# ADR-0004 — Dataset-Series Serialization and Deterministic Lock Ordering

- Status: Accepted
- Date: 2026-09-06

## Context

The platform performs several operations that can race on the same logical dataset series:

- allocating a new dataset version,
- publishing or rejecting a version,
- abandoning an active version,
- resolving the latest published version as an upstream dependency for another dataset.

Without a shared serialization point, a downstream first Run could race with an upstream Publish and observe ambiguous state. Multi-domain builds may also need to lock several upstream series, creating deadlock risk if different transactions acquire locks in different orders.

The system does not require global serializable isolation for all operations. It needs deterministic ordering around specific lifecycle and visibility decisions.

## Decision

The `dataset_series` row is the primary concurrency coordination root for one logical series.

Operations that allocate versions or depend on publication visibility use explicit row locking on the relevant `dataset_series` row.

This gives a deterministic ordering between upstream publication and downstream snapshot freeze:

```text
Publish locks/commits first
→ downstream first Run sees the newly published version
```

or:

```text
Downstream first Run locks/resolves first
→ it legitimately freezes the previous latest published version
→ upstream Publish waits and commits afterward
```

Both outcomes are valid because each corresponds to a real serialization order.

When an operation needs several dataset-series locks, it must:

1. Determine the complete lock set.
2. Sort by the total ordering:

```text
(domain, company_code, fiscal_year, period)
```

3. Acquire locks in that order.

The ordering exists only to prevent inconsistent lock acquisition and deadlocks. It does not encode business dependency order.

When first Run needs several `calculation_type` coordination rows for dependency-definition resolution, lock them in deterministic order:

```text
(domain, code)
```

Service-level locking is backed by database constraints, including:

- unique canonical dataset-series identity,
- unique `(dataset_series_id, version)`,
- at most one active `DRAFT/BUILDING/VALIDATING` version per series,
- exactly one build snapshot per dataset version,
- at most one job per `(dataset_version, calculation_type)`,
- at most one active execution attempt per job.

The system does not use PostgreSQL `SERIALIZABLE` as the default strategy for these workflows.

## Alternatives Considered

### PostgreSQL `SERIALIZABLE` for all lifecycle transactions

Rejected because it would move correctness into transaction-abort/retry behavior across a broad surface area when explicit row coordination expresses the intended contention more directly. It would also require a more pervasive retry policy.

### Application-level mutexes

Rejected because they do not coordinate safely across multiple backend processes/instances and are not durable database invariants.

### Lock rows in discovery/business dependency order

Rejected because different requests could discover or traverse dependencies in different orders and create deadlock cycles.

### Maintain `active_dataset_version_id` or `latest_published_version_id` pointers on `dataset_series`

Rejected for the current design because they duplicate lifecycle truth and introduce additional synchronization writes. Active state and latest published data are derived from `dataset_versions`, with constraints/indexes supporting those queries.

## Consequences

Positive:

- Publication visibility and downstream resolution have explainable serialization behavior.
- Version allocation is safe under concurrent requests.
- Multi-series dependency resolution has a deterministic deadlock-avoidance rule.
- The design works across multiple application instances because coordination is in PostgreSQL.

Trade-offs:

- Code paths must follow the lock-ordering contract consistently.
- Long transactions while holding series locks can reduce concurrency, so external Airflow calls are forbidden inside these transactions.
- Integration tests must exercise real concurrent PostgreSQL transactions; mocked repositories cannot validate this architecture.
