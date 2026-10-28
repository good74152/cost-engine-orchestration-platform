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
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';
import type { ScenarioCreateOptions } from '../src/modules/demo-scenario/demo-scenario.service.js';
import { insertScenario, readScenario } from '../src/modules/demo-scenario/demo-scenario.repository.js';
import { LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE, type AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import { seedDemoGuidedConfiguration } from './seed-demo-guided-configuration.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-02B requires a safe disposable PostgreSQL service');
function connection(name: string) { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); }
function barrier() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; }
class BlockingFake extends FakeExecutor {
  readonly entered = barrier(); readonly finish = barrier();
  override async dispatch(command: DispatchCalculationCommand) {
    const result = await super.dispatch(command); this.entered.release(); await this.finish.promise; return result;
  }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
function error(r: Response, status: number, code: string) {
  assert.equal(r.statusCode, status); assert.equal(r.json().code, code);
  assert.deepEqual(Object.keys(r.json()).sort(), ['code','message']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.body, /token_hash|constraint|SELECT |INSERT |postgresql:\/\//i);
}
const memory = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item instanceof Map ? [...item.entries()] : item instanceof Set ? [...item.values()] : item);

test('Demo-02B: scenario persistence, isolation, idempotency and reset recovery', { timeout: 240_000 }, async (t) => {
  const name = `demo_02b_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0,12)}`;
  assert.match(name, /^demo_02b_test_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const admin = new Client({ connectionString: connection('postgres') });
  const previous = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV, APP_MODE: process.env.APP_MODE, EXECUTOR_TYPE: process.env.EXECUTOR_TYPE };
  const apps: FastifyInstance[] = []; const ends: Promise<void>[] = [];
  let db: Pool | undefined; let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    const migrate = (direction: 'up' | 'down', count?: number) => runner({ databaseUrl: connection(name),
      dir: fileURLToPath(new URL('../migrations/', import.meta.url)), migrationsTable: 'pgmigrations',
      direction, count, singleTransaction: true, checkOrder: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await migrate('up');
    process.env.DATABASE_URL = connection(name); process.env.NODE_ENV = 'test'; process.env.APP_MODE = 'demo'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool }, { buildApp }, { createDatasetVersionService }, { runCalculationJobService }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'), import('../src/modules/dataset-version/dataset-version.service.js'),
      import('../src/modules/calculation-job-run.service.js'),
    ]);
    db = pool; pool.on('connect', (c) => ends.push(new Promise<void>((done) => c.once('end', done))));
    const resetHooks: ResetOptions = { log() {} }; const createHooks: ScenarioCreateOptions = {};
    const assigned: FakeExecutor[] = [];
    const runtime = new DemoRuntime(pool, 'test', { createExecutor: () => assigned.shift() ?? new FakeExecutor() }, resetHooks, createHooks);
    const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false,
      nodeEnvironment: 'test', demoSession: { origin: 'https://demo.test' } }); apps.push(app);
    const post = (url: string, s?: Session, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'x-demo-session': '1', origin: 'https://demo.test', ...(s ? { cookie: s.cookie } : {}) } });
    const get = (url: string, s?: Session) => app.inject({ method: 'GET', url, headers: s ? { cookie: s.cookie } : {} });
    const newSession = async (): Promise<Session> => {
      const r = await post('/demo/sessions'); assert.equal(r.statusCode, 201);
      const header = r.headers['set-cookie']; assert.ok(typeof header === 'string'); const cookie = header.split(';',1)[0]!;
      return { cookie, context: await runtime.sessions.authenticate(cookie, LOCAL_SESSION_COOKIE) };
    };
    const create = (s: Session, payload: unknown = { scenarioType: 'HAPPY_PATH' }) => post('/demo/scenarios', s, payload);
    const reset = (s: Session) => post('/demo/sessions/reset', s);
    const scenarioRows = async (s: Session) => (await pool.query('SELECT id,session_id,scenario_type,status,completed_step,created_at,updated_at FROM demo_scenario_instances WHERE session_id=$1', [s.context.sessionId])).rows;
    const tables = ['demo_scenario_instances','dataset_series','dataset_versions','calculation_jobs','execution_attempts',
      'dataset_build_snapshots','dataset_build_snapshot_dependencies','calculation_types','execution_dependency_definition_versions',
      'execution_dependency_definition_dependencies','pgmigrations'];
    const dump = async () => {
      const state: Record<string, unknown> = {};
      for (const table of tables) state[table] = (await pool.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
      state.sessions = (await pool.query('SELECT id,company_code,created_at,expires_at,revoked_at FROM demo_sessions ORDER BY id')).rows;
      return state;
    };
    const fixtureGraph = async (s: Session) => {
      // SQL/service fixtures for future guided-owned data, not a step API/runner.
      const data = await createDatasetVersionService({ domain: 'CAPEX', companyCode: s.context.companyCode, fiscalYear: 2026, period: 'Q3' });
      const fake = await runtime.executors.forSession(s.context);
      const attempt = await runCalculationJobService(data.calculationJobs[0]!.jobId, fake);
      return { data, fake, attempt };
    };
    console.log('DEMO_02B_RUNTIME', JSON.stringify({ node: process.version, postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
      database: name, migrations: (await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n }));

    await t.test('fresh up, empty supported down and forward again preserve existing schema', async () => {
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 12);
      await migrate('down',5);
      assert.equal((await pool.query("SELECT to_regclass('demo_scenario_instances') AS table_name")).rows[0].table_name, null);
      assert.equal((await pool.query("SELECT to_regclass('demo_sessions') AS table_name")).rows[0].table_name, 'demo_sessions');
      // Representative pre-02B Session/domain data must survive the new up.
      const retained=await newSession();
      await pool.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version)
        VALUES(gen_random_uuid(),'CAPEX',$1,2025,'Q1',0)`,[retained.context.companyCode]);
      const priorSeries=(await pool.query('SELECT to_jsonb(ds) AS row FROM dataset_series ds WHERE company_code=$1',[retained.context.companyCode])).rows;
      const priorSession=(await pool.query('SELECT id,company_code,created_at,expires_at,revoked_at FROM demo_sessions WHERE id=$1',[retained.context.sessionId])).rows;
      await migrate('up'); assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 12);
      assert.deepEqual((await pool.query('SELECT to_jsonb(ds) AS row FROM dataset_series ds WHERE company_code=$1',[retained.context.companyCode])).rows,priorSeries);
      assert.deepEqual((await pool.query('SELECT id,company_code,created_at,expires_at,revoked_at FROM demo_sessions WHERE id=$1',[retained.context.sessionId])).rows,priorSession);
    });

    await t.test('missing seed returns sanitized configuration conflict without auto-seeding or creating a scenario', async () => {
      const s = await newSession(); const before = await dump();
      error(await create(s), 409, 'DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE'); assert.deepEqual(await dump(), before);
      error(await get('/demo/scenarios/current', s), 404, 'DEMO_RESOURCE_UNAVAILABLE');
      assert.equal(runtime.executors.size, 0);
    });
    await seedDemoGuidedConfiguration(pool);

    await t.test('incompatible seed contract is rejected read-only for every compatibility dimension', async () => {
      const s = await newSession();
      const pairs = [
        ["UPDATE calculation_types SET airflow_dag_id='wrong' WHERE domain='CAPEX'", "UPDATE calculation_types SET airflow_dag_id='demo_capex_guided' WHERE domain='CAPEX'"],
        ["UPDATE calculation_types SET is_active=false WHERE domain='CAPEX'", "UPDATE calculation_types SET is_active=true WHERE domain='CAPEX'"],
        ["UPDATE calculation_types SET last_allocated_dependency_definition_version=2 WHERE domain='CAPEX'", "UPDATE calculation_types SET last_allocated_dependency_definition_version=1 WHERE domain='CAPEX'"],
        ["UPDATE execution_dependency_definition_versions SET status='DRAFT'", "UPDATE execution_dependency_definition_versions SET status='PUBLISHED'"],
        ["INSERT INTO execution_dependency_definition_dependencies SELECT id,'DPR' FROM execution_dependency_definition_versions", 'DELETE FROM execution_dependency_definition_dependencies'],
        ["INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES ('CAPEX','OTHER','other')", "DELETE FROM calculation_types WHERE code='OTHER'"],
        ["INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status) SELECT id,2,'DRAFT' FROM calculation_types", 'DELETE FROM execution_dependency_definition_versions WHERE version=2'],
      ];
      for (const [mutation, restore] of pairs) {
        await pool.query(mutation!);
        try { const before = await dump(); error(await create(s),409,'DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE'); assert.deepEqual(await dump(),before); }
        finally { await pool.query(restore!); }
      }
      const definition=(await pool.query('SELECT row_to_json(d) AS item FROM execution_dependency_definition_versions d')).rows[0].item;
      for(const mutation of ['UPDATE execution_dependency_definition_versions SET published_at=NULL',
        'DELETE FROM execution_dependency_definition_versions','UPDATE execution_dependency_definition_versions SET version=2']) {
        await pool.query(mutation);
        try {const before=await dump();error(await create(s),409,'DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE');assert.deepEqual(await dump(),before);}
        finally {
          if(mutation.startsWith('DELETE')) await pool.query(`INSERT INTO execution_dependency_definition_versions
            (id,calculation_type_id,version,status,created_at,published_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [definition.id,definition.calculation_type_id,definition.version,definition.status,definition.created_at,definition.published_at]);
          else await pool.query('UPDATE execution_dependency_definition_versions SET version=1,published_at=$1 WHERE id=$2',[definition.published_at,definition.id]);
        }
      }
    });

    const a = await newSession(); const b = await newSession(); let idA = ''; let idB = '';
    await t.test('initial creation is READY/0 with exact DTO; same-session duplicate returns unchanged original, even after progress/config/data changes', async () => {
      for (const s of [a,b]) {
        const first = await create(s); assert.equal(first.statusCode, 201);
        const item = first.json(); assert.equal(item.status, 'READY'); assert.equal(item.completedStep, 0); assert.equal(item.scenarioType, 'HAPPY_PATH');
        assert.deepEqual(Object.keys(item).sort(), ['scenarioId','scenarioType','status','completedStep','createdAt','updatedAt'].sort());
        assert.ok(Number.isFinite(Date.parse(item.createdAt))); assert.ok(Number.isFinite(Date.parse(item.updatedAt)));
        const rows = await scenarioRows(s); assert.equal(rows.length,1); assert.equal(rows[0].id,item.scenarioId); assert.equal(rows[0].session_id,s.context.sessionId);
        const again = await create(s); assert.equal(again.statusCode,200); assert.deepEqual(again.json(), item);
        if (s === a) idA = item.scenarioId; else idB = item.scenarioId;
      }
      // Persisted progress fixture only: no application progress advancement exists.
      await pool.query("UPDATE demo_scenario_instances SET status='IN_PROGRESS',completed_step=2 WHERE id=$1", [idA]);
      await fixtureGraph(a); await pool.query("UPDATE calculation_types SET is_active=false WHERE domain='CAPEX'");
      try {
        const before = await dump(); const r = await create(a); assert.equal(r.statusCode,200);
        assert.equal(r.json().scenarioId,idA); assert.equal(r.json().status,'IN_PROGRESS'); assert.equal(r.json().completedStep,2);
        assert.deepEqual(await dump(),before);
      } finally { await pool.query("UPDATE calculation_types SET is_active=true WHERE domain='CAPEX'"); }
    });

    await t.test('20 concurrent HTTP creates converge, and direct concurrent service calls use PostgreSQL serialization', async () => {
      const s = await newSession(); const entered = barrier(); const finish = barrier();
      createHooks.beforeCommit = async () => { entered.release(); await finish.promise; };
      const first = Promise.resolve(create(s));
      try {
        await entered.promise;
        const rest = Array.from({ length:19 }, () => Promise.resolve(create(s)));
        finish.release(); delete createHooks.beforeCommit;
        const responses = await Promise.all([first,...rest]);
        assert.equal(responses.filter((r) => r.statusCode===201).length,1);
        assert.equal(responses.filter((r) => r.statusCode===200).length,19);
        assert.equal(new Set(responses.map((r) => r.json().scenarioId)).size,1); assert.equal((await scenarioRows(s)).length,1);
      } finally { finish.release(); delete createHooks.beforeCommit; await first; }
      const direct = await newSession();
      const outcomes = await Promise.all(Array.from({ length:10 }, () => runtime.scenarios.create(direct.context)));
      assert.equal(outcomes.filter((r) => r.created).length,1); assert.equal(new Set(outcomes.map((r) => r.scenario.scenarioId)).size,1);
    });

    await t.test('database unique/FK/type/status/step constraints reject actual invalid writes', async () => {
      for (const [sql, args, code] of [
        ["INSERT INTO demo_scenario_instances(session_id,scenario_type) VALUES ($1,'HAPPY_PATH')", [a.context.sessionId], '23505'],
        ["INSERT INTO demo_scenario_instances(session_id,scenario_type) VALUES ($1,'HAPPY_PATH')", [randomUUID()], '23503'],
        ["UPDATE demo_scenario_instances SET status='BOGUS' WHERE id=$1", [idA], '23514'],
        ["UPDATE demo_scenario_instances SET scenario_type='BOGUS' WHERE id=$1", [idA], '23514'],
        ['UPDATE demo_scenario_instances SET completed_step=-1 WHERE id=$1', [idA], '23514'],
        ['UPDATE demo_scenario_instances SET completed_step=NULL WHERE id=$1', [idA], '23502'],
      ] as const) await assert.rejects(pool.query(sql,[...args]), (e: unknown) => (e as {code?:string}).code===code);
      const s = await newSession(); const left = await pool.connect(); const right = await pool.connect();
      try {
        await left.query('BEGIN'); await right.query('BEGIN'); const one = await insertScenario(left,s.context.sessionId); assert.ok(one);
        const second = insertScenario(right,s.context.sessionId); await left.query('COMMIT');
        assert.equal(await second,null); assert.equal((await readScenario(right,s.context.sessionId))!.scenarioId,one.scenarioId);
        await right.query('COMMIT');
      } finally { await left.query('ROLLBACK'); await right.query('ROLLBACK'); left.release(); right.release(); }
    });

    await t.test('unsupported types/extra identity or progress input/malformed bodies and queries are rejected without writes', async () => {
      const s = await newSession(); const before = await dump();
      for (const body of [{},null,[],{scenarioType:'UNKNOWN'},{scenarioType:'lost_response_recovery'}, {scenarioType:3},
        ...['sessionId','companyCode','scenarioId','status','completedStep','requestId','expectedStep'].map((key) => ({scenarioType:'HAPPY_PATH',[key]:'forged'}))]) {
        error(await create(s,body),400,'INVALID_REQUEST');
      }
      error(await post('/demo/scenarios?limit=1',s,{scenarioType:'HAPPY_PATH'}),400,'INVALID_REQUEST');
      error(await get('/demo/scenarios/current?sessionId=forged',a),400,'INVALID_REQUEST');
      error(await get(`/demo/scenarios/${idA}?limit=1`,a),400,'INVALID_REQUEST'); assert.deepEqual(await dump(),before);
      error(await post(`/demo/scenarios/${idA}/next`,a,{}),400,'INVALID_REQUEST');
      const different = await newSession();
      assert.equal((await create(different)).statusCode,201);
      error(await create(different,{scenarioType:'FAILURE_RETRY'}),409,'DEMO_SCENARIO_TYPE_CONFLICT');
    });

    await t.test('current/by-ID reads are owned; foreign/missing/malformed IDs have identical generic 404', async () => {
      for (const [s,own,foreign] of [[a,idA,idB],[b,idB,idA]] as const) {
        const current = await get('/demo/scenarios/current',s); assert.equal(current.statusCode,200); assert.equal(current.json().scenarioId,own);
        assert.deepEqual((await get(`/demo/scenarios/${own}`,s)).json(),current.json());
        const bodies = [];
        for (const id of [foreign,randomUUID(),'invalid',"' OR true--"]) {
          const r = await get(`/demo/scenarios/${encodeURIComponent(id)}`,s); error(r,404,'DEMO_RESOURCE_UNAVAILABLE'); bodies.push(r.json());
        }
        for (const body of bodies) assert.deepEqual(body,bodies[0]);
      }
    });

    await t.test('auth/cookie clearing/CSRF/Origin protections and core surface remain unchanged', async () => {
      const expired = await newSession(); const revoked = await newSession();
      await create(expired); await create(revoked);
      await pool.query("UPDATE demo_sessions SET created_at=now()-interval '5 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[expired.context.sessionId]);
      await runtime.sessions.revoke(revoked.context.sessionId);
      for (const s of [undefined,expired,revoked,{...a,cookie:`${LOCAL_SESSION_COOKIE}=invalid`}]) {
        for (const r of [await create(s as Session), await get('/demo/scenarios/current',s), await get(`/demo/scenarios/${idA}`,s)]) {
          error(r,401,'DEMO_SESSION_UNAVAILABLE'); assert.match(String(r.headers['set-cookie']),/Max-Age=0/);
        }
      }
      const missingHeader = await app.inject({method:'POST',url:'/demo/scenarios',payload:{scenarioType:'HAPPY_PATH'},headers:{cookie:a.cookie}});
      error(missingHeader,403,'DEMO_SESSION_CSRF_REJECTED');
      for (const headers of [{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'}]) {
        const r = await app.inject({method:'GET',url:'/demo/scenarios/current',headers:{cookie:a.cookie,...headers}});
        error(r,403,'DEMO_SESSION_CSRF_REJECTED'); assert.equal(r.headers['access-control-allow-credentials'],undefined);
      }
      const secure = await buildApp({appMode:'demo',demoRuntime:runtime,logger:false,nodeEnvironment:'test',demoSession:{secureCookies:true}}); apps.push(secure);
      const r = await secure.inject({method:'GET',url:'/demo/scenarios/current',headers:{cookie:expired.cookie.replace(LOCAL_SESSION_COOKIE,SECURE_SESSION_COOKIE)}});
      error(r,401,'DEMO_SESSION_UNAVAILABLE'); assert.match(String(r.headers['set-cookie']),/; Secure/);
      delete process.env.APP_MODE;
      try { const core = await buildApp({appMode:'core',logger:false,nodeEnvironment:'test'}); apps.push(core);
        for (const url of ['/demo/scenarios','/demo/scenarios/current',`/demo/scenarios/${idA}`]) {
          assert.equal((await core.inject({method:'GET',url})).statusCode,404);
          assert.equal((await core.inject({method:'POST',url,payload:{}})).statusCode,404);
        }
      } finally {process.env.APP_MODE='demo';}
    });

    await t.test('existing Free Exploration data refuses first scenario without deleting or changing it', async () => {
      const s = await newSession(); await fixtureGraph(s); const before = await dump();
      error(await create(s),409,'DEMO_SCENARIO_SESSION_NOT_EMPTY'); assert.deepEqual(await dump(),before);
      assert.equal((await scenarioRows(s)).length,0);
    });

    await t.test('unexpected PostgreSQL Scenario insert failure rolls back and returns sanitized internal error', async () => {
      const s=await newSession();const before=await dump();
      await pool.query(`CREATE FUNCTION demo_02b_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'private scenario SQL detail'; END $$;
        CREATE TRIGGER demo_02b_insert_failure BEFORE INSERT ON demo_scenario_instances
        FOR EACH ROW EXECUTE FUNCTION demo_02b_insert_failure()`);
      try {error(await create(s),500,'INTERNAL_SERVER_ERROR');assert.deepEqual(await dump(),before);}
      finally {await pool.query('DROP TRIGGER demo_02b_insert_failure ON demo_scenario_instances; DROP FUNCTION demo_02b_insert_failure()');}
      assert.equal((await create(s)).statusCode,201);
    });

    await t.test('manual admission session lock and all orchestration locks are released before executor dispatch waits', async () => {
      const s=await newSession();const fake=new BlockingFake();assigned.push(fake);
      const data=await post('/demo/dataset-versions',s,{domain:'CAPEX',fiscalYear:2026,period:'Q3'});
      assert.equal(data.statusCode,201);const job=data.json().calculationJobs[0].jobId;
      const running=Promise.resolve(post(`/demo/calculation-jobs/${job}/run`,s));
      const observer=new Client({connectionString:connection(name)});await observer.connect();
      try {await fake.entered.promise;await observer.query('BEGIN');
        await observer.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE NOWAIT',[s.context.sessionId]);
        await observer.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE NOWAIT',[job]);
        await observer.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 FOR UPDATE NOWAIT',[job]);
      } finally {await observer.query('ROLLBACK');await observer.end();fake.finish.release();}
      assert.equal((await running).statusCode,200);
    });

    await t.test('guided sessions reject ALL manual domain and fake mutations inside queue; reads/other sessions remain usable', async () => {
      const graph = (await pool.query('SELECT id,output_dataset_version_id FROM calculation_jobs WHERE output_dataset_version_id IN (SELECT v.id FROM dataset_versions v JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1)',[a.context.companyCode])).rows[0];
      const attempt = (await pool.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1',[graph.id])).rows[0].id;
      const fake = await runtime.executors.forSession(a.context); const before = await dump(); const fakeBefore = memory(fake);
      const requests: [string,unknown][] = [
        ['/demo/dataset-versions',{domain:'CAPEX',fiscalYear:2027,period:'Q1'}],
        ...['submit-validation','publish','reject','abandon'].map((c):[string,unknown] => [`/demo/dataset-versions/${graph.output_dataset_version_id}/${c}`,{}]),
        ...['run','reconcile'].map((c):[string,unknown] => [`/demo/calculation-jobs/${graph.id}/${c}`,{}]),
        ['/demo/fake-executor/dispatch-behavior',{behavior:'REJECT'}], [`/demo/execution-attempts/${attempt}/fake-state`,{state:'FAILED'}],
      ];
      for (const [url,body] of requests) error(await post(url,a,body),409,'DEMO_SCENARIO_MODE_CONFLICT');
      for (const url of ['/demo/dataset-versions',`/demo/dataset-versions/${graph.output_dataset_version_id}`,
        `/demo/dataset-versions/${graph.output_dataset_version_id}/calculation-jobs`,`/demo/calculation-jobs/${graph.id}`,
        `/demo/calculation-jobs/${graph.id}/execution-attempts`]) assert.equal((await get(url,a)).statusCode,200);
      assert.deepEqual(await dump(),before); assert.equal(memory(fake),fakeBefore);
      const free = await newSession(); const r = await post('/demo/dataset-versions',free,{domain:'CAPEX',fiscalYear:2026,period:'Q3'});
      assert.equal(r.statusCode,201); const job = r.json().calculationJobs[0].jobId;
      assert.equal((await post(`/demo/calculation-jobs/${job}/run`,free)).statusCode,200);
      assert.equal((await post(`/demo/calculation-jobs/${job}/reconcile`,free)).statusCode,200);
      assert.equal((await post('/demo/fake-executor/dispatch-behavior',free,{behavior:'REJECT'})).statusCode,200);
    });

    await t.test('scenario-first and manual-first admissions serialize without mode mixing; different session remains independent', async () => {
      const s = await newSession(); const entered = barrier(); const finish = barrier();
      createHooks.beforeCommit = async () => { entered.release(); await finish.promise; };
      const creating = Promise.resolve(create(s));
      try {
        await entered.promise;
        error(await reset(s),409,'RESET_CONFLICT');
        const manual = Promise.resolve(post('/demo/dataset-versions',s,{domain:'CAPEX',fiscalYear:2028,period:'Q1'}));
        assert.equal((await get('/demo/scenarios/current',b)).statusCode,200);
        finish.release(); assert.equal((await creating).statusCode,201); error(await manual,409,'DEMO_SCENARIO_MODE_CONFLICT');
      } finally {finish.release(); delete createHooks.beforeCommit; await creating;}
      const free = await newSession(); const allowed = barrier(); const release = barrier(); const original = runtime.scenarios.assertFreeExploration.bind(runtime.scenarios);
      runtime.scenarios.assertFreeExploration = async (session) => { await original(session); if(session.sessionId===free.context.sessionId){allowed.release();await release.promise;} };
      const manual = Promise.resolve(post('/demo/dataset-versions',free,{domain:'CAPEX',fiscalYear:2028,period:'Q1'}));
      try {await allowed.promise; const scenario = Promise.resolve(create(free)); release.release(); assert.equal((await manual).statusCode,201);
        error(await scenario,409,'DEMO_SCENARIO_SESSION_NOT_EMPTY');
      } finally {release.release(); await manual; runtime.scenarios.assertFreeExploration=original;}
    });

    await t.test('create waits for session row lock then revalidates revocation using a fresh PostgreSQL statement', async () => {
      const s = await newSession(); const locker = new Client({connectionString:connection(name)}); await locker.connect();
      await locker.query('BEGIN'); await locker.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE',[s.context.sessionId]);
      const request = Promise.resolve(create(s));
      try {
        let waiting = false; const deadline = Date.now()+3000;
        while(!waiting && Date.now()<deadline) { waiting = (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
          AND query LIKE 'SELECT id FROM demo_sessions%'`,[name])).rowCount!==0; await setImmediate(); }
        assert.ok(waiting,'Scenario Create must wait for the PostgreSQL session row lock');
        await locker.query('UPDATE demo_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[s.context.sessionId]); await locker.query('COMMIT');
        error(await request,401,'DEMO_SESSION_UNAVAILABLE'); assert.equal((await scenarioRows(s)).length,0);
      } finally {await locker.query('ROLLBACK'); await locker.end(); await request;}
    });

    await t.test('lost Create COMMIT acknowledgement returns unknown, then recovers SAME durable ID; pre-COMMIT transport loss safely retries', async () => {
      const s = await newSession(); let persisted = '';
      createHooks.commit = async (client) => { persisted = (await client.query('SELECT id FROM demo_scenario_instances WHERE session_id=$1',[s.context.sessionId])).rows[0].id;
        await client.query('COMMIT'); throw new Error('lost acknowledgement'); };
      try {error(await create(s),503,'DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN');} finally {delete createHooks.commit;}
      error(await post('/demo/dataset-versions',s,{domain:'CAPEX',fiscalYear:2026,period:'Q3'}),409,'DEMO_SCENARIO_MODE_CONFLICT');
      const retry = await create(s); assert.equal(retry.statusCode,200); assert.equal(retry.json().scenarioId,persisted); assert.equal((await scenarioRows(s)).length,1);
      const rollback = await newSession(); createHooks.commit = async () => {throw new Error('COMMIT not delivered');};
      try {error(await create(rollback),503,'DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN');} finally {delete createHooks.commit;}
      const fresh = await create(rollback); assert.equal(fresh.statusCode,201); assert.equal((await scenarioRows(rollback)).length,1);
    });

    await t.test('populated Scenario down refuses atomically and preserves data/migration marker', async () => {
      const before = await dump(); await assert.rejects(migrate('down',5),/retained scenario data/); assert.deepEqual(await dump(),before);
    });

    await t.test('reset atomically removes owner Scenario/domain graph, revokes and releases fake; other owners/shared configuration survive', async () => {
      const s = await newSession(); await create(s); const graph = await fixtureGraph(s);
      const beforeOther = await scenarioRows(b); const size = runtime.executors.size;
      const shared = (await pool.query('SELECT to_jsonb(t) AS row FROM calculation_types t ORDER BY id')).rows;
      assert.equal((await reset(s)).statusCode,204); assert.equal((await scenarioRows(s)).length,0);
      assert.equal((await pool.query('SELECT id FROM dataset_series WHERE company_code=$1',[s.context.companyCode])).rowCount,0);
      assert.ok((await pool.query('SELECT revoked_at FROM demo_sessions WHERE id=$1',[s.context.sessionId])).rows[0].revoked_at);
      assert.equal(runtime.executors.size,size-1); assert.equal(graph.fake.getExternalExecutions()[0]!.state,'RUNNING');
      assert.deepEqual(await scenarioRows(b),beforeOther); assert.deepEqual((await pool.query('SELECT to_jsonb(t) AS row FROM calculation_types t ORDER BY id')).rows,shared);
    });

    await t.test('PostgreSQL failure AFTER Scenario delete rolls back Scenario/domain/revocation and preserves exact fake state', async () => {
      const s = await newSession(); await create(s); const graph = await fixtureGraph(s); const before = await dump(); const fakeBefore = memory(graph.fake);
      await pool.query(`CREATE FUNCTION demo_02b_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.company_code='${s.context.companyCode}' AND NOT EXISTS(SELECT 1 FROM demo_scenario_instances WHERE session_id='${s.context.sessionId}')
        THEN RAISE EXCEPTION 'failure after scenario delete'; END IF; RETURN OLD; END $$;
        CREATE TRIGGER demo_02b_cleanup_failure BEFORE DELETE ON dataset_series FOR EACH ROW EXECUTE FUNCTION demo_02b_cleanup_failure()`);
      try {error(await reset(s),500,'DEMO_RESET_FAILED'); assert.deepEqual(await dump(),before); assert.equal(memory(graph.fake),fakeBefore);
        assert.equal((await get('/demo/scenarios/current',s)).statusCode,200);
      } finally {await pool.query('DROP TRIGGER demo_02b_cleanup_failure ON dataset_series; DROP FUNCTION demo_02b_cleanup_failure()');}
      assert.equal((await reset(s)).statusCode,204);
    });

    await t.test('reset acknowledgement loss resolves full commit and full rollback including Scenario-only owners', async () => {
      for (const committed of [true,false]) {
        const s = await newSession(); await create(s); const before = await dump();
        resetHooks.commit = async (client) => {if(committed) await client.query('COMMIT'); throw new Error('lost acknowledgment');};
        try {const r=await reset(s); if(committed) assert.equal(r.statusCode,204); else {error(r,500,'DEMO_RESET_FAILED');assert.deepEqual(await dump(),before);} }
        finally {delete resetHooks.commit;}
        assert.equal((await scenarioRows(s)).length,committed ? 0 : 1);
      }
    });

    await t.test('unknown reset MUST NOT declare success when series is gone but Scenario remains; recovery stays blocked', async () => {
      const s = await newSession(); await create(s); await fixtureGraph(s); const size=runtime.executors.size;
      await pool.query(`CREATE FUNCTION demo_02b_keep_scenario() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.session_id='${s.context.sessionId}' THEN RETURN NULL; END IF; RETURN OLD; END $$;
        CREATE TRIGGER demo_02b_keep_scenario BEFORE DELETE ON demo_scenario_instances FOR EACH ROW EXECUTE FUNCTION demo_02b_keep_scenario()`);
      resetHooks.commit=async(client)=>{await client.query('COMMIT');throw new Error('lost acknowledgement');};
      try {error(await reset(s),503,'DEMO_RESET_OUTCOME_UNKNOWN');}
      finally {delete resetHooks.commit;await pool.query('DROP TRIGGER demo_02b_keep_scenario ON demo_scenario_instances; DROP FUNCTION demo_02b_keep_scenario()');}
      assert.equal((await scenarioRows(s)).length,1); assert.equal((await pool.query('SELECT id FROM dataset_series WHERE company_code=$1',[s.context.companyCode])).rowCount,0);
      assert.equal(runtime.executors.size,size); assert.equal(await runtime.reset.recoverPendingResets(),1);
      await assert.rejects(runtime.coordinator.run(s.context,async()=>{}),{code:'DEMO_RESET_OUTCOME_UNKNOWN'});
      // Explicit repair only in the owned fault-injection fixture, never an application auto-repair.
      await pool.query('DELETE FROM demo_scenario_instances WHERE session_id=$1',[s.context.sessionId]);
      assert.equal(await runtime.reset.recoverPendingResets(),0); assert.equal(runtime.executors.size,size-1);
    });

    await t.test('Scenario-only expired/revoked owners are discovered by bounded maintenance without a fake or domain data', async () => {
      const expired=await newSession(); const revoked=await newSession(); await create(expired);await create(revoked);
      await pool.query("UPDATE demo_sessions SET created_at=now()-interval '5 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[expired.context.sessionId]);
      await runtime.sessions.revoke(revoked.context.sessionId);
      const size=runtime.executors.size; const beforeB=await scenarioRows(b);
      const report=await runtime.reset.maintainInactiveSessions(1000); assert.ok(report.cleaned>=2);assert.equal(report.failed,0);assert.equal(report.pending,0);
      assert.equal((await scenarioRows(expired)).length,0);assert.equal((await scenarioRows(revoked)).length,0);
      assert.equal(runtime.executors.size,size);assert.deepEqual(await scenarioRows(b),beforeB);
    });

    await t.test('Reset reservation rejects Create and both GETs; running/queued reads block Reset with shared capacity contracts', async () => {
      const s=await newSession();const id=(await create(s)).json().scenarioId;const entered=barrier();const finish=barrier();
      resetHooks.beforeCommit=async()=>{entered.release();await finish.promise;};const resetting=Promise.resolve(reset(s));
      try {await entered.promise;error(await create(s),409,'RESET_CONFLICT');
        for(const path of ['/demo/scenarios/current',`/demo/scenarios/${id}`]) error(await get(path,s),409,'RESET_CONFLICT');
      } finally {finish.release();delete resetHooks.beforeCommit;}assert.equal((await resetting).statusCode,204);
      const gate=barrier();const readEntered=barrier();const original=runtime.scenarios.get.bind(runtime.scenarios);
      runtime.scenarios.get=async(session,id)=>{const value=await original(session,id);if(session.sessionId===b.context.sessionId){readEntered.release();await gate.promise;}return value;};
      const reading=Promise.resolve(get('/demo/scenarios/current',b));
      try {await readEntered.promise;error(await reset(b),409,'RESET_CONFLICT');assert.equal((await get('/demo/scenarios/current',a)).statusCode,200);}
      finally {gate.release();await reading;runtime.scenarios.get=original;}
      const lease=runtime.coordinator.tryBeginReset(b.context);lease.unknown=true;
      try {error(await create(b),503,'DEMO_RESET_OUTCOME_UNKNOWN');error(await get('/demo/scenarios/current',b),503,'DEMO_RESET_OUTCOME_UNKNOWN');}
      finally {runtime.coordinator.finishReset(lease);}
      const capacity=barrier();const hold=runtime.coordinator.run(b.context,async()=>capacity.promise);
      const queued=Array.from({length:31},()=>runtime.coordinator.run(b.context,async()=>{}));
      try {error(await create(b),429,'DEMO_SESSION_QUEUE_FULL');error(await get('/demo/scenarios/current',b),429,'DEMO_SESSION_QUEUE_FULL');}
      finally {capacity.release();await Promise.all([hold,...queued]);}
    });

    await t.test('repeated GETs never modify Scenario/domain/config/session/fake memory or allocate an executor', async () => {
      const before=await dump();const count=runtime.executors.size;const fake=await runtime.executors.forSession(a.context);const fakeBefore=memory(fake);
      for(let n=0;n<5;n++) for(const [s,id]of [[a,idA],[b,idB]]as const){
        assert.equal((await get('/demo/scenarios/current',s)).statusCode,200);assert.equal((await get(`/demo/scenarios/${id}`,s)).statusCode,200);
      }
      assert.deepEqual(await dump(),before);assert.equal(memory(fake),fakeBefore);assert.equal(runtime.executors.size,count);
    });

    await t.test('restart invalidates old cookies/progress access and never recreates old fake; maintenance removes Scenario-only history', async () => {
      const s=await newSession();const id=(await create(s)).json().scenarioId;await pool.query("UPDATE demo_scenario_instances SET status='IN_PROGRESS',completed_step=1 WHERE id=$1",[id]);
      const fresh=new DemoRuntime(pool,'test',{}, {log(){}});
      // Hold only maintenance, as existing B2 tests do, to inspect durable rows after startup invalidation.
      const maintenance=fresh.reset.maintainInactiveSessions.bind(fresh.reset);
      fresh.reset.maintainInactiveSessions=async()=>{throw new Error('test maintenance unavailable');};
      await fresh.reset.startServer();assert.equal(fresh.executors.size,0);assert.equal((await scenarioRows(s))[0].completed_step,1);
      const restarted=await buildApp({appMode:'demo',demoRuntime:fresh,logger:false,nodeEnvironment:'test'});apps.push(restarted);
      error(await restarted.inject({method:'GET',url:'/demo/scenarios/current',headers:{cookie:s.cookie}}),401,'DEMO_SESSION_UNAVAILABLE');
      const next=await restarted.inject({method:'POST',url:'/demo/sessions',payload:{},headers:{'x-demo-session':'1'}});assert.equal(next.statusCode,201);
      const cookie=String(next.headers['set-cookie']).split(';',1)[0]!;
      error(await restarted.inject({method:'GET',url:`/demo/scenarios/${id}`,headers:{cookie}}),404,'DEMO_RESOURCE_UNAVAILABLE');
      fresh.reset.maintainInactiveSessions=maintenance;await maintenance(1000);assert.equal((await scenarioRows(s)).length,0);assert.equal(fresh.executors.size,0);
    });
  } finally {
    try {await Promise.all(apps.map((app)=>app.close()));if(db){await db.end();await Promise.all(ends);}}
    finally {
      for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      try {if(created){const deadline=Date.now()+5000;let sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
        while(sessions.rowCount&&Date.now()<deadline){await setImmediate();sessions=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}
        assert.equal(sessions.rowCount,0);assert.match(name,/^demo_02b_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);
        console.log('DEMO_02B_TEARDOWN',JSON.stringify({database:name,sessions:0,dropped:true,forced:false}));
      }}finally{await admin.end();}
    }
  }
});
