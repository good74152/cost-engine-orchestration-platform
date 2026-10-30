# Demo-05D-3A — Operational Backup and Restore Verification

Authority: System Owner's bounded Production Backup & Restore Verification request.
Baseline: latest main `480f5db499e65f0a571cc363aa759c719f6ab716`; PR #44 formally
merged before this branch. Branch `codex/demo-05d3a-operational-backup`.
Implementation pending System Owner Review; no merge or production VPS/database
operation. This supplements accepted ADR-0010/0017/0018 using existing PostgreSQL,
Configuration and isolated-restore boundaries; no new architecture/state machine.

## Scope and entrypoints

- `backup-live.sh --database-url-file /run/secrets/database_url`: separate explicit
  Compose Demo target, WORKFLOW_OPEN plus exact WORKFLOW Configuration, real
  retained business rows allowed, foreground online pg_dump -Fc operation.
- `verify-backup-live.sh --backup-file /absolute/.../backup.dump`: no target option;
  real restore into fresh owned isolated PostgreSQL 18 only.
- The existing `backup.sh`, cutover-preflight and default verify-backup mode retain
  DRAINING/LEGACY/empty/offline first-deployment behavior. Operational manifests
  are explicitly separate and cannot pass default first-deployment verification.

No Migration, Seed, Cutover, Cleanup, runtime startup or executor command is
performed by these tools. Existing Core, Gate, Dataset/Job, snapshots, Guided,
Session security, Reset and unknown-outcome recovery stay unchanged. Only the
existing Schema verifier is exported for reuse; its SQL/fingerprint recipe is
unchanged. A bounded operational DTO helper is not another configuration validator.

## Online backup consistency and snapshot semantics

The dedicated operator opens REPEATABLE READ. It locks Gate FOR SHARE, requires
WORKFLOW_OPEN, acquires existing Configuration SHARE locks, pgmigrations SHARE,
then ACCESS SHARE on every audited business relation. Normal Session creation,
including its production capacity SHARE ROW EXCLUSIVE lock, remains compatible.
Dataset writes, Job/Attempt changes, Publish, reads and Reset are not quiesced.
Configuration writes/migration inventory changes and incompatible relation DDL
wait behind the operation. One trusted System Owner must still exclude any
migration/Cutover/configuration/deployment operations and arbitrary external DBAs.
SQL locks cannot prevent a privileged administrator from terminating the holder,
changing unrelated objects, bypassing application constraints or racing secrets.

The transaction reuses exact Migration inventory, full WORKFLOW validator (six
Domains/ten Types and all historical definitions) and the strengthened Schema
verifier. It checks actual stored FK orphans/CHECK violations and Core stored
bindings: Job Type domain, Attempt's resolved Definition/build snapshot, and
frozen upstream published versions in the same company/year/period. The frozen
domain set must equal the union of the existing resolved dependency definitions;
no latest-version re-resolution or hard-coded pipeline is introduced. This reads
persisted integrity without deriving executor outcomes or running state changes.

Complete business rows, including Session token hashes and immutable snapshot
bindings, feed a SHA-256 without printing row contents. A server cursor fetches
1,000 rows at a time in stable C-collation order with explicit UTC/ISO/hex output.
All 21 business-table counts, Migration names and Schema/Configuration/data
fingerprints belong to the same snapshot. Parent/raw partition counts retain the
existing audit inventory; counts do not promise one unique total across partitions.

The holder exports pg_export_snapshot and remains alive while POSIX invokes
pg_dump --snapshot against the same fixed Compose Demo database. A private control
file signals an anonymous stdin pipe only after pg_dump succeeds; the caller must observe
successful holder exit before publishing a manifest. Connection/holder failure
invalidates the operation even if some archive bytes were produced. Rollback
releases read locks; no business DML or COMMIT is involved. A dedicated one-off
container is labelled with the newly reserved backup identity; failure cleanup
verifies that exact ownership before removing it. It is not a background worker.

REPEATABLE READ's view starts at the first snapshot-taking query, before export.
Transactions committing later are excluded; source post-backup counts may grow
or shrink. No before/after row-count equality or external-writer claim is made.
pg_dump logical consistency does not include atomic sequence counters, globals,
roles, tablespaces, external executor memory or WAL/PITR. Normal sequence gaps
are allowed. Monitor old-version retention, lock age, vacuum pressure and sort
temporary storage. Bounds: lock 3s, SQL 60s, readiness 120s, holder 60min. Large
databases may fail these limits and need a separately reviewed scaling plan.

## Artifacts, restore validation and isolation

Provision an existing private off-Git backup root; POSIX requires operator-owned
0700, Windows equivalent ACLs. mktemp reserves a unique private bundle, umask077
protects archive/manifest, and no earlier file is overwritten or deleted. Failure
removes only its own partial bundle. Manifest formatVersion1/purpose OPERATIONAL
records BACKUP_CREATED, identity, backup.dump, decimal byte size, SHA-256, start/
completion timestamps and complete snapshot evidence including Deployment Version.
Successful archive creation alone is not restore verification or off-host safety.

The wrapper reuses Demo-05D-2's actual restore harness and all ownership/target
checks. Only an absolute archive/manifest is accepted, no caller-selected URL,
Container, Volume or database. Check custom format/identity/size/SHA before any
resources. Create random labelled fresh local Volume and PostgreSQL 18 Container,
network none, no published ports, one owned mount and a fresh restore database.
No source mount, deployment secret, Compose database network or Backend exists in
that target. Actual pg_restore --exit-on-error --no-owner --no-privileges is
mandatory. The matching immutable operator image validates the restored database
using the exact shared Schema/Configuration and operational data verifier.

Every restored evidence field must match the snapshot manifest, including full
data hash, counts, migrations and Schema/Configuration fingerprints. A checksum
or successful pg_restore exit alone never suffices. Exact-owned Container/Volume
cleanup precedes RESTORE_VERIFIED; unknown ownership refuses deletion and success.
No production target fallback or automatic runtime start is possible. The helper
image must already exist locally. Protect trusted manifests; SHA is corruption
detection, not authentication against a malicious artifact author.

## Production recovery limitations and FakeExecutor restart implications

Database Restore and restoring users' calculation execution capability are
different things. Actual production restore is explicitly out of scope and
requires a separate approved target/data-loss/recovery plan. No automatic restore,
Backend restart, Job rerun, Attempt redispatch or reopening traffic is added.
Persisted running/unknown work does not prove live executor state exists.
FakeExecutor's memory, including execution and rejected identities, is not in the
archive. Normal startup still invalidates old Sessions; verification neither
bypasses that rule nor reconstructs a fake from rows. Unknown Outcome and Reset
recovery are unchanged. RESTORE_VERIFIED is database evidence, not service RTO.

## Failure handling and Owner policy

| Failure | Result / explicit next action |
| --- | --- |
| LEGACY_OPEN/DRAINING/configuration or Schema conflict | Nonzero/no backup success; investigate, never repair or Cutover automatically. |
| DB connection/dump/holder timeout or loss | Rollback/release, remove only new partial bundle, preserve earlier backups; confirm health before a separately requested new attempt. |
| Bad checksum/header/manifest | Refuse before creating restore resources; investigate trusted/off-host copy. |
| pg_restore/schema/data mismatch | No RESTORE_VERIFIED; remove exact-owned disposable resources, investigate; never retry against production. |
| Ownership/cleanup unconfirmed | Refuse guessed deletion and success; inspect only reported owned identity privately. |

System Owner sets backup frequency/retention, off-host encryption/access/key
handling, age alerts, restore-drill frequency and disk/temporary/MVCC/volume
thresholds. No scheduler or automatic historical-backup deletion is implemented.
Record desired RPO/RTO and measurements separately: source snapshot age bounds
potential data loss; retrieve/restore/validate/runtime/executor/reopen phases all
contribute to service recovery time. No achieved RPO or RTO is claimed. See the
[policy table and operator runbook](../DEPLOYMENT.md#operational-backup-after-workflow-cutover).

## Verification

Real disposable PostgreSQL tests use independently migrated DBs and explicit
pg_stat_activity/pg_blocking_pids barriers for Configuration, inventory, DDL and
Gate locks. Live Session capacity creation and exported-snapshot reads prove
normal writes remain possible and later commits stay excluded. Corrupt FK data,
missing snapshot, weakened schema/configuration, timeout and unavailable DB fail.

Real Docker tests run a healthy production-profile Backend and actual APIs to
create Session, published FAB_COST and two-job CAPEX with running Attempts and
frozen inputs. A deterministic pg_dump invocation barrier observes the exported
holder and ACCESS SHARE locks, then commits new Session/Dataset, Job/Attempt
success and CAPEX publication before pg_dump imports the same earlier snapshot.
The actual restored counts/hash must match the snapshot while live counts differ.
This uses explicit barrier signals/observed PostgreSQL locks, not sleep timing.

Failure cases include pg_dump failure, terminated exporter connection, corrupted/
truncated archives, rehashed invalid archive requiring actual restore failure,
forged data evidence, unsafe targets and no overwrite. Source-offline restore
proves independence; original Backend ID/start time/Fake identity stay intact.
Resources are owned temporary local/CI fixtures and are removed after tests.

Executed locally on 2026-10-30 (Asia/Taipei), PostgreSQL 18 / Node 24.18.0:
the operational PostgreSQL suite has 19 passing tests and removes 19 independent
migrated databases. Initial Docker verification passed all 17 cases; the final
suite also includes the subsequent successful-dump/lost-holder failure barrier.
Final complete rerun/regression counts and exact-head CI links are recorded in
the PR, avoiding any production-readiness or achieved RPO/RTO claim.

Actual initial disposable restore evidence (source remained running):

| Evidence | Observed value |
| --- | --- |
| Backup identity | cost-engine-live-backup-uUy0zCciUtIB |
| Custom archive | 88,182 bytes, PGDMP |
| Archive SHA-256 | 73b9ffeaccbb8174b435aabd74b3a38618a683cc2ee5250c8eee68acc5cf8b76 |
| Schema SHA-256, source = restored | da6af75c9d09fa3d083cb7dc9bdc262bce64cb13432c49156910b1561f942c73 |
| Data SHA-256, source snapshot = restored | 3f4fb278f2758e8cf2c86b6ef89d85db4fb7489199164c062c7313025066a293 |
| Stored business rows | 1 Session, 2 Dataset versions, 3 Jobs, 3 Attempts, 2 snapshots, 1 upstream binding |
| Actual target | demo05d2_restore_be950de4da0ce4c559e35e4f8c44e3ce_postgres |
| Isolation | fresh owned Volume, network none, zero ports; exact-owned cleanup confirmed |
| Concurrent-write restore | snapshot 1 Session / 2 Datasets, live 2 Sessions / 3 Datasets; restored data hash equals exported snapshot |
| Runtime boundary | unchanged original Backend ID/start time and Fake execution identities; no restored Backend started |

No production operation is performed.
