import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { firstDeploymentBusinessTables } from '../../src/deployment/cutover-preflight.js';
import { assessRpo, drillPhases, DrillClock, type DrillReport } from '../../src/deployment/drill-report.js';
import { sha256, offHostSigningPayload, type OperationalManifest, type RecoveryPolicy, type OffHostEvidence } from '../../src/deployment/readiness-evidence.js';
import type { ReadinessOptions } from '../../src/deployment/recovery-readiness.js';

export const fixtureNow = Date.now();
export const iso = (offset: number) => new Date(fixtureNow+offset).toISOString();
export const fixtureClock = () => new DrillClock(()=>fixtureNow,()=>0n);
export async function readinessFixture() {
  const root = await mkdtemp(join(tmpdir(),'demo05d3c-')); const options:ReadinessOptions={backupDirectory:join(root,'backups'),
    drillDirectory:join(root,'drills'),policyFile:join(root,'policy','policy.json'),reportDirectory:join(root,'readiness'),offHostDirectory:join(root,'offhost')};
  for(const name of ['backups','drills','policy','readiness','offhost']) await mkdir(join(root,name),{mode:0o700});
  const keys=generateKeyPairSync('ed25519');
  const policy:RecoveryPolicy={formatVersion:1,targetRpoMs:100000,maxDrillAgeMs:100000,maxOffHostEvidenceAgeMs:100000,
    trustedOffHostReviewers:[{keyId:'owner-2026',reviewerId:'system-owner',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString()}]};
  const json=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value),{mode:0o600});
  const savePolicy=()=>json(options.policyFile,policy); await savePolicy();
  const backup=async(start=-10000)=>{
    const identity='cost-engine-live-backup-'+randomBytes(12).toString('hex'),directory=join(options.backupDirectory,identity),archive=Buffer.from('PGDMP-private-offline-unit-fixture-'+identity);
    const manifest:OperationalManifest={formatVersion:1,purpose:'OPERATIONAL',result:'BACKUP_CREATED',identity,fileName:'backup.dump',sizeBytes:String(archive.length),sha256:sha256(archive),
      startedAt:iso(start),createdAt:iso(start+100),snapshot:{result:'PASS',postgresVersion:'18',admissionState:'WORKFLOW_OPEN',admissionUpdatedAt:iso(start-100),configuration:'WORKFLOW',
        deploymentVersion:'fixture-commit-001',migrations:['1793400000000_demo-workflow-admission'],schemaSha256:sha256('schema'),configurationSha256:sha256('configuration'),dataSha256:sha256('data'),
        counts:Object.fromEntries(firstDeploymentBusinessTables.map(t=>[t,0]))}};
    await mkdir(directory,{mode:0o700});await json(join(directory,'manifest.json'),manifest);await writeFile(join(directory,'backup.dump'),archive,{mode:0o600});
    return {manifest,directory,archive,save:()=>json(join(directory,'manifest.json'),manifest)};
  };
  const drill=async(b:Awaited<ReturnType<typeof backup>>,start=-5000)=>{
    const drillId='drill-'+randomBytes(16).toString('hex'),file=join(options.drillDirectory,drillId,'report.json'),m=b.manifest;
    const report:DrillReport={formatVersion:1,result:'DRILL_VERIFIED',drillId,startedAt:iso(start),completedAt:iso(start+1000),
      backup:{identity:m.identity,sha256:m.sha256,sizeBytes:m.sizeBytes,deploymentVersion:m.snapshot.deploymentVersion,startedAt:m.startedAt,createdAt:m.createdAt},
      verification:{postgresVersion:'18',admissionState:'WORKFLOW_OPEN',configuration:'WORKFLOW',migrations:m.snapshot.migrations,schemaSha256:m.snapshot.schemaSha256,
        configurationSha256:m.snapshot.configurationSha256,dataSha256:m.snapshot.dataSha256,counts:m.snapshot.counts,isolated:true,cleaned:true},
      assessment:{transactionReadOnly:true,jobStatusCounts:{PENDING:0,RUNNING:0,SUCCEEDED:0,FAILED:0},attemptStatusCounts:{PREPARED:0,DISPATCHING:0,ACCEPTED:0,SUCCEEDED:0,FAILED:0,DISPATCH_FAILED:0},
        manualReviewCount:0,manualReview:[],assessedAt:iso(start+800)},rpo:assessRpo(m.startedAt,m.createdAt,iso(start+800),null),
      phases:drillPhases.map(name=>({name,result:'PASS',durationMs:100})),drillDurationMs:1000,serviceRecoveryTested:false,achievedRtoMs:null,productionRecoveryApproved:false};
    await mkdir(join(options.drillDirectory,drillId),{mode:0o700});await json(file,report);return{report,file,save:()=>json(file,report)};
  };
  const offhost=async(b:Awaited<ReturnType<typeof backup>>,d:Awaited<ReturnType<typeof drill>>)=>{
    const evidence:OffHostEvidence={formatVersion:1,evidenceId:'offhost-'+randomBytes(16).toString('hex'),backupId:b.manifest.identity,
      originalSha256:b.manifest.sha256,retrievedSha256:b.manifest.sha256,retrievedAt:new Date(Date.parse(d.report.startedAt)-100).toISOString(),storageReference:'owner-vault/media-001',
      drillId:d.report.drillId,drillReportSha256:sha256(await readFile(d.file)),verifiedBy:'system-owner',verifiedAt:new Date(Date.parse(d.report.completedAt)+100).toISOString(),
      ownerReview:{reviewId:'owner-review-'+randomBytes(16).toString('hex'),keyId:'owner-2026',reviewedAt:new Date(Date.parse(d.report.completedAt)+200).toISOString(),purpose:'OFF_HOST_RETRIEVAL_AND_DRILL_REVIEW',signature:''}};
    const file=join(options.offHostDirectory!,evidence.evidenceId+'.json');
    const resign=()=>{evidence.ownerReview.signature=sign(null,offHostSigningPayload(evidence),keys.privateKey).toString('base64');};resign();
    const save=()=>json(file,evidence);await save();return{evidence,file,resign,save};
  };
  return{root,options,policy,savePolicy,backup,drill,offhost,json,cleanup:()=>rm(root,{recursive:true,force:true})};
}
