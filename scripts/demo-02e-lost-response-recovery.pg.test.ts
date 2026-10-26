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
import { LostAcknowledgementExecutor } from '../src/modules/demo-scenario/lost-acknowledgement-executor.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import { seedDemoGuidedConfiguration } from './seed-demo-guided-configuration.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-02E requires a safe disposable PostgreSQL test service');
function connection(name: string) { const url=new URL(source!);url.pathname='/'+name;return url.toString(); }
function barrier() {let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}
const fakeState=(fake:FakeExecutor)=>JSON.stringify(fake,(_key,value:unknown)=>
  value instanceof Map?[...value]:value instanceof Set?[...value]:value);
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

test('Demo-02E: Lost Response recovery, durable identity and isolation',{timeout:300_000},async t=>{
  const name=`demo_02e_test_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;assert.match(name,/^demo_02e_test_[a-z0-9_]+$/);assert.ok(name.length<=63);
  const admin=new Client({connectionString:connection('postgres')});await admin.connect();
  const previous={DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:process.env.NODE_ENV,APP_MODE:process.env.APP_MODE,EXECUTOR_TYPE:process.env.EXECUTOR_TYPE};
  const apps:FastifyInstance[]=[];const ends:Promise<void>[]=[];let db:Pool|undefined;let created=false;
  try{
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
    const migrate=(direction:'up'|'down',count?:number)=>runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../migrations/',import.meta.url)),
      migrationsTable:'pgmigrations',direction,count,singleTransaction:true,checkOrder:true,logger:{debug(){},info(){},warn(){},error(){}}});
    await migrate('up',10);
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
    const create=(s:Session,type='LOST_RESPONSE_RECOVERY')=>post('/demo/scenarios',s,{scenarioType:type});
    const newSession=async(type:string|null='LOST_RESPONSE_RECOVERY'):Promise<Session>=>{
      const r=await post('/demo/sessions');assert.equal(r.statusCode,201,r.body);const cookie=String(r.headers['set-cookie']).split(';',1)[0]!;
      const s={cookie,context:await runtime.sessions.authenticate(cookie,LOCAL_SESSION_COOKIE),id:'',requests:Array.from({length:9},()=>randomUUID())};
      if(type){const sc=await create(s,type);assert.equal(sc.statusCode,201,sc.body);s.id=sc.json().scenarioId;}return s;
    };
    const next=(s:Session,n:number,id=s.requests[n-1]??randomUUID())=>post(`/demo/scenarios/${s.id}/next`,s,{expectedStep:n,requestId:id});
    const through=async(s:Session,n:number,start=1)=>{for(let step=start;step<=n;step++){let r=await next(s,step);if(r.statusCode===202)r=await next(s,step);assert.equal(r.statusCode,200,r.body);}};
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

    await t.test('migration preserves populated Happy/Failure histories, exact down/up, and refuses pre-02E ledger reinterpretation',async()=>{
      const old=(await pool.query("SELECT pg_get_functiondef('validate_demo_step_binding()'::regprocedure) AS body")).rows[0].body;
      for(const type of ['HAPPY_PATH','FAILURE_RETRY']){const s=await newSession(type);await through(s,type==='HAPPY_PATH'?6:9);}
      const before=await dump();await migrate('up');const after=await dump();assert.deepEqual({...after,pgmigrations:before.pgmigrations},before);
      await migrate('down',1);assert.deepEqual(await dump(),before);
      assert.equal((await pool.query("SELECT pg_get_functiondef('validate_demo_step_binding()'::regprocedure) AS body")).rows[0].body,old);
      const legacy=await newSession(null);
      await pool.query("INSERT INTO demo_scenario_instances(id,session_id,scenario_type) VALUES($1,$2,'LOST_RESPONSE_RECOVERY')",[legacy.id=randomUUID(),legacy.context.sessionId]);
      // The old validator forbids E; a fixture deliberately represents incompatible pre-migration history.
      await pool.query('ALTER TABLE demo_scenario_step_executions DISABLE TRIGGER demo_step_binding');
      try{await pool.query('INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent) VALUES($1,1,$2,$3)',[legacy.id,legacy.requests[0],
        {domain:'CAPEX',companyCode:legacy.context.companyCode,fiscalYear:2026,period:'Q4',expectedVersion:1,calculationTypeCode:'DEMO_GUIDED_SUMMARY'}]);}
      finally{await pool.query('ALTER TABLE demo_scenario_step_executions ENABLE TRIGGER demo_step_binding');}
      const guard=await dump();await assert.rejects(migrate('up'),/Cannot reinterpret pre-02E/);assert.deepEqual(await dump(),guard);
      await pool.query('DELETE FROM demo_scenario_step_executions WHERE scenario_id=$1',[legacy.id]);await pool.query('DELETE FROM demo_scenario_instances WHERE id=$1',[legacy.id]);
      await migrate('up');assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,11);
      const ready=await newSession();const retained=await dump();
      await assert.rejects(migrate('down',1),/retained Lost Response Recovery scenarios/);assert.deepEqual(await dump(),retained);
      assert.equal((await post('/demo/sessions/reset',ready)).statusCode,204);
    });
    console.log('DEMO_02E_RUNTIME',JSON.stringify({node:process.version,postgres:(await pool.query('SHOW server_version')).rows[0].server_version,database:name,migrations:11}));
    await t.test('Create supports all three types, same-type replay, cross-type conflict, and concurrent Create uniqueness',async()=>{
      const s=await newSession();const original=(await get('/demo/scenarios/current',s)).json();const before=await dump();
      const again=await create(s);assert.equal(again.statusCode,200);assert.deepEqual(again.json(),original);
      for(const type of ['HAPPY_PATH','FAILURE_RETRY'])error(await create(s,type),409,'DEMO_SCENARIO_TYPE_CONFLICT');
      error(await create(s,'UNKNOWN'),400,'INVALID_REQUEST');assert.deepEqual(await dump(),before);
      const concurrent=await newSession(null);const results=await Promise.all(Array.from({length:20},()=>create(concurrent)));
      assert.equal(results.filter(r=>r.statusCode===201).length,1);assert.equal(results.filter(r=>r.statusCode===200).length,19);
      assert.equal(new Set(results.map(r=>r.json().scenarioId)).size,1);
    });
    for(const type of ['LOST_RESPONSE_RECOVERY','HAPPY_PATH','FAILURE_RETRY'])for(const behavior of ['REJECT','UNKNOWN_WITHOUT_CREATION'])
      await t.test('manual '+behavior+' before '+type+' Create fails closed unchanged; Reset/new session runs the normal flow',async()=>{
        const s=await newSession(null);
        const manual=await post('/demo/fake-executor/dispatch-behavior',s,{behavior});assert.equal(manual.statusCode,200,manual.body);
        assert.equal(await state(s),null);const fake=await runtime.executors.forSession(s.context);
        const before=await dump();const memory=fakeState(fake);
        for(let i=0;i<2;i++){
          const rejected=await create(s,type);error(rejected,409,'DEMO_SCENARIO_SESSION_NOT_EMPTY');
          assert.match(rejected.json().message,/reset the session/);assert.equal(rejected.headers['set-cookie'],undefined);
          assert.deepEqual(await dump(),before);assert.equal(fakeState(fake),memory);
          assert.equal(await runtime.executors.forSession(s.context),fake);
        }
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_scenario_instances WHERE session_id=$1',[s.context.sessionId])).rows[0].n,0);
        assert.equal(fake.getDispatchHistory().length,0);assert.equal(fake.getExternalExecutions().length,0);
        assert.equal((await post('/demo/sessions/reset',s)).statusCode,204);assert.equal(runtime.executors.hasSession(s.context.sessionId),false);
        const fresh=await newSession(type);assert.notEqual(fresh.context.companyCode,s.context.companyCode);await through(fresh,1);
        const first=await next(fresh,2);assert.equal(first.statusCode,type==='LOST_RESPONSE_RECOVERY'?202:200,first.body);
        if(type==='LOST_RESPONSE_RECOVERY'){
          const recovered=await next(fresh,2);assert.equal(recovered.statusCode,200,recovered.body);
          assert.equal(recovered.json().stepResult.executionAttemptId,first.json().stepResult.executionAttemptId);
          const commands=(await runtime.executors.forSession(fresh.context)).getDispatchHistory();assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);
        }
        await through(fresh,type==='FAILURE_RETRY'?9:6,3);
        const d=(await state(fresh))!;assert.equal(d.versions.length,1);assert.equal(d.jobs.length,1);assert.equal(d.attempts.length,type==='FAILURE_RETRY'?2:1);
        assert.equal(d.versions[0]!.status,'PUBLISHED');assert.equal((await runtime.executors.forSession(fresh.context)).getExternalExecutions().length,type==='FAILURE_RETRY'?2:1);
      });
    for(const type of ['LOST_RESPONSE_RECOVERY','HAPPY_PATH','FAILURE_RETRY'])
      await t.test(type+' repeated Create preserves the SAME live and terminal execution, scripts, identity and progress',async()=>{
        const s=await newSession(type);await through(s,1);const first=await next(s,2);
        assert.equal(first.statusCode,type==='LOST_RESPONSE_RECOVERY'?202:200,first.body);
        const fake=await runtime.executors.forSession(s.context);
        const replay=async()=>{
          const before=await dump();const memory=fakeState(fake);const original=(await get('/demo/scenarios/current',s)).json();
          for(let i=0;i<3;i++){const r=await create(s,type);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json(),original);}
          error(await create(s,type==='HAPPY_PATH'?'FAILURE_RETRY':'HAPPY_PATH'),409,'DEMO_SCENARIO_TYPE_CONFLICT');
          assert.deepEqual(await dump(),before);assert.equal(await runtime.executors.forSession(s.context),fake);assert.equal(fakeState(fake),memory);
        };
        await replay();
        if(type==='LOST_RESPONSE_RECOVERY'){const recovered=await next(s,2);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().stepResult.executionAttemptId,first.json().stepResult.executionAttemptId);await replay();}
        if(type==='FAILURE_RETRY'){await through(s,5,3);await replay();await through(s,9,6);}else await through(s,6,3);
        await replay();assert.equal(fake.getExternalExecutions().length,type==='FAILURE_RETRY'?2:1);
      });
    await t.test('coordinator orders manual behavior before Create, and Create before manual behavior without contamination',async()=>{
      for(const manualFirst of [true,false]){
        const s=await newSession(null);const entered=barrier();const finish=barrier();const firstAdmitted=barrier();const admitted=barrier();let queued=0;
        const run=runtime.coordinator.run.bind(runtime.coordinator);const original=runtime.coordinator.run;
        const held=run(s.context,async()=>{entered.release();await finish.promise;});await entered.promise;
        runtime.coordinator.run=(session,body)=>{const operation=run(session,body);if(session.sessionId===s.context.sessionId){if(++queued===1)firstAdmitted.release();if(queued===2)admitted.release();}return operation;};
        let manual:Promise<Response>|undefined;let guided:Promise<Response>|undefined;
        try{
          if(manualFirst){manual=Promise.resolve(post('/demo/fake-executor/dispatch-behavior',s,{behavior:'REJECT'}));await firstAdmitted.promise;guided=Promise.resolve(create(s));}
          else{guided=Promise.resolve(create(s));await firstAdmitted.promise;manual=Promise.resolve(post('/demo/fake-executor/dispatch-behavior',s,{behavior:'REJECT'}));}
          await admitted.promise;finish.release();await held;
          const [m,g]=await Promise.all([manual,guided]);
          if(manualFirst){assert.equal(m.statusCode,200,m.body);error(g,409,'DEMO_SCENARIO_SESSION_NOT_EMPTY');assert.equal(await state(s),null);}
          else{assert.equal(g.statusCode,201,g.body);s.id=g.json().scenarioId;error(m,409,'DEMO_SCENARIO_MODE_CONFLICT');
            assert.equal(runtime.executors.hasSession(s.context.sessionId),false);await through(s,1);assert.equal((await next(s,2)).statusCode,202);assert.equal((await next(s,2)).statusCode,200);}
        }finally{runtime.coordinator.run=original;finish.release();await held;await Promise.all([manual,guided]);}
      }
    });
    const completed=await newSession();const responses:StepResponse[]=[];
    await t.test('first Step 2 is 202 with real execution, durable DISPATCHING/PENDING, pending ledger/progress and strict request ownership',async()=>{
      responses.push((await next(completed,1)).json());const r=await next(completed,2);assert.equal(r.statusCode,202,r.body);
      const dto=r.json<StepResponse>();assert.equal(dto.stepStatus,'PENDING');assert.equal(dto.completedStep,1);
      assert.equal(dto.stepResult.attemptNumber,1);assert.equal(dto.stepResult.attemptStatus,'DISPATCHING');assert.equal(dto.stepResult.jobStatus,'PENDING');
      const d=(await state(completed))!;assert.equal(d.attempts.length,1);assert.equal(d.attempts[0]!.status,'DISPATCHING');assert.equal(d.jobs[0]!.status,'PENDING');
      const fake=await runtime.executors.forSession(completed.context);assert.equal(fake.getExternalExecutions().length,1);assert.equal(fake.getExternalExecutions()[0]!.state,'RUNNING');
      assert.equal((await ledgers(completed))[1].status,'PENDING');assert.equal((await ledgers(completed))[1].result,null);
      assert.deepEqual(await progress(completed),{status:'IN_PROGRESS',completed_step:1});
      const before=await dump();assert.deepEqual((await get('/demo/scenarios/'+completed.id+'/pending-step',completed)).json(),{pendingStep:{stepNumber:2,requestId:completed.requests[1]}});
      error(await next(completed,2,randomUUID()),409,'DEMO_SCENARIO_STEP_CONFLICT');error(await next(completed,3),409,'DEMO_SCENARIO_STEP_CONFLICT');assert.deepEqual(await dump(),before);
    });
    await t.test('same request recovers ALREADY_EXISTS with identical full frozen command, Attempt 1, version 1, and one external execution',async()=>{
      const fake=await runtime.executors.forSession(completed.context);const before=fake.getDispatchHistory()[0]!;
      const r=await next(completed,2);assert.equal(r.statusCode,200,r.body);responses.push(r.json());
      assert.equal(r.json().stepResult.executionAttemptId,before.executionAttemptId);assert.equal(r.json().stepResult.attemptNumber,1);
      assert.equal(r.json().stepResult.attemptStatus,'ACCEPTED');assert.equal(r.json().stepResult.jobStatus,'RUNNING');
      assert.equal(fake.getDispatchHistory().length,2);assert.deepEqual(fake.getDispatchHistory()[1],before);assert.equal(fake.getExternalExecutions().length,1);
      const d=(await state(completed))!;assert.equal(d.attempts.length,1);assert.equal(d.attempts[0]!.dag,before.airflowDagId);assert.equal(d.attempts[0]!.run,before.airflowDagRunId);
      assert.equal(d.snapshots[0]!.id,before.datasetBuildSnapshotId);assert.equal(d.jobs[0]!.definition,before.resolvedDependencyDefinitionVersionId);
      assert.equal(d.versions.length,1);assert.equal(d.counter,1);
    });
    await t.test('six-step completion uses original execution, separate fake success/reconciliation, validation and atomic final progress',async()=>{
      for(let n=3;n<=6;n++){
        const r=await next(completed,n);assert.equal(r.statusCode,200,r.body);responses.push(r.json());
        const d=(await state(completed))!;assert.equal(d.attempts.length,1);assert.equal(d.jobs.length,1);assert.equal(d.versions.length,1);assert.equal(d.counter,1);
        assert.equal(d.attempts[0]!.id,responses[1]!.stepResult.executionAttemptId);
        assert.equal(d.jobs[0]!.status,n===3?'RUNNING':'SUCCEEDED');assert.equal(d.attempts[0]!.status,n===3?'ACCEPTED':'SUCCEEDED');
        assert.equal(d.versions[0]!.status,n===5?'VALIDATING':n===6?'PUBLISHED':'BUILDING');
        if(n===3)assert.equal((await runtime.executors.forSession(completed.context)).getExternalExecutions()[0]!.state,'SUCCEEDED');
        assert.equal((await ledgers(completed))[n-1].intent.airflowDagRunId,d.attempts[0]!.run);
      }
      assert.deepEqual(await progress(completed),{status:'COMPLETED',completed_step:6});
      assert.equal((await runtime.executors.forSession(completed.context)).getExternalExecutions().length,1);
    });
    await t.test('original completed results replay after publication without dispatch or next-step work; E step 7 is invalid',async()=>{
      const before=await dump();const fake=await runtime.executors.forSession(completed.context);const lookups=fake.getStatusLookupHistory().length;
      for(let n=1;n<=6;n++){const r=await next(completed,n);assert.equal(r.statusCode,200);assert.deepEqual(r.json(),responses[n-1]);error(await next(completed,n,randomUUID()),409,'DEMO_SCENARIO_STEP_CONFLICT');}
      error(await next(completed,7),400,'INVALID_REQUEST');assert.deepEqual(await dump(),before);assert.equal(fake.getDispatchHistory().length,2);assert.equal(fake.getStatusLookupHistory().length,lookups);
    });
    await t.test('backend SQL failure after real external creation but BEFORE core UNKNOWN recording recovers the SAME execution',async()=>{
      const s=await newSession();await through(s,1);
      await pool.query("CREATE FUNCTION fixture_02e_unknown_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='DISPATCHING' AND NEW.last_dispatch_error IS NOT NULL THEN RAISE EXCEPTION 'fixture unknown recording failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_02e_unknown_fail BEFORE UPDATE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION fixture_02e_unknown_fail()");
      try{error(await next(s,2),500,'INTERNAL_SERVER_ERROR');}finally{await pool.query('DROP TRIGGER fixture_02e_unknown_fail ON execution_attempts; DROP FUNCTION fixture_02e_unknown_fail()');}
      const fake=await runtime.executors.forSession(s.context);const first=fake.getDispatchHistory()[0]!;
      assert.equal(fake.getExternalExecutions().length,1);assert.equal((await state(s))!.attempts[0]!.status,'DISPATCHING');
      assert.equal((await state(s))!.attempts[0]!.history.last_dispatch_error,null);assert.equal((await progress(s)).completed_step,1);assert.equal((await ledgers(s))[1].status,'PENDING');
      const r=await next(s,2);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().stepResult.executionAttemptId,first.executionAttemptId);
      assert.deepEqual(fake.getDispatchHistory()[1],first);assert.equal(fake.getExternalExecutions().length,1);assert.equal((await state(s))!.attempts.length,1);
    });
    await t.test('decorator delegates status and preserves REJECTED, UNKNOWN and ALREADY_EXISTS without behavior-queue accumulation',async()=>{
      const command=(await runtime.executors.forSession(completed.context)).getDispatchHistory()[0]!;
      const fake=new FakeExecutor({scriptedBehaviors:['UNKNOWN_WITHOUT_CREATION','REJECT','ACCEPT']});const decorated=new LostAcknowledgementExecutor(fake);
      assert.equal((await decorated.dispatch(command)).kind,'UNKNOWN');assert.equal(fake.getExternalExecutions().length,0);
      assert.equal((await decorated.dispatch(command)).kind,'REJECTED');assert.equal((await decorated.dispatch(command)).kind,'REJECTED');assert.equal(fake.getExternalExecutions().length,0);
      const fresh={...command,executionAttemptId:randomUUID(),airflowDagRunId:'new-private-fixture'};
      assert.equal((await decorated.dispatch(fresh)).kind,'UNKNOWN');assert.equal(fake.getExternalExecutions().length,1);
      assert.equal((await new LostAcknowledgementExecutor(fake).dispatch(fresh)).kind,'ALREADY_EXISTS');assert.equal((await decorated.getExecutionStatus(fresh)).kind,'RUNNING');
    });
    await t.test('A rollback and failure before dispatch leave no attempt; same-request retry performs exactly one initial creation',async()=>{
      const s=await newSession();await through(s,1);
      hooks.beforeCommit=async(phase,c)=>{if(phase==='A')await c.query('SELECT 1/0');};
      try{error(await next(s,2),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeCommit;}
      assert.equal((await ledgers(s)).length,1);assert.equal((await state(s))!.attempts.length,0);
      hooks.beforeDomain=async()=>{throw new Error('after committed intent, before dispatch');};
      try{error(await next(s,2),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeDomain;}
      assert.equal((await ledgers(s)).length,2);assert.equal((await state(s))!.attempts.length,0);
      assert.equal((await next(s,2)).statusCode,202);assert.equal((await next(s,2)).statusCode,200);
      assert.equal((await runtime.executors.forSession(s.context)).getExternalExecutions().length,1);
    });
    for(const n of [2,3,4,5,6])await t.test('step '+n+' recovers real B rollback without duplicate work',async()=>{
      const s=await newSession();await through(s,n-1);if(n===2)assert.equal((await next(s,2)).statusCode,202);
      hooks.beforeCommit=async(phase,c)=>{if(phase==='B')await c.query('SELECT 1/0');};
      try{error(await next(s,n),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeCommit;}
      assert.equal((await progress(s)).completed_step,n-1);assert.equal((await ledgers(s))[n-1].status,'PENDING');
      const before=await state(s);const fake=await runtime.executors.forSession(s.context);const dispatches=fake.getDispatchHistory().length;const lookups=fake.getStatusLookupHistory().length;
      assert.equal((await next(s,n)).statusCode,200);assert.deepEqual(await state(s),before);assert.equal(fake.getDispatchHistory().length,dispatches);
      if(n===4)assert.equal(fake.getStatusLookupHistory().length,lookups);
    });
    await t.test('A/B unknown COMMIT, actual rollback and unavailable fresh confirmation preserve request identity and safe 503',async()=>{
      for(const phase of ['A','B'] as const)for(const action of ['COMMIT','ROLLBACK','UNAVAILABLE'] as const){
        const s=await newSession();await through(s,1);if(phase==='B')assert.equal((await next(s,2)).statusCode,202);
        let injected=false;hooks.commit=async(p,c)=>{await c.query(p===phase&&action==='ROLLBACK'?'ROLLBACK':'COMMIT');if(p===phase&&!injected){injected=true;throw new Error('lost commit acknowledgement');}};
        if(action==='UNAVAILABLE')hooks.recoveryClient=()=>{const url=new URL(connection(name));url.port='1';return new Client({connectionString:url.toString(),connectionTimeoutMillis:100});};
        let r:Response;try{r=await next(s,2);}finally{delete hooks.commit;delete hooks.recoveryClient;}
        if(action==='COMMIT')assert.equal(r.statusCode,phase==='A'?202:200,r.body);else error(r,503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');
        let recovered=await next(s,2);if(recovered.statusCode===202)recovered=await next(s,2);assert.equal(recovered.statusCode,200,recovered.body);
        assert.equal((await state(s))!.attempts.length,1);assert.equal((await runtime.executors.forSession(s.context)).getExternalExecutions().length,1);
      }
    });
    await t.test('unavailable fake dispatch stays PENDING/202; unavailable fake lookup fails closed without progress',async()=>{
      const s=await newSession();await through(s,1);const fake=new FakeExecutor();assigned.push(fake);
      const original=fake.dispatch;fake.dispatch=async()=>{throw new Error('executor unavailable');};
      try{const r=await next(s,2);assert.equal(r.statusCode,202,r.body);assert.equal(r.json().stepResult.attemptStatus,'DISPATCHING');assert.equal(fake.getExternalExecutions().length,0);}
      finally{fake.dispatch=original;}
      assert.equal((await next(s,2)).statusCode,202);assert.equal((await next(s,2)).statusCode,200);
      fake.setStatusLookupUnavailable('private unavailable detail');
      error(await next(s,3),503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');assert.equal((await progress(s)).completed_step,2);assert.equal((await ledgers(s))[2].status,'PENDING');
      fake.clearStatusLookupUnavailable();assert.equal((await next(s,3)).statusCode,200);assert.equal((await state(s))!.attempts.length,1);
    });
    await t.test('definite rejection is not forged success and cannot allocate Attempt 2 on repeated E Next',async()=>{
      const s=await newSession();await through(s,1);assigned.push(new FakeExecutor({defaultBehavior:'REJECT'}));
      for(let i=0;i<3;i++)error(await next(s,2),409,'DEMO_SCENARIO_STATE_CONFLICT');
      const d=(await state(s))!;assert.equal(d.attempts.length,1);assert.equal(d.attempts[0]!.status,'DISPATCH_FAILED');assert.equal(d.jobs[0]!.status,'PENDING');
      assert.equal((await runtime.executors.forSession(s.context)).getExternalExecutions().length,0);
    });
    await t.test('deterministic same/different requests converge; NOWAIT proves ALL locks released during external dispatch; Reset busy',async()=>{
      const s=await newSession();await through(s,1);const fake=new BlockingFake();fake.block=true;assigned.push(fake);
      const first=Promise.resolve(next(s,2));await fake.entered.promise;
      try{
        const probe=new Client({connectionString:connection(name)});await probe.connect();
        try{await probe.query('BEGIN');await probe.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE NOWAIT',[s.context.sessionId]);
          await probe.query('SELECT id FROM demo_scenario_instances WHERE id=$1 FOR UPDATE NOWAIT',[s.id]);
          await probe.query('SELECT id FROM demo_scenario_step_executions WHERE scenario_id=$1 FOR UPDATE NOWAIT',[s.id]);
          const d=(await state(s))!;await probe.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE NOWAIT',[d.jobs[0]!.id]);
          await probe.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 FOR UPDATE NOWAIT',[d.jobs[0]!.id]);await probe.query('ROLLBACK');
        }finally{await probe.end();}
        error(await post('/demo/sessions/reset',s),409,'RESET_CONFLICT');
        const same=Promise.resolve(next(s,2));const different=Promise.resolve(next(s,2,randomUUID()));const premature=Promise.resolve(next(s,4));
        fake.finish.release();const results=await Promise.all([first,same,different,premature]);
        assert.equal(results[0]!.statusCode,202);assert.equal(results[1]!.statusCode,200);error(results[2]!,409,'DEMO_SCENARIO_STEP_CONFLICT');error(results[3]!,409,'DEMO_SCENARIO_STEP_CONFLICT');
        assert.equal(fake.getExternalExecutions().length,1);assert.equal(fake.getDispatchHistory().length,2);assert.deepEqual(fake.getDispatchHistory()[0],fake.getDispatchHistory()[1]);
      }finally{fake.finish.release();await first;}
    });
    await t.test('different sessions progress independently with isolated executions and generic foreign-resource failures',async()=>{
      const a=await newSession();const b=await newSession();await through(a,1);const fake=new BlockingFake();fake.block=true;assigned.push(fake);
      const first=Promise.resolve(next(a,2));await fake.entered.promise;
      try{await through(b,6);assert.equal((await progress(b)).completed_step,6);assert.notEqual(await runtime.executors.forSession(b.context),fake);}
      finally{fake.finish.release();assert.equal((await first).statusCode,202);}
      const before=await dump();error(await post('/demo/scenarios/'+b.id+'/next',a,{expectedStep:2,requestId:b.requests[1]}),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await get('/demo/scenarios/'+b.id+'/pending-step',a),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await get('/demo/calculation-jobs/'+(await state(b))!.jobs[0]!.id,a),404,'DEMO_RESOURCE_UNAVAILABLE');assert.deepEqual(await dump(),before);
      assert.equal((await next(a,2)).statusCode,200);assert.equal(fake.getExternalExecutions().length,1);
    });
    await t.test('PostgreSQL rejects E ranges, wrong parent/owner/snapshot/definition/identity/attempt, duplicate keys and history edits',async()=>{
      const s=await newSession();await through(s,2);const another=await newSession();await through(another,2);
      const d=(await state(s))!;const a=d.attempts[0]!;const intent={datasetVersionId:d.versions[0]!.id,jobId:d.jobs[0]!.id,executionAttemptId:a.id,
        datasetBuildSnapshotId:d.snapshots[0]!.id,resolvedDependencyDefinitionVersionId:d.jobs[0]!.definition,airflowDagId:a.dag,airflowDagRunId:a.run};
      const insert=(id:string,n:number,binding:unknown,request:string=randomUUID())=>pool.query('INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent) VALUES($1,$2,$3,$4)',[id,n,request,binding]);
      for(const n of [0,7,8,9])await assert.rejects(insert(s.id,n,intent),e=>(e as {code:string}).code==='23514');
      for(const binding of [{...intent,executionAttemptId:randomUUID()},{...intent,datasetBuildSnapshotId:randomUUID()},
        {...intent,resolvedDependencyDefinitionVersionId:randomUUID()},{...intent,airflowDagRunId:'wrong'},{...intent,airflowDagId:'wrong'}])await assert.rejects(insert(s.id,3,binding));
      await assert.rejects(insert(another.id,3,intent));
      await assert.rejects(insert(s.id,3,intent,s.requests[1]));
      await pool.query("INSERT INTO execution_attempts(calculation_job_id,attempt_number,status,airflow_dag_id,airflow_dag_run_id,finished_at) VALUES($1,2,'DISPATCH_FAILED','demo_capex_guided',$2,now())",[d.jobs[0]!.id,'cost-engine-'+randomUUID()]);
      try{await assert.rejects(insert(s.id,3,intent));error(await next(s,3),409,'DEMO_SCENARIO_STATE_CONFLICT');}
      finally{await pool.query('DELETE FROM execution_attempts WHERE calculation_job_id=$1 AND attempt_number=2',[d.jobs[0]!.id]);}
      const l=(await ledgers(s))[1];await assert.rejects(pool.query('UPDATE demo_scenario_step_executions SET intent=$2 WHERE id=$1',[l.id,{}]));
      await assert.rejects(pool.query('UPDATE demo_scenario_step_executions SET result=$2 WHERE id=$1',[l.id,{}]));
      await assert.rejects(pool.query("UPDATE demo_scenario_instances SET scenario_type='HAPPY_PATH' WHERE id=$1",[s.id]));
      await assert.rejects(pool.query('UPDATE demo_scenario_instances SET session_id=$2 WHERE id=$1',[s.id,another.context.sessionId]));
      // A syntactically valid completion cannot invent success before a bound Attempt exists.
      const pending=await newSession();await through(pending,1);hooks.beforeDomain=async()=>{throw new Error('stop after A');};
      try{error(await next(pending,2),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeDomain;}
      const p=(await ledgers(pending))[1];await assert.rejects(pool.query("UPDATE demo_scenario_step_executions SET status='COMPLETED',completed_at=now(),result=$2 WHERE id=$1",[p.id,
        {...responses[1],scenarioId:pending.id,requestId:pending.requests[1],stepResult:{...responses[1]!.stepResult,datasetVersionId:(await state(pending))!.versions[0]!.id,jobId:(await state(pending))!.jobs[0]!.id}}]));
    });
    await t.test('retained E READY and ledger histories refuse down atomically with validator, migration markers and all data unchanged',async()=>{
      const before=await dump();const fn=(await pool.query("SELECT pg_get_functiondef('validate_demo_step_binding()'::regprocedure) AS body")).rows[0].body;
      await assert.rejects(migrate('down',1),/retained Lost Response Recovery scenarios/);assert.deepEqual(await dump(),before);
      assert.equal((await pool.query("SELECT pg_get_functiondef('validate_demo_step_binding()'::regprocedure) AS body")).rows[0].body,fn);
    });
    await t.test('Reset rollback preserves pending lost-ACK execution and all ledger/domain rows; commit deletes only owner and releases fake',async()=>{
      const s=await newSession();await through(s,1);assert.equal((await next(s,2)).statusCode,202);const other=await newSession();await through(other,4);
      const otherState=await state(other);const otherLedgers=await ledgers(other);const before=await dump();const fake=await runtime.executors.forSession(s.context);
      await pool.query("CREATE FUNCTION fixture_02e_reset_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture reset failure'; END $$; CREATE TRIGGER fixture_02e_reset_fail BEFORE DELETE ON dataset_series FOR EACH ROW EXECUTE FUNCTION fixture_02e_reset_fail()");
      try{error(await post('/demo/sessions/reset',s),500,'DEMO_RESET_FAILED');assert.deepEqual(await dump(),before);assert.equal(await runtime.executors.forSession(s.context),fake);}
      finally{await pool.query('DROP TRIGGER fixture_02e_reset_fail ON dataset_series; DROP FUNCTION fixture_02e_reset_fail()');}
      assert.equal((await post('/demo/sessions/reset',s)).statusCode,204);assert.equal(await state(s),null);assert.equal(await progress(s),undefined);assert.equal((await ledgers(s)).length,0);
      assert.ok(!runtime.executors.sessionIds().includes(s.context.sessionId));assert.deepEqual(await state(other),otherState);assert.deepEqual(await ledgers(other),otherLedgers);
    });
    await t.test('unknown Reset commit/rollback and unavailable confirmation retain admission safety around lost-ACK state',async()=>{
      for(const commit of [true,false]){const s=await newSession();await through(s,1);assert.equal((await next(s,2)).statusCode,202);const before=await dump();
        resetHooks.commit=async c=>{await c.query(commit?'COMMIT':'ROLLBACK');throw new Error('lost acknowledgement');};
        try{const r=await post('/demo/sessions/reset',s);if(commit){assert.equal(r.statusCode,204,r.body);assert.equal(await state(s),null);}else{error(r,500,'DEMO_RESET_FAILED');assert.deepEqual(await dump(),before);}}
        finally{delete resetHooks.commit;}}
      const s=await newSession();await through(s,1);assert.equal((await next(s,2)).statusCode,202);
      resetHooks.commit=async c=>{await c.query('ROLLBACK');throw new Error('lost acknowledgement');};
      resetHooks.recoveryClient=()=>{const url=new URL(connection(name));url.port='1';return new Client({connectionString:url.toString(),connectionTimeoutMillis:100});};
      try{error(await post('/demo/sessions/reset',s),503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await next(s,2),503,'DEMO_RESET_OUTCOME_UNKNOWN');assert.ok(runtime.executors.sessionIds().includes(s.context.sessionId));}
      finally{delete resetHooks.commit;delete resetHooks.recoveryClient;}
      assert.equal(await runtime.reset.recoverPendingResets(),0);assert.equal((await next(s,2)).statusCode,200);assert.equal((await state(s))!.attempts.length,1);
    });
    await t.test('cookie/CSRF/Origin, exact selectors, manual isolation and expiry remain enforced without hidden operations',async()=>{
      const s=await newSession();const before=await dump();
      error(await post('/demo/scenarios/'+s.id+'/next',undefined,{expectedStep:1,requestId:s.requests[0]}),401,'DEMO_SESSION_UNAVAILABLE');
      for(const field of ['datasetVersionId','jobId','executionAttemptId','airflowDagId','airflowDagRunId','behavior'])
        error(await post('/demo/scenarios/'+s.id+'/next',s,{expectedStep:1,requestId:s.requests[0],[field]:randomUUID()}),400,'INVALID_REQUEST');
      error(await app.inject({method:'POST',url:'/demo/scenarios/'+s.id+'/next',headers:{cookie:s.cookie},payload:{expectedStep:1,requestId:s.requests[0]}}),403,'DEMO_SESSION_CSRF_REJECTED');
      error(await app.inject({method:'GET',url:'/demo/scenarios/'+s.id+'/pending-step',headers:{cookie:s.cookie,origin:'https://foreign.test'}}),403,'DEMO_SESSION_CSRF_REJECTED');
      error(await post('/demo/fake-executor/dispatch-behavior',s,{behavior:'ACCEPT'}),409,'DEMO_SCENARIO_MODE_CONFLICT');
      assert.deepEqual(await dump(),before);
      await through(s,1);assert.equal((await next(s,2)).statusCode,202);const domain=await state(s);
      await pool.query("UPDATE demo_sessions SET created_at=clock_timestamp()-interval '5 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[s.context.sessionId]);
      const expired=await next(s,2);error(expired,401,'DEMO_SESSION_UNAVAILABLE');assert.match(String(expired.headers['set-cookie']),/Max-Age=0/);assert.deepEqual(await state(s),domain);
    });
    await t.test('queued recovery rechecks expiration before admission and never redispatches after expiry',async()=>{
      const s=await newSession();await through(s,1);assert.equal((await next(s,2)).statusCode,202);const entered=barrier();const finish=barrier();const admitted=barrier();
      const run=runtime.coordinator.run.bind(runtime.coordinator);const original=runtime.coordinator.run;
      const first=run(s.context,async()=>{entered.release();await finish.promise;});await entered.promise;
      runtime.coordinator.run=(session,body)=>{const operation=run(session,body);if(session.sessionId===s.context.sessionId)admitted.release();return operation;};
      const recovery=Promise.resolve(next(s,2));const fake=await runtime.executors.forSession(s.context);
      try{await admitted.promise;await pool.query("UPDATE demo_sessions SET created_at=clock_timestamp()-interval '5 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[s.context.sessionId]);
        finish.release();await first;error(await recovery,401,'DEMO_SESSION_UNAVAILABLE');assert.equal(fake.getDispatchHistory().length,1);assert.equal((await progress(s)).completed_step,1);}
      finally{runtime.coordinator.run=original;finish.release();await Promise.all([first,recovery]);}
    });
    await t.test('restart invalidates old cookies, never resurrects execution memory, and denies new session old request ownership',async()=>{
      const s=await newSession();await through(s,1);assert.equal((await next(s,2)).statusCode,202);
      const fresh=new DemoRuntime(pool,'test',{}, {log(){}});const maintenance=fresh.reset.maintainInactiveSessions.bind(fresh.reset);
      fresh.reset.maintainInactiveSessions=async()=>{throw new Error('hold cleanup');};await fresh.reset.startServer();
      const restarted=await buildApp({appMode:'demo',demoRuntime:fresh,logger:false,nodeEnvironment:'test'});apps.push(restarted);
      error(await restarted.inject({method:'POST',url:'/demo/scenarios/'+s.id+'/next',headers:{cookie:s.cookie,'x-demo-session':'1'},payload:{expectedStep:2,requestId:s.requests[1]}}),401,'DEMO_SESSION_UNAVAILABLE');
      const cookie=await restarted.inject({method:'POST',url:'/demo/sessions',headers:{'x-demo-session':'1'},payload:{}});assert.equal(cookie.statusCode,201);
      error(await restarted.inject({method:'POST',url:'/demo/scenarios/'+s.id+'/next',headers:{cookie:String(cookie.headers['set-cookie']).split(';',1)[0]!,'x-demo-session':'1'},payload:{expectedStep:2,requestId:s.requests[1]}}),404,'DEMO_RESOURCE_UNAVAILABLE');
      assert.equal(fresh.executors.size,0);fresh.reset.maintainInactiveSessions=maintenance;await maintenance(1000);assert.equal(await state(s),null);assert.equal((await ledgers(s)).length,0);assert.equal(fresh.executors.size,0);
    });
  }finally{
    try{await Promise.all(apps.map(a=>a.close()));if(db){await db.end();await Promise.all(ends);}}
    finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      try{if(created){const deadline=Date.now()+5000;let sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
        while(sessions.rowCount&&Date.now()<deadline){await setImmediate();sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}assert.equal(sessions.rowCount,0);
        assert.match(name,/^demo_02e_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);console.log('DEMO_02E_TEARDOWN',JSON.stringify({database:name,sessions:0,dropped:true,forced:false}));
      }}finally{await admin.end();}
    }
  }
});
