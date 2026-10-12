# Task 007D — End-to-End Verification and Reproducible PostgreSQL Gate

- Status: Ready after concurrency fixes (if any) and API hardening merge.
- One independently reviewable test/verification PR.
- No production lifecycle redesign, executor adapter implementation, or historical migration edits.

## Goal

Demonstrate that Tasks 002–006 work as one coherent orchestration system, preserve durable identity and immutable snapshots across failures, and have a reproducible green milestone verification command against PostgreSQL.

## Preconditions

Read the Task 007 master spec, accepted ADRs 0001–0007, the current HTTP routes, FakeExecutor, and all existing PG test suites. Reuse existing fixtures/helpers as appropriate. Do not duplicate low-level race tests already covered in specialized suites.

## E2E requirements

Use Fastify.inject registered public endpoints, fresh migrated disposable PostgreSQL database(s), and deterministic FakeExecutor status controls. SQL may create calculation types/dependency definitions and inspect DB history, but do not change lifecycle status directly as a substitute for the supported API.

### Flow A — upstream publish and downstream success

~~~text
seed CAPEX calculation type + published dependency definition with zero upstream
POST Create CAPEX v1
POST Run each job
simulate fake SUCCEEDED
POST Reconcile each job
POST Submit Validation
POST Publish

seed DPR two or more calculation types + definition requiring CAPEX
POST Create DPR v1
POST Run first job → freeze CAPEX v1
POST Run remaining jobs
simulate/reconcile SUCCEEDED
POST Submit Validation → POST Publish
~~~

Assert: one DPR snapshot, every job has resolved definition pin, frozen upstream CAPEX v1, no premature VALIDATING, latest PUBLISHED selection, correct job/attempt identities and terminal timestamps.

### Flow B — failed execution and retry

~~~text
DPR job ACCEPTED → fake FAILED → reconcile FAILED
POST Run retry → attemptNumber increments
same datasetBuildSnapshotId, same pinned definition / upstream versions
fake SUCCEEDED → reconcile SUCCEEDED
all jobs SUCCEEDED → Submit Validation → Publish
~~~

Assert attempt 1 remains FAILED, attempt 2 SUCCEEDED, no new dataset version/snapshot.

### Flow C — lost dispatch response

~~~text
FakeExecutor ACCEPT_THEN_UNKNOWN
POST Run → 202, same attempt DISPATCHING
fake external execution moves to SUCCEEDED before next response
POST Reconcile → terminal SUCCEEDED
finish other jobs, Submit Validation, Publish
~~~

Assert exactly one external execution for that stable DAG identity; no new attempt.

### Flow D — reject and next-version creation

~~~text
complete version to VALIDATING
POST Reject
POST Create same series → next monotonic version
~~~

Assert REJECTED is immutable and never latest PUBLISHED.

### Flow E — abandonment safety

~~~text
DRAFT → Abandon succeeds
new BUILDING version with FAILED/terminal attempts → Abandon succeeds
PREPARED, DISPATCHING, ACCEPTED → Abandon conflict and no mutation
~~~

Do not call executor cancel or purge history.

### Flow F — late callback safety

A terminal attempt is rechecked after validation/publication. Callback identity only triggers executor lookup, matching terminal state is idempotent. No job/dataset history rewrite.

## Test suite arrangement

Prefer a clearly named integrated PG E2E suite rather than repeating all existing test fixtures and cases. Tests should use independently named temporary databases; avoid destructive cleanup on the configured source database. Use actual PostgreSQL locks where timing matters. No sleep-only concurrency assertions.

## Reproducible milestone command

Add a single package.json command (recommended: test:milestone) that **sequentially** executes:
~~~text
npm run build
npm run test:orchestration-schema-v2
npm run test:dataset-version-creation-v2
npm run test:first-run-immutable-build-snapshot
npm run test:execution-attempt-dispatch-fake-executor
npm run test:executor-reconciliation
npm run test:dataset-version-terminal-lifecycle
npm run test:raw-ingestion
new integrated E2E suite
~~~
Preserve isolated test databases and avoid running these suites in one shared process that mutates the same DATABASE_URL. Node and PostgreSQL versions, database permissions needed for CREATE/DROP DATABASE, and safe setup instructions must be documented.

CI is optional for this milestone; a reproducible local test command and recorded real-PostgreSQL evidence are mandatory.

## Required test report

Create a tracked verification report at an appropriate docs/verification path (no credentials, tokens, secrets, or sensitive source data):
~~~text
Git HEAD SHA
Node version
PostgreSQL server version
database connection topology (redacted)
exact command invocation and exit code
suite-by-suite passed, failed and skipped counts
CON-01 / CON-02 deterministic regression outcomes
migration up/down and rollback-guard results
any blocked/failed case and disposition
~~~

If an environment is not available, mark the test as NOT RUN and do not mark the milestone verified. No fabricated pass results.

## Scope boundaries

Do not add real Airflow, queues, extra API endpoints for test convenience, migration/schema changes, attempt-state transitions, or automatic publication. Do not hide failures by skipping tests.

## Acceptance

- [ ] All six E2E flows use supported APIs and real PostgreSQL.
- [ ] Immutable snapshot/definition/attempt history assertions pass.
- [ ] Single command runs build, all six existing v2 PG suites, retained raw-ingestion test, new E2E suite.
- [ ] Safe temporary DB isolation and cleanup confirmed.
- [ ] All tests green without unexpected skips.
- [ ] Actual run evidence captured in repo and independently reproducible.
- [ ] Zero known critical lifecycle/concurrency regressions remain open.
