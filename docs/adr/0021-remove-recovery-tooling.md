# ADR-0021 — Remove Recovery Tooling

- Status: Accepted. Supersedes [ADR-0019](0019-offline-recovery-readiness-evidence.md).
- Scope: operational tooling only. No orchestration, lifecycle, locking or API behavior changes.

## Context

The repository had grown about 2,900 lines of backup, restore verification, disaster-recovery drills and
offline readiness reports, plus four CI jobs. Their subject is a demo whose data is anonymous sessions that
expire in four hours. Startup already invalidates every session, because FakeExecutor memory doesn't survive
a restart, so a restored database could never resume work anyway.

That tooling was larger than the project's point, and it pulled attention away from the orchestration core.

## Decision

Delete it. The demo keeps no backup. A lost database is rebuilt with migrations and the seed.

Shrink the deployment rehearsal to the scripts that remain. It runs on a disposable GitHub-hosted machine, so
its own resource ownership checks, cleanup, sanitized report and aggregation job go too. A failed rehearsal is
a failed CI run.

## Consequences

- A disk failure loses demo sessions. Visitors start a new one.
- There is no RPO or RTO to claim, and none is claimed.
- A real production system holding real data would need backups. This doesn't argue otherwise. If the demo ever
  held data worth keeping, the code is in Git history.
