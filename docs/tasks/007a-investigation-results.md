# Task 007A — Investigation results

Recorded: 2026-10-12 (Asia/Taipei). Status: **investigation complete; owner review pending; do not merge**.

Branch: `feature/task-007a-concurrency-investigation`.
Verified branch point / unchanged production baseline: `85479c723090de8dc96cdb0a13472f3156b5e8f9`.
Executed investigation harness commit: `de6ec98bd731d41e41b95d5267f28fbcdf12a5c1`.
Harness Git blob: `d372e7b152f45849488337f442c9ae105c90c152`.
The subsequent evidence/documentation commit does not change that harness or production code.

Authoritative Task 007/007A documents were read from `origin/architecture/task-007-milestone-hardening`; that branch was neither merged nor cherry-picked. Accepted Tasks 002–006 and ADRs remain unchanged. Task 007B is not authorized by this report.

## Evidence boundary and reproduction

[Machine-readable runtime evidence](007a-investigation-evidence.json) contains exact A/B HTTP status, JSON bodies, public error codes, IDs, pre/intermediate/final PostgreSQL states, frozen definition pins/upstreams, external processing results, response-release events, recovery requests, and per-scenario classifications. These are executed observations, not hypothetical test outcomes. Random UUIDs and timestamps vary on rerun.

Runtime: Node.js `v24.18.0`; PostgreSQL `18.6` (Debian `18.6-1.pgdg13+2`, x86_64).

Database setup: the repository Compose PostgreSQL service; credentials come from `TEST_DATABASE_URL` or `DATABASE_URL` and are never printed. The connection must permit `CREATE DATABASE`. Each investigation run creates one uniquely named, validated `cross_workflow_test_*` database from `template0`, applies all six checked-in migrations in one transaction, verifies the v2 migration marker, and drops only that owned database in `finally`. Fixtures truncate only this disposable database, not the configured application database.

CAPEX v1 is completed/published through HTTP using a fixture-only FakeExecutor. DPR is created through HTTP with two jobs (TABLE_X requires CAPEX; TABLE_Y has an explicit zero-dependency definition). The controlled investigation executor is a separate instance; its external counts refer only to the investigated DPR executions, not the already-completed fixture execution.

Each scenario begins with DPR `DRAFT`, jobs `PENDING`, no snapshot and no attempt. First Run freezes one snapshot, both definition IDs and CAPEX v1; then the selected job is `PENDING`, attempt 1 `DISPATCHING`, dataset `BUILDING`. Both concurrent Run requests use the identical full dispatch command. Definition and upstream pins remain unchanged through every observed race/recovery.

Reproduce:

```text
git fetch origin
git switch --track origin/feature/task-007a-concurrency-investigation
docker compose up -d
npm.cmd run build
npm.cmd run test:cross-workflow-concurrency-investigation
```

If the local tracking branch already exists, switch to that branch without creating another one. The investigation command is deliberately red until owner-approved remediation; it does not skip/TODO cases or assert HTTP 500 as correct behavior. Watchdog timeouts only detect stalled tests; no sleeps establish event ordering. All response barriers and database gates have `try/finally` cleanup, including late-starting dispatches.

## Confirmed runtime observations

Here A is the original Run and B is reconciliation for CON-01, or the second Run for CON-02. Table states/counts are **before recovery probes**, whose results follow below. Full successful/error bodies are in the JSON evidence.

| Scenario ID | External processing / local recording order | A / B HTTP | Original attempt / selected job | External runs | Classification |
|---|---|---|---|---:|---|
| CON-01-RECONCILE_FIRST | Fake ACCEPT held; external SUCCEEDED; B commit verified; A released | 500 INTERNAL_SERVER_ERROR / 200 SUCCEEDED | SUCCEEDED / SUCCEEDED | 1 SUCCEEDED | BACKEND CONCURRENCY DEFECT |
| CON-01-DISPATCH_FIRST | A acceptance committed; external SUCCEEDED; B reconciles | 200 ACCEPTED / 200 SUCCEEDED | SUCCEEDED / SUCCEEDED | 1 SUCCEEDED | SUPPORTED / SAFELY HANDLED |
| CON-02-FAKE-REJECTED_FIRST | Fake processes REJECT at zero runs, then ACCEPT of X; A records before B | 502 EXECUTOR_DISPATCH_FAILED / 500 INTERNAL_SERVER_ERROR | DISPATCH_FAILED / PENDING | 1 RUNNING | BACKEND CONCURRENCY DEFECT against existing FakeExecutor behavior; contract checkpoint below |
| CON-02-FAKE-ACCEPTED_FIRST | Same external REJECT→ACCEPT; B records before A | 200 ACCEPTED / 200 ACCEPTED | ACCEPTED / RUNNING | 1 RUNNING | SUPPORTED / SAFELY HANDLED |
| CON-02-INVALID-REJECTED_FIRST | Wrapper lies: actual Fake ACCEPT→ALREADY_EXISTS, reported REJECT→ALREADY_EXISTS; A records first | 502 / 500 | DISPATCH_FAILED / PENDING | 1 RUNNING | EXECUTOR CONTRACT VIOLATION |
| CON-02-INVALID-ACCEPTED_FIRST | Same intentionally invalid external responses; B records first | 200 / 200 | ACCEPTED / RUNNING | 1 RUNNING | EXECUTOR CONTRACT VIOLATION |
| CON-02-EXISTS-0 | Fake ACCEPT creates X; next dispatch gets ALREADY_EXISTS despite queued REJECT; A records first | 200 / 200 | ACCEPTED / RUNNING | 1 RUNNING | SUPPORTED / SAFELY HANDLED |
| CON-02-EXISTS-1 | Same external processing; B records first | 200 / 200 | ACCEPTED / RUNNING | 1 RUNNING | SUPPORTED / SAFELY HANDLED |
| CON-LOCKS | Held attempt gate separately blocks outcome recording and reconciliation | 200 ACCEPTED / 200 SUCCEEDED | SUCCEEDED / SUCCEEDED | 1 SUCCEEDED | SUPPORTED / SAFELY HANDLED |

All original outcomes retain one attempt with unchanged UUID, attempt number 1, DAG ID and stable run ID; dataset remains `BUILDING`; exactly one immutable build snapshot exists. CON-01 late recording does not rewrite terminal timestamps or any durable state after B's verified commit.

### CON-01: cause, correctness and review proposal

HTTP 500 was reproduced repeatedly with the valid unmodified FakeExecutor result, delayed only by a Promise barrier. The generic body is exactly:

```json
{"message":"Internal Server Error","code":"INTERNAL_SERVER_ERROR"}
```

Root cause: `recordDispatchOutcome` in `src/modules/calculation-job-run.service.ts:408` first handles ACCEPTED/RUNNING idempotently, then the acceptance branch at line 440 requires DISPATCHING plus PENDING/FAILED. Reconciliation has already changed the locked pair to SUCCEEDED/SUCCEEDED; the branch at line 446 throws `CalculationStateInvariantError` instead of recognizing a valid overtaking terminal fact. This branch explanation is static code analysis matched to the executed state and HTTP evidence; the internal error is not leaked by the API.

Durable correctness: intact. API correctness: false internal failure for a valid successful execution. Suggested severity: medium (misleading client outcome/retry behavior; no terminal history corruption observed).

Task 007B is recommended **after owner approval**. Review proposal only: a late accepted response for the same verified identity should return a successful, durable-state-consistent response without another attempt or terminal regression. The red regression currently proposes HTTP 200. The exact terminal Run DTO and any required bounded response-type adjustment are **not accepted or implemented here**; existing Task-004 Run typing assumes ACCEPTED/RUNNING. Owner review must settle that contract before implementation.

### CON-02: contract interpretation and recovery

Actual FakeExecutor processing confirms:

1. REJECT can legitimately return before any run exists, without creating X.
2. A subsequent overlapping dispatch of X can create it and return ACCEPTED; no rejection tombstone exists.
3. If X already exists at processing time, the identity lookup returns ALREADY_EXISTS before the queued REJECT behavior is consumed.
4. Therefore external processing order matters: REJECT→ACCEPT differs from ACCEPT→ALREADY_EXISTS.
5. Holding these unchanged results fixed, backend recording order also matters: rejection-first strands X; acceptance-first is safely handled by the existing ACCEPTED/RUNNING idempotency branch.

The valid wrapper does not invent responses or alter FakeExecutor processing. Its delay models response latency. The deliberately invalid wrapper is separate: it creates X and immediately substitutes a definite no-run REJECTED result while X already exists. That is an unambiguous executor contract violation and is **not** used as the proof of a supported backend race. Passing invalid-fixture tests prove the fixture violates the contract, not that its backend failure is correct.

Root cause in the Fake rejection-first case: A commits DISPATCH_FAILED. B's delayed confirmed acceptance then fails the same DISPATCHING guard at line 440. The old attempt cannot be reconciled: manual selection excludes DISPATCH_FAILED (`calculation-job-reconciliation.repository.ts:36`), and the identity-based reconciliation guard also rejects that status (`calculation-job-reconciliation.service.ts:333`).

Executed recovery results for CON-02-FAKE-REJECTED_FIRST:

- Manual `/reconcile`: 409 `EXECUTION_NOT_RECONCILABLE`; no change to X.
- Callback carrying X's same DAG/run identity: the same 409, before and after retry.
- Another `/run`: 200, but allocates attempt 2 with a **different** run identity. The fake creates a second external execution for the same logical job. Both external runs are RUNNING; original attempt 1 remains DISPATCH_FAILED, new attempt 2 ACCEPTED, job RUNNING.
- Subsequent manual reconciliation selects attempt 2 and returns 200 RUNNING; it does not recover X.
- Snapshot and frozen pins still remain unchanged. This is not safe same-identity recovery.

Acceptance-first recovery calls return 200 and retain one attempt / one external run with the same identity. In the intentionally invalid rejection-first fixture, retry instead consumes its leftover scripted REJECT: attempt 2 also becomes DISPATCH_FAILED (HTTP 502), one external X still exists, and reconciliation remains 409. This invalid-fixture result is recorded separately, not generalized to normal adapters.

Suggested severity: high for the existing Fake-compatible sequence (external/local truth split and duplicate execution on retry).

**Architecture/contract checkpoint requiring System Owner review:** ADR-0005 requires definite rejection with certainty of no execution. It does not specify whether that certainty is scoped to one processed request or is a permanent identity-wide guarantee covering overlapping/later dispatches. The existing FakeExecutor implements the former. The result is conclusively a failure under current Fake-compatible operation; claiming that every future Airflow adapter permits this sequence would be an unsupported inference. Decide the executor guarantee and bounded 007B scope before remediation. No acceptance-vs-rejection precedence, attempt-history rewrite, or new dispatch policy is proposed as an accepted rule here.

## Transaction/lock evidence

While response barriers hold A (and B where applicable) inside dispatch, a separate connection successfully obtains dataset, job and attempt `FOR UPDATE NOWAIT` locks. `pg_stat_activity` reports zero other idle-in-transaction connections in the owned test database.

CON-LOCKS separately holds the attempt row, observes the outcome-recording/reconciliation backend waiting for that row through `pg_blocking_pids`, then attempts NOWAIT on the job. It receives SQLSTATE `55P03`, proving that each blocked mutation already holds the job lock before waiting for the attempt. Gates are rolled back/released before either HTTP request completes. No production transaction boundary or lock order was changed.

## Verification commands and results

Counts below are Node's reported totals, including enclosing test/file entries where present.

| Exact command | Exit | Pass / fail / skip | Result |
|---|---:|---|---|
| `node --version` | 0 | n/a | v24.18.0 |
| `docker compose up -d` | 0 | n/a | Repository PostgreSQL service started |
| `npm.cmd run build` | 0 | n/a | Passed, including after harness commit |
| `npm.cmd run test:cross-workflow-concurrency-investigation` | 1 | 7 / 3 / 0 | Two red scenario regressions plus their failing parent; 9 scenario cases executed; repeated reproductions agree |
| `npm.cmd run test:execution-attempt-dispatch-fake-executor` | 0 | 11 / 0 / 0 | Unchanged Task 004 suite passed |
| `npm.cmd run test:executor-reconciliation` | 0 | 22 / 0 / 0 | Unchanged Task 005 suite passed |
| `npm.cmd run test:dataset-version-terminal-lifecycle` (initial parallel run) | 1 | 64 / 1 / 0 | All scenario assertions passed; file failed on post-test asynchronous connection error |
| `npm.cmd run test:dataset-version-terminal-lifecycle` (independent rerun) | 0 | 64 / 0 / 0 | Passed |
| `npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/cross-workflow-concurrency-investigation.pg.test.ts` | 0 | n/a | Investigation test source also type-checks; normal build covers src only |
| `git diff --check` | 0 | n/a | Passed |

The initial parallel Task 006 error was `terminating connection due to administrator command`, reported as asynchronous activity after the 20-request Submit Validation test ended. Its independent rerun was green. This is an additional **INCONCLUSIVE / BLOCKED** teardown-flakiness observation, not a confirmed production defect or an excuse to hide the failed run. No existing test/teardown implementation was changed. An initial optional standalone type-check without `--ignoreConfig` returned TS5112/exit 1; the corrected command above passed.

No shared test helpers were modified; other suites were not required by the conditional helper-change gate. All executed PostgreSQL suites use their existing isolated migration setup. There are no skips, TODOs or cancelled investigation cases.

## Delivery and stop boundary

Changes are limited to the dedicated test suite, its npm script, this report and the captured JSON evidence. No production source, router, repository, FakeExecutor, state machine, schema, migration, snapshot logic or API contract was modified. No real Airflow, cancellation, worker, queue, cleanup package, or Task 007B–E implementation was added.

System Owner approval is pending for classifications/severity, the CON-01 response contract and CON-02 contract timing/guarantees. Keep the red branch unmerged. Investigation results recommend considering bounded 007B work, but do not authorize it.
