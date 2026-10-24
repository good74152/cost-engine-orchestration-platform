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

## Code review correction — Company Code Collision Safety (2026-10-24)

Baseline: merged commit d037fcfb14185ec773ee5503a60fc364b6f4d1aa;
branch codex/demo-01b2-company-code-collision-fix. This is a bounded bug fix,
not a new feature or architecture decision. Earlier verification above describes
the original B2 implementation, not this subsequent correction.

### Bug and repair

Creation previously relied only on uniqueness within demo_sessions. A historical
dataset_series could already use the same legal DEMO_ company code without a
session row. Allocating that code would incorrectly claim its ownership; later
Reset or inactive cleanup could delete historical data by company membership.

The existing INSERT ... SELECT now includes WHERE NOT EXISTS against all
dataset_series company codes, regardless of domain/year/period. The check and
session insertion are one PostgreSQL statement. An empty RETURNING result means
collision: consume one candidate and retry, without creating a session or
returning that candidate's token/cookie. Keep the five-candidate limit and the
existing unique constraints/retry for session ID, company code and token hash.
Concurrent session allocations still converge through database uniqueness.
Unexpected PostgreSQL failures remain sanitized, with no successful cookie or
partially inserted session. Crypto generation, SHA-256, TTL, DTO and cookies stay
unchanged. Cleanup/reset SQL, core locks, state machines and migrations do not change.

### Safety boundary

Only one Demo backend instance may write this Demo database, with no concurrent
Core or external writer. A statement snapshot is not cross-table uniqueness:
an arbitrary external writer could insert the same dataset company after the
check. This fix does not claim protection against that unsupported race and
adds no schema, locks, distributed coordination or production-security exception.
Stronger guarantees outside this boundary require architecture review first.
This prevents new colliding allocations; it does not relabel or automatically
repair any already-overlapping historical/session data. Such data needs owner
review, not guessed ownership or wider deletion.

### Tests and pre-fix evidence

Real disposable PostgreSQL tests add:

- A: historical series using a valid DEMO_ code; first candidate rejected, second
  accepted, only the successful token returned, rejected ID/code absent, history unchanged.
- B: five historical collisions through the session HTTP route; sanitized 500,
  no Set-Cookie, no inserted sessions, no token/hash/SQL details in response/logs,
  historical rows unchanged.
- C: original session company/ID/hash unique-collision retry/exhaustion tests retained.
- D: original twenty concurrent HTTP creations retained; additionally force two
  simultaneous services to propose the same company and verify one retries.
- E: published historical DEMO_ dataset with a job, snapshot and terminal attempt;
  colliding HTTP creation retries, new session builds real CAPEX/DPR executions,
  Reset removes only its own graph and leaves the complete historical/shared
  database state unchanged. The same historical fixture remains for later tests.

Before the production fix, npm.cmd run test:demo-session-infrastructure exited 1:
18 pass / 3 fail / 0 skip/cancelled/TODO. Two new assertions failed plus the parent:
the first historical candidate was accepted (one call instead of two), and the
exhaustion route returned 201 instead of 500. Normal owned teardown succeeded.
An initial supplemental ES2022 script check also found test-only toSorted usage;
it was replaced with a copied array sort, without changing assertions or targets.
New execution evidence for this correction is recorded separately below.

The first implementation's untyped comparison made PostgreSQL infer incompatible
types for parameter $2 (42P08). That intermediate execution failed, not passed:
infrastructure exit 1, 2 pass / 11 fail (later tests not reached); reset exit 1,
0 pass / 22 fail; zero skips/cancellations/TODOs. A PREPARE-only diagnostic in an
owned migrated disposable database confirmed the parse error without credentials.
The comparison now explicitly casts $2 to varchar, matching the INSERT target
without changing schema or candidate validation. Diagnostic and failed fixture
databases were normally dropped. Both focused suites then passed (21 and 22);
final clean-source verification below supersedes these intermediate executions.

### Final correction verification — 2026-10-24 (Asia/Taipei)

Runtime-tested source: 6d7c57431ae665b2d2a0059bac9054a211ef2a46.
Exact tested tree: cfa0870e6c7c3d0b8e0afcae476da2a0a1fcc1cf.
The working tree was clean throughout the final commands below. The later
evidence-only documentation commit is not a separately runtime-tested source.
Environment: Windows, Node.js v24.18.0, npm 11.16.0, PostgreSQL 18.6
(Debian 18.6-1.pgdg13+2), existing Compose postgres_db/test_postgres service.
No dependency or infrastructure change. Private test URLs were not printed.

| Exact command | Exit | Pass | Fail | Skip | Cancelled | TODO |
|---|---:|---:|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a | n/a | n/a |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a | n/a | n/a |
| git diff --check d037fcfb14185ec773ee5503a60fc364b6f4d1aa | 0 | n/a | n/a | n/a | n/a | n/a |

Supplemental strict script check: exit 0, no diagnostics, counters n/a:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-session-infrastructure.pg.test.ts scripts/demo-session-reset-recovery.pg.test.ts
```

All thirteen milestone children ran. Every child exited 0, status PASS,
signal/spawnError null, issues empty; every test child's fail/skip/cancelled/TODO
was 0. The runner, scripts and core assertions were not changed for this correction.

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

Tests A–E above are green, including the two formerly red historical collision
assertions, original company/ID/hash uniqueness tests, twenty HTTP creations,
forced two-session collision and HTTP creation/Run/Reset preservation of the
historical graph. Existing unexpected PostgreSQL-error sanitization, rollback,
cookie/TTL/hash/DTO and production-safety regressions pass unchanged. CON-01 and
CON-02 are green. Counts include parents: infrastructure is 20 subtests + parent;
ownership/isolation 18 + parent; reset/recovery 21 + parent. Not unique-test counts
across repeated suites. No failed intermediate execution is called PASS here.

Final disposable Demo databases were migrated through all seven migrations and
normally dropped after zero-connection checks (forced=false):

- demo_01a_test_9900_90835649632b.
- demo_01b1_test_3084_68b8b409a2b8.
- demo_01b2_test_35116_e42c75cd2d6a.

Milestone teardown also confirmed normal DROP for terminal lifecycle
dataset_lifecycle_test_30040_10fc5605628c (ten closed clients), late dispatch
late_dispatch_test_21832_547da97a3892 (seven clients), and API contracts
task_007c_test_2096_df8aae4190bb; sessions=[] for each. The isolated launcher
dropped raw_milestone_test_25536_7f3542a2bf01; E2E dropped
task_007d_e2e_13072_f6662a9d4f45. Pre/post read-only inventory matched exactly:
postgres, template0, template1, testdb. No fixture connection remained. No
persistent developer database/schema/history was modified. The local service
role had CREATEDB=true/SUPERUSER=true; validated owned targets, not role sandboxing,
provided the test boundary. Do not use a production connection source.

The complete correction diff was reviewed: only these four files changed:

- src/modules/demo-session/demo-session.service.ts — single-statement guard and empty-result retry.
- scripts/demo-session-infrastructure.pg.test.ts — A/B plus forced concurrent collision; C/D retained.
- scripts/demo-session-reset-recovery.pg.test.ts — historical full-graph Reset safety test E.
- docs/tasks/demo-01b2-session-reset-recovery.md — bounded correction and new evidence.

This scope check exited 0 with an empty diff on the tested source:

```powershell
git diff --exit-code d037fcfb14185ec773ee5503a60fc364b6f4d1aa -- . ':!src/modules/demo-session/demo-session.service.ts' ':!scripts/demo-session-infrastructure.pg.test.ts' ':!scripts/demo-session-reset-recovery.pg.test.ts' ':!docs/tasks/demo-01b2-session-reset-recovery.md'
```

Thus applied migrations, cleanup/reset services, state machines, canonical
identity, transaction/lock order, executor contract, security checks, dependencies
and ADRs remain unchanged. No TRUNCATE/CASCADE or historical-data repair was added.
No accepted-architecture conflict was found inside the stated single-writer limit.

Warnings: intermediate red/typing failures are recorded above, separately from
the final pass. Final build/tests emitted no unexpected runtime/compiler warnings,
skip/cancellation/TODO or teardown failure. Git emitted informational LF-to-CRLF
guidance; diff checks passed. The existing remote alias may emit a moved-repository
notice on push. Full final stdout is retained locally in temporary
demo-collision-verified-*.log files, without credentials.

PR #24 was already merged as d037fcf before this correction. Its metadata may be
updated with these findings and the correction branch reference, but that cannot
change its historical merge or incorporate this fix into main. Do not reopen,
rewrite the merge or automatically merge anything. This branch is submitted for
owner review; integrating it requires a separate authorized PR/workflow. No new
PR is created by this correction's delivery. Single-instance/no external writer
and the existing browser/network-test limitations still apply.
