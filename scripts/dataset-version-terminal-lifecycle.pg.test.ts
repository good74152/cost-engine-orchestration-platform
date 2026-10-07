import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runner } from 'node-pg-migrate';
import { Client, type Pool, type PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import type { ExecutionIdentity, ExecutorExecutionStatus } from '../src/executors/calculation-executor.js';
import type { CreateDatasetVersionResult, DatasetDomain } from '../src/modules/dataset-version/dataset-version.types.js';

const sourceDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceDatabaseUrl) throw new Error('PostgreSQL integration tests require a database URL');
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
type Command = 'submit-validation' | 'publish' | 'reject' | 'abandon';
type Row = Record<string, unknown>;

function databaseUrl(name: string): string {
  const url = new URL(sourceDatabaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

class BlockingLookupExecutor extends FakeExecutor {
  private firstLookup = true;
  private enter!: () => void;
  private release!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.enter = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });

  override async getExecutionStatus(identity: ExecutionIdentity): Promise<ExecutorExecutionStatus> {
    const observation = await super.getExecutionStatus(identity);
    if (!this.firstLookup) return observation;
    this.firstLookup = false;
    this.enter();
    await this.released;
    return observation;
  }

  unblock(): void { this.release(); }
}

class BlockingDispatchExecutor extends FakeExecutor {
  private enter!: () => void;
  private release!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.enter = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });

  override async dispatch(command: Parameters<FakeExecutor['dispatch']>[0]) {
    this.enter();
    await this.released;
    return super.dispatch(command);
  }

  unblock(): void { this.release(); }
}

test('dataset validation and terminal lifecycle PostgreSQL integration and concurrency', { concurrency: false }, async (t) => {
  const name = `dataset_lifecycle_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^dataset_lifecycle_test_[a-z0-9_]+$/);
  assert.ok(name.length <= 63);
  const admin = new Client({ connectionString: databaseUrl('postgres') });
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let applicationPool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let fake: FakeExecutor = new FakeExecutor();
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  try {
    await runner({
      databaseUrl: databaseUrl(name), dir: migrationsDirectory,
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true,
      checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    process.env.DATABASE_URL = databaseUrl(name);
    const [{ pool }, { buildApp }, { prepareCalculationJobRunService: prepare }] = await Promise.all([
      import('../src/db/pool.js'),
      import('../src/app.js'),
      import('../src/modules/calculation-job-preparation.service.js'),
    ]);
    applicationPool = pool;

    async function reset(executor: FakeExecutor = new FakeExecutor()): Promise<void> {
      if (app) await app.close();
      await pool.query('TRUNCATE TABLE dataset_series, calculation_types CASCADE');
      fake = executor;
      app = await buildApp({ logger: false, calculationExecutor: fake, nodeEnvironment: 'test' });
    }

    async function configure(domain: DatasetDomain = 'DPR', count = 2, dependencies: string[] = []): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        const typeId = randomUUID();
        const definitionId = randomUUID();
        await pool.query(
          `INSERT INTO calculation_types (id, domain, code, airflow_dag_id,
             is_active, last_allocated_dependency_definition_version)
           VALUES ($1, $2, $3, $4, TRUE, 1)`,
          [typeId, domain, `TYPE_${index}`, `dag_${domain}_${index}`],
        );
        await pool.query(
          `INSERT INTO execution_dependency_definition_versions
             (id, calculation_type_id, version, status, published_at)
           VALUES ($1, $2, 1, 'PUBLISHED', NOW())`,
          [definitionId, typeId],
        );
        for (const dependency of dependencies) {
          await pool.query(
            `INSERT INTO execution_dependency_definition_dependencies
               (definition_version_id, required_domain) VALUES ($1, $2)`,
            [definitionId, dependency],
          );
        }
      }
    }

    async function create(domain: DatasetDomain = 'DPR', companyCode = 'TW01'): Promise<CreateDatasetVersionResult> {
      const response = await app!.inject({
        method: 'POST', url: '/dataset-versions',
        payload: { domain, companyCode, fiscalYear: 2026, period: 'Q3' },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    }

    async function command(datasetVersionId: string, action: Command) {
      return app!.inject({ method: 'POST', url: `/dataset-versions/${datasetVersionId}/${action}` });
    }

    async function run(jobId: string) {
      return app!.inject({ method: 'POST', url: `/calculation-jobs/${jobId}/run` });
    }

    async function reconcile(jobId: string) {
      return app!.inject({ method: 'POST', url: `/calculation-jobs/${jobId}/reconcile` });
    }

    async function callback(identity: ExecutionIdentity) {
      return app!.inject({ method: 'POST', url: '/executor-callbacks/airflow',
        payload: { airflowDagId: identity.airflowDagId, airflowDagRunId: identity.airflowDagRunId } });
    }

    async function complete(dataset: CreateDatasetVersionResult, outcome: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED') {
      for (const job of dataset.calculationJobs) {
        const dispatched = await run(job.jobId);
        assert.equal(dispatched.statusCode, 200, dispatched.body);
        assert.equal(fake.setExecutionState(dispatched.json(), outcome), true);
        const reconciled = await reconcile(job.jobId);
        assert.equal(reconciled.statusCode, 200, reconciled.body);
        assert.equal(reconciled.json().datasetStatus, 'BUILDING');
        assert.equal(reconciled.json().jobStatus, outcome);
      }
    }

    async function validating(domain: DatasetDomain = 'DPR'): Promise<CreateDatasetVersionResult> {
      const dataset = await create(domain);
      await complete(dataset);
      const result = await command(dataset.datasetVersionId, 'submit-validation');
      assert.equal(result.statusCode, 200, result.body);
      return dataset;
    }

    async function readState(datasetId: string) {
      const [dataset, jobs, attempts, snapshots, dependencies] = await Promise.all([
        pool.query<Row>('SELECT * FROM dataset_versions WHERE id = $1', [datasetId]),
        pool.query<Row>('SELECT * FROM calculation_jobs WHERE output_dataset_version_id = $1 ORDER BY id', [datasetId]),
        pool.query<Row>(`SELECT ea.* FROM execution_attempts ea
          JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
          WHERE cj.output_dataset_version_id = $1 ORDER BY ea.calculation_job_id, ea.attempt_number`, [datasetId]),
        pool.query<Row>('SELECT * FROM dataset_build_snapshots WHERE dataset_version_id = $1', [datasetId]),
        pool.query<Row>(`SELECT dep.* FROM dataset_build_snapshot_dependencies dep
          JOIN dataset_build_snapshots s ON s.id = dep.snapshot_id
          WHERE s.dataset_version_id = $1 ORDER BY dep.upstream_dataset_series_id`, [datasetId]),
      ]);
      return { dataset: dataset.rows[0]!, jobs: jobs.rows, attempts: attempts.rows,
        snapshots: snapshots.rows, dependencies: dependencies.rows };
    }

    function assertHistoryUnchanged(before: Awaited<ReturnType<typeof readState>>, after: Awaited<ReturnType<typeof readState>>) {
      assert.deepEqual(after.jobs, before.jobs);
      assert.deepEqual(after.attempts, before.attempts);
      assert.deepEqual(after.snapshots, before.snapshots);
      assert.deepEqual(after.dependencies, before.dependencies);
    }

    function expectError(response: { statusCode: number; json(): { code: string; message: string } }, status: number, code: string) {
      assert.equal(response.statusCode, status);
      assert.equal(response.json().code, code);
      assert.doesNotMatch(response.json().message, /constraint|uq_|ck_|SQLSTATE/i);
    }

    async function rowGate(table: 'dataset_series' | 'dataset_versions' | 'calculation_jobs' | 'execution_attempts', id: string) {
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return { client, pid: rows[0]!.pid, released: false };
    }

    async function releaseGate(gate: { client: PoolClient; released: boolean }): Promise<void> {
      if (gate.released) return;
      gate.released = true;
      await gate.client.query('ROLLBACK');
      gate.client.release();
    }

    // Ordering is proved by PostgreSQL's blocking graph, never by timing sleeps.
    async function blockedBy(blockerPid: number, queryFragment = 'FOR UPDATE'): Promise<number> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const { rows } = await pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND $1 = ANY(pg_blocking_pids(pid)) AND strpos(query, $2) > 0`,
          [blockerPid, queryFragment],
        );
        if (rows.length > 0) return rows[0]!.pid;
        await setImmediate();
      }
      assert.fail(`No query containing ${queryFragment} blocked by PostgreSQL backend ${blockerPid}`);
    }

    await t.test('all jobs must succeed before explicit validation; duplicate commands preserve history and timestamps', async () => {
      await reset();
      await configure();
      const dataset = await create();
      await complete(dataset);
      const before = await readState(dataset.datasetVersionId);
      assert.equal(before.dataset.status, 'BUILDING');
      assert.equal(before.dataset.validating_at, null);
      const response = await command(dataset.datasetVersionId, 'submit-validation');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        datasetSeriesId: dataset.datasetSeriesId, datasetVersionId: dataset.datasetVersionId,
        version: 1, datasetStatus: 'VALIDATING',
      });
      const validated = await readState(dataset.datasetVersionId);
      assert.ok(validated.dataset.validating_at);
      assertHistoryUnchanged(before, validated);
      assert.equal((await command(dataset.datasetVersionId, 'submit-validation')).statusCode, 200);
      assert.deepEqual(await readState(dataset.datasetVersionId), validated);
    });

    for (const jobStatus of ['PENDING', 'RUNNING', 'FAILED'] as const) {
      await t.test(`one ${jobStatus} job prevents validation without mutation`, async () => {
        await reset();
        await configure();
        const dataset = await create();
        const [first, last] = dataset.calculationJobs;
        const dispatched = await run(first!.jobId);
        fake.setExecutionState(dispatched.json(), 'SUCCEEDED');
        assert.equal((await reconcile(first!.jobId)).statusCode, 200);
        if (jobStatus !== 'PENDING') {
          const lastRun = await run(last!.jobId);
          assert.equal(lastRun.statusCode, 200);
          if (jobStatus === 'FAILED') {
            fake.setExecutionState(lastRun.json(), 'FAILED');
            assert.equal((await reconcile(last!.jobId)).statusCode, 200);
          }
        }
        const before = await readState(dataset.datasetVersionId);
        expectError(await command(dataset.datasetVersionId, 'submit-validation'), 409, 'DATASET_NOT_READY_FOR_VALIDATION');
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      });
    }

    await t.test('zero jobs and SUCCEEDED jobs with active attempts are internal invariants', async () => {
      for (const active of [null, 'PREPARED', 'DISPATCHING', 'ACCEPTED'] as const) {
        await reset();
        await configure('DPR', 1);
        const dataset = await create();
        if (active === null) {
          await pool.query('DELETE FROM calculation_jobs WHERE output_dataset_version_id = $1', [dataset.datasetVersionId]);
          await pool.query("UPDATE dataset_versions SET status = 'BUILDING' WHERE id = $1", [dataset.datasetVersionId]);
        } else {
          const prepared = await prepare(dataset.calculationJobs[0]!.jobId);
          await pool.query("UPDATE calculation_jobs SET status = 'SUCCEEDED' WHERE id = $1", [prepared.jobId]);
          await pool.query('UPDATE execution_attempts SET status = $2 WHERE id = $1', [prepared.executionAttemptId, active]);
        }
        const before = await readState(dataset.datasetVersionId);
        expectError(await command(dataset.datasetVersionId, 'submit-validation'), 500, 'INTERNAL_SERVER_ERROR');
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      }
    });

    for (const action of ['publish', 'reject'] as const) {
      await t.test(`${action} sets a terminal timestamp once and preserves immutable build history`, async () => {
        await reset();
        await configure();
        const dataset = await validating();
        const before = await readState(dataset.datasetVersionId);
        const result = await command(dataset.datasetVersionId, action);
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().datasetStatus, action === 'publish' ? 'PUBLISHED' : 'REJECTED');
        const terminal = await readState(dataset.datasetVersionId);
        assert.ok(terminal.dataset[action === 'publish' ? 'published_at' : 'rejected_at']);
        assertHistoryUnchanged(before, terminal);
        assert.equal((await command(dataset.datasetVersionId, action)).statusCode, 200);
        assert.deepEqual(await readState(dataset.datasetVersionId), terminal);
        const next = await create();
        assert.equal(next.version, 2);
        assert.equal(next.datasetSeriesId, dataset.datasetSeriesId);
      });
    }

    await t.test('route error contracts cover every invalid source state and unknown ids', async () => {
      for (const action of ['submit-validation', 'publish', 'reject', 'abandon'] as const) {
        expectError(await command(randomUUID(), action), 404, 'DATASET_VERSION_NOT_FOUND');
        for (const status of ['DRAFT', 'BUILDING', 'VALIDATING', 'PUBLISHED', 'REJECTED', 'ABANDONED'] as const) {
          const isValid = action === 'submit-validation' ? ['BUILDING', 'VALIDATING'].includes(status)
            : action === 'publish' ? ['VALIDATING', 'PUBLISHED'].includes(status)
              : action === 'reject' ? ['VALIDATING', 'REJECTED'].includes(status)
                : ['DRAFT', 'BUILDING', 'ABANDONED'].includes(status);
          if (isValid) continue;
          await reset();
          await configure();
          const dataset = await create();
          await pool.query('UPDATE dataset_versions SET status = $2 WHERE id = $1', [dataset.datasetVersionId, status]);
          const before = await readState(dataset.datasetVersionId);
          expectError(await command(dataset.datasetVersionId, action), 409,
            action === 'submit-validation' && status === 'DRAFT' ? 'DATASET_NOT_READY_FOR_VALIDATION' : 'STATE_CONFLICT');
          assert.deepEqual(await readState(dataset.datasetVersionId), before);
        }
      }
    });

    for (const scenario of ['DRAFT', 'PENDING', 'DISPATCH_FAILED', 'FAILED', 'SUCCEEDED'] as const) {
      await t.test(`safe ${scenario} dataset can be abandoned without touching jobs, attempts, snapshot or executor`, async () => {
        await reset();
        await configure();
        const dataset = await create();
        if (scenario === 'PENDING') {
          await prepare(dataset.calculationJobs[0]!.jobId);
          // Fixture a BUILDING snapshot with no remaining execution intent.
          await pool.query('DELETE FROM execution_attempts');
        } else if (scenario === 'DISPATCH_FAILED') {
          fake.setDefaultBehavior('REJECT');
          assert.equal((await run(dataset.calculationJobs[0]!.jobId)).statusCode, 502);
        } else if (scenario === 'FAILED' || scenario === 'SUCCEEDED') {
          await complete(dataset, scenario);
        }
        const before = await readState(dataset.datasetVersionId);
        const externalBefore = structuredClone(fake.getExternalExecutions());
        const lookups = fake.getStatusLookupHistory().length;
        const dispatches = fake.getDispatchHistory().length;
        const response = await command(dataset.datasetVersionId, 'abandon');
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().datasetStatus, 'ABANDONED');
        const abandoned = await readState(dataset.datasetVersionId);
        assert.ok(abandoned.dataset.abandoned_at);
        assertHistoryUnchanged(before, abandoned);
        assert.equal((await command(dataset.datasetVersionId, 'abandon')).statusCode, 200);
        assert.deepEqual(await readState(dataset.datasetVersionId), abandoned);
        assert.deepEqual(fake.getExternalExecutions(), externalBefore);
        assert.equal(fake.getStatusLookupHistory().length, lookups);
        assert.equal(fake.getDispatchHistory().length, dispatches);
        assert.equal((await create()).version, 2);
      });
    }

    for (const active of ['PREPARED', 'DISPATCHING', 'ACCEPTED'] as const) {
      await t.test(`${active} execution blocks abandonment without mutation`, async () => {
        await reset(new FakeExecutor({ defaultBehavior: active === 'DISPATCHING' ? 'ACCEPT_THEN_UNKNOWN' : 'ACCEPT' }));
        await configure();
        const dataset = await create();
        if (active === 'PREPARED') await prepare(dataset.calculationJobs[0]!.jobId);
        else await run(dataset.calculationJobs[0]!.jobId);
        const before = await readState(dataset.datasetVersionId);
        assert.equal(before.attempts[0]!.status, active);
        expectError(await command(dataset.datasetVersionId, 'abandon'), 409, 'DATASET_HAS_ACTIVE_EXECUTION');
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      });
    }

    await t.test('RUNNING job without a valid ACCEPTED attempt is unsafe invariant corruption', async () => {
      for (const preparedAttempt of [false, true]) {
        await reset();
        await configure();
        const dataset = await create();
        if (preparedAttempt) await prepare(dataset.calculationJobs[0]!.jobId);
        await pool.query("UPDATE calculation_jobs SET status = 'RUNNING' WHERE id = $1", [dataset.calculationJobs[0]!.jobId]);
        const before = await readState(dataset.datasetVersionId);
        expectError(await command(dataset.datasetVersionId, 'abandon'), 500, 'INTERNAL_SERVER_ERROR');
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      }
    });

    await t.test('twenty concurrent Submit Validation requests converge with a single timestamp', async () => {
      await reset();
      await configure();
      const dataset = await create();
      await complete(dataset);
      const responses = await Promise.all(Array.from({ length: 20 }, () => command(dataset.datasetVersionId, 'submit-validation')));
      assert.ok(responses.every((response) => response.statusCode === 200));
      const state = await readState(dataset.datasetVersionId);
      assert.equal(state.dataset.status, 'VALIDATING');
      assert.ok(state.dataset.validating_at);
      assert.equal((await command(dataset.datasetVersionId, 'submit-validation')).statusCode, 200);
      assert.deepEqual(await readState(dataset.datasetVersionId), state);
    });

    await t.test('final dataset UPDATE failures rollback every lifecycle command atomically', async () => {
      for (const action of ['submit-validation', 'publish', 'reject', 'abandon'] as const) {
        await reset();
        await configure();
        const dataset = await create();
        await complete(dataset);
        if (action === 'publish' || action === 'reject') {
          assert.equal((await command(dataset.datasetVersionId, 'submit-validation')).statusCode, 200);
        }
        const before = await readState(dataset.datasetVersionId);
        await pool.query(`CREATE FUNCTION reject_lifecycle_update_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'forced lifecycle test failure'; END $$;
          CREATE TRIGGER reject_lifecycle_update_for_test BEFORE UPDATE ON dataset_versions
          FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_update_for_test()`);
        try {
          expectError(await command(dataset.datasetVersionId, action), 500, 'INTERNAL_SERVER_ERROR');
          assert.deepEqual(await readState(dataset.datasetVersionId), before);
        } finally {
          await pool.query('DROP TRIGGER reject_lifecycle_update_for_test ON dataset_versions; DROP FUNCTION reject_lifecycle_update_for_test()');
        }
      }
    });

    for (const first of ['submit', 'reconcile'] as const) {
      await t.test(`final-job ${first} obtains execution locks first with deterministic serial outcome`, async () => {
        await reset();
        await configure('DPR', 1);
        const dataset = await create();
        const jobId = dataset.calculationJobs[0]!.jobId;
        const dispatched = await run(jobId);
        fake.setExecutionState(dispatched.json(), 'SUCCEEDED');
        const gate = await rowGate('execution_attempts', dispatched.json().executionAttemptId);
        try {
          const firstRequest = first === 'submit' ? command(dataset.datasetVersionId, 'submit-validation') : reconcile(jobId);
          const firstPid = await blockedBy(gate.pid, 'FOR UPDATE');
          const secondRequest = first === 'submit' ? reconcile(jobId) : command(dataset.datasetVersionId, 'submit-validation');
          await blockedBy(firstPid, 'FOR UPDATE');
          await releaseGate(gate);
          const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
          const submit = first === 'submit' ? firstResponse : secondResponse;
          const reconciled = first === 'submit' ? secondResponse : firstResponse;
          assert.equal(reconciled.statusCode, 200);
          if (first === 'submit') expectError(submit, 409, 'DATASET_NOT_READY_FOR_VALIDATION');
          else assert.equal(submit.statusCode, 200);
          const state = await readState(dataset.datasetVersionId);
          assert.equal(state.dataset.status, first === 'submit' ? 'BUILDING' : 'VALIDATING');
          assert.equal(state.jobs[0]!.status, 'SUCCEEDED');
          assert.equal(state.attempts[0]!.status, 'SUCCEEDED');
        } finally { await releaseGate(gate); }
      });
    }

    for (const winner of ['publish', 'reject'] as const) {
      await t.test(`${winner} wins the Publish-vs-Reject serialization; loser cannot rewrite terminal history`, async () => {
        await reset();
        await configure();
        const dataset = await validating();
        const gate = await rowGate('dataset_versions', dataset.datasetVersionId);
        try {
          const winningRequest = command(dataset.datasetVersionId, winner);
          const winnerPid = await blockedBy(gate.pid);
          const losingRequest = command(dataset.datasetVersionId, winner === 'publish' ? 'reject' : 'publish');
          await blockedBy(winnerPid);
          await releaseGate(gate);
          assert.equal((await winningRequest).statusCode, 200);
          expectError(await losingRequest, 409, 'STATE_CONFLICT');
          const terminal = await readState(dataset.datasetVersionId);
          assert.equal(terminal.dataset.status, winner === 'publish' ? 'PUBLISHED' : 'REJECTED');
          assert.ok(terminal.dataset[winner === 'publish' ? 'published_at' : 'rejected_at']);
          assert.equal(terminal.dataset[winner === 'publish' ? 'rejected_at' : 'published_at'], null);
        } finally { await releaseGate(gate); }
      });
    }

    for (const first of ['publish', 'freeze'] as const) {
      await t.test(`Publish vs downstream First Run: ${first} owns upstream series first`, async () => {
        await reset();
        await configure('CAPEX', 1);
        const previous = await validating('CAPEX');
        assert.equal((await command(previous.datasetVersionId, 'publish')).statusCode, 200);
        const candidate = await validating('CAPEX');
        await configure('DPR', 1, ['CAPEX']);
        const downstream = await create();
        const candidateHistory = await readState(candidate.datasetVersionId);
        const gate = await rowGate('dataset_versions', first === 'publish' ? candidate.datasetVersionId : downstream.datasetVersionId);
        try {
          if (first === 'publish') {
            const publishing = command(candidate.datasetVersionId, 'publish');
            const publisherPid = await blockedBy(gate.pid);
            const freezing = prepare(downstream.calculationJobs[0]!.jobId);
            await blockedBy(publisherPid);
            await releaseGate(gate);
            assert.equal((await publishing).statusCode, 200);
            await freezing;
          } else {
            const freezing = prepare(downstream.calculationJobs[0]!.jobId);
            const freezerPid = await blockedBy(gate.pid);
            const publishing = command(candidate.datasetVersionId, 'publish');
            await blockedBy(freezerPid);
            await releaseGate(gate);
            await freezing;
            assert.equal((await publishing).statusCode, 200);
          }
          const frozen = await readState(downstream.datasetVersionId);
          assert.equal(frozen.snapshots.length, 1);
          assert.equal(frozen.dependencies.length, 1);
          assert.equal(frozen.dependencies[0]!.upstream_dataset_version_id,
            first === 'publish' ? candidate.datasetVersionId : previous.datasetVersionId);
          assertHistoryUnchanged(candidateHistory, await readState(candidate.datasetVersionId));
        } finally { await releaseGate(gate); }
      });
    }

    for (const action of ['publish', 'reject', 'abandon'] as const) {
      for (const first of ['create', 'decision'] as const) {
        await t.test(`${action} vs next-version creation: ${first} owns series first`, async () => {
          await reset();
          await configure();
          const dataset = action === 'abandon' ? await create() : await validating();
          const gate = await rowGate(first === 'create' ? 'dataset_series' : 'dataset_versions',
            first === 'create' ? dataset.datasetSeriesId : dataset.datasetVersionId);
          const createRequest = async () => app!.inject({ method: 'POST', url: '/dataset-versions',
            payload: { domain: 'DPR', companyCode: 'TW01', fiscalYear: 2026, period: 'Q3' } });
          try {
            if (first === 'create') {
              const creating = createRequest();
              const creatorPid = await blockedBy(gate.pid);
              const deciding = command(dataset.datasetVersionId, action);
              await blockedBy(creatorPid);
              await releaseGate(gate);
              expectError(await creating, 409, 'ACTIVE_DATASET_VERSION_EXISTS');
              assert.equal((await deciding).statusCode, 200);
              const series = await pool.query('SELECT last_allocated_version FROM dataset_series WHERE id = $1', [dataset.datasetSeriesId]);
              assert.equal(series.rows[0].last_allocated_version, 1);
              assert.equal((await create()).version, 2);
            } else {
              const deciding = command(dataset.datasetVersionId, action);
              const decisionPid = await blockedBy(gate.pid);
              const creating = createRequest();
              await blockedBy(decisionPid);
              await releaseGate(gate);
              assert.equal((await deciding).statusCode, 200);
              const next = await creating;
              assert.equal(next.statusCode, 201, next.body);
              assert.equal(next.json().version, 2);
            }
            const history = await pool.query('SELECT version, status FROM dataset_versions WHERE dataset_series_id = $1 ORDER BY version', [dataset.datasetSeriesId]);
            assert.deepEqual(history.rows, [
              { version: 1, status: action === 'publish' ? 'PUBLISHED' : action === 'reject' ? 'REJECTED' : 'ABANDONED' },
              { version: 2, status: 'DRAFT' },
            ]);
          } finally { await releaseGate(gate); }
        });
      }
    }

    await t.test('Abandon obtains lifecycle lock before first Run: Run revalidates and never dispatches', async () => {
      await reset();
      await configure('DPR', 1);
      const dataset = await create();
      const gate = await rowGate('dataset_versions', dataset.datasetVersionId);
      try {
        const abandoning = command(dataset.datasetVersionId, 'abandon');
        const abandonPid = await blockedBy(gate.pid);
        const running = run(dataset.calculationJobs[0]!.jobId);
        await blockedBy(abandonPid);
        await releaseGate(gate);
        assert.equal((await abandoning).statusCode, 200);
        expectError(await running, 409, 'JOB_NOT_RUNNABLE');
        const state = await readState(dataset.datasetVersionId);
        assert.equal(state.dataset.status, 'ABANDONED');
        assert.equal(state.attempts.length, 0);
        assert.equal(state.snapshots.length, 0);
        assert.equal(fake.getExternalExecutions().length, 0);
        assert.equal(fake.getDispatchHistory().length, 0);
      } finally { await releaseGate(gate); }
    });

    await t.test('Run commits DISPATCHING before Abandon: external-call barrier proves Abandon is blocked', async () => {
      const executor = new BlockingDispatchExecutor();
      await reset(executor);
      await configure('DPR', 1);
      const dataset = await create();
      const running = run(dataset.calculationJobs[0]!.jobId);
      try {
        await executor.entered;
        const before = await readState(dataset.datasetVersionId);
        assert.equal(before.attempts[0]!.status, 'DISPATCHING');
        expectError(await command(dataset.datasetVersionId, 'abandon'), 409, 'DATASET_HAS_ACTIVE_EXECUTION');
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
        executor.unblock();
        assert.equal((await running).statusCode, 200);
        assert.equal((await readState(dataset.datasetVersionId)).dataset.status, 'BUILDING');
      } finally { executor.unblock(); await running; }
    });

    for (const first of ['abandon', 'reconcile'] as const) {
      await t.test(`reconciliation vs Abandon: ${first} locks job first`, async () => {
        await reset();
        await configure('DPR', 1);
        const dataset = await create();
        const jobId = dataset.calculationJobs[0]!.jobId;
        const dispatched = await run(jobId);
        fake.setExecutionState(dispatched.json(), 'SUCCEEDED');
        const gate = await rowGate('execution_attempts', dispatched.json().executionAttemptId);
        try {
          const firstRequest = first === 'abandon' ? command(dataset.datasetVersionId, 'abandon') : reconcile(jobId);
          const firstPid = await blockedBy(gate.pid);
          const secondRequest = first === 'abandon' ? reconcile(jobId) : command(dataset.datasetVersionId, 'abandon');
          await blockedBy(firstPid);
          await releaseGate(gate);
          const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
          const abandoned = first === 'abandon' ? firstResponse : secondResponse;
          const reconciled = first === 'abandon' ? secondResponse : firstResponse;
          assert.equal(reconciled.statusCode, 200, reconciled.body);
          if (first === 'abandon') expectError(abandoned, 409, 'DATASET_HAS_ACTIVE_EXECUTION');
          else assert.equal(abandoned.statusCode, 200);
          const state = await readState(dataset.datasetVersionId);
          assert.equal(state.dataset.status, first === 'abandon' ? 'BUILDING' : 'ABANDONED');
          assert.equal(state.jobs[0]!.status, 'SUCCEEDED');
          assert.equal(state.attempts[0]!.status, 'SUCCEEDED');
        } finally { await releaseGate(gate); }
      });
    }

    async function advance(dataset: CreateDatasetVersionResult, target: 'VALIDATING' | 'PUBLISHED' | 'REJECTED' | 'ABANDONED') {
      if (target !== 'ABANDONED') {
        assert.equal((await command(dataset.datasetVersionId, 'submit-validation')).statusCode, 200);
      }
      if (target !== 'VALIDATING') {
        const action = target === 'PUBLISHED' ? 'publish' : target === 'REJECTED' ? 'reject' : 'abandon';
        assert.equal((await command(dataset.datasetVersionId, action)).statusCode, 200);
      }
    }

    for (const target of ['VALIDATING', 'PUBLISHED', 'REJECTED', 'ABANDONED'] as const) {
      await t.test(`matching terminal success remains idempotent under ${target}`, async () => {
        await reset();
        await configure('DPR', 1);
        const dataset = await create();
        await complete(dataset);
        const identity = fake.getDispatchHistory()[0]!;
        await advance(dataset, target);
        const before = await readState(dataset.datasetVersionId);
        for (const response of [await reconcile(dataset.calculationJobs[0]!.jobId), await callback(identity)]) {
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().datasetStatus, target);
          assert.equal(response.json().attemptStatus, 'SUCCEEDED');
          assert.equal(response.json().jobStatus, 'SUCCEEDED');
        }
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      });

      await t.test(`historical FAILED attempt never rewrites newer successful job under ${target}`, async () => {
        await reset();
        await configure('DPR', 1);
        const dataset = await create();
        await complete(dataset, 'FAILED');
        const oldIdentity = fake.getDispatchHistory()[0]!;
        await complete(dataset);
        await advance(dataset, target);
        const before = await readState(dataset.datasetVersionId);
        const response = await callback(oldIdentity);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().datasetStatus, target);
        assert.equal(response.json().attemptStatus, 'FAILED');
        assert.equal(response.json().jobStatus, 'SUCCEEDED');
        assert.equal(before.attempts.length, 2);
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      });

      await t.test(`stale Phase-A RUNNING observation returns current terminal state after ${target}`, async () => {
        const executor = new BlockingLookupExecutor();
        await reset(executor);
        await configure('DPR', 1);
        const dataset = await create();
        const jobId = dataset.calculationJobs[0]!.jobId;
        const dispatched = await run(jobId);
        assert.equal(dispatched.statusCode, 200);
        const stale = reconcile(jobId);
        try {
          await executor.entered;
          fake.setExecutionState(dispatched.json(), 'SUCCEEDED');
          assert.equal((await reconcile(jobId)).statusCode, 200);
          await advance(dataset, target);
          const before = await readState(dataset.datasetVersionId);
          executor.unblock();
          const response = await stale;
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().datasetStatus, target);
          assert.equal(response.json().attemptStatus, 'SUCCEEDED');
          assert.equal(response.json().jobStatus, 'SUCCEEDED');
          assert.equal(before.attempts.length, 1);
          assert.deepEqual(await readState(dataset.datasetVersionId), before);
        } finally { executor.unblock(); await stale; }
      });

      for (const attemptStatus of ['ACCEPTED', 'DISPATCHING'] as const) {
        await t.test(`non-terminal ${attemptStatus} outside BUILDING (${target}) fails in Phase A`, async () => {
          await reset(new FakeExecutor({ defaultBehavior: attemptStatus === 'DISPATCHING' ? 'ACCEPT_THEN_UNKNOWN' : 'ACCEPT' }));
          await configure('DPR', 1);
          const dataset = await create();
          const jobId = dataset.calculationJobs[0]!.jobId;
          assert.equal((await run(jobId)).statusCode, attemptStatus === 'DISPATCHING' ? 202 : 200);
          await pool.query('UPDATE dataset_versions SET status = $2 WHERE id = $1', [dataset.datasetVersionId, target]);
          const before = await readState(dataset.datasetVersionId);
          const lookups = fake.getStatusLookupHistory().length;
          assert.equal((await reconcile(jobId)).statusCode, 500);
          assert.equal(fake.getStatusLookupHistory().length, lookups);
          assert.deepEqual(await readState(dataset.datasetVersionId), before);
        });
      }
    }

    for (const local of ['SUCCEEDED', 'FAILED'] as const) {
      await t.test(`terminal ${local} contradiction after lifecycle advancement stays an internal anomaly`, async () => {
        await reset();
        await configure('DPR', 1);
        const dataset = await create();
        await complete(dataset, local);
        await advance(dataset, local === 'SUCCEEDED' ? 'PUBLISHED' : 'ABANDONED');
        const identity = fake.getDispatchHistory()[0]!;
        fake.setExecutionState(identity, local === 'SUCCEEDED' ? 'FAILED' : 'SUCCEEDED');
        const before = await readState(dataset.datasetVersionId);
        assert.equal((await callback(identity)).statusCode, 500);
        assert.deepEqual(await readState(dataset.datasetVersionId), before);
      });
    }

    for (const attemptStatus of ['ACCEPTED', 'DISPATCHING'] as const) {
      await t.test(`Phase B revalidates ${attemptStatus} lifecycle after external lookup`, async () => {
        const executor = new BlockingLookupExecutor({ defaultBehavior: attemptStatus === 'DISPATCHING' ? 'ACCEPT_THEN_UNKNOWN' : 'ACCEPT' });
        await reset(executor);
        await configure('DPR', 1);
        const dataset = await create();
        const jobId = dataset.calculationJobs[0]!.jobId;
        await run(jobId);
        const reconciling = reconcile(jobId);
        try {
          await executor.entered;
          // Deliberate corruption during the executor lookup must not weaken the Phase-B guard.
          await pool.query("UPDATE dataset_versions SET status = 'VALIDATING' WHERE id = $1", [dataset.datasetVersionId]);
          const before = await readState(dataset.datasetVersionId);
          executor.unblock();
          assert.equal((await reconciling).statusCode, 500);
          assert.deepEqual(await readState(dataset.datasetVersionId), before);
        } finally { executor.unblock(); await reconciling; }
      });
    }

    for (const target of ['PUBLISHED', 'REJECTED', 'ABANDONED'] as const) {
      await t.test(`lifecycle to ${target} preserves non-empty upstream snapshot and definition pins`, async () => {
        await reset();
        await configure('CAPEX', 1);
        const upstream = await validating('CAPEX');
        assert.equal((await command(upstream.datasetVersionId, 'publish')).statusCode, 200);
        await configure('DPR', 2, ['CAPEX']);
        const dataset = await create();
        await complete(dataset);
        const before = await readState(dataset.datasetVersionId);
        assert.equal(before.dependencies.length, 1);
        assert.ok(before.jobs.every((job) => job.resolved_dependency_definition_version_id));
        const externalBefore = fake.getExternalExecutions();
        const dispatchesBefore = [...fake.getDispatchHistory()];
        const lookupsBefore = [...fake.getStatusLookupHistory()];
        await advance(dataset, target);
        assertHistoryUnchanged(before, await readState(dataset.datasetVersionId));
        assert.deepEqual(fake.getExternalExecutions(), externalBefore);
        assert.deepEqual(fake.getDispatchHistory(), dispatchesBefore);
        assert.deepEqual(fake.getStatusLookupHistory(), lookupsBefore);
      });
    }
  } finally {
    if (app) await app.close();
    if (applicationPool) await applicationPool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
