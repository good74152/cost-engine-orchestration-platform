# ADR-0013 — Restricted Single-Instance Public Demo

- Status: Accepted specification; implementation requires System Owner review.
- Date: 2026-10-27
- Authority: System Owner's Demo-04 bounded task.

## Decision

Extend ADR-0009's environment restriction only for an explicitly configured
production Demo profile. Core FakeExecutor remains development/test only.
Require APP_MODE=demo, NODE_ENV=production, EXECUTOR_TYPE=fake,
DEMO_PUBLIC_ENABLED=true, an exact HTTPS origin, and explicit bounded limits.
Conflicting injected options cannot weaken the profile.

Caddy is the sole public entry and overwrites the client-address header with
its socket peer address. Backend access is confined to its private proxy network.
The application does not trust Forwarded/X-Forwarded-* for origin or protocol.
An explicit shared proxy secret authenticates this private hop; it never enters
the frontend. No CDN or additional proxy is supported by this configuration.

Use Secure/HttpOnly/SameSite=Strict host cookies, exact mutation Origin and the
existing CSRF header. Apply bounded per-address creation/mutation rate limits,
a global mutation rate, request-body limits and concurrent-safe session admission.
Session admission takes a PostgreSQL table lock before checking active and total
retained session capacity and inserting. This is Demo admission only; core row
locks and transaction protocols are unchanged. No distributed lock service.

Retain session history under ADR-0010. Periodic, bounded, non-overlapping in-process
maintenance calls its existing cleanup/recovery service, never purges session
history or fabricates terminal execution. A retained-session ceiling makes growth
finite; reaching it denies new sessions until reviewed retention/archival work.
Cleanup failures retain the original reservations and fake identity history.

Deploy one named backend container on one VPS, stop before replacement, and
invalidate previous sessions before listening. Fixed container identity rejects
Compose scaling and overlapping projects using this deployment. This is an
operational single-writer boundary, not arbitrary external-writer protection.
Do not run core, seed, migrations or another backend concurrently with admissions.

Startup validates environment, DB, exact migration inventory and read-only seed
compatibility before runtime initialization/invalidation/readiness. Migration and
seed remain explicit offline operator commands. Shutdown closes admission and
drains Fastify, then stops maintenance and closes the pool; forced process death
does not claim in-flight operations completed.

## Threat model

| Threat | Control and residual limit |
|---|---|
| Anonymous core/raw writes or executor controls | Demo-only registration and proxy allowlist; negative route tests |
| Credential theft/CSRF | TLS, host cookie, exact Origin, CSRF header, no-store, no request/header logging |
| Spoofed forwarding headers | Caddy overwrites peer header; private backend + proxy secret; no arbitrary forwarding trust |
| Cross-session reads/mutations | Existing PostgreSQL ownership validators and per-session fake registry |
| Request/session/memory exhaustion | Body/rate/queue/session/executor/retained-history caps; VPS resource/disk monitoring still required |
| Lost fake state on restart | Stop/start deployment; revoke old credentials before readiness |
| Unsafe cleanup/unknown commit | Existing owner-scoped transactional cleanup and bounded recovery; preserve history |
| Two in-memory truth owners | Fixed container identity, no replicas, stopped-backend operator tools; no external writers |
| Destructive migration/seed/rollback | Explicit target, pre-change backup, exact compatibility checks; never automatic down or volume deletion |
| Compromised VPS/operator/database | Out of application isolation boundary; protect host, secrets and off-host backups |

No financial lifecycle, executor contract, immutable snapshot, canonical identity
or historical migration is changed. This does not claim public VPS/TLS deployment
has been performed or reviewed.
