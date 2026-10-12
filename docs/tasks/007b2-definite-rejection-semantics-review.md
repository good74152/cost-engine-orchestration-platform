# Task 007B-2 — Identity-Scoped Rejection Contract and FakeExecutor Hardening

- Status: Architecture accepted; bounded implementation spec READY for system-owner review.
- Decision: ADR-0008 — Identity-Scoped Definite Dispatch Rejection.
- Evidence: Task 007A investigation report and machine-readable evidence on `feature/task-007a-concurrency-investigation`.
- Implementation: NOT STARTED.
- Dependency: Task 007B-1 is independently reviewable. Coordinate test-harness import/merge to avoid conflicts; do not silently mix CON-01 and CON-02 fixes.

## Goal

Eliminate the exact CON-02 external/local execution identity split proven by Task 007A **under the now-accepted executor contract**:

`REJECTED` means irrevocable **identity-wide** no-run for `(airflow_dag_id, airflow_dag_run_id)`, including overlapping and future same-identity dispatches.

Today the FakeExecutor rejects only one request at the moment no external run exists; another same-identity request can subsequently create that run. A local DISPATCH_FAILED attempt may then coexist with an external RUNNING execution, which is unreconcilable and can lead to duplicate work on retry.

Fix the FakeExecutor's contract compliance, not the accepted execution-attempt state machine.

## Required Reading

- AGENTS.md
- docs/ARCHITECTURE.md
- docs/adr/0005-execution-attempts-and-airflow-reconciliation.md
- docs/adr/0008-identity-scoped-definite-dispatch-rejection.md
- docs/tasks/007-end-to-end-hardening-and-legacy-cleanup.md
- docs/tasks/007b-conditional-concurrency-remediation.md
- docs/tasks/007b1-late-dispatch-terminal-reconciliation.md
- docs/tasks/007a-investigation-results.md and docs/tasks/007a-investigation-evidence.json on the 007A branch
- src/executors/calculation-executor.ts
- src/executors/fake-executor.ts
- src/modules/calculation-job-run.service.ts
- existing Task-004/Task-005 PostgreSQL test suites

Confirm the 007A evidence artifacts and the deterministic harness before editing tests or implementation.

## Bounded Production Scope

### Executor interface semantics

Clarify the `DispatchResult` contract in `src/executors/calculation-executor.ts` or an adjacent concise comment/documented type:

- `REJECTED`: permanent guarantee that this exact identity never existed and will never be created by same-identity dispatch.
- `ACCEPTED`: this identity was created/confirmed.
- `ALREADY_EXISTS`: this identity already exists, treated as accepted identity.
- `UNKNOWN`: no irrevocable identity decision; use same identity to recover/retry/lookup.

Do not introduce a new dispatch outcome enum member or change public HTTP response contracts.

### FakeExecutor permanent rejection marker

Introduce a private identity-scoped permanent rejection set (or equivalent) using the same full execution key as the existing `externalExecutions` map.

Dispatch logic must:

1. Check whether an external run already exists. If yes, return `ALREADY_EXISTS` even if the next scripted behavior would have been REJECT.
2. Check whether the identity is permanently rejected. If yes, return `REJECTED` without creating a run or consuming the next scripted behavior.
3. For a previously unseen identity, consume the scripted/default behavior.
4. On configured `REJECT`, record the identity as permanently rejected **before** returning `REJECTED`.
5. On `ACCEPT` and `ACCEPT_THEN_UNKNOWN`, create exactly one external run.
6. On `UNKNOWN_WITHOUT_CREATION`, do not mark rejection; future same-identity dispatch may create a run.
7. Preserve `getExecutionStatus`, `setExecutionState`, lookup history, and existing fake control routes.

A useful invariant within one FakeExecutor instance:

```text
rejectedIdentities ∩ externalExecutionKeys = ∅
```

The decision/check/update must be atomic with respect to same-instance concurrent `dispatch()` invocations. The current in-memory synchronous region can achieve this if no `await` occurs between the identity checks and decision. Do not add an in-memory mutex as a substitute for a cross-process guarantee.

**Scope honesty:** This tombstone exists only for the lifetime of that FakeExecutor instance. It is not a persisted or cross-process rejection registry. FakeExecutor is not an actual production Airflow adapter; future adapters must independently uphold ADR-0008 or classify results as UNKNOWN.

### Durable orchestration remains unchanged

Under the now-valid rejection guarantee, the backend may continue to use the existing Task-004 path:

```text
attempt DISPATCHING → DISPATCH_FAILED
job remains PENDING or FAILED
HTTP 502 EXECUTOR_DISPATCH_FAILED
```

Repeated same-identity REJECTED results must converge on one immutable DISPATCH_FAILED attempt; they do not create any external execution.

A later independent `/run` after the rejection has been persisted may create attempt 2 with a *new* identity; this is valid because X is permanently rejected. The new identity can be accepted and run.

Do not implement:
- DISPATCH_FAILED → ACCEPTED (forbidden terminal rewrite),
- acceptance-overrides-rejection precedence,
- a new attempt status,
- new database columns or migrations,
- executor cancellation,
- real Airflow integration,
- distributed mutex/lease/queue,
- Task 007C/007D/007E cleanup.

Do not change Task 005 reconciliation selection rules merely to accommodate a rejected attempt; under ADR-0008 there must never be a real external execution for that rejected identity.

## Mandatory Deterministic Tests

Use a real disposable PostgreSQL database with migrations, Fastify.inject, and the FakeExecutor (or a response-delaying wrapper that delegates *actual external processing* unchanged). Explicit barriers must control external processing and DB recording order; timeouts only serve as failure watchdogs.

### 1. CON-02: rejection processed and recorded first

Two overlapping `POST /calculation-jobs/:id/run` calls share **exactly the same** attempt ID and DAG/run identity X.

Fake configured first call REJECT then subsequent ACCEPT:

- First processed response must be REJECTED, with zero external X.
- Second processed response for X **must also be REJECTED**, regardless of scripted ACCEPT; X never exists.
- When first response is recorded before second, both HTTP requests return 502 (definite rejection) or exactly the stable existing contract under review; no generic 500.
- Local attempt 1 DISPATCH_FAILED; job PENDING; external X count 0.
- No new attempt is created by either overlapping request itself.

Then a new independent /run may create attempt 2 with new identity Y; it may succeed. Assert only Y exists externally and snapshot/definition/upstream pins are unchanged.

### 2. CON-02: rejection processed but response order reversed

Same Fake external results as above; second HTTP response returns to backend first.

Both requests must converge on the same rejected attempt with no external X. No internal error or terminal rewrite.

### 3. ACCEPT-first, ALREADY_EXISTS second

Script ACCEPT then REJECT for same X.

- First response ACCEPTED and creates X.
- Second returns ALREADY_EXISTS; configured REJECT must not override X.
- Recording orders both converge to attempt ACCEPTED, job RUNNING, one X.

### 4. UNKNOWN_WITHOUT_CREATION does not tombstone

An unknown response without creation leaves X eligible for a later same-identity retry/dispatch. The later call may create X exactly once, returning ACCEPTED; DB records same attempt identity, not Attempt 2.

### 5. ACCEPT_THEN_UNKNOWN recovery unchanged

The Fake creates X but reports UNKNOWN. Repeated same identity reports ALREADY_EXISTS; DB recovery stays on same attempt. No duplicate X or snapshot refresh.

### 6. Permanent tombstone and scripted-behavior isolation

After X is REJECTED:

- repeated dispatch of X returns REJECTED;
- no additional scripted behavior is consumed;
- a fresh identity Y still consumes the next configured behavior and can be accepted;
- the exact key includes both airflowDagId and airflowDagRunId, not run ID alone;
- test a parallel distinct-identity dispatch to show no global fake serialization is introduced.

### 7. Invalid adapter fixture isolation

Preserve a separate test confirming that an intentionally dishonest adapter that reports REJECTED for an already-created run violates ADR-0008. Do not ask the backend to rewrite DISPATCH_FAILED or silently suppress contradiction to make this invalid test pass.

### 8. Existing regression suites

Run existing Task-004 Run/Retry, Task-005 reconciliation, Task-006 lifecycle and relevant Task-003 snapshot PostgreSQL suites, plus CON-01 tests after Task 007B-1 integration.

Confirm job → attempt lock ordering and that executor calls are outside DB transactions.

## 007A Harness Integration Rule

The original Task-007A CON-02 FakeExecutor sequence expecting REJECTED→ACCEPTED was correct **under the old fake semantics**, but is no longer a valid expected result after ADR-0008.

- Preserve original docs/tasks/007a-investigation-results.md and JSON evidence as historical reproduction evidence.
- Replace the intentionally red expectation with the newly accepted contract behavior, using an explicit comment pointing to ADR-0008.
- Do not `skip`, `todo`, weaken assertions, or fabricate green results.
- Avoid merging a red 007A branch directly to main. Coordinate with Task 007B-1 so the same investigation suite is not imported or rewritten independently in two competing branches.

## Likely Files

- src/executors/calculation-executor.ts (contract comment)
- src/executors/fake-executor.ts (private rejection marker and dispatch guard)
- scripts/cross-workflow-concurrency-investigation.pg.test.ts and/or a focused new Task-007B-2 PG regression suite
- scripts/execution-attempt-dispatch-fake-executor.pg.test.ts, only for relevant backward compatibility tests
- package.json only for a test command that is actually needed

No application route, schema migration, repository-layer, snapshot, dataset lifecycle, or external adapter implementation changes.

## Stop Conditions

Stop and escalate if:

- A valid new FakeExecutor behavior still produces an external X with local X=DISPATCH_FAILED.
- A proposed fix requires changing the Task-004/005 state machine or retroactively altering terminal history.
- A broader requirement emerges for rejection durability across multiple real executors, machines, or process restarts.
- A real Airflow adapter is requested to return REJECTED without a provable permanent identity-wide guarantee.

Do not hide unsupported distributed guarantees behind passing in-process FakeExecutor tests.

## Acceptance Criteria

- [ ] Same-identity permanent REJECTED can never be followed by an external run for that identity in FakeExecutor.
- [ ] No double external execution or orphaned run under accepted FakeExecutor behavior.
- [ ] Concurrent rejection-first and acceptance-first tests deterministic and green on real PostgreSQL.
- [ ] No 500 during legal same-identity dispatch interleavings; expected HTTP codes verified.
- [ ] UNKNOWN and ALREADY_EXISTS recovery unchanged.
- [ ] Retry after DISPATCH_FAILED uses a fresh attempt/identity and the same frozen dataset contract.
- [ ] Terminal attempt history and job → attempt lock order unchanged.
- [ ] 007A historical evidence retained without merging red tests.
- [ ] Relevant Task-002–006 PostgreSQL suites green, exact commands/versions/exit codes recorded.
- [ ] System owner reviews implementation and explains why instance-local tombstones do **not** prove a distributed production executor guarantee.

This task is not complete on a green FakeExecutor unit test alone. The real PostgreSQL cross-workflow regression and existing Run/Retry/Reconciliation tests are mandatory.
