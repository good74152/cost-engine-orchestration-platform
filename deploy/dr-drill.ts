import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DrillClock, assessRpo, drillPhases, drillRejected, type DrillPhase, type DrillReport } from '../src/deployment/drill-report.js';
import { parseRecoveryAssessment } from '../src/deployment/recovery-assessment.js';
import { assertPrivateDirectory } from '../src/deployment/private-directory.js';
export { assertPrivateDirectory } from '../src/deployment/private-directory.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const posix = (path: string) => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase()) : path;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function assertDrillWorkspace(path: string): void {
  assertPrivateDirectory(path); if (!/^\.drill-work-[a-f0-9]{32}$/.test(basename(path))) throw drillRejected();
}
export function parseDrillArguments(args: string[]) {
  if (args.length !== 4 && args.length !== 6) throw drillRejected(); const values = new Map<string,string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1]!;
    if (!['--backup-file','--report-dir','--target-rpo-ms'].includes(flag) || values.has(flag) || !value) throw drillRejected(); values.set(flag, value);
  }
  const archive = values.get('--backup-file'), directory = values.get('--report-dir'), target = values.get('--target-rpo-ms');
  if (!archive || !directory || !isAbsolute(archive) || basename(archive) !== 'backup.dump') throw drillRejected();
  let targetRpoMs: number | null = null;
  if (target !== undefined) { if (!/^(0|[1-9][0-9]*)$/.test(target) || !Number.isSafeInteger(Number(target))) throw drillRejected(); targetRpoMs = Number(target); }
  return { archive, directory, targetRpoMs };
}

// Only known files in this newly created workspace are removed. No recursive
// delete, name guessing or unknown Docker-resource cleanup is performed here.
async function removeWorkspace(workspace: string): Promise<void> {
  assertDrillWorkspace(workspace);
  await unlink(join(workspace, 'assessment.json.partial')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await rmdir(workspace);
}

export async function runDrill(args: string[]): Promise<void> {
  const options = parseDrillArguments(args), reportRoot = assertPrivateDirectory(options.directory);
  const clock = new DrillClock(), started = clock.sample();
  const manifestPath = join(dirname(options.archive), 'manifest.json'), manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw drillRejected();
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  // Time checks before creating any restore resources; the existing harness must
  // still independently prove the complete manifest/archive integrity contract.
  assessRpo(manifest.startedAt, manifest.createdAt, started.at, options.targetRpoMs);
  const drillId = 'drill-' + randomBytes(16).toString('hex'), workspace = join(reportRoot, '.drill-work-' + drillId.slice(6));
  await mkdir(workspace, { mode: 0o700 }); assertDrillWorkspace(workspace);
  let workspaceOwned = true, reportDirectoryOwned = false; const reportDirectory = join(reportRoot, drillId);
  try {
    const phases: DrillReport['phases'] = []; let active: { name: DrillPhase; start: number } | undefined;
    let verification: Record<string, unknown> | undefined, assessedAt: string | undefined;
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';
    await new Promise<void>((done, reject) => {
      const child = spawn(shell, [posix(join(repository, 'deploy/scripts/verify-backup.sh')), '--drill', '--backup-file', posix(options.archive)], {
        cwd: repository, env: { ...process.env, DEMO_DRILL_WORKSPACE: posix(workspace) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '', bytes = 0, invalid = false;
      const abort = () => { invalid = true; child.kill('SIGTERM'); }; // Only our direct harness child; its existing trap owns resource cleanup.
      const timer = setTimeout(abort, 45 * 60 * 1000);
      child.stderr.on('data', () => {}); // Never forward raw subprocess diagnostics/identifiers to Console.
      child.stdout.on('data', (chunk: Buffer) => {
        if (invalid) return; bytes += chunk.length; if (bytes > 65536) { abort(); return; } buffer += chunk.toString('utf8');
        try {
          for (;;) {
            const end = buffer.indexOf('\n'); if (end === -1) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.trim()) continue; const value = JSON.parse(line) as Record<string, unknown>; clock.sample();
            if (value.event === 'PHASE') {
              if (Object.keys(value).sort().join(',') !== 'at,event,monotonicNs,name,state') throw drillRejected();
              const point = clock.observeEmission(value.at, value.monotonicNs);
              if (value.state === 'START') {
                if (active || value.name !== drillPhases[phases.length]) throw drillRejected(); active = { name: value.name as DrillPhase, start: point.elapsedMs };
              } else if (value.state === 'PASS') {
                if (!active || value.name !== active.name) throw drillRejected();
                phases.push({ name: active.name, result: 'PASS', durationMs: point.elapsedMs - active.start });
                if (active.name === 'ASSESSMENT') assessedAt = point.at; active = undefined;
              } else throw drillRejected();
            } else {
              if (verification || phases.length !== drillPhases.length || value.result !== 'RESTORE_VERIFIED') throw drillRejected(); verification = value;
            }
          }
        } catch { abort(); }
      });
      child.once('error', () => { clearTimeout(timer); reject(drillRejected()); });
      child.once('close', code => { clearTimeout(timer); if (invalid || code !== 0 || buffer.trim() || !verification || active || phases.length !== 5) reject(drillRejected()); else done(); });
    });
    if (!verification || !assessedAt) throw drillRejected();
    const assessmentFile = join(workspace, 'assessment.json.partial'), fileStat = await lstat(assessmentFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 8 * 1024 * 1024 || (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0)) throw drillRejected();
    const assessment = parseRecoveryAssessment(JSON.parse(await readFile(assessmentFile, 'utf8')));
    const v = verification as Record<string, any>; // Project only the already-verified existing DTO; no arbitrary report spreading.
    if (v.postgresVersion !== '18' || v.admissionState !== 'WORKFLOW_OPEN' || v.configuration !== 'WORKFLOW' || v.isolation?.cleaned !== true
      || v.isolation?.network !== 'none' || v.isolation?.publishedPorts !== 0 || !digest(v.schemaSha256) || !digest(v.configurationSha256) || !digest(v.dataSha256)
      || v.backupIdentity !== manifest.identity || v.sha256 !== manifest.sha256 || v.sizeBytes !== manifest.sizeBytes) throw drillRejected();
    if (typeof v.backupIdentity !== 'string' || !/^cost-engine-live-backup-[A-Za-z0-9_-]+$/.test(v.backupIdentity)
      || !digest(v.sha256) || typeof v.sizeBytes !== 'string' || !/^[1-9][0-9]*$/.test(v.sizeBytes)
      || typeof v.deploymentVersion !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(v.deploymentVersion)
      || !Array.isArray(v.migrations) || !v.migrations.length || v.migrations.length > 1000
      || v.migrations.some((n: unknown) => typeof n !== 'string' || !/^\d+_[a-z0-9-]{1,120}$/.test(n))
      || !v.counts || typeof v.counts !== 'object' || Array.isArray(v.counts) || Object.keys(v.counts).length !== 21
      || Object.entries(v.counts).some(([k,n]) => !/^[a-z][a-z0-9_]{0,80}$/.test(k) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      || !(await readFile(manifestPath)).equals(manifestBytes)) throw drillRejected();
    const rpo = assessRpo(manifest.startedAt, manifest.createdAt, assessedAt, options.targetRpoMs);
    await removeWorkspace(workspace); workspaceOwned = false;
    const completed = clock.sample();
    const report: DrillReport = { formatVersion: 1, result: 'DRILL_VERIFIED', drillId, startedAt: started.at, completedAt: completed.at,
      backup: { identity: v.backupIdentity, sha256: v.sha256, sizeBytes: v.sizeBytes, deploymentVersion: v.deploymentVersion,
        startedAt: manifest.startedAt as string, createdAt: manifest.createdAt as string },
      verification: { postgresVersion: '18', admissionState: 'WORKFLOW_OPEN', configuration: 'WORKFLOW', migrations: v.migrations,
        schemaSha256: v.schemaSha256, configurationSha256: v.configurationSha256, dataSha256: v.dataSha256, counts: v.counts, isolated: true, cleaned: true },
      assessment: { ...assessment, assessedAt }, rpo, phases, drillDurationMs: completed.elapsedMs,
      serviceRecoveryTested: false, achievedRtoMs: null, productionRecoveryApproved: false };
    if (assertPrivateDirectory(options.directory) !== reportRoot) throw drillRejected();
    await mkdir(reportDirectory, { mode: 0o700 }); reportDirectoryOwned = true; // Exclusive identity; never reuse another report directory.
    const partial = join(reportDirectory, 'report.json.partial');
    const file = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    clock.sample(); // A clock anomaly during report I/O also withholds publication.
    await rename(partial, join(reportDirectory, 'report.json')); reportDirectoryOwned = false;
    console.info(JSON.stringify({ result: 'DRILL_VERIFIED', rpoAssessment: rpo.result, manualReviewCount: assessment.manualReviewCount,
      drillDurationMs: completed.elapsedMs, serviceRecoveryTested: false, achievedRtoMs: null, productionRecoveryApproved: false }));
  } finally {
    if (workspaceOwned) await removeWorkspace(workspace);
    if (reportDirectoryOwned) { await unlink(join(reportDirectory, 'report.json.partial')).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(reportDirectory); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDrill(process.argv.slice(2)).catch(() => { console.error('DR drill failed; no verified report or production recovery approval; inspect owned resources privately'); process.exitCode = 1; });
}
