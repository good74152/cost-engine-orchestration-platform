# ADR-0014 — Canonical Domain Naming: E2E_COST

- Status: Accepted (Naming-01 scope authorized by the System Owner; implementation awaits review)
- Date: 2026-10-28
- Supplements: ADR-0001 and ADR-0003; their identity and snapshot rules are unchanged.

## Decision

`COWOS_S` and `E2E_COST` identify the same Domain. Its canonical identifier is
now `E2E_COST`. Core and Demo creation APIs accept only the new spelling;
`COWOS_S` is rejected with HTTP 400 `INVALID_DOMAIN`. No alias or normalization
is provided. The frontend offers the new identifier.

Canonical identity remains `(domain, company_code, fiscal_year, period)`.
This is a coordinated identifier correction, not allocation of a new series.
The forward migration updates `dataset_series.domain`, `calculation_types.domain`
and `execution_dependency_definition_dependencies.required_domain`, including
inactive types and all historical definition versions. The dependencies still
refer to the same Domain; definition IDs, versions and dependency membership
are unchanged. This narrowly scoped naming correction is not permission for
application code to rewrite published dependency configuration.

UUIDs, version counters, Dataset Versions, Jobs, frozen Snapshot references,
Attempts, DAG mappings/run IDs, statuses, timestamps, legacy bridge keys and
audit/validation history are preserved. Strings embedded in external execution
identifiers or historical payloads are not renamed.

## Migration safety and alternatives

The migration locks all three affected tables and performs preflight checks and
updates in one PostgreSQL statement inside the migration transaction. It refuses
collisions on canonical series identity, non-null legacy business key, type
domain/code (including inactive types), or definition/required-domain. It never
merges rows or chooses a winner. Non-colliding target data remains intact.
Any check/update failure rolls back the complete migration and its ledger entry.

Automatic reverse renaming is unsafe because preexisting/new target data cannot
be distinguished from renamed data. Down refuses while any of the three columns
contains `E2E_COST`; with no target data it is an explicit no-op. Data-bearing
rollback requires a reviewed forward migration or coordinated backup restoration.
Applied migrations and historical verification records remain unchanged.

Aliases were rejected by the Naming-01 requirement. Reallocating or merging
identities would violate historical reproducibility and is not permitted.

## Operations and limits

Use a maintenance window: stop all Core/Demo/ETL/configuration writers, back up
the database, apply migrations explicitly, then deploy/restart the matching
backend and frontend. No rolling compatibility with old clients/writers is
claimed; table locks protect the migration, not later writes by old software.
Conflicts require operator investigation; do not delete history or bypass guards.

Six-domain Demo seed and Playground restructuring are out of scope. The existing
CAPEX seed and all business/lifecycle/executor behavior remain unchanged.
See [Naming-01 task](../tasks/naming-01-e2e-cost.md) for inventory and verification.
