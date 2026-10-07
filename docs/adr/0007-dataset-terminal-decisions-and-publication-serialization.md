# ADR-0007 — Dataset Terminal Decisions and Publication Serialization

- Status: Accepted
- Date: 2026-10-07

## Context

Calculation execution completion and dataset publication are different business facts.

Task 005 may reconcile every required calculation job to `SUCCEEDED`, but the dataset version intentionally remains `BUILDING` until an explicit validation decision is made. Publication then changes which dataset version downstream First Run operations may resolve as the latest `PUBLISHED` version.

Dataset terminal transitions also release the one-active-version slot enforced for a `dataset_series`. Therefore validation, publication, rejection, abandonment, next-version creation, and downstream snapshot freezing must have explicit serialization rules.

Abandonment has an additional distributed-systems constraint: the current milestone does not implement executor cancellation. The platform must not declare a dataset `ABANDONED` while an execution attempt may still be dispatched or running externally.

## Decision

### Explicit validation boundary

Job success does not automatically advance dataset state.

```text
BUILDING
+ one or more calculation_jobs
+ every calculation_job = SUCCEEDED
→ explicit Submit Validation
→ VALIDATING
```

Submit Validation is one PostgreSQL transaction:

```text
lock dataset_version
→ require BUILDING, unless already VALIDATING
→ lock all calculation_jobs for that dataset_version in deterministic id order
→ require at least one job
→ require every job SUCCEEDED
→ reject internal contradictory active-attempt state
→ BUILDING → VALIDATING
→ set validating_at
→ commit
```

Concurrent reconciliation of the final job serializes through the calculation-job row lock. Submit Validation either observes the job before terminal reconciliation and fails eligibility, or observes the committed `SUCCEEDED` state and succeeds.

### Publication visibility protocol

Publish changes downstream-visible latest-`PUBLISHED` state and therefore participates in the same `dataset_series` coordination protocol used by version allocation and downstream snapshot resolution.

Publish lock order:

```text
dataset_series
→ target dataset_version
```

After both rows are locked, Publish revalidates the target state.

Only:

```text
VALIDATING → PUBLISHED
```

is allowed.

`published_at` is written in the same transaction.

This serializes Publish with:

- Task 002 next-version creation on the same dataset series,
- Task 003 downstream First Run that locks the series before resolving latest `PUBLISHED`,
- other terminal decisions on the same dataset version.

A concurrent downstream First Run therefore observes one of two explainable outcomes: the previously published version, or the newly committed published version.

### Reject and Abandon use the series terminal-decision protocol

Reject and Abandon also acquire:

```text
dataset_series
→ dataset_version
```

Although they do not make a version visible as `PUBLISHED`, they release the active-version slot and therefore serialize with next-version creation.

Reject allows only:

```text
VALIDATING → REJECTED
```

Abandon allows only:

```text
DRAFT → ABANDONED
BUILDING → ABANDONED
```

`VALIDATING` must be resolved through Publish or Reject, not Abandon.

### Safe abandonment without cancellation

Task 006 does not call the executor and does not cancel external execution.

Before Abandon mutates dataset state, it locks:

```text
dataset_series
→ dataset_version
→ all calculation_jobs in deterministic order
→ execution_attempts for those jobs in deterministic order
```

An attempt in any of these states blocks abandonment:

```text
PREPARED
DISPATCHING
ACCEPTED
```

`PREPARED` is included because it is durable intent that Task 004 can still dispatch. Allowing abandonment while a PREPARED attempt exists would require a separate attempt-cancellation/invalidation protocol that is outside the current milestone.

Terminal attempt states do not block abandonment:

```text
DISPATCH_FAILED
FAILED
SUCCEEDED
```

Job states `PENDING`, `FAILED`, and `SUCCEEDED` may be abandoned when no active attempt exists.

A `RUNNING` job must correspond to an active `ACCEPTED` attempt and therefore blocks abandonment. A contradictory `RUNNING` job without such an attempt is an internal invariant violation.

### Lock hierarchy compatibility

Task 006 operations use:

```text
Submit Validation:
dataset_version
→ calculation_jobs ordered

Publish:
dataset_series
→ dataset_version

Reject:
dataset_series
→ dataset_version

Abandon:
dataset_series
→ dataset_version
→ calculation_jobs ordered
→ execution_attempts ordered
```

This is compatible with accepted earlier workflows:

```text
Task 002:
dataset_series

Task 003:
calculation_type
→ upstream dataset_series
→ output dataset_version
→ calculation_job

Task 004 / Task 005 local execution mutation:
calculation_job
→ execution_attempt
```

No Task 006 operation acquires a lower-level execution row and then reaches backward for a dataset-version or dataset-series lock.

### Idempotency and conflicting terminal decisions

Commands use same-target idempotency:

```text
submit-validation when already VALIDATING → 200 current state
publish when already PUBLISHED           → 200 current state
reject when already REJECTED             → 200 current state
abandon when already ABANDONED           → 200 current state
```

A request for a conflicting or invalid lifecycle target returns a conflict and never rewrites terminal history.

Examples:

```text
Publish after REJECTED  → conflict
Reject after PUBLISHED  → conflict
Abandon after PUBLISHED → conflict
Abandon after REJECTED  → conflict
```

`PUBLISHED`, `REJECTED`, and `ABANDONED` remain immutable terminal states.

### Reconciliation compatibility after dataset lifecycle advancement

Task 006 may advance a dataset after an execution attempt has already become terminal. Delayed duplicate callbacks must remain safe.

A terminal local attempt may be idempotently verified against the same executor terminal result even when the dataset is now `VALIDATING`, `PUBLISHED`, `REJECTED`, or `ABANDONED`.

A non-terminal execution attempt must not continue state mutation after the dataset has left `BUILDING`; such a state combination is an internal invariant violation.

Contradictory terminal executor observations remain anomalies and never rewrite terminal history.

## Alternatives Considered

### Automatically transition BUILDING to VALIDATING when the final job succeeds

Rejected because execution completion and business validation are distinct decisions. Automatic transition would remove the explicit validation boundary and couple executor reconciliation to dataset publication workflow.

### Publish by locking only dataset_version

Rejected because publication changes downstream latest-`PUBLISHED` visibility. Without the `dataset_series` coordination lock, Publish would not serialize with Task 003 latest-published resolution or Task 002 version creation.

### Lock dataset_series only for Publish, but not Reject/Abandon

Viable for narrow publication correctness, but not selected. Reject and Abandon also release the active-version slot. Using one series-level terminal-decision protocol makes next-version creation deterministic and easier to reason about.

### Allow abandonment with PREPARED attempts

Rejected for this milestone. A PREPARED attempt can still be dispatched by Task 004. Safe abandonment would require a durable cancellation/invalidation state and additional concurrency semantics.

### Cancel executor runs as part of Abandon

Rejected for Task 006. Executor cancellation introduces a separate distributed state machine: cancellation acceptance, timeout/ambiguity, callback races, retry, and terminal meaning. The current milestone instead waits for active execution to reach a terminal local state before abandonment.

### Return conflict for every repeated command

Rejected. A successful commit followed by a lost HTTP response must be safely retryable. Same-target idempotency distinguishes retry of an already-achieved outcome from a genuinely conflicting terminal decision.

## Consequences

Positive:

- Execution success remains separate from validation/publication.
- Publish has deterministic visibility ordering with downstream snapshot freeze.
- Next-version creation is serialized with terminal release of the active-version slot.
- Publish-vs-Reject has exactly one terminal winner.
- Abandon cannot race into `ABANDONED` while an execution may still start or remain active.
- Command retries after response loss are safe.
- Task 006 requires no executor call or cancellation protocol.

Trade-offs:

- Terminal decisions acquire a `dataset_series` row lock even when the operation does not publish data.
- Abandon may be temporarily unavailable while a PREPARED/DISPATCHING/ACCEPTED attempt exists.
- Some corrupted state combinations are surfaced as internal invariant failures rather than repaired automatically.
- Task 005 reconciliation needs a bounded compatibility adjustment so duplicate terminal callbacks remain idempotent after dataset lifecycle advancement.
