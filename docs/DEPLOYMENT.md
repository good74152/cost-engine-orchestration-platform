# Restricted portfolio Demo deployment

This is deployment capability, not an already deployed website. System Owner owns
VPS, DNS, credentials, production operations and launch authorization. Local tests
use disposable targets only. See [Demo-04](tasks/demo-04-secure-deployment.md) and
[ADR-0013 / threat model](adr/0013-restricted-public-demo-deployment.md).

## Architecture and security

Browser → HTTPS Caddy (80/443, built React) → private proxy network → one Node 24
Fastify Demo backend → private database network → persistent PostgreSQL 18.
Only Caddy publishes ports. No Vite server, CDN, wildcard CORS or real Airflow.

Caddy overwrites client-IP and proxy-secret headers with its socket peer and a
mounted secret. Backend verifies the private hop, trusts no arbitrary Forwarded
headers, and validates the explicit exact HTTPS Origin. Do not add an unconfigured
CDN/proxy. Public APIs are existing `/demo/*`. Core,
raw-ingestion, callbacks, internal controls, debug/admin/migration/seed routes are
not registered in Demo mode; Caddy additionally blocks those URL families.

Production requires ALL of NODE_ENV=production, APP_MODE=demo, EXECUTOR_TYPE=fake,
DEMO_PUBLIC_ENABLED=true and validated origin/secrets/limits. Conflicting injected
options fail closed. Core's FakeExecutor factory remains development/test only.

Cookies are `__Host-ce_demo_session`, Secure, HttpOnly, SameSite=Strict, Path=/,
no Domain, fixed four-hour TTL. POST needs exact Origin + X-Demo-Session: 1. GET
rejects supplied foreign Origin/cross-site fetch. Same-origin browser credentials
never enter JS storage. APIs use no-store. Caddy supplies CSP/HSTS/browser headers;
hashed assets cache immutably for a year, HTML uses no-cache. Access logging is
off; application events omit URLs/headers/tokens/hashes/passwords/SQL credentials.

## Configuration

Copy deploy/env.example to a private absolute env-file location. Set immutable
DEPLOYMENT_VERSION (Git/image tag), DEMO_PUBLIC_ORIGIN (e.g. https://demo.example.com,
no trailing slash/path/query), ACME_EMAIL and DEMO_SECRETS_DIR. Create three private
one-line files outside Git:

- postgres_password: cryptographic random password, at least 16 characters; hex
  avoids URL encoding mistakes.
- database_url: postgres://demo_owner:<same-password>@database:5432/cost_engine_demo
- proxy_secret: 32–64 cryptographic random bytes encoded as 64–128 lowercase hex.

Use a 0700 parent directory. Give backend UID 1000 read access to its mounted files
(for example UID 1000 owner, mode 0400); Caddy/DB entrypoint also need read access.
Compose file secrets are bind mounts, not encrypted storage. Protect operator and
backup access. Never put secrets in frontend VITE variables/build args, repository,
public env files, shell tracing or request logs. Node reads secrets before the pool.

| Setting | Default / allowed bound |
|---|---|
| DEMO_MAX_ACTIVE_SESSIONS | 100 / 1–1000 |
| DEMO_MAX_RETAINED_SESSIONS | 10000 / up to 1000000, at least active |
| DEMO_MAX_EXECUTORS | 100 / no greater than active |
| DEMO_CREATES_PER_MINUTE | 10 / up to 100 per address |
| DEMO_MUTATIONS_PER_MINUTE | 120 / up to 1000 per address |
| DEMO_GLOBAL_MUTATIONS_PER_MINUTE | 600 / up to 5000 |
| DEMO_BODY_BYTES | 16384 / up to 65536 |
| DEMO_MAINTENANCE_INTERVAL_MS | 60000 / 1000–3600000 |
| DEMO_MAINTENANCE_BATCH | 25 / 1–100 |

One-minute windows retain at most 4096 address keys and fail closed on exhaustion.
Check the session-creation and per-address mutation limits before the global
limit. Charge all applicable budgets only when every check passes, synchronously
without an await. Locally rejected requests spend no global quota; global capacity
remains strict. Admitted requests count even if a later route/business check fails.
NAT users share budgets. 429 DEMO_RATE_LIMITED includes Retry-After. Session/fake
capacity uses 503 DEMO_SESSION_CAPACITY_REACHED / DEMO_EXECUTOR_CAPACITY_REACHED.
Existing queue limits remain. These are basic abuse controls, not DDoS protection.
Docker memory/PID limits and VPS disk/RAM monitoring remain required.

Session capacity check + insertion use one transaction with a PostgreSQL table
lock, not a racing count-then-insert. Five candidates, secure hash/token and
historical-company collision guard remain. Core orchestration locks are unchanged.

## Authorized VPS / DNS / HTTPS checklist

1. Prepare a patched Linux VPS, Docker/Compose with `!override` support, secured
   administration and firewall. Allow public 80/443 only; no DB or Node port.
2. Point DNS A/AAAA at the VPS; verify IPv6/firewall and exact configured origin.
3. Configure ACME email. Caddy obtains/renews the public certificate and retains
   its account/certificates in named volumes.
4. With authorization, verify public certificate chain, redirects, headers and
   full flows. Local internal-CA tests do not prove public DNS/TLS issuance.

## Build and initialize

From the reviewed checkout on the authorized VPS:

```sh
export DEMO_DEPLOY_ENV=/opt/cost-engine-demo/compose.env
docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml config --quiet
sh deploy/scripts/deploy.sh
```

This closes Web, builds backend/web/operator images, drains/stops the
named backend and starts only DB. It never migrates, seeds, deletes data or opens
HTTP. First installation initializes a named volume with explicit credentials.
PG18 mounts `/var/lib/postgresql`, with PGDATA `/var/lib/postgresql/18/docker`.
Do not reuse the old root developer Compose data mount. See the
[official image](https://hub.docker.com/_/postgres) and
[Docker persistence guide](https://docs.docker.com/guides/postgresql/immediate-setup-and-data-persistence/).

For existing data take and restore-validate a backup BEFORE migrations. Then
explicitly authorize:

```sh
sh deploy/scripts/operate.sh migrate-up
sh deploy/scripts/operate.sh seed-six-domain
```

These are separate explicit commands, not an automatic initialization pipeline.
Current public Workflow deployment needs separately reviewed offline drain/cutover
below. Never execute a Legacy seed against WORKFLOW_OPEN.

Operator tools refuse a running named backend. Seed requires separate explicit
DEMO_SEED_DATABASE_URL_FILE (operator profile mounts the chosen target), no
DATABASE_URL fallback. It preserves the exact idempotent minimal CAPEX seed and
rejects incompatible published configuration instead of rewriting it. No HTTP
tools or automatic startup migrations/seed/down/wipe.

Modifying commands also require Web stopped and automatic restart disabled for
stopped writers/entrypoints. deploy.sh prepares this state. Read-only status may
run with Backend online; --no-deps avoids implicitly starting other services.

```sh
sh deploy/scripts/operate.sh admission-status --database-url-file /run/secrets/database_url
# Only after proving offline/quiescence/backup prerequisites:
sh deploy/scripts/operate.sh admission-drain --database-url-file /run/secrets/database_url
sh deploy/scripts/operate.sh cutover-status --database-url-file /run/secrets/database_url
# A separate reviewed invocation; never automatically retried:
sh deploy/scripts/operate.sh cutover --database-url-file /run/secrets/database_url
```

Admission/Cutover require that explicit shared Demo target file; no DATABASE_URL
fallback. Existing Unknown COMMIT semantics remain: preserve closure, confirm
durable state independently, and never assume rollback or retry automatically.

The optional Demo-05A configuration uses the same stopped-backend operator:
`sh deploy/scripts/operate.sh seed-six-domain`. Run it explicitly after migrations
and before `start.sh`; it can initialize all six domains or extend the existing
guided CAPEX configuration in one transaction. `seed` retains its original minimal
behavior. See [type codes, dependencies and conflict safety](tasks/demo-05a-six-domain-configuration.md).

Startup validates profile → DB → exact migration inventory → read-only seed
compatibility → runtime → previous-session invalidation → listen → ready.
Incomplete startup fails closed. `/health/ready` checks initialization and live
DB access, returns 503 when unavailable, and exposes status/version only. Process
alive alone is not ready. Only the backend loopback GET probe can reach readiness.
Caddy returns 404 for /health and /health/* without proxying them, even if the
backend is stopped. The public profile independently rejects non-loopback health
requests before PostgreSQL access; forwarded headers cannot grant probe access.
Use Docker's health status or an authorized loopback probe for DB monitoring.

## Stop → Deploy → Start

One fixed host-wide backend container identity rejects scaling/overlapping Compose
projects using this configuration. Do not override the name, use `compose run
backend`, start Core/another runtime or allow external/config writers against
this DB. This is an operational boundary, not distributed locking. Only one owner
deployment operation at a time. No rolling deployment or accepting replica overlap.

Stop Caddy first, stop Node admission and drain Fastify. SIGTERM stops maintenance,
waits for admitted requests/cleanup, then closes the pool; Docker allows 60s.
Forced process death does not mean dispatch/step completion. New startup revokes
old sessions before readiness because fake memory was lost; UI 401 handling shows
expiry. Brief maintenance downtime is deliberate. Start preserves a ready
same-version Backend process, starts DB/Backend only and leaves Web closed.
Wrong running versions are refused rather than replaced. Never remove volumes.

```sh
sh deploy/scripts/start.sh
# Complete necessary Demo-05D-2 / 05D-3 Owner acceptance before PUBLIC TRAFFIC:
sh deploy/scripts/open-web.sh --confirm-owner-acceptance-05d2-05d3 --database-url-file /run/secrets/database_url
# If public HTTPS/ACME/flow acceptance fails, IMMEDIATELY close the entry:
sh deploy/scripts/close-web.sh
```

Approval covers reviewed artifacts/security/host/DNS/firewall/secrets, restore-tested
backup, quiescence/cutover/readiness/version and immediate closure acceptance. This
task does not claim production 05D-2/05D-3 acceptance has occurred. Caddy may accept
traffic immediately. Open checks live DB, unique healthy Backend, configured Image
Tag/container environment/loopback readiness version, then the existing Cutover
Status Operator. Complete JSON must confirm WORKFLOW_OPEN + WORKFLOW; exit code or
matching text is insufficient. No financial configuration validator is duplicated.
Failed startup attempts explicit closure and retains DB/configuration. Verify public
HTTPS/ACME after authorized opening and close immediately if checks fail.

Web uses public-web profile and restart: no; Backend also uses restart: no. Default
Compose selects DB/Backend only; daemon restart cannot resume Backend/public Web.
Use explicit start/approved open afterward. Close is idempotent, confirms project
Web stopped and retains Backend/DB/data/Session/Gate/configuration/volumes. External
CDN/proxies/other ingress are not controlled. If Docker cannot confirm closure,
use the Owner's external ingress plan rather than claiming the entry is closed.

Controls use an absolute readable DEMO_DEPLOY_ENV and absolute checked-in Compose
file. Reviewed alternatives use DEMO_COMPOSE_FILE and optional DEMO_COMPOSE_OVERRIDE;
keep the production host-wide Backend identity. Effective configuration is checked
as JSON without printing credentials. JSON parsing uses host Node if available or
the same Node 24 image in an unprivileged read-only network-none parser container.
Docker-only hosts need no extra installation. One Owner operation at a time;
arbitrary Docker administrators/external writers remain outside this boundary.
See [complete safety contract/evidence](tasks/demo-05d1-deployment-safety.md).

## Maintenance and retention

The bounded non-overlapping in-process timer calls existing owner cleanup and
unknown-commit recovery. It cleans only inactive owner graphs and releases fakes
after confirmed cleanup. Busy operations block cleanup; an idle DB RUNNING job
follows existing Reset semantics. Failures remain isolated/logged; uncertain
reservations retain blocking and identity history. No reconciliation/dispatch worker.

ADR-0010 retains Session history to prevent identity reuse. Those rows stay.
The retained ceiling bounds total growth and eventually stops new admissions.
Monitor it and request reviewed retention/archival work before exhaustion; do not
purge history or increase limits indefinitely. Foreign-FK cleanup fails closed.

## Backup and restore

Demo-05D-2's tools verify the **first public deployment**: migrated, completely
empty business data, exact six-domain/nine-Type LEGACY configuration and DRAINING.
They do not replace a separately reviewed operational backup policy for a running
or already-cut-over service. Existing Session history is intentionally a failure;
do not delete history to make the check pass.

First keep Web and Backend stopped with restart disabled using the Demo-05D-1
runbook. The Owner must confirm no other Backend, external writer, concurrent
deployment or unresolved unknown outcome. Docker/SQL checks cannot prove those
facts. Then explicitly select the shared Demo database:

```sh
sh deploy/scripts/operate.sh cutover-preflight --database-url-file /run/secrets/database_url
# Provision a private existing directory OUTSIDE every Git worktree:
export DEMO_BACKUP_DIR=/var/backups/cost-engine-demo
sh deploy/scripts/backup.sh --database-url-file /run/secrets/database_url
```

Preflight returns deterministic JSON with PASS, Deployment Version, PostgreSQL 18,
DRAINING/LEGACY, exact migration names, all 21 business-table counts and schema/
configuration fingerprints. It reuses existing Gate/configuration/quiescence
validators and never writes, migrates, seeds, cleans, cuts over or opens Web.
PASS describes the checked instant only; it is neither approval nor durable state.

Backup additionally requires that the mounted target names this Compose database
service (`database`, `demo_owner`, `cost_engine_demo`, normal port, no URL query
overrides). It must not validate a different database and then dump this one.
It creates a fresh private `cost-engine-backup-*` directory, custom pg_dump -Fc,
600-mode archive/manifest and SHA-256/decimal-byte-size/identity evidence. It checks
preflight again afterward and compares all evidence. Failure removes only its new
incomplete bundle; older backups are never replaced or removed. No retry occurs.
Each pg_dump has its own consistent PostgreSQL snapshot. Before/after checks do
not fence arbitrary external writers; maintain Owner-proven offline quiescence.

Use the returned identity to explicitly verify the archive:

```sh
sh deploy/scripts/verify-backup.sh --backup-file /var/backups/cost-engine-demo/cost-engine-backup-IDENTITY/backup.dump
```

Verify accepts no target URL/database/container/volume. It checks custom format,
size/checksum/complete manifest before creating a 128-bit random, labelled own
PostgreSQL 18 container/database/volume. Its network is `none`, no port is published,
no deployment secret/network/volume is mounted and no real credential is used.
Only a read-only operator container shares that new namespace to reuse the actual
configuration/schema/preflight verifier after pg_restore --exit-on-error. The
corresponding immutable `cost-engine-demo-operator:<Deployment Version>` image must
already exist. Every restored field must match the recorded backup evidence.
Ownership, network and mount checks precede startup/restore/cleanup. Only exact
owned resources are removed; uncertainty refuses cleanup and withholds success.

RESTORE_VERIFIED is emitted only after real restore, validation and cleanup. It
does not approve Cutover, perform production recovery or prove off-host storage.
SHA-256 proves file consistency, not authenticity or restorability; retain the
trusted manifest with the archive. Encrypt/copy successful bundles OFF HOST under
the Owner's policy and retain restore evidence. Backups may contain secrets/history;
never log contents or commit them. Monitor disk, backup age and Docker storage.

On failure keep Web closed. WORKFLOW_OPEN + WORKFLOW means use compatible forward
fixes, not reapplication or reversal. DRAINING + LEGACY requires fresh Preflight
and separate human approval before an explicit Cutover retry. Conflict/UNKNOWN/
DB unavailable means stop and use existing durable confirmation; never infer
rollback, automatically retry, restore, down-migrate, delete Definition v1/v2 or
open Web. Actual disaster recovery needs separate explicit authorization and a
reviewed target/data-loss plan. This tool can only restore disposable targets.
See [full contract, transaction boundary and evidence](tasks/demo-05d2-cutover-preflight-backup-recovery.md).

## Rollback

For WORKFLOW_OPEN operational backups containing business data, use the separate
[online backup runbook](#operational-backup-after-workflow-cutover). The existing
first-deployment backup remains DRAINING/LEGACY/empty/offline only.

Retain previous immutable backend/web/operator images and env files. Stop traffic
and backend, backup, check previous-image schema compatibility, select that image
version and start one backend. Exact startup inventory rejects incompatible schema;
do not bypass it. Demo-04 adds no migrations, so its own image rollback needs no
schema down. Later schema changes need individual reviewed down guards. Never
auto-down, drop DB, truncate, remove volume or delete Dataset/Session history.
Unsafe down is refused; choose a reviewed forward fix or approved restore with
explicit data-loss implications. Restore-test backups before deciding.

## Monitoring and release checklist

Monitor internal readiness/DB/container health/version, RAM/disk, backup age/off-host copies,
active/retained sessions, cleanup backlog, rate/executor limits and reset/startup
failures. Logs contain event names/durable IDs/counts, not request headers or SQL.

- Review PR and immutable image identity; run all build/regression gates.
- Confirm one backend, no external writers, no public DB/Node bindings.
- Verify secrets/permissions, origin, DNS/ACME and off-host restore-tested backup.
- Stop admissions/backend before explicit migration/seed; start and check readiness.
- In LEGACY_OPEN exercise Guided flows, Free Exploration, Resource Explorer, Reset and restart.
- In WORKFLOW_OPEN verify Legacy Scenario admission is denied, and explicitly
  publish FAB_COST before running both CAPEX Jobs; verify reads, Reset and restart.
- Record actual public VPS/DNS/TLS evidence separately; no automatic deploy on merge.

CI uses disposable PostgreSQL and isolated local HTTPS containers, never public
credentials/targets. [Executed verification](verification/demo-04-deployment.md).
Root and frontend dependency audits reject high-severity findings. Use the
reviewed lockfiles with npm ci; do not replace them with an unreviewed upgrade
or grant install-script approvals merely to suppress an npm warning.

## Legacy admission drain installation

Before installing Demo-05C-2 on an existing deployment, follow the
[first-installation and rollback runbook](tasks/demo-05c2-legacy-admission-drain.md#deployment-runbook).
Do not restart a Backend with active Sessions to install the Gate: startup revokes
those credentials and loses process-local Fake state. Suspend new admission via a
verified replay-aware entrypoint, preserve existing operations and Backend cookie
validation, confirm actual quiescence, then update/migrate and explicitly drain.
Keep admission closed when rolling back to a Gate-unaware binary. Configuration
cutover is deferred to Demo-05C-3 and cannot be authorized by a SQL count alone.

## Workflow configuration cutover capability

Demo-05C-3A provides status/cutover only; applying its migration does not cut over.
Use the [offline operator and failed-deployment runbook](tasks/demo-05c3a-configuration-cutover.md#offline-runbook-and-failed-deployment-recovery).
Confirm DRAINING, stop Backend/ingress/requests/writers, resolve retained work and
review backup/restore before explicitly choosing the intended Demo DB. The new
operator accepts DEMO_CUTOVER_DATABASE_URL or FILE only; production commands are
cutover-status/cutover with the explicitly supplied target. No URL fallback.

WORKFLOW_OPEN is irreversible and requires a compatible new Backend with target
configuration validation. Do not restart an old image, run legacy seeds, auto-down
or delete v1 to recover a failed deployment. Keep traffic closed, confirm durable
state and choose a reviewed forward fix/restore. SQL counts do not prove process
quiescence. No actual public cutover is performed by this implementation.

## Workflow UI deployment and recovery

Demo-05C-3C Frontend reads authenticated Workflow availability from Backend Gate.
Ship compatible Backend/Frontend images together; no Frontend environment switch
can open Workflow. LEGACY_OPEN keeps Guided, DRAINING keeps existing Guided only,
and WORKFLOW_OPEN replaces new Legacy Create with Workflow Explorer. Old Guided
deep links safely redirect. Missing/unavailable contracts fail UI mode actions
closed and offer Refresh, rather than guessing WORKFLOW_OPEN. Free Exploration,
Reset and ownership checks remain. Deployment still requires the offline sequence
above; serving this UI does not execute Cutover or prove process quiescence.

Verify all four v2 Templates, two independently operated CAPEX Jobs, explicit
Dataset binding, Reconcile/Validate/Publish, reload with zero mutation, lost ACK
recovery using one Attempt, network-error recovery, Reset and Session isolation.
Use separate disposable Workflow-cutover and Legacy browser fixtures in CI;
`npm run ui:smoke:workflow` and `npm run ui:smoke` must not target live Demo data.
Browser refresh rereads durable state on the current running Backend. Backend
restart still loses process-local Fake state and invalidates old Sessions; it is
not browser recovery. Keep traffic closed if deployment/cutover fails and follow
the reviewed compatible-forward-fix/restore plan; never reopen an old binary.

## Operational backup after Workflow cutover

This capability operates only against the explicitly selected existing Compose
Demo database with WORKFLOW_OPEN and the complete WORKFLOW catalog. It does not
authorize any production operation. One System Owner coordinates the operation;
exclude deployments, migration/seed/configuration/Cutover commands and other DBA
changes for its duration. Keep immutable images, Compose files and secrets fixed.
Normal user API traffic continues; do not stop/restart Backend for this backup.
If Backend is running its actual health/image/version must match the selected
Deployment Version; a stopped/absent Backend is also permitted without starting it.

Provision a private outside-Git directory owned by the trusted operator, mode
0700 on POSIX (equivalent private Windows ACLs). Ensure free space for the dump,
SQL sorts and restored Docker volume. Retain the matching immutable local
`cost-engine-demo-operator:<Deployment Version>` image and trusted manifest.

```sh
export DEMO_DEPLOY_ENV=/opt/cost-engine-demo/compose.env
export DEMO_BACKUP_DIR=/var/backups/cost-engine-demo
sh deploy/scripts/backup-live.sh --database-url-file /run/secrets/database_url

# Only the archive is supplied. No production URL/volume/target is accepted.
sh deploy/scripts/verify-backup-live.sh --backup-file /var/backups/cost-engine-demo/cost-engine-live-backup-IDENTITY/backup.dump
```

The target file must name `database:5432/cost_engine_demo` as `demo_owner`, without
connection query overrides. No implicit DATABASE_URL fallback. Each backup uses
a fresh private bundle, pg_dump custom format, SHA-256 and byte size. Output
records Deployment Version, timestamps and validated snapshot evidence. Do not
log, publish or commit archives/manifests; they include retained private data.
SHA-256 is corruption detection, not authentication: protect/encrypt the bundle
and verify the trusted off-host copy after transfer. Never replace a manifest to
make a failed archive appear trusted.

REPEATABLE READ establishes the data view before export; the holder remains alive
until pg_dump finishes with that exact snapshot. Concurrent committed Session,
Dataset, Job/Attempt and Publish changes after the snapshot are intentionally
excluded. Snapshot counts need not equal live counts after backup. Nontransactional
sequence counters can advance; gaps are normal. This is a logical single-database
backup, not cluster roles/tablespaces, external executor state or PITR/WAL backup.
See PostgreSQL's [pg_dump snapshot option](https://www.postgresql.org/docs/18/app-pgdump.html)
and [exported snapshot semantics](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION).

Database/connection/dump/validation/checksum/holder failure returns nonzero and
removes only the newly created incomplete bundle; earlier backups remain. The
transaction releases locks on exit/disconnection. Inspect any reported unresolved
owned-resource cleanup privately; never prune arbitrary resources. No automatic
retry follows an outage. Investigate, confirm source health, then explicitly
start a new backup. Limits: lock wait 3 seconds, individual SQL 60 seconds,
snapshot readiness 120 seconds and holder lifetime 60 minutes. A large database
may exceed these bounds; do not claim a backup succeeded or loosen verification
to bypass them. Review capacity/retention and a separate scale plan if necessary.

Verification restores into a fresh isolated PostgreSQL 18 Container/Volume, with
no published ports, no source volume/secrets and network none. It reuses existing
ownership checks/cleanup and shared Configuration/Schema validators. It verifies
actual FK/CHECK data and complete row hashes as well as schema/configuration,
migrations and counts. Only successful real restore, evidence match and cleanup
produce RESTORE_VERIFIED. Run it with the source offline as an independence drill;
it must not start Backend. Any failure means no recovery capability is confirmed.

### Backup policy to be set by System Owner

Record the approved values, owners, alerts and executed evidence; none is an
achieved RPO/RTO claim. No scheduler or automatic historical-backup deletion is
implemented by this task.

| Control | Owner sets / measures |
| --- | --- |
| Backup frequency | Maximum interval, operating window, explicit operator/scheduling ownership; account for write rate and failed backups. |
| Retention | Required daily/weekly/monthly history and legal/privacy constraints; review copies before any separately authorized manual deletion. |
| Off-host backup | Independent host/storage, encryption/access/key handling, verified hash after transfer and restore drill from that copy. |
| Backup age monitoring | Alert threshold from snapshot/start time, latest successful bundle and latest independent restore evidence; failure must not reset age. |
| Restore verification frequency | Every release/schema change and Owner-selected periodic interval/sample; retain exact archive/image/version evidence. |
| Disk usage monitoring | Host backup storage, PostgreSQL temporary space/MVCC growth, Docker data/verification volume and retention headroom; alert thresholds. |
| RPO | Desired acceptable data-loss window versus age of the newest trusted restore-verified snapshot and write-volume evidence. |
| RTO | Desired service recovery window; measure retrieval, restore, validation, secrets/images, reviewed runtime/executor recovery and authorized reopening separately. |

### Production recovery limitation

**Database Restore and restoring users' calculation execution capability are
different operations.** This tool verifies only disposable database restoration.
Actual production recovery requires separate System Owner authorization, explicit
target/data-loss review and a reviewed recovery plan. There is no production
restore command, automatic Backend restart, Job rerun or Attempt redispatch.
Restored accepted/dispatching/unknown Attempts are stored evidence; they do not
prove a corresponding running executor exists.

FakeExecutor execution/rejection memory is not in pg_dump. Restart loses it, and
normal Backend startup invalidates prior Sessions before listening. Do not bypass
that invalidation, reconstruct fake outcomes from stored rows, replay unknown
dispatches automatically or alter existing Unknown Outcome/Reset recovery.
RESTORE_VERIFIED cannot approve public activation or claim end-to-end recovery.
See [scope, evidence and failure handling](tasks/demo-05d3a-operational-backup.md).

## Disaster Recovery Drill

After an operational backup exists, use the separate
[read-only DR Drill runbook](RECOVERY_DRILL.md) to restore and assess only an
isolated PostgreSQL target and publish a private JSON report. It reuses the
existing verification engine. Existing `verify-backup-live.sh` remains available
with its unchanged RESTORE_VERIFIED contract. The drill starts no Backend and
provides no production restore target or automatic runtime/executor recovery.
Report duration measures database-drill stages, not achieved service RTO; Owner
recovery approval and measured production RPO/RTO remain separate obligations.

## Offline Recovery Readiness

After retaining trusted Operational Backup and actual 3B Drill evidence, run the
separate [Recovery Readiness CLI](RECOVERY_READINESS.md) with explicit private
source/output directories and Owner policy. It performs no backup, restore,
database connection, storage sync or automatic scheduling. Local and Off-host
recovery points are assessed separately; Disaster READY additionally requires a
hash-bound Owner-signed retrieval and actual Drill review under policy-trusted
keys. The report distinguishes independent local checks from physical provenance
attestation. No production RPO/RTO, execution recovery or approval is granted.
