# Demo-05B-2 — Per-Request FakeExecutor Behavior

## Scope and baseline

Branch: codex/demo-05b2-per-request-fake-executor, created from latest origin/main
01df7b800e27220ba9978c12b7cbfd3a98a370a4. GitHub confirms Demo-05B-1 PR #36
merged at this main commit before implementation. Demo-05A is already merged.
Read AGENTS, README, Architecture, ADR index, ADR-0010/0012/0015 and the existing
coordinator/runtime/routes/fake/Core Run/Reconcile before changing code.
ADR-0016 records the requested Demo extension. No Core or migration changes.

## Public API

POST /demo/calculation-jobs/:id/run keeps cookie, Origin/CSRF, ownership and mode
checks. Exactly {} remains supported with its original response and Exclusive
admission. Alternatively send exactly one simulation object:

```json
{"simulation":{"dispatch":"ACCEPT","completion":"FAILED"}}
```

| Dispatch | Completion |
|---|---|
| ACCEPT | Required: RUNNING, SUCCEEDED or FAILED |
| ACCEPT_THEN_UNKNOWN | Required: RUNNING, SUCCEEDED or FAILED |
| REJECT | Forbidden |
| UNKNOWN_WITHOUT_CREATION | Forbidden |

Unknown keys, aliases, missing/extra completion, null, arrays and other shapes
return 400 INVALID_REQUEST before executor allocation or Domain mutation.
An explicit response adds this object to the unchanged Core Run result:

```json
{
  "simulation": {
    "requested": {"dispatch":"ACCEPT","completion":"SUCCEEDED"},
    "applied": {"dispatch":"ACCEPT","completion":"FAILED"},
    "application": "EXISTING"
  }
}
```

APPLIED means this request made the identity decision; EXISTING means another
request already did. Applied completion is the original creation setting, not
current live state after a later manual fake-state change. UNBOUND reports null
when no execution/rejection exists; UNKNOWN reports null for legacy/existing
identities without known explicit settings. Never claim a later request's
settings changed an existing execution. Legacy {} responses have no new object.
Existing 200/202/502 Core dispatch contracts and sanitized errors remain.

## Shared fake, identity and recovery

The request adapter uses the registry's original FakeExecutor. Explicit dispatch
does not consume the shared queue, change defaults, or create another fake.
Synchronous full DAG/run identity decisions prevent duplicate external executions.
The first actual creation/rejection wins, regardless of HTTP arrival order.
ALREADY_EXISTS preserves state and reports known original settings. Rejection
remains irrevocable for that identity; a later new Attempt can use new settings.

ACCEPT_THEN_UNKNOWN creates the requested external completion but returns UNKNOWN;
Core keeps PENDING/FAILED and DISPATCHING until normal recovery/Reconcile.
UNKNOWN_WITHOUT_CREATION creates no run, binds no settings and can safely recover
with the same Attempt/identity. An in-flight count lasts only until each no-run
UNKNOWN's Core outcome recording completes or fails. While it is nonzero, REJECT
returns UNKNOWN/unbound rather than causing an unsafe late UNKNOWN write after
DISPATCH_FAILED. The caller can retry after earlier calls finish. Acceptance
recovery is never delayed. This is not permanent simulation binding or a queue.

Completion changes only external Fake state. Even SUCCEEDED/FAILED external
completion leaves DB RUNNING/ACCEPTED after confirmed dispatch; existing Core
Reconcile performs terminal transitions. Manual fake-state controls still work.
The adapter releases transient records in finally, including PostgreSQL errors.

## Concurrency and safety

Explicit Run and Reconcile use the existing four-slot Parallel gate. Legacy Run,
Fake controls and Guided Create/Next remain Exclusive barriers. Reset denies
active/queued work, blocks both classes while reserved and preserves unknown
COMMIT recovery. Session ownership, eligibility, Cookie security and Guided mode
are unchanged. No SQL transaction/Session row lock spans executor calls. Core A,
B, external dispatch and C durability boundaries/lock order are unchanged.
Single backend/no concurrent external writer remains required. No immutable
snapshot mutation, terminal shortcut, UI/history/template or new infrastructure.

## PostgreSQL verification

The new suite uses an independently created template0 database, all 12 unchanged
migrations, explicit six-domain seed, real HTTP route injection and real Core
services. Barriers control application/response order, not sleep. It covers
different/same-job concurrent decisions, reversed arrival order, completion only
through Reconcile, both UNKNOWN recoveries, rejection/retry, frozen upstreams
after newer publication, queue/default isolation, manual state, parallel registry
allocation, four slots/429, Reset/unknown COMMIT recovery, Session/CSRF/ownership,
all three Guided flows and late dispatch after terminal Reconcile. A separate
connection acquires Session/Dataset/Job/Attempt FOR UPDATE NOWAIT inside the
blocked executor. A failing outcome-write trigger checks sanitized 500 and
release of transient UNKNOWN state. Fixture cleanup uses zero-backend normal
DROP, never FORCE or a persistent data target.

## Executed verification — 2026-10-28

Windows PowerShell, Node 24.18.0, PostgreSQL 18.6, Chromium 156.0.8078.4.
All final commands below exited 0; no final suite failed, skipped or cancelled.
Counts include Node parent/nested entries; Vitest reports individual tests.

| Exact command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05b2:typecheck | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05b2 | 0 | 24 | 0 | 0 |
| npm.cmd run test:demo-05b1:typecheck | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05b1 | 0 | 12 | 0 | 0 |
| npm.cmd run test:demo-05a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02e | 0 | 37 | 0 | 0 |
| npm.cmd run test:demo-04 | 0 | 23 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 259 | 0 | 0 |
| npm.cmd run test:demo-04-containers | 0 | 13 | 0 | 0 |
| npm.cmd run ui:test | 0 | 41 | 0 | 0 |
| npm.cmd run ui:smoke | 0 | 10 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |

**605 pass / 0 fail / 0 skip**, zero cancellations/TODOs. Core milestone includes
schema migration (30), Naming-01 (13), dataset creation (14), first Run (19),
dispatch (11), reconciliation (22), lifecycle (64), cross-workflow concurrency
(14, including CON-01/02), late dispatch (32), API contracts (12), isolated raw
ingestion (1), E2E (7) and runner verification (20). Each child command exited 0.
The new suite preserves all three full Guided Scenarios and verifies actual
concurrency using explicit barriers. The old gate test now observes both gate
entry points for Reconcile, preserving all its security/order/NOWAIT assertions.

Earlier development evidence is separate: an initial build reported TS2367 when
the split Reconcile handler compared its terminal/accepted status to DISPATCHING.
The handler now retains its original 200 contract. That result is not counted as
PASS. The initial new integration suite passed 20 tests, then expanded runs
passed 23 and finally 24 after adding database-error cleanup coverage. Only the
final 24 are counted above. No integration failure is hidden or marked PASS.
A staged whitespace check found an extra EOF blank line; it was removed before
the final clean working/staged diff checks.
Captured final logs contain zero warning/deprecation lines. No dependency changes.

After every PG/UI run, the source service demo05b2_pg_c9538831e11b was audited:
only postgres/template0/template1 remained, with zero other client connections.
Its exact owned container/anonymous volume and temporary credentials were removed.
Docker/HTTPS separately verified removal of its own disposable volumes. No
developer or earlier manual Demo database/container/credentials were changed.
Raw logs remain in the host temporary directory as demo05b2-final-*.log, not Git.

Complete diff review found no Core Run/Reconcile, dataset rules, transaction/lock
order, snapshot SQL, coordinator, Reset service, Guided implementation, Session
identity/security, or historical migration edits. No accepted architecture
conflict remains; ADR-0016 documents the requested Demo extension and bounded
UNKNOWN/rejection handling. Existing single-instance/no external-writer limits
remain. Executable source/test content was unchanged after the final passing
runs; only evidence documentation and whitespace cleanup followed.

System Owner review is required. No merge, deployment or later task work.
