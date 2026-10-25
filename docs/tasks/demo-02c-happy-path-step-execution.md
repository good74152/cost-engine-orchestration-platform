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

Final revision, actual counts, warnings and teardown evidence are recorded below
after execution. Unexecuted commands are not PASS. System Owner review is required;
do not automatically approve or merge.
