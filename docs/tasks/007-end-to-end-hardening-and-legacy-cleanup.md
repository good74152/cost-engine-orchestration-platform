# Task 007 — End-to-End Hardening and Legacy Cleanup

- Status: Design priorities accepted; implementation not started.
- Baseline: main commit 85479c723090de8dc96cdb0a13472f3156b5e8f9.
- Workflow: system owner reviews each bounded PR first; Codex implements only delegated packages.
- Goal: finish the Orchestration Core v2 milestone without redesigning Tasks 002–006.

## Accepted decisions

1. Investigate CON-01 and CON-02 before lower-severity cleanup.
2. Retain the supported raw-ingestion API, module, test, historical data, and all applied migrations for this milestone. Raw ingestion is NOT dead code.
3. Divide Task 007 into independently reviewable slices.
4. No real Airflow, executor cancellation, queues, RabbitMQ, Redis, Kafka, or Kubernetes.
5. No new dataset/job/attempt states or changes to accepted lock ordering and transaction protocols.

## Source of truth and evidence boundary

Read AGENTS.md, README.md, docs/ARCHITECTURE.md, docs/ROADMAP.md and ADRs 0001–0007.

The static inspection at main 85479c72 found these test suites:
~~~text
scripts/orchestration-schema-v2.pg.test.ts
scripts/dataset-version-creation-v2.pg.test.ts
scripts/first-run-immutable-build-snapshot.pg.test.ts
scripts/execution-attempt-dispatch-fake-executor.pg.test.ts
scripts/executor-reconciliation.pg.test.ts
scripts/dataset-version-terminal-lifecycle.pg.test.ts
scripts/raw-ingestion.route.test.ts
~~~
They have NOT been executed as part of this design review. Existence of test files is not a passing verification result. Existing suites cover many deterministic races; do not mechanically duplicate them.

Accepted lifecycle:
~~~text
dataset: DRAFT → BUILDING → VALIDATING → PUBLISHED / REJECTED
         DRAFT / BUILDING → ABANDONED
job:     PENDING → RUNNING → SUCCEEDED / FAILED; FAILED may retry
attempt: PREPARED → DISPATCHING → ACCEPTED → SUCCEEDED / FAILED
         DISPATCHING → DISPATCH_FAILED only on confirmed no-run rejection
~~~
One immutable dataset-wide snapshot; retries retain it. Callback is only a trigger; executor status is authoritative. External calls are outside transactions. Same-target terminal commands are idempotent. Do not relax historical attempt immutability.

Accepted locking:
~~~text
first-run:       calculation_type → upstream dataset_series → output dataset_version → job
terminal:        dataset_series → dataset_version → jobs ordered → attempts ordered
job/attempt:     calculation_job → execution_attempt
~~~

## Implementation work packages

| Package | Bounded purpose | Status |
|---|---|---|
| 007A | Deterministic proof/classification of cross-workflow dispatch races | Evidence complete on unmerged 007A branch |
| 007B | CON-01 bounded late-response correction; CON-02 identity guarantee design | 007B-1 spec ready; 007B-2 architecture decision pending |
| 007C | HTTP validation and public error contract hardening | Ready after concurrency gate |
| 007D | Complete E2E acceptance + reproducible PostgreSQL milestone test command | After concurrency and API stabilise |
| 007E | Safe legacy application cleanup and truthful documentation | Last, after replacement paths protected by tests |

Subtask specifications:
- docs/tasks/007a-cross-workflow-concurrency-investigation.md
- docs/tasks/007b-conditional-concurrency-remediation.md
- docs/tasks/007b1-late-dispatch-terminal-reconciliation.md
- docs/tasks/007b2-definite-rejection-semantics-review.md
- docs/tasks/007c-api-contract-hardening.md
- docs/tasks/007d-end-to-end-verification-gate.md
- docs/tasks/007e-legacy-and-documentation-cleanup.md

Task 007A investigation evidence is available on feature/task-007a-concurrency-investigation (currently unmerged and containing intentionally red regression tests). CON-01 and CON-02 were reproduced on real PostgreSQL. 007B-1 has a bounded spec for the valid late-acceptance case; 007B-2 remains blocked pending the system owner's decision on the permanent identity scope of definite rejection. Do not merge a red suite or treat CON-01 resolution as complete Task 007B.

## 1. API contract gap inventory

Static findings:
- Dataset lifecycle endpoints already validate datasetVersionId UUID format.
- Run/reconcile routes currently forward jobId without UUID checking: malformed values may reach PostgreSQL and produce generic 500 instead of 400.
- Callback validates exact body keys and non-empty strings, but lacks identifier length bounds.
- Raw-ingestion route has a TypeScript request body type but lacks runtime body validation.
- Current error envelope is {message, code}; preserve the public shape unless a separate compatibility decision is approved.
- Fake-executor control routes are enabled when effective environment is merely not 'production'; verify explicit dev/test-only activation.

Required: contract matrix for all actual public error codes, malformed payloads, 400/404/409/502/503 status distinction, no internal SQL/constraint leakage, and consistent route-level tests. Do not silently introduce new read endpoints or change successful DTOs.

## 2. Complete E2E scenarios

Use HTTP through the registered Fastify app, actual migrated PostgreSQL, and deterministic FakeExecutor; use SQL for fixtures and durable-state assertions, not as a substitute for supported lifecycle APIs.

1. Publish CAPEX v1, create DPR with two or more jobs, freeze CAPEX v1 at first Run, execute/reconcile all jobs, submit validation and publish; verify latest PUBLISHED and frozen inputs.
2. Job execution fails, retry creates a new attempt with same snapshot and definition pins, later succeeds; submit validation and publish.
3. ACCEPT_THEN_UNKNOWN creates external execution but loses dispatch response; reconcile same DISPATCHING attempt to terminal; no duplicate execution/run identity or dependency refresh.
4. Completed version reaches VALIDATING then REJECTED; next version allocation succeeds, REJECTED is not exposed as latest PUBLISHED.
5. DRAFT abandonment; safe BUILDING abandonment after terminal attempts; PREPARED/DISPATCHING/ACCEPTED guards reject abandonment; no cancellation.
6. Late duplicate terminal callback after VALIDATING/PUBLISHED remains idempotent and does not mutate historical states.

Assert dataset/job/attempt identities, counts, immutable snapshots, resolved definition IDs, series allocation monotonicity and terminal timestamps.

## 3. Cross-workflow races and transaction gates

CON-01 — dispatch outcome recorded after reconciliation terminalizes same attempt:
~~~text
/run: PREPARED → DISPATCHING committed
executor creates external run; dispatch HTTP response blocked
reconcile: executor already SUCCEEDED → local attempt/job SUCCEEDED; commit
/run: original ACCEPTED result resumes
~~~
Current recordDispatchOutcome seems to require DISPATCHING and may raise an internal invariant/HTTP 500 even though durable terminal truth is correct. Reproduce deterministically before deciding a fix. Never regress committed terminal state or allocate a new attempt.

CON-02 — two /run calls dispatch same stable identity with apparently conflicting outcomes:
~~~text
A obtains REJECTED (definite no-run)
B obtains ACCEPTED / ALREADY_EXISTS (run created)
local outcome recording races in both orders
~~~
First prove whether such outcomes satisfy or violate the executor adapter's REJECTED contract. Separate valid executor behavior, contract violation, and real local race. Do not invent conflict precedence or change attempt state semantics without owner/ADR review.

Preserve and run existing deterministic tests for:
- Publish vs downstream snapshot freeze and definition publish vs freeze
- Run vs Abandon and reconciliation vs Abandon
- concurrent creation, first-run, run, reconcile, Submit Validation, Publish vs Reject
- transaction rollback, lock ordering, and external calls outside DB transactions

Deterministic PG barriers/NOWAIT or controlled external barriers are required; sleep-only timing is not sufficient for critical acceptance.

## 4. Legacy inventory / deletion boundary

| Candidate | Classification | Decision |
|---|---|---|
| src/modules/calculation-job.service.ts (re-export only) | Potential unused barrel | Search all imports/exports and tests; delete only if unreferenced |
| Superseded v1 calculation-job routes and helpers | No longer public | Search for supported callers; remove only proven dead implementation |
| src/modules/raw-ingestion and POST /raw-ingestion-batches | Supported endpoint | RETAIN |
| scripts/raw-ingestion.route.test.ts | Supported regression test | RETAIN |
| Applied migration files, including orchestration schema v2 | Historical schema/data | RETAIN UNCHANGED |
| DPR performance/input snapshot migrations and tables | Historical tables, potentially persisted data | RETAIN; no drop/data purge |
| legacy_business_key / migration compatibility bridge | Migration history | RETAIN unless separate migration/data decision |
| Package dependencies | No unused dependency yet proven | Positive audit before deletion; no upgrade sweep |

Removing application dead code is not authority to delete historical database structures. Do not change migration down/up semantics or delete audited data in this milestone.

## 5. Documentation / reproducible verification

Known drift on baseline:
- AGENTS.md points to Task 006 with Task 005 merge pending.
- ROADMAP.md describes Task 005 as unmerged and Task 006 as blocked.
- ARCHITECTURE.md implementation sequence has not been updated to merged Tasks 002–006.
- README.md Current Implementation still describes old one-job-per-dataset code.
- package.json has individual PG suite scripts but no one-command milestone test gate; no inspected .github/workflows directory.

The milestone gate must run build plus all six v2 PostgreSQL suites AND retained raw-ingestion suite against isolated disposable test databases. Document PostgreSQL CREATE DATABASE requirements, setup/teardown, command/exit code, and protection against touching non-test databases. A CI workflow is optional; local reproducibility with recorded evidence is mandatory.

## Required acceptance evidence

Report must include:
~~~text
git SHA
Node.js version
PostgreSQL server version
database setup (without credentials)
exact commands and exit codes
suite names, counts of pass/fail/skip
deterministic race test results and classification
migration up/down + fail-fast verification
unresolved/blocked findings with severity
system owner approval
~~~

Final milestone acceptance:
- [ ] CON-01/CON-02 classified with deterministic evidence; any real defect fixed without violating accepted ADRs.
- [ ] Zero known critical lifecycle or concurrency regressions; no split between external run identity and durable local truth under supported executor semantics.
- [ ] No ordinary malformed request causes a generic 500; actual public error codes verified at route boundary.
- [ ] Complete success, retry, ambiguous, reject, abandon E2E flows green.
- [ ] Snapshot/dependency pins and terminal history invariant under retries and lifecycle transitions.
- [ ] All existing PostgreSQL integration/constraint suites green, no unexplained skips.
- [ ] Single reproducible milestone test command, captured execution evidence and repeatable database setup.
- [ ] Safe cleanup only, raw-ingestion route preserved, applied migrations and history preserved.
- [ ] README, AGENTS, ARCHITECTURE, ROADMAP updated truthfully.
- [ ] Human review performed before Codex fixes are accepted and before milestone completion.

A reproduced critical defect blocks completion even if other tests pass. Missing tests are gaps in evidence, not automatically evidence of bugs.

## Stop conditions

Stop and return to design review if:
- conflict precedence between concurrent external results requires a new lasting rule;
- an accepted dataset/job/attempt state or lock protocol would need to change;
- migration/data loss or removal of the supported raw-ingestion API is proposed;
- reproducibility cannot be demonstrated with real PostgreSQL.
