import { randomBytes } from 'node:crypto';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { DrillClock, assessRpo } from './drill-report.js';
import { parseOperationalManifest, parseVerifiedDrill, parseOffHostEvidence, parseRecoveryPolicy, policySummary,
  ReadinessError, requireEvidence, time, sha256, object, type EvidenceCode, type OperationalManifest, type OffHostEvidence } from './readiness-evidence.js';
import { privateDirectory, entries, ReadBudget, readinessLimits, readJson, archiveIntegrity, publishReadiness } from './readiness-files.js';

export interface ReadinessOptions { backupDirectory: string; drillDirectory: string; policyFile: string; reportDirectory: string; offHostDirectory?: string }
type IssueCode = EvidenceCode | 'RESTORE_DRILL_EXPIRED' | 'OFF_HOST_EVIDENCE_EXPIRED' | 'EVIDENCE_BACKUP_NOT_FOUND' | 'EVIDENCE_DRILL_NOT_FOUND';
interface Issue { source: 'BACKUP' | 'DRILL' | 'OFF_HOST'; reference: string; code: IssueCode }
interface Backup { manifest: OperationalManifest; manifestSha256: string }
interface Drill { drillId: string; backupId: string; reportSha256: string; startedAt: string; completedAt: string; manualReviewCount: number; current: boolean }
export type ReadinessReason = 'VERIFIED_RECOVERY_POINT_WITHIN_RPO' | 'RECOVERY_POINT_EXCEEDS_RPO' | 'NO_VALID_OPERATIONAL_BACKUP'
  | 'NO_CURRENT_RESTORE_DRILL' | 'RESTORE_DRILL_EXPIRED' | 'LATEST_SUCCESSFUL_BACKUP_NOT_RESTORE_VERIFIED'
  | 'OFF_HOST_EVIDENCE_NOT_PROVIDED' | 'NO_TRUSTED_OFF_HOST_EVIDENCE' | 'OFF_HOST_EVIDENCE_EXPIRED';
export interface ReadinessState { status: 'READY' | 'AT_RISK' | 'NOT_VERIFIED'; reasonCodes: ReadinessReason[]; rpo: ReturnType<typeof assessRpo> | null }
function related(a: string, b: string): boolean {
  const contained = (x: string,y: string) => { const r = relative(x,y); return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
  return contained(a,b) || contained(b,a);
}
const newest = (a: Backup,b: Backup) => b.manifest.startedAt.localeCompare(a.manifest.startedAt)
  || b.manifest.createdAt.localeCompare(a.manifest.createdAt) || a.manifest.identity.localeCompare(b.manifest.identity);
function point(b: Backup, d?: Drill) {
  const m = b.manifest;
  return { backupId: m.identity, sha256: m.sha256, sizeBytes: m.sizeBytes, deploymentVersion: m.snapshot.deploymentVersion,
    startedAt: m.startedAt, createdAt: m.createdAt, manifestSha256: b.manifestSha256,
    archiveReference: m.identity + '/backup.dump', manifestReference: m.identity + '/manifest.json',
    drill: d ? { drillId: d.drillId, reportSha256: d.reportSha256, reportReference: d.drillId + '/report.json',
      completedAt: d.completedAt, manualReviewCount: d.manualReviewCount } : null };
}
function state(b: Backup | undefined, now: string, target: number, missing: ReadinessReason[]): ReadinessState {
  if (!b) return { status: 'NOT_VERIFIED', reasonCodes: missing, rpo: null };
  const rpo = assessRpo(b.manifest.startedAt,b.manifest.createdAt,now,target);
  return { status: rpo.result === 'WITHIN_TARGET' ? 'READY' : 'AT_RISK', reasonCodes: [rpo.result === 'WITHIN_TARGET'
    ? 'VERIFIED_RECOVERY_POINT_WITHIN_RPO' : 'RECOVERY_POINT_EXCEEDS_RPO'], rpo };
}

/** Offline reader only. No database client, restore, subprocess, scheduler or
 * business-state operation is invoked. Source files are never opened writable. */
export async function assessReadiness(options: ReadinessOptions, clock = new DrillClock()) {
  const backupRoot = privateDirectory(options.backupDirectory), drillRoot = privateDirectory(options.drillDirectory),
    reportRoot = privateDirectory(options.reportDirectory), policyRoot = privateDirectory(dirname(options.policyFile)),
    offHostRoot = options.offHostDirectory ? privateDirectory(options.offHostDirectory) : undefined;
  const roots = [[options.backupDirectory,backupRoot],[options.drillDirectory,drillRoot],[options.reportDirectory,reportRoot],
    [dirname(options.policyFile),policyRoot],...offHostRoot ? [[options.offHostDirectory!,offHostRoot]]:[]];
  requireEvidence(isAbsolute(options.policyFile) && !related(backupRoot,drillRoot)
    && (!offHostRoot || (!related(offHostRoot,backupRoot) && !related(offHostRoot,drillRoot)))
    && [backupRoot,drillRoot,policyRoot,...offHostRoot ? [offHostRoot] : []].every(root => !related(root,reportRoot)), 'UNSAFE_INPUT');
  const budget = new ReadBudget(), policyFile = await readJson(options.policyFile,readinessLimits.policyBytes,budget), policy = parseRecoveryPolicy(policyFile.value);
  let now = clock.sample().at; const issues: Issue[] = [], backups: Backup[] = [], drills: Drill[] = [];
  const rejected = (source: Issue['source'], name: string, error: unknown) => {
    if (!(error instanceof ReadinessError)) throw new ReadinessError('INPUT_UNREADABLE');
    if (error.code === 'RESOURCE_LIMIT' || error.code === 'INPUT_UNREADABLE') throw error;
    issues.push({ source, reference: 'entry-sha256:' + sha256(name), code: error.code });
  };
  for await (const name of entries(backupRoot,budget)) {
    clock.sample();
    try {
      requireEvidence(/^cost-engine-live-backup-[A-Za-z0-9_-]{1,137}$/.test(name), 'INVALID_MANIFEST');
      const bundle = privateDirectory(join(backupRoot,name));
      const file = await readJson(join(bundle,'manifest.json'),readinessLimits.manifestBytes,budget), manifest = parseOperationalManifest(file.value,now);
      requireEvidence(manifest.identity === name, 'INVALID_MANIFEST');
      const archive = await archiveIntegrity(join(bundle,'backup.dump'),budget,() => clock.sample());
      requireEvidence(archive.sha256 === manifest.sha256 && archive.sizeBytes === manifest.sizeBytes, 'ARCHIVE_INTEGRITY_FAILED');
      backups.push({ manifest, manifestSha256: file.sha256 });
    } catch (e) { rejected('BACKUP',name,e); }
  }
  const byBackup = new Map(backups.map(b => [b.manifest.identity,b]));
  for await (const name of entries(drillRoot,budget)) {
    clock.sample();
    try {
      requireEvidence(/^drill-[a-f0-9]{32}$/.test(name), 'INVALID_DRILL');
      const folder = privateDirectory(join(drillRoot,name)), file = await readJson(join(folder,'report.json'),readinessLimits.drillBytes,budget);
      const input = file.value, backup = object(input) && object(input.backup) && byBackup.get(input.backup.identity as string);
      if (!backup) { issues.push({ source:'DRILL',reference:name+'/report.json',code:'EVIDENCE_BACKUP_NOT_FOUND' }); continue; }
      const d = parseVerifiedDrill(input,backup.manifest,now); requireEvidence(d.drillId === name, 'INVALID_DRILL');
      drills.push({ drillId: name, backupId: backup.manifest.identity, reportSha256: file.sha256,
        startedAt:d.startedAt, completedAt:d.completedAt, manualReviewCount:d.assessment.manualReviewCount,current:true });
    } catch (e) { rejected('DRILL',name,e); }
  }
  const offHost: Array<{ backup: Backup; drill: Drill; evidence: OffHostEvidence; sha256: string }> = [];
  if (offHostRoot) for await (const name of entries(offHostRoot,budget)) {
    clock.sample();
    try {
      requireEvidence(/^offhost-[a-f0-9]{32}\.json$/.test(name), 'INVALID_OFF_HOST_EVIDENCE');
      const file = await readJson(join(offHostRoot,name),readinessLimits.offHostBytes,budget), e = parseOffHostEvidence(file.value,policy,now);
      requireEvidence(name === e.evidenceId+'.json', 'INVALID_OFF_HOST_EVIDENCE');
      const b = byBackup.get(e.backupId), d = drills.find(d => d.drillId === e.drillId);
      if (!b || !d) { issues.push({source:'OFF_HOST',reference:name,code:!b?'EVIDENCE_BACKUP_NOT_FOUND':'EVIDENCE_DRILL_NOT_FOUND'}); continue; }
      requireEvidence(d.backupId === b.manifest.identity && e.originalSha256 === b.manifest.sha256 && e.drillReportSha256 === d.reportSha256, 'BACKUP_DRILL_MISMATCH');
      requireEvidence(time(b.manifest.createdAt,now) <= time(e.retrievedAt,now) && time(e.retrievedAt,now) <= time(d.startedAt,now)
        && time(d.completedAt,now) <= time(e.verifiedAt,now), 'INVALID_TIME');
      offHost.push({backup:b,drill:d,evidence:e,sha256:file.sha256});
    } catch (e) { rejected('OFF_HOST',name,e); }
  }
  // Freshness and RPO use the completion of inventory I/O, not its start. Long
  // archive hashing cannot accidentally refresh evidence or understate its age.
  now = clock.sample().at;
  for (const d of drills) {
    d.current = time(now,now) - time(d.completedAt,now) <= policy.maxDrillAgeMs;
    if (!d.current) issues.push({source:'DRILL',reference:d.drillId+'/report.json',code:'RESTORE_DRILL_EXPIRED'});
  }
  const currentOffHost = offHost.filter(v => {
    const e=v.evidence, expired = time(now,now)-time(e.retrievedAt,now)>policy.maxOffHostEvidenceAgeMs
      || time(now,now)-time(e.verifiedAt,now)>policy.maxOffHostEvidenceAgeMs;
    if (expired) issues.push({source:'OFF_HOST',reference:e.evidenceId+'.json',code:'OFF_HOST_EVIDENCE_EXPIRED'});
    return !expired && v.drill.current;
  });
  backups.sort(newest); drills.sort((a,b) => b.completedAt.localeCompare(a.completedAt) || a.drillId.localeCompare(b.drillId));
  const latest = backups[0], local = backups.find(b => drills.some(d => d.current && d.backupId === b.manifest.identity));
  const localDrill = local && drills.find(d => d.current && d.backupId === local.manifest.identity);
  currentOffHost.sort((a,b) => newest(a.backup,b.backup) || b.drill.completedAt.localeCompare(a.drill.completedAt) || a.evidence.evidenceId.localeCompare(b.evidence.evidenceId));
  const remote = currentOffHost[0];
  const localRecoveryReadiness = state(local,now,policy.targetRpoMs,!backups.length?['NO_VALID_OPERATIONAL_BACKUP']:['NO_CURRENT_RESTORE_DRILL',
    ...issues.some(i=>i.source==='DRILL'&&i.code==='RESTORE_DRILL_EXPIRED')?['RESTORE_DRILL_EXPIRED' as const]:[]]);
  if (latest && !drills.some(d=>d.current && d.backupId===latest.manifest.identity)) localRecoveryReadiness.reasonCodes.push('LATEST_SUCCESSFUL_BACKUP_NOT_RESTORE_VERIFIED');
  const disasterRecoveryReadiness = state(remote?.backup,now,policy.targetRpoMs,!offHostRoot?['OFF_HOST_EVIDENCE_NOT_PROVIDED']:['NO_TRUSTED_OFF_HOST_EVIDENCE',
    ...issues.some(i=>i.source==='OFF_HOST'&&i.code==='OFF_HOST_EVIDENCE_EXPIRED')?['OFF_HOST_EVIDENCE_EXPIRED' as const]:[]]);
  clock.sample();
  for (const [input,physical] of roots) requireEvidence(privateDirectory(input!)===physical,'UNSAFE_INPUT');
  return { formatVersion:1 as const, result:'READINESS_ASSESSED' as const, assessmentId:'readiness-'+randomBytes(16).toString('hex'), assessedAt:now,
    policy:policySummary(policy), policySha256:policyFile.sha256,
    latestSuccessfulBackup:latest?point(latest):null, latestLocalRestoreVerifiedBackup:local?point(local,localDrill):null,
    latestOffHostRestoreVerifiedBackup:remote?{...point(remote.backup,remote.drill),offHostEvidence:{evidenceId:remote.evidence.evidenceId,
      fileSha256:remote.sha256,reference:remote.evidence.evidenceId+'.json',retrievedAt:remote.evidence.retrievedAt,verifiedAt:remote.evidence.verifiedAt,
      verifiedBy:remote.evidence.verifiedBy,reviewId:remote.evidence.ownerReview.reviewId,keyId:remote.evidence.ownerReview.keyId,
      reviewedAt:remote.evidence.ownerReview.reviewedAt,storageReferenceSha256:sha256(remote.evidence.storageReference)}}:null,
    localRecoveryReadiness,disasterRecoveryReadiness,evidenceIssues:issues.sort((a,b)=>a.source.localeCompare(b.source)||a.reference.localeCompare(b.reference)||a.code.localeCompare(b.code)),
    inventory:{validBackups:backups.length,validDrills:drills.length,trustedCurrentOffHostEvidence:currentOffHost.length,rejectedOrExpiredEvidence:issues.length},
    evidenceScope:{independentlyVerified:['LOCAL_ARCHIVE_BYTES_AND_HASH','MANIFEST_AND_DRILL_CONTRACT_BINDINGS','EVIDENCE_TIMES_AND_POLICY','OWNER_REVIEW_SIGNATURE'],
      ownerAttested:['PRIVATE_BACKUP_AND_DRILL_STORE_PROVENANCE','PHYSICAL_OFF_HOST_STORAGE_AND_RETRIEVAL','RETRIEVED_COPY_USED_BY_BOUND_DRILL'],
      limitations:['OFFLINE_JSON_CANNOT_PROVE_PHYSICAL_LOCATION','DATABASE_RECOVERY_POINT_ONLY','READY_IS_NOT_PRODUCTION_RECOVERY_APPROVAL']},
    productionRecoveryApproved:false as const,serviceRecoveryTested:false as const,actualDataLoss:'UNKNOWN' as const };
}
export async function runReadiness(options: ReadinessOptions) {
  const root = privateDirectory(options.reportDirectory), clock = new DrillClock(), report = await assessReadiness(options,clock);
  requireEvidence(privateDirectory(options.reportDirectory)===root,'UNSAFE_INPUT');
  await publishReadiness(root,report.assessmentId,report,()=>clock.sample());
  return {result:report.result,localRecoveryReadiness:report.localRecoveryReadiness.status,disasterRecoveryReadiness:report.disasterRecoveryReadiness.status,
    validBackups:report.inventory.validBackups,productionRecoveryApproved:false,serviceRecoveryTested:false};
}
