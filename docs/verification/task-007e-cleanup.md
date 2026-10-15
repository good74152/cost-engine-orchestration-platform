# Task 007E — Cleanup Audit and PostgreSQL Verification

Status: caller/static audit recorded; new runtime verification NOT RUN yet. Task 007E is not merged and Task 007 is not COMPLETE. System Owner review/final acceptance remains required.

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

Git blob identities at baseline (to be compared after verification); all under migrations/:

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

NOT RUN yet. Exact tested revision/tree, commands, environment, counters, warnings and teardown will be recorded after execution, separately from the historical D results. A later report-only commit must not be claimed as the runtime-tested source revision.

## Remaining limits / review gate

FakeExecutor is instance-local dev/test state, not a production Airflow implementation or durable distributed rejection store. Real Airflow, cancellation, queues, periodic workers, automatic publication and schema/data retirement remain deferred. No production architecture conflict found in the audit. Task 007E review/merge and System Owner final milestone acceptance remain pending.
