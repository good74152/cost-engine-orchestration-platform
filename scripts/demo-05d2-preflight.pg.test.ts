import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { runner } from 'node-pg-migrate';
import { Client, Pool } from 'pg';
import { cutoverPreflight, firstDeploymentBusinessTables } from '../src/deployment/cutover-preflight.js';
import { DemoCutoverOperator } from '../src/modules/demo-cutover/demo-cutover.operator.js';
import { seedDemoSixDomainConfiguration } from './seed-demo-six-domain-configuration.js';

const source=process.env.TEST_DATABASE_URL;
if(!source) throw new Error('Preflight tests require explicit disposable TEST_DATABASE_URL');
const connection=(name:string)=>{const u=new URL(source!);u.pathname='/'+name;return u.toString();};
test('Demo-05D-2 PostgreSQL: strict first-deployment preflight and unchanged durable recovery',{timeout:600000},async t=>{
 const admin=new Client({connectionString:connection('postgres')});await admin.connect();
 const names:string[]=[];const pools:Pool[]=[];const prior={...process.env};
 process.env.APP_MODE='demo';process.env.NODE_ENV='test';process.env.EXECUTOR_TYPE='fake';
 const fixture=async(drained=true)=>{
  const name='demo05d2_'+randomUUID().replaceAll('-','');names.push(name);
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  await runner({databaseUrl:connection(name),dir:'migrations',direction:'up',migrationsTable:'pgmigrations',singleTransaction:true,
   logger:{debug(){},info(){},warn(){},error(){}}});
  const db=new Pool({connectionString:connection(name),max:6,application_name:name});pools.push(db);await seedDemoSixDomainConfiguration(db);
  if(drained)await db.query("UPDATE demo_admission_control SET state='DRAINING'");
  return {db,name,run:()=>cutoverPreflight(db,'demo05d2-test'),operator:new DemoCutoverOperator(db)};
 };
 const snapshot=async(db:Pool)=>{
  const result:Record<string,unknown>={};
  for(const table of [...firstDeploymentBusinessTables,'calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies','demo_admission_control','pgmigrations'])
   result[table]=(await db.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
  return result;
 };
 const reject=async(f:Awaited<ReturnType<typeof fixture>>)=>{
  const before=await snapshot(f.db);await assert.rejects(f.run(),(e:unknown)=>{
   assert.ok(e instanceof Error);assert.match(e.message,/preflight|configuration|sessions|work/i);
   assert.doesNotMatch(e.message,/postgres(?:ql)?:|SELECT |INSERT |password|token_hash/);return true;
  });assert.deepEqual(await snapshot(f.db),before);
 };
 const session=async(db:Pool,kind:string)=>{
  const id=randomUUID();await db.query(`INSERT INTO demo_sessions(id,company_code,token_hash,created_at,expires_at,revoked_at)
   VALUES($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()+$4::interval,
   CASE WHEN $5 THEN clock_timestamp() ELSE NULL END)`,[id,'DEMO_'+randomUUID().replaceAll('-','').slice(0,15).toUpperCase(),Buffer.alloc(32,1),kind==='expired'?'-1 hour':'1 hour',kind==='revoked']);return id;
 };
 const graph=async(db:Pool)=>{
  const ds=(await db.query("INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period) VALUES(gen_random_uuid(),'FAB_COST','RETAINED',2026,'Q4') RETURNING id")).rows[0].id;
  const version=(await db.query("INSERT INTO dataset_versions(id,dataset_series_id,version,status) VALUES(gen_random_uuid(),$1,1,'BUILDING') RETURNING id",[ds])).rows[0].id;
  const type=(await db.query("SELECT id FROM calculation_types WHERE domain='FAB_COST'")).rows[0].id;
  const job=(await db.query("INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,status) VALUES(gen_random_uuid(),$1,$2,'PENDING') RETURNING id",[version,type])).rows[0].id;
  await db.query('INSERT INTO dataset_build_snapshots(dataset_version_id) VALUES($1)',[version]);
  await db.query("INSERT INTO execution_attempts(calculation_job_id,attempt_number,status,airflow_dag_id,airflow_dag_run_id) VALUES($1,1,'PREPARED','fixture','fixture')",[job]);
 };
 try {
  await t.test('DRAINING + complete nine-type/six-domain Legacy catalog passes and changes no rows',async()=>{
   const f=await fixture();const before=await snapshot(f.db);const result=await f.run();assert.equal(result.result,'PASS');assert.equal(result.admissionState,'DRAINING');
   assert.equal(result.configuration,'LEGACY');assert.equal(result.migrations.length,14);assert.equal(Object.keys(result.counts).length,21);
   assert.ok(Object.values(result.counts).every(n=>n===0));assert.match(result.schemaSha256,/^[a-f0-9]{64}$/);assert.deepEqual(await snapshot(f.db),before);
   console.info('PREFLIGHT_VERIFIED',JSON.stringify({database:f.name,migrations:result.migrations.length,businessTables:21,state:result.admissionState,configuration:result.configuration}));
  });
  await t.test('LEGACY_OPEN refuses first-deployment approval',async()=>{await reject(await fixture(false));});
  await t.test('WORKFLOW_OPEN refuses first-cutover preflight without changing completed configuration',async()=>{const f=await fixture();await f.operator.cutover();await reject(f);});
  for(const kind of ['active','revoked','expired'])await t.test(`${kind} Session history refuses without cleanup`,async()=>{const f=await fixture();await session(f.db,kind);await reject(f);});
  await t.test('Legacy Scenario and durable Step ledger refuse without deletion',async()=>{
   const f=await fixture();const sid=await session(f.db,'revoked');const company=(await f.db.query('SELECT company_code FROM demo_sessions WHERE id=$1',[sid])).rows[0].company_code;
   const scenario=(await f.db.query("INSERT INTO demo_scenario_instances(session_id,scenario_type) VALUES($1,'HAPPY_PATH') RETURNING id",[sid])).rows[0].id;
   await f.db.query('INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent) VALUES($1,1,$2,$3)',[scenario,randomUUID(),{domain:'CAPEX',companyCode:company,fiscalYear:2026,period:'Q4',expectedVersion:1,calculationTypeCode:'DEMO_GUIDED_SUMMARY'}]);await reject(f);
  });
  await t.test('unowned retained Series/Version/Job/Attempt/Snapshot graph refuses',async()=>{const f=await fixture();await graph(f.db);await reject(f);});
  for(const [label,sql]of [
   ['raw ingestion',"INSERT INTO raw_ingestion_series(id,domain,business_key) VALUES(gen_random_uuid(),'DPR_RAW','retained')"],
   ['DPR assets',"INSERT INTO assets(asset_id,asset_type) VALUES(1,'retained')"],
   ['partitioned raw rows',"INSERT INTO raw_dpr VALUES('2026-01-01','retained',1,1)"],
   ['historical type bridges','INSERT INTO orchestration_v2_legacy_calculation_type_bridges SELECT id FROM calculation_types LIMIT 1'],
  ])await t.test(`${label} also violates first-deployment emptiness`,async()=>{const f=await fixture();await f.db.query(sql!);await reject(f);});
  await t.test('complete configuration conflict refuses with unchanged data',async()=>{const f=await fixture();await f.db.query("UPDATE calculation_types SET airflow_dag_id='unexpected' WHERE domain='FAB_COST'");await reject(f);});
  await t.test('migration inventory mismatch refuses without repairing history',async()=>{const f=await fixture();await f.db.query('DELETE FROM pgmigrations WHERE id=(SELECT max(id) FROM pgmigrations)');await reject(f);});
  await t.test('unexpected even-empty public table refuses',async()=>{const f=await fixture();await f.db.query('CREATE TABLE unexpected_business_data(id integer)');await reject(f);});
  await t.test('unexpected business tables in another user schema also refuse',async()=>{const f=await fixture();await f.db.query('CREATE SCHEMA retained; CREATE TABLE retained.business_history(id integer)');await reject(f);});
  await t.test('a same-name view cannot masquerade as an expected empty table',async()=>{const f=await fixture();await f.db.query('DROP TABLE raw_ingestion_batches; CREATE VIEW raw_ingestion_batches AS SELECT 1 AS id WHERE false');await reject(f);});
  await t.test('missing critical FK refuses despite correct migration inventory',async()=>{const f=await fixture();await f.db.query('ALTER TABLE calculation_jobs DROP CONSTRAINT fk_calculation_jobs_calculation_type');await reject(f);});
  await t.test('disabled FK enforcement refuses even when the constraint remains validated',async()=>{const f=await fixture();await f.db.query('ALTER TABLE calculation_jobs DISABLE TRIGGER ALL');await reject(f);});
  await t.test('read-only behavior holds with DML-denying triggers on every application table',async()=>{
   const f=await fixture();await f.db.query("CREATE FUNCTION forbid_preflight_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Unexpected write'; END $$");
   for(const table of [...firstDeploymentBusinessTables.filter(n=>!n.startsWith('raw_dpr_')),'calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies','demo_admission_control','pgmigrations'])
    await f.db.query(`CREATE TRIGGER forbid_preflight_writes BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION forbid_preflight_writes()`);
   const before=await snapshot(f.db);assert.equal((await f.run()).result,'PASS');assert.deepEqual(await snapshot(f.db),before);
  });
  await t.test('explicit PostgreSQL barriers stabilize reads; PASS is only the checked instant',async()=>{
   const f=await fixture();const blocker=await f.db.connect();const writer=await f.db.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE assets IN ROW EXCLUSIVE MODE');
   const wait=async(pattern:string)=>{const deadline=Date.now()+2500;for(;;){const r=await admin.query("SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE $2",[f.name,pattern]);if(r.rows.some(r=>r.blockers.length))return;assert.ok(Date.now()<deadline,'Expected PostgreSQL lock barrier');await setImmediate();}};
   const checking=f.run();checking.catch(()=>{});let inserted:Promise<unknown>|undefined;
   try{
    await wait('LOCK TABLE orchestration%');
    inserted=writer.query("INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period) VALUES(gen_random_uuid(),'FAB_COST','LATER',2026,'Q4')");inserted.catch(()=>{});
    await wait('INSERT INTO dataset_series%');await blocker.query('ROLLBACK');assert.equal((await checking).result,'PASS');await inserted;
   }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release(true);writer.release(true);await Promise.allSettled([checking,...(inserted?[inserted]:[])]);}
   await reject(f);
  });
  await t.test('bounded lock wait fails closed and releases its transaction locks',async()=>{
   const f=await fixture();const blocker=await f.db.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM demo_admission_control FOR UPDATE');
   try{const started=Date.now();await assert.rejects(f.run(),{code:'DEMO_PREFLIGHT_REJECTED'});assert.ok(Date.now()-started>=2800);assert.ok(Date.now()-started<7000);}
   finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release(true);}assert.equal((await f.run()).result,'PASS');
  });
  await t.test('lost applied COMMIT acknowledgement confirms once on independent connection; no reapplication',async()=>{
   const f=await fixture();let calls=0;const op=new DemoCutoverOperator(f.db,{commit:async c=>{calls++;await c.query('COMMIT');throw new Error('lost ACK');}});
   assert.equal((await op.cutover()).confirmation,'DURABLE_RELOAD');assert.equal(calls,1);assert.equal((await op.status()).configuration,'WORKFLOW');
   assert.equal((await op.cutover()).outcome,'ALREADY_APPLIED');assert.equal(calls,2);await assert.rejects(f.run());
  });
  await t.test('NOT_APPLIED requires a fresh preflight and separately approved explicit retry',async()=>{
   const f=await fixture();let calls=0;const op=new DemoCutoverOperator(f.db,{commit:async c=>{calls++;await c.query('ROLLBACK');throw new Error('lost ACK');}});
   await assert.rejects(op.cutover(),{code:'DEMO_CUTOVER_NOT_APPLIED'});assert.equal(calls,1);assert.equal((await f.run()).result,'PASS');assert.equal(calls,1);
   assert.equal((await f.operator.cutover()).outcome,'APPLIED');
  });
  await t.test('UNKNOWN never retries or guesses; later durable status investigates the original outcome',async()=>{
   const f=await fixture();let calls=0;const op=new DemoCutoverOperator(f.db,{commit:async c=>{calls++;await c.query('COMMIT');throw new Error('lost ACK');},
    recoveryClient:()=>new Client({host:'127.0.0.1',port:1,user:'unavailable',database:'none',connectionTimeoutMillis:250})});
   await assert.rejects(op.cutover(),{code:'DEMO_CUTOVER_OUTCOME_UNKNOWN'});assert.equal(calls,1);
   assert.equal((await f.operator.status()).state,'WORKFLOW_OPEN');assert.equal(calls,1);await assert.rejects(f.run());
  });
  await t.test('database unavailable is a sanitized non-PASS result',async()=>{const db=new Pool({host:'127.0.0.1',port:1,user:'unavailable',database:'none',connectionTimeoutMillis:250});try{await assert.rejects(cutoverPreflight(db,'test'),{code:'DEMO_PREFLIGHT_REJECTED'});}finally{await db.end();}});
 }finally{
  for(const p of pools)await p.end();for(const name of names){assert.match(name,/^demo05d2_[a-f0-9]{32}$/);await admin.query(`DROP DATABASE "${name}"`);}await admin.end();
  for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);
  console.info('DEMO05D2_PG_TEARDOWN',JSON.stringify({databases:names.length,dropped:true}));
 }
});
