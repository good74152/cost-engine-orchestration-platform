import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import { DemoRuntime } from '../src/modules/demo-session/demo-runtime.js';
import { LOCAL_SESSION_COOKIE, type AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import type { StepOptions } from '../src/modules/demo-scenario/demo-step.service.js';
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';
import { readGuidedState, type StepResponse } from '../src/modules/demo-scenario/demo-step.repository.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import { seedDemoGuidedConfiguration } from './seed-demo-guided-configuration.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-02D requires a safe disposable PostgreSQL test service');
function connection(name: string) { const url=new URL(source!);url.pathname='/'+name;return url.toString(); }
function barrier() {let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}
class BlockingFake extends FakeExecutor {
  block=false;readonly entered=barrier();readonly finish=barrier();
  override async dispatch(command: DispatchCalculationCommand) {
    const result=await super.dispatch(command);if(this.block){this.entered.release();await this.finish.promise;}return result;
  }
}
interface Session {cookie:string;context:AuthenticatedDemoSession;id:string;requests:string[]}
type Response=Awaited<ReturnType<FastifyInstance['inject']>>;
function error(r:Response,status:number,code:string) {
  assert.equal(r.statusCode,status,r.body);assert.equal(r.json().code,code);assert.deepEqual(Object.keys(r.json()).sort(),['code','message']);
  assert.equal(r.headers['cache-control'],'no-store');assert.doesNotMatch(r.body,/token_hash|previousAttemptHistory|last_dispatch_error|SELECT |INSERT |constraint|postgresql:|division by zero/);
}

test('Demo-02D: bounded Failure Retry, immutable history, durable recovery and isolation',{timeout:300_000},async t=>{
  const name=`demo_02d_test_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;assert.match(name,/^demo_02d_test_[a-z0-9_]+$/);assert.ok(name.length<=63);
  const admin=new Client({connectionString:connection('postgres')});await admin.connect();
  const previous={DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:process.env.NODE_ENV,APP_MODE:process.env.APP_MODE,EXECUTOR_TYPE:process.env.EXECUTOR_TYPE};
  const apps:FastifyInstance[]=[];const ends:Promise<void>[]=[];let db:Pool|undefined;let created=false;
  try{
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
    const migrate=(direction:'up'|'down',count?:number)=>runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../migrations/',import.meta.url)),
      migrationsTable:'pgmigrations',direction,count,singleTransaction:true,checkOrder:true,logger:{debug(){},info(){},warn(){},error(){}}});
    await migrate('up',9);
    process.env.DATABASE_URL=connection(name);process.env.NODE_ENV='test';process.env.APP_MODE='demo';process.env.EXECUTOR_TYPE='fake';
    const [{pool},{buildApp}]=await Promise.all([import('../src/db/pool.js'),import('../src/app.js')]);db=pool;
    pool.on('connect',c=>ends.push(new Promise<void>(done=>c.once('end',done))));
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
    const hooks:StepOptions={};const resetHooks:ResetOptions={log(){}};const assigned:FakeExecutor[]=[];
    const runtime=new DemoRuntime(pool,'test',{createExecutor:()=>assigned.shift()??new FakeExecutor()},resetHooks,{},hooks);
    const app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false,demoSession:{origin:'https://demo.test'}});apps.push(app);
    const post=(url:string,s?:Session,payload:unknown={})=>app.inject({method:'POST',url,payload:JSON.stringify(payload),headers:{
      'content-type':'application/json','x-demo-session':'1',origin:'https://demo.test',...(s?{cookie:s.cookie}:{})}});
    const get=(url:string,s:Session)=>app.inject({method:'GET',url,headers:{cookie:s.cookie}});
    const create=(s:Session,type='FAILURE_RETRY')=>post('/demo/scenarios',s,{scenarioType:type});
    const newSession=async(type:string|null='FAILURE_RETRY'):Promise<Session>=>{
      const r=await post('/demo/sessions');assert.equal(r.statusCode,201,r.body);const cookie=String(r.headers['set-cookie']).split(';',1)[0]!;
      const s={cookie,context:await runtime.sessions.authenticate(cookie,LOCAL_SESSION_COOKIE),id:'',requests:Array.from({length:9},()=>randomUUID())};
      if(type){const sc=await create(s,type);assert.equal(sc.statusCode,201,sc.body);s.id=sc.json().scenarioId;}return s;
    };
    const next=(s:Session,n:number,id=s.requests[n-1]??randomUUID())=>post(`/demo/scenarios/${s.id}/next`,s,{expectedStep:n,requestId:id});
    const through=async(s:Session,n:number,start=1)=>{for(let step=start;step<=n;step++){const r=await next(s,step);assert.equal(r.statusCode,200,r.body);}};
    const state=(s:Session)=>readGuidedState(pool,s.context);
    const ledgers=async(s:Session)=>(await pool.query('SELECT to_jsonb(l) AS item FROM demo_scenario_step_executions l WHERE scenario_id=$1 ORDER BY step_number',[s.id])).rows.map(r=>r.item);
    const progress=async(s:Session)=>(await pool.query('SELECT status,completed_step FROM demo_scenario_instances WHERE id=$1',[s.id])).rows[0];
    const dump=async()=>{
      const result:Record<string,unknown>={};
      for(const table of ['pgmigrations','demo_scenario_instances','demo_scenario_step_executions','dataset_series','dataset_versions','calculation_jobs','execution_attempts','dataset_build_snapshots','dataset_build_snapshot_dependencies','calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies'])
        result[table]=(await pool.query(`SELECT to_jsonb(r) AS item FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
      result.sessions=(await pool.query('SELECT id,company_code,created_at,expires_at,revoked_at FROM demo_sessions ORDER BY id')).rows;return result;
    };
    await seedDemoGuidedConfiguration(pool);
    await t.test('forward migration preserves populated Happy Path; down restores EXACT applied validator and data; forward again',async()=>{
      const old=(await pool.query("SELECT pg_get_functiondef('validate_demo_step_binding()'::regprocedure) AS body")).rows[0].body;
      const happy=await newSession('HAPPY_PATH');await through(happy,6);const before=await dump();
      await migrate('up',1);const after=await dump();assert.deepEqual({...after,pgmigrations:before.pgmigrations},before);
      await migrate('down',1);assert.deepEqual(await dump(),before);
      assert.equal((await pool.query("SELECT pg_get_functiondef('validate_demo_step_binding()'::regprocedure) AS body")).rows[0].body,old);
      const untouched=(await ledgers(happy))[0];
      await assert.rejects(pool.query('UPDATE demo_scenario_step_executions SET created_at=now() WHERE id=$1',[untouched.id]));
      // A pre-02D non-Happy ledger is not silently reinterpreted as the new flow.
      const legacy=await newSession(null);await pool.query("INSERT INTO demo_scenario_instances(id,session_id,scenario_type) VALUES($1,$2,'FAILURE_RETRY')",[legacy.id=randomUUID(),legacy.context.sessionId]);
      await pool.query(`INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent) VALUES($1,1,$2,$3)`,[legacy.id,legacy.requests[0],
        {domain:'CAPEX',companyCode:legacy.context.companyCode,fiscalYear:2026,period:'Q4',expectedVersion:1,calculationTypeCode:'DEMO_GUIDED_SUMMARY'}]);
      const guard=await dump();await assert.rejects(migrate('up',1),/Cannot reinterpret/);assert.deepEqual(await dump(),guard);
      await pool.query('DELETE FROM demo_scenario_step_executions WHERE scenario_id=$1',[legacy.id]);await pool.query('DELETE FROM demo_scenario_instances WHERE id=$1',[legacy.id]);
      await migrate('up');assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,11);
    });
    console.log('DEMO_02D_RUNTIME',JSON.stringify({node:process.version,postgres:(await pool.query('SHOW server_version')).rows[0].server_version,database:name,migrations:11}));
    await t.test('Create supports Happy/Failure, same-type retry and cross-type conflict; one Scenario per session',async()=>{
      const s=await newSession();const original=(await get('/demo/scenarios/current',s)).json();const before=await dump();
      assert.deepEqual((await create(s)).json(),original);assert.equal((await create(s)).statusCode,200);
      error(await create(s,'HAPPY_PATH'),409,'DEMO_SCENARIO_TYPE_CONFLICT');error(await create(s,'UNKNOWN'),400,'INVALID_REQUEST');
      assert.deepEqual(await dump(),before);assert.deepEqual(await progress(s),{status:'READY',completed_step:0});
      await assert.rejects(pool.query("INSERT INTO demo_scenario_instances(session_id,scenario_type) VALUES($1,'HAPPY_PATH')",[s.context.sessionId]),e=>(e as {code:string}).code==='23505');
      const simultaneous=await newSession(null);const results=await Promise.all(Array.from({length:20},()=>create(simultaneous)));
      assert.equal(results.filter(r=>r.statusCode===201).length,1);assert.equal(results.filter(r=>r.statusCode===200).length,19);assert.equal(new Set(results.map(r=>r.json().scenarioId)).size,1);
    });
    const completed=await newSession();const responses:StepResponse[]=[];let failedHistory:Record<string,unknown>|undefined;
    await t.test('A/B: full nine-step flow, same dataset/job/snapshot/definition, distinct attempts/runs and immutable failed history',async()=>{
      for(let n=1;n<=9;n++){
        const r=await next(completed,n);assert.equal(r.statusCode,200,r.body);const dto=r.json<StepResponse>();responses.push(dto);
        assert.equal(dto.completedStep,n);assert.equal(dto.scenarioStatus,n===9?'COMPLETED':'IN_PROGRESS');assert.equal(dto.stepStatus,'COMPLETED');
        const d=(await state(completed))!;assert.equal(d.counter,1);assert.equal(d.versions.length,1);assert.equal(d.versions[0]!.version,1);assert.equal(d.jobs.length,1);
        assert.equal(d.versions[0]!.status,n===1?'DRAFT':n===8?'VALIDATING':n===9?'PUBLISHED':'BUILDING');
        assert.equal(d.jobs[0]!.status,n===1?'PENDING':n===4?'FAILED':n>=7?'SUCCEEDED':'RUNNING');
        assert.equal(d.attempts.length,n===1?0:n<5?1:2);
        if(n>1)assert.equal(dto.stepResult.attemptNumber,n<5?1:2);
        if(n===3||n===6){const fake=await runtime.executors.forSession(completed.context);assert.equal(fake.getExternalExecutions().find(e=>e.command.attemptNumber===(n===3?1:2))!.state,n===3?'FAILED':'SUCCEEDED');assert.equal(d.jobs[0]!.status,'RUNNING');}
        if(n===4){failedHistory=d.attempts[0]!.history;assert.deepEqual(await progress(completed),{status:'IN_PROGRESS',completed_step:4});}
        if(n>=5){const first=d.attempts.find(a=>a.number===1)!;const second=d.attempts.find(a=>a.number===2)!;
          assert.deepEqual(first.history,failedHistory);assert.equal(first.status,'FAILED');assert.notEqual(first.id,second.id);assert.notEqual(first.run,second.run);
          assert.equal(second.status,n<7?'ACCEPTED':'SUCCEEDED');}
        assert.doesNotMatch(r.body,/previousAttemptHistory|last_dispatch_error|airflowDag|companyCode|token_hash|command/);
      }
      const fake=await runtime.executors.forSession(completed.context);const commands=fake.getDispatchHistory();assert.equal(commands.length,2);assert.equal(fake.getExternalExecutions().length,2);
      for(const key of ['jobId','datasetVersionId','datasetBuildSnapshotId','resolvedDependencyDefinitionVersionId'] as const)assert.equal(commands[0]![key],commands[1]![key]);
      assert.equal((await ledgers(completed)).filter(l=>l.status==='COMPLETED').length,9);
      const intent=(await ledgers(completed))[4].intent;assert.equal(intent.previousAttemptStatus,'FAILED');assert.equal(intent.expectedAttemptNumber,2);assert.equal(intent.executionAttemptId,undefined);assert.deepEqual(intent.previousAttemptHistory,failedHistory);
    });
    await t.test('old result replay, wrong order/different ID/request reuse, and completed step 10 rejection never repeat work',async()=>{
      const before=await dump();const fake=await runtime.executors.forSession(completed.context);const lookups=fake.getStatusLookupHistory().length;
      for(let n=1;n<=9;n++){const r=await next(completed,n);assert.deepEqual(r.json(),responses[n-1]);error(await next(completed,n,randomUUID()),409,'DEMO_SCENARIO_STEP_CONFLICT');}
      error(await next(completed,10),400,'INVALID_REQUEST');assert.deepEqual(await dump(),before);assert.equal(fake.getDispatchHistory().length,2);assert.equal(fake.getStatusLookupHistory().length,lookups);
      const s=await newSession();error(await next(s,5),409,'DEMO_SCENARIO_STEP_CONFLICT');await through(s,4);error(await next(s,6),409,'DEMO_SCENARIO_STEP_CONFLICT');error(await next(s,5,s.requests[3]),409,'DEMO_SCENARIO_STEP_CONFLICT');
    });
    for(const n of [3,4,5,6,7,8,9])await t.test(`C/F-I: step ${n} recovers real Transaction B failure without new work or rewriting attempt 1`,async()=>{
      const s=await newSession();await through(s,n-1);hooks.beforeCommit=async(phase,c)=>{if(phase==='B')await c.query('SELECT 1/0');};
      try{error(await next(s,n),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeCommit;}
      assert.equal((await progress(s)).completed_step,n-1);assert.equal((await ledgers(s))[n-1].status,'PENDING');assert.equal((await ledgers(s))[n-1].result,null);
      const before=await state(s);const fake=await runtime.executors.forSession(s.context);const dispatches=fake.getDispatchHistory().length;const lookups=fake.getStatusLookupHistory().length;
      const r=await next(s,n);assert.equal(r.statusCode,200,r.body);assert.deepEqual(await state(s),before);assert.equal(fake.getDispatchHistory().length,dispatches);
      if(n===4||n===7)assert.equal(fake.getStatusLookupHistory().length,lookups);
      assert.ok((await state(s))!.attempts.length<=2);if(n===9)assert.deepEqual(await progress(s),{status:'COMPLETED',completed_step:9});
    });
    await t.test('D: ambiguous Retry preserves FAILED job and PENDING ledger, pending read, SAME attempt 2 recovery and no attempt 3',async()=>{
      const s=await newSession();await through(s,4);const first=(await state(s))!.attempts[0]!.history;const fake=await runtime.executors.forSession(s.context);fake.enqueueBehaviors('ACCEPT_THEN_UNKNOWN');
      const r=await next(s,5);assert.equal(r.statusCode,202,r.body);assert.equal(r.json().stepResult.attemptNumber,2);assert.equal(r.json().stepResult.attemptStatus,'DISPATCHING');assert.equal(r.json().stepResult.jobStatus,'FAILED');
      assert.equal((await progress(s)).completed_step,4);assert.deepEqual((await get(`/demo/scenarios/${s.id}/pending-step`,s)).json(),{pendingStep:{stepNumber:5,requestId:s.requests[4]}});
      error(await next(s,6),409,'DEMO_SCENARIO_STEP_CONFLICT');error(await next(s,5,randomUUID()),409,'DEMO_SCENARIO_STEP_CONFLICT');
      const recovered=await next(s,5);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().stepResult.executionAttemptId,r.json().stepResult.executionAttemptId);
      const commands=fake.getDispatchHistory();assert.equal(commands.length,3);assert.equal(commands[1]!.airflowDagRunId,commands[2]!.airflowDagRunId);assert.equal(fake.getExternalExecutions().length,2);
      assert.deepEqual((await state(s))!.attempts.find(a=>a.number===1)!.history,first);await through(s,9,6);assert.equal((await state(s))!.attempts.length,2);
    });
    await t.test('E: definite Retry rejection remains diagnostic PENDING/FAILED; repeated Next never dispatches/allocates attempt 3',async()=>{
      const s=await newSession();await through(s,4);const fake=await runtime.executors.forSession(s.context);fake.enqueueBehaviors('REJECT');
      for(let i=0;i<3;i++)error(await next(s,5),409,'DEMO_SCENARIO_STATE_CONFLICT');
      const d=(await state(s))!;assert.equal(d.attempts.length,2);assert.equal(d.attempts.find(a=>a.number===2)!.status,'DISPATCH_FAILED');assert.equal(d.jobs[0]!.status,'FAILED');assert.equal(fake.getDispatchHistory().length,2);
      assert.equal((await ledgers(s))[4].status,'PENDING');assert.equal((await progress(s)).completed_step,4);error(await next(s,6),409,'DEMO_SCENARIO_STEP_CONFLICT');
    });
    await t.test('Retry waits out an unsettled Attempt 2 rejection before deciding whether Run can be called',async()=>{
      const s=await newSession();await through(s,4);const fake=await runtime.executors.forSession(s.context);fake.enqueueBehaviors('UNKNOWN_WITHOUT_CREATION');
      assert.equal((await next(s,5)).statusCode,202);const d=(await state(s))!;const retry=d.attempts.find(a=>a.number===2)!;const history=fake.getDispatchHistory().length;
      const writer=new Client({connectionString:connection(name)});await writer.connect();await writer.query('BEGIN');
      await writer.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE',[d.jobs[0]!.id]);
      await writer.query("UPDATE execution_attempts SET status='DISPATCH_FAILED',finished_at=now() WHERE id=$1",[retry.id]);
      const recovery=Promise.resolve(next(s,5));let waiting=false;
      try{const deadline=Date.now()+5000;while(Date.now()<deadline){const rows=await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1
          AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM calculation_jobs WHERE id=%'`,[name]);if(rows.rowCount){waiting=true;break;}await setImmediate();}
        assert.ok(waiting,'must inspect settled, not pre-commit attempt history');await writer.query('COMMIT');error(await recovery,409,'DEMO_SCENARIO_STATE_CONFLICT');
        assert.equal((await state(s))!.attempts.length,2);assert.equal(fake.getDispatchHistory().length,history);
      }finally{await writer.query('ROLLBACK').catch(()=>{});await writer.end();await recovery;}
    });
    await t.test('Retry A/B acknowledgement loss confirms durable history; rollback/unavailable confirmation never creates another attempt',async()=>{
      for(const phase of ['A','B'] as const)for(const action of ['COMMIT','ROLLBACK','UNAVAILABLE'] as const){
        const s=await newSession();await through(s,4);let injected=false;
        hooks.commit=async(p,c)=>{await c.query(p===phase&&action==='ROLLBACK'?'ROLLBACK':'COMMIT');if(p===phase&&!injected){injected=true;throw new Error('lost acknowledgement');}};
        if(action==='UNAVAILABLE')hooks.recoveryClient=()=>{const url=new URL(connection(name));url.port='1';return new Client({connectionString:url.toString(),connectionTimeoutMillis:100});};
        let r:Response;try{r=await next(s,5);}finally{delete hooks.commit;delete hooks.recoveryClient;}
        if(action==='COMMIT')assert.equal(r.statusCode,200,r.body);else error(r,503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');
        const current=await next(s,5);assert.equal(current.statusCode,200,current.body);const fake=await runtime.executors.forSession(s.context);
        assert.equal((await state(s))!.attempts.length,2);assert.equal(fake.getDispatchHistory().length,2);assert.equal(fake.getExternalExecutions().length,2);
      }
    });
    await t.test('M: database enforces type-specific ranges and bindings, unique keys, immutable ledger/Scenario and retry history',async()=>{
      const s=await newSession();await through(s,5);const happy=await newSession('HAPPY_PATH');await through(happy,6);
      const another=await newSession();await through(another,5);const l=(await ledgers(s))[4];const nextIntent={...(await ledgers(s))[4].intent,
        executionAttemptId:(await state(s))!.attempts.find(a=>a.number===2)!.id,airflowDagId:'demo_capex_guided',airflowDagRunId:(await state(s))!.attempts.find(a=>a.number===2)!.run};
      const insert=(id:string,n:number,intent:unknown)=>pool.query(`INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent) VALUES($1,$2,$3,$4)`,[id,n,randomUUID(),intent]);
      for(const n of [7,8,9])await assert.rejects(insert(happy.id,n,nextIntent),e=>(e as {code:string}).code==='23514');
      await assert.rejects(insert(s.id,10,nextIntent));await assert.rejects(insert(s.id,6,{...nextIntent,executionAttemptId:l.intent.previousExecutionAttemptId}));
      await assert.rejects(insert(another.id,6,nextIntent));await assert.rejects(insert(s.id,6,{...nextIntent,datasetBuildSnapshotId:randomUUID()}));
      await assert.rejects(insert(s.id,6,{...nextIntent,previousAttemptHistory:{}}));
      await assert.rejects(pool.query('UPDATE demo_scenario_step_executions SET result=$2 WHERE id=$1',[l.id,{}]));
      await assert.rejects(pool.query("UPDATE demo_scenario_instances SET scenario_type='HAPPY_PATH' WHERE id=$1",[s.id]));
      await assert.rejects(pool.query('UPDATE demo_scenario_instances SET session_id=$2 WHERE id=$1',[s.id,another.context.sessionId]));
      const pending=await newSession();await through(pending,4);hooks.beforeDomain=async()=>{throw new Error('injected after A');};
      try{error(await next(pending,5),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeDomain;}
      const before=(await ledgers(pending))[4];const first=(await state(pending))!.attempts[0]!;
      await pool.query("UPDATE execution_attempts SET last_dispatch_error='corrupt fixture' WHERE id=$1",[first.id]);
      try{error(await next(pending,5),409,'DEMO_SCENARIO_STATE_CONFLICT');assert.equal((await state(pending))!.attempts.length,1);
        await assert.rejects(pool.query(`UPDATE demo_scenario_step_executions SET status='COMPLETED',completed_at=now(),result=$2 WHERE id=$1`,[before.id,l.result]));}
      finally{await pool.query('UPDATE execution_attempts SET last_dispatch_error=$2 WHERE id=$1',[first.id,first.history.last_dispatch_error]);}
      assert.equal((await next(pending,5)).statusCode,200);
      const dumpBefore=await dump();await assert.rejects(migrate('down',2),/retained Failure Retry scenarios/);assert.deepEqual(await dump(),dumpBefore);
    });
    for(const unknown of [false,true])await t.test(`J: concurrent Retry same/different requests and next-step order (${unknown?'UNKNOWN':'ACCEPTED'}), locks released during dispatch`,async()=>{
      const s=await newSession();await through(s,1);const fake=new BlockingFake();assigned.push(fake);await through(s,4,2);fake.block=true;
      if(unknown)fake.setDefaultBehavior('UNKNOWN_WITHOUT_CREATION');const first=Promise.resolve(next(s,5));await fake.entered.promise;
      try{
        const probe=new Client({connectionString:connection(name)});await probe.connect();try{await probe.query('BEGIN');
          await probe.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE NOWAIT',[s.context.sessionId]);await probe.query('SELECT id FROM demo_scenario_instances WHERE id=$1 FOR UPDATE NOWAIT',[s.id]);
          await probe.query('SELECT id FROM demo_scenario_step_executions WHERE scenario_id=$1 FOR UPDATE NOWAIT',[s.id]);const d=(await state(s))!;
          await probe.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE NOWAIT',[d.jobs[0]!.id]);await probe.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 ORDER BY attempt_number FOR UPDATE NOWAIT',[d.jobs[0]!.id]);await probe.query('ROLLBACK');
        }finally{await probe.end();}
        error(await post('/demo/sessions/reset',s),409,'RESET_CONFLICT');const same=Promise.resolve(next(s,5));const different=Promise.resolve(next(s,5,randomUUID()));const wrong=Promise.resolve(next(s,unknown?6:7));fake.finish.release();
        const results=await Promise.all([first,same,different,wrong]);assert.equal(results[0]!.statusCode,unknown?202:200);assert.equal(results[1]!.statusCode,unknown?202:200);
        if(!unknown)assert.deepEqual(results[1]!.json(),results[0]!.json());error(results[2]!,409,'DEMO_SCENARIO_STEP_CONFLICT');error(results[3]!,409,'DEMO_SCENARIO_STEP_CONFLICT');
        fake.setDefaultBehavior('ACCEPT');assert.equal((await next(s,5)).statusCode,200);assert.equal((await state(s))!.attempts.length,2);assert.equal(fake.getExternalExecutions().length,2);
      }finally{fake.finish.release();await first;}
    });
    await t.test('K: two Failure Retry owners progress independently, isolated fakes and generic foreign resource failures',async()=>{
      const a=await newSession();const b=await newSession();await through(a,1);const fake=new BlockingFake();assigned.push(fake);await through(a,4,2);await through(b,4);
      fake.block=true;const running=Promise.resolve(next(a,5));await fake.entered.promise;
      try{await through(b,9,5);assert.equal((await progress(b)).completed_step,9);assert.notEqual(await runtime.executors.forSession(b.context),fake);}
      finally{fake.finish.release();assert.equal((await running).statusCode,200);}
      const prior=await dump();error(await post(`/demo/scenarios/${b.id}/next`,a,{expectedStep:5,requestId:b.requests[4]}),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await get(`/demo/scenarios/${b.id}/pending-step`,a),404,'DEMO_RESOURCE_UNAVAILABLE');const owned=(await state(b))!;
      error(await get(`/demo/calculation-jobs/${owned.jobs[0]!.id}`,a),404,'DEMO_RESOURCE_UNAVAILABLE');assert.deepEqual(await dump(),prior);
    });
    await t.test('L: Reset atomically deletes both attempts/ledger/Scenario/graph; real late SQL failure restores ALL; other owner unchanged',async()=>{
      const s=await newSession();await through(s,6);const other=await newSession();await through(other,7);const otherState=await state(other);const otherLedgers=await ledgers(other);
      const before=await dump();const fake=await runtime.executors.forSession(s.context);
      await pool.query(`CREATE FUNCTION fixture_02d_reset_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
        CREATE TRIGGER fixture_02d_reset_fail BEFORE DELETE ON dataset_series FOR EACH ROW EXECUTE FUNCTION fixture_02d_reset_fail()`);
      try{error(await post('/demo/sessions/reset',s),500,'DEMO_RESET_FAILED');assert.deepEqual(await dump(),before);assert.equal(await runtime.executors.forSession(s.context),fake);}
      finally{await pool.query('DROP TRIGGER fixture_02d_reset_fail ON dataset_series; DROP FUNCTION fixture_02d_reset_fail()');}
      assert.equal((await post('/demo/sessions/reset',s)).statusCode,204);assert.equal(await state(s),null);assert.equal(await progress(s),undefined);assert.equal((await ledgers(s)).length,0);assert.ok(!runtime.executors.sessionIds().includes(s.context.sessionId));
      assert.deepEqual(await state(other),otherState);assert.deepEqual(await ledgers(other),otherLedgers);
    });
    await t.test('L: Reset acknowledgement loss resolves commit/rollback; unavailable truth blocks admission and retains fake until confirmation',async()=>{
      for(const commit of [true,false]){const s=await newSession();await through(s,5);const before=await dump();const fake=await runtime.executors.forSession(s.context);
        resetHooks.commit=async c=>{await c.query(commit?'COMMIT':'ROLLBACK');throw new Error('lost acknowledgement');};
        try{const r=await post('/demo/sessions/reset',s);if(commit){assert.equal(r.statusCode,204,r.body);assert.equal(await state(s),null);}else{error(r,500,'DEMO_RESET_FAILED');assert.deepEqual(await dump(),before);assert.equal(await runtime.executors.forSession(s.context),fake);}}
        finally{delete resetHooks.commit;}
      }
      const s=await newSession();await through(s,5);resetHooks.commit=async c=>{await c.query('ROLLBACK');throw new Error('lost acknowledgement');};
      resetHooks.recoveryClient=()=>{const url=new URL(connection(name));url.port='1';return new Client({connectionString:url.toString(),connectionTimeoutMillis:100});};
      try{error(await post('/demo/sessions/reset',s),503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await next(s,6),503,'DEMO_RESET_OUTCOME_UNKNOWN');assert.ok(runtime.executors.sessionIds().includes(s.context.sessionId));assert.equal((await state(s))!.attempts.length,2);}
      finally{delete resetHooks.commit;delete resetHooks.recoveryClient;}
      assert.equal(await runtime.reset.recoverPendingResets(),0);assert.equal((await next(s,6)).statusCode,200);
    });
    await t.test('O: exact input/auth/CSRF/ownership/expiration contracts remain protected; no manual/fake control bypass',async()=>{
      const s=await newSession();const before=await dump();
      error(await post(`/demo/scenarios/${s.id}/next`,undefined,{expectedStep:1,requestId:s.requests[0]}),401,'DEMO_SESSION_UNAVAILABLE');
      for(const payload of [{expectedStep:1,requestId:'bad'},{expectedStep:5,requestId:randomUUID(),jobId:randomUUID()},{expectedStep:1,requestId:randomUUID(),attemptNumber:2}])error(await post(`/demo/scenarios/${s.id}/next`,s,payload),400,'INVALID_REQUEST');
      error(await app.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,headers:{cookie:s.cookie},payload:{expectedStep:1,requestId:s.requests[0]}}),403,'DEMO_SESSION_CSRF_REJECTED');
      error(await app.inject({method:'GET',url:`/demo/scenarios/${s.id}/pending-step`,headers:{cookie:s.cookie,origin:'https://foreign.test'}}),403,'DEMO_SESSION_CSRF_REJECTED');
      error(await post('/demo/fake-executor/dispatch-behavior',s,{behavior:'REJECT'}),409,'DEMO_SCENARIO_MODE_CONFLICT');assert.deepEqual(await dump(),before);
      await pool.query("UPDATE demo_sessions SET created_at=clock_timestamp()-interval '5 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[s.context.sessionId]);
      const expired=await next(s,1);error(expired,401,'DEMO_SESSION_UNAVAILABLE');assert.match(String(expired.headers['set-cookie']),/Max-Age=0/);assert.equal((await ledgers(s)).length,0);
    });
    await t.test('queued Retry revalidates expiration at admission and cannot reserve/create Attempt 2 after expiry',async()=>{
      const s=await newSession();await through(s,4);const entered=barrier();const finish=barrier();const admitted=barrier();
      const run=runtime.coordinator.run.bind(runtime.coordinator);const original=runtime.coordinator.run;
      const first=run(s.context,async()=>{entered.release();await finish.promise;});await entered.promise;
      runtime.coordinator.run=(session,body)=>{const operation=run(session,body);if(session.sessionId===s.context.sessionId)admitted.release();return operation;};
      const retry=Promise.resolve(next(s,5));
      try{await admitted.promise;await pool.query("UPDATE demo_sessions SET created_at=clock_timestamp()-interval '5 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[s.context.sessionId]);
        finish.release();await first;error(await retry,401,'DEMO_SESSION_UNAVAILABLE');assert.equal((await state(s))!.attempts.length,1);assert.equal((await ledgers(s)).length,4);
      }finally{runtime.coordinator.run=original;finish.release();await Promise.all([first,retry]);}
    });
    await t.test('O: restart invalidates Failure Retry cookies and never recreates fake executions or grants a new owner old requests',async()=>{
      const s=await newSession();await through(s,5);const fresh=new DemoRuntime(pool,'test',{}, {log(){}});
      const maintenance=fresh.reset.maintainInactiveSessions.bind(fresh.reset);fresh.reset.maintainInactiveSessions=async()=>{throw new Error('hold cleanup');};await fresh.reset.startServer();
      const restarted=await buildApp({appMode:'demo',demoRuntime:fresh,logger:false,nodeEnvironment:'test'});apps.push(restarted);
      error(await restarted.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,headers:{cookie:s.cookie,'x-demo-session':'1'},payload:{expectedStep:5,requestId:s.requests[4]}}),401,'DEMO_SESSION_UNAVAILABLE');
      const newCookie=await restarted.inject({method:'POST',url:'/demo/sessions',headers:{'x-demo-session':'1'},payload:{}});assert.equal(newCookie.statusCode,201);
      error(await restarted.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,headers:{cookie:String(newCookie.headers['set-cookie']).split(';',1)[0]!,'x-demo-session':'1'},payload:{expectedStep:5,requestId:s.requests[4]}}),404,'DEMO_RESOURCE_UNAVAILABLE');
      assert.equal(fresh.executors.size,0);fresh.reset.maintainInactiveSessions=maintenance;await maintenance(1000);assert.equal((await ledgers(s)).length,0);assert.equal(await state(s),null);assert.equal(fresh.executors.size,0);
    });
  }finally{
    try{await Promise.all(apps.map(a=>a.close()));if(db){await db.end();await Promise.all(ends);}}
    finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      try{if(created){const deadline=Date.now()+5000;let sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
        while(sessions.rowCount&&Date.now()<deadline){await setImmediate();sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}assert.equal(sessions.rowCount,0);
        assert.match(name,/^demo_02d_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);console.log('DEMO_02D_TEARDOWN',JSON.stringify({database:name,sessions:0,dropped:true,forced:false}));
      }}finally{await admin.end();}
    }
  }
});
