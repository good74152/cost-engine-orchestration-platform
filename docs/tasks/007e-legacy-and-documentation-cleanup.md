# Task 007E — Safe Legacy Cleanup and Documentation Synchronization

- Status: MERGED via PR #12 at 1f441eb6e430ba2acd0078cf9ce48045cfeb6e67; Task 007 COMPLETE and Orchestration Core v2 ACCEPTED by the System Owner.
- No migration/data deletion; no unrelated architecture refactor.

Closure status and recorded verification: [Task 007 final acceptance](../verification/task-007-final-acceptance.md), recorded 2026-10-16. The original cleanup requirements and acceptance criteria below are preserved; historical D/E verification reports remain unchanged.

## Goal

Remove proven dead v1 application artifacts only where safe, preserve all supported workflows and migration history, and align repository developer instructions with actual implementation.

## Initial inventory

- src/modules/calculation-job.service.ts is a re-export-only barrel; candidate for deletion only if static search and tests show no supported caller.
- Task-002 test asserts the superseded v1 calculation-job mutation routes are no longer registered; confirm no remaining route/service/helper leftovers before deleting anything.
- src/modules/raw-ingestion/**, POST /raw-ingestion-batches and scripts/raw-ingestion.route.test.ts are **supported and must remain**.
- All previously applied migrations must remain unchanged, including orchestration-schema-v2 migration and the older DPR performance/input-snapshot/raw-ingestion migrations.
- legacy_business_key and other compatibility schema columns/tables are migration history; do not drop, rewrite or erase historical rows within Task 007.
- No dependency is presumed unused without a package/import audit. No version upgrade sweep.

## Procedure

1. Search imports, re-exports, route registrations, tests, package scripts and migration references for each deletion candidate.
2. Record candidate, caller graph, supported workflow risk, decision RETAIN/DELETE/DEFER.
3. Delete only dead application code after replacement path is tested and test runner no longer references it.
4. Keep migration up/down and schema/audit history completely intact.
5. Rerun build, all PostgreSQL milestone tests, and raw-ingestion regression suite after cleanup.
6. Report actual files removed with rationale; no speculative mass-deletion.

## Documentation requirements

Update:

- AGENTS.md: Current Implementation Task points to current phase, remove stale Task-005 merge-pending / Task-006 next text, preserve engineering workflow and truth boundary.
- docs/ROADMAP.md: Tasks 002–006 merged; Task 007 package status accurate. Mark milestone COMPLETE only after verified acceptance, never on a static code review.
- docs/ARCHITECTURE.md: accepted architecture unchanged; current implementation sequence status accurate; describe actual FakeExecutor and public endpoints without inventing real Airflow integration.
- README.md: replace outdated Current Implementation that claims one job per dataset; explain current multi-job dataset version, frozen dataset-wide snapshot, Run/retry/reconcile, manual validation, terminal decisions, and supported raw-ingestion as a separate bounded feature.
- README.md / developer instructions: setup, NODE_ENV conditions for test/dev fake controls, PostgreSQL migration/tests, one-command milestone verification. Avoid unsafe instructions like deleting the developer's real database.
- Package scripts: document all commands introduced in 007D accurately; do not change them except to repair broken references from proven cleanup.

## Verification

- Import/caller scan for every removed file.
- No public v2 or raw-ingestion route disappearance.
- No changes to applied migration files or data history.
- npm run build passes.
- npm run test:milestone passes against PostgreSQL.
- docs reflect actual verified implementation and no unsupported production claims.
- Compare current branch to baseline main to ensure cleanup does not swallow unrelated modules or change state machines.

## Non-goals

Do not:
- remove raw-ingestion API or tests,
- drop historical DPR/raw-ingestion tables,
- edit already-applied migrations,
- add new backend technologies,
- refactor accepted lifecycle protocols,
- add real Airflow or cancellation,
- relabel the project as a past-employer implementation.

## Acceptance

Only proven dead code is deleted; all supported routes and historical migration behavior remain intact. Developer documentation and roadmap are accurate, reproducible PostgreSQL test evidence is available, and the owner reviews/approves the final milestone closure.
