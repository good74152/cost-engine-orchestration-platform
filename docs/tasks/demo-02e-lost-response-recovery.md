# Demo-02E — Lost Response Recovery Scenario

## Goal and baseline

Add only LOST_RESPONSE_RECOVERY, the third fixed Guided Scenario. The fake
creates an execution but its dispatch acknowledgement is lost. Recovery must
confirm that same execution, not allocate another attempt or dataset version.
This is executor-to-backend ACK loss, not browser-to-backend response loss.

Branch feature/demo-02e-lost-response-recovery starts from freshly fetched main
13a89070fd5270e2f33a649150cc20a639be7b21. GitHub confirmed Demo-02D PR #29
merged at that commit; Demo-02A/B/C/D are present. Authority: the System Owner's
Demo-02E specification, Architecture and ADR-0008–0012. This adds the specified
fixed flow within the existing step protocol; no new major decision or ADR.

## API and six-step workflow

POST /demo/scenarios accepts exactly scenarioType: HAPPY_PATH, FAILURE_RETRY or
LOST_RESPONSE_RECOVERY. New returns 201 READY/0; same-type retry returns 200 with
the original Scenario; different-type returns 409 DEMO_SCENARIO_TYPE_CONFLICT.
PostgreSQL UNIQUE(session_id) still permits only one Scenario per session.

POST /demo/scenarios/:id/next accepts exactly expectedStep and requestId UUID.
E accepts steps 1–6, Happy Path 1–6 and Failure Retry 1–9. No client resource,
execution identity, company or executor behavior selector is accepted.

| Step | Operation | Confirmed result |
|---|---|---|
| 1 | Existing dataset creation | CAPEX / authenticated company / 2026 / Q4 / version 1, DRAFT; one DEMO_GUIDED_SUMMARY PENDING Job |
| 2, first call | Existing Run through Demo lost-ACK decorator | One real external execution; Attempt 1 DISPATCHING, Job PENDING; ledger PENDING, progress 1, HTTP 202 |
| 2, same-request recovery | Existing Run with original identity | Fake returns ALREADY_EXISTS; Core saves ACCEPTED/RUNNING; ledger COMPLETED, progress 2, HTTP 200 |
| 3 | Set original own fake execution SUCCEEDED | PostgreSQL remains RUNNING/ACCEPTED |
| 4 | Existing reconciliation | Same Job and Attempt 1 SUCCEEDED |
| 5 | Existing Submit Validation | Same dataset VALIDATING |
| 6 | Existing Publish | Same dataset PUBLISHED; ledger and Scenario COMPLETED/6 atomically |

Completed results include the actual attemptNumber=1 and original attempt,
snapshot and frozen-definition UUIDs. Happy Path DTOs remain unchanged. No raw
DB rows, full executor command, token/hash or dispatch diagnostic is returned.
Pending GET and Scenario GET DTOs remain unchanged and PostgreSQL-only.

## Lost acknowledgement simulation

LostAcknowledgementExecutor is a stateless Demo-only CalculationExecutor
decorator, constructed only for E Step 2. It first calls the session-owned
FakeExecutor. Only underlying ACCEPTED becomes UNKNOWN. ALREADY_EXISTS,
REJECTED and UNKNOWN retain their original meanings; status lookup delegates
to the same fake. No behavior is enqueued, including on request retries.

The decorator creates no identity or fake execution itself. Real FakeExecutor
idempotency provides one execution per full DAG/run identity. Core Run and the
CalculationExecutor interface are unchanged. Existing accepted durable state
fills progress without redispatch. Definite rejection cannot be recovered as
success or allocate Attempt 2 in this bounded Scenario; use Reset.

## Identity binding, idempotency and UNKNOWN recovery

Reuse demo_scenario_step_executions and the exact existing canonical binding.
Transaction A durably binds Step 2 to Step 1's dataset and sole guided Job.
Core owns durable Attempt 1, attempt number, full DAG/run identity, immutable
snapshot and frozen definition. These existing related rows are the persisted
execution binding while the ledger is PENDING; no second identity store or
mutable intent is introduced. The recovery read validates exactly one version,
counter 1, one Job, at most Attempt 1, one snapshot, published zero-dependency
definition 1 and the stable DAG/run convention. It never chooses latest data.
The completed result binds the actual UUIDs; subsequent intents additionally
freeze and validate the same complete DAG/run identity.

UNKNOWN leaves ledger PENDING, completedStep=1 and the prior logical Job state.
Same requestId recovers through the existing Core DISPATCHING path and stable
identity. ALREADY_EXISTS confirms ACCEPTED/RUNNING. No second attempt, Job,
snapshot, version or external execution is created. Core diagnostic-write
failure after external creation also leaves durable DISPATCHING recoverable.

Ledger lookup precedes progress validation. Another requestId cannot claim
Step 2 (409 DEMO_SCENARIO_STEP_CONFLICT); Step 3 cannot skip a pending Step 2.
Original completed replay returns the stored response even after Step 6, with
no redispatch or later step operation. Existing unique keys, progress CAS,
immutable intent/history and owner/parent PostgreSQL validation remain.

## Transaction boundaries and failures

Keep the existing protocol:

1. Transaction A locks/revalidates Session, owned Scenario and ledger; reserves
   PENDING intent and commits.
2. Short settled-state recovery reads release version/job/attempt locks before
   Domain operations. Core Run commits preparation and DISPATCHING before the
   external call, then records its outcome in its own short transaction.
3. Transaction B rechecks exact durable success and atomically completes ledger
   and Scenario progress. Publication alone does not imply completed progress.

No PostgreSQL transaction or Scenario lock spans FakeExecutor dispatch. Unknown
A/B COMMIT destroys the suspect connection; an independent bounded connection
waits for durable root locks and reads fresh state. Unconfirmed A never starts
Domain work. Confirmed completion replays; unavailable truth returns safe 503,
not a guessed rollback or blind new attempt. Same-request recovery remains.

Public errors retain the shared flat message/code envelope: 400 INVALID_REQUEST;
401 DEMO_SESSION_UNAVAILABLE; 403 DEMO_SESSION_CSRF_REJECTED; generic owned-resource
404 DEMO_RESOURCE_UNAVAILABLE; 409 DEMO_SCENARIO_STEP_CONFLICT or
DEMO_SCENARIO_STATE_CONFLICT; 503 DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN. Existing
configuration/type/mode/queue/Reset errors remain. Unexpected SQL/system errors
return sanitized 500 INTERNAL_SERVER_ERROR, without SQL or credential details.
Executor dispatch unavailability is ambiguous and returns PENDING/202; unavailable
fake status truth in later steps returns 503 without advancing progress.

## Forward migration and rollback

New 1793100000000_demo-lost-response-recovery.ts preserves the exact applied
02D validator under a rollback-only name. Its new validator adds only E's six
steps, Attempt 1 and successful completion rules, including attemptNumber=1.
Happy Path's six-step DTO rules and Failure Retry's nine-step, two-attempt,
full failed-history proof are unchanged. Ownership, parent/frozen-input/full
identity, unique keys and immutable ledger/Scenario bindings remain enforced.

Up refuses incompatible pre-02E Lost Response ledger history instead of
reinterpreting it. Down refuses ANY retained E Scenario, including READY with
no ledger. It never deletes history. With no E Scenario, supported down restores
the exact prior validator and preserves valid Happy/Failure histories; up works
again. DDL locks and migration transaction make refusal atomic, including
migration markers and validator state. All ten applied migrations are unchanged.

Existing tests adjust only migration counts/rollback depth and inputs that are
now supported. Their original Session/Scenario/ledger/Failure guards and all
existing test cases remain; no milestone runner gate is changed.

## Session isolation, Reset and limits

Use the existing HttpOnly cookie, fixed TTL, Origin/CSRF, ownership, per-session
coordinator and separate session fake. Manual mutations stay blocked for guided
sessions. Reset conflicts with admitted/queued work. Existing atomic cleanup
removes ledger, Scenario and owner graph then revokes; rollback restores all
and retains the same fake. Unknown Reset retains admission blocking until
durable confirmation. Release fake only after confirmed cleanup. Other sessions
and shared configuration are untouched.

Expiry/revocation denies future and queued admission without cancelling admitted
work. Real startup invalidates old cookies; durable progress never resurrects
lost in-memory fake state. Single Demo backend only, no concurrent core/external
or configuration writer. Development/test only; no public production deployment,
distributed durability, frontend, background runner, queues or real Airflow.
Core financial state machines, snapshots, lock ordering and executor contract,
historical migrations and session security are unchanged. Only Demo-02E is added.

## PostgreSQL verification

scripts/demo-02e-lost-response-recovery.pg.test.ts owns a template0 disposable
database, verifies current_database before fixture writes, and applies all eleven
migrations. It closes actual clients, verifies zero backends and normally drops
only its validated owned database. No persistent developer database is a target.

Coverage includes Create/replay/type conflict; all six steps; real lost ACK and
same full command recovery; backend failure before UNKNOWN recording; A/B SQL
rollback and unknown COMMIT; unavailable truth; deterministic same/different
requests and sessions; NOWAIT lock-release proof during dispatch; PostgreSQL
invalid writes; supported/unsafe migrations; Happy/Failure regression; Reset
rollback/unknown outcomes; exact input/security, queued expiry and restart.

Required commands (Windows npm.cmd): build; test:demo-02e; test:demo-02d;
test:demo-02c; test:demo-02b; test:demo-02a; test:demo-session-infrastructure;
test:demo-session-ownership-executor-isolation; test:demo-session-reset-recovery;
test:milestone; git diff --check. Executed clean-revision evidence follows after
verification. System Owner review is required; no automatic approval or merge.
