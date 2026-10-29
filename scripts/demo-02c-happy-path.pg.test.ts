import { admissionMigrationPattern, installHistoricalAdmissionFixture } from './support/demo-admission-historical-fixture.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import { DemoRuntime } from '../src/modules/demo-session/demo-runtime.js';
import type { StepOptions } from '../src/modules/demo-scenario/demo-step.service.js';
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';
import { LOCAL_SESSION_COOKIE, type AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import { seedDemoGuidedConfiguration } from './seed-demo-guided-configuration.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-02C requires an owned disposable PostgreSQL test service');
function connection(name: string) { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); }
function barrier() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; }
class BlockingFake extends FakeExecutor {
  readonly entered = barrier(); readonly finish = barrier();
  override async dispatch(command: DispatchCalculationCommand) {
    const result = await super.dispatch(command); this.entered.release(); await this.finish.promise; return result;
  }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession; id: string; requests: string[] }
interface DomainDump {
  series: { id: string; last_allocated_version: number }[];
  versions: { id: string; version: number; status: string }[];
  jobs: { id: string; status: string }[];
  attempts: { id: string; status: string }[];
  snapshots: { id: string }[];
}
function error(r: Response, status: number, code: string) {
  assert.equal(r.statusCode, status, r.body); assert.equal(r.json().code, code);
  assert.deepEqual(Object.keys(r.json()).sort(), ['code','message']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.body, /token_hash|constraint|SELECT |INSERT |postgresql:|division by zero|private fault/i);
}

test('Demo-02C: durable Happy Path steps, exact recovery and isolated reset', { timeout: 300_000 }, async (t) => {
  const name = `demo_02c_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0,12)}`;
  assert.match(name, /^demo_02c_test_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const admin = new Client({ connectionString: connection('postgres') });
  const previous = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV, APP_MODE: process.env.APP_MODE, EXECUTOR_TYPE: process.env.EXECUTOR_TYPE };
  const apps: FastifyInstance[] = []; const ends: Promise<void>[] = [];
  let db: Pool | undefined; let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    const migrate = (direction: 'up' | 'down', count?: number) => runner({ databaseUrl: connection(name),
      dir: fileURLToPath(new URL('../migrations/', import.meta.url)), migrationsTable: 'pgmigrations',
      direction, count, ignorePattern: admissionMigrationPattern, singleTransaction: true, checkOrder: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await migrate('up');
    await installHistoricalAdmissionFixture(connection(name));
    process.env.DATABASE_URL = connection(name); process.env.NODE_ENV = 'test'; process.env.APP_MODE = 'demo'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool }, { buildApp }] = await Promise.all([import('../src/db/pool.js'), import('../src/app.js')]);
    db = pool; pool.on('connect', (c) => ends.push(new Promise<void>((done) => c.once('end', done))));
    // Abort BEFORE any fixture/seed write if an eager global import bound the
    // core pool to the source service instead of this independently owned DB.
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
    const hooks: StepOptions = {}; const resetHooks: ResetOptions = { log() {} }; const assigned: FakeExecutor[] = [];
    const runtime = new DemoRuntime(pool, 'test', { createExecutor: () => assigned.shift() ?? new FakeExecutor() }, resetHooks, {}, hooks);
    const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false, nodeEnvironment: 'test', demoSession: { origin: 'https://demo.test' } }); apps.push(app);
    const post = (url: string, s?: Session, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'x-demo-session': '1', origin: 'https://demo.test', ...(s ? { cookie: s.cookie } : {}) } });
    const get = (url: string, s?: Session) => app.inject({ method: 'GET', url, headers: s ? { cookie: s.cookie } : {} });
    const newSession = async (scenario = true): Promise<Session> => {
      const r = await post('/demo/sessions'); assert.equal(r.statusCode, 201, r.body);
      const cookie = String(r.headers['set-cookie']).split(';',1)[0]!;
      const s: Session = { cookie, context: await runtime.sessions.authenticate(cookie, LOCAL_SESSION_COOKIE), id: '', requests: Array.from({length:6},()=>randomUUID()) };
      if (scenario) { const result = await post('/demo/scenarios', s, {scenarioType:'HAPPY_PATH'}); assert.equal(result.statusCode,201,result.body); s.id=result.json().scenarioId; }
      return s;
    };
    const next = (s: Session, n: number, requestId = s.requests[n-1]!) => post(`/demo/scenarios/${s.id}/next`,s,{expectedStep:n,requestId});
    const pending = (s: Session) => get(`/demo/scenarios/${s.id}/pending-step`,s);
    const progress = async (s: Session) => (await pool.query('SELECT status,completed_step FROM demo_scenario_instances WHERE id=$1',[s.id])).rows[0];
    const ledgers = async (s: Session) => (await pool.query('SELECT to_jsonb(l) AS item FROM demo_scenario_step_executions l WHERE scenario_id=$1 ORDER BY step_number',[s.id])).rows.map(r=>r.item);
    const domain = async (s: Session) => {
      const state: Record<string,unknown> = {};
      for (const [key, sql] of Object.entries({
        series: 'SELECT to_jsonb(ds) AS item FROM dataset_series ds WHERE company_code=$1',
        versions: 'SELECT to_jsonb(v) AS item FROM dataset_versions v JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1',
        jobs: 'SELECT to_jsonb(j) AS item FROM calculation_jobs j JOIN dataset_versions v ON v.id=j.output_dataset_version_id JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1',
        attempts: 'SELECT to_jsonb(a) AS item FROM execution_attempts a JOIN calculation_jobs j ON j.id=a.calculation_job_id JOIN dataset_versions v ON v.id=j.output_dataset_version_id JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1',
        snapshots: 'SELECT to_jsonb(b) AS item FROM dataset_build_snapshots b JOIN dataset_versions v ON v.id=b.dataset_version_id JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1',
      })) state[key]=(await pool.query(sql,[s.context.companyCode])).rows.map(r=>r.item);
      return state as unknown as DomainDump;
    };
    const through = async (s: Session, n: number) => { for(let step=1;step<=n;step++){const r=await next(s,step);assert.equal(r.statusCode,200,r.body);} };
    const whole = async () => {
      const state: Record<string,unknown> = {};
      for(const table of ['demo_scenario_step_executions','demo_scenario_instances','dataset_series','dataset_versions','calculation_jobs','execution_attempts','dataset_build_snapshots','dataset_build_snapshot_dependencies','calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies','pgmigrations'])
        state[table]=(await pool.query(`SELECT to_jsonb(r) AS item FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
      state.sessions=(await pool.query('SELECT id,company_code,expires_at,revoked_at FROM demo_sessions ORDER BY id')).rows;
      return state;
    };
    console.log('DEMO_02C_RUNTIME',JSON.stringify({node:process.version,postgres:(await pool.query('SHOW server_version')).rows[0].server_version,database:name,migrations:(await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n}));

    await t.test('fresh up, empty ledger down/up and populated down refusal preserve history',async()=>{
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,12);
      await migrate('down',4);assert.equal((await pool.query("SELECT to_regclass('demo_scenario_step_executions') AS name")).rows[0].name,null);
      assert.equal((await pool.query("SELECT to_regclass('demo_scenario_instances') AS name")).rows[0].name,'demo_scenario_instances');
      await seedDemoGuidedConfiguration(pool);const retained=await newSession();const before=await progress(retained);
      await migrate('up');assert.deepEqual(await progress(retained),before);assert.equal((await ledgers(retained)).length,0);
    });
    await seedDemoGuidedConfiguration(pool);
    const happy=await newSession();const original:unknown[]=[];
    await t.test('A: six explicit steps preserve separate Domain, fake, ledger and progress state',async()=>{
      assert.deepEqual(await progress(happy),{status:'READY',completed_step:0});
      for(let n=1;n<=6;n++){
        const r=await next(happy,n);assert.equal(r.statusCode,200,r.body);const dto=r.json();original.push(dto);
        assert.deepEqual(Object.keys(dto).sort(),['scenarioId','stepNumber','requestId','stepStatus','completedStep','scenarioStatus','stepResult'].sort());
        assert.equal(dto.stepNumber,n);assert.equal(dto.completedStep,n);assert.equal(dto.stepStatus,'COMPLETED');assert.equal(dto.requestId,happy.requests[n-1]);
        assert.equal(dto.scenarioStatus,n===6?'COMPLETED':'IN_PROGRESS');assert.equal(r.headers['cache-control'],'no-store');
        assert.doesNotMatch(r.body,/companyCode|airflow|token|intent|last_dispatch_error|command/);
        const d=await domain(happy);assert.equal(d.series.length,1);assert.equal(d.series[0].last_allocated_version,1);assert.equal(d.versions.length,1);assert.equal(d.jobs.length,1);
        assert.equal(d.versions[0].version,1);assert.equal(d.versions[0].status,n===1?'DRAFT':n<5?'BUILDING':n===5?'VALIDATING':'PUBLISHED');
        assert.equal(d.jobs[0].status,n===1?'PENDING':n<4?'RUNNING':'SUCCEEDED');assert.equal(d.attempts.length,n===1?0:1);
        if(n>1)assert.equal(d.attempts[0].status,n<4?'ACCEPTED':'SUCCEEDED');
        if(n===3){const fake=await runtime.executors.forSession(happy.context);assert.equal(fake.getExternalExecutions()[0]!.state,'SUCCEEDED');assert.equal(d.jobs[0].status,'RUNNING');}
        assert.deepEqual(await progress(happy),{status:n===6?'COMPLETED':'IN_PROGRESS',completed_step:n});
        assert.equal((await ledgers(happy)).filter(l=>l.status==='COMPLETED').length,n);
      }
      assert.equal((await runtime.executors.forSession(happy.context)).getDispatchHistory().length,1);
    });
    await t.test('B/C/D: replay returns original results even after step 6, never repeats domain work; wrong step/request rejected',async()=>{
      const before=await whole();const fake=await runtime.executors.forSession(happy.context);const history=fake.getDispatchHistory().length;const lookups=fake.getStatusLookupHistory().length;
      for(let n=1;n<=6;n++){const r=await next(happy,n);assert.equal(r.statusCode,200);assert.deepEqual(r.json(),original[n-1]);error(await next(happy,n,randomUUID()),409,'DEMO_SCENARIO_STEP_CONFLICT');}
      error(await next(happy,7,randomUUID()),400,'INVALID_REQUEST');
      assert.deepEqual(await whole(),before);assert.equal(fake.getDispatchHistory().length,history);assert.equal(fake.getStatusLookupHistory().length,lookups);
      const fresh=await newSession();error(await next(fresh,2),409,'DEMO_SCENARIO_STEP_CONFLICT');assert.equal((await ledgers(fresh)).length,0);
      await through(fresh,1);error(await next(fresh,3),409,'DEMO_SCENARIO_STEP_CONFLICT');error(await next(fresh,2,fresh.requests[0]),409,'DEMO_SCENARIO_STEP_CONFLICT');
    });
    await t.test('schema rejects invalid state, ownership/parent bindings, duplicate step/request and retained down atomically',async()=>{
      const before=await whole();await assert.rejects(migrate('down',4),/retained ledger data/);assert.deepEqual(await whole(),before);
      const a=await newSession();await through(a,1);const b=await newSession();await through(b,1);
      const aResult=(await ledgers(a))[0].result.stepResult;const bResult=(await ledgers(b))[0].result.stepResult;
      const insert=(step:number,id:string,intent:unknown,status='PENDING',result:unknown=null,at:Date|null=null)=>pool.query(`INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent,status,result,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.id,step,id,intent,status,result,at]);
      const intent={datasetVersionId:aResult.datasetVersionId,jobId:aResult.jobId};
      for(const invalid of [()=>insert(0,randomUUID(),intent),()=>insert(7,randomUUID(),intent),()=>insert(2,randomUUID(),intent,'WRONG'),
        ()=>insert(2,randomUUID(),intent,'COMPLETED',{},new Date()),()=>insert(2,randomUUID(),intent,'PENDING',{}),
        ()=>insert(2,randomUUID(),{datasetVersionId:bResult.datasetVersionId,jobId:bResult.jobId}),
        ()=>insert(2,a.requests[0]!,intent)])await assert.rejects(invalid);
      hooks.beforeCommit=async(phase,c)=>{if(phase==='B')await c.query('SELECT 1/0');};
      try{error(await next(a,2),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeCommit;}
      const ledger=(await ledgers(a))[1];
      await assert.rejects(insert(2,randomUUID(),intent),e=>(e as {code:string}).code==='23505');
      await assert.rejects(pool.query('UPDATE demo_scenario_step_executions SET intent=$2 WHERE id=$1',[ledger.id,{...intent,jobId:bResult.jobId}]));
      await assert.rejects(pool.query("UPDATE demo_scenario_step_executions SET result='{}',status='COMPLETED',completed_at=now() WHERE id=$1",[ledger.id]));
      const invalidResult={scenarioId:a.id,stepNumber:2,requestId:a.requests[1],stepStatus:'COMPLETED',completedStep:2,scenarioStatus:'IN_PROGRESS',
        stepResult:{...intent,executionAttemptId:(await domain(a)).attempts[0]!.id,datasetStatus:'DRAFT',jobStatus:'PENDING',attemptStatus:'ACCEPTED'}};
      await assert.rejects(pool.query("UPDATE demo_scenario_step_executions SET result=$2,status='COMPLETED',completed_at=now() WHERE id=$1",[ledger.id,invalidResult]));
      assert.equal((await next(a,2)).statusCode,200);
      await assert.rejects(pool.query('UPDATE demo_scenario_step_executions SET created_at=now() WHERE id=$1',[ledger.id]));
    });
    for(let n=1;n<=6;n++)await t.test(`E-J/L: step ${n} domain success survives real Transaction B failure; same request fills progress only`,async()=>{
      const s=await newSession();await through(s,n-1);
      hooks.beforeCommit=async(phase,c)=>{if(phase==='B')await c.query('SELECT 1/0');};
      try{error(await next(s,n),500,'INTERNAL_SERVER_ERROR');}finally{delete hooks.beforeCommit;}
      assert.equal((await progress(s)).completed_step,n-1);const l=(await ledgers(s))[n-1];assert.equal(l.status,'PENDING');assert.equal(l.result,null);assert.equal(l.completed_at,null);
      const before=await domain(s);const fake=n>1?await runtime.executors.forSession(s.context):undefined;
      const dispatches=fake?.getDispatchHistory().length;const lookups=fake?.getStatusLookupHistory().length;
      if(n===3){assert.equal(fake!.getExternalExecutions()[0]!.state,'SUCCEEDED');assert.equal(before.jobs[0].status,'RUNNING');assert.equal(before.attempts[0].status,'ACCEPTED');}
      const r=await next(s,n);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().completedStep,n);
      assert.deepEqual(await domain(s),before);if(fake)assert.equal(fake.getDispatchHistory().length,dispatches);
      if(n===4)assert.equal(fake!.getStatusLookupHistory().length,lookups);
      if(n===6)assert.deepEqual(await progress(s),{status:'COMPLETED',completed_step:6});
      assert.equal((await domain(s)).series[0].last_allocated_version,1);
    });
    await t.test('K: real PostgreSQL intent insert failure rolls back A; no ledger or domain operation',async()=>{
      const s=await newSession();const before=await whole();
      await pool.query(`CREATE FUNCTION fixture_intent_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private fault'; END $$;
        CREATE TRIGGER fixture_intent_fail BEFORE INSERT ON demo_scenario_step_executions FOR EACH ROW EXECUTE FUNCTION fixture_intent_fail()`);
      try{error(await next(s,1),500,'INTERNAL_SERVER_ERROR');assert.deepEqual(await whole(),before);assert.equal((await ledgers(s)).length,0);}
      finally{await pool.query('DROP TRIGGER fixture_intent_fail ON demo_scenario_step_executions; DROP FUNCTION fixture_intent_fail()');}
      assert.equal((await next(s,1)).statusCode,200);
    });
    await t.test('M: lost A/B COMMIT acknowledgements are resolved from durable locks/ledger, not error guesses',async()=>{
      for(const phase of ['A','B'] as const)for(const commit of [true,false]){
        const s=await newSession();let injected=false;
        hooks.commit=async(p,c)=>{await c.query(p===phase?(commit?'COMMIT':'ROLLBACK'):'COMMIT');if(p===phase&&!injected){injected=true;throw new Error('lost commit acknowledgement');}};
        let r:Response;try{r=await next(s,1);}finally{delete hooks.commit;}
        if(commit){assert.equal(r.statusCode,200,r.body);assert.equal((await ledgers(s))[0].status,'COMPLETED');}
        else{error(r,503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');assert.equal((await progress(s)).completed_step,0);assert.equal((await domain(s)).versions.length,phase==='A'?0:1);
          const retry=await next(s,1);assert.equal(retry.statusCode,200,retry.body);}
        assert.equal((await domain(s)).versions.length,1);assert.equal((await domain(s)).series[0].last_allocated_version,1);
      }
    });
    await t.test('M: unresolved A and B outcomes discard suspect sockets, fail closed, and recover on same request',async()=>{
      for(const phase of ['A','B'] as const){
        const s=await newSession();hooks.commit=async(p,c)=>{await c.query('COMMIT');if(p===phase)throw new Error('lost acknowledgement');};
        hooks.recoveryClient=()=>{const url=new URL(connection(name));url.port='1';return new Client({connectionString:url.toString(),connectionTimeoutMillis:100});};
        try{error(await next(s,1),503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');}finally{delete hooks.commit;delete hooks.recoveryClient;}
        assert.equal((await domain(s)).versions.length,phase==='A'?0:1);
        const r=await next(s,1);assert.equal(r.statusCode,200,r.body);assert.equal((await domain(s)).versions.length,1);
      }
    });
    await t.test('UNKNOWN dispatch keeps ledger PENDING/202, browser can read request ID, recovery uses SAME attempt/external identity',async()=>{
      const s=await newSession();await through(s,1);const fake=await runtime.executors.forSession(s.context);fake.enqueueBehaviors('ACCEPT_THEN_UNKNOWN');
      const r=await next(s,2);assert.equal(r.statusCode,202,r.body);assert.equal(r.json().stepStatus,'PENDING');assert.equal(r.json().stepResult.attemptStatus,'DISPATCHING');
      assert.equal((await progress(s)).completed_step,1);const before=await whole();const history=fake.getStatusLookupHistory().length;
      const expected={pendingStep:{stepNumber:2,requestId:s.requests[1]}};
      for(let n=0;n<3;n++)assert.deepEqual((await pending(s)).json(),expected);
      assert.deepEqual(await whole(),before);assert.equal(fake.getStatusLookupHistory().length,history);
      const other=await newSession();error(await get(`/demo/scenarios/${s.id}/pending-step`,other),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await next(s,2,randomUUID()),409,'DEMO_SCENARIO_STEP_CONFLICT');error(await next(s,3),409,'DEMO_SCENARIO_STEP_CONFLICT');
      const recovered=await next(s,2);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().stepResult.executionAttemptId,r.json().stepResult.executionAttemptId);
      const dispatch=fake.getDispatchHistory();assert.equal(dispatch.length,2);assert.equal(dispatch[0]!.airflowDagRunId,dispatch[1]!.airflowDagRunId);
      assert.equal(fake.getExternalExecutions().length,1);assert.equal((await domain(s)).attempts.length,1);assert.deepEqual((await pending(s)).json(),{pendingStep:null});
    });
    await t.test('recovery waits out prior unacknowledged job writes before deciding whether a Run is safe',async()=>{
      const s=await newSession();await through(s,1);
      const {prepareCalculationJobRunService}=await import('../src/modules/calculation-job-preparation.service.js');
      const job=(await domain(s)).jobs[0]!;const prepared=await prepareCalculationJobRunService(job.id);
      const writer=new Client({connectionString:connection(name)});await writer.connect();
      await writer.query('BEGIN');await writer.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE',[job.id]);
      // Simulate an earlier definite rejection whose transaction has not settled
      // yet. Recovery must wait and observe this, never allocate attempt 2.
      await writer.query("UPDATE execution_attempts SET status='DISPATCH_FAILED',finished_at=now() WHERE id=$1",[prepared.executionAttemptId]);
      const nextRequest=Promise.resolve(next(s,2));let observed=false;
      try{
        const deadline=Date.now()+5000;
        while(Date.now()<deadline){const waiting=await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1
          AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM calculation_jobs WHERE id=%'`,[name]);if(waiting.rowCount){observed=true;break;}await setImmediate();}
        assert.ok(observed,'recovery must actually wait on the prior job lock');await writer.query('COMMIT');
        error(await nextRequest,409,'DEMO_SCENARIO_STATE_CONFLICT');assert.equal((await domain(s)).attempts.length,1);assert.equal(runtime.executors.sessionIds().includes(s.context.sessionId),false);
      }finally{await writer.query('ROLLBACK').catch(()=>{});await writer.end();await nextRequest;}
    });
    await t.test('definite rejection cannot be blindly retried into a new Happy Path attempt; contradictions fail closed',async()=>{
      const s=await newSession();await through(s,1);const fake=await runtime.executors.forSession(s.context);fake.enqueueBehaviors('REJECT');
      error(await next(s,2),409,'DEMO_SCENARIO_STATE_CONFLICT');error(await next(s,2),409,'DEMO_SCENARIO_STATE_CONFLICT');
      assert.equal((await domain(s)).attempts.length,1);assert.equal(fake.getDispatchHistory().length,1);assert.equal((await progress(s)).completed_step,1);
      const partial=await newSession();await pool.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version) VALUES(gen_random_uuid(),'CAPEX',$1,2026,'Q4',1)`,[partial.context.companyCode]);
      error(await next(partial,1),409,'DEMO_SCENARIO_STATE_CONFLICT');assert.equal((await domain(partial)).versions.length,0);
    });
    await t.test('N/P: deterministic queued duplicates/conflicts/next-step and Reset; no Scenario locks during executor dispatch',async()=>{
      const s=await newSession();await through(s,1);const fake=new BlockingFake();assigned.push(fake);
      const first=Promise.resolve(next(s,2));await fake.entered.promise;
      try{
        const probe=new Client({connectionString:connection(name)});await probe.connect();
        try{await probe.query('BEGIN');await probe.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE NOWAIT',[s.context.sessionId]);
          await probe.query('SELECT id FROM demo_scenario_instances WHERE id=$1 FOR UPDATE NOWAIT',[s.id]);
          await probe.query('SELECT id FROM demo_scenario_step_executions WHERE scenario_id=$1 FOR UPDATE NOWAIT',[s.id]);
          const d=await domain(s);await probe.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE NOWAIT',[d.jobs[0].id]);await probe.query('SELECT id FROM execution_attempts WHERE id=$1 FOR UPDATE NOWAIT',[d.attempts[0].id]);await probe.query('ROLLBACK');
        }finally{await probe.end();}
        error(await post('/demo/sessions/reset',s),409,'RESET_CONFLICT');
        const same=Promise.resolve(next(s,2));const different=Promise.resolve(next(s,2,randomUUID()));
        // A still-unconfirmed next step must fail, not skip. This call queues;
        // after step 2 completes, step 4 is still an invalid skip.
        const skip=Promise.resolve(next(s,4));fake.finish.release();
        const results=await Promise.all([first,same,different,skip]);assert.equal(results[0]!.statusCode,200,results[0]!.body);assert.deepEqual(results[1]!.json(),results[0]!.json());
        error(results[2]!,409,'DEMO_SCENARIO_STEP_CONFLICT');error(results[3]!,409,'DEMO_SCENARIO_STEP_CONFLICT');
        assert.equal((await domain(s)).attempts.length,1);assert.equal(fake.getDispatchHistory().length,1);
      }finally{fake.finish.release();await first;}
    });
    await t.test('N: step 3 queued behind unresolved step 2 conflicts, two same-ID retries reuse the sole durable attempt',async()=>{
      const s=await newSession();await through(s,1);const fake=new BlockingFake({defaultBehavior:'UNKNOWN_WITHOUT_CREATION'});assigned.push(fake);
      const first=Promise.resolve(next(s,2));await fake.entered.promise;
      const later=Promise.resolve(next(s,3));const same=Promise.resolve(next(s,2));fake.finish.release();
      const results=await Promise.all([first,later,same]);assert.equal(results[0]!.statusCode,202);error(results[1]!,409,'DEMO_SCENARIO_STEP_CONFLICT');assert.equal(results[2]!.statusCode,202);
      assert.equal((await domain(s)).attempts.length,1);assert.equal((await ledgers(s)).length,2);assert.equal(fake.getExternalExecutions().length,0);
      assert.equal(fake.getDispatchHistory()[0]!.airflowDagRunId,fake.getDispatchHistory()[1]!.airflowDagRunId);
    });
    await t.test('O: different sessions execute independently and cannot read/mutate each other or share ledger/fake state',async()=>{
      const a=await newSession();const b=await newSession();await Promise.all([through(a,1),through(b,1)]);
      const fake=new BlockingFake();assigned.push(fake);const running=Promise.resolve(next(a,2));await fake.entered.promise;
      try{assert.equal((await next(b,2)).statusCode,200);const other=await runtime.executors.forSession(b.context);assert.notEqual(other,fake);
        assert.notEqual((await ledgers(a))[1].id,(await ledgers(b))[1].id);assert.equal(other.getExternalExecutions().length,1);
      }finally{fake.finish.release();assert.equal((await running).statusCode,200);}
      error(await post(`/demo/scenarios/${b.id}/next`,a,{expectedStep:3,requestId:randomUUID()}),404,'DEMO_RESOURCE_UNAVAILABLE');
      const d=await domain(b);error(await get(`/demo/dataset-versions/${d.versions[0].id}`,a),404,'DEMO_RESOURCE_UNAVAILABLE');error(await get(`/demo/calculation-jobs/${d.jobs[0].id}`,a),404,'DEMO_RESOURCE_UNAVAILABLE');
    });
    await t.test('executor unavailability or missing/contradictory fake never completes the step or invents DB failure',async()=>{
      const s=await newSession();await through(s,2);const fake=await runtime.executors.forSession(s.context);fake.setStatusLookupUnavailable('private diagnostic');
      error(await next(s,3),503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');assert.equal((await progress(s)).completed_step,2);fake.clearStatusLookupUnavailable();assert.equal((await next(s,3)).statusCode,200);
      fake.setStatusLookupUnavailable('private diagnostic');const before=await domain(s);error(await next(s,4),503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN');assert.deepEqual(await domain(s),before);fake.clearStatusLookupUnavailable();assert.equal((await next(s,4)).statusCode,200);
      const failed=await newSession();await through(failed,2);const own=await runtime.executors.forSession(failed.context);const execution=own.getExternalExecutions()[0]!;own.setExecutionState(execution,'FAILED');
      error(await next(failed,3),409,'DEMO_SCENARIO_STATE_CONFLICT');assert.equal((await domain(failed)).jobs[0].status,'RUNNING');
      const missing=await newSession();await through(missing,2);runtime.executors.releaseSession(missing.context.sessionId);
      error(await next(missing,3),409,'DEMO_SCENARIO_STATE_CONFLICT');assert.equal((await runtime.executors.forSession(missing.context)).getExternalExecutions().length,0);
    });
    await t.test('security and exact route contracts: 400/401/403/404, guided manual writes remain blocked, core has no Next',async()=>{
      const s=await newSession();
      for(const body of [{},{expectedStep:1,requestId:'bad'},{expectedStep:1.1,requestId:randomUUID()},{expectedStep:'1',requestId:randomUUID()},
        {expectedStep:1,requestId:randomUUID(),companyCode:s.context.companyCode},{expectedStep:1,requestId:randomUUID(),jobId:randomUUID()}])error(await post(`/demo/scenarios/${s.id}/next`,s,body),400,'INVALID_REQUEST');
      error(await post(`/demo/scenarios/${s.id}/next`,undefined,{expectedStep:1,requestId:randomUUID()}),401,'DEMO_SESSION_UNAVAILABLE');
      error(await app.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,headers:{cookie:s.cookie},payload:{expectedStep:1,requestId:randomUUID()}}),403,'DEMO_SESSION_CSRF_REJECTED');
      error(await app.inject({method:'GET',url:`/demo/scenarios/${s.id}/pending-step`,headers:{cookie:s.cookie,origin:'https://foreign.test'}}),403,'DEMO_SESSION_CSRF_REJECTED');
      error(await get(`/demo/scenarios/${s.id}/pending-step?extra=1`,s),400,'INVALID_REQUEST');error(await get('/demo/scenarios/invalid/pending-step',s),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await post(`/demo/scenarios/${randomUUID()}/next`,s,{expectedStep:1,requestId:randomUUID()}),404,'DEMO_RESOURCE_UNAVAILABLE');
      error(await post('/demo/dataset-versions',s,{domain:'CAPEX',fiscalYear:2026,period:'Q4'}),409,'DEMO_SCENARIO_MODE_CONFLICT');
      const exploration=await newSession(false);assert.equal((await post('/demo/dataset-versions',exploration,{domain:'CAPEX',fiscalYear:2026,period:'Q2'})).statusCode,201);
      await pool.query("UPDATE calculation_types SET is_active=false WHERE code='DEMO_GUIDED_SUMMARY'");
      try{const before=await whole();error(await next(s,1),409,'DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE');assert.deepEqual(await whole(),before);}
      finally{await pool.query("UPDATE calculation_types SET is_active=true WHERE code='DEMO_GUIDED_SUMMARY'");}
      const old=process.env.APP_MODE;delete process.env.APP_MODE;try{const core=await buildApp({logger:false,nodeEnvironment:'test',appMode:'core'});apps.push(core);assert.equal((await core.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,payload:{}})).statusCode,404);}finally{process.env.APP_MODE=old;}
      await runtime.sessions.revoke(s.context.sessionId);const r=await next(s,1);error(r,401,'DEMO_SESSION_UNAVAILABLE');assert.match(String(r.headers['set-cookie']),/Max-Age=0/);
    });
    await t.test('Next/pending preserve queue-full and normal/unknown Reset admission contracts',async()=>{
      const s=await newSession();const entered=barrier();const finish=barrier();
      const head=runtime.coordinator.run(s.context,async()=>{entered.release();await finish.promise;});await entered.promise;
      const queued=Array.from({length:31},()=>runtime.coordinator.run(s.context,async()=>{}));
      try{error(await next(s,1),429,'DEMO_SESSION_QUEUE_FULL');error(await pending(s),429,'DEMO_SESSION_QUEUE_FULL');}
      finally{finish.release();await Promise.all([head,...queued]);}
      const lease=runtime.coordinator.tryBeginReset(s.context);
      try{error(await next(s,1),409,'RESET_CONFLICT');lease.unknown=true;error(await next(s,1),503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await pending(s),503,'DEMO_RESET_OUTCOME_UNKNOWN');}
      finally{runtime.coordinator.finishReset(lease);}
    });
    await t.test('Q: Reset removes ledger before Scenario/domain in ONE transaction; real later failure restores ALL and fake',async()=>{
      const s=await newSession();await through(s,3);const other=await newSession();await through(other,2);const otherBefore=await domain(other);const otherLedger=await ledgers(other);
      const before=await whole();const fake=await runtime.executors.forSession(s.context);
      await pool.query(`CREATE FUNCTION fixture_cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private fault'; END $$;
        CREATE TRIGGER fixture_cleanup_fail BEFORE DELETE ON dataset_series FOR EACH ROW EXECUTE FUNCTION fixture_cleanup_fail()`);
      try{error(await post('/demo/sessions/reset',s),500,'DEMO_RESET_FAILED');assert.deepEqual(await whole(),before);assert.equal(await runtime.executors.forSession(s.context),fake);}
      finally{await pool.query('DROP TRIGGER fixture_cleanup_fail ON dataset_series; DROP FUNCTION fixture_cleanup_fail()');}
      assert.equal((await post('/demo/sessions/reset',s)).statusCode,204);assert.equal((await ledgers(s)).length,0);assert.equal(await progress(s),undefined);
      assert.equal((await domain(s)).series.length,0);assert.ok(!runtime.executors.sessionIds().includes(s.context.sessionId));assert.deepEqual(await domain(other),otherBefore);assert.deepEqual(await ledgers(other),otherLedger);
    });
    await t.test('Q: unknown Reset committed/rolled back outcomes retain or release ledger/fake only after durable confirmation',async()=>{
      for(const commit of [true,false]){
        const s=await newSession();await through(s,2);const before=await whole();const fake=await runtime.executors.forSession(s.context);
        resetHooks.commit=async c=>{await c.query(commit?'COMMIT':'ROLLBACK');throw new Error('lost acknowledgement');};
        try{const r=await post('/demo/sessions/reset',s);if(commit){assert.equal(r.statusCode,204,r.body);assert.equal((await ledgers(s)).length,0);assert.ok(!runtime.executors.sessionIds().includes(s.context.sessionId));}
          else{error(r,500,'DEMO_RESET_FAILED');assert.deepEqual(await whole(),before);assert.equal(await runtime.executors.forSession(s.context),fake);}}
        finally{delete resetHooks.commit;}
      }
      const s=await newSession();await through(s,2);const fake=await runtime.executors.forSession(s.context);
      resetHooks.commit=async c=>{
        await c.query('ROLLBACK');
        // Fault fixture: financial graph is absent, but Scenario AND ledger
        // remain. Revocation alone must not release the retained fake/lease.
        const d=await domain(s);const fixture=await pool.connect();
        try{await fixture.query('BEGIN');
          await fixture.query('DELETE FROM execution_attempts WHERE calculation_job_id=$1',[d.jobs[0]!.id]);
          await fixture.query('DELETE FROM dataset_build_snapshots WHERE dataset_version_id=$1',[d.versions[0]!.id]);
          await fixture.query('DELETE FROM calculation_jobs WHERE id=$1',[d.jobs[0]!.id]);
          await fixture.query('DELETE FROM dataset_versions WHERE id=$1',[d.versions[0]!.id]);
          await fixture.query('DELETE FROM dataset_series WHERE id=$1',[d.series[0]!.id]);
          await fixture.query('UPDATE demo_sessions SET revoked_at=now() WHERE id=$1',[s.context.sessionId]);await fixture.query('COMMIT');
        }catch(e){await fixture.query('ROLLBACK');throw e;}finally{fixture.release();}
        throw new Error('lost acknowledgement');
      };
      try{error(await post('/demo/sessions/reset',s),503,'DEMO_RESET_OUTCOME_UNKNOWN');assert.equal((await domain(s)).series.length,0);assert.equal((await ledgers(s)).length,2);assert.ok(runtime.executors.sessionIds().includes(s.context.sessionId));
        assert.equal(await runtime.reset.recoverPendingResets(),1);assert.equal(fake.getExternalExecutions().length,1);
      }finally{delete resetHooks.commit;}
      // Repair only the injected partial-revocation fixture, not application data.
      await pool.query('UPDATE demo_sessions SET revoked_at=NULL WHERE id=$1',[s.context.sessionId]);assert.equal(await runtime.reset.recoverPendingResets(),0);
    });
    await t.test('inactive cleanup removes pending/completed ledgers with their Scenario and owned graph',async()=>{
      const s=await newSession();await through(s,2);await runtime.sessions.revoke(s.context.sessionId);
      await runtime.reset.cleanupInactiveSession(s.context.sessionId);assert.equal((await ledgers(s)).length,0);assert.equal((await domain(s)).series.length,0);assert.equal(await progress(s),undefined);
    });
    await t.test('R: restart invalidates old cookies, new session cannot recover old requests, no fake memory is recreated',async()=>{
      const s=await newSession();await through(s,2);const fresh=new DemoRuntime(pool,'test',{}, {log(){}});
      const maintenance=fresh.reset.maintainInactiveSessions.bind(fresh.reset);fresh.reset.maintainInactiveSessions=async()=>{throw new Error('fixture unavailable');};
      await fresh.reset.startServer();assert.equal(fresh.executors.size,0);assert.equal((await ledgers(s)).length,2);
      const restarted=await buildApp({appMode:'demo',demoRuntime:fresh,logger:false,nodeEnvironment:'test'});apps.push(restarted);
      error(await restarted.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,headers:{cookie:s.cookie,'x-demo-session':'1'},payload:{expectedStep:2,requestId:s.requests[1]}}),401,'DEMO_SESSION_UNAVAILABLE');
      const created=await restarted.inject({method:'POST',url:'/demo/sessions',headers:{'x-demo-session':'1'},payload:{}});assert.equal(created.statusCode,201);
      const cookie=String(created.headers['set-cookie']).split(';',1)[0]!;
      error(await restarted.inject({method:'POST',url:`/demo/scenarios/${s.id}/next`,headers:{cookie,'x-demo-session':'1'},payload:{expectedStep:2,requestId:s.requests[1]}}),404,'DEMO_RESOURCE_UNAVAILABLE');
      assert.equal(fresh.executors.size,0);fresh.reset.maintainInactiveSessions=maintenance;await maintenance(1000);assert.equal((await ledgers(s)).length,0);
    });
  } finally {
    try { await Promise.all(apps.map(a=>a.close()));if(db){await db.end();await Promise.all(ends);} }
    finally {
      for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      try{if(created){const deadline=Date.now()+5000;let sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
        while(sessions.rowCount&&Date.now()<deadline){await setImmediate();sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}
        assert.equal(sessions.rowCount,0);assert.match(name,/^demo_02c_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);
        console.log('DEMO_02C_TEARDOWN',JSON.stringify({database:name,sessions:0,dropped:true,forced:false}));
      }}finally{await admin.end();}
    }
  }
});
