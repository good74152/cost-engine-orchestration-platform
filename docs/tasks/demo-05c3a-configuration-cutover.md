# Demo-05C-3A — CAPEX Configuration Cutover Operator

Baseline main `04d7e51f4c9a432b23cca2b4cedb118ce8a5a070` (PR #39 confirmed
merged before implementation). Branch `codex/demo-05c3a-configuration-cutover`.
Authority: System Owner's bounded specification; await System Owner Review.
This task builds capability and uses disposable databases only, never production.

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
Final executed commands and teardown evidence will be recorded below.
