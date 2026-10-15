# Task 007E — Cleanup Audit and PostgreSQL Verification

Status: audit/documentation implemented; PostgreSQL milestone rerun FAILED at Task 007C asynchronous teardown. Verification is blocked pending System Owner direction. Task 007E is not merged and Task 007 is not COMPLETE.

## Branch and predecessor

- Repository: good74152/cost-engine-orchestration-platform.
- Branch: feature/task-007e-safe-legacy-cleanup-and-doc-sync.
- Exact baseline: 74f08823e8be099ef4eef5b6fa8d3c43cf019b09, latest origin/main fetched before implementation on 2026-10-15.
- Task 007D reviewed commit 54dac9e3fa0c3dfcb5d1f151dfcddd6205f8c5de is an ancestor of main (git merge-base --is-ancestor exited 0).
- Main first-parent merge history confirms A (#7, e4d531c), B-1 (#8, d1465d7), B-2 (#9, 273eac6), C (#10, 58dd1b7) and D (#11, 74f0882).
- Branch was created with git switch -c feature/task-007e-safe-legacy-cleanup-and-doc-sync origin/main; working tree was clean.
- The historical task-007d-milestone.md report is preserved unchanged. Its execution/review-time status is not retroactively rewritten.

## Supported-caller audit before any deletion

Repository-wide rg searches covered tracked application/test/tooling/docs/migration/config files, static imports, re-exports, dynamic imports, package scripts/entry points and startup. Ignored node_modules, dist and .git are generated/dependency/history areas, not supported source callers. A read-only relative-import graph cross-check covered every src/scripts TypeScript file, including multiline dynamic imports. All src modules are reachable from startup or supported tests; src/server.ts is the package dev/start entry point.

Specific reproducible searches:

```powershell
rg -n --hidden -g '!node_modules/**' -g '!.git/**' -g '!dist/**' 'calculation-job\.service|import\(|export .+ from|require\(' .
rg -n 'calculation-job\.service|prepareCalculationJobRunService|runCalculationJobService|reconcileCalculationJobService|reconcileExecutionAttemptService|reconcileExecutionByIdentityService' src scripts docs/tasks -g '*.ts' -g '*.md'
rg -n 'calculation-jobs|start-job|startCalculation|createCalculationJob|businessKey' package.json README.md docs/ARCHITECTURE.md scripts/dataset-version-creation-v2.pg.test.ts
git ls-files
```

| Candidate / responsibility | Direct / indirect callers and test evidence | Replacement / workflow risk | Decision and reason |
|---|---|---|---|
| src/modules/calculation-job.service.ts — service/type re-export barrel | Task 003 suite dynamically imports ../src/modules/calculation-job.service.js (lines 425–430 at baseline); npm run test:first-run-immutable-build-snapshot and milestone invoke it. Task specs also reference it. No production import; no package exports or other hidden entry point found. | Implementations live in preparation/run/reconciliation services. Deleting the barrel breaks a supported test, even though production imports implementations directly. | RETAIN. The request explicitly permits retention for a legitimate caller. Stop deletion of this candidate; do not rewrite a supported test simply to make the barrel unreferenced. |
| calculation-job-preparation.service.ts / .repository.ts — first Run/freeze | Run service directly imports preparation; preparation imports its repository. Dispatch/reconciliation/terminal suites import preparation directly; Task 003 uses the barrel. | Sole accepted snapshot/definition/upstream freeze owner; no obsolete v1 replacement stub. | RETAIN. Required supported runtime and PostgreSQL coverage. |
| calculation-job-run.service.ts / .repository.ts — dispatch/retry | calculation-job.route.ts imports Run; shared repositories are used by reconciliation/lifecycle modules. app → route → service; dispatch/B regressions/E2E exercise it. | Accepted Run boundary; removal loses supported behavior. | RETAIN. Not legacy dead code. |
| calculation-job-reconciliation.service.ts / .repository.ts — executor truth | Job route imports manual reconciliation; callback route imports identity reconciliation; shared ownership check is used by Run. app → routes → service; reconciliation/B/E2E suites. | Accepted reconciliation authority, stale retry/history guards. | RETAIN. Required supported callers. |
| calculation-job.route.ts — current job wiring; possible v1 routes | app registers only Run/Reconcile when an executor is injected. Task 002 explicitly asserts POST /calculation-jobs and start/submit-validation/publish/reject/fail return 404 and leave DRAFT/PENDING state intact. | Old creation/lifecycle wiring is already absent; accepted paths are dataset creation/lifecycle plus job Run/Reconcile. | RETAIN current route module. No obsolete handler/helper or old start concurrency package command remains to delete. |
| Other dataset-version modules, shared DB/types/errors and executor modules | All have incoming source/test imports or server entry-point reachability. Dataset routes use creation/lifecycle services; those use repositories/transaction; app uses errors; server factory/app routes use executors. | Each participates in an existing workflow or type/tooling boundary. | RETAIN. No positively proven dead v1 application artifact; avoid speculative exported-symbol pruning/refactoring. |
| src/modules/raw-ingestion/** and scripts/raw-ingestion.route.test.ts | app → raw route → allocateRawIngestionBatch → repository/transaction; original test invoked by milestone isolated launcher. | No replacement: raw allocation is supported (including 20-request race). | RETAIN unchanged. Supported API/data, not canonical dataset creation. |
| scripts/task-007d-* and scripts/support/task-007d-* | package milestone/runner/E2E commands import/launch them; runner launches original raw regression with scoped URLs. | Only accepted reproducible complete gate and raw isolation. | RETAIN unchanged. No broken script reference found. |
| All six migrations and legacy_business_key/DPR/raw compatibility schema | npm migrate CLI and PostgreSQL suite migration runners load them; schema tests exercise legacy up/down and rejection guards. | No schema/data retirement authorized. | RETAIN byte/content history unchanged; no new migration. |

Actual application cleanup diff: **no deletions and no application/test changes**. No candidate met the zero-supported-caller condition. This is a supported-caller retention result, not a claim that the barrel was unused. No architecture decision or cleanup-driven contract change is needed. Further barrel retirement would require a separately scoped supported-caller change.

## Dependency/package audit

| Dependency | Positive supported usage | Decision |
|---|---|---|
| dotenv | server/app/pool and PostgreSQL test/runner configuration | RETAIN |
| fastify | app HTTP server, route and test instance types | RETAIN |
| pg | runtime pool/transaction and PostgreSQL fixtures/maintenance clients | RETAIN |
| node-pg-migrate | npm migrate CLI, historical migration types, all PostgreSQL migration fixtures | RETAIN |
| tsx | npm dev/test/milestone commands and isolated raw Node loader | RETAIN |
| typescript | npm build → tsc; source strict NodeNext compilation | RETAIN |
| @types/node | Node environment/core-module/process APIs in source and tooling | RETAIN |
| @types/pg | Pool/PoolClient/Client typing across runtime and tests | RETAIN |

No dependency removal/addition/upgrade, lockfile change or package-script change. package.json's main=index.js is not a supported barrel reference: the app's actual commands are dev=tsx watch src/server.ts and start=node dist/server.js; no library exports map exists. Do not broaden this task into packaging changes.

All 13 milestone child entries remain unchanged: build plus twelve test suites. npm run test:milestone-runner and npm run test:task-007d-end-to-end remain present, as does test:raw-ingestion (used safely through its wrapper).

## API inventory preserved

Observed via actual buildApp.ready()/printRoutes with injected FakeExecutor and approved test environment; no DB mutation or health handler execution:

| Method | Registered route |
|---|---|
| GET | /health (Fastify also generates HEAD) |
| POST | /dataset-versions |
| POST | /dataset-versions/:datasetVersionId/submit-validation |
| POST | /dataset-versions/:datasetVersionId/publish |
| POST | /dataset-versions/:datasetVersionId/reject |
| POST | /dataset-versions/:datasetVersionId/abandon |
| POST | /calculation-jobs/:jobId/run |
| POST | /calculation-jobs/:jobId/reconcile |
| POST | /executor-callbacks/airflow |
| POST | /raw-ingestion-batches |
| POST | /internal/fake-executor/executions/:dagRunId/succeed (approved dev/test FakeExecutor only) |
| POST | /internal/fake-executor/executions/:dagRunId/fail (approved dev/test FakeExecutor only) |

buildApp registers executor-backed routes only when an executor is injected; server.ts explicitly obtains one from the factory. No supported route was removed/added. Old creation and job-level lifecycle routes stay absent. No read/list APIs were invented. Raw validation, original 201 DTO/409 code, transactions and concurrency test are unchanged.

## Migration inventory — baseline and final comparison

Git blob identities compared before/after verification: all six unchanged; all under migrations/:

| File | Blob |
|---|---|
| 1786634529143_init-core-schema.ts | 8c158c63286949218c2ed812b5ad305c8c7da994 |
| 1787236891082_add-dpr-performance-tables.ts | 1339fb050a2ecd26eef31e0e249b2586a3130254 |
| 1787645607729_add-dpr-calculation-input-snapshots.ts | 6a26585230f893a63e2e6679e972ffab51c50002 |
| 1787645607730_add-dpr-calculation-inputs.ts | 8d4a7519cda3330c5e6863dddc29efd93afb8324 |
| 1787755224449_raw-ingestion-batches.ts | 93c55668b079d032a2d366591fe7dec6b71635b4 |
| 1788700000000_orchestration-schema-v2.ts | 8c4cecf7dbcefad65db639ff3824d33f7c968d81 |

No historical DPR/raw table/index/compatibility column or data is removed. No DB migration is added, edited or renamed.

## Documentation changes / static boundary

- README.md: replace obsolete current-implementation claims; explain actual model/lifecycle/dispatch/retry/reconciliation/raw feature, complete route surface and flat error envelope; safe local configuration/migrations and milestone usage; explicit FakeExecutor limitations.
- AGENTS.md: only current task navigation/status updated; preserve engineering/ADR/testing/migration/truth-boundary policy.
- docs/ARCHITECTURE.md: preserve accepted architecture; clarify distinct dispatch transactions and current executor/API/testing implementation; update merged sequence/status and error coverage links.
- docs/ROADMAP.md: verify merged A–D from Git, retain E awaiting review and owner completion gates.
- This audit/verification note is new; historical D report, accepted ADRs, task specs and all source/scripts are untouched.

Static pre-test findings: git diff --check exits 0; full diff contains only these five Markdown files. git diff against baseline for src, scripts, migrations, package.json and package-lock.json is empty. No removed symbols/files need a dangling-reference sweep, because none are removed. Existing caller references were positively rechecked instead. No new skipped/TODO tests, route/DTO/error/state-machine/lock/transaction changes, dependencies or infrastructure.

## New runtime verification

Executed on 2026-10-15 (Asia/Taipei). **Overall FAIL / verification blocked**, not a milestone PASS. No rerun was used to hide the observed failure.

### Revisions and environment

| Item | Executed observation |
|---|---|
| Exact tested source commit | 8af951236347a918443adc942efeddfa063d52a2 |
| Exact tested Git tree | 2aca2aa77976da1856d77e52ff5265226fc75429 |
| Working tree during execution | Clean |
| Metadata cross-check | CON investigation printed gitCommit=8af951236347a918443adc942efeddfa063d52a2 |
| Final delivery revision | Later documentation-only descendant; see git log. It is not claimed as a separately runtime-tested commit. |
| Node.js / npm | v24.18.0 / 11.16.0 |
| PostgreSQL | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2), x86_64, 64-bit |
| Topology | Windows Node → localhost:5432 → Compose postgres_db / test_postgres, PostgreSQL 18 |
| Configuration | TEST_DATABASE_URL, falling back to DATABASE_URL; credentials never printed/committed |
| Role observation | CREATEDB=true, SUPERUSER=true on the local test service |
| DB isolation | Suite-owned, validated disposable DB names; template0; checked-in migrations; maintenance DB postgres |
| Preflight ownership check | Created and verified ownership of task_007e_preflight_11412_62ce3806407a, then dropped it |
| Before/after database inventory | Exactly postgres, template0, template1, testdb |
| Postflight C/preflight sessions | None |

This role is privileged; safety relies on owned disposable targets and local-only connection preflight, not a least-privilege sandbox. No developer/persistent database was dropped or truncated. Raw isolation wrapper remains unchanged but was NOT RUN in this gate because fail-fast stopped earlier.

The runtime source includes the initial audit note with NOT RUN status. This later report and status corrections in developer documentation record what actually happened after that commit; source/scripts/migrations/packages remain identical. Historical D PASS results refer only to that report's own revision and do not substitute for this failed E rerun.

### Exact required commands and results

- npm.cmd run build — exit 0, no compiler diagnostics; test counters not applicable.
- npm.cmd run test:milestone — exit 1, structured overall FAIL.

The unchanged runner actually executed these child commands in this order (npm CLI through Node on Windows). All observed signal/spawnError fields are null. NOT RUN means exit/counters null, not zero:

| Command | Exit | Pass | Fail | Skip | Cancelled | TODO | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| npm run build | 0 | null | null | null | null | null | PASS |
| npm run test:milestone-runner | 0 | 20 | 0 | 0 | 0 | 0 | PASS |
| npm run test:orchestration-schema-v2 | 0 | 30 | 0 | 0 | 0 | 0 | PASS |
| npm run test:dataset-version-creation-v2 | 0 | 14 | 0 | 0 | 0 | 0 | PASS |
| npm run test:first-run-immutable-build-snapshot | 0 | 19 | 0 | 0 | 0 | 0 | PASS |
| npm run test:execution-attempt-dispatch-fake-executor | 0 | 11 | 0 | 0 | 0 | 0 | PASS |
| npm run test:executor-reconciliation | 0 | 22 | 0 | 0 | 0 | 0 | PASS |
| npm run test:dataset-version-terminal-lifecycle | 0 | 64 | 0 | 0 | 0 | 0 | PASS |
| npm run test:cross-workflow-concurrency-investigation | 0 | 14 | 0 | 0 | 0 | 0 | PASS |
| npm run test:task-007b1-late-dispatch-reconciliation | 0 | 32 | 0 | 0 | 0 | 0 | PASS |
| npm run test:task-007c-api-contract | 1 | 11 | 1 | 0 | 0 | 0 | FAIL |
| npm run test:raw-ingestion (owned disposable PostgreSQL database) | null | null | null | null | null | null | NOT RUN |
| npm run test:task-007d-end-to-end | null | null | null | null | null | null | NOT RUN |

Summary: 13 command records; 10 PASS, 1 FAIL, 2 NOT RUN. Executed test counters total **237 pass / 1 fail / 0 skip / 0 cancelled / 0 TODO**. The build has null counters, and the two unexecuted suites have no observed counters. Counts include Node parent/file entries.

### Failure evidence and bounded investigation

Task 007C's ten subtests and parent passed (11 passing entries), including all 20 raw-ingestion requests yielding one 201 and nineteen 409s. After the parent completed, Node detected asynchronous activity associated with that contention subtest:

```text
Error: Test "raw-ingestion 20-way contention retains one 201 and nineteen 409"
at scripts\\task-007c-api-contract.pg.test.ts:237:13 generated asynchronous activity
after the test ended. This activity created the error
"error: terminating connection due to administrator command"
and would have caused the test to fail, but instead triggered an uncaughtException event.

not ok 1 - scripts\\task-007c-api-contract.pg.test.ts
failureType: 'testCodeFailure'
exitCode: 1
code: 'ERR_TEST_FAILURE'
# tests 12
# pass 11
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Read-only inspection found the fixture closes Fastify, awaits pool.end(), restores environment and executes DROP DATABASE IF EXISTS ... WITH (FORCE) in finally (lines 308–318). PostgreSQL container logs at 2026-10-15 05:31:15.554 UTC record FATAL: terminating connection due to administrator command. The symptom is consistent with fixture teardown/connection shutdown timing, but the exact cause is **not proven** by this observation. No failed HTTP/business assertion or new production lifecycle defect was identified. Do not relabel it as a harmless warning or suppress it.

The runner correctly failed closed and did not start the isolated original raw regression or integrated E2E Flow A–F. Those required suites remain NOT RUN for this revision. Although disposable DB removal completed and postflight inventory is clean, the requirement for a clean, error-free full teardown/gate is NOT satisfied.

No production fix, test edit, sleep, error-swallowing handler, cleanup bypass or repeat-until-green run was made. A scoped teardown investigation/fix requires System Owner direction before further implementation. No accepted architecture change is proposed.

### Verified results before the blocker

- Schema/migrations: 30 passing entries, including clean/representative legacy up, supported down/forward, unsafe conversion rejection/atomicity and real rejected invariant writes.
- Dataset creation: 14 passing entries; canonical allocation/rollback/concurrency and absent legacy mutation routes preserved.
- First Run: 19 passing entries through the retained barrel caller.
- Dispatch: 11 passing entries; reconciliation: 22; dataset terminal lifecycle: 64.
- Combined CON-01/CON-02: **14 passing entries, exit 0**. Both CON-01 recording orders and legal identity-wide rejection/existing/UNKNOWN/recovery/independent-job cases are green. Invalid-adapter cases remain passing negative contract tests, not supported behavior.
- Focused B-1: **32 passing entries, exit 0**, including late terminal responses, later lifecycle, newer retry ownership, contradictions and lock/identity boundaries.
- Runner-policy regression: 20 passing entries. Fail-fast behavior also operated correctly in this actual gate.
- C route assertions passed, but its process/file-level asynchronous teardown failure makes the suite FAIL. Raw original regression/E2E were not executed, not implicitly covered by historical D results.

### Additional checks and warnings

| Command/check | Exit/result |
|---|---|
| docker compose up -d postgres_db | 0; existing container Running |
| node --version | 0; v24.18.0 |
| npm.cmd --version | 0; 11.16.0 |
| npm.cmd ls --depth=0 | 0; all eight direct dependencies present |
| node --input-type=module -e $preflightCode | 0; local endpoint, server/role, owned create/ownership/drop and inventory |
| node --input-type=module -e $postflightCode | 0; read-only inventory matches and no remaining C/preflight sessions |
| node --import tsx --input-type=module -e $routeCode | 0; actual registered route tree, no business/DB handler invoked |
| node --input-type=module -e $linkCode | 0; all 16 local Markdown links and package script source targets exist |
| git diff --check | 0 before tests; repeated after reporting |
| git diff --exit-code 74f08823e8be099ef4eef5b6fa8d3c43cf019b09 -- src scripts migrations docs/adr package.json package-lock.json docs/verification/task-007d-milestone.md | 0, empty before/after tests |
| git ls-tree -r HEAD migrations | Six blobs match the baseline inventory above exactly |
| rg -n 'calculation-job\.service' src scripts | Supported Task 003 dynamic import still present |

Warnings: the actual asynchronous PostgreSQL termination above is a **test failure**, not a passing teardown. Git emitted an informational LF→CRLF warning when staging the new audit note. An optional initial AST-import diagnostic could not use ScriptTarget.Latest from the installed TypeScript 7 package; the caller audit was completed using successful read-only relative-import scanning, rg and direct caller inspection instead. That diagnostic was not a build/test result. No dependency/version change was made.

No additional compiler, spawn or signal warning was observed in the gate. Runtime coverage is this Windows/Node 24/PostgreSQL 18.6 environment only. The privileged local role and in-process fake limitations remain as documented. Delivery is blocked on the failing verification, not claimed complete.

The existing origin still uses the former financial-calculation-platform repository slug. Read-only git ls-remote origin refs/heads/main exited 0 and returned the same 74f0882 baseline. The remote configuration was not changed as part of this bounded task; GitHub may print repository-relocation guidance on push.

## Remaining limits / review gate

FakeExecutor is instance-local dev/test state, not a production Airflow implementation or durable distributed rejection store. Real Airflow, cancellation, queues, periodic workers, automatic publication and schema/data retirement remain deferred. No production architecture conflict found in the audit. The observed Task 007C teardown failure is unresolved; further scoped investigation/repair needs owner direction. Task 007E review/merge and System Owner final milestone acceptance remain pending.
