# Demo-05C-2 — Legacy Guided Scenario Admission Drain

Baseline main `b59fe8a946e860ac19b158e5e3ea3593c915f88c`; PR #38 confirmed merged
before branch creation. Branch: `codex/demo-05c2-legacy-admission-drain`.
Authority: System Owner's bounded task. Await System Owner Review; do not merge.
Implementation source: `c14b7619de85839e1ddc2c2e9b118f8e92b97e0d`.
Authorized smoke-inventory-only follow-up: `2381f6c91f5791ee459cb7fb15ede22f6c1374e9`.
Subsequent changes record verification/runbook details only.

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
   Its reviewed contract must distinguish the exact configured Session cookie
   field from unrelated cookies. Route only potential replays to the old Backend;
   the Backend validates their token, expiry and revocation and must never fall
   back from a rejected token to allocation. Before proceeding, verify a valid
   replay returns the same Session/expiry, missing/unrelated cookies are blocked,
   invalid/duplicate/expired/revoked Session cookies cannot insert a Session, and
   existing Session commands still work. Header presence is only routing evidence,
   never authentication. Do not modify/restart the live Backend to install this
   entrypoint prerequisite while Sessions remain.
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
fixtures verified admission races, idempotency, durable reload and continued
Guided/manual/Reset behavior. The DRAINING flow completes HAPPY_PATH,
FAILURE_RETRY and LOST_RESPONSE_RECOVERY (including same-request 202 recovery),
then verifies completed Scenario replay, Free Exploration publication, expiry/
revocation and unknown Reset recovery.

Historical migration suites keep their original applied-migration inventory and
down targets. They install the new Gate in a separately tracked fixture migration
so current Session/Scenario services can run without silently changing the old
validator/rollback tests. Latest-schema suites expect 13 migrations. No historical
migration SQL or Frontend application code is modified. The System Owner explicitly
authorized only the two 12→13 migration-inventory numbers in the existing
Frontend browser-smoke fixture; its UI/behavior assertions remain unchanged.
Docker/HTTPS includes the actual
production UI plus explicit-target admission commands. Core's cross-workflow
teardown now waits, within its existing bound, for PostgreSQL to report zero
backends after client shutdown; it still uses normal DROP and keeps every Core
concurrency/lifecycle assertion.

Final local results: **PASS — 648 tests, 0 failed/skipped/cancelled/TODO**,
counting each suite once, including Node test parent counters. Executed on Windows,
Node v24.18.0 / PostgreSQL 18.6. Every final command exited 0:

| Command (`npm.cmd run ...`) | Passing tests |
|---|---:|
| test:demo-05c2 | 19, using 18 independently owned migrated databases |
| test:milestone | 259, including CON-01/02 and isolated raw ingestion |
| test:demo-session-infrastructure | 21 |
| test:demo-session-reset-recovery | 22 |
| test:demo-session-ownership-executor-isolation | 19 |
| test:demo-02a | 23 |
| test:demo-02b | 26 |
| test:demo-02c | 27 |
| test:demo-02d | 25 |
| test:demo-02e | 37 |
| test:demo-04 | 23 |
| test:demo-05a | 23 |
| test:demo-05b1 | 12 |
| test:demo-05b2 | 29 |
| test:demo-05c1 | 18 |
| test:demo-04-containers | 14, including real HTTPS/production UI/operator drain |
| ui:test | 41 |
| ui:smoke | 10, actual Chromium / Vite / Backend / PostgreSQL |

Also passed: build; test:demo-05c2:typecheck (including the CLI, historical fixture
helper and new migration); existing test:demo-04/05a/05b1/05b2/05c1:typecheck;
ui:typecheck; ui:build; root and frontend npm audit --audit-level=high (zero
vulnerabilities); git diff --check and staged checks. CI runs the new focused
typecheck and PostgreSQL suite. Remote CI results are separate from local evidence.

The new suite proves lock ordering with NOWAIT and actual pg_stat_activity /
pg_blocking_pids waiters, not sleep-only timing. Unknown drain confirmation uses
a different PostgreSQL backend PID and waits for a gate-owning transaction before
reading durable truth. New fixtures record zero remaining backends and normal
DROP (no FORCE). Container project `demo04_test_83d9fae40144` confirmed removal of
its owned volumes. Browser fixture `demo03_browser_35216_5163d6a5d360` recorded zero
connections and normal DROP. The source test service was checked to contain only
the maintenance database before removing its container/anonymous volume and
private URL file. No persistent developer/production database was used.

Development-run failures were resolved before these final results: historical
fixture filtering omitted the migration filename suffix; a new transaction catch
masked the existing safe allocation-exhausted error; the first container run
preceded local Playwright dependency installation; and the old Core teardown
observed server-backend shutdown later than client socket closure. Final reruns
retain all original business/security/concurrency assertions and pass.

No known implementation blocker remains. First-deployment ingress/quiescence
verification and System Owner Review are still required; this PR performs no
live deployment, CAPEX cutover, reopening or merge.
