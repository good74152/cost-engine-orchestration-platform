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
import type { CreateDatasetVersionResult } from '../src/modules/dataset-version/dataset-version.types.js';
import type { DemoJobDto, DemoAttemptDto, DemoDatasetDetailDto } from '../src/modules/demo-session/demo-read.repository.js';
import type { CalculationJobRunResult } from '../src/modules/calculation-job.types.js';
import type { FakeRunSimulation } from '../src/executors/fake-executor.js';
import type { DatasetDomain } from '../src/modules/dataset-version/dataset-version.types.js';
import type { WorkflowTemplate, WorkflowTemplateSummary } from '../src/modules/workflow-template/workflow-template.types.js';
import { DemoAdmissionOperator } from '../src/modules/demo-admission/demo-admission.operator.js';
import { DemoCutoverOperator } from '../src/modules/demo-cutover/demo-cutover.operator.js';

const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error('Demo-05C-3B requires an explicit disposable TEST_DATABASE_URL');
const connection = (name: string) => { const url = new URL(source); url.pathname = '/' + name; return url.toString(); };
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
interface Page<T> { items: T[]; nextCursor: string | null }
interface Waiter { pid: number; blockers: number[]; wait_event: string }
const types: Record<DatasetDomain, string[]> = {
  FAB_COST: ['DEMO_FAB_COST_SUMMARY'], CAPEX: ['DEMO_CAPEX_TABLE_Y', 'DEMO_GUIDED_SUMMARY'],
  INSURANCE: ['DEMO_INSURANCE_SUMMARY'], ONE_STD_COST: ['DEMO_ONE_STD_COST_TABLE_X', 'DEMO_ONE_STD_COST_TABLE_Y'],
  DPR: ['DEMO_DPR_TABLE_X', 'DEMO_DPR_TABLE_Y'], E2E_COST: ['DEMO_E2E_COST_TABLE_X', 'DEMO_E2E_COST_TABLE_Y'],
};
const upstream: Partial<Record<DatasetDomain, DatasetDomain>> = {
  CAPEX: 'FAB_COST', INSURANCE: 'FAB_COST', ONE_STD_COST: 'FAB_COST', DPR: 'CAPEX', E2E_COST: 'ONE_STD_COST',
};
function result<T>(r: Response, status = 200): T {
  assert.equal(r.statusCode, status, r.body); assert.equal(r.headers['cache-control'], 'no-store'); return r.json<T>();
}
function error(r: Response, code: string, status = 409) {
  const body = result<{ code: string; message: string }>(r, status);
  assert.equal(body.code, code); assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.doesNotMatch(r.body, /postgres(?:ql)?:|token_hash|password|SELECT |INSERT /i);
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read(); if (ready(value)) return value;
    assert.ok(Date.now() < deadline, `PostgreSQL barrier timeout: ${label}`); await setImmediate();
  }
}

test('Demo-05C-3B: six-domain API workflow on real migrated/cutover PostgreSQL', { timeout: 240_000 }, async t => {
  const name = `demo_05c3b_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^demo_05c3b_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const admin = new Client({ connectionString: connection('postgres') }); await admin.connect();
  const prior = { ...process.env }; let created = false; let db: Pool | undefined; let app: FastifyInstance | undefined;
  const ends: Promise<void>[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await runner({ databaseUrl: connection(name), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.env.DATABASE_URL = connection(name); process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool }, { buildApp }, { DemoRuntime }, { seedDemoSixDomainConfiguration }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'), import('../src/modules/demo-session/demo-runtime.js'),
      import('./seed-demo-six-domain-configuration.js'),
    ]);
    db = pool; pool.on('connect', c => ends.push(new Promise<void>(done => c.once('end', done))));
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, name);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 14);
    await seedDemoSixDomainConfiguration(pool);
    const legacyDefinition = async () => (await pool.query(`SELECT to_jsonb(d) AS definition,
      ARRAY(SELECT to_jsonb(e) FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id) AS dependencies
      FROM execution_dependency_definition_versions d JOIN calculation_types c ON c.id=d.calculation_type_id
      WHERE c.domain='CAPEX' AND c.code='DEMO_GUIDED_SUMMARY' AND d.version=1`)).rows;
    const preservedV1 = await legacyDefinition(); assert.equal(preservedV1.length, 1);
    assert.equal((await new DemoAdmissionOperator(pool).drain()).state, 'DRAINING');
    const cutover = new DemoCutoverOperator(pool);
    assert.equal((await cutover.cutover()).outcome, 'APPLIED');
    assert.equal((await cutover.status()).state, 'WORKFLOW_OPEN');
    const runtime = new DemoRuntime(pool, 'test', {}, { log() {} });
    app = await buildApp({ appMode: 'demo', demoRuntime: runtime, nodeEnvironment: 'test', logger: false,
      demoSession: { origin: 'https://demo.test' } });
    const post = (url: string, s?: Session, payload: unknown = {}) => app!.inject({ method: 'POST', url,
      payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', origin: 'https://demo.test',
        'x-demo-session': '1', ...(s ? { cookie: s.cookie } : {}) } });
    const get = (url: string, s: Session) => app!.inject({ method: 'GET', url,
      headers: { cookie: s.cookie, origin: 'https://demo.test' } });
    const session = async (): Promise<Session> => {
      const r = await post('/demo/sessions'); result(r, 201);
      const cookie = String(r.headers['set-cookie']).split(';')[0]!;
      return { cookie, context: await runtime.sessions.authenticate(cookie, 'ce_demo_session') };
    };
    // limit=1 forces traversal of every page for multi-job Datasets and Retry history.
    const pages = async <T>(url: string, s: Session): Promise<T[]> => {
      const all: T[] = []; const seen = new Set<string>(); let cursor: string | null = null;
      do {
        const page: Page<T> = result(await get(`${url}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, s));
        all.push(...page.items); cursor = page.nextCursor;
        if (cursor) { assert.ok(!seen.has(cursor)); seen.add(cursor); }
      } while (cursor);
      return all;
    };
    const jobs = (s: Session, d: CreateDatasetVersionResult) => pages<DemoJobDto>(`/demo/dataset-versions/${d.datasetVersionId}/calculation-jobs`, s);
    const attempts = (s: Session, job: string) => pages<DemoAttemptDto>(`/demo/calculation-jobs/${job}/execution-attempts`, s);
    const create = async (s: Session, domain: DatasetDomain, fiscalYear = 2026, period = 'Q4') => {
      const d = result<CreateDatasetVersionResult>(await post('/demo/dataset-versions', s, { domain, fiscalYear, period }), 201);
      const list = await jobs(s, d);
      assert.deepEqual(list.map(j => j.calculationTypeCode).sort(), types[domain]);
      assert.deepEqual(list.map(j => j.jobId).sort(), d.calculationJobs.map(j => j.jobId).sort());
      assert.ok(list.every(j => j.jobStatus === 'PENDING'));
      return d;
    };
    const run = (s: Session, job: string, simulation: FakeRunSimulation = { dispatch: 'ACCEPT', completion: 'RUNNING' }) =>
      post(`/demo/calculation-jobs/${job}/run`, s, { simulation });
    const reconcile = (s: Session, job: string) => post(`/demo/calculation-jobs/${job}/reconcile`, s);
    const lifecycle = (s: Session, d: CreateDatasetVersionResult, command: string) => post(`/demo/dataset-versions/${d.datasetVersionId}/${command}`, s);
    const succeed = async (s: Session, job: string, attempt: string) => {
      result(await post(`/demo/execution-attempts/${attempt}/fake-state`, s, { state: 'SUCCEEDED' }));
      result(await reconcile(s, job));
    };
    const ready = async (s: Session, d: CreateDatasetVersionResult) => {
      for (const job of await jobs(s, d)) {
        const r = result<CalculationJobRunResult>(await run(s, job.jobId));
        await succeed(s, job.jobId, r.executionAttemptId);
      }
      result(await lifecycle(s, d, 'submit-validation'));
    };
    const publish = async (s: Session, d: CreateDatasetVersionResult) => { await ready(s, d); result(await lifecycle(s, d, 'publish')); };
    const publishFab = async (s: Session, year = 2026, period = 'Q4') => {
      const d = await create(s, 'FAB_COST', year, period); await publish(s, d); return d;
    };
    const frozen = async (d: CreateDatasetVersionResult) => ({
      snapshots: (await pool.query('SELECT to_jsonb(s) AS row FROM dataset_build_snapshots s WHERE dataset_version_id=$1', [d.datasetVersionId])).rows,
      dependencies: (await pool.query(`SELECT to_jsonb(e) AS row FROM dataset_build_snapshot_dependencies e
        JOIN dataset_build_snapshots s ON s.id=e.snapshot_id WHERE s.dataset_version_id=$1 ORDER BY e.upstream_dataset_series_id`, [d.datasetVersionId])).rows,
      definitions: (await pool.query(`SELECT id,resolved_dependency_definition_version_id FROM calculation_jobs
        WHERE output_dataset_version_id=$1 ORDER BY id`, [d.datasetVersionId])).rows,
    });
    const assertSnapshot = async (d: CreateDatasetVersionResult, dependency?: CreateDatasetVersionResult) => {
      const f = await frozen(d); assert.equal(f.snapshots.length, 1);
      assert.equal(f.dependencies.length, dependency ? 1 : 0);
      if (dependency) {
        assert.equal(f.dependencies[0]!.row.upstream_dataset_series_id, dependency.datasetSeriesId);
        assert.equal(f.dependencies[0]!.row.upstream_dataset_version_id, dependency.datasetVersionId);
      }
      assert.ok(f.definitions.every(j => j.resolved_dependency_definition_version_id)); return f;
    };
    const assertPublished = async (s: Session, d: CreateDatasetVersionResult) => {
      const detail = result<DemoDatasetDetailDto>(await get(`/demo/dataset-versions/${d.datasetVersionId}`, s));
      assert.equal(detail.datasetStatus, 'PUBLISHED'); assert.ok(detail.publishedAt);
      for (const j of await jobs(s, d)) {
        assert.equal(j.jobStatus, 'SUCCEEDED'); const history = await attempts(s, j.jobId);
        assert.ok(history.length); assert.equal(history.at(-1)!.attemptStatus, 'SUCCEEDED');
        assert.ok(history.every(a => a.finishedAt && (a.attemptStatus === 'FAILED' || a.attemptStatus === 'SUCCEEDED')));
      }
    };
    const notReady = async (s: Session, d: CreateDatasetVersionResult, required: DatasetDomain) => {
      const before = await frozen(d); const fake = await runtime.executors.forSession(s.context);
      const dispatches = fake.getDispatchHistory().length;
      for (const j of await jobs(s, d)) {
        const r = await run(s, j.jobId); error(r, 'DEPENDENCY_NOT_READY');
        assert.equal(r.json().message, `Published upstream dataset is not ready for: ${required}`);
        assert.deepEqual(await attempts(s, j.jobId), []);
      }
      assert.deepEqual(await frozen(d), before);
      assert.deepEqual(before.snapshots, []); assert.deepEqual(before.dependencies, []);
      assert.ok(before.definitions.every(j => j.resolved_dependency_definition_version_id === null));
      assert.equal(result<DemoDatasetDetailDto>(await get(`/demo/dataset-versions/${d.datasetVersionId}`, s)).datasetStatus, 'DRAFT');
      assert.equal(fake.getDispatchHistory().length, dispatches);
    };
    const capexDefinitions = async (d: CreateDatasetVersionResult) => {
      const rows = (await pool.query(`SELECT c.code,d.version,d.status,e.required_domain FROM calculation_jobs j
        JOIN calculation_types c ON c.id=j.calculation_type_id
        JOIN execution_dependency_definition_versions d ON d.id=j.resolved_dependency_definition_version_id
        JOIN execution_dependency_definition_dependencies e ON e.definition_version_id=d.id
        WHERE j.output_dataset_version_id=$1 ORDER BY c.code`, [d.datasetVersionId])).rows;
      assert.deepEqual(rows.map(r => [r.code, r.version, r.status, r.required_domain]), [
        ['DEMO_CAPEX_TABLE_Y', 1, 'PUBLISHED', 'FAB_COST'], ['DEMO_GUIDED_SUMMARY', 2, 'PUBLISHED', 'FAB_COST'],
      ]);
    };

    await t.test('six published Domains, ten correct Jobs/Attempts and all five frozen direct dependencies', async () => {
      const s = await session(); const data = new Map<DatasetDomain, CreateDatasetVersionResult>();
      for (const domain of Object.keys(types) as DatasetDomain[]) data.set(domain, await create(s, domain));
      for (const [domain, required] of Object.entries(upstream)) await notReady(s, data.get(domain as DatasetDomain)!, required);
      for (const domain of Object.keys(types) as DatasetDomain[]) {
        const d = data.get(domain)!; await publish(s, d); await assertPublished(s, d);
        const required = upstream[domain]; await assertSnapshot(d, required ? data.get(required) : undefined);
        for (const j of await jobs(s, d)) assert.equal((await attempts(s, j.jobId)).length, 1);
      }
      await capexDefinitions(data.get('CAPEX')!);
      const definitions = (await pool.query(`SELECT c.domain,c.code,d.version,d.status,
        ARRAY(SELECT required_domain FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id ORDER BY required_domain) AS deps
        FROM calculation_jobs j JOIN calculation_types c ON c.id=j.calculation_type_id
        JOIN execution_dependency_definition_versions d ON d.id=j.resolved_dependency_definition_version_id
        WHERE j.output_dataset_version_id=ANY($1::uuid[]) ORDER BY c.domain,c.code`, [[...data.values()].map(d => d.datasetVersionId)])).rows;
      assert.equal(definitions.length, 10);
      for (const row of definitions) {
        assert.equal(row.status, 'PUBLISHED');
        assert.equal(row.version, row.code === 'DEMO_GUIDED_SUMMARY' ? 2 : 1);
        const required = upstream[row.domain as DatasetDomain]; assert.deepEqual(row.deps, required ? [required] : []);
      }
      const identities = (await pool.query(`SELECT ds.domain,ds.company_code,ds.fiscal_year,ds.period,v.status,
        (SELECT count(*)::int FROM calculation_jobs j WHERE j.output_dataset_version_id=v.id) AS jobs
        FROM dataset_versions v JOIN dataset_series ds ON ds.id=v.dataset_series_id
        WHERE ds.company_code=$1 ORDER BY ds.domain`, [s.context.companyCode])).rows;
      assert.equal(identities.length, 6); assert.equal(identities.reduce((n, r) => n + r.jobs, 0), 10);
      assert.ok(identities.every(r => r.company_code === s.context.companyCode && r.fiscal_year === 2026 && r.period === 'Q4' && r.status === 'PUBLISHED'));
      const fake = await runtime.executors.forSession(s.context); assert.equal(fake.getExternalExecutions().length, 10);
      for (const command of fake.getDispatchHistory()) {
        const domain = [...data].find(([, d]) => d.datasetVersionId === command.datasetVersionId)![0];
        const required = upstream[domain];
        const f = await frozen(data.get(domain)!);
        assert.equal(command.datasetBuildSnapshotId, f.snapshots[0]!.row.id);
        assert.equal(command.resolvedDependencyDefinitionVersionId, f.definitions.find(j => j.id === command.jobId)!.resolved_dependency_definition_version_id);
        assert.equal(command.upstreamDatasetVersions.length, required ? 1 : 0);
        if (required) {
          const input = command.upstreamDatasetVersions[0]!;
          assert.equal(input.datasetVersionId, data.get(required)!.datasetVersionId);
          assert.equal(input.domain, required); assert.equal(input.companyCode, s.context.companyCode);
          assert.equal(input.fiscalYear, 2026); assert.equal(input.period, 'Q4');
        }
      }
    });

    for (const mismatch of ['fiscal-year', 'period', 'session'] as const) await t.test(`published upstream in another ${mismatch} cannot satisfy CAPEX; rejection is atomic`, async () => {
      const s = await session(); const owner = mismatch === 'session' ? await session() : s;
      await publishFab(owner, mismatch === 'fiscal-year' ? 2025 : 2026, mismatch === 'period' ? 'Q3' : 'Q4');
      const capex = await create(s, 'CAPEX'); await notReady(s, capex, 'FAB_COST');
      const matching = await publishFab(s); await publish(s, capex); await assertSnapshot(capex, matching); await assertPublished(s, capex);
    });

    await t.test('two CAPEX Jobs freeze one FAB_COST v1; later Job stays on v1 and new CAPEX version selects FAB_COST v2', async () => {
      const s = await session(); const fab1 = await publishFab(s); const capex1 = await create(s, 'CAPEX');
      const [a, b] = await jobs(s, capex1); assert.ok(a && b);
      const first = result<CalculationJobRunResult>(await run(s, a.jobId));
      const original = await assertSnapshot(capex1, fab1); await capexDefinitions(capex1);
      const fab2 = await publishFab(s); assert.equal(fab2.version, fab1.version + 1);
      const second = result<CalculationJobRunResult>(await run(s, b.jobId));
      assert.equal(first.datasetBuildSnapshotId, second.datasetBuildSnapshotId);
      assert.deepEqual(await frozen(capex1), original);
      for (const r of [first, second]) await succeed(s, r.jobId, r.executionAttemptId);
      result(await lifecycle(s, capex1, 'submit-validation')); result(await lifecycle(s, capex1, 'publish'));
      const capex2 = await create(s, 'CAPEX'); assert.equal(capex2.version, capex1.version + 1);
      await publish(s, capex2); await assertSnapshot(capex2, fab2); await assertPublished(s, capex2);
      assert.deepEqual(await frozen(capex1), original); assert.deepEqual(await legacyDefinition(), preservedV1);
      const commands = (await runtime.executors.forSession(s.context)).getDispatchHistory().filter(c => c.datasetVersionId === capex1.datasetVersionId);
      assert.equal(commands.length, 2); assert.ok(commands.every(c => c.upstreamDatasetVersions[0]!.datasetVersionId === fab1.datasetVersionId));
    });

    await t.test('Retry only failed CAPEX Job, preserve failed history/identity and snapshot despite newer FAB_COST', async () => {
      const s = await session(); const fab = await publishFab(s); const capex = await create(s, 'CAPEX');
      const [a, b] = await jobs(s, capex); assert.ok(a && b);
      const first = result<CalculationJobRunResult>(await run(s, a.jobId));
      const other = result<CalculationJobRunResult>(await run(s, b.jobId));
      const original = await assertSnapshot(capex, fab);
      result(await post(`/demo/execution-attempts/${first.executionAttemptId}/fake-state`, s, { state: 'FAILED' }));
      result(await reconcile(s, a.jobId));
      const failed = await attempts(s, a.jobId); assert.equal(failed[0]!.attemptStatus, 'FAILED');
      const failedRow = (await pool.query('SELECT to_jsonb(a) AS row FROM execution_attempts a WHERE id=$1', [first.executionAttemptId])).rows;
      error(await lifecycle(s, capex, 'submit-validation'), 'DATASET_NOT_READY_FOR_VALIDATION');
      await publishFab(s);
      const retried = result<CalculationJobRunResult>(await run(s, a.jobId));
      assert.equal(retried.attemptNumber, 2); assert.notEqual(retried.executionAttemptId, first.executionAttemptId);
      assert.notEqual(retried.airflowDagRunId, first.airflowDagRunId); assert.equal(retried.airflowDagId, first.airflowDagId);
      assert.equal(retried.datasetBuildSnapshotId, first.datasetBuildSnapshotId);
      await succeed(s, a.jobId, retried.executionAttemptId);
      // Job A is now successful, but B is still RUNNING: validation must still fail.
      error(await lifecycle(s, capex, 'submit-validation'), 'DATASET_NOT_READY_FOR_VALIDATION');
      await succeed(s, b.jobId, other.executionAttemptId);
      result(await lifecycle(s, capex, 'submit-validation')); result(await lifecycle(s, capex, 'publish'));
      const history = await attempts(s, a.jobId); assert.deepEqual(history.map(a => [a.attemptNumber, a.attemptStatus]), [[1, 'FAILED'], [2, 'SUCCEEDED']]);
      assert.deepEqual(history[0], failed[0]); assert.equal((await attempts(s, b.jobId)).length, 1);
      assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS row FROM execution_attempts a WHERE id=$1', [first.executionAttemptId])).rows, failedRow);
      assert.deepEqual(await frozen(capex), original); await assertPublished(s, capex);
      const commands = (await runtime.executors.forSession(s.context)).getDispatchHistory().filter(c => c.datasetVersionId === capex.datasetVersionId);
      assert.equal(commands.length, 3); assert.equal(commands.filter(c => c.jobId === b.jobId).length, 1);
      assert.ok(commands.every(c => c.upstreamDatasetVersions[0]!.datasetVersionId === fab.datasetVersionId));
    });

    await t.test('lost ACK leaves one real execution; Run recovery keeps the original attempt/DAG/run identity while other Job completes independently', async () => {
      const s = await session(); const fab = await publishFab(s); const capex = await create(s, 'CAPEX');
      const [a, b] = await jobs(s, capex); assert.ok(a && b);
      const unknown = result<CalculationJobRunResult>(await run(s, a.jobId, { dispatch: 'ACCEPT_THEN_UNKNOWN', completion: 'RUNNING' }), 202);
      assert.equal(unknown.dispatchOutcome, 'UNKNOWN'); assert.equal(unknown.attemptStatus, 'DISPATCHING'); assert.equal(unknown.jobStatus, 'PENDING');
      const fake = await runtime.executors.forSession(s.context);
      const external = () => fake.getExternalExecutions().filter(e => e.command.datasetVersionId === capex.datasetVersionId);
      assert.equal(external().length, 1); assert.equal(external()[0]!.airflowDagRunId, unknown.airflowDagRunId);
      const original = await assertSnapshot(capex, fab);
      const other = result<CalculationJobRunResult>(await run(s, b.jobId)); await succeed(s, b.jobId, other.executionAttemptId);
      assert.equal((await attempts(s, a.jobId))[0]!.attemptStatus, 'DISPATCHING');
      const recovered = result<CalculationJobRunResult>(await run(s, a.jobId));
      assert.equal(recovered.dispatchOutcome, 'ALREADY_EXISTS'); assert.equal(recovered.attemptStatus, 'ACCEPTED');
      for (const key of ['executionAttemptId', 'attemptNumber', 'airflowDagId', 'airflowDagRunId', 'datasetBuildSnapshotId'] as const)
        assert.equal(recovered[key], unknown[key]);
      assert.equal(external().length, 2); assert.equal((await attempts(s, a.jobId)).length, 1);
      await succeed(s, a.jobId, recovered.executionAttemptId);
      result(await lifecycle(s, capex, 'submit-validation')); result(await lifecycle(s, capex, 'publish'));
      await assertPublished(s, capex); assert.deepEqual(await frozen(capex), original);
      assert.equal(fake.getDispatchHistory().filter(c => c.jobId === a.jobId).length, 2);
    });

    // SQL-only barriers hold existing rows. They do not change business/configuration state
    // or replace any service. Requests proceed only after pg_blocking_pids proves contention.
    const waiters = (fragment: string, count = 1) => until(async () => (await pool.query<Waiter>(`SELECT pid,
      pg_blocking_pids(pid) AS blockers,wait_event FROM pg_stat_activity
      WHERE datname=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE $2 ORDER BY pid`, [name, `%${fragment}%`])).rows,
    rows => rows.length === count && rows.every(r => r.blockers.length > 0), fragment);
    const lock = async (table: 'dataset_versions' | 'calculation_types', id: string) => {
      const client = new Client({ connectionString: connection(name) }); await client.connect();
      try {
        await client.query('BEGIN'); await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
        return { client, pid: Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) };
      } catch (e) { await client.end(); throw e; }
    };
    const evidence: { test: string; holder: number; waiters: Waiter[]; selectedVersion?: number }[] = [];

    await t.test('concurrent CAPEX first Runs really wait on configuration locks and converge on one snapshot', async () => {
      const s = await session(); const fab = await publishFab(s); const capex = await create(s, 'CAPEX');
      const [a, b] = await jobs(s, capex); assert.ok(a && b);
      const typeId = (await pool.query("SELECT id FROM calculation_types WHERE domain='CAPEX' ORDER BY domain,code LIMIT 1")).rows[0].id;
      const held = await lock('calculation_types', typeId); const pending: Promise<Response>[] = [];
      try {
        pending.push(run(s, a.jobId)); await waiters('FROM calculation_types');
        pending.push(run(s, b.jobId)); const both = await waiters('FROM calculation_types', 2);
        assert.equal(new Set(both.map(r => r.pid)).size, 2); assert.ok(both.some(r => r.blockers.includes(held.pid)));
        assert.ok(both.every(r => r.blockers.some(p => p === held.pid || both.some(w => w.pid === p))));
        assert.deepEqual((await frozen(capex)).snapshots, []);
        evidence.push({ test: 'two-first-runs', holder: held.pid, waiters: both });
      } finally { await held.client.query('ROLLBACK'); await held.client.end(); await Promise.allSettled(pending); }
      assert.equal(pending.length, 2);
      const runs = (await Promise.all(pending)).map(r => result<CalculationJobRunResult>(r));
      assert.equal(runs[0]!.datasetBuildSnapshotId, runs[1]!.datasetBuildSnapshotId);
      await assertSnapshot(capex, fab); await capexDefinitions(capex);
      for (const r of runs) { assert.equal(r.attemptNumber, 1); await succeed(s, r.jobId, r.executionAttemptId); assert.equal((await attempts(s, r.jobId)).length, 1); }
      result(await lifecycle(s, capex, 'submit-validation')); result(await lifecycle(s, capex, 'publish')); await assertPublished(s, capex);
    });

    for (const order of ['publish-first', 'run-first'] as const) await t.test(`FAB_COST Publish vs CAPEX first Run: proven ${order} ordering`, async () => {
      const s = await session(); const fab1 = await publishFab(s); const fab2 = await create(s, 'FAB_COST'); await ready(s, fab2);
      const capex = await create(s, 'CAPEX'); const [a, b] = await jobs(s, capex); assert.ok(a && b);
      const held = await lock('dataset_versions', order === 'publish-first' ? fab2.datasetVersionId : capex.datasetVersionId);
      let first: Promise<Response> | undefined; let second: Promise<Response> | undefined;
      try {
        first = order === 'publish-first' ? lifecycle(s, fab2, 'publish') : run(s, a.jobId);
        const [winner] = await waiters('FROM dataset_versions'); assert.ok(winner!.blockers.includes(held.pid));
        second = order === 'publish-first' ? run(s, a.jobId) : lifecycle(s, fab2, 'publish');
        const [loser] = await waiters('FROM dataset_series'); assert.ok(loser!.blockers.includes(winner!.pid));
        assert.notEqual(winner!.pid, loser!.pid);
        // Winner holds publication visibility; loser cannot reach its decision.
        const rowLock = await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='dataset_series'::regclass
          AND mode='RowShareLock' AND granted`, [winner!.pid]); assert.equal(rowLock.rowCount, 1);
        assert.deepEqual((await frozen(capex)).snapshots, []);
        evidence.push({ test: order, holder: held.pid, waiters: [winner!, loser!], selectedVersion: order === 'publish-first' ? 2 : 1 });
      } finally {
        await held.client.query('ROLLBACK'); await held.client.end();
        await Promise.allSettled([first, second].filter((p): p is Promise<Response> => !!p));
      }
      assert.ok(first); assert.ok(second); const responses = await Promise.all([first, second]);
      responses.forEach(r => result(r));
      const initial = result<CalculationJobRunResult>(responses[order === 'publish-first' ? 1 : 0]!);
      const selected = order === 'publish-first' ? fab2 : fab1; const original = await assertSnapshot(capex, selected);
      const later = result<CalculationJobRunResult>(await run(s, b.jobId));
      assert.equal(later.datasetBuildSnapshotId, initial.datasetBuildSnapshotId); assert.deepEqual(await frozen(capex), original);
      for (const r of [initial, later]) { await succeed(s, r.jobId, r.executionAttemptId); assert.equal((await attempts(s, r.jobId)).length, 1); }
      await capexDefinitions(capex); result(await lifecycle(s, capex, 'submit-validation')); result(await lifecycle(s, capex, 'publish'));
      await assertPublished(s, capex); await assertPublished(s, fab2);
    });

    await t.test('v2 PREVIEW list/details remain read-only in WORKFLOW_OPEN and preserve Legacy Definition v1', async () => {
      const s = await session();
      const dump = async () => {
        const rows: Record<string, unknown> = {};
        for (const { tablename } of (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
          assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
          rows[tablename] = (await pool.query(`SELECT to_jsonb(r) AS row FROM "${tablename}" r ORDER BY to_jsonb(r)::text`)).rows;
        } return rows;
      };
      const before = await dump(); const fakes = runtime.executors.size;
      const list = result<{ templates: WorkflowTemplateSummary[] }>(await get('/demo/workflow-templates', s));
      assert.equal(list.templates.length, 4);
      for (const summary of list.templates) {
        assert.equal(summary.version, 2); assert.equal(summary.availability, 'PREVIEW');
        const { steps, ...detail } = result<WorkflowTemplate>(await get(`/demo/workflow-templates/${summary.id}`, s));
        assert.deepEqual(detail, summary); assert.ok(steps.length);
      }
      assert.deepEqual(await dump(), before); assert.equal(runtime.executors.size, fakes);
      assert.deepEqual(await legacyDefinition(), preservedV1);
    });
    for (const row of evidence) t.diagnostic(`POSTGRES_LOCK_EVIDENCE ${JSON.stringify(row)}`);
    console.info('DEMO_05C3B_VERIFIED', JSON.stringify({ migrations: 14, gate: 'WORKFLOW_OPEN', domains: 6, jobs: 10,
      lockSchedules: evidence.length, coreModified: false }));
  } finally {
    await app?.close(); await db?.end(); await Promise.all(ends);
    for (const key of ['DATABASE_URL', 'APP_MODE', 'NODE_ENV', 'EXECUTOR_TYPE']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    try {
      if (created) {
        await until(async () => (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name])).rowCount, n => n === 0, 'fixture teardown');
        assert.match(name, /^demo_05c3b_[a-z0-9_]+$/); await admin.query(`DROP DATABASE "${name}"`);
        console.info('DEMO_05C3B_TEARDOWN', JSON.stringify({ dropped: true, backends: 0, forced: false }));
      }
    } finally { await admin.end(); }
  }
});
