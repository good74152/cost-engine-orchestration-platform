import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import { Client, Pool } from 'pg';
import { assessRecovery, parseRecoveryAssessment, MAX_MANUAL_REVIEW_ITEMS } from '../src/deployment/recovery-assessment.js';
import { assessRpo, DrillClock } from '../src/deployment/drill-report.js';
import { parseDrillArguments, assertPrivateDirectory } from '../deploy/dr-drill.js';
import { DemoCutoverOperator } from '../src/modules/demo-cutover/demo-cutover.operator.js';
import { seedDemoSixDomainConfiguration } from './seed-demo-six-domain-configuration.js';
import { drillDataFixture } from './support/demo-05d3b-data-fixture.js';

const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error('DR assessment tests require explicit disposable TEST_DATABASE_URL');
const connection = (name: string) => {const url=new URL(source!);url.pathname='/'+name;return url.toString();};
test('Demo-05D-3B real PostgreSQL: read-only recovery assessment', {timeout:300000},async t=>{
 const name='demo05d3b_'+randomUUID().replaceAll('-',''), admin=new Client({connectionString:connection('postgres')});await admin.connect();
 const prior={...process.env};process.env.APP_MODE='demo';process.env.NODE_ENV='test';process.env.EXECUTOR_TYPE='fake';let db:Pool|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  await runner({databaseUrl:connection(name),dir:'migrations',direction:'up',migrationsTable:'pgmigrations',singleTransaction:true,logger:{debug(){},info(){},warn(){},error(){}}});
  db=new Pool({connectionString:connection(name),max:4});await seedDemoSixDomainConfiguration(db);await db.query("UPDATE demo_admission_control SET state='DRAINING'");await new DemoCutoverOperator(db).cutover();
  const data=await drillDataFixture(db), pool=db;
  const stored=async()=>{
   const values:unknown[]=[];for(const table of ['demo_sessions','dataset_series','dataset_versions','calculation_jobs','execution_attempts','dataset_build_snapshots','dataset_build_snapshot_dependencies','demo_admission_control'])
    values.push((await pool.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows);return createHash('sha256').update(JSON.stringify(values)).digest('hex');
  };
  await t.test('RUNNING/ACCEPTED and PENDING/PREPARED/DISPATCHING are distinct manual reasons; terminal history remains counted',async()=>{
   const before=await stored(), report=await assessRecovery(pool);assert.equal(report.transactionReadOnly,true);
   assert.deepEqual(report.jobStatusCounts,{PENDING:4,RUNNING:1,SUCCEEDED:10,FAILED:1});
   assert.deepEqual(report.attemptStatusCounts,{PREPARED:1,DISPATCHING:1,ACCEPTED:1,SUCCEEDED:10,FAILED:1,DISPATCH_FAILED:1});
   assert.equal(report.manualReviewCount,5);
   for(const [status,reason,category]of [
    ['NONE','NO_ATTEMPT_NOT_STARTED','NOT_STARTED'],['PREPARED','PREPARED_NOT_DISPATCHED','NOT_STARTED'],
    ['DISPATCHING','DISPATCH_OUTCOME_UNKNOWN','POSSIBLE_UNKNOWN_OUTCOME'],['ACCEPTED','ACCEPTED_EXECUTOR_STATE_UNAVAILABLE','EXECUTOR_CONFIRMATION_REQUIRED'],
    ['DISPATCH_FAILED','DISPATCH_REJECTED_NOT_STARTED','NOT_STARTED']]){
    const item=report.manualReview.find(r=>r.jobId===data.ids[status!]!.job);assert.ok(item);assert.ok(item.attemptId===data.ids[status!]!.attempt,'Expected private attempt binding');assert.equal(item.reasonCode,reason);assert.equal(item.category,category);
   }
   assert.ok(!report.manualReview.some(r=>r.jobId===data.ids.FAILED!.job));assert.equal(await stored(),before);assert.ok(JSON.stringify(parseRecoveryAssessment(report))===JSON.stringify(report),'Strict report projection must match');
   const serialized=JSON.stringify(report);const hash=(await pool.query("SELECT encode(token_hash,'hex') AS hash FROM demo_sessions")).rows[0].hash as string;
   assert.ok(!serialized.includes(hash));assert.doesNotMatch(serialized,/token_hash|company_code|airflow_dag|last_dispatch_error/);
  });
  await t.test('PostgreSQL actually refuses writes inside the assessment transaction',async()=>{
   const probe=new Pool({connectionString:connection(name),max:1});let verified=false;
   probe.on('connect',client=>{
    const original=client.query.bind(client);
    client.query=(async(sql:string,params?:unknown[])=>{
     const result=await original(sql,params);
     if(sql.startsWith('BEGIN')){
      assert.equal((await original('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');await original('SAVEPOINT readonly_probe');
      await assert.rejects(original("UPDATE calculation_jobs SET status='FAILED'"),{code:'25006'});await original('ROLLBACK TO SAVEPOINT readonly_probe');verified=true;
     }return result;
    }) as typeof client.query;
   });try{assert.equal((await assessRecovery(probe)).manualReviewCount,5);assert.equal(verified,true);}finally{await probe.end();}
  });
  await t.test('a nonterminal Job without an active Attempt is reported without rewriting terminal attempts',async()=>{
   await pool.query("UPDATE calculation_jobs SET status='RUNNING' WHERE id=$1",[data.ids.FAILED!.job]);
   try{const r=await assessRecovery(pool);const item=r.manualReview.find(x=>x.jobId===data.ids.FAILED!.job)!;assert.equal(item.attemptStatus,'FAILED');assert.equal(item.reasonCode,'NONTERMINAL_JOB_REQUIRES_REVIEW');}
   finally{await pool.query("UPDATE calculation_jobs SET status='FAILED' WHERE id=$1",[data.ids.FAILED!.job]);}
  });
  await t.test('more than 10000 manual items fails explicitly instead of truncating a success report',async()=>{
   const series=randomUUID();await pool.query("INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version) VALUES($1,'FAB_COST','LIMIT_FIXTURE',2040,'Q1',$2)",[series,MAX_MANUAL_REVIEW_ITEMS+1]);
   await pool.query(`WITH versions AS (INSERT INTO dataset_versions(id,dataset_series_id,version,status)
     SELECT gen_random_uuid(),$1,n,'ABANDONED' FROM generate_series(1,$2) n RETURNING id)
     INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,status)
     SELECT gen_random_uuid(),v.id,t.id,'PENDING' FROM versions v CROSS JOIN calculation_types t WHERE t.domain='FAB_COST'`,[series,MAX_MANUAL_REVIEW_ITEMS+1]);
   await assert.rejects(assessRecovery(pool),/Read-only recovery assessment failed/);
   assert.equal((await pool.query('SELECT count(*) AS n FROM calculation_jobs j JOIN dataset_versions v ON v.id=j.output_dataset_version_id WHERE v.dataset_series_id=$1',[series])).rows[0].n,String(MAX_MANUAL_REVIEW_ITEMS+1));
  });
  await t.test('private report parser rejects extra secret columns, arbitrary reasons and incomplete lists',async()=>{
   const valid={transactionReadOnly:true,jobStatusCounts:{PENDING:0,RUNNING:0,SUCCEEDED:0,FAILED:0},attemptStatusCounts:{PREPARED:0,DISPATCHING:0,ACCEPTED:0,SUCCEEDED:0,FAILED:0,DISPATCH_FAILED:0},manualReviewCount:0,manualReview:[]};
   assert.deepEqual(parseRecoveryAssessment(valid),valid);
   for(const bad of [{...valid,token_hash:'secret'},{...valid,manualReviewCount:1},{...valid,jobStatusCounts:{...valid.jobStatusCounts,secret:'credential'}},{...valid,manualReview:[{jobId:randomUUID(),attemptId:null,jobStatus:'PENDING',attemptStatus:null,reasonCode:'secret',category:'NOT_STARTED'}],manualReviewCount:1}])assert.throws(()=>parseRecoveryAssessment(bad));
  });
 }finally{
  await db?.end();assert.match(name,/^demo05d3b_[a-f0-9]{32}$/);await admin.query(`DROP DATABASE "${name}"`);await admin.end();
  for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);console.info('DEMO05D3B_PG_TEARDOWN',JSON.stringify({databaseDropped:true,production:false}));
 }
});

test('DR RPO/time and target admission are conservative and explicit',async t=>{
 const started='2026-10-30T00:00:00.000Z',created='2026-10-30T00:00:05.000Z',assessed='2026-10-30T00:01:00.000Z';
 await t.test('unset, within-target and exceeded RPO keep actual loss UNKNOWN',()=>{
  for(const [target,result]of [[null,'NOT_CONFIGURED'],[60000,'WITHIN_TARGET'],[59999,'EXCEEDS_TARGET'],[0,'EXCEEDS_TARGET']]as const){const r=assessRpo(started,created,assessed,target);assert.equal(r.backupAgeMs,60000);assert.equal(r.targetRpoMs,target);assert.equal(r.result,result);assert.equal(r.actualDataLoss,'UNKNOWN');assert.equal(r.productionRpoAchieved,false);}
 });
 await t.test('invalid/noncanonical/future timestamps and invalid targets are rejected',()=>{
  for(const bad of ['invalid','2026-02-30T00:00:00.000Z','2026-10-30','2026-10-30T00:02:00.000Z',null])assert.throws(()=>assessRpo(bad,created,assessed,null));
  assert.throws(()=>assessRpo(started,'2026-10-30T00:02:00.000Z',assessed,null));for(const n of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assessRpo(started,created,assessed,n));
 });
 await t.test('monotonic durations tolerate wall rounding but reject clock reversal/jumps',()=>{
  let wall=Date.parse(started),mono=0n;const clock=new DrillClock(()=>wall,()=>mono);assert.equal(clock.sample().elapsedMs,0);
  wall+=10;mono+=10000000n;assert.equal(clock.sample().elapsedMs,10);wall-=1;assert.throws(()=>clock.sample());
  const forward=new DrillClock(()=>wall,()=>mono);wall+=5000;mono+=1000000n;assert.throws(()=>forward.sample());
  const reverse=new DrillClock(()=>wall,()=>mono);mono-=1n;assert.throws(()=>reverse.sample());
 });
 await t.test('only backup/report and explicit RPO arguments are accepted; private output cannot be in a repository',()=>{
  assert.throws(()=>parseDrillArguments(['--database-url','postgres://invalid','--report-dir','/tmp']));assert.throws(()=>parseDrillArguments(['--backup-file','/tmp/backup.dump','--report-dir','/tmp','--target-rpo-ms','-1']));
  assert.throws(()=>parseDrillArguments(['--backup-file','/tmp/backup.dump','--backup-file','/tmp/backup.dump']));assert.throws(()=>assertPrivateDirectory(process.cwd()));
 });
 await t.test('buffered phase markers preserve emission durations and reject incompatible clocks',()=>{
  const start=Date.parse(started);let mono=0n,wall=start;const clock=new DrillClock(()=>wall,()=>mono);
  mono=100000000n;wall+=100;clock.sample();
  const a=clock.observeEmission(new Date(start+10).toISOString(),'10000000'),b=clock.observeEmission(new Date(start+40).toISOString(),'40000000');assert.equal(b.elapsedMs-a.elapsedMs,30);
  assert.throws(()=>clock.observeEmission(new Date(start+30).toISOString(),'30000000'));assert.throws(()=>clock.observeEmission(new Date(start+200).toISOString(),'200000000'));
 });
});
