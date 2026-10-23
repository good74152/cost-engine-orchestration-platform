# ADR-0010 — Demo Session Reset and Recovery

- Status: Accepted
- Date: 2026-10-23
- Authority: System Owner's Demo-01B-2 specification. Implementation awaits review.

## Decision

Only a single Demo backend instance is supported. Reset reserves an idle session
synchronously, outside its normal operation queue. Running or queued requests
conflict; an idle RUNNING calculation does not. New commands cannot enter while
reset or uncertain-outcome recovery holds the reservation.

Lock the durable session, validate it, delete only its company-owned orchestration
graph in FK order, and revoke the session in one transaction. Never change the
financial state machines to make deletion possible. Foreign references fail
closed. Shared configuration, assets, raw ingestion and session history remain.

Release that session's fake only after confirmed commit. Unknown COMMIT outcomes
retain admission blocking. A new connection obtains the session row lock before
reading durable revocation and remaining owned data; this waits for the original
transaction's outcome, rather than mistaking an old MVCC view for rollback.
If resolution is unavailable, return 503 and retain the reservation. Explicit
maintenance can retry resolution. Rollback restores eligibility and retains the
original fake, without recreating or rewriting its state.

Real Demo server startup invalidates previous sessions before listening, because
fake execution state is not durable. buildApp has no invalidation side effect.
Bounded explicit maintenance reuses the same owner-scoped cleanup for inactive
sessions and releases inactive fakes. No worker or distributed recovery is added.

## Consequences

Invalid session responses clear the backend-owned HttpOnly cookie. Startup
failure is closed. Invalidation does not reconcile, cancel or invent execution
results. Do not run another Demo/core writer against this database concurrently.
ADRs 0001–0009, applied migrations and core orchestration locks are unchanged.
