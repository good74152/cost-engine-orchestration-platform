# Task 007A — Cross-Workflow Concurrency Investigation

- Status: Ready for bounded investigation; NO production implementation changes.
- Baseline: main 85479c723090de8dc96cdb0a13472f3156b5e8f9.
- Owner review is required before deciding any 007B remediation.

## Goal

Determine whether two suspected Task-004/005 cross-workflow race conditions are real lifecycle/HTTP bugs or only inconsistent executor behavior. Prove claims using deterministic real PostgreSQL tests and controlled executor barriers.

## Scope

Read:
- docs/adr/0005-execution-attempts-and-airflow-reconciliation.md
- docs/adr/0007-dataset-terminal-decisions-and-publication-serialization.md
- src/modules/calculation-job-run.service.ts and related repository
- src/modules/calculation-job-reconciliation.service.ts and related repository
- src/executors/calculation-executor.ts and fake-executor.ts
- existing dispatch, reconciliation and lifecycle PG tests

Add focused test-only fixtures/barriers and regression demonstrations. No schema migrations; no changes to production services, routers, state machines, transaction boundaries, or executor contract.

## Investigation CON-01 — late dispatch result vs terminal reconciliation

Control the two concurrent requests:

~~~text
A POST /calculation-jobs/:id/run
  → durable DISPATCHING committed
  → fake external run created
  → block return of ACCEPTED to caller A

B POST /calculation-jobs/:id/reconcile
  → fake external status now SUCCEEDED
  → commits attempt SUCCEEDED, job SUCCEEDED

release A dispatch response
  → observe public response, error, durable state
~~~

Assert:
- exactly one durable execution_attempt, one stable airflow identity and one fake external execution;
- no terminal state regression, no extra attempt or snapshot change;
- capture exact HTTP response/error of A (suspected generic 500);
- terminal history and dataset BUILDING stay consistent.

Also run the reverse interleaving where dispatch outcome is recorded before reconciliation. Use explicit barriers and PostgreSQL assertions, not sleep-only scheduling.

## Investigation CON-02 — definite rejection vs acceptance for same identity

Implement test-only controlled executor responses with explicit synchronization, in both orders:
~~~text
A and B POST /run for the same job and same stable external run identity
A sees REJECTED (definite no-run)
B sees ACCEPTED or ALREADY_EXISTS
record outcomes with A-first and B-first DB ordering
~~~

Prove/record:
1. whether valid FakeExecutor behavior can produce this sequence;
2. whether a deliberately contradictory test executor would violate CalculationExecutor's REJECTED contract;
3. whether durable DISPATCH_FAILED can exist simultaneously with a confirmed external run;
4. whether another /run or /reconcile can recover without duplicating an external execution;
5. which existing tests already constrain these outcomes.

Classify each outcome as:
- supported valid behavior / safely handled,
- external adapter contract violation (not a legal regression of the core platform),
- genuine local concurrency bug requiring 007B.

Do not treat arbitrary contradictory test-executor responses as proof that real executors may legitimately contradict definite rejection.

## Transaction and lock verification

Inspect concurrent job → attempt locks and release of PostgreSQL transaction before external dispatch, with explicit second-connection NOWAIT verification where appropriate. Confirm no reversal of accepted ordering.

## Deliverables

- Deterministic reproduction tests or dedicated test-only harness with documented commands.
- Short evidence report containing interleaving, actual response/status, DB state, executor state, violated invariant (if any), and whether the executor behavior was contract-conforming.
- A reviewed proposed response contract for CON-01 only if it is reproduced.
- A reviewed architecture decision checkpoint for CON-02 before any precedence/state change is attempted.

## Pass / PR handling

This investigation may discover a failing desired-behavior regression. Never add skip, todo, or a passing assertion that encodes the bug as intended behavior. A red PR may be **reviewed**, but cannot be merged until a bounded 007B follow-up fixes the defect and the same deterministic tests pass.

If no defect is found, attach the deterministic green proof and close 007B as not needed for that finding.

Acceptance:
- [ ] Both races reproduced or conclusively ruled out with controlled interleavings.
- [ ] Executor contract validity documented separately from local code behavior.
- [ ] Exact public responses, database state, and external fake state captured.
- [ ] No production code or migration changes.
- [ ] System owner reviews priority, classification, and necessary 007B scope.

Do not delegate Task 007B automatically.
