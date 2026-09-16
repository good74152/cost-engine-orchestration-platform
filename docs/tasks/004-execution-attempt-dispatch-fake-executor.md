# Task 004 — Execution Attempt Dispatch + FakeExecutor

## Goal

Implement the public calculation-job Run/Retry boundary on top of the durable `PREPARED` execution attempt created by Task 003.

This task owns executor dispatch semantics:

```text
PREPARED
  ↓
DISPATCHING
  ├── definite rejection → DISPATCH_FAILED
  ├── ambiguous outcome → remain DISPATCHING
  └── accepted/existing external run → ACCEPTED
                                     + calculation_job → RUNNING
```

The executor call must occur **outside** the PostgreSQL transaction that prepares or mutates the attempt.

This task also introduces a deterministic `FakeExecutor` so dispatch acceptance, rejection, response loss, duplicate run identity, and retry behavior can be tested without a real Airflow deployment.

This task does **not** reconcile terminal executor `SUCCESS/FAILED` states. Task 005 owns executor status reconciliation and job terminal transitions.

---

## Required Reading

Before implementation, read and treat these files as authoritative:

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/adr/0003-versioned-dependencies-and-build-snapshot.md`
4. `docs/adr/0004-series-serialization-and-lock-ordering.md`
5. `docs/adr/0005-execution-attempts-and-airflow-reconciliation.md`
6. `docs/adr/0006-first-run-lock-hierarchy.md`
7. `docs/tasks/003-first-run-immutable-build-snapshot.md`

Task 003 is the authoritative implementation for first-run build freezing and initial `PREPARED` attempt creation.

If implementation reveals a conflict with an accepted ADR or the current schema cannot represent the required behavior, stop and report the architecture conflict. Do not silently redesign state machines, snapshot semantics, or executor identity.

---

## Current Repository State

Task 003 is merged into `main`.

The current preparation service:

```ts
prepareCalculationJobRunService(jobId)
```

already guarantees, for a runnable `PENDING` job:

```text
BUILDING dataset version
+ immutable dataset_build_snapshot
+ frozen resolved dependency-definition ids
+ selected calculation_job still PENDING
+ selected execution_attempt PREPARED
+ stable airflow_dag_id
+ stable airflow_dag_run_id
```

Do not duplicate or bypass this logic.

The v2 schema already provides:

```text
execution_attempts
- id
- calculation_job_id
- attempt_number
- status
- airflow_dag_id
- airflow_dag_run_id
- dispatch_started_at
- accepted_at
- finished_at
- last_dispatch_error
```

with database protection for:

```text
UNIQUE(calculation_job_id, attempt_number)
UNIQUE(airflow_dag_id, airflow_dag_run_id)
partial UNIQUE(calculation_job_id)
  WHERE status IN ('PREPARED','DISPATCHING','ACCEPTED')
```

No schema migration is expected for Task 004.

---

## Bounded Scope

Implement one coherent execution-dispatch slice:

- expose the final public Run/Retry endpoint,
- reuse Task 003 preparation for initial `PENDING` execution,
- support retry preparation for a `FAILED` logical job without changing the frozen dataset snapshot,
- introduce an executor abstraction,
- introduce `FakeExecutor`,
- transition `PREPARED → DISPATCHING` before external dispatch,
- perform executor dispatch outside any open PostgreSQL transaction,
- atomically record confirmed executor acceptance as:
  - `execution_attempt DISPATCHING → ACCEPTED`,
  - `calculation_job PENDING/FAILED → RUNNING`,
- record definite dispatch rejection as `DISPATCH_FAILED` while leaving the job in its prior logical state,
- preserve `DISPATCHING` on ambiguous dispatch outcome,
- recover duplicate/existing external run identity using the same attempt and same `airflow_dag_run_id`,
- add route/error contracts and PostgreSQL + FakeExecutor integration tests.

### Explicitly not in scope

Do not implement:

- real Airflow HTTP integration,
- executor terminal-state reconciliation,
- `ACCEPTED → SUCCEEDED/FAILED`,
- `calculation_job RUNNING → SUCCEEDED/FAILED`,
- Airflow callback endpoints,
- manual Check Status endpoint,
- periodic reconciliation worker,
- Submit Validation,
- Publish/Reject/Abandon,
- Airflow cancellation,
- dependency-definition management APIs,
- changing the dataset build snapshot after Task 003 freeze,
- resolving a newer upstream dataset version during retry,
- queues, RabbitMQ, Kafka, Redis, or background workers.

---

# Public API

Expose:

```http
POST /calculation-jobs/:jobId/run
```

There is no separate `/retry` endpoint.

The same endpoint means:

```text
PENDING job → first execution
FAILED job  → retry execution
```

The backend determines the behavior from durable state.

Caller must not provide:

```text
attempt number
airflow dag id
airflow dag run id
upstream dataset versions
dependency-definition version
snapshot id
```

All execution identity and business-input identity are system-owned.

---

## Success Response

A successful confirmed dispatch should return at least:

```json
{
  "datasetVersionId": "...",
  "datasetStatus": "BUILDING",
  "datasetBuildSnapshotId": "...",
  "jobId": "...",
  "jobStatus": "RUNNING",
  "executionAttemptId": "...",
  "attemptNumber": 1,
  "attemptStatus": "ACCEPTED",
  "airflowDagId": "...",
  "airflowDagRunId": "cost-engine-...",
  "dispatchOutcome": "ACCEPTED"
}
```

Exact DTO naming may follow existing repository conventions, but the semantic information must remain available.

If the same attempt was already confirmed `ACCEPTED`, repeated `/run` may return the same durable state idempotently instead of creating or dispatching a new attempt.

---

# Executor Abstraction

Introduce a narrow executor boundary such as:

```ts
interface CalculationExecutor {
  dispatch(command: DispatchCalculationCommand): Promise<DispatchResult>;
}
```

Task 004 needs only dispatch behavior. Task 005 may extend the abstraction with executor-status lookup.

Do not expose PostgreSQL rows directly to the executor implementation.

## Dispatch result model

The executor boundary must distinguish at least:

```ts
type DispatchResult =
  | { kind: 'ACCEPTED' }
  | { kind: 'ALREADY_EXISTS' }
  | { kind: 'REJECTED'; message: string }
  | { kind: 'UNKNOWN'; message: string };
```

Equivalent naming is acceptable, but these semantics must remain distinct.

### `ACCEPTED`

The executor confirms that the external execution exists.

### `ALREADY_EXISTS`

The same stable external execution identity already exists.

This is an idempotency/recovery signal, not a failure.

For Task 004, confirmed existence is sufficient to record:

```text
attempt = ACCEPTED
job = RUNNING
```

Task 005 will later reconcile whether that external run is still running or already terminal.

### `REJECTED`

The executor definitively rejected dispatch and the adapter can establish that no external execution was created for this request.

Examples conceptually include:

```text
invalid DAG identity
invalid executor request
explicit executor rejection
```

### `UNKNOWN`

The backend cannot know whether an external execution was created.

Examples:

```text
timeout
connection reset
response lost
ambiguous transport/server failure
```

Unknown must never be converted into `DISPATCH_FAILED`.

---

# Dispatch Command

Build the executor command from durable frozen state.

It should identify at least:

```text
executionAttemptId
attemptNumber
jobId
datasetVersionId
datasetBuildSnapshotId
calculationTypeId
calculationTypeCode
resolvedDependencyDefinitionVersionId
airflowDagId
airflowDagRunId
relevant frozen upstream dependencies
```

## Relevant dependency subset

Do not send every unioned dataset-snapshot dependency blindly to every job.

For the selected job:

1. read its frozen `resolved_dependency_definition_version_id`,
2. read the direct required domains for that definition,
3. map those domains to the already-frozen `dataset_build_snapshot_dependencies`,
4. include only that job's required concrete upstream dataset versions.

Example:

```text
DPR v5 shared snapshot:
CAPEX     → v11
INSURANCE → v3
ONE_STD_COST → v8

Job A definition requires:
CAPEX

Job A dispatch command receives:
CAPEX → v11
```

A published definition with zero dependencies produces an empty upstream dependency list.

If the frozen job definition requires a domain that cannot be found in the immutable snapshot, treat it as an internal invariant violation. Do not resolve latest data again.

---

# Run Flow

The public service may be structured as one orchestration service such as:

```ts
runCalculationJobService(jobId, executor)
```

The following phases are mandatory.

---

## Phase 1 — Obtain or Reuse a Durable Attempt

### PENDING job

Use the Task 003 preparation service.

```text
prepareCalculationJobRunService(jobId)
```

It must continue to own:

```text
DRAFT first-run snapshot freeze
BUILDING snapshot reuse
PREPARED attempt creation/idempotency
```

Do not copy Task 003 SQL into the Task 004 dispatch service.

### FAILED job

Task 004 must support retry preparation.

A retry means:

```text
same dataset_version
same dataset_build_snapshot
same resolved dependency-definition version
new execution_attempt
```

It must never mean:

```text
resolve latest dependencies again
select newer upstream data
create a new dataset_build_snapshot
```

Implement a bounded retry-preparation transaction/service.

Required retry transaction semantics:

```text
lock output dataset_version
→ require BUILDING
→ verify exactly one existing dataset_build_snapshot
→ lock selected calculation_job
→ require job FAILED
→ verify frozen resolved dependency-definition id exists
→ if active attempt already exists, reuse/return it when semantically valid
→ otherwise allocate MAX(attempt_number)+1
→ create new PREPARED execution_attempt
→ commit
```

The job remains `FAILED` while the new attempt is only `PREPARED` or `DISPATCHING`.

It becomes `RUNNING` only after executor acceptance is confirmed.

### SUCCEEDED job

Not runnable.

Return:

```text
409 JOB_NOT_RUNNABLE
```

### Dataset not BUILDING for retry

Retry is not allowed once the dataset is `VALIDATING` or terminal.

Return:

```text
409 JOB_NOT_RUNNABLE
```

---

# Phase 2 — Begin Dispatch Transaction

Before calling the executor, execute a short PostgreSQL transaction.

Lock/reload the selected active execution attempt and enough job/dataset state to validate the dispatch.

### PREPARED

Atomically transition:

```text
PREPARED → DISPATCHING
```

Set:

```text
dispatch_started_at = now()
```

Build/read the durable dispatch command from frozen state.

Commit.

### DISPATCHING

Reuse the same attempt and same stable run identity.

Do not create another attempt.

A repeated `/run` request may resume dispatch using the same:

```text
airflow_dag_id
airflow_dag_run_id
```

This is the response-loss recovery path.

### ACCEPTED

Do not call the executor again.

Return the already-confirmed durable execution state idempotently.

### Terminal attempt

A terminal attempt is not active. The service should prepare a new attempt only if the logical job state permits another execution:

```text
PENDING after DISPATCH_FAILED → new attempt allowed
FAILED after confirmed execution failure → new retry attempt allowed
```

Do not mutate a terminal attempt back to a non-terminal status.

---

# Phase 3 — External Executor Call

After the dispatch transaction commits:

```text
await executor.dispatch(command)
```

There must be no open PostgreSQL transaction from Phase 2 while this call waits.

Do not hold:

```text
dataset_version row locks
calculation_job row locks
execution_attempt row locks
dataset_series row locks
```

across executor latency.

---

# Phase 4 — Record Dispatch Outcome

Use a new short PostgreSQL transaction.

## ACCEPTED / ALREADY_EXISTS

Lock/reload the execution attempt and calculation job.

If the same attempt is still `DISPATCHING`, atomically record:

```text
execution_attempt.status = ACCEPTED
execution_attempt.accepted_at = now()
calculation_job.status = RUNNING
```

Allowed logical job source states are:

```text
PENDING
FAILED
```

These paired mutations represent one confirmed fact and must commit atomically.

If another request already recorded the same attempt as `ACCEPTED` and job as `RUNNING`, treat the result idempotently.

Never move an already-terminal attempt backward to `ACCEPTED`.

## REJECTED

If the attempt is still `DISPATCHING`:

```text
execution_attempt.status = DISPATCH_FAILED
execution_attempt.finished_at = now()
execution_attempt.last_dispatch_error = <message>
```

The calculation job remains unchanged:

```text
initial dispatch rejection:
PENDING stays PENDING

retry dispatch rejection:
FAILED stays FAILED
```

The immutable dataset build snapshot remains unchanged.

Return a stable executor-dispatch error.

## UNKNOWN

Do not transition the attempt to a terminal state.

Keep:

```text
execution_attempt.status = DISPATCHING
```

Optionally persist the diagnostic message into:

```text
last_dispatch_error
```

The calculation job remains unchanged:

```text
PENDING stays PENDING
FAILED stays FAILED
```

Return an HTTP response that communicates durable-but-unconfirmed execution state.

Use:

```text
202 Accepted
```

with a response containing the existing attempt identity/status.

Do not return `EXECUTOR_DISPATCH_FAILED` for an ambiguous outcome.

---

# FakeExecutor

Implement an in-process `FakeExecutor` for deterministic tests/demo.

It is an external-system test double, not a replacement for PostgreSQL orchestration state.

## Required fake semantics

The fake must key external executions by:

```text
(airflow_dag_id, airflow_dag_run_id)
```

and must enforce one fake external execution per stable identity.

Support deterministic scripted dispatch outcomes for tests:

### ACCEPT

```text
first dispatch
→ create fake external run
→ return ACCEPTED
```

### REJECT

```text
dispatch
→ do not create fake run
→ return REJECTED
```

### ACCEPT_THEN_UNKNOWN

Simulate response loss:

```text
dispatch
→ create fake external run
→ caller receives UNKNOWN
```

A later dispatch using the same run identity must return:

```text
ALREADY_EXISTS
```

and must not create a second fake execution.

### UNKNOWN_WITHOUT_CREATION

Optional but useful for testing transport ambiguity where no fake run happened.

A later retry with the same attempt identity may then succeed or reject according to the next configured fake behavior.

## Fake execution state

The fake may store an internal executor state such as:

```text
RUNNING
SUCCESS
FAILED
```

Task 004 only needs dispatch creation/identity behavior.

Task 005 will consume terminal fake state through executor-status lookup.

Programmatic test control is allowed now. Public fake-control HTTP routes are not required in Task 004.

## Production guard

`FakeExecutor` must never be silently enabled in production.

Use explicit executor configuration, for example:

```text
EXECUTOR_TYPE=fake
```

and fail fast if fake execution is requested under production configuration.

Do not implement real Airflow solely to provide a production alternative in this task.

---

# Idempotency and Concurrency Semantics

## Same job, concurrent initial Run

Two or more concurrent requests for the same `PENDING` job must converge on:

```text
one immutable dataset_build_snapshot
one active execution_attempt
one airflow_dag_run_id
one actual FakeExecutor execution identity
```

The unique active-attempt index and stable external run identity are database/executor backstops.

Concurrent HTTP calls may both contact the fake using the same stable run id, but they must not create two actual external executions.

## Repeated Run while PREPARED

Use the same PREPARED attempt.

Do not allocate another attempt number.

## Repeated Run while DISPATCHING

Reuse the same attempt and same external run identity.

This is the ambiguous-dispatch recovery path.

## Repeated Run while ACCEPTED

Return existing accepted state.

Do not redispatch and do not allocate a new attempt.

## Dispatch failure retry

After:

```text
Attempt 1 = DISPATCH_FAILED
Job = PENDING
```

another `/run` may create:

```text
Attempt 2 = PREPARED
```

against the same frozen snapshot.

## Calculation failure retry

After Task 005 later produces:

```text
Attempt 1 = FAILED
Job = FAILED
```

Task 004's Run path must support:

```text
new Attempt 2
same frozen dataset snapshot
executor accepted
Job FAILED → RUNNING
```

Task 004 tests may seed the terminal failed state directly through test helpers because Task 005 is not implemented yet.

---

# Error Contract

Expected public errors must not fall through to generic `500`.

## `CALCULATION_JOB_NOT_FOUND`

```text
404
```

No mutation.

## `DEPENDENCY_DEFINITION_NOT_READY`

```text
409
```

Propagated from Task 003 first-run preparation.

## `DEPENDENCY_NOT_READY`

```text
409
```

Propagated from Task 003 first-run preparation.

## `JOB_NOT_RUNNABLE`

```text
409
```

Examples:

- job `SUCCEEDED`,
- retry requested while dataset is `VALIDATING/PUBLISHED/REJECTED/ABANDONED`,
- state combination violates allowed Run/Retry lifecycle.

## `EXECUTOR_DISPATCH_FAILED`

Use for a definite external dispatch rejection where no external run was created.

Recommended HTTP status:

```text
502 Bad Gateway
```

The error response should use the stable code:

```text
EXECUTOR_DISPATCH_FAILED
```

The attempt must already be durable as `DISPATCH_FAILED` before the error response is sent.

## Ambiguous dispatch outcome

Do **not** return `EXECUTOR_DISPATCH_FAILED`.

Return:

```text
202 Accepted
```

with:

```text
attemptStatus = DISPATCHING
```

and the stable existing attempt identity.

## Internal invariant failure

Examples:

- `BUILDING` dataset missing its one frozen snapshot,
- selected job's frozen dependency definition requires an upstream domain absent from the snapshot,
- attempt/job durable states contradict the accepted state machine.

These are internal errors, not normal `409` business conflicts.

Log enough identifiers to investigate:

```text
datasetVersionId
datasetBuildSnapshotId
jobId
executionAttemptId
airflowDagId
airflowDagRunId
```

---

# Transaction Boundaries

Task 004 must preserve three separate durability boundaries:

```text
Transaction A
prepare/reuse durable PREPARED attempt
COMMIT

Transaction B
PREPARED → DISPATCHING
build/read durable executor command
COMMIT

NO DB TRANSACTION
executor.dispatch(...)

Transaction C
record ACCEPTED / DISPATCH_FAILED / diagnostic UNKNOWN state
COMMIT
```

Task 003 preparation may internally perform Transaction A as already implemented.

Never merge Transaction B and the executor call into one long transaction.

---

# Required Tests

Use real PostgreSQL for state/transaction/concurrency behavior and `FakeExecutor` for external-system behavior.

At minimum cover:

## Accepted initial dispatch

Given a valid Task-003-compatible `DRAFT` dataset/job:

```text
POST /calculation-jobs/:jobId/run
→ build snapshot frozen
→ attempt PREPARED
→ DISPATCHING
→ FakeExecutor ACCEPTED
→ attempt ACCEPTED
→ job RUNNING
→ dataset BUILDING
```

Assert exactly one fake external execution exists.

## Accepted later job

A second `PENDING` job in the same `BUILDING` dataset:

```text
→ reuses existing dataset_build_snapshot
→ dispatches with that job's relevant frozen dependency subset
→ becomes RUNNING after acceptance
```

No snapshot dependency changes.

## Explicit dispatch rejection from PENDING

Fake mode:

```text
REJECT
```

Expected:

```text
attempt = DISPATCH_FAILED
job = PENDING
dataset = BUILDING
snapshot unchanged
HTTP 502 EXECUTOR_DISPATCH_FAILED
```

## Retry after DISPATCH_FAILED

Next `/run`:

```text
new attempt number
new attempt id
same dataset_build_snapshot
same frozen dependency-definition id
same frozen upstream dataset versions
```

Successful fake acceptance transitions the job to `RUNNING`.

## Ambiguous response loss

Fake mode:

```text
ACCEPT_THEN_UNKNOWN
```

First request:

```text
fake external run exists
attempt = DISPATCHING
job = PENDING
HTTP 202
```

Second `/run`:

```text
same attempt id
same attempt number
same airflow_dag_run_id
FakeExecutor = ALREADY_EXISTS
→ attempt ACCEPTED
→ job RUNNING
```

Assert fake external execution count remains exactly one.

## Unknown without confirmed run

If implemented:

```text
attempt remains DISPATCHING
job remains prior state
same identity reused by later request
```

## Duplicate accepted Run

Once:

```text
attempt = ACCEPTED
job = RUNNING
```

repeated `/run` must:

```text
not create another attempt
not call FakeExecutor again
return existing durable state
```

## Concurrent same-job Run

Execute multiple concurrent Run requests against real PostgreSQL.

Expected final invariants:

```text
one active execution_attempt
one stable airflow_dag_run_id
one actual fake external execution identity
job RUNNING or durable DISPATCHING depending scripted outcome
```

No duplicate logical execution identity.

## Different jobs

Different jobs in the same BUILDING dataset may dispatch independently.

They must:

```text
share the dataset build snapshot
have different execution attempts/run ids
send only their relevant dependency subset
```

## Retry from FAILED logical job

Seed:

```text
dataset = BUILDING
snapshot exists
job = FAILED
previous attempt = FAILED
```

Run again:

```text
new PREPARED attempt number N+1
same snapshot
accepted → job RUNNING
new attempt ACCEPTED
```

The previous failed attempt remains immutable history.

## Retry dispatch rejection from FAILED job

Expected:

```text
new attempt → DISPATCH_FAILED
job remains FAILED
snapshot unchanged
```

## Frozen-input dispatch payload

Freeze:

```text
CAPEX v11
```

Then publish/create a newer CAPEX v12 in test data.

Dispatch a later job in the same dataset.

Executor command must still contain:

```text
CAPEX v11
```

Never query/re-resolve CAPEX v12 for dispatch.

## Job-specific dependency subset

Shared snapshot contains multiple upstream domains.

Assert each FakeExecutor command contains only the domains required by the selected job's frozen dependency definition.

## No-DB-transaction-around-executor test

Use a blocking FakeExecutor dispatch barrier.

While `executor.dispatch()` is intentionally blocked, open another PostgreSQL connection and prove the application is not still holding the Phase-2 row locks/transaction.

For example, a second transaction should be able to acquire an appropriate `FOR UPDATE NOWAIT` lock on the attempt/job row after the application has entered the external fake call.

This test is required because "external call outside DB transaction" is a core architecture invariant, not only a coding-style preference.

## Error contracts

Route-level tests for at least:

```text
CALCULATION_JOB_NOT_FOUND → 404
DEPENDENCY_DEFINITION_NOT_READY → 409
DEPENDENCY_NOT_READY → 409
JOB_NOT_RUNNABLE → 409
EXECUTOR_DISPATCH_FAILED → 502
ambiguous dispatch → 202 with DISPATCHING attempt
```

---

# Likely Files / Modules

Exact organization may follow current conventions.

Likely additions/changes:

```text
src/executors/calculation-executor.ts
src/executors/fake-executor.ts
src/executors/executor-factory.ts

src/modules/calculation-job-run.service.ts
src/modules/calculation-job-run.repository.ts
src/modules/calculation-job.route.ts
src/modules/calculation-job.errors.ts
src/modules/calculation-job.types.ts
src/modules/calculation-job-preparation.*
  (only bounded extension needed for FAILED retry preparation)

src/app.ts
scripts/execution-attempt-dispatch-fake-executor.pg.test.ts
package.json
```

Do not duplicate Task 003 snapshot SQL into a second module merely for convenience.

---

# Architecture Boundaries Codex Must Not Change

Do not change these accepted rules:

1. Dataset build snapshot is dataset-wide and immutable.
2. Retry does not refresh upstream dataset versions.
3. Retry does not refresh dependency-definition versions.
4. `PREPARED` or `DISPATCHING` does not mean the logical calculation is running.
5. `calculation_job → RUNNING` occurs only when external execution existence is confirmed.
6. `DISPATCH_FAILED` means definite no-execution dispatch failure.
7. Ambiguous dispatch remains `DISPATCHING`.
8. Duplicate stable external run identity is a recovery signal, not automatically an error.
9. External executor calls occur outside PostgreSQL transactions.
10. One logical job has at most one non-terminal execution attempt.
11. Historical attempts are immutable execution history; never reuse/reset a terminal attempt.
12. Caller cannot select upstream versions, dependency definitions, attempt number, or run identity.
13. No dataset-level `FAILED` state.

If implementation appears to require breaking one of these boundaries, stop and report the issue instead of redesigning the architecture.

---

# Acceptance Criteria

Task 004 is complete only when all of the following are demonstrated:

```text
POST /calculation-jobs/:jobId/run exists
initial PENDING run uses Task 003 build preparation
FAILED job retry creates a new attempt against the same snapshot
PREPARED → DISPATCHING is durable before executor call
executor call happens outside DB transaction
ACCEPTED/ALREADY_EXISTS atomically sets attempt ACCEPTED + job RUNNING
REJECTED sets attempt DISPATCH_FAILED and preserves prior job state
UNKNOWN keeps attempt DISPATCHING and preserves prior job state
same dag_run_id is reused after ambiguous response
FakeExecutor creates at most one external run per stable identity
same-job concurrent Run cannot create duplicate active attempts/external execution identity
later job dispatch uses frozen snapshot, never newer upstream data
executor command uses only the selected job's frozen dependency subset
public error contracts are deterministic
real PostgreSQL tests cover transaction/concurrency invariants
no real Airflow/reconciliation/publication logic is introduced
```

Passing tests are not sufficient if the implementation holds a database transaction across executor latency, re-resolves dependencies during retry, or can create duplicate external execution identities.
