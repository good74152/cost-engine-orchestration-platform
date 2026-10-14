import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runner } from 'node-pg-migrate';
import { Client, type Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { DispatchCalculationCommand } from '../src/executors/calculation-executor.js';
import type { CalculationJobRunResult } from '../src/modules/calculation-job.types.js';
import type {
  CreateDatasetVersionResult, DatasetDomain,
} from '../src/modules/dataset-version/dataset-version.types.js';

const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('Task 007D requires TEST_DATABASE_URL or DATABASE_URL to reach PostgreSQL');

type Row = Record<string, unknown>;
type State = { series: Row; dataset: Row; jobs: Row[]; attempts: Row[];
  snapshots: Row[]; dependencies: Row[] };
type HttpResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function forDatabase(name: string): string {
  const parsed = new URL(sourceUrl!);
  parsed.pathname = '/' + name;
  return parsed.toString();
}

function assertHttp(response: HttpResponse, status: number): void {
  assert.equal(response.statusCode, status, response.body);
}
function assertError(response: HttpResponse, status: number, code: string): void {
  assertHttp(response, status);
  assert.equal(response.json().code, code);
  assert.equal(typeof response.json().message, 'string');
}
function defer(): { entered: Promise<void>; arrive: () => void } {
  let arrive!: () => void;
  const entered = new Promise<void>((resolve) => { arrive = resolve; });
  return { entered, arrive };
}
async function bounded<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Test-only external response barrier: persisted DISPATCHING and FakeExecutor
// external creation happen before Run receives its ACCEPTED result.
class HeldDispatchFakeExecutor extends FakeExecutor {
  private readonly arrived = defer();
  private readonly released = defer();
  readonly entered = this.arrived.entered;
  private held = false;

  override async dispatch(command: DispatchCalculationCommand) {
    const result = await super.dispatch(command);
    if (!this.held) {
      this.held = true;
      this.arrived.arrive();
      await this.released.entered;
    }
    return result;
  }
  release() { this.released.arrive(); }
}

test('Task 007D integrated PostgreSQL E2E: public orchestration flows A–F', { concurrency: false }, async (t) => {
  const dbName = `task_007d_e2e_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(dbName, /^task_007d_e2e_[a-z0-9_]+$/);
  assert.ok(dbName.length <= 63);
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldNodeEnv = process.env.NODE_ENV;
  const admin = new Client({ connectionString: forDatabase('postgres') });
  let created = false;
  let applicationPool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let fake: FakeExecutor = new FakeExecutor();
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE template0`);
    created = true;
    await runner({
      databaseUrl: forDatabase(dbName),
      dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up',
      singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    process.env.DATABASE_URL = forDatabase(dbName);
    process.env.NODE_ENV = 'test';
    const [{ pool }, { buildApp }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'),
    ]);
    applicationPool = pool;
    const version = await pool.query<{ version: string }>('SHOW server_version');
    console.log(`E2E_RUNTIME ${JSON.stringify({ node: process.version,
      postgres: version.rows[0]!.version,
      database: 'owned task_007d_e2e_* database with all checked-in migrations' })}`);
    const definitionByType = new Map<string, string>();

    async function installExecutor(executor: FakeExecutor): Promise<void> {
      if (app) await app.close();
      fake = executor;
      app = await buildApp({ logger: false, calculationExecutor: fake, nodeEnvironment: 'test' });
    }

    async function seedType(domain: DatasetDomain, code: string, requires: DatasetDomain[] = []) {
      const typeId = randomUUID();
      const definitionId = randomUUID();
      await pool.query(`INSERT INTO calculation_types
        (id, domain, code, airflow_dag_id, is_active, last_allocated_dependency_definition_version)
        VALUES ($1, $2, $3, $4, TRUE, 1)`,
        [typeId, domain, code, `dag_${domain}_${code}`]);
      await pool.query(`INSERT INTO execution_dependency_definition_versions
        (id, calculation_type_id, version, status, published_at)
        VALUES ($1, $2, 1, 'PUBLISHED', NOW())`, [definitionId, typeId]);
      for (const requiredDomain of requires) {
        await pool.query(`INSERT INTO execution_dependency_definition_dependencies
          (definition_version_id, required_domain) VALUES ($1, $2)`,
          [definitionId, requiredDomain]);
      }
      definitionByType.set(code, definitionId);
    }
    await seedType('CAPEX', 'SOURCE');
    await seedType('DPR', 'TABLE_A', ['CAPEX']);
    await seedType('DPR', 'TABLE_B', ['CAPEX']);
    await installExecutor(fake);

    async function post(path: string, payload?: object): Promise<HttpResponse> {
      return app!.inject({ method: 'POST', url: path, ...(payload ? { payload } : {}) });
    }
    async function create(domain: DatasetDomain, companyCode: string): Promise<CreateDatasetVersionResult> {
      const response = await post('/dataset-versions', {
        domain, companyCode, fiscalYear: 2026, period: 'Q3',
      });
      assertHttp(response, 201);
      const result: CreateDatasetVersionResult = response.json();
      assert.equal(result.datasetStatus, 'DRAFT');
      assert.ok(result.calculationJobs.length > 0);
      assert.equal(new Set(result.calculationJobs.map((job) => job.jobId)).size,
        result.calculationJobs.length);
      const series = (await pool.query<Row>('SELECT * FROM dataset_series WHERE id = $1',
        [result.datasetSeriesId])).rows[0]!;
      assert.deepEqual([series.domain, series.company_code, series.fiscal_year, series.period],
        [domain, companyCode, 2026, 'Q3']);
      return result;
    }
    async function run(jobId: string, status = 200): Promise<CalculationJobRunResult> {
      const response = await post(`/calculation-jobs/${jobId}/run`);
      assertHttp(response, status);
      return response.json();
    }
    async function reconcile(jobId: string, expected: 'SUCCEEDED' | 'FAILED') {
      const response = await post(`/calculation-jobs/${jobId}/reconcile`);
      assertHttp(response, 200);
      assert.equal(response.json().attemptStatus, expected);
      assert.equal(response.json().jobStatus, expected);
      return response.json();
    }
    async function lifecycle(datasetId: string, action: string, status: string): Promise<void> {
      const response = await post(`/dataset-versions/${datasetId}/${action}`);
      assertHttp(response, 200);
      assert.equal(response.json().datasetStatus, status);
    }
    async function state(datasetId: string): Promise<State> {
      const [dataset, series, jobs, attempts, snapshots, dependencies] = await Promise.all([
        pool.query<Row>('SELECT * FROM dataset_versions WHERE id = $1', [datasetId]),
        pool.query<Row>(`SELECT ds.* FROM dataset_series ds
          JOIN dataset_versions dv ON dv.dataset_series_id = ds.id WHERE dv.id = $1`, [datasetId]),
        pool.query<Row>('SELECT * FROM calculation_jobs WHERE output_dataset_version_id = $1 ORDER BY id', [datasetId]),
        pool.query<Row>(`SELECT ea.* FROM execution_attempts ea
          JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
          WHERE cj.output_dataset_version_id = $1 ORDER BY ea.calculation_job_id, ea.attempt_number`, [datasetId]),
        pool.query<Row>('SELECT * FROM dataset_build_snapshots WHERE dataset_version_id = $1', [datasetId]),
        pool.query<Row>(`SELECT dep.* FROM dataset_build_snapshot_dependencies dep
          JOIN dataset_build_snapshots s ON s.id = dep.snapshot_id
          WHERE s.dataset_version_id = $1 ORDER BY dep.upstream_dataset_series_id`, [datasetId]),
      ]);
      assert.equal(dataset.rows.length, 1);
      assert.equal(series.rows.length, 1);
      return { dataset: dataset.rows[0]!, series: series.rows[0]!, jobs: jobs.rows,
        attempts: attempts.rows, snapshots: snapshots.rows, dependencies: dependencies.rows };
    }
    function stableBuild(before: State, after: State): void {
      assert.equal(after.snapshots.length, 1);
      assert.deepEqual(after.snapshots, before.snapshots);
      assert.deepEqual(after.dependencies, before.dependencies);
      assert.deepEqual(after.jobs.map((job) => job.resolved_dependency_definition_version_id),
        before.jobs.map((job) => job.resolved_dependency_definition_version_id));
    }
    async function successfulExecution(jobId: string): Promise<CalculationJobRunResult> {
      const dispatched = await run(jobId);
      assert.equal(dispatched.attemptStatus, 'ACCEPTED');
      assert.equal(fake.setExecutionState(dispatched, 'SUCCEEDED'), true);
      await reconcile(jobId, 'SUCCEEDED');
      return dispatched;
    }
    async function finishAndPublish(dataset: CreateDatasetVersionResult) {
      for (const job of dataset.calculationJobs) await successfulExecution(job.jobId);
      const building = await state(dataset.datasetVersionId);
      assert.equal(building.dataset.status, 'BUILDING');
      assert.equal(building.snapshots.length, 1);
      await lifecycle(dataset.datasetVersionId, 'submit-validation', 'VALIDATING');
      await lifecycle(dataset.datasetVersionId, 'publish', 'PUBLISHED');
      const done = await state(dataset.datasetVersionId);
      assert.equal(done.dataset.status, 'PUBLISHED');
      assert.ok(done.dataset.published_at);
      return done;
    }
    async function upstreamFor(companyCode: string) {
      const upstream = await create('CAPEX', companyCode);
      assert.equal(upstream.version, 1);
      await finishAndPublish(upstream);
      return upstream;
    }
    async function latestPublished(seriesId: string) {
      return (await pool.query<{ id: string; version: number }>(`
        SELECT id, version FROM dataset_versions
        WHERE dataset_series_id = $1 AND status = 'PUBLISHED'
        ORDER BY version DESC LIMIT 1`, [seriesId])).rows[0] ?? null;
    }
    function assertTerminal(s: State, jobId: string, outcome: 'SUCCEEDED' | 'FAILED') {
      assert.equal(s.jobs.find((job) => job.id === jobId)!.status, outcome);
      const attempt = s.attempts.find((row) => row.calculation_job_id === jobId)!;
      assert.equal(attempt.status, outcome);
      assert.ok(attempt.accepted_at, 'Accepted timestamp is persisted');
      assert.ok(attempt.finished_at, 'Terminal timestamp is persisted');
      return attempt;
    }

    await t.test('A: publish CAPEX v1, freeze its published identity into multi-job DPR v1, publish DPR', async () => {
      await installExecutor(new FakeExecutor());
      const capex = await upstreamFor('F007A');
      const dpr = await create('DPR', 'F007A');
      assert.equal(dpr.version, 1);
      assert.equal(dpr.calculationJobs.length, 2);
      const firstJob = dpr.calculationJobs.find((job) => job.calculationTypeCode === 'TABLE_A')!;
      const first = await run(firstJob.jobId);
      assert.equal(first.attemptStatus, 'ACCEPTED');
      const afterFirst = await state(dpr.datasetVersionId);
      assert.equal(afterFirst.dataset.status, 'BUILDING');
      assert.equal(afterFirst.snapshots.length, 1);
      assert.equal(afterFirst.dependencies.length, 1);
      assert.equal(afterFirst.dependencies[0]!.upstream_dataset_series_id, capex.datasetSeriesId);
      assert.equal(afterFirst.dependencies[0]!.upstream_dataset_version_id, capex.datasetVersionId);
      assert.equal(afterFirst.jobs.length, 2);
      for (const job of dpr.calculationJobs) {
        const persisted = afterFirst.jobs.find((row) => row.id === job.jobId)!;
        assert.equal(persisted.resolved_dependency_definition_version_id,
          definitionByType.get(job.calculationTypeCode));
      }
      const secondJob = dpr.calculationJobs.find((job) => job.calculationTypeCode === 'TABLE_B')!;
      const second = await run(secondJob.jobId);
      assert.equal(second.datasetBuildSnapshotId, first.datasetBuildSnapshotId);
      const afterSecond = await state(dpr.datasetVersionId);
      stableBuild(afterFirst, afterSecond);
      assert.equal(afterSecond.attempts.length, 2);
      assert.equal(new Set(afterSecond.attempts.map((a) => a.id)).size, 2);
      assert.equal(new Set(afterSecond.attempts.map((a) => a.airflow_dag_run_id)).size, 2);
      assert.equal(afterSecond.dataset.status, 'BUILDING');
      for (const item of [first, second]) {
        assert.equal(fake.setExecutionState(item, 'SUCCEEDED'), true);
        await reconcile(item.jobId, 'SUCCEEDED');
      }
      const finished = await state(dpr.datasetVersionId);
      stableBuild(afterFirst, finished);
      assert.equal(finished.dataset.status, 'BUILDING', 'No automatic validation after all jobs succeed');
      for (const job of dpr.calculationJobs) assertTerminal(finished, job.jobId, 'SUCCEEDED');
      await lifecycle(dpr.datasetVersionId, 'submit-validation', 'VALIDATING');
      await lifecycle(dpr.datasetVersionId, 'publish', 'PUBLISHED');
      const published = await state(dpr.datasetVersionId);
      stableBuild(afterFirst, published);
      assert.ok(published.dataset.published_at);
      assert.equal((await latestPublished(capex.datasetSeriesId))!.id, capex.datasetVersionId);
      assert.equal((await latestPublished(dpr.datasetSeriesId))!.id, dpr.datasetVersionId);
      console.log('E2E_FLOW', JSON.stringify({ flow: 'A', capexVersion: capex.version,
        dprJobs: published.jobs.length, snapshots: published.snapshots.length,
        pinnedUpstreamVersions: published.dependencies.length, result: 'PUBLISHED' }));
    });

    await t.test('B: retry FAILED DPR attempt under the same frozen build snapshot', async () => {
      await installExecutor(new FakeExecutor());
      await upstreamFor('F007B');
      const dpr = await create('DPR', 'F007B');
      const target = dpr.calculationJobs[0]!;
      const first = await run(target.jobId);
      assert.equal(fake.setExecutionState(first, 'FAILED'), true);
      await reconcile(target.jobId, 'FAILED');
      const failedState = await state(dpr.datasetVersionId);
      const attempt1 = assertTerminal(failedState, target.jobId, 'FAILED');
      const retry = await run(target.jobId);
      assert.equal(retry.attemptNumber, 2);
      assert.equal(retry.attemptStatus, 'ACCEPTED');
      assert.notEqual(retry.executionAttemptId, first.executionAttemptId);
      assert.notEqual(retry.airflowDagRunId, first.airflowDagRunId);
      assert.equal(retry.datasetBuildSnapshotId, first.datasetBuildSnapshotId);
      const duringRetry = await state(dpr.datasetVersionId);
      stableBuild(failedState, duringRetry);
      assert.deepEqual(duringRetry.attempts.find((row) => row.id === first.executionAttemptId), attempt1);
      assert.equal(fake.setExecutionState(retry, 'SUCCEEDED'), true);
      await reconcile(target.jobId, 'SUCCEEDED');
      for (const job of dpr.calculationJobs.filter((job) => job.jobId !== target.jobId)) {
        await successfulExecution(job.jobId);
      }
      const beforePublish = await state(dpr.datasetVersionId);
      stableBuild(failedState, beforePublish);
      assert.equal(beforePublish.attempts.length, 3);
      assert.deepEqual(beforePublish.attempts.find((row) => row.id === first.executionAttemptId), attempt1);
      assert.equal(beforePublish.attempts.find((row) => row.id === first.executionAttemptId)!.status, 'FAILED');
      assert.equal(beforePublish.attempts.find((row) => row.id === retry.executionAttemptId)!.status, 'SUCCEEDED');
      assert.equal(beforePublish.jobs.find((job) => job.id === target.jobId)!.status, 'SUCCEEDED');
      await lifecycle(dpr.datasetVersionId, 'submit-validation', 'VALIDATING');
      await lifecycle(dpr.datasetVersionId, 'publish', 'PUBLISHED');
      const done = await state(dpr.datasetVersionId);
      stableBuild(failedState, done);
      assert.deepEqual(done.attempts.find((row) => row.id === first.executionAttemptId), attempt1);
      assert.equal(done.attempts.find((row) => row.id === retry.executionAttemptId)!.status, 'SUCCEEDED');
      assert.equal(done.dataset.status, 'PUBLISHED');
      console.log('E2E_FLOW', JSON.stringify({ flow: 'B', attempts: done.attempts.length,
        original: 'FAILED', retry: 'SUCCEEDED', snapshotReused: true }));
    });

    await t.test('C: ACCEPT_THEN_UNKNOWN recovers by reconcile without allocating a new execution', async () => {
      await installExecutor(new FakeExecutor());
      await upstreamFor('F007C');
      const dpr = await create('DPR', 'F007C');
      fake.enqueueBehaviors('ACCEPT_THEN_UNKNOWN');
      const target = dpr.calculationJobs[0]!;
      const response = await post(`/calculation-jobs/${target.jobId}/run`);
      assertHttp(response, 202);
      const unknown: CalculationJobRunResult = response.json();
      assert.equal(unknown.attemptStatus, 'DISPATCHING');
      assert.equal(unknown.dispatchOutcome, 'UNKNOWN');
      const dispatchedState = await state(dpr.datasetVersionId);
      assert.equal(dispatchedState.dataset.status, 'BUILDING');
      assert.equal(dispatchedState.attempts.length, 1);
      assert.equal(dispatchedState.attempts[0]!.id, unknown.executionAttemptId);
      assert.equal(dispatchedState.attempts[0]!.status, 'DISPATCHING');
      const externalBefore = fake.getExternalExecutions()
        .filter((execution) => execution.airflowDagRunId === unknown.airflowDagRunId);
      assert.equal(externalBefore.length, 1);
      assert.equal(fake.setExecutionState(unknown, 'SUCCEEDED'), true);
      await reconcile(target.jobId, 'SUCCEEDED');
      const recovered = await state(dpr.datasetVersionId);
      stableBuild(dispatchedState, recovered);
      assert.equal(recovered.attempts.length, 1);
      assert.equal(recovered.attempts[0]!.id, unknown.executionAttemptId);
      for (const job of dpr.calculationJobs.filter((job) => job.jobId !== target.jobId)) {
        await successfulExecution(job.jobId);
      }
      await lifecycle(dpr.datasetVersionId, 'submit-validation', 'VALIDATING');
      await lifecycle(dpr.datasetVersionId, 'publish', 'PUBLISHED');
      const done = await state(dpr.datasetVersionId);
      stableBuild(dispatchedState, done);
      assert.equal(done.attempts.length, 2, 'Two jobs, not a hidden retry');
      assert.equal(done.attempts.filter((row) => row.calculation_job_id === target.jobId).length, 1);
      assert.equal(fake.getExternalExecutions().filter((execution) =>
        execution.airflowDagRunId === unknown.airflowDagRunId).length, 1);
      console.log('E2E_FLOW', JSON.stringify({ flow: 'C', http: 202,
        recoveredAttempt: unknown.executionAttemptId, duplicateExternalWork: false }));
    });

    await t.test('D: rejected dataset version remains historical; next version advances monotonically', async () => {
      await installExecutor(new FakeExecutor());
      const v1 = await upstreamFor('F007D');
      const v2 = await create('CAPEX', 'F007D');
      assert.equal(v2.version, 2);
      for (const job of v2.calculationJobs) await successfulExecution(job.jobId);
      await lifecycle(v2.datasetVersionId, 'submit-validation', 'VALIDATING');
      const beforeReject = await state(v2.datasetVersionId);
      await lifecycle(v2.datasetVersionId, 'reject', 'REJECTED');
      const rejected = await state(v2.datasetVersionId);
      stableBuild(beforeReject, rejected);
      assert.ok(rejected.dataset.rejected_at);
      assert.equal((await latestPublished(v1.datasetSeriesId))!.id, v1.datasetVersionId);
      const v3 = await create('CAPEX', 'F007D');
      assert.equal(v3.version, 3);
      assert.equal(v3.datasetSeriesId, v1.datasetSeriesId);
      assert.equal((await state(v3.datasetVersionId)).dataset.status, 'DRAFT');
      assert.deepEqual(await state(v2.datasetVersionId), rejected);
      assert.equal((await latestPublished(v3.datasetSeriesId))!.id, v1.datasetVersionId);
      console.log('E2E_FLOW', JSON.stringify({ flow: 'D', versions: [1, 2, 3],
        rejectedVersion: 2, latestPublished: 1 }));
    });

    await t.test('E: DRAFT/BUILDING abandonment, ACCEPTED and DISPATCHING active-attempt guards', async () => {
      await installExecutor(new FakeExecutor());
      const draft = await create('CAPEX', 'F007E1');
      const draftBefore = await state(draft.datasetVersionId);
      assert.equal(draftBefore.attempts.length, 0);
      await lifecycle(draft.datasetVersionId, 'abandon', 'ABANDONED');
      const draftAfter = await state(draft.datasetVersionId);
      assert.equal(draftAfter.attempts.length, 0);
      assert.deepEqual(draftAfter.jobs, draftBefore.jobs);
      assert.equal(draftAfter.snapshots.length, 0);

      const safe = await create('CAPEX', 'F007E2');
      const failed = await run(safe.calculationJobs[0]!.jobId);
      assert.equal(fake.setExecutionState(failed, 'FAILED'), true);
      await reconcile(failed.jobId, 'FAILED');
      const beforeSafeAbandon = await state(safe.datasetVersionId);
      await lifecycle(safe.datasetVersionId, 'abandon', 'ABANDONED');
      const afterSafeAbandon = await state(safe.datasetVersionId);
      assert.deepEqual(afterSafeAbandon.attempts, beforeSafeAbandon.attempts);
      stableBuild(beforeSafeAbandon, afterSafeAbandon);

      const active = await create('CAPEX', 'F007E3');
      const accepted = await run(active.calculationJobs[0]!.jobId);
      assert.equal(accepted.attemptStatus, 'ACCEPTED');
      const beforeAcceptedAbandon = await state(active.datasetVersionId);
      assertError(await post(`/dataset-versions/${active.datasetVersionId}/abandon`),
        409, 'DATASET_HAS_ACTIVE_EXECUTION');
      assert.deepEqual(await state(active.datasetVersionId), beforeAcceptedAbandon);

      const blocker = new HeldDispatchFakeExecutor();
      await installExecutor(blocker);
      const dispatchingDataset = await create('CAPEX', 'F007E4');
      const jobId = dispatchingDataset.calculationJobs[0]!.jobId;
      const pendingRun = post(`/calculation-jobs/${jobId}/run`);
      try {
        await bounded(blocker.entered, 'external dispatch barrier');
        const before = await state(dispatchingDataset.datasetVersionId);
        assert.equal(before.attempts.length, 1);
        assert.equal(before.attempts[0]!.status, 'DISPATCHING');
        assert.equal(before.jobs[0]!.status, 'PENDING');
        assert.equal(blocker.getExternalExecutions().length, 1);
        assertError(await post(`/dataset-versions/${dispatchingDataset.datasetVersionId}/abandon`),
          409, 'DATASET_HAS_ACTIVE_EXECUTION');
        assert.deepEqual(await state(dispatchingDataset.datasetVersionId), before);
      } finally {
        blocker.release();
        const resumed = await bounded(pendingRun, 'release blocked dispatch');
        assertHttp(resumed, 200);
      }
      const afterRelease = await state(dispatchingDataset.datasetVersionId);
      assert.equal(afterRelease.attempts[0]!.status, 'ACCEPTED');
      console.log('E2E_FLOW', JSON.stringify({ flow: 'E', abandoned: ['DRAFT', 'BUILDING'],
        guarded: ['DISPATCHING', 'ACCEPTED'],
        prepared: 'covered by existing Task 006 PostgreSQL guard, not publicly observable here' }));
    });

    await t.test('F: duplicate late callback in VALIDATING/PUBLISHED preserves durable history', async () => {
      await installExecutor(new FakeExecutor());
      const dataset = await create('CAPEX', 'F007F');
      const jobId = dataset.calculationJobs[0]!.jobId;
      const dispatched = await successfulExecution(jobId);
      await lifecycle(dataset.datasetVersionId, 'submit-validation', 'VALIDATING');
      const validating = await state(dataset.datasetVersionId);
      const externalCount = fake.getExternalExecutions().length;
      const dispatchCount = fake.getDispatchHistory().length;
      async function verifyCallback(expectedDataset: 'VALIDATING' | 'PUBLISHED') {
        const lookupsBefore = fake.getStatusLookupHistory().length;
        const response = await post('/executor-callbacks/airflow', {
          airflowDagId: dispatched.airflowDagId,
          airflowDagRunId: dispatched.airflowDagRunId,
        });
        assertHttp(response, 200);
        assert.equal(response.json().attemptStatus, 'SUCCEEDED');
        assert.equal(response.json().jobStatus, 'SUCCEEDED');
        assert.equal(response.json().datasetStatus, expectedDataset);
        assert.equal(fake.getStatusLookupHistory().length, lookupsBefore + 1,
          'Callback must consult authoritative executor state');
      }
      await verifyCallback('VALIDATING');
      assert.deepEqual(await state(dataset.datasetVersionId), validating);
      await lifecycle(dataset.datasetVersionId, 'publish', 'PUBLISHED');
      const published = await state(dataset.datasetVersionId);
      await verifyCallback('PUBLISHED');
      await verifyCallback('PUBLISHED');
      assert.deepEqual(await state(dataset.datasetVersionId), published,
        'Duplicate late callbacks cannot rewrite terminal history/timestamps');
      assert.equal(fake.getExternalExecutions().length, externalCount);
      assert.equal(fake.getDispatchHistory().length, dispatchCount);
      console.log('E2E_FLOW', JSON.stringify({ flow: 'F', validationCallback: 1,
        publishedCallbacks: 2, immutable: true }));
    });
  } finally {
    try { if (app) await app.close(); }
    finally {
      try { if (applicationPool) await applicationPool.end(); }
      finally {
        if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = oldDatabaseUrl;
        if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = oldNodeEnv;
        try {
          if (created) {
            assert.match(dbName, /^task_007d_e2e_[a-z0-9_]+$/);
            await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
            console.log('E2E_DB_TEARDOWN', JSON.stringify({ database: dbName, result: 'dropped' }));
          }
        } finally { await admin.end(); }
      }
    }
  }
});
