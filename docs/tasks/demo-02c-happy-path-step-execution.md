# Demo-02C — Happy Path Step-by-Step Execution

## Goal and baseline

Execute only HAPPY_PATH through six explicit Next requests. A Domain operation
that committed before progress failed must be recoverable without repeating its
business effect. Authority: System Owner's Demo-02C specification, AGENTS.md,
Architecture and ADR-0009–0012. No accepted core protocol is redesigned.

Branch: feature/demo-02c-happy-path-execution, created from freshly fetched main
876d03008ec4efd4d21342eda609b494398cf4d0 (PR #27 merge). PR #26 and #27 are merged.

## APIs and security

Demo only, with existing HttpOnly cookie, Origin/CSRF policy, no-store, ownership
and per-session coordinator. POST /demo/scenarios/:id/next accepts exactly:

```json
{"expectedStep":2,"requestId":"550e8400-e29b-41d4-a716-446655440000"}
```

expectedStep must be integer 1–6; requestId must be a UUID (canonicalized to
lowercase). No client session/company/dataset/job/attempt/executor selector.
Success 200 returns scenarioId, stepNumber, requestId, stepStatus=COMPLETED,
completedStep, scenarioStatus and an explicit stepResult. Result includes only
dataset/job IDs and statuses, plus bound attempt/snapshot/definition UUIDs when
applicable; Step 3 also includes externalStatus=SUCCEEDED. No raw DB rows or
executor commands. COMPLETED replay returns the original stored response, not
today's Scenario status. Existing Scenario GET DTOs remain unchanged.

Unconfirmed dispatch returns 202, stepStatus=PENDING, prior completedStep and
the same attempt identity/status. GET /demo/scenarios/:id/pending-step returns
only {pendingStep:{stepNumber,requestId}} or {pendingStep:null}. It uses one
owned-parent PostgreSQL snapshot, makes no writes and never consults the fake.
Manual guided-domain/fake writes remain blocked; free sessions remain usable.

| HTTP | Code / meaning |
|---|---|
| 400 | INVALID_REQUEST: body, query, UUID request or step range invalid (including step 7) |
| 401 | DEMO_SESSION_UNAVAILABLE: invalid/expired/revoked cookie; clear actual cookie |
| 403 | DEMO_SESSION_CSRF_REJECTED: missing mutation header or cross-origin request |
| 404 | DEMO_RESOURCE_UNAVAILABLE: missing/invalid/foreign Scenario, without disclosure |
| 409 | DEMO_SCENARIO_STEP_CONFLICT: wrong order, different ID for reserved step or ID reused on another step |
| 409 | DEMO_SCENARIO_STATE_CONFLICT: inconsistent guided progress, resource set, frozen identity or non-Happy-Path outcome |
| 409 | DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE: initial intent requires compatible 02A configuration |
| 409 | RESET_CONFLICT: Reset has reserved the session |
| 429 | DEMO_SESSION_QUEUE_FULL: existing bounded admission capacity reached |
| 503 | DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN: unconfirmed commit, unavailable executor truth or unsettled recovery read; retry same request |
| 503 | DEMO_RESET_OUTCOME_UNKNOWN: existing uncertain Reset reservation |
| 500 | Sanitized INTERNAL_SERVER_ERROR for unexpected PostgreSQL/system failure |

Expected errors retain the flat message/code envelope. Do not expose SQL,
credentials, hashes, internal intent or dispatch diagnostic text. A definite
dispatch failure remains PENDING in the ledger and requires Reset for this Happy
Path; repeated requests do not create a second attempt. No FAILURE_RETRY runner.

## Step ledger and bindings

New forward migration 1792900000000_demo-scenario-step-executions.ts adds UUID
id, scenario_id FK RESTRICT, step_number 1–6, request_id UUID, PENDING/COMPLETED,
JSONB intent/result and creation/completion timestamps. Uniques cover
(scenario_id,step_number) and (scenario_id,request_id). Pending has no completion
result/time; completed requires the correct response envelope and step-specific
success result/time. A trigger verifies canonical ownership, previous-step
resource continuity, attempt/job/snapshot/frozen-definition relationships and
full external identity when present. Intent and completed history are immutable.
The existing Scenario/step index serves bounded reads (at most six rows).

Down takes ACCESS EXCLUSIVE and refuses retained ledgers. Empty down drops only
this table/function. Existing migrations and core constraints are unchanged.
Existing regression rollback fixtures target their original tables one migration
further down; none of their rollback assertions or guards are weakened.

## Durable boundaries and concurrency

Within the existing queue:

1. Transaction A: lock/revalidate session, lock owned Scenario/ledgers, find
   matching ledger FIRST, validate request and progress, freeze intent, insert
   PENDING, commit. Same completed request returns stored original response.
2. Release Scenario locks. Briefly wait for earlier Domain writes to settle,
   inspect fresh exact durable state, release those locks too. Call existing
   Domain service only if needed. No Scenario transaction encloses a service or
   executor call. Database state, not a global idempotency map, is recovery truth.
3. Transaction B: same Scenario protocol; recheck success/binding and progress,
   atomically update ledger plus Scenario. Step 6 also sets COMPLETED/6.

An ambiguous A/B COMMIT destroys its suspect pooled connection. A separate
bounded Client waits for the durable session/Scenario locks, then reads fresh
ledger/progress. A confirmation can permit the reserved operation or return its
original completed result. Confirmed B rollback returns retryable 503, leaving
PENDING; next same-request call inspects Domain truth before filling progress.
Unavailable confirmation remains 503; never infer rollback from a socket error.
No executor call occurs in confirmation. No distributed/second queue is added.

Different sessions proceed independently. Reset conflicts while Next/reads are
active or queued. Same-request duplicates converge; another request cannot take
over, skip a pending step or rerun a completed step. Database unique constraints,
locks and progress CAS remain correctness backstops beyond queue ordering.

## Six-step execution and recovery

| Step | Domain/external operation | Proof and recovery |
|---|---|---|
| 1 | createDatasetVersionService | Freeze CAPEX, authenticated company, 2026, Q4, expected version 1 and DEMO_GUIDED_SUMMARY before creation. Query exact canonical series, not latest version. Require counter 1, exactly version 1 DRAFT and one matching PENDING job; no snapshot/attempt. Existing partial/other-version graph conflicts, never allocate v2. |
| 2 | runCalculationJobService with session fake | Require the same job/dataset, BUILDING, one zero-upstream snapshot, published frozen definition 1 and exactly attempt 1. RUNNING/ACCEPTED fills progress without redispatch. PREPARED/DISPATCHING reuse the core stable identity. UNKNOWN stays PENDING/202; rejection/contradiction cannot allocate another attempt. |
| 3 | owning FakeExecutor public status/set API | Freeze Step 2's attempt/snapshot/definition and full DAG/run identity. Only RUNNING may be set SUCCEEDED; already SUCCEEDED recovers. Verify external success while DB is still RUNNING/ACCEPTED. Missing/FAILED execution conflicts; unavailable truth is 503. Never create a fake run here. |
| 4 | reconcileCalculationJobService | Require Step 2's attempt. Durable SUCCEEDED job/attempt fills progress without another lookup. Otherwise reconcile same identity; unavailable truth leaves DB/progress unchanged. |
| 5 | submitDatasetValidationService | Require completed Step 4 and same succeeded graph. Already VALIDATING fills progress without another lifecycle call. |
| 6 | publishDatasetVersionService | Require completed Step 5 and same succeeded graph. Already PUBLISHED fills ledger plus COMPLETED/6 atomically, without republishing. Replay returns stored Step 6 result. |

Domain and ledger are deliberately not one transaction. Successful financial
history survives a later Scenario transaction failure. Resources are selected by
durable bindings, never a caller-selected ID or a new latest upstream query.

## Reset, restart and limits

Existing Reset transaction now deletes ledger, Scenario, owned domain graph,
then revokes. Later failures roll everything back and preserve the same fake.
Unknown recovery explicitly includes remaining ledger and Scenario/graph data;
FK RESTRICT additionally prevents orphan ledgers. Release fake only after
confirmed cleanup. Inactive cleanup uses the same path; no worker is added.
Startup invalidates old cookies. A new session cannot recover old requests or
resurrect fake runs from persisted progress.

Single Demo backend; no concurrent core/external/config writer, public production
deployment, multi-instance/distributed guarantee or cross-process fake durability.
No frontend, other Scenario type, new financial logic, real Airflow, background
reconciliation, reset redesign or core lifecycle/lock/executor changes.

## PostgreSQL verification

scripts/demo-02c-happy-path.pg.test.ts owns a template0 disposable database and
applies all nine migrations. It checks current_database before any fixture/seed
write, closes actual clients, checks zero remaining backends and normally drops
only that named database. No persistent database is an authorized test target.

Tests cover specification A–T: six steps; ordering/replay; real A and all six B
failures; lost A/B COMMIT and unavailable confirmation; UNKNOWN stable-identity
recovery; rejected/contradictory graphs; deterministic same/different request
barriers and different owners; NOWAIT proof of released session/Scenario/ledger/
job/attempt locks during dispatch; pending reads; security/error contracts;
Reset rollback/unknown retained-ledger safety and inactive/restart cleanup.

Required commands (Windows uses npm.cmd):

```bash
npm run build
npm run test:demo-02c
npm run test:demo-02b
npm run test:demo-02a
npm run test:demo-session-infrastructure
npm run test:demo-session-ownership-executor-isolation
npm run test:demo-session-reset-recovery
npm run test:milestone
git diff --check
```

### Executed verification — 2026-10-25 (Asia/Taipei)

All final commands ran sequentially on clean implementation commit
89e59216ec97b0d53c70fa4e3bbaae8a30f4dba2, tree
a54be102e74599a647071ea78e38ec443a769689. The following evidence-only commit
changes this document, not the tested implementation/migration/test sources.
Windows PowerShell; Node 24.18.0; npm 11.16.0; Compose PostgreSQL 18.6
(Debian 18.6-1.pgdg13+2). docker compose up -d postgres_db exited 0.

| Exact command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |
| git diff 876d030..HEAD --check | 0 | n/a | n/a | n/a |

All cancellations and TODOs are zero. Counts include Node parent/nested entries,
not just individual assertions. Total: 138 Demo entries plus 246 milestone entries.
Supplemental strict type checking of the new test and migration exited 0:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-02c-happy-path.pg.test.ts migrations/1792900000000_demo-scenario-step-executions.ts
```

The unchanged milestone launched these commands. Each test had zero fail, skip,
cancel and TODO; every child had null signal/spawnError and no gate issues:

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

All 13 milestone commands PASS. CON-01/CON-02 and E2E Flow A–F are green.
Raw ingestion used only the isolated launcher. No milestone gate was weakened.

Final Demo fixture teardown (each applied all nine migrations):

| Suite | Owned DB | Final backends | Normal DROP |
|---|---|---:|---|
| 02C | demo_02c_test_17956_80fbb99c6672 | 0 | yes |
| 02B | demo_02b_test_38784_1507116447b9 | 0 | yes |
| 02A | demo_02a_test_9068_b213026134f0 | 0 | yes |
| 01A | demo_01a_test_36100_54d676c11717 | 0 | yes |
| 01B-1 | demo_01b1_test_28964_171446bbf99f | 0 | yes |
| 01B-2 | demo_01b2_test_256_932923e960e1 | 0 | yes |

After every gate completed, pg_database contained only postgres, template0,
template1 and the pre-existing testdb. pg_stat_activity contained only the audit
connection to postgres. No fixture database/backend remained. Final verification
needed no forced cleanup, TRUNCATE or CASCADE. Empty ledger down/up, preservation
of a pre-ledger Scenario and atomic refusal of populated down ran in the new
suite. Existing Session/Scenario rollback guards also remain green.

Machine-local logs are in the executing machine's temporary directory:
demo02c-final-build.log, demo02c-final-test-demo-02c.log,
demo02c-final-test-demo-02b.log, demo02c-final-test-demo-02a.log,
demo02c-final-test-demo-session-infrastructure.log,
demo02c-final-test-demo-session-ownership-executor-isolation.log,
demo02c-final-test-demo-session-reset-recovery.log and
demo02c-final-test-milestone.log. These are executed local results, not claims
about GitHub CI. Credentials/raw logs are not committed.

### Development failures and warnings — not final results

The first build exposed TS18048 on an optional attempt; an explicit existence
guard fixed it. Docker was initially stopped; Docker Desktop and the existing
Compose service were started before PostgreSQL verification. No new service.

The first draft 02C run exited 1 (0 pass, 2 fail, zero skip/cancel/TODO). Static
imports from DemoRuntime initialized the core global pool before the fixture
selected its disposable database. It read the source testdb's six migrations and
then inadvertently seeded two shared configuration rows there. This was a test
isolation defect, not valid verification evidence. No dataset/job/session data
was created there. Read-only inspection identified exactly the newly created
type/definition by UUID, identical microsecond creation time and absence of job
references. A guarded transaction removed only those two rows; the first guard
using millisecond precision correctly refused without changing anything, then
the exact microsecond guard succeeded. No historical/domain/session rows were
removed. Domain service loading is now lazy, and the new fixture verifies
current_database before any seed/fixture write. All final tests used only their
owned disposable databases. This incident is disclosed, not presented as PASS.

The next two runs exited 1 (3 pass, 23 fail each). The new ledger trigger wrongly
required resource IDs in Step 1's pre-creation intent while completing the step.
It now distinguishes the frozen canonical intent from the bound completion
result. A later draft run was stopped after a fixture barrier self-wait (15 pass,
3 fail reported, zero skip/cancel/TODO). It also exposed a fault-client URL-port
override mistake and a fixture INSERT missing its required UUID. Those fixtures
were corrected. The stopped process's explicitly identified owned disposable DB
was normally dropped after verifying zero backends; no DROP FORCE was used.
The next two complete runs passed 26/26; the expanded settled-write recovery suite
and pre-final run passed 27/27. Only the final clean-revision table above is the
release evidence; earlier red results are retained here rather than hidden.

No runtime/build/deprecation warnings occur in the final logs. Git emitted local
LF-to-CRLF staging notices; both whitespace checks still passed. No accepted
architecture conflict was found. Applied migrations, core lifecycle/First Run/
dispatch/reconciliation/executor implementations, 02A seed, token/cookie/company
collision policies, and the session coordinator implementation have no diff.
Only the new ledger migration is added. New UI/other scenarios/background or
real Airflow work is absent. System Owner review is required; no automatic
approval or merge.
