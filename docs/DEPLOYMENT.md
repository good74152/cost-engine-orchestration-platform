# Restricted portfolio Demo deployment

This is deployment capability, not an already deployed website. System Owner owns
VPS, DNS, credentials, production operations and launch authorization. Local tests
use disposable targets only. See [Demo-04](tasks/demo-04-secure-deployment.md) and
[ADR-0013 / threat model](adr/0013-restricted-public-demo-deployment.md).
For step-by-step first-launch commands, see the [DigitalOcean runbook](DIGITALOCEAN_RUNBOOK.md).

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
sh deploy/scripts/operate.sh migrate-up
sh deploy/scripts/operate.sh seed-six-domain
sh deploy/scripts/start.sh
sh deploy/scripts/open-web.sh
```

| Script | What it does |
|---|---|
| `deploy.sh` | Closes Web, builds images, stops the Backend and starts only the database. Never migrates, seeds or deletes data. |
| `operate.sh` | Runs one explicit operator command. Refuses while the Backend or Web runs. |
| `start.sh` | Starts the database and Backend, and leaves Web closed. Keeps a ready Backend of the same version running and refuses a wrong version. |
| `open-web.sh` | Checks the database and a ready Backend of the configured version, then starts Caddy. |
| `close-web.sh` | Stops Caddy. Idempotent, and keeps the Backend, database and data. |

If public HTTPS or a flow check fails after opening, run `close-web.sh` right away.

Startup checks profile → database → exact migration inventory → exact Demo configuration → runtime →
previous-session invalidation → listen → ready. Incomplete startup fails closed. `/health/ready` checks
initialization and live database access, and exposes status and version only. Only the Backend's loopback
probe can reach it: Caddy returns 404 for `/health` and `/health/*`.

PostgreSQL 18 mounts `/var/lib/postgresql`, with PGDATA `/var/lib/postgresql/18/docker`. Don't reuse the root
developer Compose data mount. See the [official image](https://hub.docker.com/_/postgres).

## One writer, no automatic restart

A fixed host-wide Backend container name rejects scaling and overlapping Compose projects. Don't override it,
use `compose run backend`, or let another writer touch this database. This is an operational boundary, not
distributed locking. There is no rolling deployment.

Web and Backend use `restart: no`, so a daemon restart can't reopen the public entrance. Run `start.sh` and
`open-web.sh` again afterward. External CDNs, proxies and other ingress aren't controlled by these scripts.

To stop: Caddy first, then the Backend. SIGTERM stops maintenance, waits for admitted requests and closes the
pool; Docker allows 60 seconds. New startup revokes old sessions because fake memory was lost, and the page
shows them as expired. Never remove volumes.

The scripts need an absolute readable `DEMO_DEPLOY_ENV` and check the effective Compose configuration as JSON
without printing credentials. They use host Node if present, or the Node 24 image in a read-only, network-less
parser container. See the [safety contract](tasks/demo-05d1-deployment-safety.md).

## Maintenance and retention

A bounded in-process timer cleans inactive owner graphs and releases fakes after confirmed cleanup. Busy
operations block cleanup. There's no reconciliation or dispatch worker.

[ADR-0010](adr/0010-demo-session-reset-and-recovery.md) keeps session rows to prevent identity reuse. The retained
ceiling bounds growth and eventually stops new sessions. Monitor it.

## Rollback and data

Keep the previous images and env files. Stop traffic and the Backend, check that the previous image matches the
schema, then start one Backend. The startup inventory check rejects a mismatch, so don't bypass it. Migrations aren't
run down automatically; choose a reviewed forward fix.

The demo keeps no backup. Its data is disposable anonymous sessions, and a lost database is rebuilt from migrations and
the seed ([ADR-0021](adr/0021-remove-recovery-tooling.md)).

## Monitoring and release checklist

Watch readiness, container health and version, RAM and disk, active and retained sessions, and rate and executor limits.
Logs contain event names, durable IDs and counts, not request headers or SQL.

- Review the PR and image identity, and run the build and test gates.
- Confirm one Backend, no external writers, and no public database or Node bindings.
- Verify secrets, permissions, origin and DNS/ACME.
- After opening, run all four scenarios and manual mode over HTTPS, then Reset.
- There's no automatic deploy on merge.

CI uses disposable PostgreSQL and isolated local HTTPS containers, never public credentials or targets. Dependency audits
reject high-severity findings. Use the lockfiles with `npm ci`.

## Fresh-installation deployment rehearsal

The `Fresh installation deployment rehearsal` workflow runs the real deployment scripts on a fresh GitHub-hosted machine, once per
scenario: full install through the six-domain workflow over HTTPS, and refused Backend startup. Secrets are random and disposable.
Web binds to loopback only, with a local test CA and no public DNS or ACME. The machine is discarded afterward.
