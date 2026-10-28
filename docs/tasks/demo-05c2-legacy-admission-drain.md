# Demo-05C-2 — Legacy Guided Scenario Admission Drain

Baseline main `b59fe8a946e860ac19b158e5e3ea3593c915f88c`; PR #38 confirmed merged
before branch creation. Branch: `codex/demo-05c2-legacy-admission-drain`.
Authority: System Owner's bounded task. Await System Owner Review; do not merge.

## Specification

Follow [ADR-0017](../adr/0017-demo-admission-drain.md). One forward migration adds
the singleton LEGACY_OPEN/DRAINING gate and database guards. Shared row locks cover
Session allocation (with/without capacity) and Scenario admission through COMMIT;
drain uses the conflicting exclusive row lock. Gate precedes all capacity/Session
locks. Existing cookie replays and same-type Scenario replays remain supported.
All operation/ledger/coordinator/reset/Core/Fake rules remain unchanged.

New HTTP errors use existing flat message/code, no-store sanitization:
503 DEMO_ADMISSION_DRAINING (new legacy admission closed),
503 DEMO_ADMISSION_UNAVAILABLE (missing/unreadable gate), and
503 DEMO_SESSION_CREATE_OUTCOME_UNKNOWN (no unconfirmed Cookie issued).
Scenario unknown COMMIT still uses DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN and
the next locked durable reload. Operator-only errors distinguish unavailable,
DEMO_ADMISSION_DRAIN_NOT_APPLIED and DEMO_ADMISSION_DRAIN_OUTCOME_UNKNOWN.

`npm run demo:admission -- status|drain` requires exactly one explicit
DEMO_ADMISSION_DATABASE_URL or DEMO_ADMISSION_DATABASE_URL_FILE, independent of
DATABASE_URL. Only state/updatedAt and drain confirmation are printed. No public
API or reverse/open command is added. Production operator image also supports
admission-status/admission-drain with an explicitly provided admission target.

## Deployment runbook

1. Before first installation, identify the existing Backend/startup revision and
   the trusted ingress admission capability. The old Backend revokes Sessions on
   restart, and does not honor the new database Gate.
2. Stop new Session creation using the existing trusted ingress, *without*
   stopping/restarting the Backend or blocking established Session operations.
   Valid POST /demo/sessions cookie replay must still reach Backend authentication;
   presence of any Cookie alone is never authorization. Malformed/expired/forged
   cookies must not fall through to new creation. A blanket endpoint block or
   naive proxy cookie matching is not a safe substitute. Obtain a reviewed,
   replay-aware entrypoint mechanism first; if it is absent, stop installation.
   This PR does not claim to provide that old-version ingress mechanism.
3. Wait for existing Sessions to complete/reset/expire. Verify no active users,
   queued/in-flight requests, uncertain Scenario/Reset outcomes, retained work
   requiring the old configuration, or other writers. Observe runtime/operator
   evidence as well as SQL; zero active Session count alone is insufficient.
4. Only after quiescence, stop/update the Backend and explicitly run migrations
   against the intended Demo DB. Keep new admission closed at ingress throughout.
5. Set the private DEMO_ADMISSION_DATABASE_URL (or its dedicated file variable).
   Run `npm run demo:admission -- status`, then `npm run demo:admission -- drain`,
   then status again. For the Compose operator use `-e
   DEMO_ADMISSION_DATABASE_URL_FILE=/run/secrets/database_url` explicitly with
   `admission-drain`/`admission-status`; no target is inferred from mounted secrets.
   Do not paste URLs or credentials into shared shell history/logs.
6. Only a confirmed DRAINING status establishes the new-admission barrier. A
   drain timeout/UNKNOWN requires fresh confirmation/retry, never an assumption.
   Preserve existing-session traffic where applicable. DRAINING does not revoke
   credentials, cancel work, stop manual operations or change configuration.
7. Demo-05C-3 separately owns the real CAPEX Configuration Cutover, its complete
   quiescence checks and reviewed rollback plan. This task performs none of it.

Rollback after DRAINING must keep ingress admission closed. An older Backend
ignores the Gate and may revoke Sessions at restart: do not directly reopen its
traffic. Down refuses a drained Gate and active Session/retained Scenario data;
offline rollback of an unused LEGACY_OPEN installation requires an operator
plan and no serving old/new writers. Never delete/reset the Gate to reopen it.

## Verification

Real PostgreSQL barriers/locks, unknown COMMIT injection and disposable database
fixtures will verify admission races, idempotency, durable reload and continued
Guided/manual/Reset behavior. Final executed evidence is recorded below after runs.

Historical migration suites keep their original applied-migration inventory and
down targets. They install the new Gate in a separately tracked fixture migration
so current Session/Scenario services can run without silently changing the old
validator/rollback tests. Latest-schema suites expect 13 migrations. No historical
migration SQL or Frontend file is modified. Docker/HTTPS includes the actual
production UI plus explicit-target admission commands. Core's cross-workflow
teardown now waits, within its existing bound, for PostgreSQL to report zero
backends after client shutdown; it still uses normal DROP and keeps every Core
concurrency/lifecycle assertion.
