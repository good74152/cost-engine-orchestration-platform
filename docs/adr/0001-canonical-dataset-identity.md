# ADR-0001 — Canonical Dataset Identity and Monotonic Version Allocation

- Status: Accepted
- Date: 2026-09-06

## Context

The original implementation identified a logical dataset with `(domain, business_key)`. `business_key` was opaque application data, which made scope validation and cross-domain dependency matching difficult to reason about and easy to implement incorrectly.

The platform coordinates multiple quarterly cost/financial domains, including:

```text
FAB_COST
CAPEX
DPR
INSURANCE
ONE_STD_COST
COWOS_S
```

All of these domains share common reporting coordinates: company, fiscal year, and quarter.

The system also needs reproducible historical versions. Rejected or abandoned work must remain auditable and must not cause version numbers to be reused.

## Decision

A logical dataset series is identified by:

```text
(domain, company_code, fiscal_year, period)
```

with database uniqueness:

```sql
UNIQUE(domain, company_code, fiscal_year, period)
```

`company_code` is an immutable business identifier for the reporting entity. `period` is quarterly (`Q1`..`Q4`) and shares the same fiscal calendar across the currently modeled domains.

`business_key` is retired as canonical identity. A temporary `legacy_business_key` may exist only as a migration/rollback bridge; new application code must not depend on it.

Each `dataset_series` maintains:

```text
last_allocated_version
```

This is a monotonic allocation counter only. It is not a cached pointer to the latest usable dataset.

Dataset versions are unique by:

```sql
UNIQUE(dataset_series_id, version)
```

Version numbers are never reused, including after `REJECTED` or `ABANDONED` versions.

The latest usable upstream dataset is derived from historical rows:

```sql
SELECT id, version
FROM dataset_versions
WHERE dataset_series_id = $1
  AND status = 'PUBLISHED'
ORDER BY version DESC
LIMIT 1;
```

## Alternatives Considered

### Keep opaque `business_key`

Rejected because the backend could not reliably enforce same-company/same-period dependency rules without parsing conventions embedded in a string.

### Include `calculation_type` in dataset identity

Rejected because a dataset version is a complete domain/reporting-scope publication unit containing multiple calculation jobs. Calculation types belong below the dataset version.

### Cache `latest_published_version_id` on `dataset_series`

Rejected for the current design because it duplicates publication truth and introduces an additional write that must remain transactionally consistent with `dataset_versions` state.

### Reuse failed/rejected version numbers

Rejected because historical version identity must remain stable and audit-friendly.

## Consequences

Positive:

- Cross-domain dependency scope is explicit and enforceable.
- Queries and indexes operate on structured columns instead of parsed strings.
- Version history remains immutable and easy to audit.
- New domains can reuse the same identity model without hard-coded pipelines.

Trade-offs:

- Migrating old `business_key` data requires explicit transformation/validation.
- `dataset_series` becomes a meaningful coordination row and must be locked correctly during allocation and publication-related operations.
- Any future domain requiring a different reporting grain would require a new architecture decision rather than silently overloading these coordinates.
