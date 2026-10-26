# Demo-02D — Failure and Retry Scenario

## Goal and baseline

Add only FAILURE_RETRY, using Demo-02C's existing ledger, request idempotency,
coordinator and transaction A / Domain / transaction B protocol. A failed financial
calculation is an expected teaching outcome, not a failed Scenario operation.
Retry creates a new Attempt, never a new Dataset Version or Job.

Branch feature/demo-02d-failure-retry-scenario starts from freshly fetched main
6427346baa1028cd6d8eec473b10241d2a4fd7e1, the merged Demo-02C PR #28. Demo-02A/B
are also merged. Authority: System Owner's Demo-02D specification, Architecture,
ADR-0008–0012 and Demo-02B/C. No new core architectural decision or ADR is needed;
this is the expressly specified second fixed flow within ADR-0012's protocol.

## API and nine-step workflow

POST /demo/scenarios accepts exactly {"scenarioType":"FAILURE_RETRY"} or the
existing HAPPY_PATH. New is 201 READY/0, same-type retry is 200 unchanged, and
another existing type is 409 DEMO_SCENARIO_TYPE_CONFLICT. UNIQUE(session_id)
remains. LOST_RESPONSE_RECOVERY and unknown types are still 400 INVALID_REQUEST.

Use the existing POST /demo/scenarios/:id/next with exactly expectedStep and
requestId UUID. FAILURE_RETRY accepts steps 1–9; HAPPY_PATH still accepts only
1–6. Out-of-range input is 400 INVALID_REQUEST, not a later operation. A valid
but skipped step, different request for a reserved step, or request reused for
another step returns 409 DEMO_SCENARIO_STEP_CONFLICT. Completed replay returns
its original stored response even after later Retry/publication.

| Step | Existing service / fake operation | Confirmed result |
|---|---|---|
| 1 | Create Dataset | Version 1 DRAFT, one guided PENDING Job |
| 2 | Run | Same Job RUNNING, Attempt 1 ACCEPTED, dataset BUILDING |
| 3 | Set own fake execution FAILED | External Attempt 1 FAILED; DB still RUNNING/ACCEPTED |
| 4 | Reconcile | Job FAILED, Attempt 1 FAILED; Scenario IN_PROGRESS/4 |
| 5 | Run/Retry | Same Job RUNNING, new Attempt 2 ACCEPTED |
| 6 | Set own fake execution SUCCEEDED | External Attempt 2 SUCCEEDED; DB still RUNNING/ACCEPTED |
| 7 | Reconcile | Job SUCCEEDED, Attempt 2 SUCCEEDED; Attempt 1 unchanged FAILED |
| 8 | Submit Validation | Same Dataset VALIDATING |
| 9 | Publish | Same Dataset PUBLISHED; Scenario COMPLETED/9 |

Steps 1–8 complete as IN_PROGRESS, not COMPLETED. Existing Domain services own
all financial status writes. Only steps 3/6 change external fake state through
its public API. There is no dataset-level FAILED, automatic reconciliation or
Scenario failure state. READY, IN_PROGRESS and COMPLETED retain their meanings.

From Step 2, FAILURE_RETRY stepResult includes attemptNumber plus executionAttemptId,
datasetVersionId, jobId, datasetBuildSnapshotId, resolvedDependencyDefinitionVersionId
and the relevant public statuses. Fake steps also identify externalStatus.
No full DB row, private previousAttemptHistory, dispatch diagnostic, token/hash
or executor command is returned. HAPPY_PATH response shape is unchanged; stored
old results are never rewritten. The server derives full DAG/run identity from
the bound durable Attempt, never from client input.

GET /demo/scenarios/:id/pending-step is unchanged: owned PostgreSQL-only read of
pending stepNumber/requestId or null. It never performs an operation. Same cookie,
Origin/CSRF, no-store, ownership, coordinator, queue and Reset rules apply. Manual
guided-domain/fake mutation HTTP routes remain blocked. Core registration and
other free-exploration sessions remain unchanged.

## Attempt binding and Retry recovery

All nine steps use CAPEX / authenticated company / 2026 / Q4 / version 1 and
DEMO_GUIDED_SUMMARY. Require exactly one version/job, the original immutable
snapshot and frozen published zero-dependency definition 1. Never query latest
upstreams or refresh definitions on Retry.

Step 5 transaction A verifies the Step 4 failure and freezes dataset/job IDs,
Attempt 1 ID, FAILED status, the complete terminal Attempt 1 row, expected new
attempt number 2, original snapshot and definition IDs. The private whole-row
history is an integrity witness, not a public DTO. No Attempt 2 UUID is guessed.
The existing core Run service allocates it. Result identifies the actual Attempt
2 UUID/number. Its full stable DAG/run identity must match the durable row and
core identity convention. Later intents bind that same row and full identity.

Attempt 2 must belong to the same Job, with a different UUID/run identity from
Attempt 1. Step 5–9 verify Attempt 1's complete saved terminal row is unchanged,
as well as the same snapshot/definition and correct Attempt number. Only one
planned Retry is supported; unexpected extra Attempts or mismatched bindings
return 409 DEMO_SCENARIO_STATE_CONFLICT without another Run.

Recovery first waits out earlier Domain writes under existing-order short
version/job/attempt locks and reads fresh durable state. Release those locks
BEFORE any Domain service or fake wait. If Attempt 2 is already ACCEPTED and the
Job RUNNING, only complete the ledger/progress; no redispatch or Attempt 3.
PREPARED/DISPATCHING reuses existing Run recovery with that same stable identity.
Unconfirmed dispatch stays PENDING/202 and Job FAILED; never claim success.
Definite REJECTED records the core DISPATCH_FAILED fact and returns
409 DEMO_SCENARIO_STATE_CONFLICT in this bounded Scenario. Its ledger remains
PENDING/diagnosable and Reset is required; subsequent Next never creates Attempt
3. ADR-0008's identity-wide irrevocable rejection semantics are unchanged.

Steps 3/6 recover an already matching external FAILED/SUCCEEDED state without
dispatch or fake recreation. Missing/contradictory external truth conflicts;
unavailability is 503 DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN. Steps 4/7 recover matching
durable terminal state without another executor lookup. Steps 8/9 recover exact
VALIDATING/PUBLISHED without repeating those lifecycle calls. Failure after a
Domain commit never rolls back or rewrites that financial fact.

## Transactions, concurrency and Reset

Reuse Demo-02C, not a second runner/ledger/queue:

1. A locks/revalidates session, owned Scenario and ledger, checks stored request
   BEFORE progress, freezes intent and commits PENDING.
2. Inspect/execute/recover through existing Domain services, with no open Scenario
   transaction or held Scenario locks across executor calls.
3. B revalidates identity/success/progress and commits ledger completion plus
   progress atomically. Step 9 also sets COMPLETED/9 in B.

Unknown A/B COMMIT destroys the suspect connection and confirms durable ledger
and progress from a separate bounded connection after acquiring root locks. No
guessed rollback or blind repeated Retry. Unresolved truth returns 503; confirmed
rollback permits same-request recovery. Original request/result ownership remains
durable, not an in-memory idempotency map.

The existing per-session coordinator serializes Next. PostgreSQL uniques, locks,
CAS and trigger checks remain backstops. Different sessions/fakes can proceed
independently. Next blocks Reset with existing busy semantics; an uncertain Reset
blocks further admission. Reset already deletes ledger, Scenario and the whole
owner graph, including BOTH Attempts, then revokes in one transaction. Confirmed
rollback restores everything and retains the same fake; unknown outcomes retain
blocking until durable confirmation. No cleanup/lock protocol changes are needed.
Inactive cleanup/startup invalidation remain unchanged; restart never recreates
fake execution from Scenario history.

## Forward migration and rollback

New migration: 1793000000000_demo-failure-retry-scenario.ts. No applied migration
is edited. Same ledger/FK/uniques/status/JSON checks remain. A broad 1–9 range
CHECK and generic completion-shape CHECK are paired with a type-aware trigger:

- HAPPY_PATH is strictly six steps / expected Attempt 1 and old success results.
- FAILURE_RETRY is nine steps, with FAILED at 4, Retry binding at 5 and Attempt 2
  thereafter. Step 5's predecessor must be Step 4's same FAILED Attempt/whole row.
- Owner/version/job/snapshot/definition and previous-step resource continuity
  remain checked. Full identity is validated when present; returned Attempt
  number is checked for Failure Retry. Ledger intent/completed history cannot
  be changed. Scenario ID/session/type cannot change once it has ledgers.

The original Demo-02C validator is retained under a rollback-only name. Supported
down refuses ANY retained FAILURE_RETRY Scenario, including READY with no ledger,
without deleting data or migration markers. When none remain, down restores the
exact original validator and six-step checks, preserving Happy Path rows. Up
also refuses any pre-02D non-Happy ledger rather than reinterpreting its history.
DDL locks and the migration transaction make these failures atomic. The extra
validator is necessary rollback compatibility, not an obsolete application path.

Existing tests target the same original Session/Scenario/ledger down migrations
one level further down and expect ten migrations. The old assertion rejecting
FAILURE_RETRY Create is superseded by new positive/conflict coverage; malformed
types and LOST_RESPONSE_RECOVERY are still rejected. No existing invariant or
milestone gate is weakened.

## Testing and verification

New scripts/demo-02d-failure-retry.pg.test.ts uses its own template0 PostgreSQL
database. It asserts current_database before fixture/seed writes, migrates the
accepted schema, closes actual clients, verifies zero backends and normally drops
only its validated owned database. No persistent developer DB is a test target.

Coverage A–O: nine steps and exact failed history; new stable Attempt 2 and same
frozen inputs; real progress failures at steps 3–9; A/B COMMIT loss/rollback/
unavailable confirmation; UNKNOWN/rejection with no Attempt 3; old result replay;
actual invalid constraint writes; supported down/up and unsafe atomic refusal;
deterministic same/different-ID and pending-order races; NOWAIT lock-release proof
during Retry dispatch; independent owner/fake execution; Reset rollback/unknown;
authentication, strict input, ownership, expiration and restart invalidation.
The original six-step Happy Path is tested before/after migration and by the
complete unchanged-behavior Demo-02C suite.

Required Windows commands (npm.cmd avoids PowerShell script policy):

```powershell
npm.cmd run build
npm.cmd run test:demo-02d
npm.cmd run test:demo-02c
npm.cmd run test:demo-02b
npm.cmd run test:demo-02a
npm.cmd run test:demo-session-infrastructure
npm.cmd run test:demo-session-ownership-executor-isolation
npm.cmd run test:demo-session-reset-recovery
npm.cmd run test:milestone
git diff --check
```

### Executed verification — 2026-10-26 (Asia/Taipei)

All final commands ran sequentially on clean implementation commit
7acaae07336aab4b04bf44570891cb4c7ae7a9cd, tree
c6c93efedbb431643bb06474d52198a8d7bd85e4. The subsequent evidence-only commits
update this document, not the tested code/migration/test sources. Environment:
Windows PowerShell; Node 24.18.0; npm 11.16.0; PostgreSQL 18.6
(Debian 18.6-1.pgdg13+2), using the existing Compose service.
docker compose up -d postgres_db exited 0.

| Exact command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |
| git diff 6427346..HEAD --check | 0 | n/a | n/a | n/a |

All cancellations/TODOs are zero. Counts include Node parent/nested entries, not
only individual assertions. Total: 163 Demo entries plus 246 milestone entries.
Supplemental strict test/migration type checking also exited 0:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-02d-failure-retry.pg.test.ts migrations/1793000000000_demo-failure-retry-scenario.ts
```

The unchanged milestone runner launched all 13 commands below. Each reported
PASS, exit 0, null signal/spawnError and no gate issues. Every test's fail, skip,
cancel and TODO counts are zero:

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
| npm run test:raw-ingestion (owned disposable PostgreSQL database) | 0 | 1 | 0 | 0 |
| npm run test:task-007d-end-to-end | 0 | 7 | 0 | 0 |

CON-01/CON-02 and E2E Flow A–F remain green. Raw ingestion used the isolated
launcher only, never a persistent developer database. No milestone child or gate
was changed or weakened.

All final Demo fixtures reached ten applied migrations and normally dropped
their owned databases after closing actual clients and checking zero backends:

| Suite | Owned database | Backends at teardown | Normal DROP |
|---|---|---:|---|
| 02D | demo_02d_test_26748_511eb22f8f7c | 0 | yes |
| 02C | demo_02c_test_38952_e8b9192136c6 | 0 | yes |
| 02B | demo_02b_test_36676_73e39eb6582c | 0 | yes |
| 02A | demo_02a_test_8328_8a63bea6aa06 | 0 | yes |
| 01A | demo_01a_test_29424_8d43ad15c0f6 | 0 | yes |
| 01B-1 | demo_01b1_test_23172_6134e84f0b6a | 0 | yes |
| 01B-2 | demo_01b2_test_23332_5d2656dabb47 | 0 | yes |

The unchanged isolated raw launcher reported owned teardown for
raw_milestone_test_33080_efa55bcf93c9. Its pre-existing cleanup uses DROP DATABASE
WITH (FORCE), as do several other existing core milestone fixtures. Those helpers
were not changed by Demo-02D; this report does not claim they use normal DROP or
that their FORCE clause terminated zero clients. The seven Demo suites above
separately prove zero backends and normal DROP without FORCE. After all gates, pg_database contained
only postgres, template0, template1 and pre-existing testdb. pg_stat_activity
showed only the audit connection to postgres, no fixture database/backend.
The new Demo-02D fixture needed no forced DROP, TRUNCATE, CASCADE, source-database
fixture write or repair.

Migration behavior was executed, not inferred: forward over a completed original
six-step Scenario preserved every row; supported down restored the exact original
02C validator and data; forward again succeeded; unsupported pre-02D non-Happy
ledger migration and retained Failure Retry down both failed atomically with
unchanged data/markers. Existing Session/Scenario/ledger down assertions still
target and verify their original guards under the additional migration.

Before-final development results are separate from this clean-revision evidence:
the first Demo-02D suite exited 0 (23 pass), expanded with the settled Attempt 2
writer and queued-expiration tests it exited 0 (25 pass). Preliminary Demo-02C
and 02B reruns exited 0 (27/26 pass); build and strict type checks exited 0.
There were no red Demo-02D runs to relabel as PASS. Intentionally injected SQL,
dispatch, commit-transport and reset failures are asserted test cases, not suite
failures. All owned development fixtures were normally dropped too.

Final runtime/build logs contain no warnings/deprecations. Git emitted local
LF-to-CRLF staging notices; whitespace checks passed. The remote still uses the
repository's former name and may report its normal rename redirect on push; this
is not a test warning or a change to the configured remote.

Local execution logs (not GitHub CI evidence) are in the executing machine's
temporary directory: demo02d-final-build.log, demo02d-final-test-demo-02d.log,
demo02d-final-test-demo-02c.log, demo02d-final-test-demo-02b.log,
demo02d-final-test-demo-02a.log, demo02d-final-test-demo-session-infrastructure.log,
demo02d-final-test-demo-session-ownership-executor-isolation.log,
demo02d-final-test-demo-session-reset-recovery.log and
demo02d-final-test-milestone.log. Raw logs/credentials are not committed.

The complete diff was reviewed. No accepted architecture conflict was found.
Only the new forward migration is added; all nine historical migrations are
unchanged. Core Run/Retry/preparation/reconciliation/dataset/executor code,
02A seed, session security/coordinator/Reset implementation and raw ingestion
have no diff. The existing runner's A/B/unknown-commit architecture is reused.
No Demo-02E or other non-goal implementation is included.

## Limits and review

Single Demo backend, no concurrent core/external/config writer, development/test
only. Fake state is process-local; old sessions are invalid after restart. No
public deployment or distributed durability guarantee. Raw ingestion, shared
configuration, core state machines, immutable snapshot rules, core lock ordering,
executor contract, session security and applied migrations remain unchanged.
No LOST_RESPONSE_RECOVERY/02E, frontend, deployment, worker, real Airflow, queues,
distributed coordinator or financial logic is implemented. System Owner must
review the PR; no automatic approval or merge.
