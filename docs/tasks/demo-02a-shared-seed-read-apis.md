# Demo-02A — Shared Configuration Seed and Read APIs

## Goal and baseline

Provide an explicit minimal shared Demo configuration and protected PostgreSQL
Dataset, Job and Attempt reads. This is not a Scenario Runner.

Branch: `feature/demo-02a-seed-read-apis`, created from freshly fetched main
`2c44809a14d18559e7154c51c34e30acf8bebca3`. Its history contains Task 007 acceptance,
Demo-01A (PR #15), Demo-01B-1 (#20), Demo-01B-2 (#24) and the company collision
fix (#25). Do not use the old B2 feature branch as the baseline.

Authority: the System Owner's Demo-02A specification, AGENTS.md, the Architecture,
Roadmap, Reference, ADR-0009 and ADR-0010. Accepted core lifecycle, snapshot,
allocation, executor and lock protocols remain unchanged.

## Shared seed

Run `npm run seed:demo-guided` explicitly, after migrating a dedicated Demo DB.
It requires `APP_MODE=demo`, an approved development/test `NODE_ENV`, and an
explicit `DEMO_SEED_DATABASE_URL`. There is no fallback to `DATABASE_URL`.
Production and conflicting executor configuration fail closed. No connection
credentials are printed. No new dependencies or seeder framework are used.

For PowerShell, configure credentials privately, without pasting them into logs:

```powershell
$env:APP_MODE = 'demo'
$env:NODE_ENV = 'development'
$env:EXECUTOR_TYPE = 'fake'
# Privately set DEMO_SEED_DATABASE_URL to the migrated local Demo database.
npm.cmd run seed:demo-guided
```

One transaction inserts or verifies:

| Field | Required value |
|---|---|
| Domain | CAPEX |
| Type code | DEMO_GUIDED_SUMMARY |
| DAG | demo_capex_guided |
| Active | true |
| Definition allocation counter | 1 |
| Definition history | Exactly version 1, PUBLISHED, non-null published timestamp |
| Required direct domains | None |
| Other active CAPEX types | None |

An absent type is inserted with its counter and published definition in the
same transaction. A concurrent invocation uses the type uniqueness constraint
and row lock to converge on the same committed IDs. A repeated compatible seed
only verifies; it never updates rows or timestamps. Inactive CAPEX types and
other domains are left alone.

An existing guided type must match the complete contract. Missing/extra
definitions, different DAG, inactive type, wrong counter, unpublished definition,
missing publication timestamp or required upstream domains are conflicts, not
instructions to repair history. Another active CAPEX type also conflicts because
dataset creation snapshots every active type, not just the seeded one.

Conflict returns a clear `DEMO_CONFIGURATION_CONFLICT` command error and rolls
back, including a type inserted earlier in that transaction. Unexpected SQL
errors are sanitized. A transport failure during commit does not prove rollback;
rerunning the idempotent command checks durable configuration safely.

The seed never changes sessions, company codes, datasets, jobs, attempts or
published definitions. It is not invoked by startup, buildApp, session creation,
dataset creation or Reset. Shared configuration remains outside owner cleanup.
Demo-05A adds a separate optional `seed:demo-six-domain` command; the minimal
`seed:demo-guided` command and its CAPEX contract are unchanged. See
[six-domain setup](demo-05a-six-domain-configuration.md) for the additional types
and required published inputs.
Use the accepted single Demo instance/no concurrent core or external writer
boundary. Quiesce independent configuration administration while seeding; this
is not arbitrary cross-table/configuration-writer serialization.

## Protected read contracts

These GET routes exist only in explicit Demo mode:

| Route | Response |
|---|---|
| `/demo/dataset-versions` | Dataset page |
| `/demo/dataset-versions/:id` | Dataset detail |
| `/demo/dataset-versions/:id/calculation-jobs` | Owned parent's Job page |
| `/demo/calculation-jobs/:id` | Job detail |
| `/demo/calculation-jobs/:id/execution-attempts` | Owned parent's Attempt page |

Dataset list fields: `datasetVersionId`, `datasetSeriesId`, `domain`,
`fiscalYear`, `period`, `version`, `datasetStatus`, `createdAt`.
Detail adds nullable `buildingStartedAt`, `validatingAt`, `publishedAt`,
`rejectedAt`, `abandonedAt`.

Job list fields: `jobId`, `datasetVersionId`, `calculationTypeCode`, `jobStatus`,
`createdAt`, `startedAt`, `finishedAt`. Detail adds `datasetStatus`.

Attempt fields: `executionAttemptId`, `attemptNumber`, `attemptStatus`,
`createdAt`, `dispatchStartedAt`, `acceptedAt`, `finishedAt`.
Timestamps are ISO-8601 strings; unset lifecycle timestamps are null.

Every field is explicitly projected into the public DTO. No raw SELECT * rows,
credentials/hashes, company selectors, SQL diagnostics, dispatch error text,
DAG/run internals or fake memory are exposed. All statuses come from PostgreSQL.
A fake marked SUCCEEDED still reads as RUNNING/ACCEPTED until reconciliation.

## Security and ownership

Authenticate the existing HttpOnly cookie before parsing/handling the route.
Enter the existing coordinator and revalidate eligibility at execution time.
Each parameterized data statement joins its resource through canonical series
ownership to the authenticated session ID. No caller-supplied company code is
trusted. Missing, foreign and malformed resource IDs share generic 404.

GET requires no `X-Demo-Session` mutation header. Supplied Origin must still
match, and cross-site Fetch Metadata is rejected under the shared policy.
Cookies retain their existing HttpOnly/SameSite/Secure policy; no credentialed
CORS is enabled. Success and errors use `Cache-Control: no-store`.

| HTTP | Code |
|---|---|
| 400 | INVALID_REQUEST (unsupported or malformed query) |
| 401 | DEMO_SESSION_UNAVAILABLE (clear the actual session cookie) |
| 403 | DEMO_SESSION_CSRF_REJECTED (cross-origin policy) |
| 404 | DEMO_RESOURCE_UNAVAILABLE |
| 409 | RESET_CONFLICT |
| 429 | DEMO_SESSION_QUEUE_FULL |
| 503 | DEMO_RESET_OUTCOME_UNKNOWN |
| 500 | INTERNAL_SERVER_ERROR (sanitized unexpected failure) |

## Consistency and Reset

Reads use the same runtime-owned per-session Promise queue as mutations, not a
second lock. Running or queued reads make Reset busy. A reset reservation blocks
new reads with 409, or 503 while its commit outcome remains unknown. Different
sessions proceed independently. Queued expiry/revocation rejects before the
operation body, as before; already admitted work may finish.

One data SQL statement creates each response. Child lists use a bounded lateral
query inside the same statement as the parent ownership check. An empty owned
page is 200, not a false missing parent; an unavailable parent is 404. No response
combines multiple domain queries with inconsistent lifecycle observations.
No executor or explicit orchestration transaction is used for GET.

## Pagination and index review

Lists return `{ items, nextCursor }`. Default limit is 20; allowed limits are
canonical decimal integers 1–100. Values above 100 are rejected, not silently
clamped. Unknown query fields, duplicate limit/cursor values, invalid types,
invalid cursors and pagination on detail endpoints return 400.

Dataset and Job pages sort by UUID ascending. Attempt pages sort by immutable
`attemptNumber` ascending. Queries fetch at most limit+1, not whole histories.
Cursors are bounded (512 characters), canonical base64url JSON with exact
version/kind/session-and-parent scope/key validation. They are not credentials
or authorization: even a forged well-formed cursor still executes ownership SQL.
Use returned cursors unchanged. Pagination across requests is not a long-lived
database snapshot; concurrent insertions before the cursor require a refresh.

The suite records catalog definitions and EXPLAIN ANALYZE plans. Existing
version/series and job/version uniqueness indexes support joins; job history
uses `(calculation_job_id, attempt_number)` for bounded ordered range scans.
The Job list may sort that parent's job set. Company filtering may scan the
small Demo series table; no company-first index or large-scale latency guarantee
is claimed. No new index is justified by the small local Demo workload, so no
historical or new migration is changed. Reassess measured plans before scaling.

## PostgreSQL tests and verification

`scripts/demo-02a-seed-read-apis.pg.test.ts` creates a uniquely named template0
database, applies all seven migrations, runs real HTTP/SQL tests, closes actual
clients, verifies zero remaining backends and normally drops only its owned DB.
No FORCE, TRUNCATE, CASCADE or persistent developer-data cleanup is used.

Coverage includes fresh CLI seed, concurrent/repeated idempotency, incompatible
configuration and SQL-failure rollback, safety gates, full CAPEX HTTP publication
flow, both-direction owner isolation, DTOs, generic missing/foreign/invalid IDs,
unavailable-cookie clearing, Origin/core-mode boundaries, controlled read/reset
barriers, queued revocation, queue/unknown-reset contracts, multi-page datasets,
jobs and 136 attempts, cursor validation, and whole-graph/fake-memory read-only
checks. No mocked repository substitutes for PostgreSQL.

Privately configure TEST_DATABASE_URL (fallback DATABASE_URL) for a safe local
test service with CREATE DATABASE and owned DDL/drop privileges. Commands:

```bash
npm run build
npm run test:demo-02a
npm run test:demo-session-infrastructure
npm run test:demo-session-ownership-executor-isolation
npm run test:demo-session-reset-recovery
npm run test:milestone
git diff --check
```

### Executed results — 2026-10-24 (Asia/Taipei)

All final commands below ran on clean implementation commit
`818c1997aae9f25a5b3858121a0e795c4f0198d9`, tree
`f49ae67c863e5cd9e0a8e6e0039e83cb0d497ab5`. The later evidence commit changes
only this document. Environment: Windows PowerShell, Node 24.18.0, npm 11.16.0,
repository Compose PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2).
`docker compose up -d postgres_db` exited 0; the existing service was running.

The actual Windows commands use npm.cmd. Counts include Node parent/nested test
entries. Every test row has zero failures, skips, cancellations and TODOs.

| Command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |
| git diff 2c44809..HEAD --check | 0 | n/a | n/a | n/a |

Supplemental script type checking also exited 0:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-02a-seed-read-apis.pg.test.ts scripts/seed-demo-guided-configuration.ts
```

The unchanged milestone's actual child results (npm commands are launched by
the runner, including its isolated raw-ingestion launcher):

| Child command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm run build | 0 | n/a | n/a | n/a |
| npm run test:milestone-runner | 0 | 20 | 0 | 0 |
| npm run test:orchestration-schema-v2 | 0 | 30 | 0 | 0 |
| npm run test:dataset-version-creation-v2 | 0 | 14 | 0 | 0 |
| npm run test:first-run-immutable-build-snapshot | 0 | 19 | 0 | 0 |
| npm run test:execution-attempt-dispatch-fake-executor | 0 | 11 | 0 | 0 |
| npm run test:executor-reconciliation | 0 | 22 | 0 | 0 |
| npm run test:dataset-version-terminal-lifecycle | 0 | 64 | 0 | 0 |
| npm run test:cross-workflow-concurrency-investigation | 0 | 14 | 0 | 0 |
| npm run test:task-007b1-late-dispatch-reconciliation | 0 | 32 | 0 | 0 |
| npm run test:task-007c-api-contract | 0 | 12 | 0 | 0 |
| npm run test:raw-ingestion (owned disposable DB only) | 0 | 1 | 0 | 0 |
| npm run test:task-007d-end-to-end | 0 | 7 | 0 | 0 |

All 13 milestone commands reported PASS, exit 0, null signal/spawnError and no
gate issues. CON-01/CON-02 remain green. Raw ingestion was not run against a
persistent developer database. No existing test or milestone gate was weakened.

Final Demo fixture teardown evidence:

| Suite | Owned DB | Final sessions | Normal DROP |
|---|---|---:|---|
| 02A | demo_02a_test_9084_306feb1c15cb | 0 | yes |
| 01A | demo_01a_test_39720_8393837894cf | 0 | yes |
| 01B-1 | demo_01b1_test_29936_0ce7ee54dfc9 | 0 | yes |
| 01B-2 | demo_01b2_test_39552_4470c51cb397 | 0 | yes |

Each Demo fixture applied all seven migrations; no migration changed. The new
suite's real query plans showed a small company-filtered series scan, the
existing job/version index plus a small sort, and an ordered Attempt range scan
on uq_execution_attempt_job_number. These are local-workload observations, not
large-volume performance proof. After all gates, pg_database contained only
postgres, template0, template1 and the pre-existing testdb. pg_stat_activity
contained only the single maintenance verification connection; no fixture DB
or fixture backend remained. No forced cleanup was needed.

Local full logs are in the executing machine's temporary directory:
demo02a-final-build.log, demo02a-final-test-demo-02a.log,
demo02a-final-test-demo-session-infrastructure.log,
demo02a-final-test-demo-session-ownership-executor-isolation.log,
demo02a-final-test-demo-session-reset-recovery.log and
demo02a-final-test-milestone.log. They are not committed or CI results.

### Earlier development results and warnings

Before the implementation commit, the first build exited 1 on a TypeScript
generic inference error in the Dataset/Job detail route. An async callback fixed
the union result type. The first supplemental type check exited 1 on the test
environment override type; NodeJS.ProcessEnv fixed it.

The first PostgreSQL 02A run exited 1: 18 pass, 2 fail, zero skip/cancel/TODO
(one failed child plus its parent). Its core-mode negative test accidentally
retained APP_MODE=demo, correctly triggering the existing conflicting-mode guard.
The fixture now temporarily clears that environment value and restores it;
no production guard was relaxed. Normal owned teardown succeeded even on red.
The next expanded run passed 21/21, and the final expanded suite passed 23/23.
These earlier results are not after-fix regressions or substituted PASS evidence.

No runtime/build/deprecation warnings were found in the final verification logs.
Git staging emitted its normal local LF-to-CRLF conversion notices for six new
files; diff whitespace checks still passed. No architecture conflict was found.
Core lifecycle/First Run/dispatch/reconciliation, session allocation/collision
protection, Reset/coordinator and executor implementations remain unchanged.

## Limits and review

Development/test, single backend, no concurrent core/external writer, no public
production deployment guarantee. Fake execution state is still process-local.
No Scenario Runner/state/instance/API, expectedStep, requestId idempotency,
frontend, queues, real Airflow, distributed coordination or later Demo-02 work.
System Owner review is required; do not automatically merge.
