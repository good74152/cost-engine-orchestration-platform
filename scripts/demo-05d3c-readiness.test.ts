import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, readdir, mkdir, chmod, stat, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readinessFixture, fixtureClock, fixtureNow, iso } from './support/readiness-fixture.js';
import { assessReadiness, runReadiness } from '../src/deployment/recovery-readiness.js';
import { parseRecoveryPolicy, offHostSigningPayload, sha256, parseVerifiedDrill, ReadinessError } from '../src/deployment/readiness-evidence.js';
import { publishReadiness, readinessLimits } from '../src/deployment/readiness-files.js';
import { DrillClock } from '../src/deployment/drill-report.js';
import { parseReadinessArguments } from '../deploy/recovery-readiness.js';

type Fixture = Awaited<ReturnType<typeof readinessFixture>>;
const assess=(f:Fixture)=>assessReadiness(f.options,fixtureClock());
function scenario(name:string,body:(f:Fixture)=>Promise<void>){test('Demo-05D-3C '+name,async()=>{const f=await readinessFixture();try{await body(f);}finally{await f.cleanup();}});}
scenario('Local READY requires its own complete fresh Drill',async f=>{
 const b=await f.backup(),d=await f.drill(b),r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'READY');assert.equal(r.latestLocalRestoreVerifiedBackup?.backupId,b.manifest.identity);
 assert.equal(r.latestLocalRestoreVerifiedBackup?.drill?.drillId,d.report.drillId);assert.equal(r.productionRecoveryApproved,false);assert.equal(r.serviceRecoveryTested,false);assert.equal(r.actualDataLoss,'UNKNOWN');
});
scenario('Local AT_RISK uses conservative startedAt RPO',async f=>{
 const b=await f.backup(-200000);await f.drill(b);const r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'AT_RISK');assert.equal(r.localRecoveryReadiness.rpo?.backupAgeMs,200000);assert.deepEqual(r.localRecoveryReadiness.reasonCodes,['RECOVERY_POINT_EXCEEDS_RPO']);
});
scenario('no Drill means NOT_VERIFIED despite intact new archive',async f=>{
 await f.backup();const r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.latestSuccessfulBackup);assert.equal(r.latestLocalRestoreVerifiedBackup,null);
});
scenario('new undrilled backup cannot replace older verified recovery point',async f=>{
 const old=await f.backup(-200000);await f.drill(old);const recent=await f.backup(-2000),r=await assess(f);
 assert.equal(r.latestSuccessfulBackup?.backupId,recent.manifest.identity);assert.equal(r.latestLocalRestoreVerifiedBackup?.backupId,old.manifest.identity);assert.equal(r.localRecoveryReadiness.status,'AT_RISK');
});
scenario('expired Drill cannot supply a verified point',async f=>{
 const b=await f.backup(-200000);await f.drill(b,-150000);const r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.localRecoveryReadiness.reasonCodes.includes('RESTORE_DRILL_EXPIRED'));
});
scenario('optional Off-host absence cannot become Disaster READY',async f=>{
 const b=await f.backup();await f.drill(b);delete f.options.offHostDirectory;const r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'READY');assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.deepEqual(r.disasterRecoveryReadiness.reasonCodes,['OFF_HOST_EVIDENCE_NOT_PROVIDED']);
});
scenario('trusted signed retrieval plus bound fresh Drill gives scoped Disaster READY',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d),r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'READY');
 assert.equal(r.latestOffHostRestoreVerifiedBackup?.offHostEvidence.evidenceId,e.evidence.evidenceId);assert.ok(r.evidenceScope.ownerAttested.includes('PHYSICAL_OFF_HOST_STORAGE_AND_RETRIEVAL'));
 assert.ok(!JSON.stringify(r).includes(e.evidence.storageReference));assert.ok(!JSON.stringify(r).includes(e.evidence.ownerReview.signature));
});
scenario('Disaster RPO uses old Off-host recovery point, never newer local backup',async f=>{
 const old=await f.backup(-200000),d=await f.drill(old);await f.offhost(old,d);const recent=await f.backup(-8000);await f.drill(recent,-3000);const r=await assess(f);
 assert.equal(r.localRecoveryReadiness.status,'READY');assert.equal(r.disasterRecoveryReadiness.status,'AT_RISK');assert.equal(r.disasterRecoveryReadiness.rpo?.backupAgeMs,200000);
});
scenario('expired retrieval cannot be refreshed by a new Owner signature',async f=>{
 const b=await f.backup(-200000),d=await f.drill(b,-150000),e=await f.offhost(b,d);f.policy.maxDrillAgeMs=300000;await f.savePolicy();e.evidence.verifiedAt=iso(-1000);e.evidence.ownerReview.reviewedAt=iso(-900);e.resign();await e.save();
 const r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.disasterRecoveryReadiness.reasonCodes.includes('OFF_HOST_EVIDENCE_EXPIRED'));
});
scenario('fake self-signed key and signed payload tampering are rejected',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d);const attacker=generateKeyPairSync('ed25519');e.evidence.ownerReview.signature=sign(null,offHostSigningPayload(e.evidence),attacker.privateKey).toString('base64');await e.save();
 let r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code==='OWNER_REVIEW_UNTRUSTED'));
 e.resign();e.evidence.storageReference='forged-vault';await e.save();r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');
});
scenario('boolean Owner declaration and secret extra fields cannot replace review',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d);await f.json(e.file,{...e.evidence,ownerApproved:true,password:'test-secret-must-not-appear'});
 const r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(!JSON.stringify(r).includes('test-secret-must-not-appear'));
});
scenario('Off-host Backup and exact report file SHA are both bound',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d);e.evidence.drillReportSha256=sha256('different-report');e.resign();await e.save();
 const r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code==='BACKUP_DRILL_MISMATCH'));
});
scenario('retrieval after Drill is rejected even with trusted Owner signature',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d);e.evidence.retrievedAt=e.evidence.verifiedAt;e.resign();await e.save();const r=await assess(f);
 assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code==='INVALID_TIME'));
});
for(const field of ['identity','sha256','deploymentVersion'] as const) scenario('Drill '+field+' mismatch cannot be accepted',async f=>{
 const b=await f.backup(),d=await f.drill(b);d.report.backup[field]='mismatched';await d.save();const r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code===(field==='identity'?'EVIDENCE_BACKUP_NOT_FOUND':'BACKUP_DRILL_MISMATCH')));
});
for(const change of ['flag','cleanup','rpo','phase','counts','manual','extra'] as const) scenario('Drill strict '+change+' evidence rejects result-only forgery',async f=>{
 const b=await f.backup(),d=await f.drill(b);const v:any=d.report;
 if(change==='flag')v.serviceRecoveryTested=true;if(change==='cleanup')v.verification.cleaned=false;if(change==='rpo')v.rpo.backupAgeMs=0;if(change==='phase')v.phases.pop();
 if(change==='counts')v.assessment.jobStatusCounts.RUNNING=1;if(change==='manual')v.assessment.manualReviewCount=1;if(change==='extra')v.password='test-private';
 await d.save();const r=await assess(f);assert.equal(r.localRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(!JSON.stringify(r).includes('test-private'));
});
scenario('manifest format, archive existence, hash, and PGDMP header are verified independently',async f=>{
 const badFormat=await f.backup();await f.json(join(badFormat.directory,'manifest.json'),{...badFormat.manifest,purpose:'FIRST_DEPLOYMENT'});
 const missing=await f.backup();await unlink(join(missing.directory,'backup.dump'));
 const corrupt=await f.backup();await writeFile(join(corrupt.directory,'backup.dump'),Buffer.from('PGDMP-changed'));
 const header=await f.backup();const bytes=Buffer.from('NOTPG-but-valid-hash');await writeFile(join(header.directory,'backup.dump'),bytes);header.manifest.sha256=sha256(bytes);header.manifest.sizeBytes=String(bytes.length);await header.save();
 const r=await assess(f);assert.equal(r.inventory.validBackups,0);assert.equal(r.evidenceIssues.length,4);assert.equal(r.localRecoveryReadiness.status,'NOT_VERIFIED');
});
for(const change of ['future','invalid','order','gate'] as const) scenario('untrusted manifest '+change+' timestamp is rejected',async f=>{
 const b=await f.backup();if(change==='future')b.manifest.createdAt=iso(10000);if(change==='invalid')b.manifest.startedAt='invalid';if(change==='order')b.manifest.startedAt=b.manifest.createdAt+'x';if(change==='gate')b.manifest.snapshot.admissionUpdatedAt=iso(-1000);
 await b.save();const r=await assess(f);assert.equal(r.latestSuccessfulBackup,null);
});
test('Demo-05D-3C no policy defaults, negative/unsafe durations, extra secrets and private keys',()=>{
 const p={formatVersion:1,targetRpoMs:1,maxDrillAgeMs:1,maxOffHostEvidenceAgeMs:1,trustedOffHostReviewers:[]};
 assert.doesNotThrow(()=>parseRecoveryPolicy(p));for(const value of [{...p,targetRpoMs:-1},{...p,maxDrillAgeMs:1.5},{...p,maxOffHostEvidenceAgeMs:undefined},{...p,targetRpoMs:Number.MAX_SAFE_INTEGER+1},{...p,password:'secret'},{}])assert.throws(()=>parseRecoveryPolicy(value),/INVALID_POLICY/);
});
scenario('missing referenced Drill and missing source root fail closed at different boundaries',async f=>{
 const b=await f.backup(),d=await f.drill(b);await f.offhost(b,d);await unlink(d.file);const r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');
 f.options.drillDirectory=join(f.root,'does-not-exist');await assert.rejects(()=>runReadiness(f.options));assert.deepEqual(await readdir(f.options.reportDirectory),[]);
});
scenario('input resource limit never returns a truncated success report',async f=>{
 for(let i=0;i<readinessLimits.entries+1;i++)await writeFile(join(f.options.backupDirectory,'unknown-'+i),'',{mode:0o600});
 await assert.rejects(()=>runReadiness(f.options),/RESOURCE_LIMIT/);assert.deepEqual(await readdir(f.options.reportDirectory),[]);
});
scenario('oversized evidence is a fatal resource failure',async f=>{
 const b=await f.backup();await writeFile(join(b.directory,'manifest.json'),' '.repeat(readinessLimits.manifestBytes+1));
 await assert.rejects(()=>runReadiness(f.options),/RESOURCE_LIMIT/);assert.deepEqual(await readdir(f.options.reportDirectory),[]);
});
scenario('report publishing is exclusive and leaves existing reports untouched on failure',async f=>{
 const id='readiness-'+'a'.repeat(32);await publishReadiness(f.options.reportDirectory,id,{prior:true},()=>{});const file=join(f.options.reportDirectory,id,'report.json'),before=sha256(await readFile(file));
 await assert.rejects(()=>publishReadiness(f.options.reportDirectory,id,{},()=>{}),/REPORT_WRITE_FAILED/);assert.equal(sha256(await readFile(file)),before);
 await assert.rejects(()=>publishReadiness(f.options.reportDirectory,'readiness-'+'b'.repeat(32),{},()=>{throw Error('fault after write');}),/REPORT_WRITE_FAILED/);
 assert.deepEqual(await readdir(f.options.reportDirectory),[id]);
});
scenario('private directory permissions and write failure withhold final report',async f=>{
 if(process.platform==='win32') {
  // Deterministic write failure independent of administrator/root chmod behavior.
  const original=f.options.reportDirectory;f.options.reportDirectory=f.options.policyFile;await assert.rejects(()=>runReadiness(f.options));assert.deepEqual(await readdir(original),[]);return;
 }
 await chmod(f.options.reportDirectory,0o500);try{await assert.rejects(()=>runReadiness(f.options));assert.deepEqual(await readdir(f.options.reportDirectory),[]);}finally{await chmod(f.options.reportDirectory,0o700);}
 const b=await f.backup();await chmod(join(b.directory,'manifest.json'),0o644);const r=await assess(f);assert.equal(r.inventory.validBackups,0);assert.ok(r.evidenceIssues.some(i=>i.code==='UNSAFE_INPUT'));
});
scenario('unsafe symlink, repository output, and source/output overlap rejected',async f=>{
 f.options.reportDirectory=f.options.backupDirectory;await assert.rejects(()=>assess(f),/UNSAFE_INPUT/);
 f.options.reportDirectory=process.cwd();await assert.rejects(()=>assess(f),/UNSAFE_INPUT/);
 if(process.platform!=='win32'){const link=join(f.root,'link');await symlink(f.options.drillDirectory,link,'dir');f.options.drillDirectory=link;await assert.rejects(()=>assess(f),/UNSAFE_INPUT/);}
});
scenario('source Backup and Drill bytes unchanged; two private reports never overwrite',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d),paths=[join(b.directory,'manifest.json'),join(b.directory,'backup.dump'),d.file,e.file,f.options.policyFile];
 const before=await Promise.all(paths.map(async p=>sha256(await readFile(p))));await runReadiness(f.options);await runReadiness(f.options);
 assert.deepEqual(await Promise.all(paths.map(async p=>sha256(await readFile(p)))),before);const names=await readdir(f.options.reportDirectory);assert.equal(names.length,2);
 for(const name of names){assert.match(name,/^readiness-[a-f0-9]{32}$/);const path=join(f.options.reportDirectory,name,'report.json'),text=await readFile(path,'utf8');assert.ok(!/manualReview"|token_hash|password|database_url/i.test(text));
  if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(join(f.options.reportDirectory,name))).mode&0o777,0o700);}}
});
test('Demo-05D-3C CLI rejects database URLs, arbitrary target flags, duplicates and incomplete flags',()=>{
 for(const a of [[],['--database-url','postgres://secret'],['--restore-target','foo'],Array(8).fill('--backup-dir')])assert.throws(()=>parseReadinessArguments(a));
});
scenario('CLI public summary omits private identifiers and never connects to environment Database URL',async f=>{
 const b=await f.backup(),d=await f.drill(b);await f.offhost(b,d);
 const args=['--backup-dir',f.options.backupDirectory,'--drill-dir',f.options.drillDirectory,'--policy-file',f.options.policyFile,'--report-dir',f.options.reportDirectory,'--off-host-evidence-dir',f.options.offHostDirectory!];
 const result=await new Promise<{code:number;out:string;err:string}>((done,reject)=>{const p=spawn(process.execPath,['--import','tsx','deploy/recovery-readiness.ts',...args],{env:{...process.env,DATABASE_URL:'postgres://forbidden-invalid-production-host/secret'},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('close',code=>done({code:code??-1,out,err}));});
 assert.equal(result.code,0,result.err);const summary=JSON.parse(result.out);assert.equal(summary.result,'READINESS_ASSESSED');assert.equal(summary.localRecoveryReadiness,'READY');assert.equal(summary.disasterRecoveryReadiness,'READY');assert.ok(!result.out.includes(b.manifest.identity));assert.ok(!result.out.includes(d.report.drillId));assert.ok(!/secret|postgres:|token|password/i.test(result.out+result.err));
});
scenario('clock rollback or large wall/monotonic divergence rejects assessment',async f=>{
 let calls=0;const clock=new DrillClock(()=>++calls===1?fixtureNow:fixtureNow-1,()=>0n);await assert.rejects(()=>assessReadiness(f.options,clock));
});
scenario('real filesystem write and read faults publish no report or unsafe diagnostics',async f=>{
 const b=await f.backup();await f.drill(b);
 for(const fault of ['write','read']) {
  // Test-only loader patches Node builtins inside this child. No production
  // environment flag, fault entrypoint, or OS/disk exhaustion is required.
  const loader=join(f.root,'fault-'+fault+'.mjs');
  await writeFile(loader,`import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';
const original=fs.open;fs.open=async function(path,...args){
 if(${JSON.stringify(fault)}==='read'&&String(path).endsWith('policy.json')){const e=new Error('private-raw-path-secret');e.code='EIO';throw e;}
 const handle=await original.call(this,path,...args);
 if(${JSON.stringify(fault)}==='write'&&String(path).endsWith('report.json.partial'))handle.writeFile=async()=>{const e=new Error('private-raw-path-secret');e.code='ENOSPC';throw e;};return handle;};syncBuiltinESMExports();`,{mode:0o600});
  const args=['--backup-dir',f.options.backupDirectory,'--drill-dir',f.options.drillDirectory,'--policy-file',f.options.policyFile,'--report-dir',f.options.reportDirectory];
  const r=await new Promise<{code:number;out:string;err:string}>((done,reject)=>{const p=spawn(process.execPath,['--import',pathToFileURL(loader).href,'--import','tsx','deploy/recovery-readiness.ts',...args],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('close',code=>done({code:code??-1,out,err}));});
  assert.notEqual(r.code,0);assert.equal(r.out,'');assert.match(r.err,new RegExp(fault==='write'?'REPORT_WRITE_FAILED':'INPUT_UNREADABLE'));assert.ok(!r.err.includes('private-raw-path-secret'));assert.deepEqual(await readdir(f.options.reportDirectory),[]);
 }
});
scenario('expired old history cannot contaminate an independently verified fresh point',async f=>{
 const old=await f.backup(-200000);await f.drill(old,-150000);const recent=await f.backup();await f.drill(recent);const r=await assess(f);
 assert.equal(r.localRecoveryReadiness.status,'READY');assert.equal(r.latestLocalRestoreVerifiedBackup?.backupId,recent.manifest.identity);assert.equal(r.evidenceIssues.length,1);
});
scenario('future review times and empty policy trust cannot grant off-host readiness',async f=>{
 const b=await f.backup(),d=await f.drill(b),e=await f.offhost(b,d);e.evidence.ownerReview.reviewedAt=iso(10000);e.resign();await e.save();
 let r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code==='INVALID_TIME'));
 e.evidence.ownerReview.reviewedAt=iso(-1000);e.resign();await e.save();f.policy.trustedOffHostReviewers=[];await f.savePolicy();r=await assess(f);assert.equal(r.disasterRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code==='OWNER_REVIEW_UNTRUSTED'));
});
scenario('freshness includes time spent reading archives, using paired wall/monotonic clock',async f=>{
 const b=await f.backup();await f.drill(b);f.policy.maxDrillAgeMs=6000;await f.savePolicy();let sample=0;
 const clock=new DrillClock(()=>fixtureNow+1000*(sample++),()=>BigInt(sample-1)*1000000000n);
 const r=await assessReadiness(f.options,clock);assert.equal(r.localRecoveryReadiness.status,'NOT_VERIFIED');assert.ok(r.evidenceIssues.some(i=>i.code==='RESTORE_DRILL_EXPIRED'));
});
