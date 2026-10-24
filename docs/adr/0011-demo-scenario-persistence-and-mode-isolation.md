# ADR-0011 — Demo Scenario Persistence and Mode Isolation

- Status: Accepted
- Date: 2026-10-24
- Authority: System Owner's Demo-02B bounded specification. Implementation and
  verification require Code Review; this is not implementation acceptance.

## Decision

One durable Scenario belongs directly to one demo_sessions row. A PostgreSQL
UNIQUE(session_id), restrictive FK and type/status/nonnegative-step checks are
correctness backstops. Create accepts only HAPPY_PATH and inserts READY/0.
There is no Step Runner, progress command, ledger or requestId protocol here.

Authenticate and admit Create/Get through the existing Demo coordinator. Create
locks the session, revalidates it in a fresh statement and checks for an existing
Scenario first. Same-type retries return its current durable DTO unchanged.
Only the first insert requires compatible read-only Demo-02A configuration and
an empty company-owned domain graph. No automatic seed, repair or deletion.
ON CONFLICT(session_id) DO NOTHING plus durable reload handles unique conflicts.

The same session queue protects manual-mode admission. If a Scenario exists,
reject all manual Demo domain/fake mutations; retain reads and Reset. Admission
uses a short session-row transaction and fresh Scenario read, then commits
BEFORE unchanged Domain services/executor work. This also waits out an earlier
ambiguous Create COMMIT. No session lock spans an executor call, and no core lock
order changes. Different sessions remain independent.

Unknown Create COMMIT does not imply rollback: discard the suspect connection
and return an explicit retryable unknown-outcome error. The next Create locks
the session and reads durable state; it does not blindly insert another row.
This is Create idempotency, not future Step idempotency.

Extend ADR-0010's existing reset transaction with owner Scenario deletion before
domain cleanup and revocation. Rollback retains all three and the fake. Unknown
reset resolution must check remaining Scenario AND domain data after acquiring
the durable session lock. Revocation plus a remaining Scenario is not complete
reset success. Maintenance must discover Scenario-only inactive owners, using
the same bounded cleanup/reservation path. Startup still invalidates old sessions;
persisted progress does not resurrect old fake state or credential eligibility.

## Limits

Single Demo backend, no concurrent core/external writer or independent config
administration. Historical migrations, canonical identity, financial state
machines, snapshots, executor semantics and cookie/collision policies are
unchanged. Schema reserves three Scenario types/statuses; only HAPPY_PATH is
creatable and READY is the only initial application state. Future Demo-02C must
define step transactions/recovery before adding progress execution.
