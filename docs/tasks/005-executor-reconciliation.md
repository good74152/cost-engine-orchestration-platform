# Task 005 — Executor Reconciliation

## Goal

Implement one authoritative executor-state reconciliation path for calculation executions that were dispatched by Task 004.

Task 005 converts durable external executor facts into local orchestration state without trusting callback payloads as the source of truth.

The core mapping is:

```text
local DISPATCHING / ACCEPTED execution_attempt
        +
executor lookup by stable airflow_dag_id + airflow_dag_run_id
        ↓
RUNNING
→ attempt ACCEPTED
→ job RUNNING

SUCCEEDED
→ attempt SUCCEEDED
→ job SUCCEEDED

FAILED
→ attempt FAILED
→ job FAILED
```

Task 005 also supports:

- manual Check Status,
- callback-triggered reconciliation,
- recovery of ambiguous Task-004 `DISPATCHING` attempts,
- duplicate/stale reconciliation idempotency,
- executor unavailable / not-found behavior,
- deterministic FakeExecutor terminal-state control for tests and local demo.

This task does **not** implement dataset validation/publication/rejection/abandonment. Dataset state remains `BUILDING` after job terminal reconciliation; Task 006 owns dataset-level decisions.

---

## Required Reading

Before implementation, read and treat these files as authoritative:

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/adr/0003-versioned-dependencies-and-build-snapshot.md`
4. `docs/adr/0005-execution-attempts-and-airflow-reconciliation.md`
5. `docs/tasks/003-first-run-immutable-build-snapshot.md`
6. `docs/tasks/004-execution-attempt-dispatch-fake-executor.md`

Task 004 is authoritative for:

- Run/Retry,
- execution-attempt allocation,
- stable `airflow_dag_run_id`,
- `PREPARED → DISPATCHING → ACCEPTED`,
- `DISPATCH_FAILED`,
- ambiguous dispatch remaining `DISPATCHING`,
- FakeExecutor dispatch identity.

Do not duplicate or redesign Task-004 dispatch behavior.

If implementation reveals a conflict with an accepted ADR or the current schema cannot represent required semantics, stop and report the architecture conflict. Do not silently redesign execution states, retry semantics, or snapshot behavior.

---

## Current Repository State

Task 004 is merged into `main`.

The public Run boundary already exists:

```http
POST /calculation-jobs/:jobId/run
```

The executor abstraction currently provides dispatch:

```ts
interface CalculationExecutor {
  dispatch(command: DispatchCalculationCommand): Promise<DispatchResult>;
}
```

The FakeExecutor already stores fake external executions keyed by:

```text
(airflow_dag_id, airflow_dag_run_id)
```

and Task 004 guarantees that confirmed acceptance is persisted atomically as:

```text
execution_attempt = ACCEPTED
calculation_job   = RUNNING
```

Task 004 can also leave an ambiguous attempt as:

```text
execution_attempt = DISPATCHING
calculation_job   = PENDING or FAILED
```

Task 005 must reconcile both cases.

No schema migration is expected for Task 005. If implementation appears to require one, stop and report why before adding it.

---

## Bounded Scope

Implement one coherent reconciliation slice:

- extend `CalculationExecutor` with executor-state lookup,
- extend `FakeExecutor` with deterministic execution status,
- implement one internal reconciliation service for one exact execution attempt,
- expose manual calculation-job reconciliation,
- expose callback-triggered reconciliation by stable external identity,
- recover ambiguous `DISPATCHING` attempts when the external execution is found,
- atomically map confirmed terminal executor state to attempt/job state,
- preserve local state when executor lookup is unavailable or inconclusive,
- make duplicate/stale reconciliation idempotent,
- detect terminal contradictions without rewriting historical terminal state,
- add real PostgreSQL integration/concurrency tests,
- add development/test-only FakeExecutor controls needed to drive RUNNING/SUCCEEDED/FAILED demo flows.

### Explicitly not in scope

Do not implement:

- real Airflow HTTP integration,
- automatic/periodic reconciliation worker,
- message queues,
- executor cancellation,
- dataset Submit Validation,
- Publish/Reject/Abandon,
- automatic start of downstream jobs,
- job-to-job dependency graphs,
- dependency-definition changes,
- snapshot changes,
- retry-attempt creation beyond the existing Task-004 Run endpoint,
- new infrastructure such as RabbitMQ/Kafka/Redis.

---

# Executor Status Contract

Extend the executor abstraction with a narrow lookup contract, for example:

```ts
interface ExecutionIdentity {
  airflowDagId: string;
  airflowDagRunId: string;
}

type ExecutorExecutionStatus =
  | { kind: 'RUNNING' }
  | { kind: 'SUCCEEDED' }
  | { kind: 'FAILED'; message?: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNAVAILABLE'; message: string };

interface CalculationExecutor {
  dispatch(command: DispatchCalculationCommand): Promise<DispatchResult>;
  getExecutionStatus(
    identity: ExecutionIdentity,
  ): Promise<ExecutorExecutionStatus>;
}
```

Equivalent naming is acceptable, but the semantics must remain distinct.

## RUNNING

The executor confirms that this exact external execution exists and is still running.

## SUCCEEDED

The executor confirms terminal successful execution.

Map to local:

```text
execution_attempt → SUCCEEDED
calculation_job   → SUCCEEDED
```

## FAILED

The executor confirms terminal execution failure.

Map to local:

```text
execution_attempt → FAILED
calculation_job   → FAILED
```

This is different from Task-004 `DISPATCH_FAILED`:

```text
DISPATCH_FAILED
= external execution was definitely not created

FAILED
= external execution existed and later completed unsuccessfully
```

## NOT_FOUND

Status lookup cannot find the external execution identity.

For the current architecture, `NOT_FOUND` does **not** prove that a previously ambiguous dispatch definitely failed. Executor systems may have visibility lag or inconsistent error surfaces.

Therefore:

```text
do not mark attempt DISPATCH_FAILED
do not mark job FAILED
do not create a new attempt
```

Local state remains unchanged and the public reconciliation call returns `EXECUTOR_STATUS_UNAVAILABLE`.

## UNAVAILABLE

Timeout, transport error, 5xx, or otherwise inconclusive executor status lookup.

Local state remains unchanged.

Never convert executor availability failure into financial calculation failure.

---

# FakeExecutor Extension

Extend the existing FakeExecutor external execution state from RUNNING-only to:

```text
RUNNING
SUCCEEDED
FAILED
```

The fake must implement `getExecutionStatus()` using the same stable:

```text
airflow_dag_id + airflow_dag_run_id
```

identity used for dispatch.

Required programmatic controls:

```ts
setExecutionState(..., 'RUNNING' | 'SUCCEEDED' | 'FAILED')
```

Exact API may follow repository conventions.

The fake must also support deterministic status-lookup unavailability for tests, without deleting or mutating the underlying fake execution.

Unknown external identity returns `NOT_FOUND`.

## Development/Test Fake Control Routes

For local portfolio demo, add development/test-only controls when the configured executor is actually `FakeExecutor`, for example:

```http
POST /internal/fake-executor/executions/:dagRunId/succeed
POST /internal/fake-executor/executions/:dagRunId/fail
```

Equivalent bounded routing is acceptable.

These routes:

- mutate only FakeExecutor external state,
- must never directly update PostgreSQL attempt/job rows,
- must not be registered in production,
- must fail if the run identity does not exist.

Normal reconciliation must still be invoked after fake state is changed.

Do not add a route that directly sets `calculation_jobs.status`.

---

# Reconciliation Service Boundary

Implement one authoritative service path for one exact execution attempt, conceptually:

```ts
reconcileExecutionAttemptService(attemptId, executor)
```

Manual Check Status and callback handling must both resolve an attempt and call this same service.

Do not duplicate state-mapping logic in routes.

The service has two major phases:

```text
Phase A
read durable execution identity
COMMIT / no open transaction

external executor.getExecutionStatus(...)
NO DB TRANSACTION

Phase B
lock/reload local state
apply idempotent reconciliation
COMMIT
```

Never hold a PostgreSQL transaction or row lock while waiting for executor status lookup.

---

# Public Manual Reconciliation API

Expose:

```http
POST /calculation-jobs/:jobId/reconcile
```

The route resolves the job's execution attempt to reconcile.

Selection rules:

1. If a non-terminal reconcilable attempt exists, use it:
   - `DISPATCHING`
   - `ACCEPTED`
2. Otherwise, for a terminal job, use its latest terminal executor attempt:
   - `SUCCEEDED`
   - `FAILED`
3. `PREPARED` is not reconcilable because dispatch has not started.
4. `DISPATCH_FAILED` is not reconcilable because Task 004 established that no external execution was created.
5. A job with no reconcilable executor attempt returns a stable conflict error.

Recommended stable code:

```text
EXECUTION_NOT_RECONCILABLE
```

HTTP:

```text
409
```

Unknown job:

```text
404 CALCULATION_JOB_NOT_FOUND
```

---

# Callback-Triggered Reconciliation

Expose a callback-trigger endpoint such as:

```http
POST /executor-callbacks/airflow
```

Request identifies the external execution:

```json
{
  "airflowDagId": "dpr_asset_summary",
  "airflowDagRunId": "cost-engine-..."
}
```

The callback payload is only a **signal**.

Do not accept callback-provided SUCCESS/FAILED as authoritative state.

Flow:

```text
callback identity
→ locate execution_attempt by stored airflow identity
→ call the same reconcileExecutionAttemptService(...)
→ executor.getExecutionStatus(...)
→ reconcile from executor source of truth
```

Unknown callback identity:

```text
404 EXECUTION_ATTEMPT_NOT_FOUND
```

Real Airflow callback authentication/signature integration is not part of this task because real Airflow integration is not implemented yet. Do not invent production credentials or a custom Airflow API.

---

# Local Lock Ordering for Execution State

Task 004 already mutates job + attempt state during dispatch confirmation.

Task 005 must use the same local lock order whenever both rows are mutated:

```text
1. calculation_job
2. execution_attempt
```

A callback may start with attempt identity, but it must first resolve the owning job id without holding conflicting locks, then acquire mutation locks in the canonical order above.

Do not introduce an `execution_attempt → calculation_job` lock inversion that can deadlock against Task-004 dispatch-result recording.

---

# Reconciliation State Mapping

## Case A — Local DISPATCHING + External RUNNING

This is ambiguous-dispatch recovery.

Local before:

```text
attempt = DISPATCHING
job = PENDING or FAILED
```

External lookup proves the run exists.

Atomically:

```text
attempt DISPATCHING → ACCEPTED
accepted_at = now() if null
job PENDING/FAILED → RUNNING
```

Do not create a new attempt.

## Case B — Local DISPATCHING + External SUCCEEDED

The external execution may have completed before the backend ever recorded acceptance.

Atomically record the confirmed final fact:

```text
attempt DISPATCHING → SUCCEEDED
accepted_at = now() if null
finished_at = now()
job PENDING/FAILED → SUCCEEDED
```

No intermediate committed `RUNNING` state is required.

The same attempt identity remains the historical execution record.

## Case C — Local DISPATCHING + External FAILED

Atomically:

```text
attempt DISPATCHING → FAILED
accepted_at = now() if null
finished_at = now()
job PENDING/FAILED → FAILED
```

For a retry attempt where the job was already `FAILED`, the job remains `FAILED`; the new attempt becomes terminal `FAILED`.

## Case D — Local ACCEPTED + External RUNNING

Expected steady state:

```text
attempt = ACCEPTED
job = RUNNING
```

No state transition.

Return current durable state idempotently.

## Case E — Local ACCEPTED + External SUCCEEDED

Atomically:

```text
attempt ACCEPTED → SUCCEEDED
finished_at = now()
job RUNNING → SUCCEEDED
```

Dataset remains:

```text
BUILDING
```

Task 006 owns `BUILDING → VALIDATING`.

## Case F — Local ACCEPTED + External FAILED

Atomically:

```text
attempt ACCEPTED → FAILED
finished_at = now()
job RUNNING → FAILED
```

Dataset remains `BUILDING`.

Task-004 `POST /calculation-jobs/:jobId/run` may then create a new retry attempt against the same immutable snapshot.

---

# Terminal Idempotency and Stale Callbacks

Historical attempts are immutable.

A duplicate reconciliation observation of the same terminal result is a no-op.

Examples:

```text
local attempt SUCCEEDED
external SUCCEEDED
→ no-op
```

```text
local attempt FAILED
external FAILED
→ no-op
```

## Stale callback for an older attempt

A job may later have a newer attempt.

Example:

```text
Attempt 1 FAILED
job FAILED

Run retry
Attempt 2 ACCEPTED
job RUNNING

late callback arrives for Attempt 1
```

Reconciliation of Attempt 1 must **never** change the current logical job back to FAILED.

Rules:

- identify the exact attempt by stable identity,
- determine whether a newer attempt exists,
- old terminal attempts may be verified idempotently,
- never apply an old attempt's terminal state to the logical job when a newer attempt exists.

This stale-callback rule is mandatory.

---

# Terminal Contradiction

If local historical terminal state and executor terminal state contradict:

```text
local SUCCEEDED
external FAILED
```

or:

```text
local FAILED
external SUCCEEDED
```

do not overwrite history.

Treat it as an internal reconciliation anomaly.

Required behavior:

- no local terminal-state mutation,
- surface/log enough identifiers for investigation,
- do not silently pick one side and rewrite history.

Relevant identifiers:

```text
datasetVersionId
jobId
executionAttemptId
attemptNumber
airflowDagId
airflowDagRunId
localAttemptStatus
executorStatus
```

No metrics infrastructure is required in this task.

---

# Executor Unavailable / Not Found

For:

```text
UNAVAILABLE
NOT_FOUND
```

do not mutate:

```text
execution_attempt.status
calculation_job.status
dataset_version.status
```

Return:

```text
503 EXECUTOR_STATUS_UNAVAILABLE
```

This applies whether the local attempt is:

```text
DISPATCHING
ACCEPTED
```

In particular:

```text
DISPATCHING + NOT_FOUND
```

must remain `DISPATCHING`.

Do not infer `DISPATCH_FAILED` from a status-check 404/not-found response.

---

# Response Contract

A successful reconciliation response should expose enough durable state for UI/tests, for example:

```json
{
  "datasetVersionId": "...",
  "datasetStatus": "BUILDING",
  "jobId": "...",
  "jobStatus": "SUCCEEDED",
  "executionAttemptId": "...",
  "attemptNumber": 1,
  "attemptStatus": "SUCCEEDED",
  "airflowDagId": "...",
  "airflowDagRunId": "cost-engine-...",
  "executorStatus": "SUCCEEDED"
}
```

For `RUNNING`, response remains 200 with:

```text
attemptStatus = ACCEPTED
jobStatus = RUNNING
executorStatus = RUNNING
```

Duplicate terminal reconciliation also returns the same durable terminal state.

---

# Error Contract

## CALCULATION_JOB_NOT_FOUND

```text
404
```

Manual reconcile job id does not exist.

## EXECUTION_ATTEMPT_NOT_FOUND

```text
404
```

Callback external identity does not map to a durable attempt.

## EXECUTION_NOT_RECONCILABLE

```text
409
```

Examples:

- only `PREPARED` attempt exists,
- latest attempt is `DISPATCH_FAILED`,
- no executor-backed attempt exists for the job.

## EXECUTOR_STATUS_UNAVAILABLE

```text
503
```

Executor lookup returned `UNAVAILABLE` or `NOT_FOUND`.

Local orchestration state remains unchanged.

## Internal reconciliation anomaly

Terminal contradiction or impossible durable attempt/job combination.

Return generic internal error through the existing error handler and log identifiers. Do not expose internal state-machine details as a normal business error.

---

# Dataset Semantics

Reconciliation changes only execution/job state.

It does not automatically advance dataset publication lifecycle.

After all jobs become `SUCCEEDED`:

```text
dataset_version still BUILDING
```

Task 006 will implement explicit Submit Validation:

```text
BUILDING + all jobs SUCCEEDED
→ VALIDATING
```

Do not implement automatic `BUILDING → VALIDATING` in Task 005.

---

# Required Tests

Use real PostgreSQL for local state transitions/concurrency and FakeExecutor for executor state.

At minimum cover:

## ACCEPTED + RUNNING

Seed/dispatch:

```text
attempt = ACCEPTED
job = RUNNING
fake = RUNNING
```

Reconcile:

```text
no mutation
200
```

## ACCEPTED + SUCCEEDED

Fake state becomes `SUCCEEDED`.

Expected atomic local result:

```text
attempt = SUCCEEDED
job = SUCCEEDED
dataset = BUILDING
```

## ACCEPTED + FAILED

Expected atomic local result:

```text
attempt = FAILED
job = FAILED
dataset = BUILDING
```

## Ambiguous DISPATCHING recovery to RUNNING

Use Task-004 `ACCEPT_THEN_UNKNOWN`:

```text
fake external execution exists
attempt = DISPATCHING
job = PENDING
```

Reconcile while fake is RUNNING:

```text
same attempt → ACCEPTED
job → RUNNING
```

No new attempt/run identity.

## Ambiguous DISPATCHING already SUCCEEDED

Fake execution transitions to `SUCCEEDED` before reconciliation.

Expected:

```text
same attempt DISPATCHING → SUCCEEDED
job PENDING → SUCCEEDED
```

No intermediate durable RUNNING state required.

## Ambiguous retry DISPATCHING already FAILED

Seed prior failed attempt/job, Run retry with ambiguous accepted external execution, then set fake terminal FAILED.

Expected:

```text
retry attempt → FAILED
job remains FAILED
same frozen dataset snapshot
```

## Executor UNAVAILABLE

For an ACCEPTED/RUNNING attempt:

```text
503 EXECUTOR_STATUS_UNAVAILABLE
attempt remains ACCEPTED
job remains RUNNING
```

Also cover local DISPATCHING with the same no-mutation rule.

## Executor NOT_FOUND

For DISPATCHING and ACCEPTED local attempts:

```text
503 EXECUTOR_STATUS_UNAVAILABLE
no local state mutation
```

Specifically assert NOT_FOUND does not become `DISPATCH_FAILED`.

## Duplicate terminal reconciliation

```text
SUCCEEDED + external SUCCEEDED
FAILED + external FAILED
```

Repeated manual/callback reconciliation is idempotent.

## Terminal contradiction

```text
local SUCCEEDED / external FAILED
local FAILED / external SUCCEEDED
```

Expected:

```text
no overwrite
internal anomaly/error
```

## Stale callback after retry

```text
Attempt 1 FAILED
Attempt 2 ACCEPTED
job RUNNING
late callback for Attempt 1
```

Expected:

```text
Attempt 1 remains FAILED
Attempt 2 remains ACCEPTED
job remains RUNNING
```

This test is required.

## Manual Check Status

```http
POST /calculation-jobs/:jobId/reconcile
```

must select the correct active/current attempt and use the common reconciliation service.

## Callback trigger

```http
POST /executor-callbacks/airflow
```

must locate by exact stored external identity and invoke the same reconciliation service.

A callback body must not be able to force local SUCCESS/FAILED without executor lookup.

## Callback unknown identity

```text
404 EXECUTION_ATTEMPT_NOT_FOUND
```

No mutation.

## PREPARED / DISPATCH_FAILED not reconcilable

Manual reconciliation returns:

```text
409 EXECUTION_NOT_RECONCILABLE
```

and does not call executor status lookup.

## No DB transaction around executor lookup

Use a blocking FakeExecutor status lookup barrier.

While `getExecutionStatus()` is blocked, another PostgreSQL connection must be able to acquire the relevant job/attempt row lock.

This proves no database transaction is held across external status latency.

## Concurrent duplicate reconciliation

Run multiple reconciliation calls concurrently after fake state is SUCCEEDED or FAILED.

Expected:

```text
one final terminal state
all successful/idempotent observations converge
no state regression
no duplicate attempt
```

## Task-004 retry integration

After reconciliation produces:

```text
attempt 1 = FAILED
job = FAILED
```

call existing:

```http
POST /calculation-jobs/:jobId/run
```

Expected:

```text
attempt 2 created
same dataset build snapshot
accepted → attempt 2 ACCEPTED + job RUNNING
```

Task 005 must not reimplement retry creation.

## Fake control routes

In non-production fake mode:

```text
mark fake execution SUCCEEDED
→ DB unchanged until reconcile
→ reconcile
→ DB SUCCEEDED
```

and equivalent FAILED path.

Verify fake control routes are absent/disabled in production configuration.

---

# Likely Files / Modules

Exact organization may follow current repository conventions.

Likely additions/changes:

```text
src/executors/calculation-executor.ts
src/executors/fake-executor.ts

src/modules/calculation-job-reconciliation.repository.ts
src/modules/calculation-job-reconciliation.service.ts
src/modules/calculation-job.route.ts
src/modules/calculation-job.errors.ts
src/modules/calculation-job.types.ts

src/modules/executor-callback.route.ts
src/modules/fake-executor-control.route.ts

src/app.ts
scripts/executor-reconciliation.pg.test.ts
package.json
```

Reuse Task-004 execution identity and state. Do not copy dispatch logic into reconciliation.

---

# Architecture Boundaries Codex Must Not Change

Do not change these accepted rules:

1. Executor status lookup is authoritative; callback payload status is not.
2. Executor lookup happens outside PostgreSQL transactions.
3. `DISPATCHING` ambiguity is recovered using the same attempt and stable run identity.
4. `NOT_FOUND`/executor unavailability does not mean financial calculation failure.
5. Only confirmed executor terminal status produces local `SUCCEEDED/FAILED`.
6. Attempt/job terminal transitions representing one external fact are atomic.
7. Dataset remains `BUILDING`; Task 005 does not auto-submit validation.
8. Historical attempts are immutable.
9. Stale callbacks for older attempts cannot overwrite a newer attempt's logical job state.
10. Terminal contradictions are anomalies; do not rewrite terminal history.
11. Retry continues to use Task-004 Run and the immutable Task-003 snapshot.
12. Do not refresh dependency definitions or upstream dataset versions.
13. Do not implement real Airflow or a periodic worker.
14. When both local rows are locked, use `calculation_job → execution_attempt` lock order.

If implementation appears to require breaking one of these boundaries, stop and report the issue instead of redesigning the architecture.

---

# Acceptance Criteria

Task 005 is complete only when all of the following are demonstrated:

```text
CalculationExecutor supports status lookup
FakeExecutor supports RUNNING/SUCCEEDED/FAILED and unavailable lookup
manual POST /calculation-jobs/:jobId/reconcile exists
callback-triggered reconciliation exists
manual and callback paths share one reconciliation service
DISPATCHING + external RUNNING recovers to ACCEPTED + RUNNING
DISPATCHING + external terminal state converges directly to local terminal state
ACCEPTED + external SUCCEEDED atomically sets attempt/job SUCCEEDED
ACCEPTED + external FAILED atomically sets attempt/job FAILED
dataset remains BUILDING after job completion
NOT_FOUND/UNAVAILABLE returns 503 and preserves local state
duplicate terminal observations are idempotent
stale callback for old attempt cannot regress current job
terminal contradiction is detected without overwrite
executor lookup occurs outside DB transaction
Task-004 Run can retry a reconciliation-produced FAILED job
development FakeExecutor controls mutate fake state only
real PostgreSQL tests cover atomicity/concurrency
no validation/publication/real-Airflow/periodic-worker logic is introduced
```

Passing tests are not sufficient if callback payloads directly drive terminal state, executor lookup is performed inside a database transaction, stale callbacks can overwrite a newer attempt, or executor-unavailable responses are mapped to calculation failure.
