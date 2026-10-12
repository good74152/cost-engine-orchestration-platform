# Task 007B-1 — Late Dispatch Response After Terminal Reconciliation

- Status: Bounded implementation spec ready for system-owner review.
- Goal: correct **CON-01 only**, as proven by Task 007A. Do not change CON-02 semantics or work around it speculatively.
- Base: latest main after Task 007 architecture docs are merged; bring the exact deterministic 007A test harness onto the implementation branch in a controlled fashion.
- References: ADR-0005, ADR-0007; Task 007A result/evidence artifacts on feature/task-007a-concurrency-investigation.

## Proof motivating change

A /run request marks attempt DISPATCHING and commits; the executor creates external X but delays ACCEPTED. Another request reconciles X to SUCCEEDED, committing job/attempt SUCCEEDED. When the delayed ACCEPTED arrives, current recordDispatchOutcome in src/modules/calculation-job-run.service.ts throws CalculationStateInvariantError rather than recognizing the authoritative terminal result. The original /run returns HTTP 500. Real PostgreSQL evidence showed no state regression and exactly one attempt/snapshot/external run.

Fix the false HTTP 500, not the terminal state machine.

## Required public behavior

When recordDispatchOutcome receives an actual dispatch result ACCEPTED or ALREADY_EXISTS for identity X and an exact reload under the canonical job → attempt lock finds that **the same attempt X** is now terminal SUCCEEDED or FAILED:

- Return **HTTP 200**, not HTTP 500.
- Return a durable-state-consistent Run result: exact original executionAttemptId, attemptNumber, airflowDagId, airflowDagRunId and frozen datasetBuildSnapshotId; attemptStatus reflects persisted SUCCEEDED/FAILED, never the stale DISPATCHING.
- Preserve dispatchOutcome as the **observed dispatch result** (ACCEPTED or ALREADY_EXISTS), not an invented terminal execution result.
- jobStatus reflects the current logical job status. If another retry attempt has since started, do not represent the old attempt as the job's current execution or mutate current job; identity fields still refer to the original attempt.
- datasetStatus must not be hardcoded BUILDING in this overtaken-terminal path. Resolve current durable dataset state; later VALIDATING/PUBLISHED/REJECTED/ABANDONED are possible after terminal reconciliation and other lifecycle decisions.
- Never update the already-terminal attempt or job, including timestamps, diagnostics, history or a newer active attempt.
- Do not create an attempt and do not contact the executor a second time to produce this response.
- Normal DISPATCHING → ACCEPTED / RUNNING behavior remains unchanged; ACCEPTED/RUNNING idempotent case remains unchanged.
- A delayed UNKNOWN observation after the same attempt has already durably reached terminal state should also avoid a false invariant/500, returning persisted facts. Unknown does not override executor-confirmed success/failure.
- A definite REJECTED response that conflicts with a terminal executed attempt is an **executor contract contradiction**, not a late ACCEPTED idempotency case; surface it as an anomaly without rewriting history. Do not silently return a successful dispatch-result claim.
- A local DISPATCH_FAILED attempt followed by a late ACCEPTED result is **CON-02**, explicitly excluded. Do not add DISPATCH_FAILED → ACCEPTED and do not suppress it as ordinary success.

Use the existing public Run response shape wherever possible:
~~~json
{
  "datasetVersionId": "...",
  "datasetStatus": "BUILDING",
  "datasetBuildSnapshotId": "...",
  "jobId": "...",
  "jobStatus": "SUCCEEDED",
  "executionAttemptId": "...",
  "attemptNumber": 1,
  "attemptStatus": "SUCCEEDED",
  "airflowDagId": "...",
  "airflowDagRunId": "...",
  "dispatchOutcome": "ACCEPTED"
}
~~~

The sample datasetStatus is BUILDING for the original 007A test, not a universal invariant for late responses. A bounded widening of CalculationJobRunResult types may be necessary; do not change unrelated response DTOs or make result fields optional without a reason.

## Transaction and concurrency details

- Preserve the existing external call boundary: beginDispatch transaction commits before executor.dispatch.
- Record/verify outcome in the later transaction with calculation_job row locked **before** execution_attempt.
- Revalidate attempt ownership, attempt number, DAG id and run id. Do not treat a terminal attempt for another identity as idempotent.
- Avoid joined stale-dataset reads when waiting on job/attempt locks: reload the durable dataset state after locks using a nonlocking read as appropriate; never acquire dataset_series/dataset_version FOR UPDATE *after* holding job/attempt rows.
- Read the frozen snapshot ID in the existing Task-003 contract, or use the exact verified snapshot identity from the durable dispatch command. Do not recalculate/re-freeze inputs.
- Do not regress terminal attempt and job even when multiple late responses return in arbitrary order.
- Do not hide identity mismatch, impossible PREPARED transition, or contradictory REJECTED-vs-terminal facts behind success.

## Mandatory deterministic real PostgreSQL tests

1. **CON-01-RECONCILE_FIRST:** Reuse the exact 007A barrier sequence. Verify /run 200, attempt/job SUCCEEDED, same frozen input and attempt identity, one external execution, no state rewrite/timestamp change.
2. **CON-01-DISPATCH_FIRST:** /run accepted 200 then reconciliation SUCCEEDED 200; unchanged.
3. **CON-01-TERMINAL_FAILED:** external FAILED is reconciled before late ACCEPTED; /run 200 returns persisted FAILED attempt/job, no new attempt.
4. **CON-01-LATER_LIFECYCLE:** after reconciliation terminalizes attempt, finish other jobs and submit VALIDATING (optionally PUBLISHED or ABANDONED as legally allowed) before releasing delayed dispatch response; no false 500, returned dataset status consistent with durable read.
5. **CON-01-RETRY_STARTED:** old attempt FAILED and new attempt prepared/accepted before late response; no old-history rewrite, no overwrite of new job/attempt; response identifies old attempt while representing current job state.
6. **CON-01-LATE_UNKNOWN:** executor returns UNKNOWN but another executor status reconciliation has durably terminalized same attempt; no status regression or false 500.
7. **CON-01-CONTRADICTION:** late REJECTED following proven external execution terminal result remains internal anomaly; no history rewrite.
8. Existing Task-004 dispatch and Task-005 reconciliation PostgreSQL suites; Task-006 lifecycle suite; migration/creation/first-run suites where shared types/repositories change.
9. Preserve job → attempt NOWAIT/proof and no open DB transaction during external wait.

Tests must use deterministic executor response barriers, PostgreSQL fixtures and SQL persistence assertions. Timeouts are watchdogs only; do not schedule races with sleeps. Assert public HTTP codes and actual persisted data.

## Likely source files

- src/modules/calculation-job-run.service.ts (small conditional handling, state reload)
- src/modules/calculation-job-run.repository.ts (if bounded current state reload helper is needed)
- src/modules/calculation-job.types.ts (typed persisted terminal result; preserve response keys)
- scripts/cross-workflow-concurrency-investigation.pg.test.ts (carry/reframe relevant 007A tests)
- scripts/execution-attempt-dispatch-fake-executor.pg.test.ts (only if beneficial)

Do not edit migrations, Task-005 terminal decision rules, FakeExecutor rejection semantics or lifecycle endpoints.

## Scope restrictions and blockers

This PR is **not** the solution to CON-02. Do not make the current invalid FakeExecutor REJECTED→ACCEPTED red test green by rewriting DISPATCH_FAILED terminal history or weakening it. Carry CON-02 evidence as a separate documented blocker for 007B-2. The combined 007A suite may need splitting or specifically re-homing CON-02 to a pending architecture-gated test suite, but no misleading skip/TODO or false-green tests are permitted.

If the only proposed fix requires changing accepted attempt transitions, series lock protocols, dispatch identity semantics, or an executor rejection guarantee, STOP and return to architecture review.

## Code-review / merge gate

- [ ] Verified CON-01 red before fix, green after fix on real PostgreSQL.
- [ ] Honest 200 terminal durable-state result for valid late ACCEPTED/ALREADY_EXISTS/UNKNOWN.
- [ ] Exact execution attempt identity, snapshot and terminal history preserved.
- [ ] Contradictory REJECTED not silently accepted; CON-02 remains explicitly tracked.
- [ ] No DB lifecycle row lock or transaction during executor call.
- [ ] Job → attempt lock ordering unchanged.
- [ ] Relevant existing PostgreSQL suites green, commands/environment recorded.
- [ ] Owner reviews diff, response contract, regression quality and remaining CON-02 risk before merge.

Task 007B-1 is not the final Task 007B completion gate.
