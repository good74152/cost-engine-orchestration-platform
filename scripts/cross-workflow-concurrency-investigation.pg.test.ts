import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Client, type Pool } from 'pg';
import type {
  CalculationExecutor, DispatchCalculationCommand, DispatchResult,
  ExecutionIdentity, ExecutorExecutionStatus,
} from '../src/executors/calculation-executor.js';
import { FakeExecutor, type FakeExecutorOptions } from '../src/executors/fake-executor.js';
import type { CreateDatasetVersionResult } from '../src/modules/dataset-version/dataset-version.types.js';

const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('TEST_DATABASE_URL or DATABASE_URL must point to PostgreSQL');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// A timeout is a failure watchdog, never an interleaving/scheduling mechanism.
async function bounded<T>(promise: PromiseLike<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 20_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

interface ProcessedDispatch {
  command: DispatchCalculationCommand;
  actualFakeResult: DispatchResult;
  returnedResult: DispatchResult;
  externalRunsAtProcessing: number;
}

// Only responses are delayed. Normal processing is delegated unchanged to FakeExecutor.
// The optional invalid fixture is clearly separate: it lies about an existing run.
class ControlledExecutor implements CalculationExecutor {
  readonly fake: FakeExecutor;
  readonly events: string[] = [];
  readonly processed: ProcessedDispatch[] = [];
  private readonly entries = [deferred<ProcessedDispatch>(), deferred<ProcessedDispatch>()];
  private readonly releases = [deferred<void>(), deferred<void>()];
  private calls = 0;
  private open = false;

  constructor(options: FakeExecutorOptions = {}, private readonly invalidFirstRejection = false) {
    this.fake = new FakeExecutor(options);
  }

  async dispatch(command: DispatchCalculationCommand): Promise<DispatchResult> {
    const index = this.calls++;
    const actualFakeResult = await this.fake.dispatch(command);
    const returnedResult: DispatchResult = this.invalidFirstRejection && index === 0
      ? { kind: 'REJECTED', message: 'INVALID TEST EXECUTOR: definite no-run despite existing execution' }
      : actualFakeResult;
    const processed = { command, actualFakeResult, returnedResult,
      externalRunsAtProcessing: this.fake.getExternalExecutions().length };
    this.processed.push(structuredClone(processed));
    this.events.push(`dispatch ${index + 1}: external processing ${actualFakeResult.kind}; held response ${returnedResult.kind}`);
    this.entries[index]?.resolve(processed);
    if (!this.open && index < this.releases.length) await this.releases[index]!.promise;
    this.events.push(`dispatch ${index + 1}: response returned to backend`);
    return returnedResult;
  }

  async getExecutionStatus(identity: ExecutionIdentity): Promise<ExecutorExecutionStatus> {
    const result = await this.fake.getExecutionStatus(identity);
    this.events.push(`executor lookup ${identity.airflowDagRunId}: ${result.kind}`);
    return result;
  }

  entered(index: number): Promise<ProcessedDispatch> {
    return bounded(this.entries[index]!.promise, `dispatch ${index + 1} entry`);
  }

  release(index: number): void {
    this.events.push(`test releases dispatch ${index + 1}`);
    this.releases[index]!.resolve();
  }

  releaseAll(): void {
    // Future calls also pass through, so cleanup cannot strand a late-starting request.
    this.open = true;
    for (const release of this.releases) release.resolve();
  }
}

type Row = Record<string, unknown>;
type HttpResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
function http(response: HttpResponse) {
  const body = response.json();
  return { status: response.statusCode, body, publicErrorCode: body.code ?? null };
}

test('Task 007B integrated regressions: real PostgreSQL cross-workflow races (ADR-0008)',
  { concurrency: false }, async (t) => {
    const name = `cross_workflow_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    assert.match(name, /^cross_workflow_test_[a-z0-9_]+$/);
    assert.ok(name.length <= 63);
    function url(database: string) {
      const parsed = new URL(sourceUrl!);
      parsed.pathname = `/${database}`;
      return parsed.toString();
    }
    const admin = new Client({ connectionString: url('postgres') });
    const previousUrl = process.env.DATABASE_URL;
    let applicationPool: Pool | undefined;
    const applicationClientEnds: Promise<void>[] = [];
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
      // pg-pool can resolve end() before every socket emits its final end event.
      // Await those events before dropping this owned database (also on Linux CI).
      pool.on('connect', client => {
        applicationClientEnds.push(new Promise<void>(resolve => client.once('end', resolve)));
      });
      const metadata = {
        gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        productionBaselineCommit: '85479c723090de8dc96cdb0a13472f3156b5e8f9',
        testSourceGitBlob: execFileSync('git', ['hash-object', fileURLToPath(import.meta.url)], { encoding: 'utf8' }).trim(),
        nodeVersion: process.version,
        postgresVersion: (await pool.query<{ version: string }>('SELECT version()')).rows[0]!.version,
        databaseSetup: 'Owned cross_workflow_test_* database; TEMPLATE template0; all checked-in migrations up in one transaction; dropped in finally',
        migrations: (await pool.query('SELECT name FROM pgmigrations ORDER BY run_on, id')).rows,
      };
      assert.ok(metadata.migrations.some((migration) => migration.name === '1788700000000_orchestration-schema-v2'));
      console.log(`INVESTIGATION_METADATA ${JSON.stringify(metadata)}`);

      async function post(path: string, payload?: object) {
        return bounded(app!.inject({ method: 'POST', url: path, ...(payload ? { payload } : {}) }), `HTTP ${path}`);
      }
      async function run(jobId: string) { return post(`/calculation-jobs/${jobId}/run`); }
      async function reconcile(jobId: string) { return post(`/calculation-jobs/${jobId}/reconcile`); }

      async function configure(domain: string, code: string, requiredDomains: string[]) {
        const typeId = randomUUID();
        const definitionId = randomUUID();
        await pool.query(`INSERT INTO calculation_types
          (id, domain, code, airflow_dag_id, is_active, last_allocated_dependency_definition_version)
          VALUES ($1, $2, $3, $4, TRUE, 1)`, [typeId, domain, code, `dag_${domain}_${code}`]);
        await pool.query(`INSERT INTO execution_dependency_definition_versions
          (id, calculation_type_id, version, status, published_at) VALUES ($1, $2, 1, 'PUBLISHED', NOW())`, [definitionId, typeId]);
        for (const required of requiredDomains) {
          await pool.query(`INSERT INTO execution_dependency_definition_dependencies
            (definition_version_id, required_domain) VALUES ($1, $2)`, [definitionId, required]);
        }
      }

      async function create(domain: string): Promise<CreateDatasetVersionResult> {
        const response = await post('/dataset-versions', { domain, companyCode: 'TW01', fiscalYear: 2026, period: 'Q3' });
        assert.equal(response.statusCode, 201, response.body);
        return response.json();
      }

      async function fixture(executor: ControlledExecutor) {
        if (app) await app.close();
        // Only this suite's disposable database is ever truncated.
        assert.equal((await pool.query('SELECT current_database() AS name')).rows[0]!.name, name);
        await pool.query('TRUNCATE dataset_series, calculation_types CASCADE');
        const upstreamExecutor = new FakeExecutor();
        app = await buildApp({ logger: false, calculationExecutor: upstreamExecutor, nodeEnvironment: 'test' });
        await configure('CAPEX', 'SOURCE', []);
        const upstream = await create('CAPEX');
        const upstreamRun = await run(upstream.calculationJobs[0]!.jobId);
        assert.equal(upstreamRun.statusCode, 200);
        upstreamExecutor.setExecutionState(upstreamRun.json(), 'SUCCEEDED');
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
          upstreamVersionId: upstream.datasetVersionId };
      }

      async function state(datasetId: string) {
        const [dataset, jobs, attempts, snapshots, dependencies] = await Promise.all([
          pool.query('SELECT * FROM dataset_versions WHERE id = $1', [datasetId]),
          pool.query(`SELECT *
            FROM calculation_jobs WHERE output_dataset_version_id = $1 ORDER BY id`, [datasetId]),
          pool.query(`SELECT ea.*
            FROM execution_attempts ea JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
            WHERE cj.output_dataset_version_id = $1 ORDER BY ea.calculation_job_id, ea.attempt_number`, [datasetId]),
          pool.query('SELECT * FROM dataset_build_snapshots WHERE dataset_version_id = $1', [datasetId]),
          pool.query(`SELECT dep.* FROM dataset_build_snapshot_dependencies dep
            JOIN dataset_build_snapshots s ON s.id = dep.snapshot_id WHERE s.dataset_version_id = $1
            ORDER BY dep.upstream_dataset_series_id`, [datasetId]),
        ]);
        return { dataset: dataset.rows[0]!, jobs: jobs.rows as Row[], attempts: attempts.rows as Row[],
          snapshots: snapshots.rows as Row[], dependencies: dependencies.rows as Row[] };
      }

      type State = Awaited<ReturnType<typeof state>>;
      function frozen(current: State) {
        return { snapshots: current.snapshots, dependencies: current.dependencies,
          definitions: current.jobs.map((job) => ({ jobId: job.id, definitionId: job.resolved_dependency_definition_version_id })) };
      }
      function assertFrozen(before: State, after: State) {
        assert.equal(before.snapshots.length, 1);
        assert.equal(before.dependencies.length, 1);
        assert.equal(before.jobs.length, 2);
        assert.ok(before.jobs.every((job) => job.resolved_dependency_definition_version_id));
        assert.deepEqual(frozen(after), frozen(before));
      }
      function assertIdentity(current: State, command: DispatchCalculationCommand) {
        assert.equal(current.attempts.length, 1);
        const attempt = current.attempts[0]!;
        assert.equal(attempt.id, command.executionAttemptId);
        assert.equal(attempt.attempt_number, command.attemptNumber);
        assert.equal(attempt.airflow_dag_id, command.airflowDagId);
        assert.equal(attempt.airflow_dag_run_id, command.airflowDagRunId);
        assert.equal(current.dataset.status, 'BUILDING');
      }

      async function proveExternalLocksReleased(command: DispatchCalculationCommand) {
        const observer = await pool.connect();
        try {
          await observer.query('BEGIN');
          await observer.query('SELECT id FROM dataset_versions WHERE id = $1 FOR UPDATE NOWAIT', [command.datasetVersionId]);
          await observer.query('SELECT id FROM calculation_jobs WHERE id = $1 FOR UPDATE NOWAIT', [command.jobId]);
          await observer.query('SELECT id FROM execution_attempts WHERE id = $1 FOR UPDATE NOWAIT', [command.executionAttemptId]);
          const idle = await observer.query(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`);
          assert.equal(idle.rows[0]!.count, 0);
          return { datasetJobAttemptNowait: 'all acquired', otherIdleTransactions: idle.rows[0]!.count };
        } finally { await observer.query('ROLLBACK'); observer.release(); }
      }

      function evidence(id: string, executor: ControlledExecutor, details: Record<string, unknown>) {
        console.log(`INVESTIGATION_EVIDENCE ${JSON.stringify({ scenarioId: id, ...details,
          synchronization: executor.events, externalProcessing: executor.processed,
          externalExecutions: executor.fake.getExternalExecutions() })}`);
      }

      for (const order of ['RECONCILE_FIRST', 'DISPATCH_FIRST'] as const) {
        await t.test(`CON-01-${order}: terminal truth must not turn a valid late dispatch response into HTTP 500`, async () => {
          const executor = new ControlledExecutor();
          const { dataset, jobId } = await fixture(executor);
          const initial = await state(dataset.datasetVersionId);
          const requestA = run(jobId);
          try {
            const { command, returnedResult } = await executor.entered(0);
            assert.equal(returnedResult.kind, 'ACCEPTED');
            const dispatching = await state(dataset.datasetVersionId);
            assertIdentity(dispatching, command);
            assert.equal(dispatching.attempts[0]!.status, 'DISPATCHING');
            assert.equal(dispatching.jobs.find((job) => job.id === jobId)!.status, 'PENDING');
            assert.equal(executor.fake.getExternalExecutions().length, 1);
            const locks = await proveExternalLocksReleased(command);
            let responseA: HttpResponse;
            let responseB: HttpResponse;
            let committed: State;
            if (order === 'RECONCILE_FIRST') {
              executor.fake.setExecutionState(command, 'SUCCEEDED');
              responseB = await reconcile(jobId);
              executor.events.push('B reconciliation HTTP completed; PostgreSQL commit verified');
              committed = await state(dataset.datasetVersionId);
              assert.equal(committed.attempts[0]!.status, 'SUCCEEDED');
              assert.equal(committed.jobs.find((job) => job.id === jobId)!.status, 'SUCCEEDED');
              executor.release(0);
              responseA = await bounded(requestA, 'late Run response');
            } else {
              executor.release(0);
              responseA = await bounded(requestA, 'normal Run response');
              const accepted = await state(dataset.datasetVersionId);
              assert.equal(accepted.attempts[0]!.status, 'ACCEPTED');
              assert.equal(accepted.jobs.find((job) => job.id === jobId)!.status, 'RUNNING');
              executor.fake.setExecutionState(command, 'SUCCEEDED');
              responseB = await reconcile(jobId);
              committed = await state(dataset.datasetVersionId);
            }
            executor.events.push('A and B HTTP completed');
            const final = await state(dataset.datasetVersionId);
            evidence(`CON-01-${order}`, executor, { initial, dispatching, afterReconciliationCommit: committed,
              requestA: http(responseA), requestB: http(responseB), final, locks,
              executorContract: 'Unmodified FakeExecutor ACCEPT result; delayed response only' });
            assert.equal(responseB.statusCode, 200, responseB.body);
            assertIdentity(final, command);
            assert.equal(final.attempts[0]!.status, 'SUCCEEDED');
            assert.equal(final.jobs.find((job) => job.id === jobId)!.status, 'SUCCEEDED');
            assertFrozen(dispatching, final);
            assert.deepEqual(final, committed);
            assert.equal(executor.fake.getExternalExecutions().length, 1);
            // Task 007B-1: valid late responses return durable terminal truth.
            assert.equal(responseA.statusCode, 200, `CON-01 valid interleaving: ${responseA.body}`);
          } finally {
            executor.releaseAll();
            await bounded(Promise.allSettled([requestA]), 'CON-01 request cleanup');
          }
        });
      }

      for (const invalid of [false, true]) {
        for (const recordFirst of ['A', 'B'] as const) {
          const id = `CON-02-${invalid ? 'INVALID' : 'FAKE'}-${recordFirst}_FIRST`;
          await t.test(`${id}: distinguish external processing order from backend recording order`, async () => {
            const executor = new ControlledExecutor({
              scriptedBehaviors: invalid ? ['ACCEPT', 'REJECT'] : ['REJECT', 'ACCEPT'],
              defaultBehavior: 'REJECT',
            }, invalid);
            const { dataset, jobId } = await fixture(executor);
            const initial = await state(dataset.datasetVersionId);
            const requests: Array<Promise<HttpResponse>> = [];
            try {
              requests.push(run(jobId));
              const processedA = await executor.entered(0);
              const afterAExternal = await state(dataset.datasetVersionId);
              requests.push(run(jobId));
              const processedB = await executor.entered(1);
              assert.deepEqual(processedA.command, processedB.command);
              assert.equal(processedA.returnedResult.kind, 'REJECTED');
              // ADR-0008 replaces the old per-call REJECT→ACCEPT expectation.
              // Both valid calls must observe X's irrevocable rejection.
              assert.equal(processedB.returnedResult.kind, invalid ? 'ALREADY_EXISTS' : 'REJECTED');
              assert.equal(processedA.externalRunsAtProcessing, invalid ? 1 : 0);
              assert.equal(processedB.externalRunsAtProcessing, invalid ? 1 : 0);
              const bothBlocked = await state(dataset.datasetVersionId);
              assertIdentity(bothBlocked, processedA.command);
              assert.equal(bothBlocked.attempts[0]!.status, 'DISPATCHING');
              assert.equal(bothBlocked.jobs.find((job) => job.id === jobId)!.status, 'PENDING');
              const locks = await proveExternalLocksReleased(processedA.command);
              const firstIndex = recordFirst === 'A' ? 0 : 1;
              executor.release(firstIndex);
              const firstResponse = await bounded(requests[firstIndex]!, `${id} first response`);
              executor.events.push(`${firstIndex === 0 ? 'A' : 'B'} HTTP completed; first outcome commit inspected`);
              const afterFirstRecord = await state(dataset.datasetVersionId);
              executor.release(1 - firstIndex);
              const secondResponse = await bounded(requests[1 - firstIndex]!, `${id} second response`);
              const responseA = firstIndex === 0 ? firstResponse : secondResponse;
              const responseB = firstIndex === 1 ? firstResponse : secondResponse;
              executor.events.push('A and B HTTP completed; final original attempt inspected');
              const finalOriginal = await state(dataset.datasetVersionId);
              assertIdentity(finalOriginal, processedA.command);
              assertFrozen(bothBlocked, finalOriginal);
              assert.deepEqual(finalOriginal, afterFirstRecord,
                'Second recording cannot rewrite committed state, timestamps or diagnostics');
              if (!invalid) {
                for (const response of [responseA, responseB]) {
                  assert.equal(response.statusCode, 502, response.body);
                  assert.equal(response.json().code, 'EXECUTOR_DISPATCH_FAILED');
                }
                assert.equal(finalOriginal.attempts[0]!.status, 'DISPATCH_FAILED');
                assert.ok(finalOriginal.attempts[0]!.finished_at);
                assert.equal(finalOriginal.attempts[0]!.accepted_at, null);
                assert.equal(finalOriginal.jobs.find((job) => job.id === jobId)!.status, 'PENDING');
                assert.equal(executor.fake.getExternalExecutions().length, 0);
                // Repeating rejected X never consumes the queued ACCEPT for retry Y.
                const repeated = await Promise.all(Array.from({ length: 20 }, () => executor.fake.dispatch(processedA.command)));
                assert.ok(repeated.every((result) => result.kind === 'REJECTED'));
                assert.deepEqual(await executor.fake.getExecutionStatus(processedA.command), { kind: 'NOT_FOUND' });
                assert.deepEqual(await state(dataset.datasetVersionId), finalOriginal);
              } else {
                // This deliberately dishonest adapter is NOT a supported race.
                assert.equal(processedA.actualFakeResult.kind, 'ACCEPTED');
                assert.equal(processedA.externalRunsAtProcessing, 1);
                assert.equal(firstResponse.statusCode, recordFirst === 'A' ? 502 : 200);
                assert.equal(secondResponse.statusCode, recordFirst === 'A' ? 500 : 200);
                if (recordFirst === 'A') {
                  assert.equal(secondResponse.json().code, 'INTERNAL_SERVER_ERROR');
                  assert.equal(finalOriginal.attempts[0]!.status, 'DISPATCH_FAILED');
                  assert.equal(finalOriginal.jobs.find((job) => job.id === jobId)!.status, 'PENDING');
                }
              }
              const externalBeforeRecovery = structuredClone(executor.fake.getExternalExecutions());
              executor.releaseAll();
              const manual = await reconcile(jobId);
              const callback = await post('/executor-callbacks/airflow', {
                airflowDagId: processedA.command.airflowDagId, airflowDagRunId: processedA.command.airflowDagRunId,
              });
              const beforeRetry = await state(dataset.datasetVersionId);
              const retry = await run(jobId);
              const afterRetry = await state(dataset.datasetVersionId);
              const afterRetryCallback = await post('/executor-callbacks/airflow', {
                airflowDagId: processedA.command.airflowDagId, airflowDagRunId: processedA.command.airflowDagRunId,
              });
              const subsequentReconcile = await reconcile(jobId);
              const finalRecovery = await state(dataset.datasetVersionId);
              assertFrozen(bothBlocked, finalRecovery);
              evidence(id, executor, { initial, afterAExternal, bothBlocked, afterFirstRecord,
                requestA: http(responseA), requestB: http(responseB), finalOriginal, locks, externalBeforeRecovery,
                recovery: { manual: http(manual), sameIdentityCallback: http(callback), beforeRetry,
                  run: http(retry), afterRetry, afterRetrySameIdentityCallback: http(afterRetryCallback),
                  subsequentReconcile: http(subsequentReconcile), final: finalRecovery },
                executorContract: invalid
                  ? 'INTENTIONAL ADR-0008 VIOLATION: created X but returned definite no-run REJECTED; no backend repair permitted'
                  : 'ADR-0008: REJECT permanently reserves X; second dispatch also REJECTED; retry may create fresh Y' });
              if (!invalid) {
                for (const response of [manual, callback, afterRetryCallback]) {
                  assert.equal(response.statusCode, 409, response.body);
                  assert.equal(response.json().code, 'EXECUTION_NOT_RECONCILABLE');
                }
                assert.deepEqual(beforeRetry, finalOriginal);
                assert.equal(retry.statusCode, 200, retry.body);
                assert.equal(retry.json().attemptNumber, 2);
                assert.equal(retry.json().attemptStatus, 'ACCEPTED');
                assert.equal(retry.json().jobStatus, 'RUNNING');
                assert.notEqual(retry.json().executionAttemptId, processedA.command.executionAttemptId);
                assert.notEqual(retry.json().airflowDagRunId, processedA.command.airflowDagRunId);
                assert.equal(afterRetry.attempts.length, 2);
                assert.deepEqual(afterRetry.attempts[0], finalOriginal.attempts[0]);
                assert.equal(afterRetry.attempts[1]!.status, 'ACCEPTED');
                const retryCommand = executor.processed[2]!.command;
                assert.deepEqual(retryCommand, { ...processedA.command,
                  executionAttemptId: retry.json().executionAttemptId, attemptNumber: 2,
                  airflowDagRunId: retry.json().airflowDagRunId });
                assert.equal(executor.fake.getExternalExecutions().length, 1);
                assert.deepEqual(executor.fake.getExternalExecutions()[0]!.command, retryCommand);
                assert.equal((await executor.fake.dispatch(processedA.command)).kind, 'REJECTED');
                assert.equal(executor.fake.getExternalExecutions().length, 1, 'Rejected X must remain absent after accepting Y');
                assert.deepEqual(await state(dataset.datasetVersionId), afterRetry);
                assert.equal(subsequentReconcile.statusCode, 200);
                assert.deepEqual(finalRecovery, afterRetry);
              }
            } finally {
              executor.releaseAll();
              await bounded(Promise.allSettled(requests), `${id} request cleanup`);
            }
          });
        }
      }

      for (const firstResponse of [0, 1]) {
        await t.test(`CON-02-EXISTS-${firstResponse}: existing identity yields ALREADY_EXISTS, never scripted REJECT`, async () => {
          const executor = new ControlledExecutor({ scriptedBehaviors: ['ACCEPT', 'REJECT'] });
          const { dataset, jobId } = await fixture(executor);
          const initial = await state(dataset.datasetVersionId);
          const requests: Array<Promise<HttpResponse>> = [];
          try {
            requests.push(run(jobId));
            const a = await executor.entered(0);
            requests.push(run(jobId));
            const b = await executor.entered(1);
            assert.equal(a.returnedResult.kind, 'ACCEPTED');
            assert.equal(b.returnedResult.kind, 'ALREADY_EXISTS');
            assert.deepEqual(a.command, b.command);
            const dispatching = await state(dataset.datasetVersionId);
            const locks = await proveExternalLocksReleased(a.command);
            executor.release(firstResponse);
            const first = await bounded(requests[firstResponse]!, 'existing identity first response');
            const afterFirstRecord = await state(dataset.datasetVersionId);
            executor.release(1 - firstResponse);
            const second = await bounded(requests[1 - firstResponse]!, 'existing identity second response');
            const final = await state(dataset.datasetVersionId);
            evidence(`CON-02-EXISTS-${firstResponse}`, executor, { initial, dispatching, afterFirstRecord,
              requestA: http(firstResponse === 0 ? first : second), requestB: http(firstResponse === 1 ? first : second), final, locks,
              executorContract: 'FakeExecutor checks existing X before consuming scripted REJECT' });
            assert.equal(first.statusCode, 200);
            assert.equal(second.statusCode, 200);
            assertIdentity(final, a.command);
            assertFrozen(dispatching, final);
            assert.equal(final.attempts[0]!.status, 'ACCEPTED');
            assert.equal(final.jobs.find((job) => job.id === jobId)!.status, 'RUNNING');
            assert.equal(executor.fake.getExternalExecutions().length, 1);
            assert.deepEqual(final, afterFirstRecord, 'Duplicate acceptance must not rewrite timestamps');
            // A different job consumes the still-queued REJECT, proving the
            // ALREADY_EXISTS decision did not consume it for X.
            executor.releaseAll();
            const otherJobId = dataset.calculationJobs.find((job) => job.jobId !== jobId)!.jobId;
            const other = await run(otherJobId);
            assert.equal(other.statusCode, 502, other.body);
            assert.equal(other.json().code, 'EXECUTOR_DISPATCH_FAILED');
            assert.equal(executor.fake.getExternalExecutions().length, 1);
            const afterOther = await state(dataset.datasetVersionId);
            assertFrozen(final, afterOther);
            assert.deepEqual(afterOther.attempts.find((attempt) => attempt.id === a.command.executionAttemptId), final.attempts[0]);
          } finally {
            executor.releaseAll();
            await bounded(Promise.allSettled(requests), 'existing identity request cleanup');
          }
        });
      }

      for (const behavior of ['UNKNOWN_WITHOUT_CREATION', 'ACCEPT_THEN_UNKNOWN'] as const) {
        await t.test(`CON-02-${behavior}: same-identity recovery without rejection or snapshot refresh`, async () => {
          const executor = new ControlledExecutor({ scriptedBehaviors: [behavior, 'ACCEPT'], defaultBehavior: 'REJECT' });
          executor.releaseAll();
          const { dataset, jobId } = await fixture(executor);
          const first = await run(jobId);
          assert.equal(first.statusCode, 202, first.body);
          assert.equal(first.json().attemptStatus, 'DISPATCHING');
          assert.equal(first.json().jobStatus, 'PENDING');
          assert.equal(first.json().dispatchOutcome, 'UNKNOWN');
          const command = executor.processed[0]!.command;
          const dispatching = await state(dataset.datasetVersionId);
          assertIdentity(dispatching, command);
          assert.equal(dispatching.attempts[0]!.status, 'DISPATCHING');
          assert.equal(executor.fake.getExternalExecutions().length, behavior === 'ACCEPT_THEN_UNKNOWN' ? 1 : 0);
          const recovered = await run(jobId);
          assert.equal(recovered.statusCode, 200, recovered.body);
          assert.equal(recovered.json().attemptStatus, 'ACCEPTED');
          assert.equal(recovered.json().jobStatus, 'RUNNING');
          assert.equal(recovered.json().dispatchOutcome, behavior === 'ACCEPT_THEN_UNKNOWN' ? 'ALREADY_EXISTS' : 'ACCEPTED');
          assert.deepEqual(executor.processed[1]!.command, command);
          const final = await state(dataset.datasetVersionId);
          assertIdentity(final, command);
          assertFrozen(dispatching, final);
          assert.equal(final.attempts[0]!.dispatch_started_at!.valueOf(), dispatching.attempts[0]!.dispatch_started_at!.valueOf());
          assert.equal(final.attempts[0]!.status, 'ACCEPTED');
          assert.equal(executor.fake.getExternalExecutions().length, 1);
          const repeated = await run(jobId);
          assert.equal(repeated.statusCode, 200);
          assert.equal(repeated.json().executionAttemptId, command.executionAttemptId);
          assert.equal(executor.processed.length, 2, 'Accepted state must not redispatch');
          assert.deepEqual(await state(dataset.datasetVersionId), final);
        });
      }

      await t.test('CON-02-IDENTITY: permanent tombstone uses full key and never consumes queued scripts', async () => {
        const executor = new ControlledExecutor({ scriptedBehaviors: ['REJECT', 'ACCEPT'], defaultBehavior: 'REJECT' });
        executor.releaseAll();
        const { dataset, jobId } = await fixture(executor);
        assert.equal((await run(jobId)).statusCode, 502);
        const command = executor.processed[0]!.command;
        const rejected = await state(dataset.datasetVersionId);
        executor.fake.setDefaultBehavior('ACCEPT');
        assert.ok((await Promise.all(Array.from({ length: 20 }, () => executor.fake.dispatch(command))))
          .every((result) => result.kind === 'REJECTED'));
        assert.equal(executor.fake.getExternalExecutions().length, 0);
        assert.equal(executor.fake.setExecutionState(command, 'RUNNING'), false);
        assert.deepEqual(await executor.fake.getExecutionStatus(command), { kind: 'NOT_FOUND' });

        // Test-only identities derived from a real frozen dispatch command:
        // different DAG / same run ID must not inherit X's tombstone. The
        // default REJECT makes consumption of queued ACCEPT observable.
        executor.fake.setDefaultBehavior('REJECT');
        const differentDag = { ...command, airflowDagId: `${command.airflowDagId}_other` };
        assert.equal((await executor.fake.dispatch(differentDag)).kind, 'ACCEPTED');
        assert.equal((await executor.fake.dispatch(differentDag)).kind, 'ALREADY_EXISTS');
        assert.equal((await executor.fake.dispatch(command)).kind, 'REJECTED');
        assert.equal(executor.fake.getExternalExecutions().length, 1);
        assert.deepEqual(executor.fake.getExternalExecutions()[0]!.command, differentDag);
        const differentRun = { ...command, airflowDagRunId: `${command.airflowDagRunId}_other` };
        executor.fake.enqueueBehaviors('ACCEPT');
        assert.equal((await executor.fake.dispatch(differentRun)).kind, 'ACCEPTED');
        assert.equal(executor.fake.getExternalExecutions().length, 2);
        assert.deepEqual(await state(dataset.datasetVersionId), rejected, 'Direct fake probes do not repair DB history');
        // Explicitly bounded to one fake instance; NOT a restart/distributed guarantee.
        assert.equal((await new FakeExecutor().dispatch(command)).kind, 'ACCEPTED');
      });

      await t.test('CON-02-INDEPENDENT: second job dispatches while first external response remains blocked', async () => {
        const executor = new ControlledExecutor();
        const { dataset, jobId } = await fixture(executor);
        const otherJobId = dataset.calculationJobs.find((job) => job.jobId !== jobId)!.jobId;
        const requests = [run(jobId)];
        try {
          const a = await executor.entered(0);
          requests.push(run(otherJobId));
          const b = await executor.entered(1);
          assert.equal(a.returnedResult.kind, 'ACCEPTED');
          assert.equal(b.returnedResult.kind, 'ACCEPTED');
          assert.notEqual(a.command.executionAttemptId, b.command.executionAttemptId);
          assert.notEqual(a.command.airflowDagRunId, b.command.airflowDagRunId);
          assert.equal(a.command.datasetBuildSnapshotId, b.command.datasetBuildSnapshotId);
          assert.equal(a.command.upstreamDatasetVersions.length, 1);
          assert.deepEqual(b.command.upstreamDatasetVersions, []);
          const blocked = await state(dataset.datasetVersionId);
          assert.equal(blocked.attempts.length, 2);
          assert.ok(blocked.attempts.every((attempt) => attempt.status === 'DISPATCHING'));
          await proveExternalLocksReleased(a.command);
          await proveExternalLocksReleased(b.command);
          executor.release(1);
          assert.equal((await bounded(requests[1]!, 'independent B response')).statusCode, 200);
          const beforeA = await state(dataset.datasetVersionId);
          assert.equal(beforeA.jobs.find((job) => job.id === jobId)!.status, 'PENDING');
          assert.equal(beforeA.jobs.find((job) => job.id === otherJobId)!.status, 'RUNNING');
          executor.release(0);
          assert.equal((await bounded(requests[0]!, 'independent A response')).statusCode, 200);
          const final = await state(dataset.datasetVersionId);
          assertFrozen(blocked, final);
          assert.equal(final.attempts.length, 2);
          assert.ok(final.attempts.every((attempt) => attempt.status === 'ACCEPTED'));
          assert.equal(executor.fake.getExternalExecutions().length, 2);
        } finally {
          executor.releaseAll();
          await bounded(Promise.allSettled(requests), 'independent job cleanup');
        }
      });

      await t.test('CON-LOCKS: dispatch recording and reconciliation lock job before attempt', async () => {
        const executor = new ControlledExecutor();
        const { dataset, jobId } = await fixture(executor);
        const requestA = run(jobId);
        const requests = [requestA];
        const proofs: Array<{ phase: string; waitingBackend: number; jobNowaitSqlstate: string }> = [];
        try {
          const { command } = await executor.entered(0);
          const locksReleasedDuringDispatch = await proveExternalLocksReleased(command);
          async function proveJobThenAttempt(phase: string, start: () => Promise<HttpResponse>) {
            const gate = await pool.connect();
            let pending: Promise<HttpResponse> | undefined;
            try {
              await gate.query('BEGIN');
              await gate.query('SELECT id FROM execution_attempts WHERE id = $1 FOR UPDATE', [command.executionAttemptId]);
              const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
              pending = start();
              requests.push(pending);
              // This polling loop has its own finite deadline so failure also stops polling.
              const deadline = Date.now() + 15_000;
              const waitingBackend = await bounded((async () => {
                while (Date.now() < deadline) {
                  const waiting = await pool.query(`SELECT pid FROM pg_stat_activity
                    WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
                      AND strpos(query, 'execution_attempts') > 0 AND strpos(query, 'FOR UPDATE') > 0`, [gatePid]);
                  if (waiting.rows.length) return waiting.rows[0]!.pid as number;
                  await setImmediate();
                }
                assert.fail(`${phase} never waited for the held attempt`);
              })(), `${phase} attempt blocker`);
              const observer = await pool.connect();
              try {
                await observer.query('BEGIN');
                await assert.rejects(observer.query('SELECT id FROM calculation_jobs WHERE id = $1 FOR UPDATE NOWAIT', [jobId]), { code: '55P03' });
                proofs.push({ phase, waitingBackend, jobNowaitSqlstate: '55P03' });
              } finally { await observer.query('ROLLBACK'); observer.release(); }
            } finally {
              await gate.query('ROLLBACK');
              gate.release();
            }
            return bounded(pending!, `${phase} completion`);
          }
          const responseA = await proveJobThenAttempt('dispatch recording', () => {
            executor.release(0);
            return requestA;
          });
          assert.equal(responseA.statusCode, 200);
          executor.fake.setExecutionState(command, 'SUCCEEDED');
          const responseB = await proveJobThenAttempt('reconciliation', () => reconcile(jobId));
          assert.equal(responseB.statusCode, 200);
          evidence('CON-LOCKS', executor, { requestA: http(responseA), requestB: http(responseB),
            final: await state(dataset.datasetVersionId), locksReleasedDuringDispatch, lockOrderProofs: proofs });
        } finally {
          executor.releaseAll();
          await bounded(Promise.allSettled(requests), 'lock-order request cleanup');
        }
      });
    } finally {
      try { if (app) await app.close(); }
      finally {
        try {
          if (applicationPool) {
            await applicationPool.end();
            await Promise.all(applicationClientEnds);
          }
        }
        finally {
          if (previousUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousUrl;
          try {
            assert.match(name, /^cross_workflow_test_[a-z0-9_]+$/);
            assert.ok(name.length <= 63);
            const sessions = await bounded((async () => {
              // A client socket's end event can precede PostgreSQL removing its backend.
              // Wait for the observed server state; retain zero-backend/non-FORCE DROP.
              for (;;) {
                const remaining = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
                if (!remaining.rowCount) return remaining;
                await new Promise<void>(resolve => setImmediate(resolve));
              }
            })(), 'PostgreSQL backend shutdown');
            assert.equal(sessions.rowCount, 0, 'All owned connections must close before DROP');
            await admin.query(`DROP DATABASE "${name}"`);
            console.log('CROSS_WORKFLOW_TEARDOWN', JSON.stringify({ sessions: 0, dropped: true, forced: false }));
          }
          finally { await admin.end(); }
        }
      }
    }
  });
