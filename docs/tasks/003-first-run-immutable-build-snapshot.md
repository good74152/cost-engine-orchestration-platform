# Task 003 — First Run + Immutable Dataset Build Snapshot

## Goal

Implement the database consistency boundary that prepares a calculation job for execution while freezing one immutable build contract for the entire dataset version.

This task ends with a durable `PREPARED` `execution_attempt`. It does **not** dispatch to Airflow/FakeExecutor and does **not** mark the calculation job `RUNNING`.

The core result is:

```text
DRAFT dataset version
+ PENDING jobs
+ published dependency configuration/upstream datasets

first run preparation
        ↓
BUILDING dataset version
+ exactly one immutable dataset_build_snapshot
+ every job pins one dependency-definition version
+ selected job has one PREPARED execution_attempt
+ selected job is still PENDING
```

Task 004 owns executor dispatch and the transition from `PREPARED` toward `DISPATCHING/ACCEPTED`.

## Required Reading

Before implementation, read and treat these files as authoritative:

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/adr/0002-dataset-version-publication-unit.md`
4. `docs/adr/0003-versioned-dependencies-and-build-snapshot.md`
5. `docs/adr/0004-series-serialization-and-lock-ordering.md`
6. `docs/adr/0005-execution-attempts-and-airflow-reconciliation.md`
7. `docs/adr/0006-first-run-lock-hierarchy.md`
8. `docs/tasks/002-dataset-version-creation-v2.md`

If implementation reveals a conflict with an accepted ADR or the existing v2 schema cannot represent the required semantics, stop and report the conflict for architecture review. Do not silently redesign tables, lifecycle states, locking, or executor semantics.

## Current Repository State

Task 002 is merged.

The authoritative dataset-version creation flow now creates:

```text
canonical dataset_series
→ dataset_version DRAFT
→ one PENDING calculation_job per active calculation_type
```

The v2 schema already contains:

```text
calculation_types
execution_dependency_definition_versions
execution_dependency_definition_dependencies
calculation_jobs.resolved_dependency_definition_version_id
dataset_build_snapshots
dataset_build_snapshot_dependencies
execution_attempts
```

The repository still contains legacy flat `calculation-job.*` files implementing old lifecycle semantics such as direct `PENDING → RUNNING`, job-level validation/publication/rejection, and dataset-level `FAILED`. They are not registered by the current `app.ts` and are not authoritative v2 behavior.

Do not reuse those old state transitions.

## Bounded Scope

Implement one coherent database/application slice:

- prepare a `PENDING` calculation job for future executor dispatch,
- on the first preparation for a `DRAFT` dataset version, freeze the dataset-wide build snapshot atomically,
- when the dataset is already `BUILDING`, reuse the existing snapshot and prepare another `PENDING` job without re-resolving dependencies,
- create or idempotently return the selected job's `PREPARED` execution attempt,
- add domain/service errors for missing configuration/dependencies and non-runnable state,
- add real PostgreSQL integration and concurrency tests,
- remove obsolete legacy calculation-job start/lifecycle code only when it is confirmed unregistered/unreferenced and replacement-path tests cover the relevant behavior.

### Explicitly not in scope

Do not implement:

- Airflow HTTP calls,
- `FakeExecutor`,
- `CalculationExecutor`,
- `PREPARED → DISPATCHING`,
- `DISPATCHING → ACCEPTED`,
- `DISPATCH_FAILED`,
- ambiguous dispatch recovery,
- job `PENDING/FAILED → RUNNING`,
- executor callbacks,
- reconciliation,
- job terminal success/failure from executor results,
- Submit Validation,
- Publish/Reject/Abandon endpoints,
- dependency-definition management APIs,
- automatic scheduling of dependent jobs,
- job-to-job dependency graphs,
- raw-ingestion changes.

Do not add a real Airflow integration merely to make the new attempt row look executable.

## Public API Boundary for This Task

Task 003 is the persistence/domain preparation slice. A public final `POST /calculation-jobs/:jobId/run` route is **not required in this task**.

Task 004 will own the public Run/dispatch boundary and will call the preparation service implemented here before dispatching externally.

Do not add a temporary `/prepare-run` endpoint.

If an existing legacy `/start` implementation is still reachable or imported anywhere, remove/disable that old behavior rather than allowing it to bypass the v2 snapshot boundary.

## Required Service Contract

Introduce a clear service boundary such as:

```ts
prepareCalculationJobRunService(jobId: string): Promise<PreparedCalculationRun>
```

Exact naming may follow repository conventions, but the semantic contract must remain the same.

A successful result must identify at least:

```text
datasetVersionId
datasetStatus = BUILDING
datasetBuildSnapshotId
jobId
jobStatus = PENDING
executionAttemptId
attemptNumber
attemptStatus = PREPARED
airflowDagId
airflowDagRunId
```

The service performs no external I/O other than PostgreSQL.

## First-Run Transaction Semantics

All writes below occur in one PostgreSQL transaction.

### Phase 1 — Load immutable context

Load enough context to identify:

- selected calculation job,
- its output dataset version,
- output dataset identity:
  - `domain`
  - `company_code`
  - `fiscal_year`
  - `period`
- every calculation job belonging to that dataset version,
- every job's `calculation_type`.

The job set created by Task 002 is the frozen calculation-type set for this dataset version.

If the selected job does not exist:

```text
CALCULATION_JOB_NOT_FOUND
```

No mutation is allowed.

### Phase 2 — If dataset is DRAFT, determine and lock configuration

For every calculation type in the dataset version, acquire `calculation_types` row locks in deterministic order:

```text
(domain, code)
```

For each calculation type, resolve the highest-version dependency definition whose status is:

```text
PUBLISHED
```

Higher `DRAFT` or `ABANDONED` definition versions must not be selected.

Every job must resolve one published dependency-definition version, including a calculation type whose published definition has zero dependency rows.

This distinction is important:

```text
published definition with zero dependencies
!=
missing published definition
```

If any job has no published definition:

```text
DEPENDENCY_DEFINITION_NOT_READY
```

Rollback the transaction.

Do not persist only a subset of `resolved_dependency_definition_version_id` values.

### Phase 3 — Union required direct upstream domains

Read dependency rows from all resolved definition versions and compute the set union of required domains.

Example:

```text
Job A definition → CAPEX
Job B definition → CAPEX + INSURANCE
Job C definition → no upstream dependencies

union → CAPEX + INSURANCE
```

Duplicate requirements must produce only one dataset-snapshot dependency for a given upstream series.

Only direct dependencies are resolved. Do not recursively traverse transitive dependencies.

### Phase 4 — Resolve and lock upstream dataset series

Translate every required domain into the output dataset's exact reporting coordinates:

```text
required_domain
+ output company_code
+ output fiscal_year
+ output period
```

Example:

```text
DPR / TW01 / 2026 / Q3
requires CAPEX

→ CAPEX / TW01 / 2026 / Q3
```

No cross-company, cross-year, or cross-period fallback is allowed.

Acquire all required upstream `dataset_series` row locks in deterministic order:

```text
(domain, company_code, fiscal_year, period)
```

Do not create missing upstream dataset-series rows as a side effect of dependency resolution.

While each upstream series row is locked, resolve the highest `dataset_versions.version` whose status is:

```text
PUBLISHED
```

Higher `DRAFT`, `BUILDING`, `VALIDATING`, `REJECTED`, or `ABANDONED` versions must not be used.

If a required upstream series does not exist, or exists but has no published version:

```text
DEPENDENCY_NOT_READY
```

Rollback the entire transaction.

### Phase 5 — Lock and revalidate output build state

After the calculation-type and required upstream-series locks are held, lock the output `dataset_version` row with `FOR UPDATE`.

This ordering is mandatory under ADR-0006.

Do **not** acquire the output `dataset_series` lock merely for `DRAFT → BUILDING` initialization.

Re-read/revalidate dataset state after the lock is acquired.

#### If it is still DRAFT

Require that:

- no `dataset_build_snapshot` exists,
- the build has not already been frozen by another request.

Then atomically:

1. persist every job's `resolved_dependency_definition_version_id`,
2. insert exactly one `dataset_build_snapshot`,
3. insert one `dataset_build_snapshot_dependencies` row per unique required upstream series,
4. transition `dataset_versions.status` from `DRAFT` to `BUILDING`,
5. set `building_started_at`,
6. continue to execution-attempt preparation below.

The transaction commit is the immutable dataset-build consistency boundary.

#### If it is already BUILDING

This may occur because another concurrent request initialized the dataset while the current transaction was resolving/locking dependencies.

The request must:

- reuse the existing `dataset_build_snapshot`,
- reuse the already-persisted job definition versions,
- not overwrite them with newly resolved values,
- not re-resolve or replace concrete upstream versions,
- continue to selected-job attempt preparation.

If `BUILDING` does not have exactly one snapshot, treat that as an internal invariant violation rather than silently creating/replacing one.

#### If it is VALIDATING or terminal

The selected job is not runnable for this task.

Return/throw:

```text
JOB_NOT_RUNNABLE
```

Do not mutate snapshot, jobs, or attempts.

## Preparing a Job Against an Existing BUILDING Snapshot

A normal later preparation for another job in a dataset that is already `BUILDING` must not execute the DRAFT dependency-resolution algorithm again.

Instead:

```text
lock output dataset_version
→ verify BUILDING
→ verify exactly one existing snapshot
→ lock selected calculation_job
→ verify job is PENDING
→ create/fetch PREPARED attempt
```

The existing frozen definition IDs and concrete upstream snapshot are authoritative.

This behavior is required so that:

```text
CAPEX v11 frozen at first Run
CAPEX v12 publishes later
second DPR job is prepared later
→ second DPR job still uses CAPEX v11
```

## Selected Job and Execution Attempt Preparation

Before attempt allocation, lock the selected `calculation_job` row.

For Task 003 the selected job must remain:

```text
PENDING
```

Creating a `PREPARED` attempt does **not** mean the executor accepted or started the calculation.

If the selected job already has an active `PREPARED` attempt, return that attempt idempotently instead of inserting another row.

Do not create multiple active attempts for repeated preparation requests.

If the selected job is not `PENDING`, return/throw:

```text
JOB_NOT_RUNNABLE
```

Task 004/005 will extend behavior for dispatch and retry states.

### Attempt number

Allocate the next attempt number while the calculation-job row is locked:

```text
COALESCE(MAX(attempt_number), 0) + 1
```

For a newly-created Task 002 job this will normally be `1`.

The unique constraint on `(calculation_job_id, attempt_number)` remains a database backstop.

### Airflow identity

Copy `airflow_dag_id` from the job's frozen `calculation_type` configuration.

Generate the attempt UUID before insert and use a stable run identity derived only from that attempt, for example:

```text
cost-engine-<execution_attempt_uuid>
```

Requirements:

- stable for the lifetime of the attempt,
- unique across attempts,
- stored before any future external dispatch,
- never regenerated when Task 004 retries/reconciles the same attempt.

Do not call Airflow to obtain an execution identity.

## State After Successful Task-003 Preparation

For the first prepared job:

```text
dataset_version.status = BUILDING
calculation_job.status = PENDING
execution_attempt.status = PREPARED
```

This state is intentional.

Task 003 must **not** produce:

```text
calculation_job.status = RUNNING
```

`RUNNING` is only valid after Task 004 has confirmed executor acceptance and atomically records:

```text
execution_attempt → ACCEPTED
calculation_job   → RUNNING
```

## Error Semantics

### `CALCULATION_JOB_NOT_FOUND`

Selected job id does not exist.

No mutation.

### `DEPENDENCY_DEFINITION_NOT_READY`

At least one calculation job in the dataset version has no `PUBLISHED` dependency-definition version.

The dataset remains `DRAFT`; all job resolved-definition references remain unchanged; no snapshot or attempt is committed.

### `DEPENDENCY_NOT_READY`

At least one required upstream canonical dataset series is missing or has no `PUBLISHED` dataset version.

The dataset remains `DRAFT`; no partial snapshot, resolved-definition set, or attempt is committed.

### `JOB_NOT_RUNNABLE`

Examples in Task 003:

- dataset is `VALIDATING`, `PUBLISHED`, `REJECTED`, or `ABANDONED`,
- selected job is not `PENDING` and there is no idempotent existing `PREPARED` result to return.

### Internal invariant violation

Examples:

- dataset is `BUILDING` but has no build snapshot,
- more than one snapshot somehow exists despite the DB unique constraint,
- frozen job configuration is internally inconsistent with its calculation type.

These are not normal business conflicts. Surface them as internal invariant failures and log enough identifiers to investigate.

## Concurrency Requirements

### Same job, concurrent first preparation

At least two concurrent preparations for the same job in one `DRAFT` dataset version must converge on:

```text
exactly one dataset_build_snapshot
exactly one active PREPARED attempt for that job
same attempt returned/observed by both callers where practical
```

No duplicate snapshot or active attempt may be committed.

### Different jobs, concurrent first preparation

Two jobs in the same `DRAFT` dataset version may be prepared concurrently.

Expected final state:

```text
exactly one dataset_build_snapshot
both jobs use the same frozen job definitions/upstream versions
one PREPARED attempt for each selected job
```

The second transaction must reuse the first transaction's snapshot if initialization already completed.

### Upstream Publish versus downstream freeze

Use real concurrent PostgreSQL transactions to prove one of two serial outcomes:

```text
Publish commits first
→ first Run freezes newly published upstream version
```

or:

```text
First Run locks/resolves first
→ snapshot freezes previous published upstream version
→ Publish commits afterward
```

A snapshot may never observe a partially-published or ambiguous result.

The concurrency test may use direct SQL/test helpers for the upstream publication transaction because the final v2 Publish API belongs to Task 006.

### Dependency-definition Publish versus freeze

Use real PostgreSQL transactions/test helpers to prove that locking the `calculation_type` coordination row serializes definition publication and first-run definition selection.

The snapshot must use one fully published definition version according to the resulting serialization order.

Do not implement a dependency-definition management API solely for this test.

## Required Tests

Use real PostgreSQL for all transaction/concurrency tests.

At minimum cover:

- selected calculation job not found,
- first preparation happy path,
- all jobs receive a resolved published dependency-definition version,
- published definition with zero dependencies is valid,
- missing published definition causes complete rollback,
- higher DRAFT/ABANDONED definition does not override latest PUBLISHED definition,
- union deduplicates the same required upstream domain across jobs,
- exact same-company/year/period upstream identity resolution,
- missing upstream series causes complete rollback,
- upstream series with no PUBLISHED version causes complete rollback,
- higher non-PUBLISHED upstream dataset version is ignored,
- exactly one build snapshot is created,
- one snapshot dependency per unique upstream series,
- snapshot dependency version belongs to the referenced upstream series,
- first preparation transitions dataset `DRAFT → BUILDING`,
- selected job remains `PENDING`,
- selected attempt is `PREPARED`,
- repeated preparation of the same job is idempotent while the attempt remains PREPARED,
- preparing another PENDING job in the same BUILDING dataset reuses the existing snapshot,
- publishing a newer upstream version after freeze does not change the snapshot used by later prepared jobs,
- concurrent same-job first preparation,
- concurrent different-job first preparation,
- upstream Publish-vs-freeze serialization,
- dependency-definition Publish-vs-freeze serialization,
- terminal/non-runnable dataset state returns `JOB_NOT_RUNNABLE` with no mutation.

Mock-only tests are insufficient for the lock/concurrency acceptance criteria.

## Likely Files / Modules

Implementation may introduce or rewrite a v2 calculation-job preparation module, for example:

```text
src/modules/calculation-job/*
```

or equivalent repository conventions.

Likely responsibilities:

```text
calculation-job.service
calculation-job.repository
calculation-job.errors
calculation-job.types
```

Existing Task-002 dataset-version code may be reused for shared types/query helpers only when ownership remains clear.

Do not move snapshot behavior into raw-ingestion modules.

No schema migration is expected for Task 003. If the existing schema cannot enforce/represent the accepted invariants, stop and report the conflict rather than adding an ad-hoc migration.

## Legacy Cleanup

The old flat calculation-job implementation contains semantics that are incompatible with v2, including direct start and job-driven dataset validation/publication/failure.

If those files have no remaining registered/imported callers after the Task-003 module is introduced, remove the obsolete code and obsolete tests as part of this task.

Do not preserve dead compatibility code merely because it previously compiled.

Do not remove historical database data or migration history as part of application-code cleanup.

## Acceptance Criteria

Task 003 is complete only when all of the following are demonstrated:

1. First preparation freezes exactly one coherent build contract for the dataset version.
2. Every job pins exactly one published dependency-definition version before the build becomes `BUILDING`.
3. Every required upstream domain resolves to one concrete latest `PUBLISHED` dataset version at the freeze boundary.
4. Missing configuration or upstream data rolls back the complete first-run transaction.
5. A later job preparation in the same dataset version never refreshes definitions or upstream versions.
6. The selected job has exactly one active `PREPARED` execution attempt and remains `PENDING`.
7. No executor/network call occurs inside or outside this task's preparation service.
8. Same-dataset concurrent preparations converge on one snapshot.
9. Upstream Publish-vs-freeze and definition-Publish-vs-freeze have deterministic serial outcomes under real PostgreSQL concurrency tests.
10. No legacy direct `PENDING → RUNNING` path remains reachable without the accepted executor boundary.
11. Build/tests pass with no architecture change outside the accepted ADRs.

## Architecture Boundaries Codex Must Not Change

Do not:

- freeze dependencies at dataset creation time,
- resolve upstream versions independently per job,
- re-resolve dependencies when preparing later jobs in a BUILDING dataset,
- recursively validate transitive dependencies,
- select caller-supplied upstream versions,
- mark the dataset or job FAILED because a dependency is not ready,
- mark a job RUNNING before executor acceptance,
- create Airflow/FakeExecutor integration,
- hold database locks while performing external calls,
- introduce `latest_published_version_id` or `active_dataset_version_id` cache pointers,
- use PostgreSQL SERIALIZABLE as a substitute for the accepted lock protocol,
- lock output build state before required upstream publication-visibility locks in the DRAFT initialization path,
- reintroduce dataset-level `FAILED`,
- add job-to-job dependency scheduling.

If any implementation pressure appears to require one of these changes, stop and return the issue for architecture review.
