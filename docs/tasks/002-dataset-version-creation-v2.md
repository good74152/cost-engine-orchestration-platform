# Task 002 — Dataset Version Creation v2

## Goal

Implement the first application slice of the accepted Cost Engine Orchestration Platform v2 architecture: create one dataset version for a canonical reporting series and atomically snapshot all active calculation types for the domain into `PENDING` calculation jobs.

## Required Reading

Before implementation, read and treat these files as authoritative:

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/adr/0001-canonical-dataset-identity.md`
4. `docs/adr/0002-dataset-version-publication-unit.md`
5. `docs/adr/0004-series-serialization-and-lock-ordering.md`

ADRs 0003 and 0005 describe later slices and must not be implemented as part of this task.

If this task conflicts with an accepted ADR, stop and return the conflict for architecture review rather than silently changing the architecture.

## Context

The v2 schema is introduced by:

```text
migrations/1788700000000_orchestration-schema-v2.ts
```

The existing application still implements the old model:

- `business_key` identity,
- one calculation job per output dataset version,
- caller-supplied calculation dependencies,
- job-driven dataset lifecycle transitions.

This task starts the application migration to the accepted model. Do not preserve obsolete API semantics merely to keep the old implementation shape.

The accepted domain catalog for this portfolio is:

```text
FAB_COST
CAPEX
DPR
INSURANCE
ONE_STD_COST
COWOS_S
```

These are normalized machine identifiers. UI labels may differ (`FAB COST`, `ONE STD COST`, `COWOS-S`). Do not invent calculation types, dependency definitions, or Airflow DAG mappings for a domain unless explicitly configured in test/seed data.

## Existing Behavior

The current `POST /calculation-jobs` flow accepts a domain, opaque `businessKey`, and caller-supplied dependency versions. It allocates a dataset version and creates exactly one calculation job.

That behavior is no longer the target architecture.

## Desired Behavior

Expose dataset creation as the orchestration entry point:

```http
POST /dataset-versions
```

Request:

```json
{
  "domain": "DPR",
  "companyCode": "TW01",
  "fiscalYear": 2026,
  "period": "Q3"
}
```

The service must execute one PostgreSQL transaction:

```text
find/create dataset_series
→ lock dataset_series row
→ verify there is no active DRAFT/BUILDING/VALIDATING dataset version
→ increment last_allocated_version
→ create dataset_version = DRAFT
→ load all active calculation_types for the domain
→ create one PENDING calculation_job per active calculation_type
→ commit
```

Response should identify the created dataset version and its calculation jobs.

## Scope

- Introduce request/response types for dataset-version creation.
- Add a dataset-version route/service/repository boundary.
- Use canonical identity fields:
  - `domain`
  - `company_code`
  - `fiscal_year`
  - `period`
- Validate `domain` against the accepted catalog:
  - `FAB_COST`
  - `CAPEX`
  - `DPR`
  - `INSURANCE`
  - `ONE_STD_COST`
  - `COWOS_S`
- Allocate the next version through the locked `dataset_series` row.
- Load `calculation_types WHERE domain = ? AND is_active = true`.
- Create all calculation jobs for the new dataset version in the same transaction.
- Map expected DB conflicts to explicit domain/API errors.
- Add route-level validation for domain/period/request shape.
- Add PostgreSQL integration tests, including concurrent creation.

## Architecture Constraints

- Do not use `legacy_business_key` in new application code.
- `last_allocated_version` is an allocation counter only; it is not the latest published version.
- Caller must not provide:
  - version number,
  - calculation types,
  - dependency definitions,
  - upstream dataset versions.
- One dataset version owns N calculation jobs.
- `calculation_jobs.calculation_type_id` is required.
- No `dataset_build_snapshot` is created during dataset-version creation.
- No `execution_attempt` is created during dataset-version creation.
- Do not call Airflow/FakeExecutor in this task.
- Critical correctness must be enforced by PostgreSQL constraints plus transaction locking, not by a check-then-insert race in application code.

## Invariants

1. `dataset_series` identity is unique by `(domain, company_code, fiscal_year, period)`.
2. Version numbers for one series are monotonic and never reused.
3. A series has at most one active dataset version in `DRAFT`, `BUILDING`, or `VALIDATING`.
4. Dataset version creation and calculation-job creation are atomic.
5. A dataset version has at most one job for each calculation type.
6. The calculation-type set is frozen by the job rows created in this transaction. Later calculation-type configuration changes do not mutate an existing dataset version.
7. A domain with zero active calculation types cannot create a dataset version.

## Failure Behavior

### Active dataset exists

Return:

```text
409 ACTIVE_DATASET_VERSION_EXISTS
```

The transaction must not allocate another version.

### No active calculation types

Return:

```text
409 CALCULATION_TYPE_NOT_CONFIGURED
```

Rollback the complete transaction, including `last_allocated_version` increment and dataset-version insert.

### Invalid request

Return a stable 400 error code such as:

```text
INVALID_REQUEST
INVALID_DOMAIN
INVALID_PERIOD
```

`INVALID_DOMAIN` includes values outside the accepted domain catalog. Do not silently normalize arbitrary aliases or display labels such as `ONE STD COST` or `COWOS-S` at the API boundary.

Do not return generic 500 for expected request errors.

### Unexpected database failure

Rollback the entire transaction and surface an internal error. Do not leave a partially-created dataset version or partial job set.

## Likely Files / Modules

Codex may create a new dataset-version module instead of forcing the new resource into the old `calculation-job` module.

Likely areas:

```text
src/app.ts
src/modules/dataset-version/*
src/modules/calculation-job.* (only where necessary to migrate/remove obsolete creation behavior)
src/db/transaction.ts
scripts/ or test files for PostgreSQL integration/concurrency tests
```

Do not change raw-ingestion architecture in this task.

## Acceptance Criteria

### Happy path

Given three active DPR calculation types:

```text
ASSET_SUMMARY
TABLE_X
TABLE_Y
```

creating `DPR/TW01/2026/Q3` returns one `DRAFT` dataset version and exactly three `PENDING` jobs.

Database assertions:

```text
one dataset_series
last_allocated_version = 1
one dataset_version version=1 status=DRAFT
three calculation_jobs
no dataset_build_snapshot
no execution_attempt
```

### Domain catalog

Each accepted domain identifier passes request validation when it has configured active calculation types:

```text
FAB_COST
CAPEX
DPR
INSURANCE
ONE_STD_COST
COWOS_S
```

A value outside the catalog returns `400 INVALID_DOMAIN` before any dataset/version/job data is committed.

### Next version

After the active dataset becomes terminal, the next create allocates the next monotonically increasing version. Rejected/abandoned version numbers are not reused.

### No configured calculation type

Creation fails with `CALCULATION_TYPE_NOT_CONFIGURED`, and no version number or partial dataset/job data remains committed.

### Concurrent create

Run at least 20 concurrent requests for the same canonical series.

Expected:

```text
1 creation succeeds
19 requests conflict
exactly one active dataset version exists
exactly one complete calculation-job set exists
last_allocated_version = 1
```

The test must execute against real PostgreSQL.

### Different series

Concurrent creates for different company/period/domain identities must not incorrectly block each other through a global application mutex.

## Required Tests

- Route request validation.
- Accepted-domain validation for all six domain identifiers.
- Unknown domain returns `INVALID_DOMAIN` with no DB mutation.
- Happy-path dataset creation.
- All active calculation types are snapshotted into jobs.
- Inactive calculation types are not included.
- Zero active calculation types rolls back the whole transaction.
- Same-series concurrent creation.
- Different-series concurrent creation.
- Version allocation after terminal `PUBLISHED`.
- Version allocation after terminal `REJECTED`.
- Version allocation after terminal `ABANDONED`.
- API error contract for `ACTIVE_DATASET_VERSION_EXISTS`.
- API error contract for `CALCULATION_TYPE_NOT_CONFIGURED`.

## Non-Goals

Do not implement in this task:

- dependency-definition creation APIs,
- first-run definition resolution,
- dataset build snapshot freezing,
- calculation-job Run/Retry,
- `execution_attempts`,
- FakeExecutor/AirflowExecutor,
- executor callbacks/reconciliation,
- Submit Validation,
- Publish/Reject/Abandon endpoints,
- job-to-job dependency graphs,
- raw-ingestion changes.

## Architecture Boundaries Codex Must Not Change

Do not reintroduce:

- opaque `business_key` as canonical identity,
- one-job-per-dataset-version assumptions,
- caller-selected upstream dataset versions,
- dataset-level `FAILED`,
- dependency resolution during dataset creation.

If implementation reveals a conflict with one of these boundaries, stop and return the issue for architecture review rather than silently changing the design.
