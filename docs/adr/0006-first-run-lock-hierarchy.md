# ADR-0006 — First-Run Lock Hierarchy Across Configuration, Series, and Build State

- Status: Accepted
- Date: 2026-09-15

## Context

ADR-0004 establishes deterministic ordering when several `dataset_series` rows or several `calculation_type` rows must be locked. First Run, however, crosses multiple lock classes:

- calculation-type configuration rows,
- upstream dataset-series publication-visibility rows,
- the output dataset version being initialized,
- the selected calculation job whose execution attempt is prepared.

A naive implementation could lock the output `dataset_series` or output `dataset_version` first and then acquire upstream-series locks. That can participate in a cross-domain lock cycle when several builds and publications execute concurrently.

Example shape:

```text
First Run A holds output A state and waits for upstream series B
Publish B holds series B and waits for B version state
First Run B holds output B state and waits for upstream series A
Publish A holds series A and waits for A version state
```

The exact cycle depends on implementation details, but the important issue is that acquiring output build-state locks before publication-visibility locks creates a lock-order inversion across workflows.

First Run therefore needs an explicit lock-class hierarchy in addition to the within-class ordering already defined by ADR-0004.

## Decision

For first-run/build-snapshot initialization, use this lock hierarchy:

```text
1. calculation_type rows
2. required upstream dataset_series rows
3. output dataset_version row
4. selected calculation_job row
```

Within each class, use deterministic ordering:

```text
calculation_type:
(domain, code)

upstream dataset_series:
(domain, company_code, fiscal_year, period)
```

The output `dataset_series` row is **not** locked merely because the output dataset is moving from `DRAFT` to `BUILDING`. The output `dataset_version` row is the serialization point for one dataset build's first-run initialization.

The upstream `dataset_series` rows remain the serialization points for publication visibility. Resolving the latest `PUBLISHED` upstream version must occur while those upstream series rows are locked.

First Run may initially read immutable identifiers without locks in order to determine the complete calculation-type and upstream-series lock sets. After all configuration and upstream-series locks have been acquired, it locks the output `dataset_version` and revalidates its state before writing.

If another concurrent request already initialized the same dataset version, the later request must observe `BUILDING` plus the existing snapshot and reuse that frozen build contract rather than creating a second snapshot or re-resolving dependencies.

Before inserting an execution attempt for the selected job, lock that `calculation_job` row. Attempt allocation for one job therefore serializes behind the job row and the database unique constraint remains the final backstop.

## First-Run Write Boundary

When the output dataset version is still `DRAFT` after revalidation, one PostgreSQL transaction performs:

```text
freeze one PUBLISHED dependency-definition version per job
→ freeze one concrete PUBLISHED version per required upstream series
→ create exactly one dataset_build_snapshot
→ persist snapshot dependency rows
→ persist each job's resolved dependency-definition version
→ DRAFT → BUILDING
→ create/fetch selected job execution_attempt PREPARED
→ commit
```

If any required definition or upstream published dataset is unavailable, the transaction rolls back and the output dataset remains `DRAFT`.

When the dataset is already `BUILDING` with a valid snapshot, preparing another `PENDING` job must reuse that snapshot and must not re-resolve dependency definitions or upstream versions.

## Alternatives Considered

### Lock output dataset_series first

Rejected because the output series is not needed to protect build-snapshot initialization and acquiring it before upstream publication-visibility locks creates unnecessary cross-series lock-order risk.

### Lock output dataset_version first, then discover/lock upstream series

Rejected because publication paths acquire series visibility locks before version state. Reversing that order in First Run can participate in deadlock cycles under concurrent cross-domain builds/publications.

### Use PostgreSQL SERIALIZABLE instead of explicit ordering

Rejected for the same reasons documented in ADR-0004. The system prefers narrow explicit coordination and deterministic lock ordering over making broad transaction retries the normal correctness mechanism.

### Use application mutexes

Rejected because they do not coordinate multiple backend processes and do not provide the database-level ordering required by publication and dependency resolution.

## Consequences

Positive:

- First Run has a concrete lock protocol that Codex and future maintainers do not need to invent.
- Upstream Publish versus downstream snapshot freeze remains serializable and explainable.
- Concurrent first-run requests for the same dataset converge on one immutable snapshot.
- The design reduces cross-resource lock-order inversions without requiring global SERIALIZABLE isolation.

Trade-offs:

- First Run may perform some non-locking reads and then revalidate after acquiring locks.
- A concurrent request may do dependency-resolution work that becomes unnecessary if another request initializes the dataset first.
- Implementations must preserve this lock-class ordering when future publication or dependency-definition management APIs are added.
