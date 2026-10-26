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

Final executed revision, counts, warnings and owned teardown are recorded after
verification. Unexecuted commands are never PASS.

## Limits and review

Single Demo backend, no concurrent core/external/config writer, development/test
only. Fake state is process-local; old sessions are invalid after restart. No
public deployment or distributed durability guarantee. Raw ingestion, shared
configuration, core state machines, immutable snapshot rules, core lock ordering,
executor contract, session security and applied migrations remain unchanged.
No LOST_RESPONSE_RECOVERY/02E, frontend, deployment, worker, real Airflow, queues,
distributed coordinator or financial logic is implemented. System Owner must
review the PR; no automatic approval or merge.
