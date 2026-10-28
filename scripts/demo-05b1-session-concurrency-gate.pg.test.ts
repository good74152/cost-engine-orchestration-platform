import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import type { AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';
import type { ScenarioCreateOptions } from '../src/modules/demo-scenario/demo-scenario.service.js';
import type { CreateDatasetVersionResult } from '../src/modules/dataset-version/dataset-version.types.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import { DemoReadRepository } from '../src/modules/demo-session/demo-read.repository.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-05B-1 requires a disposable PostgreSQL test service');
const connection = (name: string) => { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); };
function barrier() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error(`Timed out: ${label}`)),8000); })]); }
  finally { clearTimeout(timer); }
}
class BlockingFake extends FakeExecutor {
  readonly entered = barrier(); readonly finish = barrier();
  override async dispatch(command: DispatchCalculationCommand) {
    const result = await super.dispatch(command); this.entered.release(); await this.finish.promise; return result;
  }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
function error(r: Response, status: number, code: string) {
  assert.equal(r.statusCode,status,r.body); assert.equal(r.json().code,code);
  assert.equal(r.headers['cache-control'],'no-store'); assert.deepEqual(Object.keys(r.json()).sort(),['code','message']);
  assert.doesNotMatch(r.body,/token_hash|password|constraint|postgres(?:ql)?:|SELECT |INSERT /i);
}

test('Demo-05B-1: real parallel requests, exclusive barriers and safe Reset', {timeout:240_000}, async t => {
  const name=`demo_05b1_test_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;
  assert.match(name,/^demo_05b1_test_[a-z0-9_]+$/); assert.ok(name.length<=63);
  const admin=new Client({connectionString:connection('postgres')}); await admin.connect();
  const prior={...process.env}; const ends:Promise<void>[]=[];
  let created=false; let db:Pool|undefined; let app:FastifyInstance|undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created=true;
    await runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../migrations/',import.meta.url)),migrationsTable:'pgmigrations',
      direction:'up',singleTransaction:true,checkOrder:true,logger:{debug(){},info(){},warn(){},error(){}}});
    process.env.DATABASE_URL=connection(name); process.env.APP_MODE='demo'; process.env.NODE_ENV='test'; process.env.EXECUTOR_TYPE='fake';
    const [{pool},{buildApp},{DemoRuntime},{seedDemoSixDomainConfiguration}] = await Promise.all([
      import('../src/db/pool.js'),import('../src/app.js'),import('../src/modules/demo-session/demo-runtime.js'),import('./seed-demo-six-domain-configuration.js')]);
    db=pool; pool.on('connect',c=>ends.push(new Promise<void>(done=>c.once('end',done))));
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,12);
    await seedDemoSixDomainConfiguration(pool);
    const resetHooks:ResetOptions={log(){}}; const createHooks:ScenarioCreateOptions={}; const assigned:FakeExecutor[]=[];
    const runtime=new DemoRuntime(pool,'test',{createExecutor:()=>assigned.shift()??new FakeExecutor()},resetHooks,createHooks);
    app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false,demoSession:{origin:'https://demo.test'}});
    const post=async(url:string,s?:Session,payload:unknown={}):Promise<Response>=>app!.inject({method:'POST',url,payload:JSON.stringify(payload),
      headers:{'content-type':'application/json',origin:'https://demo.test','x-demo-session':'1',...(s?{cookie:s.cookie}:{})}});
    const get=async(url:string,s:Session):Promise<Response>=>app!.inject({method:'GET',url,headers:{cookie:s.cookie}});
    const session=async():Promise<Session>=>{
      const r=await post('/demo/sessions'); assert.equal(r.statusCode,201,r.body);
      const cookie=String(r.headers['set-cookie']).split(';')[0]!;
      return {cookie,context:await runtime.sessions.authenticate(cookie,'ce_demo_session')};
    };
    const create=(s:Session,year=2026,domain='CAPEX')=>post('/demo/dataset-versions',s,{domain,fiscalYear:year,period:'Q4'});
    const reset=(s:Session)=>post('/demo/sessions/reset',s);
    const count=async(table:string,where:string,values:unknown[])=>Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`,values)).rows[0].n);
    const owned=async(s:Session)=>(await pool.query(`SELECT to_jsonb(ds) AS row FROM dataset_series ds WHERE company_code=$1 ORDER BY id`,[s.context.companyCode])).rows;
    const createFixtureSeries=async(s:Session,year:number,domain='CAPEX')=>(await pool.query(`INSERT INTO dataset_series
      (id,domain,company_code,fiscal_year,period,last_allocated_version) VALUES (gen_random_uuid(),$1,$2,$3,'Q4',0) RETURNING id`,[domain,s.context.companyCode,year])).rows[0].id as string;
    const lockSeries=async(ids:string[])=>{
      const locker=new Client({connectionString:connection(name)}); await locker.connect(); await locker.query('BEGIN');
      await locker.query('SELECT id FROM dataset_series WHERE id=ANY($1::uuid[]) ORDER BY domain,company_code,fiscal_year,period FOR UPDATE',[ids]); return locker;
    };
    const waitForSeriesWaiters=async(n:number)=>{
      const deadline=Date.now()+7000; let rows:unknown[]=[];
      do {
        rows=(await admin.query(`SELECT pid,wait_event_type FROM pg_stat_activity WHERE datname=$1
          AND wait_event_type='Lock' AND query LIKE '%dataset_series%' AND cardinality(pg_blocking_pids(pid))>0`,[name])).rows;
        if(rows.length===n)return rows;
        await setImmediate();
      }while(Date.now()<deadline);
      assert.fail(`Expected ${n} simultaneously blocked Core transactions, observed ${rows.length}`);
    };
    const idle=async()=>{
      const deadline=Date.now()+3000;
      while(runtime.coordinator.activeSessionCount&&Date.now()<deadline)await setImmediate();
      assert.equal(runtime.coordinator.activeSessionCount,0);
    };

    await t.test('two different-series HTTP creates enter Core concurrently; Reset conflicts and another Session proceeds',async()=>{
      const a=await session();const b=await session(); const ids=await Promise.all([createFixtureSeries(a,2026),createFixtureSeries(a,2027)]);
      const locker=await lockSeries(ids);const pending=[create(a,2026),create(a,2027)];
      try {
        assert.equal((await waitForSeriesWaiters(2)).length,2);
        error(await bounded(reset(a),'active Reset conflict'),409,'RESET_CONFLICT');
        assert.equal(await count('demo_sessions','id=$1 AND revoked_at IS NULL',[a.context.sessionId]),1);
        assert.equal(await count('dataset_versions','dataset_series_id=ANY($1::uuid[])',[ids]),0);
        assert.equal((await bounded(create(b),'other Session progress')).statusCode,201);
      }finally{await locker.query('ROLLBACK');await locker.end();await Promise.all(pending);}
      for(const r of await Promise.all(pending))assert.equal(r.statusCode,201,r.body);
      assert.ok((await owned(a)).every(r=>r.row.last_allocated_version===1));await idle();
    });
    await t.test('same-series HTTP requests reach the PostgreSQL lock together; DB allocates exactly one complete two-job version',async()=>{
      const s=await session();const id=await createFixtureSeries(s,2026,'DPR');const locker=await lockSeries([id]);
      const pending=[create(s,2026,'DPR'),create(s,2026,'DPR')];
      try{await waitForSeriesWaiters(2);}finally{await locker.query('ROLLBACK');await locker.end();await Promise.all(pending);}
      const responses=await Promise.all(pending);assert.deepEqual(responses.map(r=>r.statusCode).sort(),[201,409]);
      const conflict=responses.find(r=>r.statusCode===409)!;error(conflict,409,'ACTIVE_DATASET_VERSION_EXISTS');
      assert.equal(await count('dataset_series','id=$1 AND last_allocated_version=1',[id]),1);
      assert.equal(await count('dataset_versions',"dataset_series_id=$1 AND version=1 AND status='DRAFT'",[id]),1);
      const jobs=(await pool.query(`SELECT j.status,t.code FROM calculation_jobs j JOIN calculation_types t ON t.id=j.calculation_type_id
        JOIN dataset_versions v ON v.id=j.output_dataset_version_id WHERE v.dataset_series_id=$1 ORDER BY t.code`,[id])).rows;
      assert.deepEqual(jobs,[{status:'PENDING',code:'DEMO_DPR_TABLE_X'},{status:'PENDING',code:'DEMO_DPR_TABLE_Y'}]);await idle();
    });
    await t.test('four actual Core transactions overlap; fifth Parallel request returns immediate 429 without mutations',async()=>{
      const s=await session();const years=[2030,2031,2032,2033];const ids=await Promise.all(years.map(y=>createFixtureSeries(s,y)));
      const locker=await lockSeries(ids);const pending=years.map(y=>create(s,y));
      try {
        await waitForSeriesWaiters(4);
        error(await bounded(create(s,2034),'fifth create must not queue'),429,'DEMO_SESSION_QUEUE_FULL');
        error(await bounded(get('/demo/dataset-versions',s),'fifth read must not queue'),429,'DEMO_SESSION_QUEUE_FULL');
        error(await bounded(reset(s),'busy Reset'),409,'RESET_CONFLICT');
        assert.equal((await owned(s)).length,4);assert.equal(await count('dataset_series','company_code=$1 AND fiscal_year=2034',[s.context.companyCode]),0);
        assert.equal(await count('dataset_versions','dataset_series_id=ANY($1::uuid[])',[ids]),0);
      }finally{await locker.query('ROLLBACK');await locker.end();await Promise.all(pending);}
      for(const r of await Promise.all(pending))assert.equal(r.statusCode,201,r.body);
      await idle();assert.equal((await create(s,2034)).statusCode,201);await idle();
    });
    await t.test('parallel read routes overlap and enforce four slots; rejected/failed operations release their slots',async()=>{
      const s=await session();assert.equal((await create(s)).statusCode,201);
      const entered=barrier();const finish=barrier();let calls=0;const original=DemoReadRepository.prototype.datasets;
      DemoReadRepository.prototype.datasets=async function(owner,page){const result=await original.call(this,owner,page);
        if(owner.sessionId===s.context.sessionId){if(++calls===4)entered.release();await finish.promise;}return result;};
      const reads=Array.from({length:4},()=>get('/demo/dataset-versions',s));
      try{await bounded(entered.promise,'four read bodies');error(await bounded(get('/demo/dataset-versions',s),'fifth read'),429,'DEMO_SESSION_QUEUE_FULL');}
      finally{finish.release();await Promise.all(reads);DemoReadRepository.prototype.datasets=original;}
      assert.ok((await Promise.all(reads)).every(r=>r.statusCode===200));await idle();
      const hold=barrier();const ready=barrier();let started=0;
      const bodies=Array.from({length:3},()=>runtime.coordinator.runParallel(s.context,async()=>{if(++started===3)ready.release();await hold.promise;}));
      try{await bounded(ready.promise,'three operations');await assert.rejects(runtime.coordinator.runParallel(s.context,async()=>{throw new Error('expected body failure');}),/expected body failure/);
        assert.equal(await runtime.coordinator.runParallel(s.context,async()=>42),42);
      }finally{hold.release();await Promise.all(bodies);}await idle();
    });
    await t.test('exclusive barriers wait for earlier parallel bodies, prevent overtaking and recover from failure without deadlock',async()=>{
      const s=await session();const first=barrier();const second=barrier();const both=barrier();const exclusiveEntered=barrier();const exclusiveFinish=barrier();
      const laterEntered=barrier();const laterFinish=barrier();const finalEntered=barrier();const events:string[]=[];let count=0;
      const assertEvents=(afterBatch:string[])=>{assert.deepEqual(events.slice(0,2).sort(),['P1','P2']);assert.deepEqual(events.slice(2),afterBatch);};
      const p1=runtime.coordinator.runParallel(s.context,async()=>{events.push('P1');if(++count===2)both.release();await first.promise;});
      const p2=runtime.coordinator.runParallel(s.context,async()=>{events.push('P2');if(++count===2)both.release();await second.promise;});
      let exclusive:Promise<void>|undefined;let later:Promise<void>|undefined;let last:Promise<void>|undefined;let after:Promise<void>|undefined;
      try {
        await bounded(both.promise,'parallel batch');
        exclusive=runtime.coordinator.run(s.context,async()=>{events.push('E1');exclusiveEntered.release();await exclusiveFinish.promise;});
        later=runtime.coordinator.runParallel(s.context,async()=>{events.push('P3');laterEntered.release();await laterFinish.promise;});
        last=runtime.coordinator.run(s.context,async()=>{events.push('E2');finalEntered.release();throw new Error('expected exclusive failure');});
        const rejected=assert.rejects(last,/expected exclusive failure/);
        after=runtime.coordinator.runParallel(s.context,async()=>{events.push('P4');});
        first.release();await p1;assertEvents([]);
        second.release();await bounded(exclusiveEntered.promise,'exclusive after entire batch');assertEvents(['E1']);
        exclusiveFinish.release();await bounded(laterEntered.promise,'parallel after exclusive');assertEvents(['E1','P3']);
        laterFinish.release();await bounded(finalEntered.promise,'next exclusive');await rejected;await after;
        assertEvents(['E1','P3','E2','P4']);
      }finally{first.release();second.release();exclusiveFinish.release();laterFinish.release();await Promise.allSettled([p1,p2,exclusive,later,last,after]);}await idle();
    });
    await t.test('parallel reservations count before revalidation finishes; queued expiry denies work and drains all state',async()=>{
      const s=await session();const original=runtime.sessions.revalidate.bind(runtime.sessions);const entered=barrier();const finish=barrier();let calls=0;let bodies=0;
      runtime.sessions.revalidate=async owner=>{if(owner.sessionId===s.context.sessionId){if(++calls===4)entered.release();await finish.promise;}await original(owner);};
      const operations=Array.from({length:4},()=>runtime.coordinator.runParallel(s.context,async()=>{bodies++;}));
      // Attach rejection handlers before revoking the durable Session.
      const settled=Promise.allSettled(operations);
      try{await bounded(entered.promise,'four revalidations');await assert.rejects(runtime.coordinator.runParallel(s.context,async()=>{}),{code:'DEMO_SESSION_QUEUE_FULL'});
        await runtime.sessions.revoke(s.context.sessionId);
      }finally{finish.release();await settled;runtime.sessions.revalidate=original;}
      assert.equal(bodies,0);for(const r of await settled){assert.equal(r.status,'rejected');if(r.status==='rejected')assert.equal(r.reason.code,'DEMO_SESSION_UNAVAILABLE');}await idle();
    });
    await t.test('manual-first Scenario Create waits for the whole admitted mutation; scenario-first blocks later Manual admission',async()=>{
      const a=await session();const b=await session();const entered=barrier();const finish=barrier();const queued=barrier();
      const originalAdmission=runtime.scenarios.assertFreeExploration.bind(runtime.scenarios);const originalRun=runtime.coordinator.run.bind(runtime.coordinator);
      runtime.scenarios.assertFreeExploration=async owner=>{await originalAdmission(owner);if(owner.sessionId===a.context.sessionId){entered.release();await finish.promise;}};
      runtime.coordinator.run=(owner,body)=>{const result=originalRun(owner,body);if(owner.sessionId===a.context.sessionId)queued.release();return result;};
      const manual=create(a);let scenario:Promise<Response>|undefined;
      try{await bounded(entered.promise,'Manual admission');scenario=post('/demo/scenarios',a,{scenarioType:'HAPPY_PATH'});await bounded(queued.promise,'exclusive Scenario admission');
        assert.equal(await count('demo_scenario_instances','session_id=$1',[a.context.sessionId]),0);
        assert.equal((await create(b)).statusCode,201);error(await reset(a),409,'RESET_CONFLICT');
      }finally{finish.release();await manual;await scenario;runtime.scenarios.assertFreeExploration=originalAdmission;runtime.coordinator.run=originalRun;}
      assert.equal((await manual).statusCode,201);error(await scenario!,409,'DEMO_SCENARIO_SESSION_NOT_EMPTY');

      const c=await session();const inCreate=barrier();const commit=barrier();const parallelQueued=barrier();let manualEntered=false;
      createHooks.beforeCommit=async()=>{inCreate.release();await commit.promise;};
      runtime.scenarios.assertFreeExploration=async owner=>{if(owner.sessionId===c.context.sessionId)manualEntered=true;return originalAdmission(owner);};
      const parallel=runtime.coordinator.runParallel.bind(runtime.coordinator);
      runtime.coordinator.runParallel=(owner,body)=>{const result=parallel(owner,body);if(owner.sessionId===c.context.sessionId)parallelQueued.release();return result;};
      const creating=post('/demo/scenarios',c,{scenarioType:'HAPPY_PATH'});let mutation:Promise<Response>|undefined;
      try{await bounded(inCreate.promise,'Scenario before COMMIT');mutation=create(c);await bounded(parallelQueued.promise,'Manual waiting behind Scenario');
        assert.equal((await get('/demo/dataset-versions',b)).statusCode,200);assert.equal(manualEntered,false);
      }finally{commit.release();await creating;await mutation;delete createHooks.beforeCommit;runtime.coordinator.runParallel=parallel;runtime.scenarios.assertFreeExploration=originalAdmission;}
      assert.equal((await creating).statusCode,201);error(await mutation!,409,'DEMO_SCENARIO_MODE_CONFLICT');assert.deepEqual(await owned(c),[]);await idle();
    });
    await t.test('Run, Reconcile and both Fake controls remain exclusive; no Session/Domain SQL locks span executor dispatch',async()=>{
      const a=await session();const b=await session();const data=(await create(a)).json<CreateDatasetVersionResult>();
      const fake=new BlockingFake();assigned.push(fake);const job=data.calculationJobs[0]!.jobId;
      const held=post(`/demo/calculation-jobs/${job}/run`,a);const probe=new Client({connectionString:connection(name)});await probe.connect();
      const pending:Promise<Response>[]=[];const original=runtime.coordinator.run.bind(runtime.coordinator);let signal=barrier();let freeAdmissions=0;
      const admission=runtime.scenarios.assertFreeExploration.bind(runtime.scenarios);
      try{
        await bounded(fake.entered.promise,'executor dispatch');const attempt=(await pool.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1',[job])).rows[0].id;
        runtime.scenarios.assertFreeExploration=async owner=>{if(owner.sessionId===a.context.sessionId)freeAdmissions++;return admission(owner);};
        runtime.coordinator.run=(owner,body)=>{const result=original(owner,body);if(owner.sessionId===a.context.sessionId)signal.release();return result;};
        await probe.query('BEGIN');
        for(const [table,id]of [['demo_sessions',a.context.sessionId],['dataset_versions',data.datasetVersionId],['calculation_jobs',job],['execution_attempts',attempt]])
          await probe.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`,[id]);
        await probe.query('ROLLBACK');
        for(const [path,body]of [[`/demo/calculation-jobs/${job}/run`,{}],[`/demo/calculation-jobs/${job}/reconcile`,{}],
          ['/demo/fake-executor/dispatch-behavior',{behavior:'ACCEPT'}],[`/demo/execution-attempts/${attempt}/fake-state`,{state:'SUCCEEDED'}]] as const) {
          signal=barrier();pending.push(post(path,a,body));await bounded(signal.promise,'exclusive queued route');
        }
        assert.equal(freeAdmissions,0);assert.equal(fake.getDispatchHistory().length,1);assert.equal(fake.getStatusLookupHistory().length,0);
        assert.equal((await create(b)).statusCode,201);error(await reset(a),409,'RESET_CONFLICT');
      }finally{fake.finish.release();await held;await Promise.all(pending);await probe.query('ROLLBACK');await probe.end();runtime.coordinator.run=original;runtime.scenarios.assertFreeExploration=admission;}
      assert.equal((await held).statusCode,200);for(const r of await Promise.all(pending))assert.equal(r.statusCode,200,r.body);
      assert.equal(fake.getDispatchHistory().length,1);assert.equal(fake.getStatusLookupHistory().length,1);
      const states=(await pool.query(`SELECT j.status AS job,a.status AS attempt FROM calculation_jobs j
        JOIN execution_attempts a ON a.calculation_job_id=j.id WHERE j.id=$1`,[job])).rows;
      assert.deepEqual(states,[{job:'RUNNING',attempt:'ACCEPTED'}]);await idle();
    });
    await t.test('Reset reservation immediately rejects all new Parallel/Exclusive operations and preserves another owner',async()=>{
      const a=await session();const b=await session();const data=(await create(a)).json<CreateDatasetVersionResult>();await create(b);
      const beforeB=await owned(b);const entered=barrier();const finish=barrier();resetHooks.beforeCommit=async()=>{entered.release();await finish.promise;};
      const resetting=reset(a);
      try{await bounded(entered.promise,'Reset before COMMIT');
        for(const request of [()=>create(a,2027),()=>get('/demo/dataset-versions',a),()=>post(`/demo/dataset-versions/${data.datasetVersionId}/abandon`,a),
          ()=>post('/demo/scenarios',a,{scenarioType:'HAPPY_PATH'}),()=>post(`/demo/calculation-jobs/${data.calculationJobs[0]!.jobId}/run`,a),
          ()=>post('/demo/fake-executor/dispatch-behavior',a,{behavior:'ACCEPT'}),()=>reset(a)])error(await bounded(request(),'reserved admission'),409,'RESET_CONFLICT');
        assert.deepEqual(await owned(b),beforeB);assert.equal((await get('/demo/dataset-versions',b)).statusCode,200);
      }finally{finish.release();await resetting;delete resetHooks.beforeCommit;}
      assert.equal((await resetting).statusCode,204);assert.deepEqual(await owned(a),[]);assert.deepEqual(await owned(b),beforeB);
      error(await create(a,2027),401,'DEMO_SESSION_UNAVAILABLE');await idle();
    });
    await t.test('unknown Reset COMMIT retains both admission barriers until fresh-connection rollback recovery',async()=>{
      const s=await session();await create(s);const before=await owned(s);const fake=await runtime.executors.forSession(s.context);
      resetHooks.commit=async client=>{await client.query('ROLLBACK');throw new Error('lost reset acknowledgement');};
      resetHooks.recoveryClient=()=>{throw new Error('recovery unavailable');};
      try{
        error(await reset(s),503,'DEMO_RESET_OUTCOME_UNKNOWN');
        error(await create(s,2027),503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await get('/demo/dataset-versions',s),503,'DEMO_RESET_OUTCOME_UNKNOWN');
        error(await post('/demo/scenarios',s,{scenarioType:'HAPPY_PATH'}),503,'DEMO_RESET_OUTCOME_UNKNOWN');
        error(await post('/demo/fake-executor/dispatch-behavior',s,{behavior:'ACCEPT'}),503,'DEMO_RESET_OUTCOME_UNKNOWN');
        assert.deepEqual(await owned(s),before);assert.equal(await runtime.executors.forSession(s.context),fake);
      }finally{delete resetHooks.commit;delete resetHooks.recoveryClient;}
      assert.equal(await runtime.reset.recoverPendingResets(),0);assert.deepEqual(await owned(s),before);
      assert.equal((await create(s,2027)).statusCode,201);assert.equal((await reset(s)).statusCode,204);await idle();
    });
    await t.test('parallel lifecycle/read routes retain ownership checks and cookie/Origin security',async()=>{
      const a=await session();const b=await session();const data=(await create(a)).json<CreateDatasetVersionResult>();
      error(await get(`/demo/dataset-versions/${data.datasetVersionId}`,b),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await post(`/demo/dataset-versions/${data.datasetVersionId}/abandon`,b),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await app!.inject({method:'POST',url:'/demo/dataset-versions',headers:{cookie:a.cookie,origin:'https://foreign.invalid','x-demo-session':'1'},
        payload:{domain:'CAPEX',fiscalYear:2027,period:'Q4'}}),403,'DEMO_SESSION_CSRF_REJECTED');
      const r=await post(`/demo/dataset-versions/${data.datasetVersionId}/abandon`,a);assert.equal(r.statusCode,200,r.body);
      assert.equal((await pool.query('SELECT status FROM dataset_versions WHERE id=$1',[data.datasetVersionId])).rows[0].status,'ABANDONED');await idle();
    });
    console.info('DEMO_05B1_EVIDENCE',JSON.stringify({database:name,migrations:12,parallelLimit:4,realPostgresWaiters:true,noExecutorSessionLock:true}));
  }finally{
    try{await app?.close();if(db){await db.end();await Promise.all(ends);}}
    finally{
      for(const key of ['DATABASE_URL','APP_MODE','NODE_ENV','EXECUTOR_TYPE']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
      try{if(created){const deadline=Date.now()+5000;let rows=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
        while(rows.rowCount&&Date.now()<deadline){await setImmediate();rows=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}
        assert.equal(rows.rowCount,0);assert.match(name,/^demo_05b1_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);
        console.info('DEMO_05B1_TEARDOWN',JSON.stringify({database:name,backends:0,dropped:true,forced:false}));}}
      finally{await admin.end();}
    }
  }
});
