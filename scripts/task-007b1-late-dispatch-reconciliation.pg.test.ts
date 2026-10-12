import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Client, type Pool, type PoolClient } from 'pg';
import type {
  CalculationExecutor, DispatchCalculationCommand, DispatchResult,
  ExecutionIdentity, ExecutorExecutionStatus,
} from '../src/executors/calculation-executor.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { CreateDatasetVersionResult } from '../src/modules/dataset-version/dataset-version.types.js';

const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('TEST_DATABASE_URL or DATABASE_URL must point to PostgreSQL');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Watchdogs only: barriers and PostgreSQL's blocking graph establish ordering.
async function bounded<T>(promise: PromiseLike<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

class DelayedExecutor implements CalculationExecutor {
  readonly fake: FakeExecutor;
  private calls = 0;
  private readonly enteredGate = deferred<{ command: DispatchCalculationCommand; outcome: DispatchResult }>();
  private readonly releaseGate = deferred<void>();
  readonly entered = this.enteredGate.promise;

  constructor(private readonly outcome: DispatchResult['kind'] = 'ACCEPTED') {
    this.fake = new FakeExecutor({ scriptedBehaviors: outcome === 'UNKNOWN' ? ['ACCEPT_THEN_UNKNOWN'] : [] });
  }

  async dispatch(command: DispatchCalculationCommand): Promise<DispatchResult> {
    const index = this.calls++;
    let result = await this.fake.dispatch(command);
    if (index !== 0) return result;
    if (this.outcome === 'ALREADY_EXISTS') result = await this.fake.dispatch(command);
    if (this.outcome === 'REJECTED') {
      // Explicitly dishonest fixture: execution exists but adapter claims definite no-run.
      result = { kind: 'REJECTED', message: 'TEST CONTRACT CONTRADICTION: execution already exists' };
    }
    assert.equal(result.kind, this.outcome);
    this.enteredGate.resolve({ command, outcome: result });
    await this.releaseGate.promise;
    return result;
  }

  async getExecutionStatus(identity: ExecutionIdentity): Promise<ExecutorExecutionStatus> {
    return this.fake.getExecutionStatus(identity);
  }

  release(): void { this.releaseGate.resolve(); }
}

type Row = Record<string, unknown>;
type HttpResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

test('Task 007B-1 late dispatch PostgreSQL regression and lock boundaries', { concurrency: false }, async (t) => {
  const name = `late_dispatch_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^late_dispatch_test_[a-z0-9_]+$/);
  assert.ok(name.length <= 63);
  function url(database: string) {
    const parsed = new URL(sourceUrl!);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }
  const admin = new Client({ connectionString: url('postgres') });
  const previousUrl = process.env.DATABASE_URL;
  let applicationPool: Pool | undefined;
  let app: FastifyInstance | undefined;
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  try {
    await runner({ databaseUrl: url(name), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.env.DATABASE_URL = url(name);
    const [{ pool }, { buildApp }] = await Promise.all([import('../src/db/pool.js'), import('../src/app.js')]);
    applicationPool = pool;
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM pgmigrations WHERE name = $1',
      ['1788700000000_orchestration-schema-v2'])).rows[0]!.count, 1);
    console.log(`CON01_RUNTIME ${JSON.stringify({ node: process.version,
      postgres: (await pool.query('SELECT version() AS version')).rows[0]!.version,
      setup: 'Owned late_dispatch_test_* database; template0; all migrations up; dropped in finally' })}`);

    async function post(path: string, payload?: object) {
      return bounded(app!.inject({ method: 'POST', url: path, ...(payload ? { payload } : {}) }), path);
    }
    async function run(jobId: string) { return post(`/calculation-jobs/${jobId}/run`); }
    async function reconcile(jobId: string) { return post(`/calculation-jobs/${jobId}/reconcile`); }
    async function create(domain: string): Promise<CreateDatasetVersionResult> {
      const response = await post('/dataset-versions', { domain, companyCode: 'TW01', fiscalYear: 2026, period: 'Q3' });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    }
    async function configure(domain: string, code: string, dependencies: string[]) {
      const typeId = randomUUID();
      const definitionId = randomUUID();
      await pool.query(`INSERT INTO calculation_types
        (id, domain, code, airflow_dag_id, is_active, last_allocated_dependency_definition_version)
        VALUES ($1, $2, $3, $4, TRUE, 1)`, [typeId, domain, code, `dag_${domain}_${code}`]);
      await pool.query(`INSERT INTO execution_dependency_definition_versions
        (id, calculation_type_id, version, status, published_at) VALUES ($1, $2, 1, 'PUBLISHED', NOW())`, [definitionId, typeId]);
      for (const required of dependencies) {
        await pool.query(`INSERT INTO execution_dependency_definition_dependencies
          (definition_version_id, required_domain) VALUES ($1, $2)`, [definitionId, required]);
      }
    }
    async function fixture(executor: DelayedExecutor) {
      if (app) await app.close();
      assert.equal((await pool.query('SELECT current_database() AS name')).rows[0]!.name, name);
      await pool.query('TRUNCATE dataset_series, calculation_types CASCADE');
      const upstreamExecutor = new FakeExecutor();
      app = await buildApp({ logger: false, calculationExecutor: upstreamExecutor, nodeEnvironment: 'test' });
      await configure('CAPEX', 'SOURCE', []);
      const upstream = await create('CAPEX');
      const dispatched = await run(upstream.calculationJobs[0]!.jobId);
      assert.equal(dispatched.statusCode, 200);
      upstreamExecutor.setExecutionState(dispatched.json(), 'SUCCEEDED');
      assert.equal((await reconcile(upstream.calculationJobs[0]!.jobId)).statusCode, 200);
      for (const action of ['submit-validation', 'publish']) {
        assert.equal((await post(`/dataset-versions/${upstream.datasetVersionId}/${action}`)).statusCode, 200);
      }
      await configure('DPR', 'TABLE_X', ['CAPEX']);
      await configure('DPR', 'TABLE_Y', []);
      const dataset = await create('DPR');
      await app.close();
      app = await buildApp({ logger: false, calculationExecutor: executor, nodeEnvironment: 'test' });
      return { dataset, jobId: dataset.calculationJobs.find((job) => job.calculationTypeCode === 'TABLE_X')!.jobId,
        otherJobId: dataset.calculationJobs.find((job) => job.calculationTypeCode === 'TABLE_Y')!.jobId };
    }
    async function state(datasetId: string) {
      const [dataset, jobs, attempts, snapshots, dependencies] = await Promise.all([
        pool.query('SELECT * FROM dataset_versions WHERE id = $1', [datasetId]),
        pool.query('SELECT * FROM calculation_jobs WHERE output_dataset_version_id = $1 ORDER BY id', [datasetId]),
        pool.query(`SELECT ea.* FROM execution_attempts ea JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
          WHERE cj.output_dataset_version_id = $1 ORDER BY ea.calculation_job_id, ea.attempt_number`, [datasetId]),
        pool.query('SELECT * FROM dataset_build_snapshots WHERE dataset_version_id = $1', [datasetId]),
        pool.query(`SELECT dep.* FROM dataset_build_snapshot_dependencies dep JOIN dataset_build_snapshots s ON s.id = dep.snapshot_id
          WHERE s.dataset_version_id = $1 ORDER BY dep.upstream_dataset_series_id`, [datasetId]),
      ]);
      return { dataset: dataset.rows[0]!, jobs: jobs.rows as Row[], attempts: attempts.rows as Row[],
        snapshots: snapshots.rows as Row[], dependencies: dependencies.rows as Row[] };
    }
    type State = Awaited<ReturnType<typeof state>>;
    function assertFrozen(before: State, after: State) {
      assert.equal(after.snapshots.length, 1);
      assert.equal(after.dependencies.length, 1);
      assert.deepEqual(after.snapshots, before.snapshots);
      assert.deepEqual(after.dependencies, before.dependencies);
      assert.deepEqual(after.jobs.map((job) => job.resolved_dependency_definition_version_id),
        before.jobs.map((job) => job.resolved_dependency_definition_version_id));
      assert.ok(after.jobs.every((job) => job.resolved_dependency_definition_version_id));
    }
    function assertResponse(response: HttpResponse, command: DispatchCalculationCommand, current: State, dispatchOutcome: string) {
      console.log(`CON01_HTTP ${JSON.stringify({ status: response.statusCode, body: response.json() })}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), {
        datasetVersionId: command.datasetVersionId, datasetStatus: current.dataset.status,
        datasetBuildSnapshotId: command.datasetBuildSnapshotId, jobId: command.jobId,
        jobStatus: current.jobs.find((job) => job.id === command.jobId)!.status,
        executionAttemptId: command.executionAttemptId, attemptNumber: command.attemptNumber,
        attemptStatus: current.attempts.find((attempt) => attempt.id === command.executionAttemptId)!.status,
        airflowDagId: command.airflowDagId, airflowDagRunId: command.airflowDagRunId, dispatchOutcome,
      });
    }
    async function terminalize(executor: DelayedExecutor, command: DispatchCalculationCommand, status: 'SUCCEEDED' | 'FAILED') {
      assert.equal(executor.fake.setExecutionState(command, status), true);
      const response = await reconcile(command.jobId);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().attemptStatus, status);
      const committed = await state(command.datasetVersionId);
      assert.equal(committed.attempts.find((attempt) => attempt.id === command.executionAttemptId)!.status, status);
      return committed;
    }
    async function noLocksDuringDispatch(command: DispatchCalculationCommand) {
      const observer = await pool.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM dataset_versions WHERE id = $1 FOR UPDATE NOWAIT', [command.datasetVersionId]);
        await observer.query('SELECT id FROM calculation_jobs WHERE id = $1 FOR UPDATE NOWAIT', [command.jobId]);
        await observer.query('SELECT id FROM execution_attempts WHERE id = $1 FOR UPDATE NOWAIT', [command.executionAttemptId]);
        assert.equal((await observer.query(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`)).rows[0]!.count, 0);
      } finally { await observer.query('ROLLBACK'); observer.release(); }
    }
    async function gate(table: 'calculation_jobs' | 'execution_attempts', id: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        return { client, pid: (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number };
      } catch (error) {
        try { await client.query('ROLLBACK'); } finally { client.release(); }
        throw error;
      }
    }
    async function blockedBy(pid: number): Promise<number> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const waiting = await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND $1 = ANY(pg_blocking_pids(pid)) AND strpos(query, 'FOR UPDATE') > 0`, [pid]);
        if (waiting.rows.length) return waiting.rows[0]!.pid;
        await setImmediate();
      }
      assert.fail(`No orchestration query blocked by backend ${pid}`);
    }
    async function releaseGate(held: { client: PoolClient }) {
      try { await held.client.query('ROLLBACK'); } finally { held.client.release(); }
    }

    // Exact CON-01 barrier: creation + committed DISPATCHING, executor response held,
    // B reconciles and commit is queried, then A is released. No production helpers invoked directly.
    for (const outcome of ['ACCEPTED', 'ALREADY_EXISTS', 'UNKNOWN'] as const) {
      for (const terminal of ['SUCCEEDED', 'FAILED'] as const) {
        await t.test(`CON-01-RECONCILE_FIRST: late ${outcome} after ${terminal}`, async () => {
          const executor = new DelayedExecutor(outcome);
          const { dataset, jobId } = await fixture(executor);
          const requestA = run(jobId);
          try {
            const { command } = await bounded(executor.entered, 'first dispatch');
            const dispatching = await state(dataset.datasetVersionId);
            assert.equal(dispatching.dataset.status, 'BUILDING');
            assert.equal(dispatching.attempts.length, 1);
            assert.equal(dispatching.attempts[0]!.status, 'DISPATCHING');
            assert.equal(dispatching.jobs.find((job) => job.id === jobId)!.status, 'PENDING');
            assert.equal(executor.fake.getExternalExecutions().length, 1);
            await noLocksDuringDispatch(command);
            const committed = await terminalize(executor, command, terminal);
            const dispatchCount = executor.fake.getDispatchHistory().length;
            executor.release();
            const responseA = await requestA;
            assert.deepEqual(await state(dataset.datasetVersionId), committed, 'No late-response state, timestamp or diagnostic rewrite');
            assertFrozen(dispatching, committed);
            assert.equal(executor.fake.getDispatchHistory().length, dispatchCount);
            assert.equal(executor.fake.getExternalExecutions().length, 1);
            assertResponse(responseA, command, committed, outcome);
          } finally { executor.release(); await Promise.allSettled([requestA]); }
        });
      }
    }

    await t.test('CON-01-DISPATCH_FIRST: normal acceptance followed by success remains unchanged', async () => {
      const executor = new DelayedExecutor();
      const { dataset, jobId } = await fixture(executor);
      const requestA = run(jobId);
      try {
        const { command } = await bounded(executor.entered, 'normal dispatch');
        executor.release();
        const responseA = await requestA;
        const accepted = await state(dataset.datasetVersionId);
        assertResponse(responseA, command, accepted, 'ACCEPTED');
        assert.equal(accepted.attempts[0]!.status, 'ACCEPTED');
        assert.equal(responseA.json().jobStatus, 'RUNNING');
        const committed = await terminalize(executor, command, 'SUCCEEDED');
        assert.equal(committed.dataset.status, 'BUILDING');
        assert.equal(committed.attempts.length, 1);
      } finally { executor.release(); await Promise.allSettled([requestA]); }
    });

    async function finishOther(executor: DelayedExecutor, otherJobId: string) {
      const other = await run(otherJobId);
      assert.equal(other.statusCode, 200, other.body);
      executor.fake.setExecutionState(other.json(), 'SUCCEEDED');
      assert.equal((await reconcile(otherJobId)).statusCode, 200);
    }
    for (const lifecycle of ['VALIDATING', 'PUBLISHED', 'REJECTED', 'ABANDONED'] as const) {
      await t.test(`CON-01-LATER_LIFECYCLE: terminal late acceptance reports ${lifecycle}`, async () => {
        const executor = new DelayedExecutor();
        const { dataset, jobId, otherJobId } = await fixture(executor);
        const requestA = run(jobId);
        try {
          const { command } = await bounded(executor.entered, 'lifecycle dispatch');
          const frozen = await state(dataset.datasetVersionId);
          await terminalize(executor, command, 'SUCCEEDED');
          await finishOther(executor, otherJobId);
          if (lifecycle !== 'ABANDONED') assert.equal((await post(`/dataset-versions/${dataset.datasetVersionId}/submit-validation`)).statusCode, 200);
          if (lifecycle !== 'VALIDATING') {
            const action = lifecycle === 'PUBLISHED' ? 'publish' : lifecycle === 'REJECTED' ? 'reject' : 'abandon';
            assert.equal((await post(`/dataset-versions/${dataset.datasetVersionId}/${action}`)).statusCode, 200);
          }
          const committed = await state(dataset.datasetVersionId);
          assert.equal(committed.dataset.status, lifecycle);
          executor.release();
          const responseA = await requestA;
          assert.deepEqual(await state(dataset.datasetVersionId), committed);
          assertFrozen(frozen, committed);
          assertResponse(responseA, command, committed, 'ACCEPTED');
        } finally { executor.release(); await Promise.allSettled([requestA]); }
      });
    }

    await t.test('CON-01-RETRY_STARTED: old FAILED identity returns current RUNNING job without touching accepted retry', async () => {
      const executor = new DelayedExecutor();
      const { dataset, jobId } = await fixture(executor);
      const requestA = run(jobId);
      try {
        const { command } = await bounded(executor.entered, 'retry dispatch');
        const failed = await terminalize(executor, command, 'FAILED');
        const retry = await run(jobId);
        assert.equal(retry.statusCode, 200, retry.body);
        assert.equal(retry.json().attemptNumber, 2);
        assert.notEqual(retry.json().executionAttemptId, command.executionAttemptId);
        const committed = await state(dataset.datasetVersionId);
        assert.equal(committed.attempts.length, 2);
        assert.deepEqual(committed.attempts[0], failed.attempts[0]);
        executor.release();
        const responseA = await requestA;
        assert.deepEqual(await state(dataset.datasetVersionId), committed);
        assertFrozen(failed, committed);
        assert.equal(executor.fake.getExternalExecutions().length, 2, 'Exactly the two intentional attempt identities');
        assertResponse(responseA, command, committed, 'ACCEPTED');
        assert.equal(responseA.json().attemptStatus, 'FAILED');
        assert.equal(responseA.json().jobStatus, 'RUNNING');
      } finally { executor.release(); await Promise.allSettled([requestA]); }
    });

    for (const terminal of ['SUCCEEDED', 'FAILED'] as const) {
      await t.test(`CON-01-CONTRADICTION: late definite REJECTED after ${terminal} remains internal anomaly`, async () => {
        const executor = new DelayedExecutor('REJECTED');
        const { dataset, jobId } = await fixture(executor);
        const requestA = run(jobId);
        try {
          const { command } = await bounded(executor.entered, 'contradictory dispatch');
          const committed = await terminalize(executor, command, terminal);
          executor.release();
          const responseA = await requestA;
          assert.equal(responseA.statusCode, 500);
          assert.equal(responseA.json().code, 'INTERNAL_SERVER_ERROR');
          assert.deepEqual(await state(dataset.datasetVersionId), committed);
          assert.equal(executor.fake.getExternalExecutions().length, 1);
        } finally { executor.release(); await Promise.allSettled([requestA]); }
      });
    }

    for (const table of ['calculation_jobs', 'execution_attempts'] as const) {
      await t.test(`CON-01-FRESH_DATASET: reload after waiting on ${table}, without dataset/series lock inversion`, async () => {
        const executor = new DelayedExecutor();
        const { dataset, jobId, otherJobId } = await fixture(executor);
        const requestA = run(jobId);
        let held: Awaited<ReturnType<typeof gate>> | undefined;
        try {
          const { command } = await bounded(executor.entered, 'fresh-state dispatch');
          await terminalize(executor, command, 'SUCCEEDED');
          await finishOther(executor, otherJobId);
          assert.equal((await post(`/dataset-versions/${dataset.datasetVersionId}/submit-validation`)).statusCode, 200);
          held = await gate(table, table === 'calculation_jobs' ? jobId : command.executionAttemptId);
          executor.release();
          await blockedBy(held.pid);
          // Publish needs only series/version locks and can commit while A waits on execution state.
          assert.equal((await post(`/dataset-versions/${dataset.datasetVersionId}/publish`)).statusCode, 200);
          const committed = await state(dataset.datasetVersionId);
          const releasing = held; held = undefined;
          await releaseGate(releasing);
          const responseA = await requestA;
          assert.deepEqual(await state(dataset.datasetVersionId), committed);
          assertResponse(responseA, command, committed, 'ACCEPTED');
          assert.equal(responseA.json().datasetStatus, 'PUBLISHED');
        } finally {
          if (held) await releaseGate(held);
          executor.release(); await Promise.allSettled([requestA]);
        }
      });
    }

    await t.test('CON-01-LOCKS: dispatch recording and reconciliation retain job-before-attempt locking', async () => {
      const executor = new DelayedExecutor();
      const { jobId } = await fixture(executor);
      const requestA = run(jobId);
      const requests = [requestA];
      try {
        const { command } = await bounded(executor.entered, 'lock-order dispatch');
        await noLocksDuringDispatch(command);
        async function proveOrder(start: () => Promise<HttpResponse>) {
          const held = await gate('execution_attempts', command.executionAttemptId);
          let request: Promise<HttpResponse> | undefined;
          try {
            request = start(); requests.push(request);
            await blockedBy(held.pid);
            const observer = await pool.connect();
            try {
              await observer.query('BEGIN');
              await assert.rejects(observer.query('SELECT id FROM calculation_jobs WHERE id = $1 FOR UPDATE NOWAIT', [jobId]), { code: '55P03' });
            } finally { await observer.query('ROLLBACK'); observer.release(); }
          } finally { await releaseGate(held); }
          return request!;
        }
        assert.equal((await proveOrder(() => { executor.release(); return requestA; })).statusCode, 200);
        executor.fake.setExecutionState(command, 'SUCCEEDED');
        assert.equal((await proveOrder(() => reconcile(jobId))).statusCode, 200);
      } finally { executor.release(); await Promise.allSettled(requests); }
    });

    for (const field of ['calculation_job_id', 'attempt_number', 'airflow_dag_id', 'airflow_dag_run_id'] as const) {
      await t.test(`CON-01-IDENTITY: terminal ${field} mismatch remains internal anomaly`, async () => {
        const executor = new DelayedExecutor();
        const { dataset, jobId, otherJobId } = await fixture(executor);
        const requestA = run(jobId);
        try {
          const { command } = await bounded(executor.entered, 'identity dispatch');
          await terminalize(executor, command, 'SUCCEEDED');
          // Deliberate persisted corruption must not be disguised as terminal recovery.
          const value = field === 'calculation_job_id' ? otherJobId : field === 'attempt_number' ? 99 : `wrong-${randomUUID()}`;
          await pool.query(`UPDATE execution_attempts SET ${field} = $2 WHERE id = $1`, [command.executionAttemptId, value]);
          const corrupted = await state(dataset.datasetVersionId);
          executor.release();
          const responseA = await requestA;
          assert.equal(responseA.statusCode, 500);
          assert.equal(responseA.json().code, 'INTERNAL_SERVER_ERROR');
          assert.deepEqual(await state(dataset.datasetVersionId), corrupted);
        } finally { executor.release(); await Promise.allSettled([requestA]); }
      });
    }

    for (const corruption of ['snapshot', 'dataset', 'PREPARED', 'DISPATCH_FAILED', 'DRAFT', 'ACTIVE_OUTSIDE_BUILDING'] as const) {
      await t.test(`CON-01-BOUNDARY: ${corruption} is not suppressed as terminal recovery`, async () => {
        const executor = new DelayedExecutor();
        const { dataset, jobId } = await fixture(executor);
        const requestA = run(jobId);
        try {
          const { command } = await bounded(executor.entered, 'boundary dispatch');
          if (corruption !== 'ACTIVE_OUTSIDE_BUILDING') await terminalize(executor, command, 'SUCCEEDED');
          if (corruption === 'snapshot') {
            // Test-owned corruption replaces the supposedly immutable snapshot identity.
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query('DELETE FROM dataset_build_snapshot_dependencies WHERE snapshot_id = $1', [command.datasetBuildSnapshotId]);
              await client.query('DELETE FROM dataset_build_snapshots WHERE id = $1', [command.datasetBuildSnapshotId]);
              await client.query('INSERT INTO dataset_build_snapshots (dataset_version_id) VALUES ($1)', [dataset.datasetVersionId]);
              await client.query('COMMIT');
            } catch (error) { await client.query('ROLLBACK'); throw error; }
            finally { client.release(); }
          } else if (corruption === 'dataset') {
            const upstreamId = (await pool.query("SELECT id FROM dataset_versions WHERE status = 'PUBLISHED'")).rows[0]!.id;
            await pool.query('UPDATE calculation_jobs SET output_dataset_version_id = $2 WHERE id = $1', [jobId, upstreamId]);
          } else if (corruption === 'PREPARED' || corruption === 'DISPATCH_FAILED') {
            await pool.query('UPDATE execution_attempts SET status = $2 WHERE id = $1', [command.executionAttemptId, corruption]);
            if (corruption === 'DISPATCH_FAILED') await pool.query("UPDATE calculation_jobs SET status = 'PENDING' WHERE id = $1", [jobId]);
          } else {
            await pool.query('UPDATE dataset_versions SET status = $2 WHERE id = $1',
              [dataset.datasetVersionId, corruption === 'DRAFT' ? 'DRAFT' : 'VALIDATING']);
          }
          const before = await state(dataset.datasetVersionId);
          const jobBefore = (await pool.query('SELECT * FROM calculation_jobs WHERE id = $1', [jobId])).rows;
          const attemptBefore = (await pool.query('SELECT * FROM execution_attempts WHERE id = $1', [command.executionAttemptId])).rows;
          executor.release();
          const responseA = await requestA;
          assert.equal(responseA.statusCode, 500, responseA.body);
          assert.equal(responseA.json().code, 'INTERNAL_SERVER_ERROR');
          assert.deepEqual(await state(dataset.datasetVersionId), before);
          assert.deepEqual((await pool.query('SELECT * FROM calculation_jobs WHERE id = $1', [jobId])).rows, jobBefore);
          assert.deepEqual((await pool.query('SELECT * FROM execution_attempts WHERE id = $1', [command.executionAttemptId])).rows, attemptBefore);
        } finally { executor.release(); await Promise.allSettled([requestA]); }
      });
    }
  } finally {
    try { if (app) await app.close(); }
    finally {
      try { if (applicationPool) await applicationPool.end(); }
      finally {
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
        finally { await admin.end(); }
      }
    }
  }
});
