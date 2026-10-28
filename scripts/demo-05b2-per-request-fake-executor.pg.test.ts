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
import type { CreateDatasetVersionResult } from '../src/modules/dataset-version/dataset-version.types.js';
import { FakeExecutor, type FakeRunSimulation } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import type { CalculationJobRunResult } from '../src/modules/calculation-job.types.js';
import type { SimulationReport } from '../src/modules/demo-session/request-scoped-fake-executor.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-05B-2 requires a disposable PostgreSQL test service');
const connection = (name: string) => { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); };
function barrier() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error(`Timed out: ${label}`)),8000); })]); }
  finally { clearTimeout(timer); }
}
class ControlledFake extends FakeExecutor {
  before: (command: DispatchCalculationCommand, simulation: FakeRunSimulation) => Promise<void> = async () => {};
  after: (command: DispatchCalculationCommand, simulation: FakeRunSimulation) => Promise<void> = async () => {};
  override async dispatchWithSimulation(command: DispatchCalculationCommand, simulation: FakeRunSimulation) {
    await this.before(command,simulation);
    const observation=await super.dispatchWithSimulation(command,simulation);
    try { await this.after(command,simulation); return observation; }
    catch (error) { observation.finish(); throw error; }
  }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
function error(r: Response, status: number, code: string, simulation?: SimulationReport) {
  assert.equal(r.statusCode,status,r.body); assert.equal(r.json().code,code);
  assert.equal(r.headers['cache-control'],'no-store');
  assert.deepEqual(Object.keys(r.json()).sort(),simulation?['code','message','simulation']:['code','message']);
  if(simulation)assert.deepEqual(r.json().simulation,simulation);
  assert.doesNotMatch(r.body,/token_hash|password|constraint|postgres(?:ql)?:|SELECT |INSERT /i);
}

test('Demo-05B-2: per-request simulation, identity-safe concurrency and unchanged Core transitions', {timeout:240_000}, async t => {
  const name=`demo_05b2_test_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;
  assert.match(name,/^demo_05b2_test_[a-z0-9_]+$/); assert.ok(name.length<=63);
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
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,13);
    await seedDemoSixDomainConfiguration(pool);
    const resetHooks:ResetOptions={log(){}}; const assigned:FakeExecutor[]=[];
    const runtime=new DemoRuntime(pool,'test',{createExecutor:()=>assigned.shift()??new FakeExecutor()},resetHooks);
    app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false,demoSession:{origin:'https://demo.test'}});
    const post=async(url:string,s?:Session,payload:unknown={}):Promise<Response>=>app!.inject({method:'POST',url,payload:JSON.stringify(payload),
      headers:{'content-type':'application/json',origin:'https://demo.test','x-demo-session':'1',...(s?{cookie:s.cookie}:{})}});
    const session=async():Promise<Session>=>{
      const r=await post('/demo/sessions'); assert.equal(r.statusCode,201,r.body);
      const cookie=String(r.headers['set-cookie']).split(';')[0]!;
      return {cookie,context:await runtime.sessions.authenticate(cookie,'ce_demo_session')};
    };
    const create=(s:Session,year=2026,domain='CAPEX')=>post('/demo/dataset-versions',s,{domain,fiscalYear:year,period:'Q4'});
    const reset=(s:Session)=>post('/demo/sessions/reset',s);
    const idle=async()=>{
      const deadline=Date.now()+3000;
      while(runtime.coordinator.activeSessionCount&&Date.now()<deadline)await setImmediate();
      assert.equal(runtime.coordinator.activeSessionCount,0);
    };


    const result=(r:Response,status=200)=>{assert.equal(r.statusCode,status,r.body);assert.equal(r.headers['cache-control'],'no-store');
      return r.json<CalculationJobRunResult & {simulation:SimulationReport}>();};
    const run=(s:Session,job:string,simulation?:FakeRunSimulation)=>post(`/demo/calculation-jobs/${job}/run`,s,simulation?{simulation}:{});
    const reconcile=(s:Session,job:string)=>post(`/demo/calculation-jobs/${job}/reconcile`,s);
    const accept=(completion:'RUNNING'|'SUCCEEDED'|'FAILED'='RUNNING'):FakeRunSimulation=>({dispatch:'ACCEPT',completion});
    const dataset=async(s:Session,year=2026,domain='CAPEX')=>{const r=await create(s,year,domain);assert.equal(r.statusCode,201,r.body);return r.json<CreateDatasetVersionResult>();};
    const fixture=async(year=2026)=>{const s=await session();const data=await dataset(s,year);const fake=new ControlledFake();assigned.push(fake);
      assert.equal(await runtime.executors.forSession(s.context),fake);return {s,data,job:data.calculationJobs[0]!.jobId,fake};};
    const states=async(job:string)=>(await pool.query(`SELECT j.status AS job,a.status AS attempt,a.id,a.attempt_number
      FROM calculation_jobs j JOIN execution_attempts a ON a.calculation_job_id=j.id WHERE j.id=$1 ORDER BY a.attempt_number`,[job])).rows;
    const assertStates=async(job:string,expected:string[][])=>assert.deepEqual((await states(job)).map(r=>[r.job,r.attempt]),expected);
    const assertReport=(r:ReturnType<typeof result>,requested:FakeRunSimulation,applied:FakeRunSimulation|null,application:SimulationReport['application'])=>
      assert.deepEqual(r.simulation,{requested,applied,application});
    const rejectedResponse=(r:Response,requested:FakeRunSimulation,applied:FakeRunSimulation|null,application:SimulationReport['application'])=>
      error(r,502,'EXECUTOR_DISPATCH_FAILED',{requested,applied,application});
    const frozen=async(id:string)=>({snapshots:(await pool.query('SELECT to_jsonb(s) AS row FROM dataset_build_snapshots s WHERE dataset_version_id=$1',[id])).rows,
      deps:(await pool.query(`SELECT to_jsonb(d) AS row FROM dataset_build_snapshot_dependencies d JOIN dataset_build_snapshots s ON s.id=d.snapshot_id
        WHERE s.dataset_version_id=$1 ORDER BY d.upstream_dataset_series_id`,[id])).rows});
    const finishDataset=async(s:Session,data:CreateDatasetVersionResult)=>{
      for(const job of data.calculationJobs){result(await run(s,job.jobId,accept('SUCCEEDED')));assert.equal((await reconcile(s,job.jobId)).statusCode,200);}
      for(const command of ['submit-validation','publish']){const r=await post(`/demo/dataset-versions/${data.datasetVersionId}/${command}`,s);assert.equal(r.statusCode,200,r.body);}
    };

    await t.test('strict request combinations reject without attempts or fake allocation; empty body stays compatible',async()=>{
      const s=await session();const data=await dataset(s);const job=data.calculationJobs[0]!.jobId;
      const before=runtime.executors.size;
      for(const body of [null,[],{dispatch:'ACCEPT'},{simulation:null},{simulation:[]},{simulation:{}},{simulation:{dispatch:'ACCEPT'}},
        {simulation:{dispatch:'ACCEPT_THEN_UNKNOWN'}},{simulation:{dispatch:'ACCEPT',completion:'SUCCESS'}},
        {simulation:{dispatch:'REJECT',completion:'FAILED'}},{simulation:{dispatch:'UNKNOWN_WITHOUT_CREATION',completion:'RUNNING'}},
        {simulation:{dispatch:'accept',completion:'RUNNING'}},{simulation:{dispatch:'ACCEPT',completion:'RUNNING',jobId:job}},
        {simulation:accept(),companyCode:s.context.companyCode}]) error(await post(`/demo/calculation-jobs/${job}/run`,s,body),400,'INVALID_REQUEST');
      assert.equal(runtime.executors.size,before);assert.deepEqual(await states(job),[]);
      const r=result(await run(s,job));assert.equal(r.simulation,undefined);assert.equal(r.attemptStatus,'ACCEPTED');
      assertReport(result(await run(s,job,accept('FAILED'))),accept('FAILED'),null,'UNKNOWN');
      assert.equal((await runtime.executors.forSession(s.context)).getExternalExecutions()[0]!.state,'RUNNING');
    });
    for(const completion of ['RUNNING','SUCCEEDED','FAILED'] as const) await t.test(`ACCEPT + ${completion}: completion is external only until Reconcile`,async()=>{
      const {s,job,fake}=await fixture();const sim=accept(completion);const first=result(await run(s,job,sim));
      assertReport(first,sim,sim,'APPLIED');await assertStates(job,[['RUNNING','ACCEPTED']]);assert.equal(fake.getExternalExecutions()[0]!.state,completion);
      const repeated=result(await run(s,job,accept(completion==='FAILED'?'SUCCEEDED':'FAILED')));
      assert.equal(repeated.executionAttemptId,first.executionAttemptId);assert.equal(fake.getDispatchHistory().length,1);
      assertReport(repeated,accept(completion==='FAILED'?'SUCCEEDED':'FAILED'),sim,'EXISTING');
      const r=await reconcile(s,job);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().jobStatus,completion);
      await assertStates(job,[[completion,completion==='RUNNING'?'ACCEPTED':completion]]);
    });
    await t.test('different jobs really dispatch concurrently on one Session fake with independent completion and one immutable snapshot',async()=>{
      const s=await session();await finishDataset(s,await dataset(s));const data=await dataset(s,2026,'DPR');
      const fake=await runtime.executors.forSession(s.context);assert.ok(fake instanceof FakeExecutor);
      // Install barriers on the existing instance, without replacing the registry entry.
      const original=fake.dispatchWithSimulation.bind(fake);const entered=barrier();const release=barrier();let calls=0;
      fake.dispatchWithSimulation=async(command,simulation)=>{const observation=await original(command,simulation);if(++calls===2)entered.release();await release.promise;return observation;};
      const jobs=data.calculationJobs.map(j=>j.jobId);const sims=[accept('FAILED'),accept('SUCCEEDED')];const requests=jobs.map((j,i)=>run(s,j,sims[i]!));
      try{await bounded(entered.promise,'both independent job dispatches');
        for(const j of jobs)await assertStates(j,[['PENDING','DISPATCHING']]);error(await reset(s),409,'RESET_CONFLICT');
        const probe=new Client({connectionString:connection(name)});await probe.connect();
        try{await probe.query('BEGIN');for(const table of ['demo_sessions','dataset_versions','calculation_jobs','execution_attempts']){
          const ids=table==='demo_sessions'?[s.context.sessionId]:table==='dataset_versions'?[data.datasetVersionId]:table==='calculation_jobs'?jobs:(await Promise.all(jobs.map(states))).flat().map(r=>r.id);
          await probe.query(`SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) FOR UPDATE NOWAIT`,[ids]);}
        }finally{await probe.query('ROLLBACK');await probe.end();}
      }finally{release.release();await Promise.all(requests);fake.dispatchWithSimulation=original;}
      for(const [i,r]of (await Promise.all(requests)).entries())assertReport(result(r),sims[i]!,sims[i]!,'APPLIED');
      const frozenBefore=await frozen(data.datasetVersionId);assert.equal(frozenBefore.snapshots.length,1);assert.equal(frozenBefore.deps.length,1);
      await Promise.all(jobs.map(async j=>{assert.equal((await reconcile(s,j)).statusCode,200);}));
      await assertStates(jobs[0]!,[['FAILED','FAILED']]);await assertStates(jobs[1]!,[['SUCCEEDED','SUCCEEDED']]);
      assert.deepEqual(await frozen(data.datasetVersionId),frozenBefore);assert.equal(await runtime.executors.forSession(s.context),fake);
      const commands=fake.getDispatchHistory().filter(c=>c.datasetVersionId===data.datasetVersionId);
      assert.equal(new Set(commands.map(c=>c.airflowDagRunId)).size,2);assert.ok(commands.every(c=>c.upstreamDatasetVersions.length===1&&c.upstreamDatasetVersions[0]!.domain==='CAPEX'));
      const upstream=commands[0]!.upstreamDatasetVersions[0]!.datasetVersionId;
      await finishDataset(s,await dataset(s));const retried=result(await run(s,jobs[0]!,accept('SUCCEEDED')));assert.equal(retried.attemptNumber,2);
      assert.equal(fake.getDispatchHistory().at(-1)!.upstreamDatasetVersions[0]!.datasetVersionId,upstream);
      assert.deepEqual(await frozen(data.datasetVersionId),frozenBefore);
    });
    await t.test('concurrent same-attempt settings: first actual decision wins, later response reports actual settings without overwrite',async()=>{
      const {s,job,fake,data}=await fixture();const entered=barrier();const release=barrier();let calls=0;
      fake.after=async()=>{if(++calls===1){entered.release();await release.promise;}};
      const firstSim=accept('FAILED');const laterSim=accept('SUCCEEDED');const first=run(s,job,firstSim);let second:Response|undefined;
      try{await bounded(entered.promise,'first applied dispatch');second=await bounded(run(s,job,laterSim),'second same identity');
        assertReport(result(second),laterSim,firstSim,'EXISTING');assert.equal(fake.getExternalExecutions().length,1);assert.equal(fake.getExternalExecutions()[0]!.state,'FAILED');
      }finally{release.release();await first;}
      const a=result(await first);assertReport(a,firstSim,firstSim,'APPLIED');assert.equal(a.executionAttemptId,result(second!).executionAttemptId);
      assert.equal(a.airflowDagRunId,result(second!).airflowDagRunId);assert.equal((await states(job)).length,1);
      assert.equal((await frozen(data.datasetVersionId)).snapshots.length,1);assert.equal(fake.getDispatchHistory().length,2);
      assert.equal(result(await run(s,job,accept())).simulation.application,'EXISTING');assert.equal(fake.getDispatchHistory().length,2);
    });
    await t.test('actual application order, not HTTP arrival order, chooses the immutable simulation',async()=>{
      const {s,job,fake}=await fixture();const entered=barrier();const release=barrier();let calls=0;
      fake.before=async()=>{if(++calls===1){entered.release();await release.promise;}};
      const delayed=run(s,job,accept('FAILED'));let winner:ReturnType<typeof result>|undefined;
      try{await bounded(entered.promise,'before first decision');winner=result(await bounded(run(s,job,accept('SUCCEEDED')),'second applies first'));
        assertReport(winner,accept('SUCCEEDED'),accept('SUCCEEDED'),'APPLIED');
      }finally{release.release();await delayed;}
      const r=result(await delayed);assertReport(r,accept('FAILED'),accept('SUCCEEDED'),'EXISTING');assert.equal(r.executionAttemptId,winner!.executionAttemptId);
      assert.equal(fake.getExternalExecutions().length,1);assert.equal(fake.getExternalExecutions()[0]!.state,'SUCCEEDED');
    });
    await t.test('ACCEPT_THEN_UNKNOWN recovers same attempt/identity and original completion through ALREADY_EXISTS',async()=>{
      const {s,job,fake}=await fixture();const sim:FakeRunSimulation={dispatch:'ACCEPT_THEN_UNKNOWN',completion:'FAILED'};
      const first=result(await run(s,job,sim),202);assertReport(first,sim,sim,'APPLIED');await assertStates(job,[['PENDING','DISPATCHING']]);
      const recovered=result(await run(s,job,accept('SUCCEEDED')));assertReport(recovered,accept('SUCCEEDED'),sim,'EXISTING');
      assert.equal(recovered.executionAttemptId,first.executionAttemptId);assert.equal(recovered.airflowDagRunId,first.airflowDagRunId);assert.equal(recovered.dispatchOutcome,'ALREADY_EXISTS');
      assert.equal(fake.getExternalExecutions().length,1);assert.equal(fake.getExternalExecutions()[0]!.state,'FAILED');await assertStates(job,[['RUNNING','ACCEPTED']]);
      assert.equal((await reconcile(s,job)).json().jobStatus,'FAILED');
    });
    await t.test('UNKNOWN_WITHOUT_CREATION remains unbound and can recover concurrently without consuming shared behavior',async()=>{
      const {s,job,fake}=await fixture();const entered=barrier();const release=barrier();let calls=0;
      fake.enqueueBehaviors('REJECT');fake.after=async()=>{if(++calls===1){entered.release();await release.promise;}};
      const sim:FakeRunSimulation={dispatch:'UNKNOWN_WITHOUT_CREATION'};const pending=run(s,job,sim);let recovered:ReturnType<typeof result>|undefined;
      try{await bounded(entered.promise,'no-run UNKNOWN in flight');assert.equal(fake.getExternalExecutions().length,0);
        recovered=result(await bounded(run(s,job,accept('SUCCEEDED')),'same identity recovers'));assertReport(recovered,accept('SUCCEEDED'),accept('SUCCEEDED'),'APPLIED');
      }finally{release.release();await pending;}
      const first=result(await pending);assertReport(first,sim,accept('SUCCEEDED'),'EXISTING');assert.equal(first.attemptStatus,'ACCEPTED');assert.equal(first.executionAttemptId,recovered!.executionAttemptId);
      assert.equal(fake.getExternalExecutions().length,1);assert.equal((await reconcile(s,job)).json().jobStatus,'SUCCEEDED');
      const other=await dataset(s,2027);error(await run(s,other.calculationJobs[0]!.jobId),502,'EXECUTOR_DISPATCH_FAILED');
    });
    await t.test('no-run UNKNOWN does not permanently bind; definite rejection waits for earlier ambiguous recording then recovers with a new attempt',async()=>{
      const {s,job,fake,data}=await fixture();const entered=barrier();const release=barrier();let calls=0;
      fake.after=async()=>{if(++calls===1){entered.release();await release.promise;}};
      const unknown:FakeRunSimulation={dispatch:'UNKNOWN_WITHOUT_CREATION'},reject:FakeRunSimulation={dispatch:'REJECT'};
      const first=run(s,job,unknown);let deferred:ReturnType<typeof result>|undefined;
      try{await bounded(entered.promise,'ambiguous dispatch outstanding');deferred=result(await bounded(run(s,job,reject),'safe rejection deferral'),202);
        assertReport(deferred,reject,null,'UNBOUND');await assertStates(job,[['PENDING','DISPATCHING']]);assert.equal(fake.getExternalExecutions().length,0);
      }finally{release.release();await first;}
      const before=result(await first,202);assertReport(before,unknown,null,'UNBOUND');assert.equal(before.executionAttemptId,deferred!.executionAttemptId);
      const snapshot=await frozen(data.datasetVersionId);rejectedResponse(await run(s,job,reject),reject,reject,'APPLIED');await assertStates(job,[['PENDING','DISPATCH_FAILED']]);
      const retry=result(await run(s,job,accept('FAILED')));assert.equal(retry.attemptNumber,2);assert.notEqual(retry.executionAttemptId,before.executionAttemptId);
      assert.equal(fake.getExternalExecutions().length,1);assert.deepEqual(await frozen(data.datasetVersionId),snapshot);
    });
    await t.test('completed UNKNOWN responses remain 202/unbound; recovery reuses that same attempt without permanent configuration',async()=>{
      const {s,job,fake}=await fixture();const sim:FakeRunSimulation={dispatch:'UNKNOWN_WITHOUT_CREATION'};
      const first=result(await run(s,job,sim),202);const repeated=result(await run(s,job,sim),202);
      for(const r of [first,repeated])assertReport(r,sim,null,'UNBOUND');
      assert.equal(first.executionAttemptId,repeated.executionAttemptId);assert.equal(fake.getExternalExecutions().length,0);
      const recovered=result(await run(s,job,accept('RUNNING')));assertReport(recovered,accept('RUNNING'),accept('RUNNING'),'APPLIED');
      assert.equal(recovered.executionAttemptId,first.executionAttemptId);assert.equal(recovered.airflowDagRunId,first.airflowDagRunId);
      assert.equal((await states(job)).length,1);assert.equal(fake.getExternalExecutions().length,1);
    });
    await t.test('failed PostgreSQL outcome recording releases transient UNKNOWN admission and returns a sanitized internal error',async()=>{
      const {s,job,fake}=await fixture();
      await pool.query(`CREATE FUNCTION demo05b2_fail_unknown() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test-only outcome write failure'; END $$`);
      await pool.query(`CREATE TRIGGER demo05b2_fail_unknown BEFORE UPDATE ON execution_attempts FOR EACH ROW
        WHEN (NEW.last_dispatch_error IS NOT NULL) EXECUTE FUNCTION demo05b2_fail_unknown()`);
      try{error(await run(s,job,{dispatch:'UNKNOWN_WITHOUT_CREATION'}),500,'INTERNAL_SERVER_ERROR');}
      finally{await pool.query('DROP TRIGGER demo05b2_fail_unknown ON execution_attempts');await pool.query('DROP FUNCTION demo05b2_fail_unknown()');}
      await assertStates(job,[['PENDING','DISPATCHING']]);rejectedResponse(await run(s,job,{dispatch:'REJECT'}),{dispatch:'REJECT'},{dispatch:'REJECT'},'APPLIED');
      await assertStates(job,[['PENDING','DISPATCH_FAILED']]);assert.equal(fake.getExternalExecutions().length,0);
    });
    await t.test('retry rejection preserves FAILED logical state and frozen inputs, then a new attempt may succeed',async()=>{
      const {s,job,data}=await fixture();result(await run(s,job,accept('FAILED')));assert.equal((await reconcile(s,job)).json().jobStatus,'FAILED');
      const before=await frozen(data.datasetVersionId);rejectedResponse(await run(s,job,{dispatch:'REJECT'}),{dispatch:'REJECT'},{dispatch:'REJECT'},'APPLIED');
      await assertStates(job,[['FAILED','FAILED'],['FAILED','DISPATCH_FAILED']]);assert.deepEqual(await frozen(data.datasetVersionId),before);
      const next=result(await run(s,job,accept('SUCCEEDED')));assert.equal(next.attemptNumber,3);await assertStates(job,[['RUNNING','FAILED'],['RUNNING','DISPATCH_FAILED'],['RUNNING','ACCEPTED']]);
      assert.deepEqual(await frozen(data.datasetVersionId),before);
    });
    await t.test('concurrent first Run allocation retains exactly one Session FakeExecutor, not one per request',async()=>{
      const s=await session();const a=await dataset(s);const b=await dataset(s,2026,'FAB_COST');const before=runtime.executors.size;
      const fake=new ControlledFake();assigned.push(fake);const entered=barrier();const release=barrier();let calls=0;
      fake.after=async()=>{if(++calls===2)entered.release();await release.promise;};
      const requests=[run(s,a.calculationJobs[0]!.jobId,accept('FAILED')),run(s,b.calculationJobs[0]!.jobId,accept('SUCCEEDED'))];
      try{await bounded(entered.promise,'concurrent registry creation');assert.equal(runtime.executors.size,before+1);assert.equal(assigned.length,0);
        assert.equal(await runtime.executors.forSession(s.context),fake);assert.equal(fake.getExternalExecutions().length,2);
      }finally{release.release();await Promise.all(requests);}
      for(const r of await Promise.all(requests))result(r);
    });
    await t.test('identity-wide rejection defeats overlapping acceptance; new attempt may choose a different simulation',async()=>{
      const {s,job,fake}=await fixture();const entered=barrier();const release=barrier();let calls=0;
      fake.after=async()=>{if(++calls===1){entered.release();await release.promise;}};
      const rejected=run(s,job,{dispatch:'REJECT'});
      try{await bounded(entered.promise,'rejection applied');rejectedResponse(await bounded(run(s,job,accept('SUCCEEDED')),'overlapping rejection tombstone'),accept('SUCCEEDED'),{dispatch:'REJECT'},'EXISTING');
        assert.equal(fake.getExternalExecutions().length,0);
      }finally{release.release();await rejected;}
      // The first caller applied REJECT; the competing caller only observed it.
      error(await rejected,502,'EXECUTOR_DISPATCH_FAILED',{requested:{dispatch:'REJECT'},applied:{dispatch:'REJECT'},application:'APPLIED'});
      assert.equal((await states(job)).length,1);
      const retry=result(await run(s,job,accept('SUCCEEDED')));assert.equal(retry.attemptNumber,2);assertReport(retry,accept('SUCCEEDED'),accept('SUCCEEDED'),'APPLIED');
      assert.equal(fake.getExternalExecutions().length,1);
    });
    await t.test('late rejection after a newer accepted attempt retains the existing Core flat 500 contract, without borrowing its simulation',async()=>{
      const {s,job,fake}=await fixture();const entered=barrier();const release=barrier();let calls=0;
      fake.after=async()=>{if(++calls===1){entered.release();await release.promise;}};
      const old=run(s,job,{dispatch:'REJECT'});
      try{await bounded(entered.promise,'old rejected dispatch');
        rejectedResponse(await run(s,job,accept('SUCCEEDED')),accept('SUCCEEDED'),{dispatch:'REJECT'},'EXISTING');
        const next=result(await run(s,job,accept('SUCCEEDED')));assert.equal(next.attemptNumber,2);assertReport(next,accept('SUCCEEDED'),accept('SUCCEEDED'),'APPLIED');
      }finally{release.release();await old;}
      // Core guards DISPATCH_FAILED/RUNNING here; do not turn this invariant
      // failure into a 502, or attach the old/new attempt's known simulation.
      error(await old,500,'INTERNAL_SERVER_ERROR');
      await assertStates(job,[['RUNNING','DISPATCH_FAILED'],['RUNNING','ACCEPTED']]);
      assert.equal(fake.getExternalExecutions().length,1);
    });
    await t.test('first explicit rejection reports APPLIED while preserving one durable failed dispatch and no external execution',async()=>{
      const {s,job,fake,data}=await fixture();const sim:FakeRunSimulation={dispatch:'REJECT'};
      rejectedResponse(await run(s,job,sim),sim,sim,'APPLIED');await assertStates(job,[['PENDING','DISPATCH_FAILED']]);
      assert.equal((await states(job)).length,1);assert.equal(fake.getExternalExecutions().length,0);assert.equal(fake.getDispatchHistory().length,1);
      assert.equal((await frozen(data.datasetVersionId)).snapshots.length,1);
      const command=fake.getDispatchHistory()[0]!;const before=fake.simulationInfo(command);
      assert.equal((await fake.dispatchWithSimulation(command,accept('SUCCEEDED'))).result.kind,'REJECTED');
      assert.deepEqual(fake.simulationInfo(command),before);assert.equal(fake.getExternalExecutions().length,0);
    });
    await t.test('legacy rejection on the same durable identity reports UNKNOWN, never the new request or another attempt decision',async()=>{
      const {s,job,fake}=await fixture();const prepared=result(await run(s,job,{dispatch:'UNKNOWN_WITHOUT_CREATION'}),202);
      // Seed a legacy external rejection while Core still has the ambiguous attempt.
      // Legacy HTTP Run is Exclusive, so its public terminal rejection would instead
      // permit a NEW attempt; it cannot publicly overlap a scoped Run on this identity.
      const command=fake.getDispatchHistory()[0]!;fake.enqueueBehaviors('REJECT');assert.equal((await fake.dispatch(command)).kind,'REJECTED');
      const before=fake.simulationInfo(command);const sim=accept('SUCCEEDED');
      rejectedResponse(await run(s,job,sim),sim,null,'UNKNOWN');assert.deepEqual(fake.simulationInfo(command),before);
      const rows=await states(job);assert.equal(rows.length,1);assert.equal(rows[0]!.id,prepared.executionAttemptId);
      await assertStates(job,[['PENDING','DISPATCH_FAILED']]);assert.equal(fake.getExternalExecutions().length,0);

      const other=await dataset(s,2027);const otherJob=other.calculationJobs[0]!.jobId;fake.enqueueBehaviors('REJECT');
      error(await run(s,otherJob),502,'EXECUTOR_DISPATCH_FAILED'); // Legacy flat envelope.
      const next=result(await run(s,otherJob,sim));assert.equal(next.attemptNumber,2);assertReport(next,sim,sim,'APPLIED');
      assert.equal(fake.getExternalExecutions().length,1);assert.equal(fake.getExternalExecutions()[0]!.state,'SUCCEEDED');
    });
    await t.test('pre-dispatch dependency failure keeps the flat 409 contract and creates no attempt, snapshot or fake decision',async()=>{
      const s=await session();const data=await dataset(s,2026,'DPR');const fake=new ControlledFake();assigned.push(fake);
      error(await run(s,data.calculationJobs[0]!.jobId,{dispatch:'REJECT'}),409,'DEPENDENCY_NOT_READY');
      for(const job of data.calculationJobs)assert.deepEqual(await states(job.jobId),[]);
      assert.deepEqual(await frozen(data.datasetVersionId),{snapshots:[],deps:[]});assert.equal(fake.getDispatchHistory().length,0);assert.equal(fake.getExternalExecutions().length,0);
    });
    await t.test('a known fake rejection does not decorate a failed PostgreSQL outcome write or other internal error',async()=>{
      const {s,job,fake}=await fixture();
      await pool.query(`CREATE FUNCTION demo05b2_fail_rejection() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test-only rejection write failure'; END $$`);
      await pool.query(`CREATE TRIGGER demo05b2_fail_rejection BEFORE UPDATE ON execution_attempts FOR EACH ROW
        WHEN (NEW.status='DISPATCH_FAILED') EXECUTE FUNCTION demo05b2_fail_rejection()`);
      try{error(await run(s,job,{dispatch:'REJECT'}),500,'INTERNAL_SERVER_ERROR');}
      finally{await pool.query('DROP TRIGGER demo05b2_fail_rejection ON execution_attempts');await pool.query('DROP FUNCTION demo05b2_fail_rejection()');}
      await assertStates(job,[['PENDING','DISPATCHING']]);assert.equal(fake.getExternalExecutions().length,0);
      rejectedResponse(await run(s,job,accept()),accept(),{dispatch:'REJECT'},'EXISTING');
      await assertStates(job,[['PENDING','DISPATCH_FAILED']]);assert.equal((await states(job)).length,1);assert.equal(fake.getExternalExecutions().length,0);
    });
    await t.test('shared queue/default and manual Fake state stay intact; scoped settings never consume or rewrite them',async()=>{
      const {s,job,fake}=await fixture();fake.setDefaultBehavior('REJECT');fake.enqueueBehaviors('ACCEPT_THEN_UNKNOWN');
      const first=result(await run(s,job,accept('FAILED')));assert.equal(fake.getExternalExecutions()[0]!.state,'FAILED');
      assert.equal((await post(`/demo/execution-attempts/${first.executionAttemptId}/fake-state`,s,{state:'SUCCEEDED'})).statusCode,200);
      assertReport(result(await run(s,job,accept('RUNNING'))),accept('RUNNING'),accept('FAILED'),'EXISTING');assert.equal(fake.getExternalExecutions()[0]!.state,'SUCCEEDED');
      await assertStates(job,[['RUNNING','ACCEPTED']]);assert.equal((await reconcile(s,job)).json().jobStatus,'SUCCEEDED');
      const second=await dataset(s,2027);const lost=result(await run(s,second.calculationJobs[0]!.jobId),202);assert.equal(lost.simulation,undefined);
      assertReport(result(await run(s,second.calculationJobs[0]!.jobId,accept('FAILED'))),accept('FAILED'),null,'UNKNOWN');
      const third=await dataset(s,2028);error(await run(s,third.calculationJobs[0]!.jobId),502,'EXECUTOR_DISPATCH_FAILED');
    });
    await t.test('Run and Reconcile overlap safely; late dispatch preserves terminal reconciliation history',async()=>{
      for(const completion of ['SUCCEEDED','FAILED'] as const){const {s,job,fake}=await fixture();const entered=barrier();const release=barrier();
        fake.after=async()=>{entered.release();await release.promise;};const pending=run(s,job,accept(completion));
        try{await bounded(entered.promise,'external completion before dispatch recording');await assertStates(job,[['PENDING','DISPATCHING']]);
          const r=await bounded(reconcile(s,job),'parallel Reconcile');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().jobStatus,completion);
          await assertStates(job,[[completion,completion]]);
        }finally{release.release();await pending;}
        const r=result(await pending);assert.equal(r.jobStatus,completion);assert.equal(r.attemptStatus,completion);assertReport(r,accept(completion),accept(completion),'APPLIED');
        assert.equal(fake.getExternalExecutions().length,1);
      }
    });
    await t.test('four explicit Runs enter dispatch together, fifth gets 429; Reset conflicts and legacy/Fake controls wait exclusively',async()=>{
      const {s,job,fake}=await fixture();const jobs=[job];for(const year of [2027,2028,2029,2030])jobs.push((await dataset(s,year)).calculationJobs[0]!.jobId);
      const entered=barrier();const release=barrier();let calls=0;fake.after=async()=>{if(++calls===4)entered.release();await release.promise;};
      const pending=jobs.slice(0,4).map(j=>run(s,j,accept()));const original=runtime.coordinator.run.bind(runtime.coordinator);const admitted=barrier();let exclusive=0;
      runtime.coordinator.run=(owner,body)=>{const r=original(owner,body);if(owner.sessionId===s.context.sessionId&&++exclusive===2)admitted.release();return r;};
      let legacy:Promise<Response>|undefined;let control:Promise<Response>|undefined;
      try{await bounded(entered.promise,'four dispatches');error(await bounded(run(s,jobs[4]!,accept()),'fifth explicit Run'),429,'DEMO_SESSION_QUEUE_FULL');
        error(await reset(s),409,'RESET_CONFLICT');assert.equal((await states(jobs[4]!)).length,0);
        legacy=run(s,job);control=post('/demo/fake-executor/dispatch-behavior',s,{behavior:'REJECT'});await bounded(admitted.promise,'exclusive legacy/control admission');
        assert.equal(calls,4);assert.equal(fake.getDispatchHistory().length,4);
      }finally{release.release();await Promise.all(pending);await legacy;await control;runtime.coordinator.run=original;}
      for(const r of await Promise.all(pending))result(r);result(await legacy!);assert.equal((await control!).statusCode,200);assert.equal(calls,4);
      error(await run(s,jobs[4]!),502,'EXECUTOR_DISPATCH_FAILED');await idle();
    });
    await t.test('Reset reservation and unknown outcome block scoped Run/Reconcile; fresh recovery retains the original fake',async()=>{
      const {s,job,fake}=await fixture();const entered=barrier();const release=barrier();resetHooks.beforeCommit=async()=>{entered.release();await release.promise;};
      resetHooks.commit=async client=>{await client.query('ROLLBACK');throw new Error('lost acknowledgement');};resetHooks.recoveryClient=()=>{throw new Error('recovery offline');};
      const pending=reset(s);
      try{await bounded(entered.promise,'Reset reservation');error(await run(s,job,accept()),409,'RESET_CONFLICT');error(await reconcile(s,job),409,'RESET_CONFLICT');
      }finally{release.release();await pending;delete resetHooks.beforeCommit;}
      try{error(await pending,503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await run(s,job,accept()),503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await reconcile(s,job),503,'DEMO_RESET_OUTCOME_UNKNOWN');
        assert.equal(fake.getDispatchHistory().length,0);assert.equal(await runtime.executors.forSession(s.context),fake);
      }finally{delete resetHooks.commit;delete resetHooks.recoveryClient;}
      assert.equal(await runtime.reset.recoverPendingResets(),0);result(await run(s,job,accept()));assert.equal((await reset(s)).statusCode,204);
      error(await run(s,job,accept()),401,'DEMO_SESSION_UNAVAILABLE');
    });
    await t.test('different Sessions progress independently, share no fake state, and preserve ownership/CSRF protection',async()=>{
      const a=await fixture();const b=await fixture();const entered=barrier();const release=barrier();a.fake.after=async()=>{entered.release();await release.promise;};
      const pending=run(a.s,a.job,accept('FAILED'));
      try{await bounded(entered.promise,'Session A dispatch');error(await run(b.s,a.job,accept('SUCCEEDED')),404,'DEMO_RESOURCE_UNAVAILABLE');
        error(await reconcile(b.s,a.job),404,'DEMO_RESOURCE_UNAVAILABLE');const r=result(await bounded(run(b.s,b.job,accept('SUCCEEDED')),'Session B independent'));
        assertReport(r,accept('SUCCEEDED'),accept('SUCCEEDED'),'APPLIED');assert.notEqual(a.fake,b.fake);
        assert.equal(b.fake.getExternalExecutions().length,1);assert.equal(b.fake.getExternalExecutions()[0]!.state,'SUCCEEDED');
        error(await app!.inject({method:'POST',url:`/demo/calculation-jobs/${b.job}/run`,headers:{cookie:b.s.cookie,origin:'https://evil.invalid','x-demo-session':'1'},payload:{simulation:accept()}}),403,'DEMO_SESSION_CSRF_REJECTED');
      }finally{release.release();await pending;}
      result(await pending);assert.equal(a.fake.getExternalExecutions()[0]!.state,'FAILED');
    });
    for(const type of ['HAPPY_PATH','FAILURE_RETRY','LOST_RESPONSE_RECOVERY']) await t.test(`${type}: unchanged exclusive Guided flow rejects manual scoped Run`,async()=>{
      const s=await session();const created=await post('/demo/scenarios',s,{scenarioType:type});assert.equal(created.statusCode,201,created.body);const id=created.json().scenarioId;
      error(await run(s,randomUUID(),accept()),409,'DEMO_SCENARIO_MODE_CONFLICT');
      for(let step=1;step<=(type==='FAILURE_RETRY'?9:6);step++){const body={expectedStep:step,requestId:randomUUID()};let r=await post(`/demo/scenarios/${id}/next`,s,body);
        if(type==='LOST_RESPONSE_RECOVERY'&&step===2){assert.equal(r.statusCode,202,r.body);r=await post(`/demo/scenarios/${id}/next`,s,body);}assert.equal(r.statusCode,200,r.body);}
      assert.equal((await pool.query('SELECT status FROM demo_scenario_instances WHERE id=$1',[id])).rows[0].status,'COMPLETED');
    });
    await idle();console.info('DEMO_05B2_EVIDENCE',JSON.stringify({database:name,migrations:13,realPostgres:true,barriers:true,parallelLimit:4,noOpenTransactionDuringExecutor:true}));
  }finally{
    try{await app?.close();if(db){await db.end();await Promise.all(ends);}}
    finally{
      for(const key of ['DATABASE_URL','APP_MODE','NODE_ENV','EXECUTOR_TYPE']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
      try{if(created){const deadline=Date.now()+5000;let rows=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
        while(rows.rowCount&&Date.now()<deadline){await setImmediate();rows=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}
        assert.equal(rows.rowCount,0);assert.match(name,/^demo_05b2_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);
        console.info('DEMO_05B2_TEARDOWN',JSON.stringify({database:name,backends:0,dropped:true,forced:false}));}}
      finally{await admin.end();}
    }
  }
});
