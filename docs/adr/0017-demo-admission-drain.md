# ADR-0017 — PostgreSQL Demo Admission Drain

- Status: Accepted bounded task specification; implementation requires System Owner Review.
- Authority: System Owner's Demo-05C-2 specification.
- Supplements ADR-0010/0011/0012/0015/0016; does not alter Core or Guided execution.

## Decision

A singleton PostgreSQL `demo_admission_control` row starts LEGACY_OPEN and can
move only to DRAINING. PostgreSQL is already the durable authority for Session
and Scenario insertion. Sharing its row lock with admission transactions closes
the race that an unlocked status check or process-local flag would leave.
No distributed lock service or new worker is required. Checks/PK prevent other
identities/states; triggers prevent deletion, truncation and reopening, and set
the transition timestamp. Missing/unreadable state fails closed with sanitized 503.

Lock order is Gate row FOR SHARE → optional Session capacity table lock → Session
insert, or Gate row FOR SHARE → Session row FOR UPDATE → Scenario lookup/insert.
The gate remains held through the same transaction's COMMIT. Admission uses READ
COMMITTED and a fresh state read after lock acquisition. Drain takes FOR UPDATE
on that same row and commits DRAINING. Thus a completed drain has waited for all
earlier protected inserts; later admissions cannot insert. Concurrent drain
commands serialize on the row and preserve the first transition timestamp.

Session capacity and allocation remain in one transaction even without capacity
configuration. Only a confirmed COMMIT releases a credential to HTTP. Ambiguous
Session COMMIT discards the socket and returns 503 without a Cookie: no unknown
credential is issued. A possibly committed, unreachable Session remains subject
to the existing lifetime/capacity/cleanup rules. Existing valid-cookie POST replay
authenticates without entering new admission and never rotates or extends it.

Scenario Create locks the gate before the Session, then reloads durable Scenario
state before deciding whether it is a new insertion. Existing same-type replay
is allowed in DRAINING; different-type remains 409. A missing Scenario requires
LEGACY_OPEN. Ambiguous Scenario COMMIT retains ADR-0011's 503 and subsequent
fresh-connection locked durable reload. After a rollback followed by drain, retry
cannot recreate an absent Scenario; after commit it can replay the same row.
Guided Steps, manual Domain commands, reads and Reset never acquire this Gate.
Parallel/Exclusive admission and Reset unknown-outcome recovery remain unchanged.

The trusted CLI supports status/drain only, requires exactly one explicit
DEMO_ADMISSION_DATABASE_URL or DEMO_ADMISSION_DATABASE_URL_FILE, and never falls
back to DATABASE_URL or seed/runtime secrets. No public management route exists.
After ambiguous drain COMMIT, destroy the suspect connection and create a truly
separate PostgreSQL connection. Lock the same Gate FOR UPDATE, then read fresh
durable state: DRAINING confirms the barrier, LEGACY_OPEN confirms it is not
applied and requires retry, inability to confirm remains explicitly UNKNOWN.
Neither an exception nor an unlocked pre-commit SELECT proves an outcome.
No reverse operation exists; ordinary SQL also cannot reopen DRAINING.

## Deployment and rollback limits

First installation cannot safely restart a live old Backend: startup still
revokes existing Sessions because Fake state is process-local. First stop *new*
Session creation at the existing trusted entrypoint, retain the old Backend and
existing Session operations, and let all Sessions finish/expire/reset. A Cookie
header's presence is not proof of a valid Session: the Backend must validate
cookie replays. The pre-Gate entrypoint needs a separately verified replay-aware
admission path; a blanket POST /demo/sessions block or pass-through for arbitrary
cookies is insufficient. If unavailable, this prerequisite blocks installation;
do not invent a proxy-only authentication bypass or restart users away.

Only after operator-confirmed quiescence may the Backend/migration be updated;
keep ingress closed until the new operator confirms DRAINING. Migrating while
an old writer is serving does not protect its inserts: it does not take the Gate.
After drain, rollback to an unaware Backend must retain closed admission/traffic
until a reviewed compatible deployment plan; never reopen traffic automatically.
Down is offline-only and refuses DRAINING, active Sessions or retained Scenarios.

Demo-05C-3 must separately verify confirmed drain, compatible binaries, no active
or queued/in-flight operations, no pending Reset/Scenario outcomes, no retained
configuration-dependent work or external writers, and an approved configuration
cutover/rollback plan. A SQL active-Session count alone cannot prove these facts.
This task does not change CAPEX configuration or perform a cutover/deployment.
