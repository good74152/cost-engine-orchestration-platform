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

Then explicitly authorize:

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
# Only after proving offline and quiescent:
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
sh deploy/scripts/open-web.sh --confirm-owner-acceptance-05d2-05d3 --database-url-file /run/secrets/database_url
# If public HTTPS/ACME/flow acceptance fails, IMMEDIATELY close the entry:
sh deploy/scripts/close-web.sh
```

Approval covers reviewed artifacts/security/host/DNS/firewall/secrets, quiescence,
cutover, readiness, version and immediate closure. Caddy may accept
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

## Rollback

Retain previous immutable backend/web/operator images and env files. Stop traffic
and backend, check previous-image schema compatibility, select that image
version and start one backend. Exact startup inventory rejects incompatible schema;
do not bypass it. Demo-04 adds no migrations, so its own image rollback needs no
schema down. Later schema changes need individual reviewed down guards. Never
auto-down, drop DB, truncate, remove volume or delete Dataset/Session history.
Unsafe down is refused; choose a reviewed forward fix.

## Monitoring and release checklist

Monitor internal readiness/DB/container health/version, RAM/disk,
active/retained sessions, cleanup backlog, rate/executor limits and reset/startup
failures. Logs contain event names/durable IDs/counts, not request headers or SQL.

- Review PR and immutable image identity; run all build/regression gates.
- Confirm one backend, no external writers, no public DB/Node bindings.
- Verify secrets/permissions, origin and DNS/ACME.
- Stop admissions/backend before explicit migration/seed; start and check readiness.
- In WORKFLOW_OPEN run all four scenarios and manual mode; verify reads, Reset and restart.
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
Confirm DRAINING, stop Backend/ingress/requests/writers and resolve retained work before explicitly choosing the intended Demo DB. The new
operator accepts DEMO_CUTOVER_DATABASE_URL or FILE only; production commands are
cutover-status/cutover with the explicitly supplied target. No URL fallback.

WORKFLOW_OPEN is irreversible and requires a compatible new Backend with target
configuration validation. Do not restart an old image, run legacy seeds, auto-down
or delete v1 to recover a failed deployment. Keep traffic closed, confirm durable
state and choose a reviewed forward fix. SQL counts do not prove process
quiescence. No actual public cutover is performed by this implementation.

## Page deployment and recovery

The [page](adr/0020-one-page-demo-ui.md) reads Workflow availability from the Backend Gate. Ship compatible Backend and Frontend images together; no Frontend setting can open Workflow. Outside WORKFLOW_OPEN, scenarios stop with a dialog explaining the missing configuration. Deployment still requires the offline sequence above.

Browser refresh rereads durable state on the current running Backend. Backend restart still loses process-local Fake state and invalidates old Sessions; it is not browser recovery. Keep traffic closed if deployment or cutover fails, follow the reviewed forward-fix or restore plan, and never reopen an old binary. `npm run ui:smoke` must not target live Demo data.

## Fresh-installation deployment rehearsal

The `Fresh installation deployment rehearsal` workflow runs the real deployment scripts on a
fresh GitHub-hosted machine, once per scenario: full install through the six-domain workflow over
HTTPS, refused Backend startup, and refused cutover without drain. Secrets are random and
disposable. Web binds to loopback only, with a local test CA and no public DNS or ACME. Nothing is
kept afterward, because the machine is discarded.

The demo keeps no backup. Its data is disposable anonymous sessions, and a lost database is rebuilt
from migrations and the seed. See [ADR-0021](adr/0021-remove-recovery-tooling.md).
