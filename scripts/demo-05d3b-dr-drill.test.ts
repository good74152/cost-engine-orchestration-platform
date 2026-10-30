import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import type { DrillReport } from '../src/deployment/drill-report.js';
import { parseOperationalManifest, parseVerifiedDrill } from '../src/deployment/readiness-evidence.js';

interface Result { code:number; out:string; err:string }
function command(exe:string,args:string[],env=process.env,input?:string):Promise<Result>{return new Promise((done,reject)=>{
 const p=spawn(exe,args,{env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=String(b));p.stderr.on('data',b=>err+=String(b));p.once('error',reject);p.stdin.on('error',()=>{});p.stdin.end(input);p.once('close',code=>done({code:code??-1,out,err}));
});}
const posix=(p:string)=>process.platform==='win32'?p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d:string)=>'/'+d.toLowerCase()):p;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

test('Demo-05D-3B real Docker: isolated DR drill and private recovery report',{timeout:1200000},async t=>{
 const id='demo05d3b_test_'+randomUUID().replaceAll('-','').slice(0,12),directory=await mkdtemp(join(tmpdir(),id+'-'));
 const secrets=join(directory,'secrets'),backups=join(directory,'backups'),reports=join(directory,'reports');for(const p of[secrets,backups,reports])await mkdir(p,{mode:0o700});
 const password=randomBytes(24).toString('hex'),proxy=randomBytes(32).toString('hex'),url=`postgres://demo_owner:${password}@database:5432/cost_engine_demo`,privateValues=[password,proxy,url];
 for(const [key,value]of Object.entries({postgres_password:password,proxy_secret:proxy,database_url:url}))await writeFile(join(secrets,key),value,{mode:0o644});
 const envFile=join(directory,'compose.env'),override=join(directory,'override.yaml');
 await writeFile(envFile,`DEPLOYMENT_VERSION=${id}\nCOMPOSE_PROJECT_NAME=${id}\nDEMO_PUBLIC_ORIGIN=https://localhost\nACME_EMAIL=test@example.invalid\nDEMO_SECRETS_DIR=${JSON.stringify(secrets.replaceAll('\\','/'))}\n`);
 await writeFile(override,`services:\n  backend:\n    container_name: ${id}-backend\n  web:\n    ports: !override []\n`);
 const base=['compose','--project-name',id,'--env-file',envFile,'-f',resolve('deploy/compose.yaml'),'-f',override],shell=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'sh';
 const env={...process.env,COMPOSE_PROJECT_NAME:id,DEMO_DEPLOY_ENV:posix(envFile),DEMO_COMPOSE_FILE:posix(resolve('deploy/compose.yaml')),DEMO_COMPOSE_OVERRIDE:posix(override),DEMO_BACKUP_DIR:posix(backups)};
 const safe=(text:string)=>privateValues.reduce((s,v)=>s.replaceAll(v,'[redacted]'),text).replaceAll(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g,'[private-id]');
 const docker=async(args:string[],ok=true,input?:string)=>{const r=await command('docker',args,process.env,input);if(ok)assert.equal(r.code,0,safe(r.err.slice(-2500)+r.out.slice(-1000)));return r;};
 const compose=(...args:string[])=>docker([...base,...args]);
 const script=async(name:string,args:string[]=[],ok=true)=>{const r=await command(shell,[posix(resolve('deploy/scripts/'+name+'.sh')),...args],env);if(ok)assert.equal(r.code,0,safe(r.err+r.out));else assert.notEqual(r.code,0);return r;};
 const target=['--database-url-file','/run/secrets/database_url'];
 const sql=async(q:string)=>(await compose('exec','-T','database','psql','-U','demo_owner','-d','cost_engine_demo','-At','-v','ON_ERROR_STOP=1','-c',q)).out.trim();
 const resourceIds=async()=>({containers:(await docker(['ps','--all','--filter','label=cost-engine.restore.purpose=demo05d2','--format','{{.ID}}'])).out.trim(),volumes:(await docker(['volume','ls','--filter','label=cost-engine.restore.purpose=demo05d2','--format','{{.Name}}'])).out.trim()});
 const sourceEvidence=async()=>({gate:await sql('SELECT row_to_json(g) FROM demo_admission_control g'),data:await sql(`SELECT md5(jsonb_agg(row ORDER BY row::text)::text) FROM (
  SELECT to_jsonb(j) AS row FROM calculation_jobs j UNION ALL SELECT to_jsonb(a) FROM execution_attempts a UNION ALL SELECT to_jsonb(s) FROM demo_sessions s UNION ALL SELECT to_jsonb(v) FROM dataset_versions v UNION ALL SELECT to_jsonb(b) FROM dataset_build_snapshots b UNION ALL SELECT to_jsonb(d) FROM dataset_build_snapshot_dependencies d) rows`),database:(await compose('ps','-q','database')).out.trim()});
 const reportNames=async()=>(await readdir(reports)).sort();
 let archive='',manifest:any,ids:Record<string,{job:string;attempt:string|null}>={},initialized=false;
 const drill=async(extra:string[]=[],ok=true,input=archive,processEnv:NodeJS.ProcessEnv=process.env)=>{
  const r=await command(process.execPath,['--import','tsx','deploy/dr-drill.ts','--backup-file',input,'--report-dir',reports,...extra],processEnv);
  for(const secret of privateValues)assert.ok(!(r.out+r.err).includes(secret),'Console must never contain secrets');
  assert.doesNotMatch(r.out+r.err,/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/,'No manual-review identifiers in Console');
  if(ok)assert.equal(r.code,0,safe(r.err));else{assert.notEqual(r.code,0);assert.doesNotMatch(r.out,/DRILL_VERIFIED/);}return r;
 };
 const readNewReport=async(before:string[])=>{
  const after=await reportNames(),created=after.filter(n=>!before.includes(n));assert.equal(created.length,1);assert.match(created[0]!,/^drill-[a-f0-9]{32}$/);
  const file=join(reports,created[0]!,'report.json'),text=await readFile(file,'utf8'),report=JSON.parse(text) as DrillReport;
  // The downstream offline assessment accepts actual 3B restore evidence,
  // including populated history/manual review, without rerunning a restore.
  const now=new Date().toISOString();
  assert.doesNotThrow(()=>parseVerifiedDrill(report,parseOperationalManifest(manifest,now),now),'Readiness must accept the real 3B DTO');
  for(const secret of privateValues)assert.ok(!text.includes(secret),'Private report cannot contain tokens/hashes/credentials');
  assert.doesNotMatch(text,/token_hash|database_url|company_code|last_dispatch_error|airflow_dag/i);
  if(process.platform!=='win32'){assert.equal((await stat(file)).mode&0o077,0);assert.equal((await stat(dirname(file))).mode&0o777,0o700);}
  return {report,file};
 };
 const cloned=async(label:string,change:(m:any)=>void,bytes?:Buffer)=>{
  const identity='cost-engine-live-backup-'+label+'-'+randomBytes(6).toString('hex'),dir=join(backups,identity);await mkdir(dir,{mode:0o700});
  const m=structuredClone(manifest);m.identity=identity;change(m);await writeFile(join(dir,'manifest.json'),JSON.stringify(m));await writeFile(join(dir,'backup.dump'),bytes??await readFile(archive));return join(dir,'backup.dump');
 };
 try{
  await t.test('build existing operator, migrate/cutover only disposable source and create populated operational backup',async()=>{
   await compose('--profile','operations','build','operator');initialized=true;await compose('up','-d','--no-deps','--wait','database');
   await script('operate',['migrate-up']);await script('operate',['seed-six-domain']);await script('operate',['admission-drain',...target]);await script('operate',['cutover',...target]);
   const setup=join(directory,'fixture.ts');await writeFile(setup,"import{readFileSync}from'node:fs';import{Pool}from'pg';import{drillDataFixture}from'./support/demo-05d3b-data-fixture.js';\nconst db=new Pool({connectionString:readFileSync('/run/secrets/database_url','utf8').trim()});try{const x=await drillDataFixture(db);console.log(JSON.stringify(x.ids));}finally{await db.end();}\n");
   const fixture=await docker([...base,'run','--rm','-T','--no-deps','--entrypoint','./node_modules/.bin/tsx','--volume',`${setup}:/app/scripts/fixture.ts:ro`,'--volume',`${resolve('scripts/support')}:/app/scripts/support:ro`,'operator','scripts/fixture.ts']);
   ids=JSON.parse(fixture.out); // Job/Attempt IDs belong only in the private report, never Console.
   privateValues.push(await sql("SELECT encode(token_hash,'hex') FROM demo_sessions"));
   const b=await script('backup-live',target);manifest=JSON.parse(b.out);archive=join(backups,manifest.identity,'backup.dump');
   assert.equal(sha(await readFile(archive)),manifest.sha256);assert.equal(manifest.snapshot.counts.calculation_jobs,16);assert.equal(manifest.snapshot.counts.execution_attempts,15);
   // This retained image lacks the new assessment entrypoint. The drill uses
   // current trusted read-only source mounts, not a rewritten backup/image.
   assert.notEqual((await docker(['run','--rm','--network','none','--entrypoint','test',`cost-engine-demo-operator:${id}`,'-e','/app/deploy/dr-assess-restored.ts'],false)).code,0);
  });
  assert.ok(initialized&&archive&&manifest,'Disposable bootstrap must succeed before dependent drill tests');
  await t.test('actual isolated PostgreSQL restore yields private complete read-only assessment and observed timings',async()=>{
   const before=await reportNames(),source=await sourceEvidence(),resources=await resourceIds(),backupHash=sha(await readFile(archive)),manifestHash=sha(await readFile(join(dirname(archive),'manifest.json')));
   const r=await drill();const summary=JSON.parse(r.out);assert.deepEqual(Object.keys(summary).sort(),['achievedRtoMs','drillDurationMs','manualReviewCount','productionRecoveryApproved','result','rpoAssessment','serviceRecoveryTested'].sort());assert.equal(summary.manualReviewCount,5);
   const {report}=await readNewReport(before);assert.equal(report.result,'DRILL_VERIFIED');assert.equal(report.rpo.targetRpoMs,null);assert.equal(report.rpo.result,'NOT_CONFIGURED');assert.equal(report.rpo.actualDataLoss,'UNKNOWN');
   assert.equal(report.assessment.transactionReadOnly,true);assert.equal(report.assessment.jobStatusCounts.RUNNING,1);assert.equal(report.assessment.jobStatusCounts.SUCCEEDED,10);assert.equal(report.assessment.jobStatusCounts.FAILED,1);
   assert.equal(report.assessment.attemptStatusCounts.SUCCEEDED,10);assert.equal(report.assessment.attemptStatusCounts.FAILED,1);assert.equal(report.assessment.manualReviewCount,5);
   assert.ok(report.assessment.manualReview.some(x=>x.jobId===ids.DISPATCHING!.job&&x.reasonCode==='DISPATCH_OUTCOME_UNKNOWN'),'Expected unknown dispatch review');
   assert.ok(report.assessment.manualReview.some(x=>x.jobId===ids.NONE!.job&&x.reasonCode==='NO_ATTEMPT_NOT_STARTED'),'Expected not-started review');
   assert.equal(report.serviceRecoveryTested,false);assert.equal(report.achievedRtoMs,null);assert.equal(report.productionRecoveryApproved,false);
   assert.deepEqual(report.phases.map(p=>p.name),['INTEGRITY_CHECK','RESTORE','VALIDATION','ASSESSMENT','CLEANUP']);assert.ok(report.phases.every(p=>p.result==='PASS'&&p.durationMs>=0));assert.ok(report.drillDurationMs>=report.phases.reduce((n,p)=>n+p.durationMs,0));
   assert.equal(report.verification.dataSha256,manifest.snapshot.dataSha256);assert.equal(report.verification.schemaSha256,manifest.snapshot.schemaSha256);assert.equal(report.verification.cleaned,true);
   assert.deepEqual(await sourceEvidence(),source);assert.deepEqual(await resourceIds(),resources);assert.equal(sha(await readFile(archive)),backupHash);assert.equal(sha(await readFile(join(dirname(archive),'manifest.json'))),manifestHash);
   assert.equal((await compose('ps','--all','-q','backend')).out.trim(),'');assert.equal((await compose('--profile','public-web','ps','--all','-q','web')).out.trim(),'');
   console.info('DRILL_EVIDENCE',JSON.stringify({postgresVersion:'18',isolated:true,cleaned:true,manualReviewCount:5,terminalHistoryPreserved:true,serviceRecoveryTested:false,achievedRtoMs:null}));
  });
  await t.test('explicit within-target RPO and exceeded-target risk are separate from technical success; reports never overwrite',async()=>{
   const existing=await reportNames(),oldHash=sha(await readFile(join(reports,existing[0]!,'report.json')));
   for(const [target,result]of [['8640000000','WITHIN_TARGET'],['0','EXCEEDS_TARGET']]){
    const before=await reportNames(),r=await drill(['--target-rpo-ms',target!]);assert.equal(JSON.parse(r.out).rpoAssessment,result);
    const {report}=await readNewReport(before);assert.equal(report.rpo.result,result);assert.equal(report.rpo.targetRpoMs,Number(target));assert.equal(report.rpo.backupAgeMs,Date.parse(report.rpo.assessedAt)-Date.parse(manifest.startedAt));assert.equal(report.achievedRtoMs,null);
   }assert.equal(sha(await readFile(join(reports,existing[0]!,'report.json'))),oldHash);assert.equal((await reportNames()).length,existing.length+2);
  });
  await t.test('future/invalid/inconsistent backup times and corrupt archive publish no report and change no source',async()=>{
   const before=await reportNames(),resources=await resourceIds(),source=await sourceEvidence();
   for(const file of [await cloned('future',m=>{m.startedAt='2999-01-01T00:00:00.000Z';m.createdAt=m.startedAt;}),await cloned('bad-time',m=>{m.startedAt='invalid';}),await cloned('reversed',m=>{m.startedAt=m.createdAt;m.createdAt='2000-01-01T00:00:00.000Z';}),await cloned('damaged',()=>{},(await readFile(archive)).subarray(0,256))])await drill([],false,file);
   assert.deepEqual(await reportNames(),before);assert.deepEqual(await resourceIds(),resources);assert.deepEqual(await sourceEvidence(),source);
  });
  const faultEnv=async(kind:string)=>{
   const bin=join(directory,'fault-'+kind);await mkdir(bin);const actual=(await command(shell,['-c','command -v docker'])).out.trim();assert.ok(actual);
   const body=kind==='assessment'?'case " $* " in *" deploy/dr-assess-restored.ts "*) exit 47;; esac':
    kind==='cleanup'?'case " $* " in *" rm --force --volumes "*) exit 48;; esac':
    'if [ "$1" = inspect ] && [ "${#2}" -eq 64 ]; then printf "[]\\n"; exit 0; fi';
   const capture='case "$1" in\n create) value=$("$DEMO_TEST_REAL_DOCKER" "$@") || exit; printf "%s\\n" "$value" > "$DEMO_TEST_CONTAINER_FILE"; printf "%s\\n" "$value"; exit 0;;\n volume) if [ "$2" = create ]; then value=$("$DEMO_TEST_REAL_DOCKER" "$@") || exit; printf "%s\\n" "$value" > "$DEMO_TEST_VOLUME_FILE"; printf "%s\\n" "$value"; exit 0; fi;;\n esac\n';
   await writeFile(join(bin,'docker'),'#!/bin/sh\n'+capture+body+'\nexec "$DEMO_TEST_REAL_DOCKER" "$@"\n',{mode:0o755});
   // Node's PATH uses native separators. Execute the Node CLI through this
   // private POSIX launcher so only its Docker descendants receive the shim.
   return {bin,actual,containerFile:join(bin,'created-container'),volumeFile:join(bin,'created-volume')};
  };
  const runFault=async(kind:string)=>{
   const initial=await reportNames(),resources=await resourceIds(),source=await sourceEvidence(),fault=await faultEnv(kind);
   const r=await command(shell,['-c','PATH="$1:$PATH"; export PATH; export DEMO_TEST_REAL_DOCKER="$2" DEMO_TEST_CONTAINER_FILE="$5" DEMO_TEST_VOLUME_FILE="$6"; exec node --import tsx deploy/dr-drill.ts --backup-file "$3" --report-dir "$4"','fault',posix(fault.bin),fault.actual,posix(archive),posix(reports),posix(fault.containerFile),posix(fault.volumeFile)]);
   assert.notEqual(r.code,0);assert.doesNotMatch(r.out,/DRILL_VERIFIED/);assert.doesNotMatch(r.out+r.err,/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/);for(const secret of privateValues)assert.ok(!(r.out+r.err).includes(secret));
   assert.deepEqual(await reportNames(),initial);assert.deepEqual(await sourceEvidence(),source);
   const now=await resourceIds();
   if(kind==='assessment')assert.deepEqual(now,resources);
   else{
    assert.ok(now.containers.length>resources.containers.length,'Unknown/failed-cleanup resources must not be silently removed');
    // Test-only rescue checks immutable resource IDs and their real owner labels;
    // production never guesses cleanup after the injected failed observation.
    const ownedId=(await readFile(fault.containerFile,'utf8')).trim(),ownedVolume=(await readFile(fault.volumeFile,'utf8')).trim();assert.match(ownedId,/^[a-f0-9]{64}$/);
    const observed=JSON.parse((await docker(['inspect',ownedId])).out)[0],owner=observed.Config.Labels['cost-engine.restore.owner'];assert.match(owner,/^[a-f0-9]{32}$/);
    assert.equal(observed.Id,ownedId);assert.equal(observed.Name,'/demo05d2_restore_'+owner+'_postgres');assert.equal(observed.HostConfig.NetworkMode,'none');assert.equal(observed.Mounts[0].Name,ownedVolume);
    assert.equal(ownedVolume,'demo05d2_restore_'+owner+'_data');const volume=JSON.parse((await docker(['volume','inspect',ownedVolume])).out)[0];assert.equal(volume.Labels['cost-engine.restore.owner'],owner);assert.equal(volume.Labels['cost-engine.restore.purpose'],'demo05d2');
    await docker(['rm','--force','--volumes',ownedId]);await docker(['volume','rm',ownedVolume]);
    assert.deepEqual(await resourceIds(),resources);
   }
  };
  await t.test('assessment failure withholds DRILL_VERIFIED and private report, then cleans exact-owned resources',()=>runFault('assessment'));
  await t.test('cleanup failure withholds DRILL_VERIFIED and report without touching source',()=>runFault('cleanup'));
  await t.test('unknown ownership refuses deletion and report; only verified test-owned rescue removes fixtures',()=>runFault('ownership'));
  await t.test('existing verify-backup-live CLI and exact success JSON contract remain unchanged',async()=>{
   const before=await reportNames(),r=await script('verify-backup-live',['--backup-file',posix(archive)]);const value=JSON.parse(r.out);assert.equal(value.result,'RESTORE_VERIFIED');assert.ok(!('assessment'in value));assert.ok(!('phases'in value));assert.equal(value.dataSha256,manifest.snapshot.dataSha256);assert.deepEqual(await reportNames(),before);
  });
  await t.test('no arbitrary URLs/targets or unsafe report roots; source-offline drill never starts Backend',async()=>{
   const before=await reportNames();await drill(['--database-url',url],false);await drill(['--target-rpo-ms','-1'],false);
   const unsafe=await command(process.execPath,['--import','tsx','deploy/dr-drill.ts','--backup-file',archive,'--report-dir',resolve('.')]);assert.notEqual(unsafe.code,0);assert.deepEqual(await reportNames(),before);
   await compose('stop','database');try{const r=await drill();assert.equal(JSON.parse(r.out).result,'DRILL_VERIFIED');}finally{await compose('up','-d','--no-deps','--wait','database');}
   assert.equal((await compose('ps','--all','-q','backend')).out.trim(),'');assert.equal(await sql('SELECT state FROM demo_admission_control'),'WORKFLOW_OPEN');assert.equal(sha(await readFile(archive)),manifest.sha256);
  });
 }finally{
  if(initialized){const cfg=JSON.parse((await compose('--profile','operations','--profile','public-web','config','--format','json')).out);assert.equal(cfg.name,id);await compose('--profile','operations','--profile','public-web','down','--volumes','--remove-orphans');}
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith(id+'-'));await rm(directory,{recursive:true,force:true});console.info('DEMO05D3B_DOCKER_TEARDOWN',JSON.stringify({removed:true,production:false}));
 }
});
