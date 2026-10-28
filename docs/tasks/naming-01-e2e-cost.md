# Naming-01 — Rename Canonical Dataset Domain to E2E_COST

Date: 2026-10-28 (Asia/Taipei). Implementation pending System Owner review;
no merge or deployment authorization is implied.

Baseline: freshly fetched main `f7effb37576f1179d48a774829b0069fe70cc9ad`.
Branch: `feature/naming-01-e2e-cost` in an independent worktree.
The System Owner's Naming-01 request resolves the earlier Roadmap backlog
questions: same Domain, no alias, preserved identities/history, forward migration.
See [ADR-0014](../adr/0014-canonical-domain-e2e-cost.md).

## Inventory and bounded changes

Repository-wide case-insensitive search for `COWOS_S`, `COWOS-S` and `E2E_COST`
identified the following original uses:

| Location | Treatment |
|---|---|
| `src/modules/dataset-version/dataset-version.types.ts` | Replace canonical catalog member; Core and Demo share the existing parser |
| `frontend/src/features/exploration/exploration-page.tsx` | Replace Domain option |
| `scripts/dataset-version-creation-v2.pg.test.ts` | New accepted value; old value and aliases rejected without mutation |
| `scripts/orchestration-schema-v2.pg.test.ts` | Retain old spelling in historical v1/v2 migration fixtures (those tests stop before Naming-01) |
| `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/REFERENCE.md`, `docs/ROADMAP.md` | Synchronize current catalog/contract/status |
| `docs/adr/0001-canonical-dataset-identity.md`, `docs/tasks/002-dataset-version-creation-v2.md` | Preserve original decision/task text, add a current-naming cross-reference |

No applied migration contains a literal `COWOS_S`; the old schema permits it as
VARCHAR data. Only three persisted columns carry the canonical identifier:

| Column | Rename collision check |
|---|---|
| `dataset_series.domain` | `(domain, company_code, fiscal_year, period)` and `(domain, legacy_business_key)` |
| `calculation_types.domain` | `(domain, code)`, active and inactive |
| `execution_dependency_definition_dependencies.required_domain` | `(definition_version_id, required_domain)` across all definition states |

Version, Job, Snapshot, Attempt and legacy-bridge relations use UUIDs. No foreign
key needs recreation. Raw ingestion has a separate unchanged domain catalog.
Demo guided intent/ledger is CAPEX-only and is not rewritten. Existing historical
verification reports, applied migrations, external DAG/run names and audit text
are retained. Remaining old spelling is explanatory history, migration source
matching or negative/pre-migration test data.

New migration: `1793200000000_rename-cowos-s-to-e2e-cost.ts`. Locks and checks
precede every update; the enclosing transaction also covers `pgmigrations`.
Down only succeeds as a no-op when none of the three columns contains target
data; it refuses all populated target cases.

## Verification

`npm run test:naming-01` uses owned disposable real PostgreSQL databases and tests:

- Fresh install, no-data down/up and repeat up without changes.
- Populated upgrade with terminal versions, retries, frozen upstream references,
  active/inactive types, all definition states and compatible target data.
- Exact whole-row preservation except the three designated Domain fields.
- All four conflict classes; complete data and migration-ledger rollback.
- Injected failure during the final update, after earlier updates have executed.
- An in-flight writer blocks migration preflight; its committed collision is
  detected after lock acquisition without partial updates.
- Down refusal for target data independently in each affected table.
- Core and authenticated Demo acceptance/rejection; reused series/version counter,
  Run with migrated configuration, downstream resolution of the same published
  upstream UUID and Demo read DTOs.

The suite is part of `npm run test:milestone` and therefore the existing CI gate.
UI tests cover the visible option and submitted new identifier. Existing Demo
tests keep their rollback targets while accounting for the new migration.
Executed results are recorded separately in
[Naming-01 verification](../verification/naming-01-e2e-cost.md).

## Rollout

1. Stop all writers and take a coordinated database/application backup.
2. Run `npm run migrate -- up` using the existing private target configuration.
   For restricted Demo use the existing offline operator migration procedure.
3. If preflight fails, keep the old application stopped while investigating;
   the database remains unchanged. Do not merge/delete conflicting histories.
4. Deploy the matching API/UI and update callers to `E2E_COST`; verify reads and
   new creation before admitting writes. No alias or automatic runtime seed.
5. After a successful data-bearing migration, rollback is a reviewed forward fix
   or a coordinated pre-upgrade restore; do not roll back only the application.

No six-domain Demo seed, Playground refactor, financial business logic or
identity-model changes are included. Await System Owner review.
