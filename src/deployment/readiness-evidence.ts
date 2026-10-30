import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import type { OperationalBackupEvidence } from './operational-backup.js';
import { assessRpo, isoTime, drillPhases, type DrillReport } from './drill-report.js';
import { parseRecoveryAssessment } from './recovery-assessment.js';

export type EvidenceCode = 'INVALID_MANIFEST' | 'INVALID_DRILL' | 'BACKUP_DRILL_MISMATCH' | 'INVALID_OFF_HOST_EVIDENCE'
  | 'OWNER_REVIEW_UNTRUSTED' | 'INVALID_TIME' | 'UNSAFE_INPUT' | 'RESOURCE_LIMIT' | 'INPUT_UNREADABLE'
  | 'ARCHIVE_INTEGRITY_FAILED' | 'REPORT_WRITE_FAILED' | 'INVALID_POLICY';
export class ReadinessError extends Error {
  constructor(public readonly code: EvidenceCode) { super('Recovery readiness failed: ' + code + '; no report published'); }
}
export function requireEvidence(value: unknown, code: EvidenceCode): asserts value { if (!value) throw new ReadinessError(code); }
export const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return object(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
}
export const canonical = (v: unknown): string => JSON.stringify(normalize(v));
function normalize(v: unknown): unknown {
  return Array.isArray(v) ? v.map(normalize) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
}
export function time(v: unknown, now: string): number {
  try { const n = isoTime(v); requireEvidence(n <= isoTime(now), 'INVALID_TIME'); return n; }
  catch { throw new ReadinessError('INVALID_TIME'); }
}
const duration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const alias = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
export interface RecoveryPolicy {
  formatVersion: 1; targetRpoMs: number; maxDrillAgeMs: number; maxOffHostEvidenceAgeMs: number;
  trustedOffHostReviewers: Array<{ keyId: string; reviewerId: string; publicKeyPem: string }>;
}
export function parseRecoveryPolicy(v: unknown): RecoveryPolicy {
  requireEvidence(exact(v, ['formatVersion','targetRpoMs','maxDrillAgeMs','maxOffHostEvidenceAgeMs','trustedOffHostReviewers'])
    && v.formatVersion === 1 && duration(v.targetRpoMs) && duration(v.maxDrillAgeMs) && duration(v.maxOffHostEvidenceAgeMs)
    && Array.isArray(v.trustedOffHostReviewers) && v.trustedOffHostReviewers.length <= 16, 'INVALID_POLICY');
  const keys = new Set<string>();
  for (const reviewer of v.trustedOffHostReviewers) {
    requireEvidence(exact(reviewer, ['keyId','reviewerId','publicKeyPem']) && alias(reviewer.keyId) && alias(reviewer.reviewerId)
      && typeof reviewer.publicKeyPem === 'string' && reviewer.publicKeyPem.length <= 256 && !keys.has(reviewer.keyId), 'INVALID_POLICY');
    publicKey(reviewer.publicKeyPem); keys.add(reviewer.keyId);
  }
  return v as unknown as RecoveryPolicy;
}
function publicKey(pem: string): KeyObject {
  try {
    requireEvidence(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(pem), 'INVALID_POLICY');
    const key = createPublicKey(pem); requireEvidence(key.asymmetricKeyType === 'ed25519', 'INVALID_POLICY'); return key;
  } catch { throw new ReadinessError('INVALID_POLICY'); }
}
export const policySummary = (p: RecoveryPolicy) => ({ formatVersion: p.formatVersion, targetRpoMs: p.targetRpoMs,
  maxDrillAgeMs: p.maxDrillAgeMs, maxOffHostEvidenceAgeMs: p.maxOffHostEvidenceAgeMs,
  trustedOffHostReviewers: p.trustedOffHostReviewers.map(r => ({ keyId: r.keyId, reviewerId: r.reviewerId,
    publicKeySha256: sha256(publicKey(r.publicKeyPem).export({ type: 'spki', format: 'der' })) })) });

export interface OperationalManifest {
  formatVersion: 1; purpose: 'OPERATIONAL'; result: 'BACKUP_CREATED'; identity: string; fileName: 'backup.dump';
  sizeBytes: string; sha256: string; startedAt: string; createdAt: string; snapshot: OperationalBackupEvidence;
}
const manifestContract = createRequire(import.meta.url)('../../deploy/scripts/live-json.cjs') as { assertOperationalManifest(v: unknown): void };
export function parseOperationalManifest(v: unknown, now: string): OperationalManifest {
  try { manifestContract.assertOperationalManifest(v); } catch { throw new ReadinessError('INVALID_MANIFEST'); }
  const m = v as OperationalManifest;
  requireEvidence(m.identity.length <= 160 && BigInt(m.sizeBytes) <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_MANIFEST');
  requireEvidence(time(m.snapshot.admissionUpdatedAt, now) <= time(m.startedAt, now)
    && time(m.startedAt, now) <= time(m.createdAt, now), 'INVALID_TIME');
  requireEvidence(new Set(m.snapshot.migrations).size === m.snapshot.migrations.length, 'INVALID_MANIFEST');
  return m;
}

/** Downstream validation of the existing 3B DTO, not a new drill engine. Full
 * manual-review lists are validated using 3B's parser, then discarded. */
export function parseVerifiedDrill(v: unknown, manifest: OperationalManifest, now: string): DrillReport {
  requireEvidence(exact(v, ['formatVersion','result','drillId','startedAt','completedAt','backup','verification','assessment','rpo',
    'phases','drillDurationMs','serviceRecoveryTested','achievedRtoMs','productionRecoveryApproved']), 'INVALID_DRILL');
  requireEvidence(v.formatVersion === 1 && v.result === 'DRILL_VERIFIED' && typeof v.drillId === 'string' && /^drill-[a-f0-9]{32}$/.test(v.drillId)
    && v.serviceRecoveryTested === false && v.achievedRtoMs === null && v.productionRecoveryApproved === false, 'INVALID_DRILL');
  const expectedBackup = { identity: manifest.identity, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes,
    deploymentVersion: manifest.snapshot.deploymentVersion, startedAt: manifest.startedAt, createdAt: manifest.createdAt };
  requireEvidence(canonical(v.backup) === canonical(expectedBackup), 'BACKUP_DRILL_MISMATCH');
  const { admissionUpdatedAt: _updated, deploymentVersion: _version, result: _result, ...snapshot } = manifest.snapshot;
  requireEvidence(canonical(v.verification) === canonical({ ...snapshot, isolated: true, cleaned: true }), 'BACKUP_DRILL_MISMATCH');
  requireEvidence(object(v.assessment) && typeof v.assessment.assessedAt === 'string', 'INVALID_DRILL');
  const { assessedAt, ...assessmentDto } = v.assessment;
  let assessment: ReturnType<typeof parseRecoveryAssessment>;
  try { assessment = parseRecoveryAssessment(assessmentDto); } catch { throw new ReadinessError('INVALID_DRILL'); }
  requireEvidence(Object.values(assessment.jobStatusCounts).reduce((a,b) => a+b,0) === manifest.snapshot.counts.calculation_jobs
    && Object.values(assessment.attemptStatusCounts).reduce((a,b) => a+b,0) === manifest.snapshot.counts.execution_attempts
    && assessment.manualReviewCount <= manifest.snapshot.counts.calculation_jobs!, 'INVALID_DRILL');
  for (const [status,count] of Object.entries(assessment.jobStatusCounts)) {
    const listed = assessment.manualReview.filter(i=>i.jobStatus===status).length;
    requireEvidence(listed <= count && (!['PENDING','RUNNING'].includes(status) || listed === count), 'INVALID_DRILL');
  }
  const attemptIds = new Set<string>();
  for (const item of assessment.manualReview) {
    requireEvidence(['PENDING','RUNNING'].includes(item.jobStatus) || ['PREPARED','DISPATCHING','ACCEPTED'].includes(item.attemptStatus ?? ''), 'INVALID_DRILL');
    if (item.attemptId) { requireEvidence(!attemptIds.has(item.attemptId), 'INVALID_DRILL'); attemptIds.add(item.attemptId); }
  }
  for (const [status,count] of Object.entries(assessment.attemptStatusCounts))
    requireEvidence(assessment.manualReview.filter(i=>i.attemptStatus===status).length <= count, 'INVALID_DRILL');
  const start = time(v.startedAt, now), end = time(v.completedAt, now), at = time(assessedAt, now);
  requireEvidence(time(manifest.createdAt, now) <= start && start <= at && at <= end, 'INVALID_TIME');
  requireEvidence(typeof v.drillDurationMs === 'number' && Number.isFinite(v.drillDurationMs) && v.drillDurationMs >= 0
    && Math.abs(end - start - v.drillDurationMs) <= 1000, 'INVALID_DRILL');
  requireEvidence(Array.isArray(v.phases) && v.phases.length === drillPhases.length, 'INVALID_DRILL');
  let total = 0;
  for (const [i,p] of v.phases.entries()) {
    requireEvidence(exact(p, ['name','result','durationMs']) && p.name === drillPhases[i] && p.result === 'PASS'
      && typeof p.durationMs === 'number' && Number.isFinite(p.durationMs) && p.durationMs >= 0, 'INVALID_DRILL'); total += p.durationMs;
  }
  requireEvidence(total <= v.drillDurationMs + 0.001 && object(v.rpo) && (v.rpo.targetRpoMs === null || duration(v.rpo.targetRpoMs)), 'INVALID_DRILL');
  requireEvidence(canonical(v.rpo) === canonical(assessRpo(manifest.startedAt, manifest.createdAt, assessedAt, v.rpo.targetRpoMs)), 'INVALID_DRILL');
  return v as unknown as DrillReport;
}

export interface OffHostEvidence {
  formatVersion: 1; evidenceId: string; backupId: string; originalSha256: string; retrievedSha256: string; retrievedAt: string;
  storageReference: string; drillId: string; drillReportSha256: string; verifiedBy: string; verifiedAt: string;
  ownerReview: { reviewId: string; keyId: string; reviewedAt: string; purpose: 'OFF_HOST_RETRIEVAL_AND_DRILL_REVIEW'; signature: string };
}
/** UTF-8 recursively sorted-key JSON of the complete envelope except signature.
 * External Owner signing is deliberately outside this read-only tool. */
export function offHostSigningPayload(e: OffHostEvidence): Buffer {
  const { signature: _signature, ...review } = e.ownerReview;
  return Buffer.from(canonical({ ...e, ownerReview: review }));
}
export function parseOffHostEvidence(v: unknown, policy: RecoveryPolicy, now: string): OffHostEvidence {
  requireEvidence(exact(v, ['formatVersion','evidenceId','backupId','originalSha256','retrievedSha256','retrievedAt','storageReference',
    'drillId','drillReportSha256','verifiedBy','verifiedAt','ownerReview']) && v.formatVersion === 1
    && typeof v.evidenceId === 'string' && /^offhost-[a-f0-9]{32}$/.test(v.evidenceId)
    && typeof v.backupId === 'string' && /^cost-engine-live-backup-[A-Za-z0-9_-]{1,137}$/.test(v.backupId)
    && digest(v.originalSha256) && digest(v.retrievedSha256) && v.originalSha256 === v.retrievedSha256
    && digest(v.drillReportSha256) && typeof v.drillId === 'string' && /^drill-[a-f0-9]{32}$/.test(v.drillId)
    && alias(v.verifiedBy) && typeof v.storageReference === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,127}$/.test(v.storageReference), 'INVALID_OFF_HOST_EVIDENCE');
  requireEvidence(exact(v.ownerReview, ['reviewId','keyId','reviewedAt','purpose','signature'])
    && typeof v.ownerReview.reviewId === 'string' && /^owner-review-[a-f0-9]{32}$/.test(v.ownerReview.reviewId)
    && alias(v.ownerReview.keyId) && v.ownerReview.purpose === 'OFF_HOST_RETRIEVAL_AND_DRILL_REVIEW'
    && typeof v.ownerReview.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(v.ownerReview.signature), 'OWNER_REVIEW_UNTRUSTED');
  const e = v as unknown as OffHostEvidence;
  requireEvidence(time(e.retrievedAt, now) <= time(e.verifiedAt, now) && time(e.verifiedAt, now) <= time(e.ownerReview.reviewedAt, now), 'INVALID_TIME');
  const reviewer = policy.trustedOffHostReviewers.find(r => r.keyId === e.ownerReview.keyId && r.reviewerId === e.verifiedBy);
  requireEvidence(reviewer && verify(null, offHostSigningPayload(e), publicKey(reviewer.publicKeyPem), Buffer.from(e.ownerReview.signature,'base64')), 'OWNER_REVIEW_UNTRUSTED');
  return e;
}
