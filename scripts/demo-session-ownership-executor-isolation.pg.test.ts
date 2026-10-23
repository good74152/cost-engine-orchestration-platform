import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import { DemoRuntime } from '../src/modules/demo-session/demo-runtime.js';
import { LOCAL_SESSION_COOKIE, type AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import { resolveAppMode } from '../src/app-mode.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo isolation tests require an owned disposable PostgreSQL service');
function connection(name: string) { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); }
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, release: () => resolve() };
}
class BarrierFake extends FakeExecutor {
  readonly entered = barrier();
  readonly finish = barrier();
  private held = false;
  override async dispatch(command: DispatchCalculationCommand) {
    const outcome = await super.dispatch(command);
    if (!this.held) { this.held = true; this.entered.release(); await this.finish.promise; }
    return outcome;
  }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
function error(response: Response, status: number, code: string) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'message']);
  assert.equal(response.json().code, code);
  assert.doesNotMatch(response.body, /token_hash|constraint|SELECT |INSERT |postgresql:\/\//i);
}
interface Session { cookie: string; context: AuthenticatedDemoSession }

test('Demo-01B-1: session ownership and executor isolation on real PostgreSQL', { timeout: 180_000 }, async (t) => {
  const name = `demo_01b1_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^demo_01b1_test_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const prior = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV,
    APP_MODE: process.env.APP_MODE, EXECUTOR_TYPE: process.env.EXECUTOR_TYPE };
  const admin = new Client({ connectionString: connection('postgres') });
  const apps: FastifyInstance[] = [];
  const ends: Promise<void>[] = [];
  let db: Pool | undefined;
  let created = false;
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
    pool.on('connect', (client) => { ends.push(new Promise<void>((done) => client.once('end', () => done()))); });
    const assigned: FakeExecutor[] = [];
    const runtime = new DemoRuntime(pool, 'test', { createExecutor: () => assigned.shift() ?? new FakeExecutor() });
    const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false,
      nodeEnvironment: 'test', demoSession: { origin: 'https://demo.test' } }); apps.push(app);
    const headers = { 'x-demo-session': '1', origin: 'https://demo.test' };
    const post = (url: string, session?: Session, payload: unknown = {}, target = app) => target.inject({
      method: 'POST', url, payload: JSON.stringify(payload),
      headers: { ...headers, 'content-type': 'application/json', ...(session ? { cookie: session.cookie } : {}) },
    });
    const newSession = async (target = app, owner = runtime): Promise<Session> => {
      const response = await post('/demo/sessions', undefined, {}, target);
      assert.equal(response.statusCode, 201);
      const setCookie = response.headers['set-cookie'];
      assert.ok(typeof setCookie === 'string', 'Expected one cookie, without dumping credentials');
      const cookie = (setCookie as string).split(';', 1)[0]!;
      return { cookie, context: await owner.sessions.authenticate(cookie, LOCAL_SESSION_COOKIE) };
    };
    const create = async (session: Session, period = 'Q3', domain = 'DPR', fiscalYear = 2026) => {
      const response = await post('/demo/dataset-versions', session, { domain, period, fiscalYear });
      assert.equal(response.statusCode, 201);
      const result = response.json();
      return { ...result, jobId: result.calculationJobs[0].jobId as string };
    };
    const state = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM dataset_series s) AS series,
      (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM dataset_versions v) AS versions,
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM calculation_jobs j) AS jobs,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM execution_attempts a) AS attempts,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM dataset_build_snapshots b) AS snapshots,
      (SELECT jsonb_agg(to_jsonb(d)) FROM dataset_build_snapshot_dependencies d) AS dependencies`)).rows;
    const run = (session: Session, jobId: string) => post(`/demo/calculation-jobs/${jobId}/run`, session);
    const reconcile = (session: Session, jobId: string) => post(`/demo/calculation-jobs/${jobId}/reconcile`, session);
    const behavior = (session: Session, value: string) => post('/demo/fake-executor/dispatch-behavior', session, { behavior: value });
    const control = (session: Session, id: string, value: string) => post(`/demo/execution-attempts/${id}/fake-state`, session, { state: value });
    const attemptRow = async (id: string) => (await pool.query('SELECT * FROM execution_attempts WHERE id=$1', [id])).rows[0];
    const fakeState = (executor: FakeExecutor) => JSON.stringify({ history: executor.getDispatchHistory(),
      executions: executor.getExternalExecutions(), lookups: executor.getStatusLookupHistory() });
    const dprType = (await pool.query(`INSERT INTO calculation_types
      (domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
      VALUES ('DPR','SUMMARY','demo_dpr',true,1) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO execution_dependency_definition_versions
      (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now())`, [dprType]);
    console.log('DEMO_01B1_RUNTIME', JSON.stringify({ node: process.version,
      postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
      database: name, migrations: (await pool.query('SELECT COUNT(*)::int AS n FROM pgmigrations')).rows[0].n }));

    const a = await newSession(); const b = await newSession();
    const dataA = await create(a); const dataB = await create(b);

    await t.test('two sessions use equal domain/year/period with server-derived distinct companies', async () => {
      assert.notEqual(a.context.companyCode, b.context.companyCode);
      assert.notEqual(dataA.datasetSeriesId, dataB.datasetSeriesId);
      const rows = (await pool.query(`SELECT id,company_code,domain,fiscal_year,period,last_allocated_version
        FROM dataset_series WHERE id=ANY($1::uuid[]) ORDER BY company_code`, [[dataA.datasetSeriesId, dataB.datasetSeriesId]])).rows;
      assert.equal(rows.length, 2);
      for (const [session, data] of [[a, dataA], [b, dataB]] as const) {
        const row = rows.find((row) => row.id === data.datasetSeriesId)!;
        assert.equal(row.company_code, session.context.companyCode); assert.equal(row.last_allocated_version, 1);
        assert.equal(row.domain, 'DPR'); assert.equal(row.fiscal_year, 2026); assert.equal(row.period, 'Q3');
        assert.equal(data.datasetStatus, 'DRAFT'); assert.equal(data.calculationJobs[0].jobStatus, 'PENDING');
      }
      const before = await state();
      for (const extra of [{ companyCode: b.context.companyCode }, { company_code: b.context.companyCode },
        { sessionId: b.context.sessionId }, { version: 99 }, { dependencies: [] }, { calculationTypeId: dprType }]) {
        error(await post('/demo/dataset-versions', a, { domain: 'DPR', fiscalYear: 2026, period: 'Q1', ...extra }), 400, 'INVALID_REQUEST');
      }
      assert.deepEqual(await state(), before);
    });

    await t.test('foreign, nonexistent and malformed dataset/job IDs share generic 404 without executor access', async () => {
      const before = await state(); const size = runtime.executors.size;
      for (const [caller, foreign] of [[a, dataB], [b, dataA]] as const) {
        for (const command of ['submit-validation', 'publish', 'reject', 'abandon']) {
          const responses = [];
          for (const id of [foreign.datasetVersionId, randomUUID(), 'forged']) {
            const response = await post(`/demo/dataset-versions/${id}/${command}`, caller);
            error(response, 404, 'DEMO_RESOURCE_UNAVAILABLE'); responses.push(response.json());
            assert.ok(!response.body.includes(foreign.datasetVersionId));
          }
          assert.deepEqual(responses[0], responses[1]); assert.deepEqual(responses[1], responses[2]);
        }
        for (const command of ['run', 'reconcile']) {
          for (const id of [foreign.jobId, randomUUID(), 'forged']) {
            error(await post(`/demo/calculation-jobs/${id}/${command}`, caller), 404, 'DEMO_RESOURCE_UNAVAILABLE');
          }
        }
      }
      assert.equal(runtime.executors.size, size); assert.deepEqual(await state(), before);
    });

    await t.test('REJECT/ACCEPT scripts and execution histories are session-local; retry preserves snapshot', async () => {
      assert.equal((await behavior(a, 'REJECT')).statusCode, 200);
      assert.equal((await behavior(b, 'ACCEPT')).statusCode, 200);
      // Dispatch B first: a shared scripted queue would incorrectly consume A's REJECT.
      const accepted = await run(b, dataB.jobId); assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().attemptStatus, 'ACCEPTED');
      error(await run(a, dataA.jobId), 502, 'EXECUTOR_DISPATCH_FAILED');
      const fakeA = await runtime.executors.forSession(a.context); const fakeB = await runtime.executors.forSession(b.context);
      assert.notEqual(fakeA, fakeB); assert.equal(fakeA.getExternalExecutions().length, 0);
      assert.equal(fakeB.getExternalExecutions().length, 1);
      assert.ok(fakeA.getDispatchHistory().every((c) => c.jobId === dataA.jobId));
      assert.ok(fakeB.getDispatchHistory().every((c) => c.jobId === dataB.jobId));
      const first = (await pool.query('SELECT * FROM execution_attempts WHERE calculation_job_id=$1', [dataA.jobId])).rows[0];
      assert.equal(first.status, 'DISPATCH_FAILED');
      assert.equal((await pool.query('SELECT status FROM calculation_jobs WHERE id=$1', [dataA.jobId])).rows[0].status, 'PENDING');
      const snapshot = (await pool.query('SELECT id FROM dataset_build_snapshots WHERE dataset_version_id=$1', [dataA.datasetVersionId])).rows[0].id;
      // The same full external identity is tombstoned only in A's fake.
      const command = fakeA.getDispatchHistory()[0]!;
      assert.equal((await fakeA.dispatch(command)).kind, 'REJECTED');
      assert.equal((await fakeB.getExecutionStatus(command)).kind, 'NOT_FOUND');
      const retry = await run(a, dataA.jobId); assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().attemptNumber, 2); assert.notEqual(retry.json().executionAttemptId, first.id);
      assert.equal(retry.json().datasetBuildSnapshotId, snapshot);
      assert.deepEqual(await attemptRow(first.id), first);
      assert.equal(fakeA.getExternalExecutions().length, 1); assert.equal(fakeB.getExternalExecutions().length, 1);
    });

    await t.test('attempt controls verify ownership and do not update DB until Reconcile', async () => {
      const attempt = (await pool.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 ORDER BY attempt_number DESC LIMIT 1', [dataB.jobId])).rows[0].id;
      const before = await state();
      const fakeA = await runtime.executors.forSession(a.context); const fakeB = await runtime.executors.forSession(b.context);
      const beforeA = fakeState(fakeA); const beforeB = fakeState(fakeB);
      for (const id of [attempt, randomUUID(), 'forged']) {
        error(await control(a, id, 'FAILED'), 404, 'DEMO_RESOURCE_UNAVAILABLE');
      }
      assert.deepEqual(await state(), before); assert.equal(fakeState(fakeA), beforeA); assert.equal(fakeState(fakeB), beforeB);
      error(await post(`/demo/execution-attempts/${attempt}/fake-state`, b,
        { state: 'FAILED', airflowDagRunId: 'arbitrary-client-identity' }), 400, 'INVALID_REQUEST');
      error(await control(b, attempt, 'RUNNING'), 400, 'INVALID_REQUEST');
      assert.equal((await control(b, attempt, 'SUCCEEDED')).statusCode, 200);
      assert.deepEqual(await state(), before, 'Fake state controls must not mutate PostgreSQL execution state');
      const result = await reconcile(b, dataB.jobId); assert.equal(result.statusCode, 200);
      assert.equal(result.json().jobStatus, 'SUCCEEDED'); assert.equal(result.json().attemptStatus, 'SUCCEEDED');
      error(await run(b, dataB.jobId), 409, 'JOB_NOT_RUNNABLE');
      for (const command of ['submit-validation', 'publish']) {
        assert.equal((await post(`/demo/dataset-versions/${dataB.datasetVersionId}/${command}`, b)).statusCode, 200);
      }
      assert.equal((await pool.query('SELECT status FROM dataset_versions WHERE id=$1', [dataB.datasetVersionId])).rows[0].status, 'PUBLISHED');
    });

    await t.test('UNKNOWN behaviors recover same attempt/run identity using the same session fake', async () => {
      for (const scripted of ['ACCEPT_THEN_UNKNOWN', 'UNKNOWN_WITHOUT_CREATION']) {
        const session = await newSession(); const data = await create(session);
        assert.equal((await behavior(session, scripted)).statusCode, 200);
        const first = await run(session, data.jobId); assert.equal(first.statusCode, 202);
        assert.equal(first.json().attemptStatus, 'DISPATCHING'); assert.equal(first.json().jobStatus, 'PENDING');
        const executor = await runtime.executors.forSession(session.context);
        assert.equal(executor.getExternalExecutions().length, scripted === 'ACCEPT_THEN_UNKNOWN' ? 1 : 0);
        const second = await run(session, data.jobId); assert.equal(second.statusCode, 200);
        assert.equal(second.json().executionAttemptId, first.json().executionAttemptId);
        assert.equal(second.json().airflowDagRunId, first.json().airflowDagRunId);
        assert.equal(second.json().dispatchOutcome, scripted === 'ACCEPT_THEN_UNKNOWN' ? 'ALREADY_EXISTS' : 'ACCEPTED');
        const historyLength = executor.getDispatchHistory().length;
        assert.equal((await run(session, data.jobId)).statusCode, 200);
        assert.equal(executor.getDispatchHistory().length, historyLength);
        assert.equal(executor.getExternalExecutions().length, 1);
      }
    });

    await t.test('calculation failure retry and reject/abandon preserve existing lifecycle rules', async () => {
      const session = await newSession(); const data = await create(session);
      const first = await run(session, data.jobId); assert.equal(first.statusCode, 200);
      error(await post(`/demo/dataset-versions/${data.datasetVersionId}/abandon`, session), 409, 'DATASET_HAS_ACTIVE_EXECUTION');
      assert.equal((await control(session, first.json().executionAttemptId, 'FAILED')).statusCode, 200);
      const failed = await reconcile(session, data.jobId); assert.equal(failed.statusCode, 200);
      assert.equal(failed.json().jobStatus, 'FAILED');
      const historical = await attemptRow(first.json().executionAttemptId);
      const retry = await run(session, data.jobId); assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().attemptNumber, 2);
      assert.equal(retry.json().datasetBuildSnapshotId, first.json().datasetBuildSnapshotId);
      assert.equal((await control(session, retry.json().executionAttemptId, 'SUCCEEDED')).statusCode, 200);
      assert.equal((await reconcile(session, data.jobId)).statusCode, 200);
      assert.deepEqual(await attemptRow(first.json().executionAttemptId), historical);
      for (const command of ['submit-validation', 'reject']) {
        assert.equal((await post(`/demo/dataset-versions/${data.datasetVersionId}/${command}`, session)).statusCode, 200);
      }
      error(await post(`/demo/dataset-versions/${data.datasetVersionId}/publish`, session), 409, 'STATE_CONFLICT');
      const next = await create(session); assert.equal(next.version, 2);
      assert.equal((await post(`/demo/dataset-versions/${next.datasetVersionId}/abandon`, session)).statusCode, 200);
    });

    const protectedPaths = ['/demo/dataset-versions', ...['submit-validation', 'publish', 'reject', 'abandon']
      .map((action) => `/demo/dataset-versions/${dataA.datasetVersionId}/${action}`),
      `/demo/calculation-jobs/${dataA.jobId}/run`, `/demo/calculation-jobs/${dataA.jobId}/reconcile`,
      '/demo/fake-executor/dispatch-behavior', `/demo/execution-attempts/${randomUUID()}/fake-state`];

    await t.test('every Demo mutation authenticates and applies shared CSRF before changes', async () => {
      const before = await state(); const fake = await runtime.executors.forSession(a.context); const fakeBefore = fakeState(fake);
      for (const path of protectedPaths) {
        error(await post(path), 401, 'DEMO_SESSION_UNAVAILABLE');
        error(await app.inject({ method: 'POST', url: path, payload: '{',
          headers: { 'content-type': 'application/json' } }), 401, 'DEMO_SESSION_UNAVAILABLE');
        for (const badHeaders of [{}, { ...headers, origin: 'https://evil.test' },
          { ...headers, origin: 'null' }, { ...headers, 'sec-fetch-site': 'cross-site' }]) {
          error(await app.inject({ method: 'POST', url: path, payload: {},
            headers: { ...badHeaders, cookie: a.cookie } }), 403, 'DEMO_SESSION_CSRF_REJECTED');
        }
      }
      assert.deepEqual(await state(), before); assert.equal(fakeState(fake), fakeBefore);
      error(await app.inject({ method: 'GET', url: '/demo/sessions/current' }), 401, 'DEMO_SESSION_UNAVAILABLE');
      assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    });

    await t.test('expired/revoked sessions and ID impersonation cannot enter protected operations', async () => {
      const expired = await newSession(); const revoked = await newSession();
      await pool.query(`UPDATE demo_sessions SET created_at=clock_timestamp()-INTERVAL '5 hours',
        expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1`, [expired.context.sessionId]);
      await runtime.sessions.revoke(revoked.context.sessionId);
      const before = await state(); const size = runtime.executors.size;
      for (const path of protectedPaths) {
        error(await post(path, expired), 401, 'DEMO_SESSION_UNAVAILABLE');
        error(await post(path, revoked), 401, 'DEMO_SESSION_UNAVAILABLE');
        error(await app.inject({ method: 'POST', url: path, payload: {},
          headers: { ...headers, 'x-session-id': a.context.sessionId } }), 401, 'DEMO_SESSION_UNAVAILABLE');
      }
      assert.deepEqual(await state(), before); assert.equal(runtime.executors.size, size);
    });

    await t.test('Demo runtime has no anonymous Domain/raw/callback/internal-control bypass', async () => {
      const before = await state(); const size = runtime.executors.size;
      const original = ['/dataset-versions', '/calculation-jobs', ...['submit-validation', 'publish', 'reject', 'abandon']
        .map((action) => `/dataset-versions/${dataA.datasetVersionId}/${action}`),
        `/calculation-jobs/${dataA.jobId}/run`, `/calculation-jobs/${dataA.jobId}/reconcile`,
        '/internal/fake-executor/executions/run/succeed', '/internal/fake-executor/executions/run/fail',
        '/executor-callbacks/airflow', '/raw-ingestion-batches', '/demo/reset'];
      for (const path of original) {
        assert.equal((await post(path)).statusCode, 404);
        assert.equal((await post(path, a)).statusCode, 404);
      }
      assert.equal((await app.inject({ method: 'OPTIONS', url: '/demo/dataset-versions',
        headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' } })).statusCode, 404);
      assert.deepEqual(await state(), before); assert.equal(runtime.executors.size, size);
    });

    await t.test('owned invalid operations keep Domain error contracts and rollback', async () => {
      const session = await newSession(); const data = await create(session);
      for (const [payload, code] of [[{ domain: 'UNKNOWN', fiscalYear: 2026, period: 'Q3' }, 'INVALID_DOMAIN'],
        [{ domain: 'DPR', fiscalYear: 2026, period: 'Q5' }, 'INVALID_PERIOD'],
        [{ domain: 'DPR', fiscalYear: 0, period: 'Q3' }, 'INVALID_REQUEST']] as const) {
        error(await post('/demo/dataset-versions', session, payload), 400, code);
      }
      const before = await state();
      error(await post('/demo/dataset-versions', session, { domain: 'DPR', fiscalYear: 2026, period: 'Q3' }), 409, 'ACTIVE_DATASET_VERSION_EXISTS');
      error(await post('/demo/dataset-versions', session, { domain: 'INSURANCE', fiscalYear: 2026, period: 'Q3' }), 409, 'CALCULATION_TYPE_NOT_CONFIGURED');
      error(await post(`/demo/dataset-versions/${data.datasetVersionId}/submit-validation`, session), 409, 'DATASET_NOT_READY_FOR_VALIDATION');
      error(await reconcile(session, data.jobId), 409, 'EXECUTION_NOT_RECONCILABLE');
      error(await behavior(session, 'NOT_A_BEHAVIOR'), 400, 'INVALID_REQUEST');
      assert.deepEqual(await state(), before);
    });

    await t.test('dependency readiness cannot resolve another session company; frozen inputs stay owned', async () => {
      const typeId = (await pool.query(`INSERT INTO calculation_types
        (domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
        VALUES ('CAPEX','BASE','demo_capex',true,1) RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO execution_dependency_definition_versions
        (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now())`, [typeId]);
      const definitionId = randomUUID();
      await pool.query(`INSERT INTO execution_dependency_definition_versions
        (id,calculation_type_id,version,status,published_at) VALUES ($1,$2,2,'PUBLISHED',now())`, [definitionId, dprType]);
      await pool.query(`INSERT INTO execution_dependency_definition_dependencies
        (definition_version_id,required_domain) VALUES ($1,'CAPEX')`, [definitionId]);
      await pool.query('UPDATE calculation_types SET last_allocated_dependency_definition_version=2 WHERE id=$1', [dprType]);
      try {
        const owner = await newSession(); const other = await newSession();
        const capex = await create(owner, 'Q4', 'CAPEX', 2027);
        const execution = await run(owner, capex.jobId); assert.equal(execution.statusCode, 200);
        assert.equal((await control(owner, execution.json().executionAttemptId, 'SUCCEEDED')).statusCode, 200);
        assert.equal((await reconcile(owner, capex.jobId)).statusCode, 200);
        for (const action of ['submit-validation', 'publish']) {
          assert.equal((await post(`/demo/dataset-versions/${capex.datasetVersionId}/${action}`, owner)).statusCode, 200);
        }
        const ownDpr = await create(owner, 'Q4', 'DPR', 2027);
        const otherDpr = await create(other, 'Q4', 'DPR', 2027);
        assert.equal((await run(owner, ownDpr.jobId)).statusCode, 200);
        const before = await state();
        error(await run(other, otherDpr.jobId), 409, 'DEPENDENCY_NOT_READY');
        assert.deepEqual(await state(), before);
        assert.equal((await runtime.executors.forSession(other.context)).getDispatchHistory().length, 0);
        const pinned = (await pool.query(`SELECT ds.company_code, d.upstream_dataset_version_id
          FROM dataset_build_snapshot_dependencies d
          JOIN dataset_build_snapshots s ON s.id=d.snapshot_id
          JOIN dataset_series ds ON ds.id=d.upstream_dataset_series_id
          WHERE s.dataset_version_id=$1`, [ownDpr.datasetVersionId])).rows;
        assert.deepEqual(pinned, [{ company_code: owner.context.companyCode, upstream_dataset_version_id: capex.datasetVersionId }]);
      } finally {
        await pool.query(`INSERT INTO execution_dependency_definition_versions
          (calculation_type_id,version,status,published_at) VALUES ($1,3,'PUBLISHED',now())`, [dprType]);
        await pool.query('UPDATE calculation_types SET last_allocated_dependency_definition_version=3 WHERE id=$1', [dprType]);
      }
      await pool.query(`INSERT INTO calculation_types (domain,code,airflow_dag_id,is_active)
        VALUES ('INSURANCE','UNCONFIGURED','demo_insurance',true)`);
      const session = await newSession(); const unconfigured = await create(session, 'Q3', 'INSURANCE');
      const before = await state();
      error(await run(session, unconfigured.jobId), 409, 'DEPENDENCY_DEFINITION_NOT_READY');
      assert.deepEqual(await state(), before);
    });

    await t.test('registry rejection tombstones and lookup outages do not cross session namespaces', async () => {
      const first = await newSession(); const second = await newSession();
      const fakeOne = await runtime.executors.forSession(first.context); const fakeTwo = await runtime.executors.forSession(second.context);
      // Deliberately probe the same full identity directly to prove registry
      // separation, not to represent an authorized Domain dispatch. HTTP-owned
      // attempts and dispatches are covered separately above.
      const command = { ...(await runtime.executors.forSession(a.context)).getDispatchHistory()[0]!,
        executionAttemptId: randomUUID(), airflowDagRunId: `registry-probe-${randomUUID()}` };
      fakeOne.enqueueBehaviors('REJECT'); fakeTwo.enqueueBehaviors('ACCEPT_THEN_UNKNOWN');
      assert.equal((await fakeOne.dispatch(command)).kind, 'REJECTED');
      assert.equal((await fakeTwo.dispatch(command)).kind, 'UNKNOWN');
      assert.equal((await fakeOne.dispatch(command)).kind, 'REJECTED');
      assert.equal((await fakeTwo.dispatch(command)).kind, 'ALREADY_EXISTS');
      assert.equal(fakeOne.getExternalExecutions().length, 0); assert.equal(fakeTwo.getExternalExecutions().length, 1);
      fakeOne.setStatusLookupUnavailable('test-owned outage');
      assert.equal((await fakeOne.getExecutionStatus(command)).kind, 'UNAVAILABLE');
      assert.equal((await fakeTwo.getExecutionStatus(command)).kind, 'RUNNING');
      const data = await create(second); assert.equal((await run(second, data.jobId)).statusCode, 200);
      fakeTwo.setStatusLookupUnavailable('test-owned outage');
      const before = await state();
      error(await reconcile(second, data.jobId), 503, 'EXECUTOR_STATUS_UNAVAILABLE');
      assert.deepEqual(await state(), before);
      fakeTwo.clearStatusLookupUnavailable();
    });

    await t.test('same-session HTTP operations serialize through executor waits; different sessions proceed', async () => {
      for (const rejects of [false, true]) {
        const session = await newSession(); const other = await newSession();
        const firstData = await create(session); const secondData = await create(session, 'Q2');
        const otherData = await create(other);
        const blocked = new BarrierFake(); if (rejects) blocked.enqueueBehaviors('REJECT'); assigned.push(blocked);
        const first = run(session, firstData.jobId);
        await blocked.entered.promise;
        const queued = barrier(); let secondBodyStarted = false;
        const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
        runtime.coordinator.run = function<T>(context: AuthenticatedDemoSession, body: () => Promise<T>) {
          const result = originalRun(context, async () => {
            if (context.sessionId === session.context.sessionId) secondBodyStarted = true;
            return body();
          });
          if (context.sessionId === session.context.sessionId) queued.release();
          return result;
        };
        const second = run(session, secondData.jobId);
        try {
          await queued.promise;
          assert.equal(secondBodyStarted, false);
          const independent = await run(other, otherData.jobId); assert.equal(independent.statusCode, 200);
          assert.equal(secondBodyStarted, false);
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM dataset_versions WHERE id=$1 FOR UPDATE NOWAIT', [firstData.datasetVersionId]);
            await client.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE NOWAIT', [firstData.jobId]);
            await client.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 FOR UPDATE NOWAIT', [firstData.jobId]);
          } finally { await client.query('ROLLBACK'); client.release(); }
          assert.equal((await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'", [name])).rowCount, 0);
        } finally { runtime.coordinator.run = originalRun; blocked.finish.release(); }
        assert.equal((await first).statusCode, rejects ? 502 : 200);
        assert.equal((await second).statusCode, 200); assert.equal(secondBodyStarted, true);
        assert.equal(runtime.coordinator.activeSessionCount, 0);
        assert.equal(blocked.getDispatchHistory().length, 2);
      }
    });

    await t.test('queued HTTP operations revalidate expiry/revocation without cancelling admitted Run', async () => {
      for (const expires of [true, false]) {
        const session = await newSession(); const data = await create(session);
        const blocked = new BarrierFake(); assigned.push(blocked);
        const first = run(session, data.jobId); await blocked.entered.promise;
        const queued = barrier(); const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
        runtime.coordinator.run = function<T>(context: AuthenticatedDemoSession, body: () => Promise<T>) {
          const result = originalRun(context, body); queued.release(); return result;
        };
        const second = post('/demo/dataset-versions', session, { domain: 'DPR', fiscalYear: 2026, period: 'Q1' });
        try {
          await queued.promise;
          if (expires) await pool.query(`UPDATE demo_sessions SET created_at=clock_timestamp()-INTERVAL '5 hours',
            expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1`, [session.context.sessionId]);
          else await runtime.sessions.revoke(session.context.sessionId);
        } finally { runtime.coordinator.run = originalRun; blocked.finish.release(); }
        assert.equal((await first).statusCode, 200);
        error(await second, 401, 'DEMO_SESSION_UNAVAILABLE');
        assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM dataset_series WHERE company_code=$1 AND period=$2', [session.context.companyCode, 'Q1'])).rows[0].n, 0);
        assert.equal(blocked.getDispatchHistory().length, 1); assert.equal(runtime.coordinator.activeSessionCount, 0);
      }
    });

    await t.test('queue HTTP capacity rejects overflow and releases all pending requests', async () => {
      const session = await newSession(); const data = await create(session);
      const blocked = new BarrierFake(); assigned.push(blocked);
      const held = run(session, data.jobId); await blocked.entered.promise;
      const queued = barrier(); let count = 0; const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
      runtime.coordinator.run = function<T>(context: AuthenticatedDemoSession, body: () => Promise<T>) {
        const result = originalRun(context, body); if (++count === 31) queued.release(); return result;
      };
      const waiting = Array.from({ length: 31 }, () => behavior(session, 'ACCEPT'));
      try { await queued.promise; error(await behavior(session, 'ACCEPT'), 429, 'DEMO_SESSION_QUEUE_FULL'); }
      finally { runtime.coordinator.run = originalRun; blocked.finish.release(); }
      assert.equal((await held).statusCode, 200);
      assert.ok((await Promise.all(waiting)).every((response) => response.statusCode === 200));
      assert.equal(runtime.coordinator.activeSessionCount, 0);
    });

    await t.test('registry capacity fails before preparation; shared injected instances are rejected', async () => {
      const limited = new DemoRuntime(pool, 'test', { maxExecutors: 1 });
      const target = await buildApp({ appMode: 'demo', demoRuntime: limited, logger: false, nodeEnvironment: 'test',
        demoSession: { origin: 'https://demo.test' } }); apps.push(target);
      const first = await newSession(target, limited); const second = await newSession(target, limited);
      assert.equal((await post('/demo/fake-executor/dispatch-behavior', first, { behavior: 'ACCEPT' }, target)).statusCode, 200);
      const response = await post('/demo/dataset-versions', second, { domain: 'DPR', fiscalYear: 2026, period: 'Q3' }, target);
      assert.equal(response.statusCode, 201); const data = response.json();
      const before = await state();
      error(await post(`/demo/calculation-jobs/${data.calculationJobs[0].jobId}/run`, second, {}, target), 503, 'DEMO_EXECUTOR_CAPACITY_REACHED');
      assert.deepEqual(await state(), before);
      const shared = new FakeExecutor(); const invalid = new DemoRuntime(pool, 'test', { createExecutor: () => shared });
      const one = await invalid.sessions.create(); const two = await invalid.sessions.create();
      await invalid.executors.forSession(one.session);
      await assert.rejects(invalid.executors.forSession(two.session), /distinct/);
      assert.equal(invalid.executors.size, 1);
    });

    await t.test('configuration and production safety fail closed in app and actual server entrypoint', async () => {
      assert.equal(resolveAppMode(undefined, undefined), 'core'); assert.equal(resolveAppMode('demo', undefined), 'demo');
      for (const mode of ['', 'DEMO', 'invalid', ' demo']) {
        await assert.rejects(buildApp({ appMode: mode, logger: false }), /APP_MODE/);
      }
      assert.throws(() => resolveAppMode('core', 'demo'), /Conflicting/);
      await assert.rejects(buildApp({ appMode: 'demo', logger: false, nodeEnvironment: 'production' }), /production/);
      await assert.rejects(buildApp({ appMode: 'demo', logger: false, nodeEnvironment: 'test', calculationExecutor: new FakeExecutor() }), /global/);
      await assert.rejects(buildApp({ appMode: 'core', logger: false, demoRuntime: runtime }), /APP_MODE/);
      try {
        process.env.NODE_ENV = 'production';
        await assert.rejects(buildApp({ appMode: 'demo', nodeEnvironment: 'test', logger: false, demoRuntime: runtime }), /production/);
        process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'airflow';
        await assert.rejects(buildApp({ appMode: 'demo', logger: false }), /FakeExecutor/);
        process.env.EXECUTOR_TYPE = 'fake'; process.env.APP_MODE = 'invalid';
        await assert.rejects(buildApp({ appMode: 'core', logger: false }), /APP_MODE/);
      } finally { process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake'; delete process.env.APP_MODE; }
      for (const env of [{ APP_MODE: 'invalid', NODE_ENV: 'test' }, { APP_MODE: 'demo', NODE_ENV: 'production' }]) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
          env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000,
        });
        assert.equal(result.status, 1); assert.equal(result.signal, null);
        assert.match(result.stderr, /APP_MODE|production/);
        assert.doesNotMatch(result.stdout, /Server listening/);
      }
    });

    await t.test('core mode preserves original routes and does not expose protected Demo commands', async () => {
      const core = await buildApp({ appMode: 'core', logger: false, nodeEnvironment: 'test', calculationExecutor: new FakeExecutor() }); apps.push(core);
      error(await post('/dataset-versions', undefined, {}, core), 400, 'INVALID_REQUEST');
      error(await post(`/calculation-jobs/${randomUUID()}/run`, undefined, {}, core), 404, 'CALCULATION_JOB_NOT_FOUND');
      error(await post('/raw-ingestion-batches', undefined, {}, core), 400, 'INVALID_REQUEST');
      error(await post('/executor-callbacks/airflow', undefined, {}, core), 400, 'INVALID_REQUEST');
      error(await post('/internal/fake-executor/executions/unknown/succeed', undefined, {}, core), 404, 'FAKE_EXECUTION_NOT_FOUND');
      assert.equal((await post('/demo/dataset-versions', a, {}, core)).statusCode, 404);
    });
  } finally {
    try { await Promise.all(apps.map((app) => app.close())); if (db) { await db.end(); await Promise.all(ends); } }
    finally {
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      try {
        if (created) {
          assert.equal((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name])).rowCount, 0);
          assert.match(name, /^demo_01b1_test_[a-z0-9_]+$/);
          await admin.query(`DROP DATABASE "${name}"`);
          console.log('DEMO_01B1_TEARDOWN', JSON.stringify({ database: name, sessions: 0, dropped: true, forced: false }));
        }
      } finally { await admin.end(); }
    }
  }
});
