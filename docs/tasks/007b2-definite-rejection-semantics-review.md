# Task 007B-2 — CON-02 Definite-Rejection Identity Guarantee (Architecture Decision Required)

- Status: **BLOCKED for Codex implementation** until the system owner selects a contract and accepts an ADR if the executor guarantee changes.
- Evidence: docs/tasks/007a-investigation-results.md and 007a-investigation-evidence.json on feature/task-007a-concurrency-investigation.
- Severity: high under the currently implemented FakeExecutor behavior.
- This is NOT an implementation spec. It records the decision that implementation must not make by itself.

## Proven incident (not a hypothetical adversarial executor)

Two concurrent /run requests dispatch the same durable execution attempt X with the same DAG/run identity.

The existing unmodified FakeExecutor can process A as REJECTED with zero runs, then B as ACCEPTED creating external X. With responses recorded A-first:
~~~text
external:
A REJECTED, no X existed at A processing time
B ACCEPTED, X exists

database:
A records attempt 1 DISPATCH_FAILED, job PENDING
B attempts to record ACCEPTED, receives HTTP 500
attempt 1 stays DISPATCH_FAILED; job remains PENDING
external X is RUNNING
~~~

Manual/callback reconciliation of X fails 409 EXECUTION_NOT_RECONCILABLE. A new /run allocates attempt 2 with a new identity Y, potentially creating a second external execution. Exactly these outcomes were captured with deterministic barriers and real PostgreSQL in 007A.

In contrast, when B's ACCEPTED record wins the race, the existing path handles late rejection idempotently; and when X already exists at executor processing time, FakeExecutor returns ALREADY_EXISTS. Separate tests with a *lying* executor returning REJECTED for an already-created X are explicitly contract violations and do not establish the supported path.

## Why a local conditional UPDATE is insufficient

- DISPATCH_FAILED is terminal and means the platform has definitive no-run evidence.
- Changing DISPATCH_FAILED to ACCEPTED after receiving B's success would rewrite terminal execution history and contradict the accepted state machine/ADR-0005.
- Ignoring B's acceptance or returning 200 while leaving DISPATCH_FAILED would strand a real external run.
- Suppressing concurrent Run through an in-memory mutex would fail across processes and process restarts.
- Querying executor NOT_FOUND immediately before A commits DISPATCH_FAILED does not rule out B creating the run a moment later (TOCTOU).
- The external call cannot be wrapped in the database transaction/row lock that owns orchestration state.

Therefore choose and document a guarantee before coding.

## Design option A — Identity-scoped permanent definite rejection (recommendation for current FakeExecutor milestone)

Interpret REJECTED for X as an identity-wide, irrevocable assurance: **no execution exists for X, and no subsequent dispatch of the same identity X can create one**. This is stronger than today's per-call FakeExecutor behavior and must be explicitly accepted as a new executor-adapter contract (separate ADR).

Expected FakeExecutor behavior:
- A first REJECTED for X is durably remembered by the FakeExecutor as a rejection tombstone for identity X.
- Any future dispatch of X, including an overlapping delayed or repeated call, also returns REJECTED and never creates X.
- If X was accepted/created first, subsequent calls return ALREADY_EXISTS, regardless of scripted later REJECT behavior.
- UNKNOWN_WITHOUT_CREATION does not set a rejection tombstone; the same identity may be safely redispatched.
- New execution attempt Y after a genuine terminal DISPATCH_FAILED uses a new identity; it may be accepted.
- The result must be deterministic under concurrent calls and documented in CalculationExecutor contract.

Positive: preserves existing attempt states, terminal immutability, lock ordering, DB schema, and the Task-004 Run/Retry flow. Negative: strengthens adapter requirements; not every real executor rejection/transport error can be classified REJECTED. A future real Airflow adapter must return UNKNOWN unless it can uphold this identity-wide guarantee. The FakeExecutor tombstone itself is per in-memory FakeExecutor instance; do NOT claim this proves a distributed production Airflow adapter guarantee.

## Design option B — Durable cross-request dispatch arbitration

Keep REJECTED as a per-request no-run fact but ensure no overlapping/late dispatch of the same identity can create X after local terminal rejection.

This requires a durable multi-process single-flight/lease or an equivalent arbitration protocol that survives crash/retry and handles ambiguous outcomes without holding DB transactions through external calls. It likely requires new durable state/columns, liveness rules and an ADR; it is outside a minimal hardening patch.

Positive: weaker demands on real executor behavior. Negative: substantially greater engineering scope and failure modes; cannot silently piggyback Task 007B-1.

## Design option C — Redesign DISPATCH_FAILED terminal semantics

Permit compensating transition/retraction after subsequent confirmed acceptance, add a new decision state, or defer terminal rejection until concurrency certainty is established.

Rejected as a bounded Task 007B tactic: rewrites accepted terminal-history/state-machine semantics and introduces difficult crash/retry invariants. Only consider via a separate architecture initiative and migration review.

## Recommendation and decision gate

For a portfolio milestone using only a FakeExecutor, **Option A** is the most bounded and consistent with existing transaction/state-machine protocols, provided the system owner explicitly accepts that REJECTED becomes an identity-wide irrevocable guarantee for adapters.

If the goal is realistic cross-process behavior without imposing that guarantee on a future Airflow adapter, choose Option B and treat CON-02 as a separate architecture milestone, not a silent Task 007B change. In either case, zero-known-critical-regressions acceptance remains blocked until the supported combination is safe.

The system owner must decide:

1. Is REJECTED allowed only when the executor/adapter can guarantee permanent no-run for the exact DAG/run identity, even under concurrent/repeated calls?
2. If yes, record new ADR and bound implementation to FakeExecutor + contract semantics and tests; no production Airflow integration.
3. If no, authorize a separate design review for a durable dispatch arbitration mechanism, rather than asking Codex to improvise.

## Tests required after decision (not yet authorized)

- Deterministic REJECT-first and ACCEPT-first concurrent same-identity dispatch under chosen semantics.
- No external/local identity split and no duplicate external execution on retry.
- All accepted recovery paths remain safe (ACCEPT_THEN_UNKNOWN, ALREADY_EXISTS, retry after terminal rejection).
- If option A: tombstone suppresses later same-identity creation; new attempt identity can be accepted; UNKNOWN never tombstones.
- Historical 007A evidence retained, but regression expectations updated to **accepted** contract — do not encode pre-fix behavior as normal or hide red tests with skip/TODO.
- Real PostgreSQL acceptance, transaction-boundary and lock-order assertions preserved.
