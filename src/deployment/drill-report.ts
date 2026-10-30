import type { RecoveryAssessment } from './recovery-assessment.js';

export const drillPhases = ['INTEGRITY_CHECK', 'RESTORE', 'VALIDATION', 'ASSESSMENT', 'CLEANUP'] as const;
export type DrillPhase = typeof drillPhases[number];
export const drillRejected = () => new Error('DR drill failed; no verified report or production recovery approval');
export function isoTime(value: unknown): number {
  if (typeof value !== 'string') throw drillRejected(); const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== value) throw drillRejected(); return time;
}
export function assessRpo(startedAt: unknown, createdAt: unknown, assessedAt: unknown, targetRpoMs: number | null) {
  const start = isoTime(startedAt), created = isoTime(createdAt), assessed = isoTime(assessedAt);
  if (start > created || created > assessed || (targetRpoMs !== null && (!Number.isSafeInteger(targetRpoMs) || targetRpoMs < 0))) throw drillRejected();
  const backupAgeMs = assessed - start; if (!Number.isSafeInteger(backupAgeMs)) throw drillRejected();
  return { backupStartedAt: startedAt as string, assessedAt: assessedAt as string, backupAgeMs, targetRpoMs,
    result: targetRpoMs === null ? 'NOT_CONFIGURED' as const : backupAgeMs <= targetRpoMs ? 'WITHIN_TARGET' as const : 'EXCEEDS_TARGET' as const,
    actualDataLoss: 'UNKNOWN' as const, productionRpoAchieved: false as const };
}

/** Wall-clock checks protect RPO evidence; all durations use the monotonic clock.
 * A backward wall clock or >1s divergence invalidates the entire drill report. */
export class DrillClock {
  private readonly originWall: number; private readonly originMono: bigint; private lastWall: number; private lastMono: bigint;
  private lastEmissionWall: number; private lastEmissionMono: bigint;
  constructor(private readonly wall = Date.now, private readonly mono = process.hrtime.bigint) {
    this.originWall = this.lastWall = wall(); this.originMono = this.lastMono = mono();
    this.lastEmissionWall = this.originWall; this.lastEmissionMono = this.originMono;
    if (!Number.isSafeInteger(this.originWall)) throw drillRejected();
  }
  sample() {
    const wall = this.wall(), mono = this.mono(); const elapsed = Number(mono - this.originMono) / 1e6;
    if (!Number.isSafeInteger(wall) || wall < this.lastWall || mono < this.lastMono || !Number.isFinite(elapsed)
      || Math.abs(wall - this.originWall - elapsed) > 1000) throw drillRejected();
    this.lastWall = wall; this.lastMono = mono;
    return { at: new Date(wall).toISOString(), elapsedMs: elapsed };
  }
  /** Timestamp at emission, not receipt: buffered IPC cannot collapse stage time. */
  observeEmission(at: unknown, nanoseconds: unknown) {
    const wall = isoTime(at);
    if (typeof nanoseconds !== 'string' || !/^[0-9]{1,24}$/.test(nanoseconds)) throw drillRejected();
    const mono = BigInt(nanoseconds), now = this.mono(), elapsedMs = Number(mono - this.originMono) / 1e6;
    if (mono < this.lastEmissionMono || wall < this.lastEmissionWall || mono > now || mono < this.originMono
      || !Number.isFinite(elapsedMs) || Math.abs(wall - this.originWall - elapsedMs) > 1000) throw drillRejected();
    this.lastEmissionMono = mono; this.lastEmissionWall = wall;
    return { at: at as string, elapsedMs };
  }
}

export interface DrillReport {
  formatVersion: 1; result: 'DRILL_VERIFIED'; drillId: string; startedAt: string; completedAt: string;
  backup: { identity: string; sha256: string; sizeBytes: string; deploymentVersion: string; startedAt: string; createdAt: string };
  verification: { postgresVersion: '18'; admissionState: 'WORKFLOW_OPEN'; configuration: 'WORKFLOW'; migrations: string[];
    schemaSha256: string; configurationSha256: string; dataSha256: string; counts: Record<string, number>; isolated: true; cleaned: true };
  assessment: RecoveryAssessment & { assessedAt: string }; rpo: ReturnType<typeof assessRpo>;
  phases: Array<{ name: DrillPhase; result: 'PASS'; durationMs: number }>;
  drillDurationMs: number; serviceRecoveryTested: false; achievedRtoMs: null; productionRecoveryApproved: false;
}
