# Demo-05C-3A — CAPEX Configuration Cutover Operator

Baseline main `04d7e51f4c9a432b23cca2b4cedb118ce8a5a070` (PR #39 confirmed
merged before implementation). Branch `codex/demo-05c3a-configuration-cutover`.
Authority: System Owner's bounded specification; await System Owner Review.
This task builds capability and uses disposable databases only, never production.
Tested implementation: `8a00ffa24fb1eb18a25990de77d5622d26c1ffa3`; subsequent
changes record verification only.

## Contract

Follow [ADR-0018](../adr/0018-demo-workflow-configuration-cutover.md).
Migration 1793400000000 extends the existing control row without replacing its
identity/state/timestamp: LEGACY_OPEN → DRAINING → WORKFLOW_OPEN. No skip/reverse,
DELETE or TRUNCATE is allowed. Down refuses WORKFLOW_OPEN or any target/partial
CAPEX configuration, preserving completed cutover and historical definitions.

Session Create accepts both open states; DRAINING retains 503
DEMO_ADMISSION_DRAINING. First Legacy Scenario creation accepts LEGACY_OPEN only;
WORKFLOW_OPEN returns 503 DEMO_LEGACY_ADMISSION_CLOSED. Existing same-type replay
and different-type conflict keep their existing behavior; no ledger/recovery
protocol changes. Admission status recognizes WORKFLOW_OPEN, while the old drain
command returns DEMO_LEGACY_DRAIN_CLOSED, including durable confirmation.

`npm run demo:cutover -- status|cutover` requires exactly one explicit private
DEMO_CUTOVER_DATABASE_URL or DEMO_CUTOVER_DATABASE_URL_FILE. DATABASE_URL and
admission/seed targets are never fallbacks. Production operator supports
cutover-status / cutover, with the same explicit target requirement. No public
HTTP management route is registered. CLI prints only sanitized state/configuration/
outcome/confirmation JSON, never credentials or Session Tokens.

Status validates the complete dedicated-Demo catalog and returns state, updatedAt,
configuration (LEGACY/WORKFLOW). It makes no process-stopped or cutover-safe claim.
Cutover outcomes: APPLIED after confirmed mutation COMMIT, ALREADY_APPLIED after
read-only validation of WORKFLOW_OPEN+target. Confirmation is COMMITTED or
DURABLE_RELOAD. Active Workflow Sessions do not prevent ALREADY_APPLIED because
no completed configuration is rewritten.

| Error code | Meaning |
|---|---|
| DEMO_CUTOVER_REQUIRES_DRAIN | First application requires DRAINING |
| DEMO_CUTOVER_PRECONDITION_FAILED | Active Session or retained owned work exists |
| DEMO_CUTOVER_CONFIGURATION_CONFLICT | Exact legacy/target catalog is inconsistent |
| DEMO_CUTOVER_UNAVAILABLE | Pre-commit DB/lock/transport failure, no assumed success |
| DEMO_CUTOVER_NOT_APPLIED | Independent locked reload confirms DRAINING+legacy; retry may recheck conditions |
| DEMO_CUTOVER_OUTCOME_UNKNOWN | Independent confirmation is unavailable/inconsistent/timed out |

All operator failures exit nonzero. No retry/repair/cleanup loop is added.
Configuration verification requires exact nine legacy or ten Workflow Types,
including exact DAG, active flag, allocation counter and full published definition/
dependency history. Extra inactive Types are deliberately conflicts too: this is
a dedicated Demo database contract, not a generic configuration migration tool.
Do not delete historical data to satisfy it; investigate and obtain review.

## Atomic write scope and history

Gate FOR UPDATE → configuration table/row locks → Session/Scenario/ledger/owned
graph table locks. All lock waits are bounded at 3s, SQL statements at 5s, and CLI
query response waits at 6s, including COMMIT. ALREADY_APPLIED acknowledgement loss
also confirms independently and preserves its read-only outcome.
Verify no active Session, no Scenario/ledger, no dataset series owned by any
retained Session, and exact legacy configuration. Write only CAPEX:

- Keep DEMO_GUIDED_SUMMARY Type UUID/DAG/activation; increment definition counter
  from 1 to 2. Keep its entire published v1 row and zero dependencies intact.
- Insert published v2 requiring FAB_COST.
- Insert active DEMO_CAPEX_TABLE_Y / demo_capex_table_y, with published v1 requiring FAB_COST.
- Verify exact target, then transition Gate to WORKFLOW_OPEN in the same COMMIT.

The other five Domains are read-only. Existing Core Dataset/Run/Retry/Reconcile,
snapshots, state machines and FakeExecutor are reused without modification.
Startup validation must recognize the exact target under WORKFLOW_OPEN instead
of incorrectly requiring legacy single-Type CAPEX. Other states retain legacy
startup compatibility checks. Templates remain PREVIEW and Frontend UI is not
enabled/modified. Owner explicitly authorized only two 13→14 inventory numbers
in the existing browser-smoke fixture.

## Offline runbook and failed deployment recovery

1. Follow the first-installation admission-drain runbook if Gate-aware binaries
   are not installed. The old Backend must not be restarted while users remain.
2. Confirm DRAINING using the trusted admission operator. Preserve its irreversible
   barrier. Resolve unknown Scenario/Reset outcomes and explicitly clean inactive
   session-owned work using reviewed existing ownership-aware procedures. Cutover
   never deletes it for you.
3. Independently prove the Backend is stopped, ingress is closed, requests/queues/
   in-flight operations have ended, and no old binary, seed, admin or external
   writer is using the DB. SQL active-count zero is insufficient proof. Preserve
   backups, immutable images, configuration and a tested restore plan.
4. Keep traffic closed; explicitly apply migrations with the compatible new
   operator image against the intended Demo DB. Migration itself performs no cutover.
5. Set the private DEMO_CUTOVER_DATABASE_URL_FILE (or URL, exactly one), then run
   `npm run demo:cutover -- status` and `npm run demo:cutover -- cutover`.
   For Compose use the reviewed project/env file and `--profile operations run
   --rm --no-deps -e DEMO_CUTOVER_DATABASE_URL_FILE=/run/secrets/database_url operator
   cutover` (or cutover-status). Explicitly naming the mounted secret is required;
   the operator must not infer it from the runtime/admission/seed target.
6. A confirmed WORKFLOW_OPEN + complete target is success. A lost COMMIT response
   discards the socket and independently locks/reloads all configuration. Confirmed
   DRAINING+legacy is NOT_APPLIED and permits an explicit retry; UNKNOWN means keep
   traffic closed and diagnose/confirm using a fresh connection, never guess.
7. Start only the compatible new Backend, verify readiness/state/target and then
   explicitly decide whether to reopen traffic. New Session creation is allowed;
   new Legacy Scenario creation is denied. This does not activate a Workflow UI.
8. If deployment fails after cutover, retain closed ingress and use status. Do not
   run legacy seeds, reverse Gate, auto-down, delete configuration/history, or start
   an unaware old image. Use a reviewed compatible forward fix or approved backup
   restore with explicit data implications. Down intentionally refuses completed
   or partial target configuration. Before application, guarded down preserves the
   prior Gate row/state/timestamp. No production operation is executed by this PR.

## Verification

Real PostgreSQL tests exercise exact configuration/v1 preservation, conflicts,
data preconditions, all-or-nothing rollback, concurrent operators and Session
admission, fresh-connection unknown-COMMIT confirmation while the original
transaction remains active, lock timeout/unavailability, idempotent replay with
write-blocking triggers, startup and unchanged Core two-Job CAPEX execution.
Final local verification on 2026-10-29 (Asia/Taipei), Node v24.18.0 /
PostgreSQL 18.6: **681 passed, 0 failed/skipped/cancelled/TODO**, counting each
suite once (including Node parent test counters). Every final command exited 0:

| Command (`npm.cmd run ...`) | Passing tests |
|---|---:|
| test:demo-05c3a | 29; 32 independently owned migrated databases |
| test:milestone | 259; includes CON-01/02 and isolated raw ingestion |
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
| test:demo-05c2 | 22 |
| test:demo-04-containers | 15; actual production-image operator/TLS/UI/restart |
| ui:test | 41 |
| ui:smoke | 10; actual Chromium/Vite/Backend/PostgreSQL |

Also PASS: build, test:demo-05c3a:typecheck (strict, including CLI/new migration),
test:demo-04/05a/05b1/05b2/05c1/05c2:typecheck, ui:typecheck, ui:build,
root/frontend npm audit --audit-level=high (zero vulnerabilities), git diff --check
and staged checks. CI now runs the new focused suite/typecheck; remote results
are separate from this local evidence. Repeated development/final runs are not
added again to the total.

The final cutover suite verifies original v1 JSON/UUID/publication-time equality,
exact ten active Types/two CAPEX Types/eleven definitions, unchanged other five
Domains, no cleanup of retained data, conflict refusal and total rollback. Write-
rejecting triggers prove ALREADY_APPLIED performs no INSERT/UPDATE/DELETE even
with active Workflow Sessions. Original-transaction barriers and pg_blocking_pids
prove independent confirmation really waits on the original PostgreSQL backend
before COMMIT/ROLLBACK, or returns UNKNOWN on timeout. The read-only replay ACK-
loss path is also confirmed independently. Two concurrent operators produce one
APPLIED and one ALREADY_APPLIED; waiting Session admission sees the complete target
only after COMMIT. Existing Core APIs freeze v2/v1 FAB_COST dependencies for the
two CAPEX Jobs and explicitly publish their Dataset without new execution logic.

All 32 new fixtures recorded zero remaining backends and normal DROP (no FORCE).
Final Compose project `demo04_test_c7f96405abad` removed its owned volumes after
explicit fixture-only maintenance, offline cutover, exact v1 checks, new-binary
restart/readiness and HTTPS Session/Legacy-Scenario admission checks. Maintenance
was a separate existing Reset procedure in test setup, never a cutover action.
Chromium fixture `demo03_browser_18940_055bcb263cb3` also recorded zero backends and
normal DROP. The source test service contained only maintenance DB `postgres`
before its container/anonymous volume and private target file were removed.
No persistent developer or production DB was used.

Problems identified and resolved: startup previously assumed legacy single-Type
CAPEX and now validates the exact Workflow target; old drain's uncertain-outcome
path now rejects WORKFLOW_OPEN; the first retained-graph test fixture omitted a
required UUID and was fixed before final runs. Historical migration tests retain
their original rollback targets with a separately tracked two-migration Gate
fixture. Latest-inventory assertions are 14; Demo-05C-2's Gate-removal test now
removes the extension and Gate together. No historical migration SQL was edited.

Acceptance criteria 1–8 are satisfied by the implementation/local verification:
one atomic transaction; v1 preservation; exact target; read-only idempotency;
independent unknown-COMMIT confirmation; fail-closed conflicts; preserved Guided/
Core behavior; all new/existing regression suites PASS. No known implementation
blocker remains. Offline process/writer verification, actual production operation
and System Owner Review remain Owner responsibilities. No merge or live cutover.
