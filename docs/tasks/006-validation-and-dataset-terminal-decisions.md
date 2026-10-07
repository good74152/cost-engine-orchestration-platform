# Task 006 — Validation and Dataset Terminal Decisions

## Goal

Implement the dataset-level lifecycle boundary after calculation execution is complete.

Task 005 may reconcile all calculation jobs to `SUCCEEDED`, but the dataset version intentionally remains `BUILDING`.

Task 006 owns the explicit business decisions:

```text
BUILDING
+ all required calculation_jobs SUCCEEDED
→ Submit Validation
→ VALIDATING

VALIDATING
→ PUBLISHED

VALIDATING
→ REJECTED

DRAFT
→ ABANDONED

BUILDING
→ ABANDONED
only when no execution can still be dispatched or running
```

`PUBLISHED`, `REJECTED`, and `ABANDONED` are immutable terminal states.

There is no dataset-level `FAILED` state.

Task 006 must not automatically validate or publish a dataset merely because job execution succeeded.

---

## Implementation Precondition

Task 005 must be merged to `main` before Task 006 implementation begins.

This task spec is authored against the review-accepted Task 005 implementation, including the stale reconciliation observation fix.

If the final merged Task 005 differs materially from that implementation, re-check this spec before coding.

---

## Required Reading

Treat these files as authoritative:

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/adr/0002-dataset-version-publication-unit.md`
4. `docs/adr/0003-versioned-dependencies-and-build-snapshot.md`
5. `docs/adr/0004-series-serialization-and-lock-ordering.md`
6. `docs/adr/0005-execution-attempts-and-airflow-reconciliation.md`
7. `docs/adr/0006-first-run-lock-hierarchy.md`
8. `docs/adr/0007-dataset-terminal-decisions-and-publication-serialization.md`
9. `docs/tasks/003-first-run-immutable-build-snapshot.md`
10. `docs/tasks/004-execution-attempt-dispatch-fake-executor.md`
11. `docs/tasks/005-executor-reconciliation.md`

Do not silently redesign Tasks 002–005.

If implementation requires violating ADR-0007 or changing the accepted state machines, stop and report the architecture conflict.

---

## Current State Before Task 006

The authoritative lifecycle is:

```text
dataset_version
DRAFT
  ↓ first Run preparation
BUILDING
```

Calculation jobs:

```text
PENDING
→ RUNNING
→ SUCCEEDED

or

PENDING
→ RUNNING
→ FAILED
→ retry through Task 004
```

Task 005 is the only owner of executor-confirmed:

```text
RUNNING → SUCCEEDED / FAILED
```

Even when every required calculation job is `SUCCEEDED`:

```text
dataset_version = BUILDING
```

Task 006 begins from that boundary.

---

# Bounded Scope

Implement:

- `POST /dataset-versions/:datasetVersionId/submit-validation`
- `POST /dataset-versions/:datasetVersionId/publish`
- `POST /dataset-versions/:datasetVersionId/reject`
- `POST /dataset-versions/:datasetVersionId/abandon`
- PostgreSQL transaction/locking semantics for each operation,
- terminal-state timestamps,
- stable public error contracts,
- same-target idempotency,
- Publish-vs-Reject serialization,
- Publish-vs-Task-003 upstream-resolution serialization,
- safe Abandon active-execution guard,
- `/run`-vs-Abandon and reconciliation-vs-Abandon concurrency coverage,
- bounded Task-005 compatibility hardening for duplicate/stale terminal reconciliation after the dataset has advanced beyond `BUILDING`.

### Explicitly not in scope

Do not implement:

- real Airflow,
- executor cancellation,
- `CalculationExecutor.cancel(...)`,
- automatic Submit Validation from reconciliation,
- automatic Publish,
- periodic reconciliation,
- automatic downstream scheduling,
- queues,
- RabbitMQ,
- Kafka,
- Redis,
- dependency-definition mutation,
- build-snapshot mutation,
- retry logic outside existing Task-004 `/run`,
- Task-007 repository-wide cleanup,
- unrelated refactors.

Task 006 lifecycle endpoints are PostgreSQL-only.

---

# Dataset State Machine

Allowed transitions introduced by this task:

```text
BUILDING   → VALIDATING
VALIDATING → PUBLISHED
VALIDATING → REJECTED
DRAFT      → ABANDONED
BUILDING   → ABANDONED
```

No other transition is legal.

Terminal states:

```text
PUBLISHED
REJECTED
ABANDONED
```

must never transition to another state.

`VALIDATING` cannot return to `BUILDING`.

Task 006 never creates or retries execution attempts.

Task 006 never changes:

- `dataset_build_snapshots`,
- `dataset_build_snapshot_dependencies`,
- `calculation_jobs.resolved_dependency_definition_version_id`.

---

# Lock Hierarchy

Use the following Task-006 lock order.

## Submit Validation

```text
dataset_version
→ calculation_jobs ordered by id
```

If execution attempts are inspected for invariant validation, do so only after the job rows are locked, and order them by:

```text
(calculation_job_id, attempt_number)
```

## Publish

```text
dataset_series
→ dataset_version
```

## Reject

```text
dataset_series
→ dataset_version
```

## Abandon

```text
dataset_series
→ dataset_version
→ calculation_jobs ordered by id
→ execution_attempts ordered by (calculation_job_id, attempt_number)
```

Do not introduce:

```text
execution_attempt
→ calculation_job

dataset_version
→ dataset_series
```

These would conflict with existing workflow ordering.

---

# Shared Series Coordination

Publish, Reject, and Abandon must all serialize through the owning `dataset_series`.

The series row coordinates:

- Task-002 next-version creation,
- Task-003 latest-PUBLISHED visibility,
- Task-006 publication,
- Task-006 release of the active-version slot through Reject/Abandon.

For a target datasetVersionId, it is acceptable to first read its immutable `dataset_series_id` without a write lock, then:

```text
lock dataset_series FOR UPDATE
→ lock/reload dataset_version FOR UPDATE
→ revalidate ownership + status
```

Do not acquire the dataset_version write lock first and then reach backward for the series lock.

---

# API 1 — Submit Validation

## Route

```http
POST /dataset-versions/:datasetVersionId/submit-validation
```

No request body is required.

## Transaction

```text
BEGIN
→ lock dataset_version FOR UPDATE
→ if not found: DATASET_VERSION_NOT_FOUND
→ handle same-target VALIDATING idempotently
→ require BUILDING
→ lock every calculation_job for dataset version ORDER BY id
→ require at least one job
→ require every job status = SUCCEEDED
→ verify no contradictory non-terminal attempt exists for a SUCCEEDED job
→ UPDATE dataset_version
     BUILDING → VALIDATING
     validating_at = NOW()
→ COMMIT
```

## Eligibility

A BUILDING dataset is eligible only when:

```text
job_count > 0
AND
every calculation_job.status = SUCCEEDED
```

If any job is:

```text
PENDING
RUNNING
FAILED
```

return:

```text
409 DATASET_NOT_READY_FOR_VALIDATION
```

with no mutation.

A zero-job dataset is not a normal business case because Task 002 creates one or more jobs. Treat zero jobs as an internal invariant violation.

If a `SUCCEEDED` job still has an active attempt:

```text
PREPARED
DISPATCHING
ACCEPTED
```

treat that as an internal invariant violation.

## Reconciliation race

If Task 005 is concurrently changing the final job to `SUCCEEDED`, the calculation-job row lock determines the outcome.

Legal serial outcomes:

```text
Submit locks first
→ sees non-SUCCEEDED job
→ 409
→ rollback
→ reconciliation proceeds afterward
```

or:

```text
reconciliation commits SUCCEEDED first
→ Submit later locks job
→ sees all SUCCEEDED
→ VALIDATING
```

Do not use a read-before-lock eligibility check.

## Idempotency

Already:

```text
VALIDATING
```

returns:

```text
200 current state
```

without rewriting `validating_at`.

Terminal dataset states return:

```text
409 STATE_CONFLICT
```

`DRAFT` returns:

```text
409 DATASET_NOT_READY_FOR_VALIDATION
```

---

# API 2 — Publish

## Route

```http
POST /dataset-versions/:datasetVersionId/publish
```

No request body is required.

## Transaction

```text
BEGIN
→ resolve immutable dataset_series_id
→ lock dataset_series FOR UPDATE
→ lock target dataset_version FOR UPDATE
→ revalidate target belongs to locked series
→ if already PUBLISHED: return idempotent current state
→ require VALIDATING
→ UPDATE
     VALIDATING → PUBLISHED
     published_at = NOW()
→ COMMIT
```

Do not update `published_at` on an idempotent repeated Publish.

## Validation prerequisite

For the current portfolio scope, `VALIDATING` is the business prerequisite for Publish.

Submit Validation already established:

```text
all required jobs SUCCEEDED
```

and the dataset lifecycle prevents execution from restarting after leaving BUILDING.

Publish does not need to rerun job readiness logic as a second business gate.

Impossible corrupted VALIDATING state may be logged/asserted as an invariant, but do not redesign Publish into another Submit Validation operation.

## Publish vs Task 003 First Run

Task 003 locks the upstream `dataset_series` before resolving latest PUBLISHED.

Publish uses the same series coordination row.

Legal outcomes:

```text
Publish commits first
→ downstream First Run resolves the newly PUBLISHED version
```

or:

```text
downstream First Run holds/resolves the series first
→ freezes the previously PUBLISHED version
→ Publish commits afterward
```

No partially visible publication result is allowed.

## Publish vs Task 002 create-next-version

If Task 002 locks the series first while the target remains `VALIDATING`:

```text
Task 002 sees an active version
→ ACTIVE_DATASET_VERSION_EXISTS
```

It does not wait inside the same request for Publish and then silently retry creation.

If Publish commits first:

```text
active slot released
→ Task 002 may create the next version
```

## Idempotency/conflict

```text
PUBLISHED → 200 current state
REJECTED  → 409 STATE_CONFLICT
ABANDONED → 409 STATE_CONFLICT
BUILDING  → 409 STATE_CONFLICT
DRAFT     → 409 STATE_CONFLICT
```

---

# API 3 — Reject

## Route

```http
POST /dataset-versions/:datasetVersionId/reject
```

No request body is required.

## Transaction

```text
BEGIN
→ resolve immutable dataset_series_id
→ lock dataset_series FOR UPDATE
→ lock target dataset_version FOR UPDATE
→ revalidate target belongs to locked series
→ if already REJECTED: return idempotent current state
→ require VALIDATING
→ UPDATE
     VALIDATING → REJECTED
     rejected_at = NOW()
→ COMMIT
```

Do not update `rejected_at` on an idempotent repeated Reject.

## Publish vs Reject

Both use:

```text
dataset_series
→ dataset_version
```

Therefore exactly one terminal decision wins.

If Publish commits first:

```text
Reject wakes
→ observes PUBLISHED
→ 409 STATE_CONFLICT
```

If Reject commits first:

```text
Publish wakes
→ observes REJECTED
→ 409 STATE_CONFLICT
```

Never rewrite one terminal result into the other.

## Idempotency/conflict

```text
REJECTED  → 200 current state
PUBLISHED → 409 STATE_CONFLICT
ABANDONED → 409 STATE_CONFLICT
BUILDING  → 409 STATE_CONFLICT
DRAFT     → 409 STATE_CONFLICT
```

---

# API 4 — Abandon

## Route

```http
POST /dataset-versions/:datasetVersionId/abandon
```

No request body is required.

## Allowed source states

Only:

```text
DRAFT
BUILDING
```

may become `ABANDONED`.

`VALIDATING` must be resolved through Publish or Reject.

## Transaction

```text
BEGIN
→ resolve immutable dataset_series_id
→ lock dataset_series FOR UPDATE
→ lock dataset_version FOR UPDATE
→ if already ABANDONED: return idempotent current state
→ require DRAFT or BUILDING
→ lock all calculation_jobs ORDER BY id
→ lock execution_attempts for those jobs
     ORDER BY calculation_job_id, attempt_number
→ evaluate active-execution guard
→ if unsafe: DATASET_HAS_ACTIVE_EXECUTION
→ UPDATE
     DRAFT/BUILDING → ABANDONED
     abandoned_at = NOW()
→ COMMIT
```

Do not modify job or attempt history when abandoning.

Do not delete the build snapshot.

Do not clear frozen dependency-definition ids.

## Active-execution guard

These attempt states block abandonment:

```text
PREPARED
DISPATCHING
ACCEPTED
```

Reason:

- `PREPARED`: Task 004 can still dispatch it.
- `DISPATCHING`: external creation may already have happened or be ambiguous.
- `ACCEPTED`: external execution definitely exists and may still be running.

Return:

```text
409 DATASET_HAS_ACTIVE_EXECUTION
```

These terminal attempt states do not block abandonment:

```text
DISPATCH_FAILED
FAILED
SUCCEEDED
```

The following job states may be abandoned if there is no active attempt:

```text
PENDING
FAILED
SUCCEEDED
```

A `RUNNING` job must correspond to an active `ACCEPTED` attempt and therefore blocks abandonment.

If a `RUNNING` job exists without the corresponding active execution state, treat it as an internal invariant violation rather than pretending abandonment is safe.

## DRAFT abandonment

A normal DRAFT dataset should have:

```text
PENDING jobs
no build snapshot
no execution attempts
```

The dataset-version lock serializes against Task 003 first-run initialization.

If First Run acquired the build lock first and moved the dataset to BUILDING, Abandon revalidates BUILDING and applies the normal active-execution guard.

If Abandon commits first, First Run later observes ABANDONED and cannot create a snapshot/attempt.

## BUILDING abandonment

BUILDING may be abandoned only after all active execution attempts are gone.

Examples that are safe:

```text
PENDING job, no attempt
FAILED job, terminal FAILED attempt
PENDING job, terminal DISPATCH_FAILED attempt
SUCCEEDED job, terminal SUCCEEDED attempt
```

Examples that are unsafe:

```text
PENDING + PREPARED
PENDING/FAILED + DISPATCHING
RUNNING + ACCEPTED
```

## No executor cancellation

Task 006 does not call the executor.

If an operator manually stops an external Airflow run, local state must first converge through normal Task-005 reconciliation to a terminal attempt/job state. Only then may Abandon succeed.

Do not add a cancellation API to make Abandon pass.

---

# /run vs Abandon Concurrency

This race is a required correctness test.

Task 004 dispatch local lock order is:

```text
calculation_job
→ execution_attempt
```

Abandon locks:

```text
dataset_series
→ dataset_version
→ calculation_jobs
→ execution_attempts
```

Legal outcomes:

### /run advances first

```text
/run locks job/attempt
→ PREPARED → DISPATCHING
→ commit
→ Abandon later locks rows
→ sees DISPATCHING
→ 409 DATASET_HAS_ACTIVE_EXECUTION
```

### Abandon owns lifecycle rows first

If a PREPARED attempt already exists:

```text
Abandon sees PREPARED
→ 409 DATASET_HAS_ACTIVE_EXECUTION
```

If no active attempt exists:

```text
Abandon → ABANDONED
→ later /run preparation revalidates dataset state
→ JOB_NOT_RUNNABLE
```

No legal outcome may produce:

```text
dataset = ABANDONED
AND
new external execution starts afterward
```

---

# Reconciliation vs Submit Validation / Abandon

## Reconciliation vs Submit Validation

Task 005 locks:

```text
calculation_job
→ execution_attempt
```

Submit Validation locks:

```text
dataset_version
→ calculation_jobs
```

Task 005 does not reach backward for the dataset_version write lock, so there is no reverse lock cycle.

Submit eligibility is determined only from job states after job locks are acquired.

## Reconciliation vs Abandon

Abandon locks all jobs before attempts.

This preserves the Task-004/005 local ordering:

```text
calculation_job
→ execution_attempt
```

If reconciliation owns a job/attempt first, Abandon waits and then revalidates.

If Abandon owns the job first, reconciliation waits.

Abandon must not lock an execution attempt first and then wait for its calculation job.

---

# Task-005 Compatibility Hardening

Task 005 currently treats reconciliation outside a BUILDING dataset as an invariant violation.

Task 006 introduces legitimate later dataset states after execution attempts are already terminal.

Adjust reconciliation narrowly:

## Terminal local attempt

For local:

```text
SUCCEEDED
FAILED
```

a duplicate/stale reconciliation may idempotently verify the same executor terminal status even when the owning dataset is now:

```text
VALIDATING
PUBLISHED
REJECTED
ABANDONED
```

It must not mutate the logical job or dataset.

If executor terminal status contradicts local terminal history, keep existing anomaly behavior: no rewrite.

If a newer attempt exists, stale old-attempt reconciliation must still never alter the current job.

## Non-terminal local attempt

For:

```text
DISPATCHING
ACCEPTED
```

the dataset is expected to remain `BUILDING`.

A non-terminal attempt found under:

```text
VALIDATING
PUBLISHED
REJECTED
ABANDONED
```

is an internal invariant violation.

Do not weaken this guard.

## Stale-observation compatibility

A Phase-A reconciliation observation may be non-terminal, then another reconciliation may commit terminal state and Submit Validation may advance the dataset before the first request enters Phase B.

Phase B must re-read local attempt state before rejecting based on dataset state.

If the attempt is now terminal and the observation is merely stale, return the durable terminal result idempotently rather than regressing state or raising a false lifecycle error.

---

# Idempotency Matrix

Same-target repeated commands are successful idempotent reads of the already-achieved state:

| Command | Current state | Result |
|---|---|---|
| submit-validation | VALIDATING | 200 current state |
| publish | PUBLISHED | 200 current state |
| reject | REJECTED | 200 current state |
| abandon | ABANDONED | 200 current state |

Conflicting/invalid lifecycle targets return `409`.

Do not rewrite timestamps on same-target retries.

This policy handles:

```text
DB commit succeeds
→ HTTP response lost
→ client retries same command
```

without making a successful prior command appear to have failed.

---

# Error Contract

Add/extend stable errors.

## DATASET_VERSION_NOT_FOUND

```text
404
```

Target dataset version does not exist.

## DATASET_NOT_READY_FOR_VALIDATION

```text
409
```

Examples:

- dataset is DRAFT,
- dataset is BUILDING but at least one required job is PENDING/RUNNING/FAILED.

No mutation.

## DATASET_HAS_ACTIVE_EXECUTION

```text
409
```

Abandon found at least one:

```text
PREPARED
DISPATCHING
ACCEPTED
```

execution attempt, or a valid RUNNING/ACCEPTED execution pair.

## STATE_CONFLICT

```text
409
```

Examples:

- Publish after REJECTED,
- Reject after PUBLISHED,
- Abandon from VALIDATING/PUBLISHED/REJECTED,
- Publish/Reject from DRAFT or BUILDING.

Do not expose PostgreSQL constraint/index names.

## Internal invariant violation

Examples:

- zero calculation jobs for an active dataset version,
- SUCCEEDED job with active non-terminal attempt,
- RUNNING job without valid active ACCEPTED attempt,
- non-terminal execution attempt under a non-BUILDING dataset,
- snapshot/definition identity changed during Task-006 operations.

Return generic 500 through the existing error handler and log identifiers.

---

# Response Contracts

Exact DTO names may follow repository conventions.

A dataset lifecycle response should expose at least:

```json
{
  "datasetSeriesId": "...",
  "datasetVersionId": "...",
  "version": 7,
  "datasetStatus": "VALIDATING"
}
```

For terminal transitions expose the target status.

Timestamps may be included if repository conventions support them, but internal row shapes must not leak directly.

---

# Transaction Rollback Requirements

Every lifecycle operation is all-or-nothing.

Examples:

## Submit Validation

If any job is not SUCCEEDED:

```text
dataset remains BUILDING
validating_at unchanged
jobs unchanged
```

If the final UPDATE is forced to fail, no partial lifecycle mutation may commit.

## Publish

If target revalidation fails:

```text
status unchanged
published_at unchanged
```

## Reject

If target revalidation fails:

```text
status unchanged
rejected_at unchanged
```

## Abandon

If an active attempt is found:

```text
status unchanged
abandoned_at unchanged
jobs/attempts unchanged
```

Task 006 must not compensate by changing executor/job history after a transaction failure.

---

# Database Migration Decision

No schema migration is expected.

The current schema already provides:

- dataset lifecycle states,
- `published_at`,
- `building_started_at`,
- `validating_at`,
- `rejected_at`,
- `abandoned_at`,
- one-active-dataset-version partial unique index,
- execution-attempt status constraints and active-attempt uniqueness.

Task 006 correctness is enforced by existing constraints plus transactional locking/state revalidation.

Do not add a migration unless implementation discovers a concrete invariant that cannot be represented safely. If so, stop and request architecture review before changing schema.

---

# Required Real PostgreSQL Tests

Mock-only lifecycle/concurrency tests are insufficient.

## Submit Validation

Cover:

- all jobs SUCCEEDED → VALIDATING,
- `validating_at` set,
- one PENDING job → 409/no mutation,
- one RUNNING job → 409/no mutation,
- one FAILED job → 409/no mutation,
- zero jobs → internal invariant failure,
- duplicate Submit Validation → 200 and timestamp unchanged,
- final-job reconciliation vs Submit Validation with deterministic barrier/locking,
- concurrent Submit Validation requests converge on VALIDATING,
- snapshot and frozen definition ids unchanged.

## Publish

Cover:

- VALIDATING → PUBLISHED,
- `published_at` set exactly once,
- repeated Publish → 200 same state/timestamp,
- Publish from non-VALIDATING state → 409,
- Publish vs Reject exactly one terminal winner,
- Publish vs Task-003 downstream upstream-resolution serialization,
- Publish vs Task-002 next-version creation serialization,
- snapshot/definition pins unchanged.

For Publish-vs-First-Run, use transaction barriers or explicit locks to prove both legal serial outcomes rather than relying only on timing.

## Reject

Cover:

- VALIDATING → REJECTED,
- `rejected_at` set,
- repeated Reject → 200 same state/timestamp,
- Reject from BUILDING/DRAFT → 409,
- Publish vs Reject convergence,
- next dataset-version creation succeeds only after terminal decision releases the active slot.

## Abandon

Cover:

- DRAFT → ABANDONED,
- BUILDING with only safe terminal/no attempts → ABANDONED,
- PENDING/no attempt is safe,
- FAILED/terminal FAILED attempt is safe,
- PENDING/terminal DISPATCH_FAILED attempt is safe,
- SUCCEEDED/terminal SUCCEEDED attempt is safe,
- PREPARED blocks,
- DISPATCHING blocks,
- ACCEPTED blocks,
- RUNNING/ACCEPTED blocks,
- RUNNING without valid ACCEPTED attempt → invariant failure,
- repeated Abandon → 200 same state/timestamp,
- Abandon from VALIDATING/PUBLISHED/REJECTED → 409,
- concurrent `/run` vs Abandon cannot produce ABANDONED + new external execution,
- concurrent reconciliation vs Abandon follows lock order and converges safely,
- no executor cancellation/status mutation side effect,
- snapshot and frozen definition ids unchanged.

## Task-005 compatibility

Cover:

- terminal SUCCEEDED attempt + dataset VALIDATING + executor SUCCEEDED → idempotent success,
- terminal FAILED historical attempt + later dataset lifecycle state + matching executor FAILED → idempotent history verification,
- terminal contradiction after dataset advancement → anomaly/no overwrite,
- non-terminal ACCEPTED/DISPATCHING under VALIDATING/terminal dataset → invariant failure,
- stale Phase-A RUNNING observation after another reconciliation terminalizes the attempt and Submit Validation advances dataset → returns durable terminal state; no regression and no false lifecycle error.

## Error contract tests

At minimum:

```text
DATASET_VERSION_NOT_FOUND       → 404
DATASET_NOT_READY_FOR_VALIDATION → 409
DATASET_HAS_ACTIVE_EXECUTION    → 409
STATE_CONFLICT                  → 409
```

Every route must return stable error JSON consistent with the existing application error handler.

---

# Likely Files / Modules

Exact organization may follow repository conventions.

Likely additions/changes:

```text
src/modules/dataset-version/dataset-version-lifecycle.repository.ts
src/modules/dataset-version/dataset-version-lifecycle.service.ts
src/modules/dataset-version/dataset-version.route.ts
src/modules/dataset-version/dataset-version.errors.ts
src/modules/dataset-version/dataset-version.types.ts

src/modules/calculation-job-reconciliation.service.ts
  (bounded terminal-dataset compatibility hardening only)

src/app.ts
scripts/dataset-version-terminal-lifecycle.pg.test.ts
package.json
```

Do not duplicate Task-003/004/005 execution logic in the dataset lifecycle module.

---

# Architecture Boundaries Codex Must Not Change

1. Job success does not automatically validate or publish the dataset.
2. Submit Validation is explicit.
3. BUILDING → VALIDATING requires one or more jobs and every job SUCCEEDED.
4. Publish and Reject require VALIDATING.
5. PUBLISHED / REJECTED / ABANDONED are immutable terminal states.
6. There is no dataset FAILED state.
7. Publication visibility is serialized by `dataset_series → dataset_version`.
8. Reject and Abandon use the same series-level terminal-decision protocol.
9. Abandon cannot proceed with PREPARED/DISPATCHING/ACCEPTED attempts.
10. Task 006 does not cancel executor runs.
11. Task 006 does not create or retry execution attempts.
12. Dataset build snapshot and dependency-definition pins remain immutable.
13. Same-target lifecycle command retries are idempotent 200.
14. Conflicting terminal decisions return 409 and never rewrite history.
15. Task 006 lifecycle endpoints perform no external executor call.
16. Reconciliation terminal history remains idempotently observable after dataset lifecycle advancement.
17. Lock order must not invert Task-003 or Task-004/005 accepted ordering.

If implementation appears to require breaking any of these, stop and return to architecture review.

---

# Acceptance Criteria

Task 006 is complete only when all of the following are demonstrated:

```text
POST /dataset-versions/:id/submit-validation exists
BUILDING + all jobs SUCCEEDED → VALIDATING atomically
last-job reconciliation race has deterministic serial outcomes
POST /dataset-versions/:id/publish exists
VALIDATING → PUBLISHED under dataset_series → dataset_version locks
Publish-vs-First-Run exposes only old-or-new published visibility
POST /dataset-versions/:id/reject exists
Publish-vs-Reject has exactly one terminal winner
POST /dataset-versions/:id/abandon exists
DRAFT/BUILDING abandonment is blocked by PREPARED/DISPATCHING/ACCEPTED
/run-vs-Abandon cannot start external work after ABANDONED commits
no executor cancellation is introduced
same-target retries are idempotent
conflicting terminal decisions never rewrite history
terminal timestamps are written once
snapshot/dependency pins are unchanged
Task-005 duplicate terminal reconciliation remains safe after VALIDATING/terminal dataset states
real PostgreSQL tests prove transaction and lock behavior
no schema migration is added without architecture review
```

Passing tests are not sufficient if the implementation uses stale read-before-lock eligibility checks, publishes without the series coordination lock, allows PREPARED/DISPATCHING/ACCEPTED abandonment, or introduces executor cancellation inside Task 006.
