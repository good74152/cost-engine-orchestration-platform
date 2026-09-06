# ADR-0002 — Dataset Version as the Multi-Job Publication Unit

- Status: Accepted
- Date: 2026-09-06

## Context

The original implementation assumed one calculation job per output dataset version. The target orchestration model needs one domain/reporting-scope dataset to contain multiple required calculation outputs/tables.

For example, a DPR dataset version may require several independent calculation types. These calculations may fail and retry independently, but publication should happen only when the complete dataset is ready.

The previous dataset lifecycle also included a dataset-level `FAILED` state, which conflated one calculation execution failure with the terminal state of the publication unit.

## Decision

A `dataset_version` is the complete publication unit for one dataset series/version.

At dataset-version creation time, the platform snapshots all active `calculation_types` for the domain by atomically creating one `PENDING` `calculation_job` per active type.

Cardinality:

```text
dataset_series
  → dataset_version
      → 1..N calculation_jobs
          → 0..N execution_attempts
```

A job is unique by:

```sql
UNIQUE(output_dataset_version_id, calculation_type_id)
```

The calculation-type set is frozen by those job rows. A calculation type activated later applies to future dataset versions, not retroactively to an existing version.

Dataset lifecycle:

```text
DRAFT ─────────────────────→ ABANDONED
  │
  ▼
BUILDING ──────────────────→ ABANDONED
  │
  ▼
VALIDATING
  ├────────────────────────→ PUBLISHED
  └────────────────────────→ REJECTED
```

There is no dataset-level `FAILED` state.

Calculation job lifecycle:

```text
PENDING → RUNNING → SUCCEEDED
                  └→ FAILED → retry → RUNNING
```

An individual job failure leaves the dataset in `BUILDING`. The failed job may be retried within the same dataset version.

A dataset may enter `VALIDATING` only when every required calculation job is `SUCCEEDED`.

`PUBLISHED`, `REJECTED`, and `ABANDONED` are immutable terminal publication states.

## Alternatives Considered

### One dataset version per calculation type

Rejected because it fragments what the business treats as one coherent published dataset into multiple version identities and complicates validation/publication semantics.

### One calculation job per dataset version

Rejected because a domain can require multiple calculation units with independent execution/retry behavior.

### Dataset-level `FAILED`

Rejected because executor failure is recoverable at the job/attempt level. A dataset version should become terminal only through publication, rejection, or explicit abandonment.

### Automatically create new dataset version after any job failure

Rejected because failed calculation types may be retried safely without changing the frozen business input identity.

## Consequences

Positive:

- Publication semantics match the complete domain/reporting dataset.
- Individual calculation failures can be retried independently.
- Dataset lifecycle and execution lifecycle remain separate.
- Adding/removing calculation types affects future versions without mutating historical versions.

Trade-offs:

- Validation readiness requires aggregate reasoning across all jobs in the dataset version.
- Concurrency rules must account for multiple jobs running independently under one dataset version.
- Abandonment must consider whether any external execution may still be active.
