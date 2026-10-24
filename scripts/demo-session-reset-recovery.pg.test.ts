import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import Fastify, { type FastifyInstance } from 'fastify';
import { DemoRuntime } from '../src/modules/demo-session/demo-runtime.js';
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';
import { DemoSessionService, LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE, type AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import { demoSessionRoutes } from '../src/modules/demo-session/demo-session.route.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo reset tests require a safe disposable PostgreSQL service');
function connection(name: string) { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); }
function barrier() {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, release: () => resolve() };
}
class BarrierFake extends FakeExecutor {
  readonly entered = barrier(); readonly finish = barrier();
  override async dispatch(command: DispatchCalculationCommand) {
    const result = await super.dispatch(command);
    this.entered.release(); await this.finish.promise; return result;
  }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
function error(response: Response, status: number, code: string) {
  assert.equal(response.statusCode, status); assert.equal(response.json().code, code);
  assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'message']);
  assert.doesNotMatch(response.body, /token_hash|constraint|SELECT |INSERT |postgresql:\/\//i);
}
function cleared(response: Response, secure = false) {
  const cookie = response.headers['set-cookie'];
  assert.ok(typeof cookie === 'string', 'Expected clearing cookie without displaying credentials');
  assert.ok(cookie.startsWith(`${secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE}=;`));
  assert.match(cookie, /Max-Age=0/); assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.includes('; Secure'), secure); assert.doesNotMatch(cookie, /Domain=/i);
}

test('Demo-01B-2: scoped reset and failure recovery on real PostgreSQL', { timeout: 240_000 }, async (t) => {
  const name = `demo_01b2_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^demo_01b2_test_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const prior = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV,
    APP_MODE: process.env.APP_MODE, EXECUTOR_TYPE: process.env.EXECUTOR_TYPE };
  const admin = new Client({ connectionString: connection('postgres') });
  const apps: FastifyInstance[] = []; const ends: Promise<void>[] = [];
  let db: Pool | undefined; let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await runner({ databaseUrl: connection(name), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true,
      checkOrder: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.env.DATABASE_URL = connection(name); process.env.NODE_ENV = 'test';
    delete process.env.APP_MODE; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool }, { buildApp }] = await Promise.all([import('../src/db/pool.js'), import('../src/app.js')]);
    db = pool;
    pool.on('connect', (client) => { ends.push(new Promise<void>((done) => client.once('end', done))); });
    const events: { event: string; sessionId?: string }[] = [];
    const hooks: ResetOptions = { log: (event, sessionId) => { events.push({ event, sessionId }); } };
    const assigned: FakeExecutor[] = [];
    const runtime = new DemoRuntime(pool, 'test', { createExecutor: () => assigned.shift() ?? new FakeExecutor() }, hooks);
    const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false,
      nodeEnvironment: 'test', demoSession: { origin: 'https://demo.test' } }); apps.push(app);
    const post = (url: string, session?: Session, payload: unknown = {}, target = app) => target.inject({
      method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json',
        'x-demo-session': '1', origin: 'https://demo.test', ...(session ? { cookie: session.cookie } : {}) },
    });
    const current = (session: Session, target = app) => target.inject({ method: 'GET', url: '/demo/sessions/current', headers: { cookie: session.cookie } });
    const newSession = async (target = app, secure = false): Promise<Session> => {
      const response = await post('/demo/sessions', undefined, {}, target); assert.equal(response.statusCode, 201);
      const header = response.headers['set-cookie']; assert.ok(typeof header === 'string');
      const cookie = header.split(';', 1)[0]!;
      return { cookie, context: await runtime.sessions.authenticate(cookie, secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE) };
    };
    const create = async (session: Session, domain = 'DPR') => {
      const response = await post('/demo/dataset-versions', session, { domain, fiscalYear: 2026, period: 'Q3' });
      assert.equal(response.statusCode, 201); const data = response.json();
      return { ...data, jobId: data.calculationJobs[0].jobId as string };
    };
    const run = (session: Session, job: string) => post(`/demo/calculation-jobs/${job}/run`, session);
    const reconcile = (session: Session, job: string) => post(`/demo/calculation-jobs/${job}/reconcile`, session);
    const reset = (session: Session) => post('/demo/sessions/reset', session);
    const revoked = async (session: Session) => (await pool.query('SELECT revoked_at IS NOT NULL AS yes FROM demo_sessions WHERE id=$1', [session.context.sessionId])).rows[0].yes;
    const tables = ['dataset_series', 'dataset_versions', 'calculation_jobs', 'execution_attempts',
      'dataset_build_snapshots', 'dataset_build_snapshot_dependencies', 'dpr_results',
      'dpr_calculation_input_snapshots', 'dpr_calculation_inputs'];
    const shared = ['calculation_types', 'execution_dependency_definition_versions',
      'execution_dependency_definition_dependencies', 'assets', 'raw_dpr', 'raw_ingestion_series',
      'raw_ingestion_batches', 'orchestration_v2_legacy_calculation_type_bridges', 'pgmigrations'];
    const dump = async (selected = [...tables, ...shared]) => {
      const result: Record<string, unknown> = {};
      for (const table of selected) result[table] = (await pool.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
      result.sessions = (await pool.query('SELECT id,company_code,created_at,expires_at,revoked_at FROM demo_sessions ORDER BY id')).rows;
      return result;
    };
    const owned = async (session: Session) => {
      const series = (await pool.query('SELECT * FROM dataset_series WHERE company_code=$1 ORDER BY id', [session.context.companyCode])).rows;
      const versions = (await pool.query('SELECT * FROM dataset_versions WHERE dataset_series_id=ANY($1::uuid[]) ORDER BY id', [series.map((r) => r.id)])).rows;
      const jobs = (await pool.query('SELECT * FROM calculation_jobs WHERE output_dataset_version_id=ANY($1::uuid[]) ORDER BY id', [versions.map((r) => r.id)])).rows;
      const snapshots = (await pool.query('SELECT * FROM dataset_build_snapshots WHERE dataset_version_id=ANY($1::uuid[]) ORDER BY id', [versions.map((r) => r.id)])).rows;
      const attempts = (await pool.query('SELECT * FROM execution_attempts WHERE calculation_job_id=ANY($1::uuid[]) ORDER BY id', [jobs.map((r) => r.id)])).rows;
      const dependencies = (await pool.query('SELECT * FROM dataset_build_snapshot_dependencies WHERE snapshot_id=ANY($1::uuid[]) ORDER BY snapshot_id', [snapshots.map((r) => r.id)])).rows;
      return { series, versions, jobs, snapshots, attempts, dependencies };
    };
    await pool.query(`INSERT INTO assets(asset_id,asset_type) VALUES (1,'SHARED');
      INSERT INTO raw_dpr VALUES ('2026-01-01','SHARED',1,99);
      INSERT INTO raw_ingestion_series(id,domain,business_key,last_batch_sequence)
      VALUES ('00000000-0000-4000-8000-000000000001','DPR_RAW','keep',1);
      INSERT INTO raw_ingestion_batches(id,ingestion_series_id,batch_sequence,status)
      VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000001',1,'READY');`);
    for (const domain of ['CAPEX', 'DPR']) {
      const type = (await pool.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id,last_allocated_dependency_definition_version)
        VALUES ($1,'SUMMARY',$2,1) RETURNING id`, [domain, `demo_${domain}`])).rows[0].id;
      const definition = (await pool.query(`INSERT INTO execution_dependency_definition_versions
        (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now()) RETURNING id`, [type])).rows[0].id;
      if (domain === 'DPR') await pool.query(`INSERT INTO execution_dependency_definition_dependencies VALUES ($1,'CAPEX')`, [definition]);
    }
    const graph = async (session: Session) => {
      const capex = await create(session, 'CAPEX'); const acceptance = await run(session, capex.jobId);
      assert.equal(acceptance.statusCode, 200);
      assert.equal((await post(`/demo/execution-attempts/${acceptance.json().executionAttemptId}/fake-state`, session, { state: 'SUCCEEDED' })).statusCode, 200);
      assert.equal((await reconcile(session, capex.jobId)).statusCode, 200);
      for (const command of ['submit-validation', 'publish']) assert.equal((await post(`/demo/dataset-versions/${capex.datasetVersionId}/${command}`, session)).statusCode, 200);
      const dpr = await create(session); assert.equal((await run(session, dpr.jobId)).statusCode, 200);
      await pool.query(`INSERT INTO dpr_calculation_input_snapshots(calculation_job_id,status,fab,period_start,period_end)
        VALUES ($1,'PUBLISHED','DEMO','2026-07-01','2026-10-01')`, [dpr.jobId]);
      await pool.query(`INSERT INTO dpr_calculation_inputs(input_snapshot_id,fab,asset_id,amount) VALUES ($1,'DEMO',1,12)`, [dpr.jobId]);
      await pool.query(`INSERT INTO dpr_results(dataset_version_id,fab,asset_type,total_amount) VALUES ($1,'DEMO','SHARED',12)`, [dpr.datasetVersionId]);
      return dpr;
    };
    // Non-demo historical ownership must survive all maintenance and resets.
    await pool.query(`WITH s AS (INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version)
      VALUES (gen_random_uuid(),'CAPEX','HISTORY',2020,'Q1',1) RETURNING id)
      INSERT INTO dataset_versions(id,dataset_series_id,version,status) SELECT gen_random_uuid(),id,1,'PUBLISHED' FROM s`);
    const history = (await pool.query("SELECT * FROM dataset_series WHERE company_code='HISTORY'")).rows;
    console.log('DEMO_01B2_RUNTIME', JSON.stringify({ node: process.version, database: name,
      postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
      migrations: (await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n }));
    // Verify exactly the reviewed core/DPR graph plus Scenario session ownership.
    const edges = (await pool.query(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
      FROM pg_constraint WHERE contype='f' ORDER BY 1,2`)).rows;
    console.log('DEMO_01B2_REVIEWED_FK_GRAPH', JSON.stringify(edges));
    assert.deepEqual(edges.map((edge) => `${edge.child}->${edge.parent}`), [
      'calculation_jobs->calculation_types', 'calculation_jobs->dataset_versions',
      'calculation_jobs->execution_dependency_definition_versions',
      'dataset_build_snapshot_dependencies->dataset_build_snapshots',
      'dataset_build_snapshot_dependencies->dataset_versions', 'dataset_build_snapshots->dataset_versions',
      'dataset_versions->dataset_series', 'demo_scenario_instances->demo_sessions', 'dpr_calculation_inputs->assets',
      'dpr_calculation_inputs->dpr_calculation_input_snapshots', 'dpr_calculation_input_snapshots->calculation_jobs',
      'dpr_results->dataset_versions', 'execution_attempts->calculation_jobs',
      'execution_dependency_definition_dependencies->execution_dependency_definition_versions',
      'execution_dependency_definition_versions->calculation_types',
      'orchestration_v2_legacy_calculation_type_bridges->calculation_types', 'raw_ingestion_batches->raw_ingestion_series',
    ]);

    await t.test('historical DEMO company collision retries through HTTP and Reset preserves the entire historical dataset', async () => {
      const companyCode = `DEMO_${'A'.repeat(15)}`;
      const seriesId = randomUUID(); const versionId = randomUUID(); const jobId = randomUUID();
      await pool.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version)
        VALUES ($1,'CAPEX',$2,2020,'Q1',1)`, [seriesId, companyCode]);
      await pool.query(`INSERT INTO dataset_versions(id,dataset_series_id,version,status,published_at)
        VALUES ($1,$2,1,'PUBLISHED',now())`, [versionId, seriesId]);
      await pool.query(`INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,
        resolved_dependency_definition_version_id,status,started_at,finished_at)
        SELECT $1,$2,ct.id,d.id,'SUCCEEDED',now(),now() FROM calculation_types ct
        JOIN execution_dependency_definition_versions d ON d.calculation_type_id=ct.id
        WHERE ct.domain='CAPEX' AND ct.code='SUMMARY' AND d.version=1`, [jobId, versionId]);
      await pool.query('INSERT INTO dataset_build_snapshots(dataset_version_id) VALUES ($1)', [versionId]);
      await pool.query(`INSERT INTO execution_attempts(calculation_job_id,attempt_number,status,airflow_dag_id,
        airflow_dag_run_id,dispatch_started_at,accepted_at,finished_at)
        VALUES ($1,1,'SUCCEEDED','historical_capex',$2,now(),now(),now())`, [jobId, `historical-${randomUUID()}`]);
      const before = await dump(); delete before.sessions;
      const beforeCount = (await pool.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n;
      let calls = 0; const rejectedId = randomUUID();
      const controlled = new DemoSessionService(pool, { candidate: () => ({
        id: ++calls === 1 ? rejectedId : randomUUID(), token: randomBytes(32),
        companyCode: calls === 1 ? companyCode : `DEMO_${'B'.repeat(15)}`,
      }) });
      const creationApp = Fastify({ logger: false }); apps.push(creationApp);
      await creationApp.register(demoSessionRoutes(controlled, { nodeEnvironment: 'test', origin: 'https://demo.test' }));
      const session = await newSession(creationApp);
      assert.equal(calls, 2); assert.notEqual(session.context.companyCode, companyCode);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n, beforeCount + 1);
      assert.equal((await pool.query('SELECT id FROM demo_sessions WHERE id=$1 OR company_code=$2', [rejectedId, companyCode])).rowCount, 0);
      await graph(session);
      assert.equal((await owned(session)).attempts.length, 2);
      const response = await reset(session); assert.equal(response.statusCode, 204); cleared(response);
      assert.equal(await revoked(session), true); assert.equal((await owned(session)).series.length, 0);
      const after = await dump(); delete after.sessions;
      assert.deepEqual(after, before, 'Historical series/version/job/snapshot/attempt and all unrelated data remain byte-for-byte equal');
      assert.equal((await pool.query('SELECT id FROM demo_sessions WHERE company_code=$1', [companyCode])).rowCount, 0);
    });

    await t.test('full reset deletes interdependent v2 and DPR graph, allows idle RUNNING, preserves B/shared/history', async () => {
      const a = await newSession(); const b = await newSession(); await graph(a); const bData = await graph(b);
      const fakeA = await runtime.executors.forSession(a.context); const fakeB = await runtime.executors.forSession(b.context);
      const beforeB = await owned(b); const fakeBeforeB = JSON.stringify(fakeB.getExternalExecutions());
      const sharedBefore = await dump(shared); delete sharedBefore.sessions;
      assert.ok((await owned(a)).jobs.some((j) => j.status === 'RUNNING'));
      const size = runtime.executors.size; const response = await reset(a);
      assert.equal(response.statusCode, 204); assert.equal(response.body, ''); cleared(response);
      assert.equal(await revoked(a), true); assert.equal(runtime.executors.size, size - 1);
      assert.deepEqual(await owned(a), { series: [], versions: [], jobs: [], snapshots: [], attempts: [], dependencies: [] });
      for (const table of ['dpr_results', 'dpr_calculation_input_snapshots', 'dpr_calculation_inputs']) {
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
      }
      assert.equal(fakeA.getExternalExecutions().length, 2, 'No cancellation or invented fake result');
      assert.deepEqual(await owned(b), beforeB); assert.equal(await runtime.executors.forSession(b.context), fakeB);
      assert.equal(JSON.stringify(fakeB.getExternalExecutions()), fakeBeforeB);
      const sharedAfter = await dump(shared); delete sharedAfter.sessions; assert.deepEqual(sharedAfter, sharedBefore);
      assert.deepEqual((await pool.query("SELECT * FROM dataset_series WHERE company_code='HISTORY'")).rows, history);
      assert.equal((await run(b, bData.jobId)).statusCode, 200); assert.equal((await reconcile(b, bData.jobId)).statusCode, 200);
      await assert.rejects(runtime.executors.forSession(a.context), { code: 'DEMO_SESSION_UNAVAILABLE' });
    });

    await t.test('reset contracts reject missing auth, selectors and CSRF with no mutation', async () => {
      const session = await newSession(); await create(session, 'CAPEX'); const before = await dump();
      error(await post('/demo/sessions/reset'), 401, 'DEMO_SESSION_UNAVAILABLE');
      for (const payload of [null, [], { sessionId: session.context.sessionId }, { companyCode: session.context.companyCode }, { id: randomUUID() }]) {
        error(await post('/demo/sessions/reset', session, payload), 400, 'INVALID_REQUEST');
      }
      for (const headers of [{ cookie: session.cookie }, { cookie: session.cookie, 'x-demo-session': '1', origin: 'https://evil.test' }]) {
        error(await app.inject({ method: 'POST', url: '/demo/sessions/reset', headers, payload: {} }), 403, 'DEMO_SESSION_CSRF_REJECTED');
      }
      const core = await buildApp({ appMode: 'core', logger: false, nodeEnvironment: 'test' }); apps.push(core);
      assert.equal((await post('/demo/sessions/reset', session, {}, core)).statusCode, 404);
      assert.deepEqual(await dump(), before);
    });

    await t.test('one reset reservation, second reset and new domain commands rejected; B proceeds independently', async () => {
      const a = await newSession(); const data = await graph(a); const b = await newSession(); const bData = await create(b, 'CAPEX');
      const entered = barrier(); const finish = barrier(); let cleanups = 0;
      hooks.beforeCommit = async () => { cleanups++; entered.release(); await finish.promise; };
      const first = reset(a);
      try {
        await entered.promise;
        error(await reset(a), 409, 'RESET_CONFLICT');
        for (const command of ['run', 'reconcile']) error(await post(`/demo/calculation-jobs/${data.jobId}/${command}`, a), 409, 'RESET_CONFLICT');
        for (const command of ['submit-validation', 'publish', 'reject', 'abandon']) error(await post(`/demo/dataset-versions/${data.datasetVersionId}/${command}`, a), 409, 'RESET_CONFLICT');
        error(await post('/demo/dataset-versions', a, { domain: 'CAPEX', fiscalYear: 2027, period: 'Q1' }), 409, 'RESET_CONFLICT');
        assert.equal((await run(b, bData.jobId)).statusCode, 200);
        assert.equal(cleanups, 1);
      } finally { finish.release(); delete hooks.beforeCommit; }
      assert.equal((await first).statusCode, 204); assert.equal(cleanups, 1);
    });

    await t.test('held Run plus queued operation rejects reset immediately without canceling original requests', async () => {
      const session = await newSession(); const data = await create(session, 'CAPEX');
      const fake = new BarrierFake(); assigned.push(fake); const held = run(session, data.jobId);
      await fake.entered.promise;
      const enteredQueue = barrier(); const original = runtime.coordinator.run.bind(runtime.coordinator);
      runtime.coordinator.run = function<T>(ctx: AuthenticatedDemoSession, body: () => Promise<T>) {
        const result = original(ctx, body); enteredQueue.release(); return result;
      };
      const queued = post('/demo/fake-executor/dispatch-behavior', session, { behavior: 'ACCEPT' });
      try { await enteredQueue.promise; error(await reset(session), 409, 'RESET_CONFLICT'); assert.equal(await revoked(session), false); }
      finally { runtime.coordinator.run = original; fake.finish.release(); }
      assert.equal((await held).statusCode, 200); assert.equal((await queued).statusCode, 200);
      assert.equal((await reset(session)).statusCode, 204);
    });

    await t.test('held reconciliation conflicts with reset but completes normally', async () => {
      const session = await newSession(); const data = await create(session, 'CAPEX');
      const fake = new BarrierFake(); fake.finish.release(); assigned.push(fake);
      assert.equal((await run(session, data.jobId)).statusCode, 200);
      const gate = barrier(); const entered = barrier(); const lookup = fake.getExecutionStatus.bind(fake);
      fake.getExecutionStatus = async (identity) => { entered.release(); await gate.promise; return lookup(identity); };
      const held = reconcile(session, data.jobId);
      try { await entered.promise; error(await reset(session), 409, 'RESET_CONFLICT'); }
      finally { gate.release(); }
      assert.equal((await held).statusCode, 200);
    });

    await t.test('reset revalidates expiry after acquiring the session lock, not before waiting', async () => {
      const session = await newSession(); await create(session, 'CAPEX'); const before = await owned(session);
      const locker = await pool.connect(); await locker.query('BEGIN');
      await locker.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [session.context.sessionId]);
      const request = reset(session);
      let unlocked = false;
      try {
        let waiting = false; const deadline = Date.now() + 1500;
        while (!waiting && Date.now() < deadline) {
          waiting = (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1
            AND wait_event_type='Lock' AND query LIKE '%FROM demo_sessions WHERE id=$1 FOR UPDATE%'`, [name])).rowCount !== 0;
        }
        assert.ok(waiting, 'Reset reached the actual session row lock');
        await locker.query(`UPDATE demo_sessions SET created_at=clock_timestamp()-INTERVAL '5 hours',
          expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1`, [session.context.sessionId]);
        await locker.query('COMMIT');
        unlocked = true;
      } finally { if (!unlocked) await locker.query('ROLLBACK'); locker.release(); }
      const response = await request; error(response, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(response);
      assert.deepEqual(await owned(session), before); assert.equal(await revoked(session), false);
      await runtime.reset.cleanupInactiveSession(session.context.sessionId);
    });

    await t.test('real PostgreSQL failure after child deletes restores full graph/session/fake and permits retry', async () => {
      const session = await newSession(); const data = await graph(session);
      const fake = await runtime.executors.forSession(session.context); const fakeBefore = JSON.stringify(fake.getExternalExecutions());
      await pool.query(`CREATE FUNCTION b2_reject_job_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.id='${data.jobId}'::uuid THEN RAISE EXCEPTION 'test cleanup failure'; END IF; RETURN OLD; END $$;
        CREATE TRIGGER b2_reject_job_delete BEFORE DELETE ON calculation_jobs FOR EACH ROW EXECUTE FUNCTION b2_reject_job_delete()`);
      const before = await dump();
      try { error(await reset(session), 500, 'DEMO_RESET_FAILED'); assert.deepEqual(await dump(), before); }
      finally { await pool.query('DROP TRIGGER b2_reject_job_delete ON calculation_jobs; DROP FUNCTION b2_reject_job_delete()'); }
      assert.equal((await current(session)).statusCode, 200); assert.equal(await revoked(session), false);
      assert.equal(await runtime.executors.forSession(session.context), fake); assert.equal(JSON.stringify(fake.getExternalExecutions()), fakeBefore);
      assert.equal((await run(session, data.jobId)).statusCode, 200);
      assert.equal((await reset(session)).statusCode, 204);
    });

    await t.test('foreign snapshot referencing owned upstream fails closed without widening cleanup', async () => {
      const a = await newSession(); const aData = await graph(a); const b = await newSession(); const bData = await graph(b);
      const upstream = (await owned(a)).versions.find((v) => v.id !== aData.datasetVersionId)!;
      const snapshot = (await pool.query('SELECT id FROM dataset_build_snapshots WHERE dataset_version_id=$1', [bData.datasetVersionId])).rows[0].id;
      await pool.query('INSERT INTO dataset_build_snapshot_dependencies VALUES ($1,$2,$3)', [snapshot, upstream.dataset_series_id, upstream.id]);
      const before = await dump();
      error(await reset(a), 500, 'DEMO_RESET_FAILED'); assert.deepEqual(await dump(), before);
      await pool.query('DELETE FROM dataset_build_snapshot_dependencies WHERE snapshot_id=$1 AND upstream_dataset_series_id=$2', [snapshot, upstream.dataset_series_id]);
      assert.equal((await reset(a)).statusCode, 204);
    });

    await t.test('committed reset with lost HTTP response never revives old data/cookie; new session works', async () => {
      const session = await newSession(); await graph(session);
      await reset(session); // Browser never applies this response's Set-Cookie.
      const response = await current(session); error(response, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(response);
      const reused = await post('/demo/sessions', session); error(reused, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(reused);
      assert.equal((await owned(session)).series.length, 0);
      assert.equal((await create(await newSession(), 'CAPEX')).datasetStatus, 'DRAFT');
    });

    await t.test('lost COMMIT acknowledgment resolves committed durable state on a fresh locked connection', async () => {
      const session = await newSession(); await graph(session);
      hooks.commit = async (client) => { await client.query('COMMIT'); throw new Error('lost commit acknowledgment'); };
      try { const response = await reset(session); assert.equal(response.statusCode, 204); cleared(response); }
      finally { delete hooks.commit; }
      assert.equal(await revoked(session), true); assert.equal((await owned(session)).series.length, 0);
      await assert.rejects(runtime.executors.forSession(session.context), { code: 'DEMO_SESSION_UNAVAILABLE' });
    });

    await t.test('failed COMMIT transport resolves confirmed rollback, retaining fake and permitting retry', async () => {
      const session = await newSession(); await graph(session); const before = await dump();
      const fake = await runtime.executors.forSession(session.context);
      hooks.commit = async () => { throw new Error('connection lost before server received COMMIT'); };
      try { error(await reset(session), 500, 'DEMO_RESET_FAILED'); }
      finally { delete hooks.commit; }
      assert.deepEqual(await dump(), before); assert.equal(await runtime.executors.forSession(session.context), fake);
      assert.equal((await reset(session)).statusCode, 204);
    });

    await t.test('fresh outcome resolution actually waits for a PostgreSQL session row lock before deciding', async () => {
      const session = await newSession(); await graph(session);
      const locker = new Client({ connectionString: connection(name) }); await locker.connect();
      const locked = barrier(); let settled = false;
      hooks.commit = async (client) => {
        await client.query('COMMIT');
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [session.context.sessionId]);
        locked.release(); throw new Error('lost commit acknowledgment');
      };
      hooks.recoveryClient = () => new Client({ connectionString: connection(name), application_name: 'b2_outcome_lock_test' });
      const request = reset(session).then((result) => { settled = true; return result; });
      try {
        await locked.promise;
        let waiting = false; const deadline = Date.now() + 1500;
        // Observe the actual server lock wait, not a guessed sleep ordering.
        while (!waiting && Date.now() < deadline) {
          waiting = (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1
            AND application_name='b2_outcome_lock_test' AND wait_event_type='Lock'`, [name])).rowCount !== 0;
        }
        assert.ok(waiting, 'Recovery must lock on a separate backend'); assert.equal(settled, false);
      } finally {
        await locker.query('ROLLBACK'); await locker.end(); delete hooks.commit; delete hooks.recoveryClient;
      }
      assert.equal((await request).statusCode, 204); assert.equal(await revoked(session), true);
    });

    await t.test('unresolved COMMIT keeps admission blocked until controlled recovery proves rollback', async () => {
      const session = await newSession(); const data = await create(session, 'CAPEX');
      const fake = await runtime.executors.forSession(session.context); const before = await dump();
      hooks.commit = async () => { throw new Error('commit transport unavailable'); };
      hooks.recoveryClient = () => { throw new Error('recovery transport unavailable'); };
      try {
        error(await reset(session), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
        error(await run(session, data.jobId), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
        error(await reconcile(session, data.jobId), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
        error(await reset(session), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
        assert.deepEqual(await dump(), before); assert.equal(await runtime.executors.forSession(session.context), fake);
      } finally { delete hooks.commit; delete hooks.recoveryClient; }
      assert.equal(await runtime.reset.recoverPendingResets(), 0);
      assert.equal((await run(session, data.jobId)).statusCode, 200); assert.equal((await reset(session)).statusCode, 204);
    });

    await t.test('unresolved committed reset retains fake until resolution, then releases only that fake', async () => {
      const session = await newSession(); await graph(session); const size = runtime.executors.size;
      hooks.commit = async (client) => { await client.query('COMMIT'); throw new Error('lost commit acknowledgment'); };
      hooks.recoveryClient = () => { throw new Error('recovery transport unavailable'); };
      try {
        error(await reset(session), 503, 'DEMO_RESET_OUTCOME_UNKNOWN'); assert.equal(runtime.executors.size, size);
        const response = await current(session); error(response, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(response);
      } finally { delete hooks.commit; delete hooks.recoveryClient; }
      assert.equal(await runtime.reset.recoverPendingResets(), 0); assert.equal(runtime.executors.size, size - 1);
    });

    await t.test('post-commit fake release failure never restores session; bounded maintenance reclaims it', async () => {
      const session = await newSession(); await graph(session);
      const original = runtime.executors.releaseSession.bind(runtime.executors); const size = runtime.executors.size;
      runtime.executors.releaseSession = (id) => { if (id === session.context.sessionId) throw new Error('test memory cleanup failure'); original(id); };
      try { assert.equal((await reset(session)).statusCode, 204); assert.equal(await revoked(session), true); assert.equal(runtime.executors.size, size); }
      finally { runtime.executors.releaseSession = original; }
      await assert.rejects(runtime.executors.forSession(session.context), { code: 'DEMO_SESSION_UNAVAILABLE' });
      await runtime.reset.cleanupInactiveSession(session.context.sessionId);
      assert.equal(runtime.executors.size, size - 1); await runtime.reset.cleanupInactiveSession(session.context.sessionId);
      assert.ok(events.some((e) => e.event === 'demo_fake_cleanup_failed' && e.sessionId === session.context.sessionId));
    });

    await t.test('inactive cleanup rejects active owners, safely retries expired/revoked data and is bounded', async () => {
      const active = await newSession(); await graph(active); const before = await owned(active);
      await assert.rejects(runtime.reset.cleanupInactiveSession(active.context.sessionId), { code: 'DEMO_SESSION_UNAVAILABLE' });
      assert.deepEqual(await owned(active), before);
      const expired = await newSession(); await graph(expired);
      await pool.query(`UPDATE demo_sessions SET created_at=clock_timestamp()-INTERVAL '5 hours',
        expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1`, [expired.context.sessionId]);
      const revokedSession = await newSession(); const data = await graph(revokedSession); await runtime.sessions.revoke(revokedSession.context.sessionId);
      await pool.query(`CREATE FUNCTION b2_maintenance_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.id='${data.jobId}'::uuid THEN RAISE EXCEPTION 'test cleanup failure'; END IF; RETURN OLD; END $$;
        CREATE TRIGGER b2_maintenance_failure BEFORE DELETE ON calculation_jobs FOR EACH ROW EXECUTE FUNCTION b2_maintenance_failure()`);
      const revokedBefore = await owned(revokedSession);
      try { await assert.rejects(runtime.reset.cleanupInactiveSession(revokedSession.context.sessionId), { code: 'DEMO_RESET_FAILED' }); }
      finally { await pool.query('DROP TRIGGER b2_maintenance_failure ON calculation_jobs; DROP FUNCTION b2_maintenance_failure()'); }
      assert.equal(await revoked(revokedSession), true); assert.deepEqual(await owned(revokedSession), revokedBefore);
      const batch = await runtime.reset.maintainInactiveSessions(1); assert.equal(batch.cleaned, 1); assert.ok(batch.pending >= 1);
      await runtime.reset.cleanupInactiveSession(expired.context.sessionId); await runtime.reset.cleanupInactiveSession(revokedSession.context.sessionId);
      assert.equal((await owned(expired)).series.length, 0); assert.equal((await owned(revokedSession)).series.length, 0);
      assert.deepEqual(await owned(active), before);
      await assert.rejects(runtime.reset.maintainInactiveSessions(0), /batch size/);
    });

    await t.test('invalid, missing, expired, revoked and unknown credentials clear local and secure cookies', async () => {
      const secureApp = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false, nodeEnvironment: 'test',
        demoSession: { secureCookies: true, origin: 'https://demo.test' } }); apps.push(secureApp);
      for (const secure of [false, true]) {
        const target = secure ? secureApp : app;
        const expired = await newSession(target, secure); const rev = await newSession(target, secure);
        await pool.query(`UPDATE demo_sessions SET created_at=clock_timestamp()-INTERVAL '5 hours',
          expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1`, [expired.context.sessionId]);
        await runtime.sessions.revoke(rev.context.sessionId);
        for (const cookie of [expired.cookie, rev.cookie, `${secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE}=invalid`,
          `${secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE}=${Buffer.alloc(32, 23).toString('base64url')}`, undefined]) {
          const response = await target.inject({ method: 'GET', url: '/demo/sessions/current', headers: cookie ? { cookie } : {} });
          error(response, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(response, secure);
        }
        const invalidPost = await post('/demo/sessions', rev, {}, target); error(invalidPost, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(invalidPost, secure);
        const resetSession = await newSession(target, secure); const success = await post('/demo/sessions/reset', resetSession, {}, target);
        assert.equal(success.statusCode, 204); cleared(success, secure);
      }
    });

    await t.test('repeated buildApp does not invalidate; explicit startup invalidates before new sessions and never resurrects fake state', async () => {
      const session = await newSession(); const data = await graph(session); const before = await owned(session);
      const second = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false, nodeEnvironment: 'test' }); apps.push(second);
      assert.equal((await current(session, second)).statusCode, 200);
      const fresh = new DemoRuntime(pool, 'test', {}, { log: hooks.log });
      // Force only maintenance to fail, allowing examination of persisted lifecycle
      // immediately after successful invalidation. No financial states are changed.
      const maintenance = fresh.reset.maintainInactiveSessions.bind(fresh.reset);
      fresh.reset.maintainInactiveSessions = async () => { throw new Error('maintenance unavailable'); };
      await fresh.reset.startServer(); fresh.reset.maintainInactiveSessions = maintenance;
      assert.equal(await revoked(session), true); assert.deepEqual(await owned(session), before); assert.equal(fresh.executors.size, 0);
      const restarted = await buildApp({ appMode: 'demo', demoRuntime: fresh, logger: false, nodeEnvironment: 'test',
        demoSession: { origin: 'https://demo.test' } }); apps.push(restarted);
      const response = await current(session, restarted); error(response, 401, 'DEMO_SESSION_UNAVAILABLE'); cleared(response);
      error(await post(`/demo/calculation-jobs/${data.jobId}/reconcile`, session, {}, restarted), 401, 'DEMO_SESSION_UNAVAILABLE');
      const created = await post('/demo/sessions', undefined, {}, restarted); assert.equal(created.statusCode, 201);
      assert.notEqual(created.json().sessionId, session.context.sessionId);
      await fresh.reset.cleanupInactiveSession(session.context.sessionId); assert.equal((await owned(session)).series.length, 0);
      await runtime.reset.maintainInactiveSessions(1000); assert.equal(runtime.executors.size, 0);
    });

    await t.test('startup invalidation SQL failure fails actual server closed, without listening or revoking valid session', async () => {
      const session = await newSession();
      await pool.query(`CREATE FUNCTION b2_startup_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test startup failure'; END $$;
        CREATE TRIGGER b2_startup_failure BEFORE UPDATE ON demo_sessions FOR EACH ROW EXECUTE FUNCTION b2_startup_failure()`);
      try {
        await assert.rejects(runtime.reset.startServer(), /invalidation failed/);
        const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
          env: { ...process.env, APP_MODE: 'demo', NODE_ENV: 'test', EXECUTOR_TYPE: 'fake', PORT: '0' }, encoding: 'utf8', timeout: 20_000,
        });
        assert.equal(child.status, 1); assert.equal(child.signal, null); assert.match(child.stderr, /invalidation failed/);
        assert.doesNotMatch(child.stdout, /Server listening/); assert.equal(await revoked(session), false);
      } finally { await pool.query('DROP TRIGGER b2_startup_failure ON demo_sessions; DROP FUNCTION b2_startup_failure()'); }
    });

    await t.test('structured events cover recovery without credential/hash/header payloads; shared/history remain', async () => {
      for (const event of ['demo_reset_started', 'demo_reset_conflict', 'demo_reset_committed', 'demo_reset_rolled_back',
        'demo_reset_commit_unknown', 'demo_fake_cleanup_failed', 'demo_startup_session_invalidation', 'demo_old_session_cleanup_failed']) {
        assert.ok(events.some((entry) => entry.event === event), `Missing event ${event}`);
      }
      assert.doesNotMatch(JSON.stringify(events), /token|cookie|hash|authorization/i);
      assert.deepEqual((await pool.query("SELECT * FROM dataset_series WHERE company_code='HISTORY'")).rows, history);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_dpr')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM calculation_types')).rows[0].n, 2);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 8);
    });
  } finally {
    try { await Promise.all(apps.map((app) => app.close())); if (db) { await db.end(); await Promise.all(ends); } }
    finally {
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      try {
        if (created) {
          const deadline = Date.now() + 5000;
          let sessions = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
          while (sessions.rowCount && Date.now() < deadline) {
            await setImmediate();
            sessions = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
          }
          assert.equal(sessions.rowCount, 0, 'All owned backends must exit before DROP');
          assert.match(name, /^demo_01b2_test_[a-z0-9_]+$/); await admin.query(`DROP DATABASE "${name}"`);
          console.log('DEMO_01B2_TEARDOWN', JSON.stringify({ database: name, sessions: 0, dropped: true, forced: false }));
        }
      } finally { await admin.end(); }
    }
  }
});
