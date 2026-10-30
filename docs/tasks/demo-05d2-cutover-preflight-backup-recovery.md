# Demo-05D-2 — Cutover Preflight, Backup/Restore and Failure Recovery Verification

Authority: bounded System Owner specification. PR #43 confirmed formally merged;
baseline main `d2b61c5db7b2e93d358049a4531586e40f7c2942`.
Branch `codex/demo-05d2-preflight-backup`. Await System Owner Review; no merge,
production VPS/database/deployment/migration/seed/drain/Cutover/restore operation.
All executed setup, faults and cleanup use owned disposable local/CI fixtures.
This supplements ADR-0017/0018 and the accepted single-instance deployment model;
no new architecture decision or application state machine is introduced.

## Approval boundary and flow

One trusted Owner operation at a time. Keep Web and Backend stopped with automatic
restart disabled. Reuse Demo-05D-1's actual Docker offline checks; SQL count zero
is insufficient. Separately prove no other Backend/external writer, in-flight
deployment/request/cleanup and unresolved unknown outcome. These tools cannot
fence arbitrary Docker administrators or database writers, or control external
CDNs/proxies. Configuration/secrets must remain immutable during verification.

```text
Owner proves offline/quiescence/no unknown outcomes
  → explicit cutover-preflight → point-in-time PASS
  → explicit backup → pg_dump custom archive + private integrity/state manifest
  → explicit verify-backup → OWN random isolated PostgreSQL → real pg_restore
  → same read-only verifier → exact evidence match → OWN cleanup → RESTORE_VERIFIED
  → Owner review/off-host storage/other deployment acceptance
  → separately approved existing Cutover (never invoked by these tools)
```

## Preflight transaction and complete empty-data contract

`operate.sh cutover-preflight --database-url-file /run/secrets/database_url` uses
the existing operator image and shared target, with no DATABASE_URL fallback.
It requires both services stopped with restart disabled, including stopped
containers that could otherwise auto-resume. It does not stop/restart them itself.
The mounted URL must name Compose database/demo_owner/cost_engine_demo on its
normal port, without query overrides. This binds evidence to the actual pg_dump
target; a repointed target cannot authorize backup of another DB.

The new logical-read-only PostgreSQL transaction acquires:

1. BEGIN READ COMMITTED; local lock_timeout 3s, statement_timeout 5s (Pool query 6s).
2. Existing Admission FOR SHARE; require DRAINING.
3. Existing Configuration SHARE table locks.
4. Existing `requireCutoverQuiescence` graph locks/checks in unchanged order.
5. SHARE locks on retained bridge/raw/DPR tables and pgmigrations.
6. Shared exact migration inventory and unchanged complete LEGACY validator.
7. Actual PostgreSQL 18/schema inventory/important validated keys/indexes/triggers.
8. All audited business-table counts zero, deterministic configuration fingerprint.
9. Read-only COMMIT; error/uncertain acknowledgement withholds PASS, closes the
   connection safely and never retries or writes durable Preflight state.

Normal transaction mode is needed for row/table locks; no DML/DDL, migration,
seed, cleanup, executor, runtime startup or Cutover is called. Shared migration
inventory extraction preserves existing Backend startup validation behavior.
Existing Cutover transaction, lock order, confirmation and configuration logic
are unchanged. No duplicate financial/dependency configuration validator exists.

Actual schema audit, not guessed table names, identifies 21 required-empty tables:

| Group | Tables |
| --- | --- |
| Demo history | demo_sessions, demo_scenario_instances, demo_scenario_step_executions |
| Dataset/execution | dataset_series, dataset_versions, calculation_jobs, execution_attempts, dataset_build_snapshots, dataset_build_snapshot_dependencies |
| Retained v1 | orchestration_v2_legacy_calculation_type_bridges, assets, dpr_calculation_input_snapshots, dpr_calculation_inputs, dpr_results |
| Raw | raw_ingestion_series, raw_ingestion_batches, raw_dpr and its four 2026 quarter partitions |

Revoked/expired Session history and **unowned** dataset graphs also fail. Published,
failed or abandoned business history is not exempt. Unknown/missing public
relations (including other user schemas) fail even when empty. Configuration tables, singleton Gate and migration
inventory are the only nonempty tables permitted. Full existing validation
requires six domains/nine active Types, exact DAGs/counters, published definitions,
CAPEX zero-dependency v1 and all six-domain direct dependency sets.

PASS JSON includes version/PostgreSQL major, DRAINING/update time, LEGACY, all
migration names/counts and SHA-256 fingerprints of ordered complete configuration
rows and schema evidence (columns, constraints, indexes, triggers and functions).
Schema comparison preserves logical column order rather than physical dropped-
column slot holes. It normalizes only pg_dump/reparse's equivalent unbounded
varchar literal-array casts to text; bounded casts and all other SQL remain.
This addresses differences observed in actual PostgreSQL 18 dump/restore without
omitting constraints, indexes, triggers or types from evidence. Disabled FK
enforcement and missing important keys still fail.
It includes no SQL, token, password or connection URL. All failure exits are
nonzero and sanitized. PASS describes only the checked instant. Table locks hold
read consistency until commit, not after return or across separate commands.

## Private backup and integrity

Provision an existing private absolute directory outside **every** Git worktree;
physical ancestor checks reject symlink/path aliases back into a repository.

```sh
export DEMO_DEPLOY_ENV=/private/reviewed/compose.env
export DEMO_BACKUP_DIR=/var/backups/cost-engine-demo
sh deploy/scripts/operate.sh cutover-preflight --database-url-file /run/secrets/database_url
sh deploy/scripts/backup.sh --database-url-file /run/secrets/database_url
```

Backup requires successful strict preflight, creates a fresh mktemp private
`cost-engine-backup-*` bundle and runs pg_dump -Fc in the actual Compose DB.
It rechecks offline/preflight afterward and requires every evidence field match.
Each dump has PostgreSQL's own consistent snapshot; the before/after checks are
not an external-writer fence. Owner quiescence remains mandatory, and actual
Restore Verification is needed to prove the archive matches the recorded state.

Umask 077 gives bundle 700 and archive/manifest 600 on POSIX. Dump/state/checksum
failure removes only newly owned incomplete artifacts, never old backups. Unique
directories prevent overwrite; partial files are published only after checks.
The manifest records formatVersion 1, BACKUP_CREATED, identity, backup.dump,
decimal-string sizeBytes, SHA-256, createdAt and the complete deterministic
preflight evidence. General logs show metadata only, never archive contents or
credentials. Protect the trusted bundle against modification; SHA is integrity,
not authenticity, authorization or proof of restore. Encrypt/copy off-host under
Owner policy. These first-deployment tools intentionally reject post-Cutover or
retained-data operational backups; those need a separate reviewed recovery policy.

## Real isolated restore and target protection

```sh
sh deploy/scripts/verify-backup.sh --backup-file /var/backups/cost-engine-demo/cost-engine-backup-IDENTITY/backup.dump
```

There is **no target parameter**. Deployment env/URL/PG credentials are not read.
Reject missing/symlinked/non-custom/truncated/changed/manifest-incomplete archives
and checksum/size mismatch before resources are created. A rehashed malformed
archive must still pass actual pg_restore, not merely its header/checksum.

The command creates its own 128-bit random nonce, matching purpose/owner labels,
fresh named local volume and postgres:18 container. Existing identities are never
reused. Before start, restore and cleanup verify exact container ID, labels,
postgres:18, no privilege, network none only, zero published ports, restart no,
one owned volume at /var/lib/postgresql, fresh restore_* database/restore_owner
and no production password/file. No deployment volume/secret/host directory or
Docker socket is mounted. Local trust is limited to this isolated namespace.

Actual pg_restore --exit-on-error --no-owner --no-privileges targets only the
internally generated database via Docker exec. A read-only, cap-dropped operator
with only temporary /tmp shares the new container namespace to reuse the exact
preflight/configuration/schema verifier. It has no deployment secrets or network.
The corresponding immutable local operator:<backup Deployment Version> image must
exist; no migration/seed is performed in the restored DB. All evidence must equal
the recorded original, including schema/configuration fingerprints, Gate update
time, migrations and all counts. A successful restore exit code alone is insufficient.

RESTORE_VERIFIED is printed **after** successful validation and exact owned
cleanup. Cleanup revalidates ownership and never prunes, guesses names or touches
deployment volumes. Unprovable ownership refuses deletion and reports failure.
The result includes backup identity/checksum/bytes, PostgreSQL 18, LEGACY/DRAINING,
counts/fingerprints and isolated resource identities/network/cleanup evidence.
It proves neither Cutover approval, production Disaster Recovery nor off-host copy.

## Failure recovery decisions and rollback limits

| Durable observation | Required Owner action |
| --- | --- |
| WORKFLOW_OPEN + complete WORKFLOW | Cutover applied; retain v1/v2 and use compatible forward fix. No reapplication needed. |
| DRAINING + complete LEGACY | NOT_APPLIED; re-run strict Preflight and review backup/restore. Retry only after separate explicit approval. |
| CONFIGURATION_CONFLICT | Stop with Web closed; investigate. No automatic repair/cleanup. |
| OUTCOME_UNKNOWN | Stop with Web closed. Existing independent locked durable confirmation/status investigates; no automatic retry or inferred rollback. |
| Database unavailable | Stop, preserve uncertainty and closure; reconnect through reviewed status tooling. |
| Backup/restore/schema/count mismatch | Nonzero, no success assertion, no Cutover or Web start; preserve prior trusted backups and investigate privately. |

Unknown acknowledgement still uses unchanged DemoCutoverOperator's suspect-socket
discard and genuinely independent locked reload. APPLIED/ALREADY_APPLIED,
NOT_APPLIED/UNKNOWN and 3/5/6-second bounds are unchanged. No second Cutover state
machine, automatic follow-up command or retry loop exists.

WORKFLOW_OPEN is irreversible. Never reopen LEGACY_OPEN, down-migrate, delete v1/
v2 or restore an old backup automatically. A failed deployment keeps Web closed
and prefers compatible Backend forward fix. Real restore needs **separate explicit
Disaster Recovery authorization**, validated target/backup and data-loss review.
verify-backup cannot perform that operation. Demo-05D-3 and public DNS/TLS/ACME/
host acceptance remain future Owner gates; no website is opened by verification.

## Verification

Independent real PostgreSQL and Docker suites cover the bounded task, explicit
lock barriers, all retained-data/schema/refusal cases, read-only invariance,
backup artifacts/fault cleanup, actual restore/integrity/state equality,
independent resources/cleanup/source unchanged and unknown-COMMIT decisions.
Executed locally on 2026-10-30 (Asia/Taipei), Node 24.18.0, PostgreSQL 18 and
Docker Desktop Linux containers; **378 passing tests**, counting each latest
component suite once (not duplicate development reruns):

| Verification | Result |
| --- | --- |
| Backend / Frontend production builds | PASS |
| Demo-05D-2 strict typecheck and existing deployment/3A/3B strict checks | PASS |
| Demo-05D-2 PostgreSQL | 27 PASS; 25 independently migrated fixture DBs removed |
| Demo-05D-2 Docker / backup / real restore | 17 PASS |
| Demo-05D-1 deployment safety, including actual independent daemon restart | 19 PASS |
| Demo-05C-3A Cutover / unknown-COMMIT regression | 29 PASS |
| Demo-05C-3B six-domain regression | 12 PASS |
| Demo-04 production containers / security / existing real restore | 15 PASS |
| Isolated Core Milestone, all 13 test suites plus build | 259 PASS |
| Final schema-audit dump/restore with full logical fingerprints | PASS |
| POSIX script / JSON helper syntax and diff checks | PASS |

Actual disposable Docker project `demo05d2_test_59eadbf3f21a` produced:

```json
{"identity":"cost-engine-backup-D4wsKWi7RxBp","sizeBytes":"86648","sha256":"756b771cc7ca1ec83c33f4f0413ac52108d19c6e411c74ac32b1464fa9ee467f","format":"PGDMP","state":"DRAINING","configuration":"LEGACY"}
{"result":"RESTORE_VERIFIED","postgresVersion":"18","configuration":"LEGACY","admissionState":"DRAINING","businessDataEmpty":true}
```

Real restore identities were
`demo05d2_restore_ebaadabf9a76173f1c1642a0c6154f70_postgres`,
`demo05d2_restore_ebaadabf9a76173f1c1642a0c6154f70_data` and
`restore_ebaadabf9a76173f1c1642a0c6154f70`. Runtime inspect confirmed `network=none`,
zero published ports, one fresh owned volume, no deployed credential and exact
owner labels. Schema/configuration fingerprints, migration inventory and all
21 zero business-table counts matched; cleanup completed before success.
The source DB ID/volume/Gate/configuration remained unchanged. A second actual
restore passed with the source Compose DB stopped, proving it is not a target or
dependency. Altered archive/evidence and actual pg_restore failure never reported
success; all newly created resources were removed and existing backups preserved.

The initial real restore correctly refused raw schema fingerprints: PostgreSQL
compacts deleted-column attribute slots and reparses equivalent varchar-array
casts. The narrow logical normalization described above fixed that false failure;
full precision/nullability/default/key/index/trigger/function evidence remains.
Independent schema-audit databases confirmed final logical fingerprints match
after actual dump/restore and were removed. Unknown-COMMIT cases used unchanged
transport seams and independent PostgreSQL confirmation; no automatic reapply.

CI retains all existing suites and adds the new strict check and real integration
suite. Final exact-commit CI links are recorded in the PR. All ten acceptance
criteria are implemented and locally verified. Production deployment/Cutover/
Disaster Recovery, off-site storage and Demo-05D-3 Owner acceptance are unperformed.

## PR #44 follow-up — Schema Integrity Validation

System Owner requested stronger existing-rule verification on the same branch.
The read-only bounded contract in `src/deployment/cutover-schema-invariants.ts`
was audited against fresh PostgreSQL 18 output from the existing forward
migrations: 1786634529143, 1788700000000, 1792600000000, 1793300000000 and
1793400000000. It executes no DDL and is not a Schema Migration Engine.

- `uq_dataset_versions_active_series`: UNIQUE btree on
  `public.dataset_versions(dataset_series_id)`, exactly DRAFT/BUILDING/VALIDATING.
- `uq_execution_attempt_active_job`: UNIQUE btree on
  `public.execution_attempts(calculation_job_id)`, exactly PREPARED/DISPATCHING/ACCEPTED.
- Compare the full deparsed definitions after the unchanged narrow Cast
  normalization, including relation/keys/predicate rather than name/prefix.
- Match 17 CHECK expressions, 12 current UNIQUE key sets and the Gate primary
  key by owning table, name, type and complete definition. Checks cover canonical
  identity/year/period, allocation/version bounds, Dataset/Job/Attempt/Definition
  states, Attempt numbering, Session hash/company/lifetime/revocation and Gate
  singleton/allowed states, exactly as defined by the existing migrations.

The 31 new independently mutated fixtures preserve names/object types: changed
index columns, weakened/missing predicates and wrong owning tables (both indexes),
all 17 CHECKs replaced by CHECK(true), five UNIQUE keys replaced by UNIQUE(id),
and a same-name/type CHECK moved to another table. Each must fail without data
repair or writes. Existing PostgreSQL/Docker cases, complete schema fingerprint
and actual restore comparison remain. Core, historical migrations, Cutover/Gate
transactions/state machines, Backup Isolation and Restore Target Protection are
unchanged. The PostgreSQL follow-up passed 58 tests (the original 27 plus 31
destructive cases) and removed its 56 independently migrated fixture databases.
The required Docker restore, Demo-05D-1, Demo-05C-3A and isolated Core Milestone
runs are repeated; final counters and exact-commit CI evidence accompany the
review delivery. No additional PR or production operation is performed.
