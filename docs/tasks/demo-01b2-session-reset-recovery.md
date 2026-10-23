# Demo-01B-2 — Session Reset and Failure Recovery

Authority: System Owner's 2026-10-23 specification. Implementation and evidence
await review; no automatic merge. Branch: feature/demo-01b2-session-reset-recovery.
Baseline: main cc535f36b8e304df7996a2b09c572f208766fef1 (Demo-01B-1 PR #20 merged).
Task 007 and Demo-01A are ancestors. See ADR-0010 for the approved bounded design.

## API and admission

POST /demo/sessions/reset requires a valid cookie, X-Demo-Session: 1, matching
supplied Origin and exactly {}. No client ownership/execution selectors. Success
is 204 only after committed cleanup/revocation, then fake release and cookie
clearing. Errors: 401 DEMO_SESSION_UNAVAILABLE; 409 RESET_CONFLICT; 400
INVALID_REQUEST; 403 DEMO_SESSION_CSRF_REJECTED; 500 DEMO_RESET_FAILED for confirmed
rollback; 503 DEMO_RESET_OUTCOME_UNKNOWN while unresolved. All 401 session errors
clear the correct host-only cookie. Invalid cookies never silently create users.

Reset reserves synchronously with no await between checking and reserving. It
does not queue. Running/queued work or another reset conflicts. Ordinary commands
reject during reset. Unknown outcome retains blocking until durable resolution.
An idle RUNNING job/ACCEPTED attempt is deletable demo data, not a reset conflict.

## Complete applied FK graph and deletion order

All seven applied migrations were read before implementation. Restricted edges:

- dataset_versions -> dataset_series.
- calculation_jobs -> dataset_versions, shared calculation_types and definitions.
- execution_attempts -> calculation_jobs.
- dataset_build_snapshots -> dataset_versions.
- snapshot_dependencies -> snapshot and composite upstream series/version.
- dpr_results -> dataset_versions.
- dpr_calculation_input_snapshots -> calculation_jobs.
- dpr_calculation_inputs -> input snapshot and shared assets.
- definition dependencies -> definitions -> types; legacy type bridges -> types.
- raw batches -> raw series. No raw/assets/session FK to the owned dataset graph.

One transaction locks/revalidates the session and derives company ownership from
that row. Reject a foreign snapshot referencing an owned upstream. Delete owned
snapshot dependencies, DPR inputs, DPR input snapshots, DPR results, attempts,
build snapshots, jobs, versions, series; revoke the same session; commit. No
CASCADE/TRUNCATE, shared deletion, session-history deletion or migration change.

## Recovery and maintenance

Confirmed rollback preserves the entire graph, valid session and fake; release
admission for retry. On COMMIT response loss discard the suspect connection and
use a new connection with a bounded lock wait on the session row. Only after the
old transaction releases that lock inspect revocation and remaining owned data.
Confirmed commit releases the fake; unresolved outcomes stay blocked. Controlled
recovery retries do not redispatch or reconstruct fake state. Post-commit fake
release failure is logged, never treated as SQL rollback; maintenance retries it.

Only real Demo server startup invalidates old sessions before listening. Failure
prevents listening. buildApp never invalidates sessions. Explicit bounded
maintenance cleans expired/revoked ownership graphs with the same SQL, skips
active/busy sessions, logs failures/pending work and can be retried idempotently.
No background worker, frontend/reset UI, scenario runner, distributed system,
financial state transition, cancellation or real Airflow integration.

Trusted backend entry points on the same live DemoRuntime (not HTTP APIs):

- runtime.reset.startServer(): real process startup only, before listen.
- runtime.reset.recoverPendingResets(limit): retry at most limit uncertain owners.
- runtime.reset.cleanupInactiveSession(id): lock/recheck one inactive durable owner.
- runtime.reset.maintainInactiveSessions(limit): recover up to limit outcomes,
  clean up to limit inactive owners, report cleaned/failed/pending counts.

The default limit is 50, maximum 1000. Repeat controlled maintenance while pending
is nonzero; investigate logged integrity failures rather than broadening deletion.
Use the same live runtime to recover its in-memory reservations/registry, not a
second concurrently running backend. Startup invokes one bounded maintenance
batch; no periodic worker or automatic indefinite drain is implied.

## Verification plan

Owned disposable fully migrated PostgreSQL database; deterministic barriers for
reset/reset, reset/running+queued commands, reset blocking commands, SQL failure
after partial deletion, commit response loss and unresolved commit recovery.
Cover full DPR/v2 FK graph, same-session upstream links, foreign-reference refusal,
shared/non-demo/B-session preservation, cookie lifecycle, startup fail-closed,
inactive maintenance and fake cleanup failure/retry. Run build, both earlier Demo
suites, dedicated B2 suite, and unchanged test:milestone. Record exact commands,
counts, tested revision, teardown, warnings and limitations below after execution.

## Bounded regression-fixture correction

The first full milestone run exposed the existing Task 007B-1 teardown race:
all 32 assertions passed, then forced DROP terminated a still-closing pooled
socket and Node reported asynchronous activity/uncaughtException (32 pass,
1 fail; command exit 1). The gate correctly stopped, leaving contracts/raw/E2E
NOT RUN. Earlier child suites, including CON-01/CON-02, passed. This is not a
financial-state or reset regression and is not reported as a green gate.

pg-pool removes idle clients from its accounting before socket end callbacks.
The B-1 fixture now uses the same actual-client-end barrier already present in
the C/terminal-lifecycle fixtures, asserts zero connections and uses normal owned
DROP instead of FORCE. No production DB helper, milestone policy, scenario or
expected assertion changes. Separate repeated focused verification and the
complete final gate are recorded below; initial failed evidence is retained.

The first barrier-only repair passed once, but a subsequent focused run on
5422713 exited 1 (31 pass / 1 parent fail): PostgreSQL briefly retained one exiting
backend after local socket end. A read-only follow-up found zero connections.
The owned leftover late_dispatch_test_2316_13099d2f7cc3 was then normally dropped;
no persistent database was touched. Final B-1 and new B2 fixtures additionally
observe pg_stat_activity until zero, bounded by five seconds. A real leak still
fails visibly; no sleep-based concurrency ordering or forced termination is used.
The full intermediate gate on 5422713 independently passed 246 entries, but is
not substituted for final verification after the deterministic teardown repair.

## Executed final verification — 2026-10-23 (Asia/Taipei)

### Exact source and environment

- Final runtime-tested source: ad9cc676941d91e0c7246c86e958ab78b943088c.
- Exact tested tree: 1ce8f462d1d6a269eda620dbd6998dc6265bcb92.
- The working tree stayed clean throughout final build/Demo/focused/milestone
  verification. This subsequent report-only commit is not separately claimed as
  a runtime-tested revision. Source commit 5422713 is intermediate, not final.
- Windows, Node.js v24.18.0, npm 11.16.0, PostgreSQL 18.6
  (Debian 18.6-1.pgdg13+2), existing Compose postgres_db/test_postgres service.
  docker compose up -d postgres_db exited 0. No dependency or infrastructure added.
- Source TEST_DATABASE_URL/DATABASE_URL was used privately only as a test-service
  connection. All suites created/migrated/dropped owned disposable databases;
  no persistent developer database was migrated or truncated. Observed local
  role has CREATEDB=true/SUPERUSER=true: safety comes from validated owned targets,
  not least-privilege sandboxing. Never run against production.

### Exact commands and counters

| Command | Exit | Pass | Fail | Skip | Cancelled | TODO |
|---|---:|---:|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a | n/a | n/a |
| npm.cmd run test:demo-session-reset-recovery | 0 | 21 | 0 | 0 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 18 | 0 | 0 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 | 0 | 0 |
| npm.cmd run test:task-007b1-late-dispatch-reconciliation (standalone 1) | 0 | 32 | 0 | 0 | 0 | 0 |
| npm.cmd run test:task-007b1-late-dispatch-reconciliation (standalone 2) | 0 | 32 | 0 | 0 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 | 0 | 0 |
| git diff --check cc535f36b8e304df7996a2b09c572f208766fef1 | 0 | n/a | n/a | n/a | n/a | n/a |

Supplemental strict check (exit 0, no diagnostics; counters n/a):

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-session-reset-recovery.pg.test.ts scripts/demo-session-ownership-executor-isolation.pg.test.ts scripts/task-007b1-late-dispatch-reconciliation.pg.test.ts
```

The milestone ran all thirteen commands. Every child exit was 0, status PASS,
signal/spawnError null, issues empty. Every test's fail/skip/cancelled/TODO was 0:

| Child npm run command | Pass |
|---|---:|
| build | n/a |
| test:milestone-runner | 20 |
| test:orchestration-schema-v2 | 30 |
| test:dataset-version-creation-v2 | 14 |
| test:first-run-immutable-build-snapshot | 19 |
| test:execution-attempt-dispatch-fake-executor | 11 |
| test:executor-reconciliation | 22 |
| test:dataset-version-terminal-lifecycle | 64 |
| test:cross-workflow-concurrency-investigation | 14 |
| test:task-007b1-late-dispatch-reconciliation | 32 |
| test:task-007c-api-contract | 12 |
| test:raw-ingestion (existing owned isolated launcher) | 1 |
| test:task-007d-end-to-end | 7 |

CON-01/CON-02 are green. Milestone ordering, fail-closed policy and scenario
assertions are unchanged; only B-1's necessary owned teardown was repaired.
Node counts include parent entries: new B2 is 20 subtests plus parent, 01A is
17 plus parent, B1 is 18 plus parent. No skipped acceptance gate is hidden.

### Acceptance mapping

| Owner criteria | Executed evidence |
|---|---|
| 1, 4, 9, 10 | Full CAPEX-published/DPR-running graph reset, 204/empty body, revocation, post-commit scoped fake release, correct clearing cookie; idle RUNNING/ACCEPTED does not conflict |
| 2, 3 | Barrier-held reset admits exactly one; second reset and Run/Reconcile/all lifecycle/create commands conflict; held Run, queued command and held reconciliation reject Reset while B progresses |
| 5, 6, 7, 14 | All sixteen catalog FK edges checked; complete DPR/v2 graph removed; real trigger failure after deletes restores every table/session/fake; foreign reference refuses without wider deletion; B/shared/history unchanged |
| 8 | Real COMMIT with injected lost acknowledgment; destroyed uncommitted connection; unavailable recovery in both durable outcomes; new-connection actual row-lock wait observed in pg_stat_activity; later controlled resolution |
| 11 | Missing/malformed/unknown/expired/revoked cookies clear local and Secure host-only cookies; invalid-cookie create stays 401; new cookie-less create works |
| 12 | Repeated buildApp preserves identity; explicit restart lifecycle invalidates, never reconstructs old fake or changes financial states; real server subprocess fails closed on SQL invalidation failure |
| 13 | Active cleanup refused; expired/revoked cleanup, failure retention, retry/idempotency, bounded batch and post-commit memory-release failure reclamation verified |
| 15, 18 | Protected-path empty diff below; no migration, Domain service, executor contract, core locks, infrastructure or dependency changes |
| 16, 17 | Final new real-PG suite and complete regressions above pass |

The suite additionally verifies expiry after waiting for the session row lock,
no Reset route in core mode, safe public error contracts, and required structured
events without credentials/hashes/headers. Concurrency ordering uses controlled
barriers or observed PostgreSQL lock state, not fixed timing sleeps.

### Teardown and data safety

Final new fixture: demo_01b2_test_36016_1841f683803f, all seven migrations up,
sixteen reviewed FK edges, zero remaining connections, normal DROP (forced=false).
Final earlier Demo fixtures also reported zero connections and normal DROP:
demo_01a_test_19384_85b160b7ae32 and demo_01b1_test_11968_c1c1725bbfda.

Both final standalone B-1 runs passed with seven closed clients, zero sessions
and normal DROP: late_dispatch_test_31808_33479d99738e and
late_dispatch_test_32856_0e21011e96e8. The final milestone's third B-1 execution
also passed: late_dispatch_test_38448_04bbee1cfdfc, seven closed clients,
sessions=[], normal DROP. Final gate teardown also confirmed:

- Terminal: dataset_lifecycle_test_9432_8ff568336e65, ten clients, sessions=[], normal DROP.
- API: task_007c_test_37136_ca7ea31c0774, sessions=[], normal DROP.
- Isolated raw: raw_milestone_test_36892_4529b5e2c342 dropped by its launcher.
- E2E: task_007d_e2e_18492_9e04d9a2f5ed dropped.

Final read-only inventory: postgres, template0, template1, testdb. No disposable
database or matching fixture connection remained. The one earlier failed fixture
was separately validated and normally dropped as recorded above, never forced.

### Complete changed-file inventory

| File | Purpose |
|---|---|
| src/modules/demo-session/demo-session-cleanup.repository.ts | Complete owner-scoped FK cleanup, foreign-reference refusal |
| src/modules/demo-session/demo-session-reset.service.ts | Atomic reset/revocation, unknown recovery, bounded inactive maintenance, explicit startup |
| src/modules/demo-session/demo-session-reset.route.ts | Protected Reset contract |
| src/modules/demo-session/demo-session.coordinator.ts | Synchronous exclusive reservation and retained unknown blocking |
| src/modules/demo-session/demo-runtime.ts | Reset service wiring, scoped fake release and async durable executor eligibility |
| src/modules/demo-session/demo-http-security.ts | Central host-only cookie clearing on 401/success |
| src/modules/demo-session/demo-session.route.ts | Supply cookie policy to session error boundary |
| src/modules/demo-session/demo-domain.route.ts | Supply cookie policy and await durable registry eligibility |
| src/app.ts | Demo-only reset registration and structured logger |
| src/server.ts | Explicit pre-listen Demo startup lifecycle |
| scripts/demo-session-reset-recovery.pg.test.ts | New disposable real-PG acceptance/barrier/failure suite |
| scripts/demo-session-ownership-executor-isolation.pg.test.ts | Mechanical async registry adaptation; all assertions retained |
| scripts/task-007b1-late-dispatch-reconciliation.pg.test.ts | Observed teardown defect only: client/backend drain, no FORCE |
| package.json | Dedicated B2 test command |
| docs/adr/0010-demo-session-reset-and-recovery.md | Decision within owner's bounded specification |
| docs/adr/README.md | Decision navigation |
| docs/tasks/demo-01b2-session-reset-recovery.md | Design, operator entry points, complete verification/failure evidence |
| docs/ARCHITECTURE.md | Demo reset/recovery extension, no core redesign |
| docs/ROADMAP.md | Merged prerequisite/current B2 review status |
| docs/REFERENCE.md | Protected Demo boundary, reset/error/cookie/startup reference |
| README.md | Brief current Demo scope and reference navigation; animations preserved |

Complete diff inspected, including the bounded teardown follow-up. This command
exited 0 with an empty diff on the final tested source:

```powershell
git diff --exit-code cc535f36b8e304df7996a2b09c572f208766fef1 -- migrations src/db src/executors src/modules/dataset-version src/modules/calculation-job* src/modules/raw-ingestion package-lock.json 'docs/adr/000[1-9]*'
```

### Earlier results and warnings, not final PASS

- First B2 execution: exit 1, 0 pass / 1 fail, no skip/cancellation/TODO. The
  pre-test FK count was mistyped as 15 instead of 16. Replaced with explicit
  equality of all sixteen reviewed child/parent edges; no schema workaround.
- Expanded B2 reruns passed 19, then 20, then 21 entries as additional lock/expiry
  tests were added. The final exact-source execution above passes 21.
- First full gate: exit 1, 226 pass / 1 fail in executed children, three commands
  NOT RUN. B-1's 32 assertions passed, then forced DROP caused asynchronous
  connection termination and one extra Node file failure. See investigation above.
- First barrier-only B-1 standalone: exit 0, 32 pass. Repeated standalone on
  5422713: exit 1, 31 pass / 1 parent fail at zero-backend assertion. Intermediate
  full gate on the same source passed 246; neither result hides that race.
- Final bounded backend-drain repair: two standalone B-1 executions and its
  full-gate execution each pass 32, without forced disconnection or warnings.
- Git emitted LF-to-CRLF guidance on staging new files. Whitespace checks pass.
  An unquoted PowerShell HEAD^{tree} metadata command failed; the quoted command
  supplied the verified tree above. It did not affect the commit or tests.
  The remote's old repository alias may emit an informational moved notice.
- Final build/test commands emitted no unexpected compiler/runtime warning,
  failure, skip, cancellation, TODO or teardown error. Full stdout is retained
  locally under the temporary demo-01b2-verified-*.log names, without credentials.

### Remaining limits and review

Only one Demo runtime/backend may use this data. Anonymous core writers must not
be exposed alongside it. Fake state is not restart-durable; startup invalidates
instead of reconstructing/reconciling it. No real executor cancellation occurs.
Maintenance has no background retry: call the controlled live-runtime entry point
again while pending work remains. Unresolved outcomes consume bounded admission
capacity and stay blocked rather than being guessed away. Cross-owner references
require integrity investigation; never widen reset deletion to repair them.
Session history is retained. Large owned graphs still require one atomic reset
transaction. No multi-instance, frontend, scenario or public-deployment guarantee.

Coverage is Windows/Node 24/PostgreSQL 18.6 and Fastify.inject. COMMIT response
loss uses injected transport exceptions around real PostgreSQL transactions;
lost HTTP response is modeled by not applying its cookie. This is not deployed
TLS/browser/network-chaos testing. Startup fail-closed also uses a real child
server process. No conflict with the accepted schema, core locking or executor
contract was found. System Owner Code Review and any merge remain manual.
