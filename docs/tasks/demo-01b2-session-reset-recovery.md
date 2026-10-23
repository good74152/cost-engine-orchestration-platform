# Demo-01B-2 — Session Reset and Failure Recovery

Authority: System Owner's 2026-10-23 specification. Implementation and evidence
await review; no automatic merge. Branch: feature/demo-01b2-session-reset-recovery.
Baseline: main cc535f36b8e304df7996a2b09c572f208766fef1 (Demo-01B-1 PR #20 merged).
Task 007 and Demo-01A are ancestors. See ADR-0010 for the approved bounded design.

## API and admission

POST /demo/sessions/reset requires a valid cookie, X-Demo-Session: 1, matching
supplied Origin and exactly {}. No client ownership/execution selectors. Success
is 204 only after committed cleanup/revocation, then fake release and cookie
clearing. Errors: 401 DEMO_SESSION_UNAVAILABLE; 409 RESET_CONFLICT; 400
INVALID_REQUEST; 403 DEMO_SESSION_CSRF_REJECTED; 500 DEMO_RESET_FAILED for confirmed
rollback; 503 DEMO_RESET_OUTCOME_UNKNOWN while unresolved. All 401 session errors
clear the correct host-only cookie. Invalid cookies never silently create users.

Reset reserves synchronously with no await between checking and reserving. It
does not queue. Running/queued work or another reset conflicts. Ordinary commands
reject during reset. Unknown outcome retains blocking until durable resolution.
An idle RUNNING job/ACCEPTED attempt is deletable demo data, not a reset conflict.

## Complete applied FK graph and deletion order

All seven applied migrations were read before implementation. Restricted edges:

- dataset_versions -> dataset_series.
- calculation_jobs -> dataset_versions, shared calculation_types and definitions.
- execution_attempts -> calculation_jobs.
- dataset_build_snapshots -> dataset_versions.
- snapshot_dependencies -> snapshot and composite upstream series/version.
- dpr_results -> dataset_versions.
- dpr_calculation_input_snapshots -> calculation_jobs.
- dpr_calculation_inputs -> input snapshot and shared assets.
- definition dependencies -> definitions -> types; legacy type bridges -> types.
- raw batches -> raw series. No raw/assets/session FK to the owned dataset graph.

One transaction locks/revalidates the session and derives company ownership from
that row. Reject a foreign snapshot referencing an owned upstream. Delete owned
snapshot dependencies, DPR inputs, DPR input snapshots, DPR results, attempts,
build snapshots, jobs, versions, series; revoke the same session; commit. No
CASCADE/TRUNCATE, shared deletion, session-history deletion or migration change.

## Recovery and maintenance

Confirmed rollback preserves the entire graph, valid session and fake; release
admission for retry. On COMMIT response loss discard the suspect connection and
use a new connection with a bounded lock wait on the session row. Only after the
old transaction releases that lock inspect revocation and remaining owned data.
Confirmed commit releases the fake; unresolved outcomes stay blocked. Controlled
recovery retries do not redispatch or reconstruct fake state. Post-commit fake
release failure is logged, never treated as SQL rollback; maintenance retries it.

Only real Demo server startup invalidates old sessions before listening. Failure
prevents listening. buildApp never invalidates sessions. Explicit bounded
maintenance cleans expired/revoked ownership graphs with the same SQL, skips
active/busy sessions, logs failures/pending work and can be retried idempotently.
No background worker, frontend/reset UI, scenario runner, distributed system,
financial state transition, cancellation or real Airflow integration.

Trusted backend entry points on the same live DemoRuntime (not HTTP APIs):

- runtime.reset.startServer(): real process startup only, before listen.
- runtime.reset.recoverPendingResets(limit): retry at most limit uncertain owners.
- runtime.reset.cleanupInactiveSession(id): lock/recheck one inactive durable owner.
- runtime.reset.maintainInactiveSessions(limit): recover up to limit outcomes,
  clean up to limit inactive owners, report cleaned/failed/pending counts.

The default limit is 50, maximum 1000. Repeat controlled maintenance while pending
is nonzero; investigate logged integrity failures rather than broadening deletion.
Use the same live runtime to recover its in-memory reservations/registry, not a
second concurrently running backend. Startup invokes one bounded maintenance
batch; no periodic worker or automatic indefinite drain is implied.

## Verification plan

Owned disposable fully migrated PostgreSQL database; deterministic barriers for
reset/reset, reset/running+queued commands, reset blocking commands, SQL failure
after partial deletion, commit response loss and unresolved commit recovery.
Cover full DPR/v2 FK graph, same-session upstream links, foreign-reference refusal,
shared/non-demo/B-session preservation, cookie lifecycle, startup fail-closed,
inactive maintenance and fake cleanup failure/retry. Run build, both earlier Demo
suites, dedicated B2 suite, and unchanged test:milestone. Record exact commands,
counts, tested revision, teardown, warnings and limitations below after execution.

## Bounded regression-fixture correction

The first full milestone run exposed the existing Task 007B-1 teardown race:
all 32 assertions passed, then forced DROP terminated a still-closing pooled
socket and Node reported asynchronous activity/uncaughtException (32 pass,
1 fail; command exit 1). The gate correctly stopped, leaving contracts/raw/E2E
NOT RUN. Earlier child suites, including CON-01/CON-02, passed. This is not a
financial-state or reset regression and is not reported as a green gate.

pg-pool removes idle clients from its accounting before socket end callbacks.
The B-1 fixture now uses the same actual-client-end barrier already present in
the C/terminal-lifecycle fixtures, asserts zero connections and uses normal owned
DROP instead of FORCE. No production DB helper, milestone policy, scenario or
expected assertion changes. Separate repeated focused verification and the
complete final gate are recorded below; initial failed evidence is retained.
