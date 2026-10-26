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

### Review fix: reject prior manual executor configuration

Before this fix, manual POST /demo/fake-executor/dispatch-behavior could enqueue
REJECT or UNKNOWN_WITHOUT_CREATION without creating any Dataset. The empty-domain
check then admitted a new Scenario whose first dispatch consumed that behavior.
This could prevent the intended real execution / lost ACK / same-identity recovery.

First Scenario creation now also requires that the session has no allocated
FakeExecutor in its runtime registry. An existing fake returns the existing
409 DEMO_SCENARIO_SESSION_NOT_EMPTY with an explicit reset instruction, before
Scenario insertion. This deliberately conservative rule also rejects an allocated
but unused fake or a prior ACCEPT configuration. It does not inspect, clear or
replace execution, rejection, default behavior or script state. Use the supported
Reset and create a new Session before starting a Guided Scenario. No new reset
semantics or executor API is introduced.

The check runs only after the durable existing-Scenario lookup, inside the existing
session coordinator and short Create transaction. Same-type Create for an existing
Scenario still returns its original durable DTO at READY, pending UNKNOWN, accepted,
Retry or terminal progress. Different-type Create remains TYPE_CONFLICT. Neither
path clears a fake or changes a run identity. Unknown Create COMMIT still resolves
through the original durable lookup. Single-instance and no-external-writer limits
remain; PostgreSQL transactions, Core Run and executor contracts are unchanged.

New PostgreSQL route cases cover both manual behaviors before all three Scenario
types, no mutation on refusal, existing Reset/new-session recovery, normal E
202-to-200 recovery, full Happy/Failure completion, repeated Create at active and
terminal phases, and barrier-ordered Manual/Create races in both directions.
Review-fix verification is recorded separately below; earlier evidence remains
the exact pre-review implementation run, not evidence for this fix.

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

### Executed verification — 2026-10-27 (Asia/Taipei)

All final commands ran sequentially on clean implementation commit
b5009ac06aa66609c7854ad4a4b2b8c14d373e23, tree
c8e39ffa37d4a1b7e12d49761e47351419e5a058. The later evidence-only commit changes
this document, not the tested implementation/migration/test sources. Environment:
Windows PowerShell, Node 24.18.0, npm 11.16.0, PostgreSQL 18.6
(Debian 18.6-1.pgdg13+2). docker compose up -d postgres_db exited 0.

| Exact command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-02e | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |
| git diff 13a8907..HEAD --check | 0 | n/a | n/a | n/a |

All cancellations/TODOs are zero. Counts include Node parent/nested entries,
not individual assertions: 190 Demo plus 246 milestone entries, total 436.
Supplemental strict test/migration type checking also exited 0 on this commit:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-02e-lost-response-recovery.pg.test.ts migrations/1793100000000_demo-lost-response-recovery.ts
```

The unchanged milestone runner launched all 13 child commands below. Every child
reported PASS, exit 0, null signal/spawnError and no gate issues; every test had
zero fail, skip, cancel and TODO:

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

CON-01/CON-02 and E2E Flow A–F remain green. Raw ingestion used its existing
isolated launcher only. No persistent developer database was a test target.

All final Demo fixtures applied eleven migrations, closed actual clients,
verified zero remaining backends and normally dropped their owned databases:

| Suite | Owned database | Backends | Normal DROP |
|---|---|---:|---|
| 02E | demo_02e_test_3904_49a056f03d16 | 0 | yes |
| 02D | demo_02d_test_34984_2f33b6a5d6d6 | 0 | yes |
| 02C | demo_02c_test_19884_4202ce8ab740 | 0 | yes |
| 02B | demo_02b_test_34376_a872b3b77789 | 0 | yes |
| 02A | demo_02a_test_32864_cb5c6fa40a6d | 0 | yes |
| 01A | demo_01a_test_3456_20d824194de7 | 0 | yes |
| 01B-1 | demo_01b1_test_38460_bf1d90b1dcbf | 0 | yes |
| 01B-2 | demo_01b2_test_22644_4d23e0e9b2a0 | 0 | yes |

The unchanged isolated raw launcher dropped raw_milestone_test_32556_a538676a38a9.
Its pre-existing cleanup uses DROP DATABASE WITH (FORCE), as do some existing
core fixtures. This task does not claim those helpers use normal DROP or that
FORCE terminated zero clients. The eight Demo suites separately prove zero
backends and normal DROP without FORCE. After all gates, a read-only maintenance
audit found only postgres, template0, template1 and pre-existing testdb. The only
client backend was the audit connection to postgres; no fixture remained.

Executed migration evidence includes populated Happy/Failure up preservation,
exact prior-validator restoration on supported down and successful forward
again; pre-02E incompatible ledger refusal; READY-only E down refusal; populated
E down refusal with unchanged data, validator and migration markers. Existing
Session/Scenario/ledger/Failure rollback guards still run at their original
migration boundaries under the additional forward migration.

The special SQL fault ran after the real fake created an execution and before
Core recorded UNKNOWN. The rejected write left one DISPATCHING Attempt 1 and
PENDING Job/ledger. Retry used the exact same complete frozen dispatch command,
received existing-execution confirmation and completed without a second run.
The blocking-executor test acquired Session/Scenario/ledger/Job/Attempt locks
with FOR UPDATE NOWAIT while dispatch was paused. Fake success and reconciled
PostgreSQL success remained separate throughout the completed six-step test.

Development results are separate from final clean-revision evidence. Preliminary
02E, 02D and 02C suites exited 0 with 27, 25 and 27 passing entries. An additional
strict type check initially exited 1 (TS2345: UUID template inference in a test
helper); an explicit string parameter corrected it. Staging whitespace checks
also rejected extra EOF blank lines; these were removed before the implementation
commit. No PostgreSQL suite failure is relabelled as PASS. Intentionally injected
SQL/transport/executor/Reset failures are successful asserted cases.

Final build/runtime logs contain no warnings or deprecations. Git emitted local
LF-to-CRLF notices; whitespace checks passed. The configured remote uses the old
repository name and may emit a rename redirect on push; it is not a test warning.
Local execution logs are in the executing machine's temporary directory:
demo02e-final-build.log and demo02e-final-test-<suite>.log, for each suite above
(colons replaced with hyphens). Raw logs/credentials are not committed. These
are local executed results, not claims about GitHub CI.

The complete diff was reviewed. The new validator differs from the applied 02D
validator only in the four specified type-selection rules; no Happy/Failure
validation branch was weakened. No accepted architecture conflict was found.
All ten historical migrations, Core Run/Retry/preparation/reconciliation/lifecycle,
FakeExecutor/interface, session security/coordinator/Reset, seed and raw ingestion
implementations have no diff. No frontend, deployment or later task was added.

### Review-fix executed verification — 2026-10-27 (Asia/Taipei)

This is separate AFTER-FIX evidence, not a reclassification of the original run
above. All final commands ran sequentially on clean review-fix commit
d8f2193ccadfbfb97aa34f1c4bbbded8cdfd9813, tree
6df765ac71a833629cda44a1bd3e1685ec2cf02e. The later evidence-only commit changes
only this document. Windows PowerShell, Node 24.18.0, npm 11.16.0, PostgreSQL
18.6 (Debian 18.6-1.pgdg13+2); docker compose up -d postgres_db exited 0.

| Exact command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-02e | 0 | 37 | 0 | 0 |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |
| git diff 1cd4a0d..HEAD --check | 0 | n/a | n/a | n/a |
| git diff 13a8907..HEAD --check | 0 | n/a | n/a | n/a |

All cancellation/TODO counters are zero. Counts include parent/nested entries:
200 Demo plus 246 milestone, total 446. The four additional Demo suites cover
shared runtime wiring, ownership/security and Reset regressions. Supplemental
strict checking on the clean review-fix commit also exited 0:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-02e-lost-response-recovery.pg.test.ts
```

All 13 unchanged milestone children reported PASS, exit 0, null signal/spawnError,
no gate issues, and zero fail/skip/cancel/TODO:

| Child command | Exit | Pass |
|---|---:|---:|
| npm run build | 0 | n/a |
| npm run test:milestone-runner | 0 | 20 |
| npm run test:orchestration-schema-v2 | 0 | 30 |
| npm run test:dataset-version-creation-v2 | 0 | 14 |
| npm run test:first-run-immutable-build-snapshot | 0 | 19 |
| npm run test:execution-attempt-dispatch-fake-executor | 0 | 11 |
| npm run test:executor-reconciliation | 0 | 22 |
| npm run test:dataset-version-terminal-lifecycle | 0 | 64 |
| npm run test:cross-workflow-concurrency-investigation | 0 | 14 |
| npm run test:task-007b1-late-dispatch-reconciliation | 0 | 32 |
| npm run test:task-007c-api-contract | 0 | 12 |
| npm run test:raw-ingestion (owned disposable PostgreSQL database) | 0 | 1 |
| npm run test:task-007d-end-to-end | 0 | 7 |

CON-01/CON-02 and E2E Flow A–F remain green. New route tests reject both prior
manual behaviors for all three types without changing PostgreSQL or fake memory,
then Reset/new-session creation completes each normal flow. E still performs
202 then 200 with identical attempt/full command and one external execution.
Create replay preserves pending/accepted/Retry/terminal state and the exact fake
instance. Deterministic barriers prove both Manual/Create queue orders. The
preliminary development suite also exited 0 (37 pass); no review-fix build,
strict-check or PostgreSQL suite failed. This does not claim a before-fix test run.

All eight final Demo suites applied eleven migrations, verified zero backends
after actual client shutdown, and normally dropped their owned databases:

| Suite | Owned database | Backends | Normal DROP |
|---|---|---:|---|
| 02E | demo_02e_test_32380_9684b89a9c76 | 0 | yes |
| 02D | demo_02d_test_31804_a8f944cb193b | 0 | yes |
| 02C | demo_02c_test_34664_a83f22810c83 | 0 | yes |
| 02B | demo_02b_test_32796_fca36ac7e30e | 0 | yes |
| 02A | demo_02a_test_38932_4916a61e420c | 0 | yes |
| 01A | demo_01a_test_18224_7e9f264ede9a | 0 | yes |
| 01B-1 | demo_01b1_test_20904_4918f23f48fd | 0 | yes |
| 01B-2 | demo_01b2_test_35056_f63719e96e1f | 0 | yes |

The unchanged isolated raw launcher dropped raw_milestone_test_10148_06a08d12d7be.
Existing core/raw FORCE cleanup policies are unchanged; no claim is made about
how many clients FORCE terminated. The eight Demo drops used no FORCE. Final
read-only audit found only postgres/template0/template1/pre-existing testdb and
the audit connection to postgres; no owned fixture or backend remained.

Final runtime/build logs had no warnings/deprecations. Git emitted LF-to-CRLF
notices; whitespace checks passed. The existing old-name remote redirects on
push. Logs remain local in the executing machine's temporary directory as
demo02e-review-final-build.log and demo02e-review-final-test-<suite>.log (colons
replaced with hyphens). No credentials or raw logs are committed. These are local
results, not GitHub CI evidence.

Review-fix files: DemoScenarioService, DemoRuntime's read-only registry inspection
and dependency wiring, the 02E PostgreSQL suite, Architecture, Reference and this
task document. Complete diff review found no Core Run/executor/interface,
migration, ownership/security, coordinator or Reset implementation changes. The
explicitly authorized refusal strategy preserves existing fake identity history;
no architecture conflict or new infrastructure was introduced. PR #30 remains
subject to System Owner review; no automatic merge or Frontend work.
