# ADR-0008 — Identity-Scoped Definite Dispatch Rejection

- Status: Accepted
- Date: 2026-10-12
- Decision owner: System Owner
- Related: ADR-0005; Task 007A CON-02; Task 007B-2

## Context

ADR-0005 says a definite executor rejection can transition an execution attempt from DISPATCHING to DISPATCH_FAILED when the backend has certainty that no external execution was created. It does not explicitly define the *time and identity scope* of this certainty.

Task 007A reproduced a critical race on real PostgreSQL using the unmodified current FakeExecutor:

1. Two overlapping /run requests dispatch the same durable execution attempt and same (airflow_dag_id, airflow_dag_run_id) identity X.
2. The FakeExecutor processes request A first as REJECTED while no X exists.
3. It processes B later as ACCEPTED, creating X.
4. A records DISPATCH_FAILED first; B fails to record ACCEPTED (HTTP 500) because the local attempt is now terminal.
5. External X runs while local X is DISPATCH_FAILED and unreconcilable. Retrying allocates a different attempt identity and may create duplicate external work.

The existing FakeExecutor's REJECTED result was only true about a particular call at its processing time, not irrevocably true about X. 007A showed that the problem occurs under that real FakeExecutor behavior, not only under a deliberately dishonest test adapter.

The separate CON-01 (late ACCEPTED after already-terminal reconciliation) is addressed by Task 007B-1; it does not resolve this rejection race.

## Decision

### Identity-wide, permanent definite rejection

For the exact executor identity:

```text
(airflow_dag_id, airflow_dag_run_id)
```

`DispatchResult.kind === 'REJECTED'` is an **irrevocable identity-scoped no-run guarantee**:

- No external execution with that identity was created.
- No execution with that same identity can later be created, even by overlapping, repeated, delayed, or retried dispatch calls.
- The guarantee is about the identity, not merely the individual HTTP request.
- The guarantee must remain true despite response delay, retries, and concurrency across all adapter instances capable of dispatching to that execution namespace.

If an adapter cannot establish and enforce all of the above, it **must not** return REJECTED. In an inconclusive outcome it returns UNKNOWN and retains the durable DISPATCHING attempt for lookup/recovery using the same stable identity.

This extends/clarifies the executor boundary in ADR-0005; it does **not** add or change any job/attempt state transition.

### Identity decision must be monotonic

For any one identity X, the executor/adapter must expose one coherent external decision:

```text
UNSEEN → REJECTED_PERMANENTLY
UNSEEN → EXISTS
```

Once permanently rejected, every same-identity dispatch returns REJECTED and no X may be created.

Once X exists, every same-identity dispatch must return ALREADY_EXISTS or an equivalent acceptance confirmation, irrespective of later configured rejection behavior. Its execution state may advance through RUNNING/SUCCEEDED/FAILED without changing that creation fact.

UNKNOWN is **not** an identity decision: UNKNOWN may mean either creation with a lost response or no creation yet, and never creates a permanent rejection marker merely by itself. The next call uses the same identity and may return ALREADY_EXISTS, ACCEPTED, REJECTED (only if the irrevocable guarantee can now be made), or UNKNOWN.

### FakeExecutor implementation for this milestone

The FakeExecutor is the sole implemented CalculationExecutor; there is no real Airflow adapter.

Implement an in-memory permanent-rejection set (tombstones) keyed by the same full identity as the external execution map. Preserve the identity result check order:

1. If external execution X already exists, return ALREADY_EXISTS.
2. If X is permanently rejected, return REJECTED, with no creation and no consumption of another scripted behavior.
3. Otherwise consume the configured dispatch behavior. On REJECT, install X's permanent rejection marker **before returning** REJECTED.
4. On ACCEPT or ACCEPT_THEN_UNKNOWN, create X once.
5. On UNKNOWN_WITHOUT_CREATION, do not tombstone; leave X open to same-identity recovery.

The check/decision/create operation must be atomic with respect to concurrent dispatches **within one FakeExecutor instance**. In the current synchronous in-memory implementation this can be satisfied without an await between inspection and state update; any future async implementation must preserve per-identity atomicity.

Tests must not assume a FakeExecutor tombstone survives a process restart, is shared across multiple Node processes, or coordinates with a different FakeExecutor instance. The fake is explicitly non-production and state is instance-local. These properties do **not** prove a future real Airflow adapter can satisfy the guarantee.

The platform must not silently use FakeExecutor as a horizontally distributed or production execution service. Existing configuration already disallows it in production.

### Durable orchestration effects

When the adapter makes an identity-wide permanent rejection and the backend commits it, the existing transition stays:

```text
DISPATCHING → DISPATCH_FAILED
job remains PENDING or FAILED
```

A retry after DISPATCH_FAILED creates a **new** execution_attempt with a distinct execution identity, retaining the same immutable dataset snapshot.

For two same-identity dispatch calls that both observe the permanent rejection, concurrent local recording converges to the existing DISPATCH_FAILED state idempotently; neither may create X.

When X was accepted first, later calls return ALREADY_EXISTS and local acceptance handling remains idempotent.

Never repair the old CON-02 reproduction by changing DISPATCH_FAILED to ACCEPTED, rewriting terminal history, or pretending an observed accepted execution does not exist.

### Future real executor contract

A future Airflow adapter must demonstrate it can uphold the identity-wide guarantee against all dispatchers sharing its execution namespace before it uses REJECTED. A per-request 4xx, request validation failure, timeout, transport failure or not-found lookup is **not automatically** evidence of irrevocable no-run.

If no such permanent guarantee is enforceable, the adapter must use UNKNOWN and rely on reconciliation. This milestone does not add a real Airflow adapter or distributed dispatch arbitration.

## Alternatives Considered

### Per-request REJECTED plus local recording precedence

Rejected. Task 007A proved that recording DISPATCH_FAILED first can strand an external execution created by another same-identity dispatch. Accepting the second response would require rewriting terminal history. A later executor status lookup cannot close the TOCTOU window while another dispatch is still able to create X.

### Durable single-flight dispatch arbitration

Not chosen for this bounded FakeExecutor milestone. It could support weaker external rejection contracts, but requires durable ownership, crash recovery, leases/fencing, and liveness rules across processes. A separate ADR/task would be needed if future requirements justify that complexity.

### Allow DISPATCH_FAILED → ACCEPTED or a compensating state

Rejected because it redefines immutable historical attempts, changes the accepted state machine, and introduces reconciliation/callback races.

### Process-local mutex as a production guarantee

Rejected. In-memory coordination across one Node process does not persist across process restarts or protect multiple application instances.

## Consequences

Positive:
- Existing Task-002–006 state machines and PostgreSQL lock order remain unchanged.
- Same-identity REJECTED and later ACCEPTED cannot legitimately coexist under the strengthened executor contract.
- Definite rejection still supports retry via a new execution attempt identity.
- Ambiguous outcomes remain recoverable using the same identity.
- Task 007B-2 can be implemented as a narrowly bounded FakeExecutor/contract correction, with real PostgreSQL regression tests.

Trade-offs:
- The executor interface has a stronger semantic obligation than an individual request's result.
- Future Airflow adapter implementations must be conservative about returning REJECTED.
- The FakeExecutor tombstone is instance-local; it is a deterministic test/demo implementation, not distributed durability.
- Existing 007A CON-02 FakeExecutor tests must be updated from intentionally red old-behavior evidence to tests asserting the newly accepted guarantee; historical evidence remains preserved.

## Required Verification

- REJECT-first, two concurrent dispatches of X: both report REJECTED; external run count remains zero; local attempt DISPATCH_FAILED; no terminal rewrite; retry uses new identity and may create exactly one run.
- ACCEPT-first: subsequent same-X dispatch reports ALREADY_EXISTS; only one external run; local ACCEPTED/RUNNING.
- Repeated REJECTED consumes no additional scripted behaviors and never creates X.
- UNKNOWN_WITHOUT_CREATION is not tombstoned; later same-X dispatch can create X, reusing its attempt identity.
- ACCEPT_THEN_UNKNOWN creates X once; retry of X reports ALREADY_EXISTS; no new attempt.
- Deterministic real PostgreSQL tests verify external count, attempt/job states, response codes and lock/transaction boundaries.
- The deliberately dishonest test executor remains classified as an **adapter contract violation**, not a supported regression to fix by rewriting history.

No claims of milestone completion before the full PostgreSQL suite is green.
