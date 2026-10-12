# Task 007B — Conditional Concurrency Remediation

- Status: BLOCKED — not Codex-ready.
- Precondition: Task 007A evidence reviewed by system owner.
- Purpose: one bounded correction for each **proven, supported-behavior** cross-workflow defect.

## Why this is conditional

The current architecture fixes:
- the durable execution-attempt identity and status machine,
- the distinction between a definite no-run rejection and ambiguous dispatch,
- executor status lookup as reconciliation truth,
- terminal attempt immutability,
- no external call inside a PostgreSQL transaction,
- calculation_job → execution_attempt lock order.

Task 007A must determine if CON-01 and CON-02 are defects under those contracts before changing implementation. An inconsistent mock executor is not permission to invent new production semantics.

## Scope once unblocked

For each confirmed bug, the system owner must first record:
1. exact failing deterministic interleaving and database/executor facts;
2. invariant violated;
3. intended HTTP/result behavior under an already terminal attempt;
4. minimal production functions to change;
5. why the correction preserves existing accepted ADRs;
6. exact regression tests expected to become green.

Then create one coherent Codex change, preferably one PR per independently confirmed bug. Do not include API general refactoring, docs cleanup, migration, new states, or a new executor adapter.

## Baseline expected invariants

- Never overwrite SUCCEEDED/FAILED attempt history.
- Never create another attempt merely because dispatch response is lost.
- Never convert a merely unavailable executor lookup into calculation failure or definite dispatch failure.
- Never let an acknowledged run become orphaned behind a local DISPATCH_FAILED under supported executor semantics.
- Never hold DB locks while waiting on external dispatch or status.
- Job and attempt transitions representing one executor fact remain atomic.
- Do not change dataset build snapshot, definition pins, or publication lifecycle.

## Stop/review condition

If resolving CON-02 requires a lasting rule for contradictory external acceptance/rejection outcomes, new attempt state, or executor guarantee different from ADR-0005, stop and return to architecture review. Author a separate ADR if justified; do NOT silently implement precedence here.

## Required tests and acceptance

- Exact 007A deterministic failing reproduction is fixed and green.
- Reverse interleaving is green.
- Existing Task-002–006 PostgreSQL suites remain green.
- No introduced deadlock, identity split, attempt duplication, terminal rewrite, or generic 500 on legal races.
- Recorded review explains why fix is bounded and consistent with accepted protocols.

If investigation finds no real defect, mark the relevant remediation as NOT REQUIRED; do not create speculative production changes.
