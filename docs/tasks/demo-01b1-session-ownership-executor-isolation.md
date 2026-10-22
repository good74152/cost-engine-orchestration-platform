# Demo-01B-1 — Session Ownership & FakeExecutor Isolation

Status: implementation/verification in progress; System Owner review required.
Specification authority: System Owner's Demo-01B-1 request, 2026-10-23.

## Goal and baseline

Provide end-to-end ownership enforcement within an explicitly selected Demo
runtime, with one independent FakeExecutor per authenticated session. Task 007's
canonical identity, state machines, snapshots, executor contract, SQL transaction
boundaries and lock ordering remain unchanged. No Reset or restart recovery.

Started from latest fetched main `50e88c2` on
`feature/demo-01b1-session-ownership-executor-isolation`. Task 007 final acceptance
is recorded in docs/verification/task-007-final-acceptance.md; Demo-01A merge
`5ed9e40` (PR #15) is an ancestor. Baseline Demo-01A real PostgreSQL suite was
rerun: exit 0, 18 pass, zero failures/skips/cancellations/TODOs.

## Approved scope and API boundary

- `APP_MODE=demo` explicitly selects the isolated route surface. Unset mode
  defaults to existing `core`; only exact `core` and `demo` are accepted.
  Unknown, empty or conflicting configuration fails startup. Demo requires
  an explicit development/test environment; production cannot be overridden by
  injected test options. A global executor cannot be injected into demo mode.
- Demo mode exposes only health, existing session create/current APIs and the
  protected routes below. It does not register original Domain write routes,
  internal fake controls, callback or raw-ingestion routes. Core mode retains
  all existing behavior, including supported raw ingestion.
- Each protected POST authenticates before body processing, applies the same
  CSRF policy as session creation, then enters the shared per-session coordinator.
  Durable session revalidation, ownership validation and the Domain command
  execute within that operation. Different sessions are independent.
- Reuse Demo-01A cookie, lifetime, no-store, logging and revocation policies.
  Every POST requires `X-Demo-Session: 1`; supplied Origin must match configured
  or direct origin; cross-site Fetch Metadata is rejected. No credentialed CORS.
  Supply `{}` for commands without other fields. GET/current remains read-only.

| Route | Request | Success |
|---|---|---|
| POST /demo/dataset-versions | exactly domain, fiscalYear, period | existing creation DTO, 201 |
| POST /demo/dataset-versions/:id/submit-validation | {} | existing lifecycle DTO, 200 |
| POST /demo/dataset-versions/:id/publish | {} | existing lifecycle DTO, 200 |
| POST /demo/dataset-versions/:id/reject | {} | existing lifecycle DTO, 200 |
| POST /demo/dataset-versions/:id/abandon | {} | existing lifecycle DTO, 200 |
| POST /demo/calculation-jobs/:id/run | {} | existing Run DTO, 200/202 |
| POST /demo/calculation-jobs/:id/reconcile | {} | existing reconcile DTO, 200 |
| POST /demo/fake-executor/dispatch-behavior | {behavior} | {behavior}, 200 |
| POST /demo/execution-attempts/:id/fake-state | {state} | {executionAttemptId, state}, 200 |

Creation rejects any client companyCode, session ID, calculation type/version or
upstream selector. The validated session supplies companyCode to the unchanged
creation service. Foreign/missing/malformed resource identifiers uniformly
return 404 DEMO_RESOURCE_UNAVAILABLE; no session is 401 DEMO_SESSION_UNAVAILABLE.
Invalid input uses 400 INVALID_REQUEST; valid owned Domain commands retain their
existing readiness/state/dispatch errors. CSRF uses 403
DEMO_SESSION_CSRF_REJECTED and the inherited coordinator capacity uses 429
DEMO_SESSION_QUEUE_FULL. Internal/invariant failures stay sanitized 500 errors.

## Executor isolation

The registry is owned by one application runtime, keyed only by authenticated
session ID. A session reuses its instance for Run, Retry, Reconcile and controls.
Each new session receives a distinct FakeExecutor object; no executions, scripts,
history, unavailable state or ADR-0008 rejection tombstones cross instances.
Registry allocation is bounded to 1024 sessions by default; exhaustion returns
503 DEMO_EXECUTOR_CAPACITY_REACHED before preparing/dispatching a Run. Do not
evict instances on expiry: doing so could discard execution/rejection history.
No automatic cleanup or background infrastructure is added.

The behavior control appends one of ACCEPT, REJECT, ACCEPT_THEN_UNKNOWN or
UNKNOWN_WITHOUT_CREATION to the current session's script. The state control
accepts only SUCCEEDED or FAILED, validates attempt ownership, and reads the
full DAG/run identity from PostgreSQL. It never trusts a client execution ID,
updates DB job/attempt status, or reconciles automatically. Reconcile still
queries executor truth and atomically records the existing transitions.

Ownership links are immutable in supported application code. Validator reads do
not introduce orchestration locks; the coordinator holds no SQL transaction
while waiting or spanning executor calls. Existing services retain their locks
and transaction A/B/external-call/C boundaries. Expiry/revocation denies queued
operations at admission but does not cancel admitted work.

## Verification and delivery

Use fully migrated owned disposable PostgreSQL databases, Node test runner and
Fastify.inject. Cover two-session same-coordinate creation, foreign dataset/job/
attempt denial without DB/executor effects, companyCode rejection, independent
scripts/state/tombstones/history, all four dispatch behaviors, failure/retry and
reconcile, lifecycle wrappers, blocked anonymous bypass routes, CSRF/auth/expiry/
revocation, deterministic same/different-session barriers, queued expiry and
failure release, config/production rejection and unchanged core behavior.

Run build, Demo-01A suite, the dedicated Demo-01B-1 suite and unchanged milestone.
Record exact revision/tree, environment, exit codes, counters, warnings and
owned teardown. Commit/push/open PR to main; do not merge automatically.

## Limits

Isolation applies to this one explicitly configured Demo runtime. Do not expose
an anonymous core runtime against the same database. Shared calculation-type
configuration is platform-owned, not client-editable. The registry and queue
are process-local; persisted sessions do not imply fake execution restart
recovery. No Reset, data cleanup, cookie clearing, scenario/UI, real Airflow,
distributed coordination, general idempotency or cloud deployment. **This
milestone is still not safe for direct public deployment.**
