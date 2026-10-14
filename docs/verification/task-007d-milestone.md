# Task 007D — Milestone Verification Report

**Status: BLOCKED / NOT VERIFIED.** This report records implementation inventory and the actual verification environment. It does **not** claim a PostgreSQL suite passed.

## Revisions and review gate

| Item | Value |
|---|---|
| Main baseline verified from GitHub | `58dd1b79ea4eb5cb3891e14c8111ba49c984f6c1` |
| Feature branch | `feature/task-007d-e2e-verification-gate` |
| Prepared test/runner source commit (not executed) | `f6d3061cadac618b37902e95da5c7da323e21cfa` |
| Runtime-tested Git revision / tree | **NONE — NOT RUN** |
| Report commit | Documentation-only descendant; **not** a tested revision |
| Owner review | Pending |
| Merged into main | No |

The integrated test code and milestone runner are committed but have **not** been executed in this environment. A future verified run must update this report with the **exact** tested Git SHA/tree before approval; do not infer proof from these unchecked test assertions.

## Runtime and connection evidence

| Parameter | Observation |
|---|---|
| Current assistant environment Node.js | `v22.16.0`; repository README requires Node.js 24+ |
| Current assistant environment npm | `10.9.2` |
| PostgreSQL server version | **NOT AVAILABLE** |
| PostgreSQL test service URL | **NOT AVAILABLE** |
| Database topology | Intended: `TEST_DATABASE_URL` or `DATABASE_URL` points to PostgreSQL test host; scripts connect to the maintenance `postgres` database and create independent owned temporary databases |
| Database permissions required | `CREATE DATABASE`, `DROP DATABASE` on the test PostgreSQL service; migration DDL privileges within each owned temporary database |
| Environment limitations | No repository checkout in the command environment; github.com DNS resolution failed; no PostgreSQL CLI/server or test DB connection; project Node dependencies unavailable |
| Network check actually executed | `git ls-remote https://github.com/good74152/cost-engine-orchestration-platform.git HEAD` → exit `128`, DNS resolution failure |
| Schema migrations modified in Task 007D | None |
| Destructive operation on developer DB | None |

The GitHub connector allowed branch creation, source inspection, and commits; it is **not** an execution environment and cannot substantiate a test PASS.

## Designed E2E coverage (each case NOT RUN)

| Flow | Checked-in assertions | Runtime result |
|---|---|---|
| A — CAPEX → DPR | Public CAPEX v1 publication; DPR v1 two jobs; immutable shared snapshot; both pinned definition versions; CAPEX v1 frozen; terminal timestamps; explicit validation/publication; latest published SQL | **NOT RUN** |
| B — Failure and retry | Failed attempt 1 remains historically immutable; attempt 2 new identity and run ID; snapshot/dependencies/definitions preserved; final publication | **NOT RUN** |
| C — Lost dispatch response | `ACCEPT_THEN_UNKNOWN`, HTTP 202, durable DISPATCHING, one external identity, reconciliation to SUCCEEDED, no extra attempt | **NOT RUN** |
| D — Reject and next version | Published v1, rejected v2, new DRAFT v3 with monotonic version; latest published remains v1; rejected snapshot preserved | **NOT RUN** |
| E — Abandonment | DRAFT success; BUILDING after failed attempt success; ACCEPTED and barrier-controlled DISPATCHING return 409; no mutation after conflict | **NOT RUN** |
| F — Late callback | VALIDATING and repeated PUBLISHED callbacks trigger executor lookup; no terminal history/snapshot/timestamp rewrite | **NOT RUN** |

**PREPARED boundary:** The public `/run` route prepares and moves an attempt into DISPATCHING before its external call. There is no supported public API to leave a committed PREPARED attempt for an E2E assertion. The existing dataset terminal lifecycle PostgreSQL regression exercises the PREPARED guard using test-only preparation-service setup. This new E2E test does **not** claim to exercise PREPARED, and its specialized regression is still NOT RUN in the present environment.

## Milestone runner and isolation

Command: `npm run test:milestone`. Its script `scripts/task-007d-milestone-runner.ts` invokes suites one after another in separate processes, in the exact order below. Failure stops progression and marks later suites **NOT RUN**. TAP totals and exit codes are emitted as structured `MILESTONE_RESULT` and `MILESTONE_SUMMARY` lines; capture these results and actual PostgreSQL versions before editing this report to indicate success.

All regular PostgreSQL suites are designed to create independently named, migrated databases. The existing `test:raw-ingestion` is different: it uses the configured DB directly, so the milestone runner never calls it without `scripts/support/task-007d-isolated-raw-ingestion.ts`. That wrapper creates and migrates an owned `raw_milestone_test_*` database, passes only the owned database URL to the raw-ingestion test child process, waits for exit, closes the maintenance connection, and drops **only** its strictly validated owned database in `finally`. Child-scoped environment settings do not rewrite the user's parent `DATABASE_URL`.

The new Task 007D E2E suite creates/migrates an independent `task_007d_e2e_*` database, closes the Fastify application and PostgreSQL pool, and drops only its own validated database in `finally`. E2E SQL seeds configuration and reads durable state; dataset/job/attempt lifecycle status changes use public HTTP routes rather than direct SQL.

**Database teardown actual result:** NOT RUN; no temporary database was created in this environment.

## Mandatory command-by-command evidence

No command below has been run against this branch in a PostgreSQL-capable checkout. Therefore no exit code or TAP pass/fail/skip counts exist. A dash is an unavailable observation, **not zero tests and not a PASS**.

| Command | Exit code | Pass | Fail | Skip | Status |
|---|---:|---:|---:|---:|---|
| `npm run build` | — | — | — | — | NOT RUN |
| `npm run test:orchestration-schema-v2` | — | — | — | — | NOT RUN |
| `npm run test:dataset-version-creation-v2` | — | — | — | — | NOT RUN |
| `npm run test:first-run-immutable-build-snapshot` | — | — | — | — | NOT RUN |
| `npm run test:execution-attempt-dispatch-fake-executor` | — | — | — | — | NOT RUN |
| `npm run test:executor-reconciliation` | — | — | — | — | NOT RUN |
| `npm run test:dataset-version-terminal-lifecycle` | — | — | — | — | NOT RUN |
| `npm run test:cross-workflow-concurrency-investigation` | — | — | — | — | NOT RUN |
| `npm run test:task-007b1-late-dispatch-reconciliation` | — | — | — | — | NOT RUN |
| `npm run test:task-007c-api-contract` | — | — | — | — | NOT RUN |
| `npm run test:raw-ingestion` (isolated launcher) | — | — | — | — | NOT RUN |
| `npm run test:task-007d-end-to-end` | — | — | — | — | NOT RUN |
| **`npm run test:milestone`** | **—** | — | — | — | **NOT RUN** |
| `git diff --check` | — | — | — | — | NOT RUN — local Git checkout unavailable |

### Existing regression gate

- **CON-01 late ACCEPTED after terminal reconciliation:** NOT RUN this iteration. Checked-in assertions are included through both concurrency suites.
- **CON-02 permanent same-identity rejection / FakeExecutor tombstone:** NOT RUN this iteration. The dishonest adapter fixture remains isolated as an intentional contract violation.
- **Task 007C HTTP request validation / NUL / 400-413-415:** NOT RUN this iteration.
- **Migration up/down, rollback guard, constraints, indexes:** NOT RUN this iteration; runner includes `test:orchestration-schema-v2` first after build.
- **Raw-ingestion 20-way concurrency:** NOT RUN this iteration; isolated launcher designed, not yet demonstrated.
- **Unexpected skips:** Unknown — no TAP output.
- **Warnings:** Runtime dependencies and PostgreSQL unavailable; Node 22 is below documented Node 24+ requirement.
- **Teardown failures:** None observed because tests were not launched; success also unverified.

## Acceptance and next action

The System Owner should review the proposed test code, raw launcher safety, and runner fail-fast behavior before approving any merge. **Task 007D milestone is not verified.** Execute `npm run test:milestone` on Node.js 24+ with a disposable PostgreSQL-capable test service and `CREATE DATABASE` privileges. Capture the complete TAP, `MILESTONE_SUMMARY`, actual Git revision/tree and `git diff --check`; update this document with exact exit codes, suite pass/fail/skip counts, runtime versions, E2E A–F evidence, and teardown outcomes.

If tests expose a production defect, stop and open a bounded follow-up; do not silently modify production lifecycle code. Task 007E remains blocked.
