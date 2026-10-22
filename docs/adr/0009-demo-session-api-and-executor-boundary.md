# ADR-0009 — Demo Session API and Executor Boundary

- Status: Accepted
- Date: 2026-10-23
- Decision owner: System Owner
- Authority: explicitly supplied Demo-01B-1 bounded specification; implementation
  and verification remain subject to Code Review, not automatically accepted.

## Context

Demo-01A provides durable sessions, ownership validators and an operation queue,
but intentionally leaves Domain APIs unauthenticated. Protected wrappers alone
cannot isolate users if anonymous original routes remain reachable. A single
global FakeExecutor would also share scripts, state and rejection history.

## Decision

Explicit APP_MODE=demo registers only session APIs, health and protected /demo
commands. Default core behavior remains separate and unchanged. Unknown or
conflicting mode configuration fails startup. Demo mode never overrides the
existing development/test-only FakeExecutor environment restriction.

Authenticate every Demo command and apply shared CSRF checks. Inside the
session coordinator, revalidate durable eligibility, validate persisted
ownership, then call unchanged Domain services. Creation accepts only domain,
year and period; the authenticated session supplies companyCode. Foreign and
nonexistent resources share a generic 404. No client execution identity is
accepted by fake state controls.

One session owns one process-local FakeExecutor instance used consistently by
Run/Retry/Reconcile/controls. Distinct sessions never share instances or any
mutable fake state. Bound the registry; do not evict an existing identity's
execution/rejection history for space. State controls modify only the fake;
reconciliation remains the sole authority for persisted execution results.

## Consequences and rejected alternatives

Do not register anonymous Domain/raw/callback/internal-control routes in demo
mode; protected wrappers alongside those routes were rejected as bypassable.
Do not add cookie authentication globally to core routes. Do not rewrite Domain
services or use the session queue instead of PostgreSQL locking/constraints.

No in-memory queue or registry is a multi-instance/restart guarantee. Do not
expose core mode against demo data to untrusted users. Reset, cleanup, restart
recovery and public deployment readiness remain outside Demo-01B-1. Existing
ADRs 0001–0008, historical migrations and executor semantics are unchanged.
