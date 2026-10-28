# Demo-05B-1 — Session Concurrency Gate

## Baseline and authority

Branch `codex/demo-05b1-session-concurrency-gate` starts from latest main
`06edb8fe628267fa298b0e39ee3d48e1140458cc`, the confirmed merge of Demo-05A PR #35.
No unmerged feature implementation is used. Authority is the System Owner's
Demo-05B-1 specification, AGENTS, Architecture and ADR-0010/0011/0012, supplemented
by [ADR-0015](../adr/0015-demo-session-concurrency-gate.md).

This slice changes only Demo admission and its route classification. Core
transactions/lock order, Dataset/Job rules, Session identity/cookies, FakeExecutor,
Guided state machine/ledger/Retry logic, migrations and infrastructure remain.
No Demo-05B-2, per-request fake, operation history, template or Playground UI.

## Operation contract

| Path family | Gate |
|---|---|
| POST /demo/dataset-versions and dataset lifecycle commands | Parallel |
| Protected Dataset/Job/Attempt GETs and Scenario/pending-step GETs | Parallel |
| POST /demo/scenarios and /demo/scenarios/:id/next | Exclusive |
| Job Run/Reconcile and both Fake controls | Exclusive |
| Reset / inactive cleanup | Immediate idle-only reservation |

`runParallel` admits at most four outstanding Parallel operations per Session.
Reservation is synchronous before durable revalidation or waiting. The fifth
returns 429 DEMO_SESSION_QUEUE_FULL immediately without entering its body.
Consecutive Parallel bodies can execute simultaneously. A previous Exclusive is
an ordering barrier, so waiting Parallel operations also occupy their slots.
Session bootstrap/current-cookie and health are unchanged, outside this gate.

`run` remains the actively used Exclusive FIFO entry point. It waits for the last
Exclusive and a snapshot of all earlier Parallel completions, then replaces the
Exclusive tail before yielding. Later Parallel work captures that new tail.
Only earlier completions are captured, so P/P → E → P → E does not deadlock.
The existing total capacity of 32 admitted/queued operations and 1024 tracked
Sessions/reservations still bounds memory. Exclusive/Guided work keeps its prior
bounded queue; only Parallel slots have the new hard limit of four.

Every operation revalidates the authenticated Session at execution time. Errors,
expiry and revocation release their slots and do not poison successors. No extra
SQL transaction/row lock wraps a gate wait or body. Core/PostgreSQL remains the
authority for concurrent same-series creation, lifecycle and immutable inputs.

Reset observes all admitted operations, including waiting/revalidating ones.
Any work means immediate 409 RESET_CONFLICT without SQL deletion. Once reserved,
both gate classes reject with 409. Unknown Reset COMMIT retains the same lease
and 503 DEMO_RESET_OUTCOME_UNKNOWN until existing fresh-connection recovery
confirms commit/rollback. Reset cleanup SQL and Fake release are unchanged.

Scenario Create cannot interleave with any admitted Manual mutation: Manual-first
finishes before the empty-owner test; Scenario-first finishes before Manual mode
admission. Existing short SQL mode checks still wait out unknown Create COMMIT;
their locks commit before Domain/executor calls. Guided Next retains FIFO and the
same request/attempt identity recovery. All existing ownership/Origin/CSRF/cookie
rules remain enforced inside the new classification.

## Verification design

The new `test:demo-05b1` suite creates and migrates its own template0 PostgreSQL
database, verifies its name before fixtures, and uses real protected HTTP handlers
and actual SQL. Test timing uses explicit barriers and observed PostgreSQL waits,
not a sleep used to assume that work has started. Timers only bound failures.

- Hold two existing canonical Series rows from a separate connection; observe
  two HTTP creates simultaneously blocked inside Core before releasing either.
  The other Session proceeds and Reset returns 409 without revoking/deleting.
- Hold one Series row; observe both same-series creates inside PostgreSQL, then
  verify one 201, one 409 ACTIVE_DATASET_VERSION_EXISTS, counter/version 1 and one
  complete two-job DPR set. Demo does not presort those creations.
- Hold four Series rows; prove four simultaneous Core transactions, fifth Create
  and read 429 immediately, no fifth allocation, and correct slot reclamation.
- Four reads overlap; failed bodies and failed eligibility release slots. Mixed
  Parallel/Exclusive barriers preserve order, avoid overtaking/cycles and recover
  from an Exclusive failure. Parallel batch start order is intentionally free.
- Both Scenario/Manual race orders use admission/commit barriers and assert the
  correct domain/mode result and no mixed graph.
- Pause a real Fake dispatch. Both Run/Reconcile/Fake control routes stay queued;
  FOR UPDATE NOWAIT succeeds on Session/version/job/attempt from another connection.
  Other Sessions proceed. No Fake state or Core lock protocol is changed.
- Reset reservation denies both classes; unknown rollback acknowledgement keeps
  admission blocked until real fresh-connection recovery. Ownership and security
  contracts remain. Existing suites cover the complementary committed Reset and
  all Guided unknown-outcome/Retry paths.

Two old test observers now watch `runParallel` for a queued Dataset Create/read;
their expiry/revocation assertions are unchanged. Other existing Session/Reset/
Guided tests remain intact. The suite closes actual clients, checks zero backends
and normally drops its owned database. Tests never target the retained local Demo
or a persistent developer database. CI includes the new strict check and PG suite.

## Commands

Privately configure TEST_DATABASE_URL for a disposable PostgreSQL test service:

```powershell
npm.cmd run build
npm.cmd run test:demo-05b1:typecheck
npm.cmd run test:demo-05b1
npm.cmd run test:demo-session-infrastructure
npm.cmd run test:demo-session-ownership-executor-isolation
npm.cmd run test:demo-session-reset-recovery
npm.cmd run test:demo-02a
npm.cmd run test:demo-02b
npm.cmd run test:demo-02c
npm.cmd run test:demo-02d
npm.cmd run test:demo-02e
npm.cmd run test:demo-05a
npm.cmd run test:demo-04
npm.cmd run test:milestone
npm.cmd run test:demo-04:typecheck
npm.cmd run test:demo-04-containers
npm.cmd run ui:smoke
git diff --check
```

## Executed verification — 2026-10-28 (Asia/Taipei)

Windows PowerShell, Node 24.18.0, PostgreSQL 18.6, Chromium 156.0.8078.4.
All final commands below exited 0. Tests used independently owned disposable
databases with 12 migrated schema versions; the raw-ingestion test used only
the milestone's isolated launcher. No implementation/test changes followed the
final runs; the executed evidence was appended afterward.

| Exact command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05b1:typecheck | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-04:typecheck | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05b1 | 0 | 12 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02e | 0 | 37 | 0 | 0 |
| npm.cmd run test:demo-05a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-04 | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-04-containers | 0 | 13 | 0 | 0 |
| npm.cmd run ui:smoke | 0 | 10 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 259 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |

**540 pass / 0 fail / 0 skip**, zero cancellations/TODOs. Counts include Node
parent/nested entries. Core contributes 259, existing Demo PG suites 223,
Demo-05A 23, the new gate suite 12, Docker/HTTPS 13 and real UI smoke 10.
CON-01/CON-02, Naming-01 and Core E2E Flow A–F remain green. Docker checks
include full profile startup, six-domain seed, all Guided Scenarios, actual UI,
readiness, backup/restore and restart. Supplemental strict checking of all
three changed test files also exited 0. Captured final test logs contain
0 warning/deprecation lines. No dependencies or install permissions changed.

Earlier failures are not final PASS evidence: the first new suite exited 1
(8 pass / 4 fail / 0 skip) because its Series fixture omitted the required UUID.
The next run exited 1 (10 pass / 2 fail / 0 skip): its Parallel batch assertion
incorrectly demanded P1 start before P2 after independent SQL revalidations.
The final assertion allows either batch order while requiring every Exclusive
and subsequent batch to respect their barriers; no product ordering was relaxed.
The first existing ownership suite exited 1 (13 pass / 4 fail / 2 cancelled /
0 skip) because its observer watched the old Exclusive entry for a now-Parallel
Create and timed out; later children were not executed. Updating only that
observer preserved all security assertions. The full rerun passed 19/19.
Both affected old observers are tracked in the diff; no failed result is counted
as PASS and no test timeout was increased.

The source service demo05b1_pg_2b7b7928313a was audited after all PG/UI tests:
only postgres/template0/template1 remained, with zero other client connections.
Its exact owned container/anonymous volume and temporary credentials were removed.
New gate fixtures checked zero backends and normal DROP on red and green runs.
Existing Core FORCE policies were untouched. Docker teardown separately verified
its owned disposable volumes were removed. Original developer/manual Demo
resources and uncommitted Demo-04C files were not changed.

Full diff review confirmed no changes to Core transaction/locking, Dataset/Job
services, FakeExecutor, Session identity/security/Reset SQL, Guided Step services
or historical migrations. ADR-0015 records the explicitly requested Demo gate
extension; no unresolved accepted-architecture conflict was found. Single
instance/no external Core/config writer limits remain. Logs stay in the host
temporary directory as demo05b1-*.log; credentials/raw logs are not committed.
System Owner review is required. No merge, deployment or Demo-05B-2 work.
