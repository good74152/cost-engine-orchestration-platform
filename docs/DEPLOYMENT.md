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

This builds backend/web/operator images, stops public admission, drains/stops the
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
sh deploy/scripts/operate.sh seed
sh deploy/scripts/start.sh
```

Operator tools refuse a running named backend. Seed requires separate explicit
DEMO_SEED_DATABASE_URL_FILE (operator profile mounts the chosen target), no
DATABASE_URL fallback. It preserves the exact idempotent minimal CAPEX seed and
rejects incompatible published configuration instead of rewriting it. No HTTP
tools or automatic startup migrations/seed/down/wipe.

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
expiry. Brief maintenance downtime is deliberate. Start is repeatable; inspect
readiness/version before opening traffic. Never remove volumes to repair startup.

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

Before migrations and at the owner's required recovery interval:

```sh
export DEMO_BACKUP_DIR=/var/backups/cost-engine-demo
sh deploy/scripts/backup.sh
```

The script uses pg_dump -Fc, private `.partial` output and rename only on success.
Failed output is not a backup. Encrypt and copy successful dumps OFF HOST. Backups
contain bearer hashes/history: restrict access and never commit them. Monitor
backup age, free disk (`df -h`) and Docker storage (`docker system df`).

Validate on a separate disposable PostgreSQL 18 target with no application:

```sh
# Private pgpass/service files should supply isolated restore credentials.
createdb --maintenance-db=service=restore_admin restore_validation
pg_restore --dbname=service=restore_validation --exit-on-error --no-owner backup.dump
psql service=restore_validation -c 'SELECT count(*) FROM pgmigrations'
```

Verify migration names, seed compatibility, representative graph relationships,
counts and ownership. Retain restore evidence. Never test a restore over live DB.
Disaster restore requires stopped backend, reviewed backup/target and human approval
before traffic. The container suite validates a real dump on a separate owned DB.

## Rollback

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
quiescence. No actual public cutover or Workflow UI enablement is included.
