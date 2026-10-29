# ADR-0018 — Atomic Demo Workflow Configuration Cutover

- Status: Accepted bounded System Owner specification; implementation awaits review.
- Baseline: Demo-05C-2 PR #39 merged at `04d7e51`.
- Supplements ADR-0003/0006/0010/0011/0017; no Core execution changes.

## Configuration and Gate versioning

Extend the existing singleton in place: LEGACY_OPEN → DRAINING → WORKFLOW_OPEN.
No skip, reversal, deletion, truncation or state reset is allowed. Session admission
accepts either open state; new Legacy Scenario admission accepts only LEGACY_OPEN.
Existing Scenario replay/recovery remains unchanged. Old drain rejects WORKFLOW_OPEN
without changing it, including unknown-COMMIT confirmation. Templates remain PREVIEW.

Keep CAPEX/DEMO_GUIDED_SUMMARY and its published zero-dependency Definition v1
unchanged (UUID, timestamps and dependencies). Allocate/publish v2 requiring
FAB_COST and advance only that Type's definition counter. Add active
DEMO_CAPEX_TABLE_Y / demo_capex_table_y with published v1 requiring FAB_COST.
Other five Domains and all their definitions remain untouched. Strict verification
expects the complete dedicated Demo catalog: nine legacy or ten target Types,
their exact DAGs/activation/counters, and exact published definition/dependency
sets. Unexpected inactive Types/definitions also require review, never repair or
deletion. This conservative operator is for the dedicated Demo configuration.

## Atomic transaction and lock order

Use READ COMMITTED, lock_timeout 3s, statement_timeout 5s and a CLI query timeout
of 6s (including COMMIT response wait). Acquire Gate FOR UPDATE,
then configuration table locks (calculation_types, definition versions, dependency
rows) in that order; then Session, Scenario, ledger and dataset graph table locks
in explicit parent-first order. Configuration tables use SHARE ROW EXCLUSIVE;
owned-data tables use SHARE to stabilize SQL precondition checks against writes.
Gate precedes all Session locks, and configuration precedes graph locks, respecting
the existing admission and First Run class order. These are offline-tool locks,
not changes to Core locks. No executor/network service is called in the transaction.

Under DRAINING, verify no active Session, no Scenario/ledger, and no dataset series
owned by any retained Session (therefore no FK-connected Job/Attempt/snapshot
graph). Verify the entire legacy catalog, write only the new CAPEX configuration,
verify the entire target, then update Gate to WORKFLOW_OPEN and COMMIT together.
No history cleanup is performed. A failure before COMMIT rolls back all changes.

## Idempotency and unknown COMMIT

DRAINING + exact legacy catalog + all SQL preconditions allows first application.
WORKFLOW_OPEN + exact target returns ALREADY_APPLIED using reads/locks only,
even if new Sessions now exist. Any other combination fails closed. No UPSERT,
metadata rewrite, automatic repair or partial completion is permitted.

Destroy an ambiguous COMMIT socket and connect through a genuinely independent
Client. Reacquire the same Gate and table locks, then read fresh durable state
and the complete configuration. WORKFLOW_OPEN + target confirms completion;
DRAINING + legacy confirms NOT_APPLIED, permitting an explicit retry that rechecks
all preconditions. Lock timeout, unavailable DB, partial configuration or any
other state remains explicitly UNKNOWN. No automatic retry loop is introduced.
The read-only ALREADY_APPLIED path uses the same independent confirmation if its
COMMIT acknowledgement is lost, preserving that outcome without rewriting data.

## Offline deployment, failed deployment and rollback

An operator must separately prove the Backend is stopped, requests and queued/
in-flight work are finished, uncertain Reset/Scenario outcomes are resolved, and
no old binary/seed/admin/external writer can access this database. SQL counts and
locks cannot establish process quiescence. Drain must already be confirmed. Keep
ingress closed across backup, migration, cutover and new-binary verification.

On failed deployment, keep traffic closed and use status/durable confirmation;
never rerun a legacy seed, reopen Gate or infer rollback from a lost response.
Use a compatible new binary/forward fix after verified backup/restore planning.
Startup validation recognizes WORKFLOW_OPEN only with the exact target catalog;
legacy startup validation is retained for the earlier states. An old binary
cannot safely serve WORKFLOW_OPEN. Down refuses WORKFLOW_OPEN or target CAPEX
configuration, retaining the completed cutover and v1 history. Before application,
down only removes the state extension and preserves the row/state/timestamp.
No automatic down, production cutover or deployment is authorized by this task.
