# Demo-05D-3C — Recovery Readiness Assessment

Status: implemented; local verification passed, GitHub verification pending;
awaits System Owner Review.
Baseline: latest main `cdfa5670352d4feff268db25911739307f188bda` (PR #46).
Branch: `codex/demo-05d3c-recovery-readiness`.

## Authorized scope

Independent read-only offline CLI, explicit policy, Operational Backup inventory,
existing 3B Drill DTO validation, trusted signed Owner off-host retrieval review,
separate Local/Disaster readiness and private atomic JSON report. See
[ADR-0019](../adr/0019-offline-recovery-readiness-evidence.md) and the
[operator runbook](../RECOVERY_READINESS.md) for trust boundaries and exact formats.

No backup/restore engine, database URL/target, Docker operation, public API,
migration, state-machine change, retry/redispatch, scheduler, sync, Backend/Web
activation or production operation is introduced. Existing 3A/3B contracts remain
unchanged. Their shared manifest assertion and private-directory boundary are
extracted without semantic change. Existing `assessRpo()` and complete 3B manual
assessment parser are reused; readiness never queries PostgreSQL itself.

## Implemented behavior

Each candidate is bounded, read-only, private and regular; source symlinks and
file replacement during reading are rejected. Full archive SHA/size/custom header
must match exact Operational metadata. Complete Drill flags, phases, chronology,
assessment and identity/version/schema/configuration/data/count bindings must
match that specific backup. Current evidence is selected per backup, independently
for local and off-host. An undrilled new backup cannot refresh a recovery point.

Three duration policies are mandatory with no defaults. Ed25519 review signatures
are verified against explicit policy public keys, not keys or booleans supplied
by evidence. Every signed retrieval is bound to exact original/retrieved SHA and
actual Drill report SHA. Physical retrieval/copy use are explicitly Owner-attested;
independent file/signature validation is disclosed separately. Fake/untrusted
evidence never grants READY. Service recovery and approval always remain false.

All rejected/expired candidates are recorded without arbitrary strings/secret
propagation. Resource-limit or required I/O failure aborts report publication.
Exclusive random report directories and private synced temporary files/atomic
rename protect previous reports. Only explicit output-root files can be written.

## Verification

Automated offline tests exercise READY, AT_RISK, NOT_VERIFIED, new unverified vs
old verified recovery points, fresh/stale history, off-host-independent RPO,
trusted/tampered/self-signed reviews, strict DTOs and hash/version/identity links,
time/clock failures, permissions, publication failure, resource limits, source
immutability and secret-free CLI behavior. Existing real 3B Docker restore tests
also assert that actual emitted populated reports pass the downstream validator.
Existing 3A/3B/3D2 PostgreSQL and Docker suites remain enabled without reduction.

Executed results and CI evidence are recorded below before delivery. Production
RPO/RTO, physical off-host provenance and actual service recovery are not proven
by these fixtures. Windows source privacy uses existing Owner-managed ACL trust;
Linux CI verifies POSIX restrictions.

### Executed local verification

| Check | Result |
| --- | --- |
| Offline readiness / CLI / real filesystem fault injection | 43 PASS, 0 FAIL |
| 3B real PostgreSQL read-only assessment regression | 12 PASS, 0 FAIL |
| 3A real PostgreSQL operational backup regression | 19 PASS, 0 FAIL |
| 3D2 real PostgreSQL preflight/schema regression | 58 PASS, 0 FAIL |
| Core milestone | 259 PASS, 0 FAIL |
| Build, readiness/3A/3B/3D2 strict typecheck, shell syntax, diff whitespace | PASS |
| Local 3B Docker bootstrap | BLOCKED: npm registry TLS ECONNRESET during `npm ci`; 2 harness failures before restore; owned teardown completed |

The PostgreSQL checks used a newly owned disposable PostgreSQL 18 Container and
owned fixture databases; the Container/anonymous volume and private connection
file were removed afterward. No production resource was accessed. The local
Docker transport failure is not a passing restore result; unchanged real Docker
suites remain mandatory in GitHub CI, including new downstream validation of
actual 3B emitted reports. CI evidence will be linked in delivery.
