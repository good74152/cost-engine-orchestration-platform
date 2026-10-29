# Demo-05C-3B — Six-Domain Workflow Verification and Template v2

Authority: System Owner's bounded specification. PR #40 was confirmed merged
before implementation; latest main baseline is
`890e32580ec79c82a95c57162519b6bcae881ef6`.
Branch: `codex/demo-05c3b-six-domain-workflow`.
Implementation awaits System Owner Review. No production database cutover,
deployment or merge is performed. Existing ADR-0003/0006/0017/0018 apply;
this verification/catalog update introduces no new architectural decision.

## Fixture and scope

`scripts/demo-05c3b-six-domain-workflow.pg.test.ts` requires explicit private
TEST_DATABASE_URL for an owned disposable PostgreSQL service. It never falls
back to a retained developer/Demo database. It creates a random, validated
`demo_05c3b_<pid>_<random>` database from template0 and applies all 14 migrations.
It calls the existing six-domain seed, DemoAdmissionOperator.drain and
DemoCutoverOperator.cutover, then verifies WORKFLOW_OPEN through operator status.
Only afterward does it register the Demo runtime and create Sessions through HTTP.
No direct SQL update substitutes for admission, cutover or financial operations.

Every Create/Run/Retry/recovery/fake-state/Reconcile/Validate/Publish uses the
existing protected Demo API with Cookie/Origin/CSRF and ownership checks. The
fixture forces `limit=1` and follows all cursors for Jobs and Attempts, verifying
the complete Job set against Create results and expected Calculation Types.
No fixed Job UUID is used. SQL reads inspect snapshots/definitions/history;
SQL transactions hold existing rows solely as concurrency barriers.
Teardown closes the app/pool and sockets, confirms no remaining backend for the
exact owned database and drops it normally without FORCE. Legacy Guided suites
retain their own independently migrated/seeded Legacy databases; the Workflow
fixture never changes their configuration or Guided ledger.

## Workflow and acceptance coverage

All Datasets share the same Session-owned company, fiscal year 2026 and Q4 in
the full-flow case. Negative cases deliberately vary one identity component.

| Domain | Calculation Types / Job count | Published direct upstream |
|---|---|---|
| FAB_COST | DEMO_FAB_COST_SUMMARY / 1 | none |
| CAPEX | DEMO_GUIDED_SUMMARY, DEMO_CAPEX_TABLE_Y / 2 | FAB_COST |
| INSURANCE | DEMO_INSURANCE_SUMMARY / 1 | FAB_COST |
| ONE_STD_COST | DEMO_ONE_STD_COST_TABLE_X/Y / 2 | FAB_COST |
| DPR | DEMO_DPR_TABLE_X/Y / 2 | CAPEX |
| E2E_COST | DEMO_E2E_COST_TABLE_X/Y / 2 | ONE_STD_COST |

The full flow publishes six Datasets and verifies exactly ten correct Jobs,
SUCCEEDED Attempts/Jobs and external executions, frozen definitions for every
Job, and each dispatch's exact snapshot/upstream identity. Before publishing
upstreams, each dependent Dataset's Jobs return the unchanged Core 409
DEPENDENCY_NOT_READY message. Snapshot/dependency/Attempt sets stay empty,
resolved definition IDs remain null, status remains DRAFT and no Fake dispatch
occurs. Additional cases prove another year, period or Session's published
FAB_COST cannot satisfy CAPEX; publishing the matching input then allows it.
No custom dependency error or Core business rule is added.

CAPEX summary freezes Published Definition v2; TABLE_Y freezes Published v1.
Both require FAB_COST. First Run pins FAB_COST v1; after FAB_COST v2 publishes,
the second Job retains the same snapshot and v1 input. After CAPEX publishes,
a new CAPEX version selects FAB_COST v2. Complete snapshot/dependency/definition
rows of the original CAPEX remain equal. The legacy summary Definition v1,
including UUID/timestamps/dependency rows, is captured before cutover and remains
byte-for-byte JSON equal after the Workflow tests.

Failure Retry runs Job A Attempt 1 to FAILED, preserves its complete SQL row
and HTTP history, then retries only A with a new Attempt/run identity. Job B
retains its single Attempt. Even after publishing newer FAB_COST, retry dispatch
uses the original snapshot/input. Validation is refused both with A failed and
with A successful while B is still RUNNING; only both successful Jobs permit
validation/publication.

Lost Response uses ACCEPT_THEN_UNKNOWN/RUNNING on one CAPEX Job. HTTP 202 means
UNKNOWN/DISPATCHING/PENDING while the real Fake execution already exists. Job B
finishes independently. A second Run confirms ALREADY_EXISTS with identical
Attempt UUID/number, DAG ID, DAG Run ID and snapshot. There are still only two
CAPEX external executions and one Attempt per Job; CAPEX can then publish.

## PostgreSQL concurrency barriers

The tests use real independent Client transactions, existing row locks,
pg_stat_activity, pg_blocking_pids and granted pg_locks. Polling yields with
setImmediate and a bounded deadline; the deadline only detects failure to reach
a barrier. No sleep or elapsed-time inference controls ordering. Both requests
must be observed blocked before the external barrier is released with ROLLBACK.

1. **Two CAPEX First Runs:** hold the first sorted CAPEX Calculation Type row.
   Start Job A, observe its waiter, then Job B and observe two distinct waiting
   backend PIDs, whose blocking chain reaches the holder. Both have entered the
   unchanged first-Run configuration lock path while the output has no snapshot.
   Release the barrier. Existing Core configuration locks serialize the two
   initializers; both HTTP responses must reference one snapshot, correct pinned
   definitions/upstream and one Attempt per Job. Both Jobs finish and CAPEX publishes.
2. **Publish first:** hold FAB_COST v2's Dataset row after it reaches VALIDATING.
   Publish acquires FAB_COST's series lock and waits on that row. CAPEX First Run
   must then wait on Publish's PID at the series lock. Release; Publish commits
   first, so CAPEX selects FAB_COST v2.
3. **Run first:** hold CAPEX's output Dataset row. First Run acquires FAB_COST's
   series lock and waits on CAPEX's row. Publish must then wait on First Run's PID
   at the series lock. Release; CAPEX freezes FAB_COST v1 before v2 is published.

Both Publish/Run schedules also assert the winner has a granted RowShareLock on
dataset_series. The second CAPEX Job always reuses the chosen snapshot/input;
there is no duplicate snapshot, partial frozen definition set, duplicate Attempt
or deadlock, and both datasets reach valid published states. The suite emits
`POSTGRES_LOCK_EVIDENCE` with actual holder/waiter PIDs and expected selected
version for reproducible audit. These are test-only barriers, not a new lock
manager or changes to the accepted Core lock hierarchy.

## Static Workflow Template v2

All four stable Template IDs advance to version 2, availability PREVIEW. Existing
Step IDs are retained. HAPPY_PATH/FAILURE_RETRY/LOST_RESPONSE_RECOVERY add the
complete FAB_COST publication chain before CAPEX creation, within the same
Session/year/period. Happy runs all CAPEX Jobs; failure runs all and retries only
the chosen failed Job; recovery confirms the original Attempt and adds an
explicit `capex.run-other-jobs` step. All required Jobs/accepted Attempts must
finish Fake success and Reconcile before validation/publication. The six-domain
description reflects the five post-cutover dependencies and removes the obsolete
CAPEX zero-dependency description. Dataset versions and Job IDs remain dynamic.

Unit tests retain exact contracts/stable IDs, independent graph sorting,
uniqueness/cycle/reference checks and validator rejection cases; additional v2
checks require the FAB_COST prerequisite and complete Job handling. Existing
05C-1 HTTP/security/reset/coordinator/state-immutability coverage remains; a
Workflow-open read test also compares every public table before/after all four
list/detail reads and verifies no Fake allocation. The catalog still requires
no database configuration/state to supply its definitions.

No Template history table, progress, workflow runner, new route/API contract,
new table/migration, Frontend change or UI activation is added. Legacy Guided
steps/configuration remain their supported separate baseline. PREVIEW continues
to mean that the new Workflow operation UI is not enabled.

## Verification

Executed on 2026-10-29 (Asia/Taipei), Node.js 24.18.0 / PostgreSQL 18 in a
task-owned disposable container. CI includes the new strict test typecheck and
PostgreSQL suite. Build, `npm exec tsc -- --noEmit` (strict source tsconfig),
focused strict 05C-3B/05C-1/05C-3A/05B-1/05B-2/05C-2 typechecks and git diff
checks all pass. No API contract or UI test infrastructure changed, so no
Frontend change or browser fixture exception is needed.

| Command | PASS count |
|---|---:|
| npm run test:demo-05c3b | 12 (11 cases plus parent) |
| npm run test:demo-05c3a | 29 |
| npm run test:demo-05c1 | 19 (9 unit + 10 HTTP including parent) |
| npm run test:demo-02b | 26 |
| npm run test:demo-02c | 27 |
| npm run test:demo-02d | 25 |
| npm run test:demo-02e | 37 |
| npm run test:demo-05b1 | 12 |
| npm run test:demo-05b2 | 29 |
| npm run test:milestone | 259 |
| npm run test:demo-05c2 (additional regression) | 22 |
| npm run test:demo-session-reset-recovery (additional regression) | 22 |
| **Total, reruns counted once** | **519** |

Zero failures, skips, cancellations or TODOs remain. The milestone runner's
overall result is PASS for every suite, including its isolated raw-ingestion
launcher. Legacy Guided runs are against their own Legacy fixtures; no Workflow
configuration is injected into those suites. Additional admission/reset tests
cover the existing shared runtime boundaries without modifying them.

Actual final 05C-3B lock evidence (PIDs are per-run observations):

```text
two-first-runs: holder 734; waiter 735 -> 734 (transactionid),
               waiter 736 -> 735 (tuple); one snapshot, two Attempts total
publish-first: holder 737; Publish 735 -> 737, Run 724 -> 735;
               CAPEX input FAB_COST v2
run-first:     holder 738; Run 735 -> 738, Publish 736 -> 735;
               CAPEX input FAB_COST v1
```

All three schedules produce a single complete CAPEX snapshot with both Jobs on
the same input and successful final publication. The suite reports
`DEMO_05C3B_TEARDOWN {"dropped":true,"backends":0,"forced":false}`.
The other PostgreSQL suites also clean their owned databases; final verification
checks the task's container has no remaining fixture databases before removal.

Acceptance Criteria 1–12 are covered by the local tests above. No Core
concurrency bug was found and no Core, Gate, operator, migration, Guided ledger,
reset/recovery or FakeExecutor implementation changed. Actual production
cutover and Workflow UI activation remain outside this task. PR CI and System
Owner Review remain the delivery review gates; local PASS does not claim a
production deployment.
