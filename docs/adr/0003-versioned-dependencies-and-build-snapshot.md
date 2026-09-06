# ADR-0003 — Versioned Dependency Definitions and Dataset-Wide Build Snapshot

- Status: Accepted
- Date: 2026-09-06

## Context

The original implementation stored concrete dependency dataset versions directly against calculation jobs and allowed dependency configuration to be overwritten. That made historical behavior difficult to reproduce and debug.

The target system also contains multiple calculation jobs inside one dataset version. If each job independently resolved the latest upstream data when it ran, one published dataset version could contain tables built from different versions of the same upstream series.

Example of the rejected behavior:

```text
DPR v5 / Job A runs at 09:00 → CAPEX v7
CAPEX v8 publishes at 09:30
DPR v5 / Job B runs at 10:00 → CAPEX v8
```

This violates the desired business meaning that all tables in DPR v5 use one coherent CAPEX version.

## Decision

Dependency configuration is platform-owned and versioned per `calculation_type`.

A dependency definition answers:

> Which direct upstream domains does this calculation type require?

Example:

```text
DPR / TABLE_X

Definition v1:
- CAPEX

Definition v2:
- CAPEX
- INSURANCE
```

Historical dependency-definition versions are immutable. A `PENDING` job does not pin a definition version at dataset creation time.

Dataset creation creates only:

```text
dataset_version DRAFT
+ required calculation_jobs PENDING
```

No upstream dataset versions, dependency-definition versions, build snapshot, or execution attempts are frozen at creation time.

When the first job in a dataset version is Run, one atomic database transaction freezes the build contract for the **entire dataset version**:

1. Resolve the latest `PUBLISHED` dependency-definition version for every calculation job.
2. Persist each job's resolved definition version.
3. Union all required direct upstream domains.
4. Resolve the matching upstream dataset series using the same `company_code`, `fiscal_year`, and `period`.
5. Resolve the latest `PUBLISHED` dataset version for every required upstream series.
6. Create exactly one immutable `dataset_build_snapshot` and its concrete upstream-version rows.
7. Transition the dataset from `DRAFT` to `BUILDING`.
8. Create the selected job's first `execution_attempt`.

The transaction commit is the dataset-version build-consistency boundary.

For one dataset version, each upstream logical series is pinned to exactly one concrete dataset version. Every job and every retry in that dataset version must reuse that frozen version.

If newer upstream data must be used, the existing dataset version is abandoned and a new dataset version is created.

The system requires only direct-upstream correctness. It does not recursively require all transitive upstream datasets used by a published dependency to still be the latest.

## Alternatives Considered

### Resolve upstream versions when the dataset version is created

Rejected because a dataset may remain `DRAFT` for some time before execution. Freezing at creation would unnecessarily use stale upstream data when the build actually starts later.

### Resolve latest upstream version separately for each calculation job

Rejected because a single dataset version could contain internally inconsistent upstream versions.

### Create an execution attempt for every job at dataset creation time

Rejected because execution attempts represent concrete dispatch/execution identity. They should not be created before a job is actually Run, and they should not be used as the dataset-wide consistency mechanism.

### Allow retry to re-resolve newer upstream versions

Rejected because a retry is execution recovery, not a new business/data recomputation identity. Changing inputs during retry would break dataset-wide consistency.

### Overwrite dependency configuration in place

Rejected because historical dataset behavior becomes impossible to explain reliably after configuration changes.

## Consequences

Positive:

- Every published dataset version has one coherent upstream input snapshot.
- Historical dependency configuration is auditable.
- Retry behavior is deterministic and reproducible.
- First Run still uses reasonably fresh upstream data rather than creation-time data.
- Investigation can answer both `what dependencies were required?` and `which concrete versions were used?`.

Trade-offs:

- First Run is a larger transaction because it freezes configuration for all jobs, not just the selected job.
- A newer upstream publication cannot be adopted by one retry inside an existing dataset version.
- Changing dependency definitions after a dataset build starts affects only future dataset versions.
- Missing required definitions or upstream published datasets must roll back the entire first-Run initialization and leave the dataset `DRAFT`.
