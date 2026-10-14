# Task 007D — Milestone Verification Report

**Status: VERIFICATION PASSED — AWAITING SYSTEM OWNER REVIEW.**

Verified on 2026-10-15 (Asia/Taipei). These are executed results, not an inventory of implemented tests. System Owner approval remains pending; Task 007/007D is not marked merged or complete. Task 007E was not started.

## Revisions and evidence boundary

| Item | Value |
|---|---|
| Repository | good74152/cost-engine-orchestration-platform |
| Existing branch | feature/task-007d-e2e-verification-gate |
| Reviewed starting HEAD | 4e0c93a94faa017c29f2d5cb8a30249027a18fa9 — matched exactly; working tree clean |
| Main baseline | 58dd1b79ea4eb5cb3891e14c8111ba49c984f6c1 |
| Exact final runtime-tested source commit | 831a2f1eca3419ed08a447fa9a2c19c32cd06ba3 |
| Exact final runtime-tested Git tree | 41868ffb517ef68eb3a5d982531ad84ba5aea5f1 |
| Report commit | Documentation-only descendant of the tested source commit; written after execution |
| System Owner review | Pending |
| Automatic merge | None |

The final milestone ran with a clean working tree at the tested source commit. INVESTIGATION_METADATA independently printed that exact SHA. The later report-only commit is not claimed as a separately tested source revision. Compare the tested commit to the delivery commit to distinguish documentation from tested code.

The report at reviewed HEAD was BLOCKED / NOT VERIFIED: its Node 22/no-checkout environment had no PostgreSQL execution. That historical observation remains in Git history and is superseded by this real runtime verification, not retroactively relabelled PASS.

## Actual environment and database safety

| Parameter | Executed observation |
|---|---|
| Checkout | Local Windows checkout; fetched and checked out the existing remote feature branch |
| Node.js | v24.18.0 |
| npm | 11.16.0 |
| Dependencies | npm.cmd ls --depth=0 exited 0; declared direct dependencies available, including tsx and node-pg-migrate |
| PostgreSQL | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2), x86_64, 64-bit |
| Topology | Windows Node → localhost:5432 → repository Compose service postgres_db, container test_postgres, PostgreSQL 18 |
| Configuration | TEST_DATABASE_URL, falling back to DATABASE_URL; credentials redacted and never printed |
| Maintenance database | postgres; creates/drops only suite-owned disposable databases |
| Role preflight | CREATEDB=true, SUPERUSER=true on this local test service; owned preflight database created from template0, ownership checked, and dropped |
| Migrations | All six checked-in TypeScript migrations available, including 1788700000000_orchestration-schema-v2 |
| Before/after DB inventory | Exactly postgres, template0, template1, testdb; no temporary databases remained |

The test role is privileged: safety comes from the launchers' strict owned-database naming/targeting, not a least-privilege role sandbox. Do not point this gate at production. No permissions, infrastructure, persistent application schema or developer data were changed.

Each PostgreSQL suite uses independent disposable databases and migrations. Fixture truncation is confined to those databases. The milestone waits for each child command and teardown before starting the next; it does not share an application pool/process between suites.

Raw ingestion is run through the existing isolated launcher only. It creates a validated raw_milestone_test_* database, applies all migrations, passes child-scoped DATABASE_URL/TEST_DATABASE_URL, waits for the original regression process to close, drops only its own database, and closes the maintenance connection. Spawn/signal/cleanup failures propagate as failure. Raw business logic and its original regression test are unchanged.

Final-run explicit cleanup evidence:

- RAW_ISOLATED_DB: raw_milestone_test_20716_a65c4d7ce722; PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2); all migrations applied.
- RAW_ISOLATED_TEARDOWN: that exact database dropped.
- E2E_DB_TEARDOWN: task_007d_e2e_32808_77e42177ae9d dropped after closing Fastify/application pool.
- Read-only postflight inventory matched preflight exactly. No cleanup or asynchronous connection-termination error occurred.

## Runner correction and regression tests

The reviewed runner treated process exit 0 as PASS. The corrected policy explicitly distinguishes kind=build from kind=test:

- Build requires exit 0 without spawn failure or termination signal. TAP counters remain null/not applicable.
- Tests require exit 0, a complete unambiguous Node TAP summary, pass > 0, and fail/skip/cancelled/TODO all zero.
- All six counters (tests, pass, fail, skipped, cancelled, todo) must be present and nonnegative safe integers. Missing, malformed, duplicated or unsafe counters remain null, never fabricated zeros.
- Totals must satisfy tests = pass + fail + skipped + cancelled + todo. Nested tests count toward Node totals; the top-level plan is not assumed equal to that total. No suite-specific pass counts are hard-coded.
- Stdout is decoded as a stream and assembled after child close, then parsed once. Stderr remains visible but cannot supply stdout counters.
- Test children explicitly select TAP through child-scoped NODE_OPTIONS rather than assuming a reporter default. npm's CLI is invoked through Node when npm supplies its path, avoiding Windows .cmd execution errors or a shell.
- Failure stops progression. Remaining suites emit MILESTONE_RESULT with NOT RUN and null observations. MILESTONE_SUMMARY becomes FAIL and the process exits nonzero. If policy fails despite child exit 0, overall exit is 1 while the child observation remains 0.

npm run test:milestone-runner imports only the small parser/classifier/sequential helper: it does not start PostgreSQL or the entire milestone. Its 20 deterministic passing cases cover requested A–N: success, process failure, all/partial skips, missing/zero/incomplete counters, cancellation, TODO, build success/failure, fail-fast progression, chunk-split summary and inconsistent totals. Additional checks cover malformed/duplicate/unsafe counters, contradictory exit/counter facts, spawn errors/signals, sequential barriers, empty plans, and actual nested Node TAP with CRLF/trailing whitespace. No real tests are skipped or TODO.

## Final complete sequential execution

Exact top-level command: npm.cmd run test:milestone — **exit 0** at source commit 831a2f1eca3419ed08a447fa9a2c19c32cd06ba3.

These child commands were executed in this exact order and printed structured MILESTONE_RESULT records. Windows uses the same npm CLI through Node. Raw ingestion is wrapped as described above.

| Command | Exit | Pass | Fail | Skip | Cancelled | TODO | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| npm run build | 0 | null | null | null | null | null | PASS (build policy) |
| npm run test:milestone-runner | 0 | 20 | 0 | 0 | 0 | 0 | PASS |
| npm run test:orchestration-schema-v2 | 0 | 30 | 0 | 0 | 0 | 0 | PASS |
| npm run test:dataset-version-creation-v2 | 0 | 14 | 0 | 0 | 0 | 0 | PASS |
| npm run test:first-run-immutable-build-snapshot | 0 | 19 | 0 | 0 | 0 | 0 | PASS |
| npm run test:execution-attempt-dispatch-fake-executor | 0 | 11 | 0 | 0 | 0 | 0 | PASS |
| npm run test:executor-reconciliation | 0 | 22 | 0 | 0 | 0 | 0 | PASS |
| npm run test:dataset-version-terminal-lifecycle | 0 | 64 | 0 | 0 | 0 | 0 | PASS |
| npm run test:cross-workflow-concurrency-investigation | 0 | 14 | 0 | 0 | 0 | 0 | PASS |
| npm run test:task-007b1-late-dispatch-reconciliation | 0 | 32 | 0 | 0 | 0 | 0 | PASS |
| npm run test:task-007c-api-contract | 0 | 11 | 0 | 0 | 0 | 0 | PASS |
| npm run test:raw-ingestion (isolated launcher) | 0 | 1 | 0 | 0 | 0 | 0 | PASS |
| npm run test:task-007d-end-to-end | 0 | 7 | 0 | 0 | 0 | 0 | PASS |

MILESTONE_SUMMARY: **overall PASS, exitCode 0**, 13 command records, every status PASS, signal/spawnError null, issues arrays empty.

Computed sum of test-suite counters: **245 pass / 0 fail / 0 skip / 0 cancelled / 0 TODO**. Counts include Node's enclosing/nested entries; E2E's seven entries mean six flows plus their parent, not seven flows.

## Executed E2E and regression outcomes

| Flow | Actual result |
|---|---|
| A | PASS: CAPEX v1 published through HTTP; two-job DPR v1 shares one snapshot and CAPEX v1 pin; no automatic validation; explicit validation/publication succeeds |
| B | PASS: original attempt remains FAILED, distinct retry SUCCEEDED, three DPR attempts for two jobs; original history/frozen build unchanged; final publication succeeds |
| C | PASS: ACCEPT_THEN_UNKNOWN returns 202/DISPATCHING; reconciliation recovers the same attempt to SUCCEEDED; one external run for that identity, no hidden retry |
| D | PASS: v1 remains latest published, v2 REJECTED, v3 DRAFT; series counter advances to 3 while rejected-version/job/attempt/snapshot fields stay unchanged |
| E | PASS: DRAFT and safe BUILDING abandonment succeeds; ACCEPTED and barrier-held DISPATCHING block abandonment without mutation; no cancellation |
| F | PASS: one callback in VALIDATING and two in PUBLISHED consult executor truth and preserve terminal history/timestamps; no redispatch |

PREPARED is not left publicly observable by the Run API. Its abandonment guard is verified by the unchanged Task 006 PostgreSQL suite (64 passing entries), not independently claimed by E2E Flow E.

- CON-01: reconciliation-first and dispatch-first both returned A/B 200/200, ending SUCCEEDED with one external execution and unchanged history. All 32 focused B1 entries passed, including later lifecycle, retry ownership, identity, contradictions and lock boundaries.
- CON-02: both legal rejection recording orders returned 502/502, EXECUTOR_DISPATCH_FAILED, one DISPATCH_FAILED attempt, PENDING job and zero external X. Subsequent independent retry created only fresh Y. Both acceptance-first orders returned 200/200 with one ACCEPTED attempt/external X. UNKNOWN, script/tombstone/full-key isolation and independent-job cases passed.
- Invalid adapter: deliberately creating X but reporting REJECTED remains an ADR-0008 violation. Rejection-recorded-first intentionally observes 502/500 and verifies no history rewrite. This is a passing negative test, not an unexpected 500 under supported semantics.
- Lock/transaction checks: dataset/job/attempt FOR UPDATE NOWAIT locks were available during external waits, other idle transactions=0. Held-attempt gates proved dispatch recording and reconciliation already held the job lock (55P03) before waiting for the attempt.
- Task 007C: 11 passing API contract entries, including identifiers/NUL, request/body/media errors and fake-control exposure.
- Migrations: 30 passing entries cover fresh up, legacy conversion, supported down/forward, unsafe rollback rejection, malformed/orphan/collision/dependency/status guards, atomicity, real constraint writes and indexes. Historical migrations are unchanged.
- Raw ingestion: original 20-request test passed: one success, nineteen conflicts, one allocation/batch, isolated DB removed by its launcher.

## Earlier failed attempts — not final PASS evidence

| Attempt / command | Exit | Actual observations and disposition |
|---|---:|---|
| Initial development npm.cmd run test:milestone-runner | 1 | 19 pass / 1 fail / 0 skip / 0 cancelled / 0 TODO. Actual-TAP subprocess inherited internal Node test context. Test-only context isolation fixed it; independent rerun exited 0 with 20/0/0/0/0 |
| npm.cmd run test:milestone at b0cc9dc514ed55ac8438d1b324b33929318bde47 | 1 | Build passed; runner-test child exited 0 and spec output showed 20 passing tests, but TAP was absent. Gate correctly preserved all counters as null and FAILED; subsequent eleven commands NOT RUN with null exit/counters. Fixed explicit child TAP selection |
| npm.cmd run test:milestone at 73f30e367459a9ecf81eb43253bbb2c29dea6e2c | 1 | Build passed; runner tests 19/1/0/0/0 because the fixture selected TAP twice via CLI and NODE_OPTIONS. Subsequent eleven commands NOT RUN. Isolated that fixture's reporter environment |
| npm.cmd run test:milestone at 3f1f95550d04e08e4e03ef98fc150b5f64690a9e | 1 | All commands through raw ingestion passed with the same counts as the final table. E2E 5/2/0/0/0 (Flow D plus parent); totals 243 pass / 2 fail. Raw/E2E databases were dropped |
| Independent npm.cmd run test:task-007d-end-to-end after fixture correction | 0 | 7/0/0/0/0; A–F and teardown passed before final complete rerun |

Flow D was a **test harness assertion defect**, not a production defect: its historical version state object included the shared mutable series counter after deliberately creating v3. It expected 2; PostgreSQL correctly stored 3. The correction retains the full deep comparison of historical fields and explicitly expects counter 3. No lifecycle assertion was skipped or removed. Two existing test-only SHOW server_version field-name mistakes were corrected so raw/E2E logs print the actual version.

An intermediate optional type-check/diff shell invocation emitted TS2339 for the runner environment's inferred type, but the shell's final diff command returned 0. That combined exit was **not** accepted as successful type-check evidence. An explicit NodeJS.ProcessEnv annotation fixed the type and the standalone check below exited 0 without diagnostics.

## Additional verification and warnings

| Exact command/check | Exit | Result |
|---|---:|---|
| docker compose up -d | 0 | PostgreSQL container running |
| node --version | 0 | v24.18.0 |
| npm.cmd --version | 0 | 11.16.0 |
| npm.cmd ls --depth=0 | 0 | Dependencies present |
| git diff --check | 0 | No whitespace errors |
| Git diff against reviewed HEAD for src, migrations, lockfile, original raw test and Task 007B regression suites | 0 | Empty; no changes to these paths |
| PostgreSQL preflight via node --input-type=module -e | 0 | Local endpoint, privileges, six migration files and owned create/ownership/drop verified; no credentials printed |
| PostgreSQL postflight via node --input-type=module -e | 0 | Inventory unchanged; no temporary DB remained |

Standalone script type-check, exact command (exit **0**, test counters not applicable):

    npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/task-007d-milestone-runner.ts scripts/task-007d-milestone-runner.test.ts scripts/support/task-007d-isolated-raw-ingestion.ts scripts/task-007d-end-to-end.pg.test.ts

Warnings and limitations:

- Final full-gate run: no unexpected test/compiler warnings, spawn/signal errors, skipped/TODO/cancelled tests or teardown failures. Earlier failed attempts are recorded separately above.
- Git emitted informational LF-to-CRLF conversion warnings when staging new test files; whitespace checks passed.
- An initial Windows wildcard search was retried using rg -g; an optional Windows CIM process-list diagnostic was denied. Neither blocked required verification.
- Compose uses a privileged local test role. Ownership/name guards are essential; no role-hardening infrastructure was added.
- FakeExecutor tombstones are instance-local, not distributed/restart durability. Real Airflow/cancellation/distributed adapter guarantees were not tested or implemented.
- Runtime matrix: Windows, Node 24, PostgreSQL 18.6 only. No new production dependencies.
- No unresolved production correctness defect or architecture conflict found. Owner approval remains pending.

## Reproduce and review boundary

With Node.js 24+, installed project dependencies and a suitable local test PostgreSQL service, configure TEST_DATABASE_URL or DATABASE_URL privately. The role needs CREATE DATABASE and ownership/DDL/drop privileges for temporary databases. Do not log credentials.

    docker compose up -d
    npm.cmd run test:milestone
    git diff --check

Use npm run test:milestone on non-Windows systems. Do not bypass raw-ingestion isolation against a persistent database.

Correction files: package.json; scripts/task-007d-milestone-runner.ts; scripts/support/task-007d-milestone-results.ts; scripts/task-007d-milestone-runner.test.ts; scripts/support/task-007d-isolated-raw-ingestion.ts; bounded Flow D/runtime-log corrections in scripts/task-007d-end-to-end.pg.test.ts; this report.

No production code, state machines, transaction/locking protocols, historical migrations/data, raw business behavior or Task 007B assertions changed. No skipped tests, new production dependencies, Task 007E cleanup or automatic merge. Stop here for System Owner review.
