# Naming-01 verification

Executed 2026-10-28 (Asia/Taipei), from main baseline
`f7effb37576f1179d48a774829b0069fe70cc9ad`, on
`feature/naming-01-e2e-cost`. Tested implementation and assertions are committed
as `7d31ce05130fb226dc1e447614a897a33d150e02`. The follow-up commit adds this
record and replaces two stale Demo-04 diagnostic migration-count labels with
database queries; it does not change production code or test assertions.

Environment: Windows, Node 24.18.0, real PostgreSQL 18.6 in a task-owned local
Docker service, Chromium 156.0.8078.4. All database suites used independently
owned disposable databases. No persistent developer/production database was used.

| Verification | Result |
|---|---|
| Backend build | PASS, standalone and milestone |
| Full sequential Core milestone including Naming-01 | PASS, 259 TAP entries, 13 suites plus build |
| Naming-01 within milestone | PASS, 13 entries: upgrade, preservation, four conflicts, late failure rollback, concurrent writer, down guards, Core/Demo API contracts |
| Demo session infrastructure / ownership / reset | PASS, 21 / 19 / 22 entries |
| Demo-02A / 02B / 02C / 02D / 02E | PASS, 23 / 26 / 27 / 25 / 37 entries |
| Demo-04 PostgreSQL | PASS, 23 entries |
| UI tests | PASS, 41 tests in 3 files |
| UI build (includes typecheck) | PASS |
| Real Chromium/Vite/backend/PostgreSQL smoke | PASS, 10 entries; 12 applied migrations |
| Demo-04 isolated Compose/HTTPS/production UI/backup/restore/restart | PASS, 12 entries; 12 migrations asserted |
| Strict Naming-01 migration/test TypeScript check and Demo-04 typecheck | PASS |
| `git diff --check` | PASS |

All completed suites report zero failures, skips, cancellations and TODOs.
The milestone's fail-closed runner reports overall PASS, including isolated raw
ingestion and Core end-to-end flows A–F. Demo tests total 223 entries, excluding
the separate container/UI checks. Test counts include Node test parent entries.

The populated migration test compares every public table before/after, permitting
only the three designated Domain fields and the new migration ledger row to
change. This covers terminal dataset history, failed/successful attempts, DAG/run
identities, frozen upstream UUIDs, inactive legacy types and all definition
states. Four collision fixtures and an injected final-update error leave all
rows and migration markers unchanged. A real concurrent transaction verifies
the migration waits for a writer and detects its committed target collision.

Initial Naming-01 test development exposed SQL parameter-cast errors in the new
fixture; they were corrected before the successful runs. Resumption also found
the dedicated PostgreSQL container stopped; it was restarted and the affected
suites rerun. No production behavior was changed to bypass either failure.
The successful container/PG diagnostic logs initially printed a stale literal
11, while the actual schema/assertions used 12; the follow-up queries remove that
diagnostic inconsistency.

Owned test databases were removed; the PostgreSQL service has no remaining
non-template test databases. The container suite reports disposable volume
teardown. Existing verification files and applied migrations were not modified.

No known implementation blocker remains. Migration rollout requires all writers
stopped and a coordinated backup; retained E2E_COST data prevents automatic down.
This is local execution evidence, not a claim of GitHub CI completion, public
deployment, merge or System Owner acceptance. Await System Owner review.
