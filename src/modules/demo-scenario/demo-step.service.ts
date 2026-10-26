import { Client, type PoolClient } from 'pg';
import type { DemoRuntime } from '../demo-session/demo-runtime.js';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';
import { DemoResourceUnavailableError, DemoSessionError } from '../demo-session/demo-session.errors.js';
import { lockScenarioSession, readScenario, requireGuidedConfiguration, type DemoScenarioDto } from './demo-scenario.repository.js';
import { readGuidedState, readLedgers, type StepLedger, type StepResponse, type StepResult } from './demo-step.repository.js';
import { executeGuidedStep, stateConflict, stepUnknown, successResult, verifyGuidedBinding } from './demo-step.domain.js';
import { stepCount, stepPlan } from './demo-step.plan.js';
import type { StepIntent } from './demo-step.repository.js';

export interface StepOptions {
  // Test-only fault/transport/barrier seams. Not public input or idempotency truth.
  beforeDomain?: (step: number) => Promise<void>;
  beforeCommit?: (phase: 'A' | 'B', client: PoolClient) => Promise<void>;
  commit?: (phase: 'A' | 'B', client: PoolClient) => Promise<void>;
  recoveryClient?: () => Client;
}
const conflict = () => new DemoSessionError('DEMO_SCENARIO_STEP_CONFLICT', 409, 'Demo step request conflicts with durable progress');
interface Locked { scenario: DemoScenarioDto; ledgers: StepLedger[] }

/** Called INSIDE the existing runtime coordinator, not another promise queue. */
export class DemoStepService {
  constructor(private readonly runtime: DemoRuntime, private readonly options: StepOptions = {}) {}

  private async lock(client: PoolClient | Client, session: AuthenticatedDemoSession, id: string): Promise<Locked> {
    await lockScenarioSession(client, session);
    const owned = await client.query('SELECT id FROM demo_scenario_instances WHERE id=$1 AND session_id=$2 FOR UPDATE', [id, session.sessionId]);
    if (!owned.rowCount) throw new DemoResourceUnavailableError();
    const scenario = (await readScenario(client, session.sessionId, id))!;
    if (scenario.scenarioType !== 'HAPPY_PATH' && scenario.scenarioType !== 'FAILURE_RETRY' && scenario.scenarioType !== 'LOST_RESPONSE_RECOVERY') throw stateConflict();
    await client.query('SELECT id FROM demo_scenario_step_executions WHERE scenario_id=$1 ORDER BY step_number FOR UPDATE', [id]);
    return { scenario, ledgers: await readLedgers(client, id) };
  }

  private validateProgress({ scenario, ledgers }: Locked): void {
    const n = scenario.completedStep;
    const count = stepCount(scenario.scenarioType);
    if (n < 0 || n > count || scenario.status !== (n === 0 ? 'READY' : n === count ? 'COMPLETED' : 'IN_PROGRESS')
      || ledgers.filter((l) => l.status === 'COMPLETED').length !== n
      || Array.from({ length: n }, (_, i) => i + 1).some((step) => !ledgers.some((l) => l.step_number === step && l.status === 'COMPLETED'))
      || ledgers.some((l) => l.status === 'PENDING' && l.step_number !== n + 1)) throw stateConflict();
  }

  private select(state: Locked, n: number, requestId: string): StepLedger | undefined {
    if (n > stepCount(state.scenario.scenarioType)) throw new DemoSessionError('INVALID_REQUEST',400,'Invalid step request');
    const existing = state.ledgers.find((l) => l.step_number === n || l.request_id === requestId);
    if (existing && (existing.step_number !== n || existing.request_id !== requestId)) throw conflict();
    // Ledger FIRST: replay stays the original response after subsequent progress.
    if (existing?.status === 'COMPLETED') {
      if (!existing.result || state.scenario.completedStep < n) throw stateConflict();
      return existing;
    }
    this.validateProgress(state);
    if (n !== state.scenario.completedStep + 1) throw conflict();
    return existing;
  }

  private async transaction<T>(phase: 'A' | 'B', body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.runtime.db.connect(); let sent = false; let discard = false;
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await this.options.beforeCommit?.(phase, client);
      sent = true;
      if (this.options.commit) await this.options.commit(phase, client); else await client.query('COMMIT');
      return result;
    } catch (error) {
      if (sent) { discard = true; throw stepUnknown(); }
      await client.query('ROLLBACK').catch(() => { discard = true; });
      throw error;
    } finally { client.release(discard); }
  }

  private async confirm(session: AuthenticatedDemoSession, id: string, n: number, requestId: string): Promise<StepLedger> {
    // Separate transport; fresh SQL snapshot only AFTER waiting for the same
    // durable session/scenario locks. Never guess COMMIT from a socket error.
    const client = this.options.recoveryClient?.() ?? new Client({ ...this.runtime.db.options,
      connectionTimeoutMillis: 3000, query_timeout: 3500 });
    client.on('error', () => {});
    try {
      await client.connect(); await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='2s'"); await client.query("SET LOCAL statement_timeout='3s'");
      const state = await this.lock(client, session, id);
      this.validateProgress(state);
      const ledger = this.select(state, n, requestId);
      await client.query('COMMIT');
      if (!ledger) throw stepUnknown();
      return ledger;
    } catch { throw stepUnknown(); }
    finally { await client.end().catch(() => {}); }
  }

  private async reserve(session: AuthenticatedDemoSession, id: string, n: number, requestId: string): Promise<StepLedger> {
    try {
      return await this.transaction('A', async (client) => {
        const state = await this.lock(client, session, id);
        const existing = this.select(state, n, requestId);
        if (existing) return existing;
        let intent: StepIntent;
        if (n === 1) {
          await requireGuidedConfiguration(client);
          intent = { domain: 'CAPEX', companyCode: session.companyCode, fiscalYear: 2026, period: 'Q4',
            expectedVersion: 1, calculationTypeCode: 'DEMO_GUIDED_SUMMARY' };
        } else {
          const initial = state.ledgers.find((l) => l.step_number === 1)!.result!.stepResult;
          const binding = { datasetVersionId: initial.datasetVersionId, jobId: initial.jobId };
          const durable = await readGuidedState(client, session);
          const plan = stepPlan(state.scenario.scenarioType,n);
          const initialRun = state.ledgers.find((l) => l.step_number === 2)?.result?.stepResult;
          if (n === 2) { verifyGuidedBinding(durable,binding,plan); intent = binding; }
          else if (state.scenario.scenarioType === 'FAILURE_RETRY' && n === 5) {
            const resources = verifyGuidedBinding(durable,binding);
            const failed = resources.attempt;
            const reconciled = state.ledgers.find((l) => l.step_number === 4)!.result!.stepResult;
            if (!failed || failed.status !== 'FAILED' || resources.job.status !== 'FAILED' || resources.version.status !== 'BUILDING'
              || reconciled.executionAttemptId !== failed.id || reconciled.attemptStatus !== 'FAILED'
              || resources.snapshot?.id !== initialRun?.datasetBuildSnapshotId
              || resources.job.definition !== initialRun?.resolvedDependencyDefinitionVersionId) throw stateConflict();
            intent = { ...binding, datasetBuildSnapshotId: initialRun!.datasetBuildSnapshotId,
              resolvedDependencyDefinitionVersionId: initialRun!.resolvedDependencyDefinitionVersionId,
              previousExecutionAttemptId: failed.id, previousAttemptStatus: 'FAILED', previousAttemptHistory: failed.history, expectedAttemptNumber: 2 };
            verifyGuidedBinding(durable,intent,plan);
          } else {
            const retry = plan.attemptNumber === 2 ? state.ledgers.find((l) => l.step_number === 5) : undefined;
            const run = retry?.result?.stepResult ?? initialRun!;
            const priorBinding: StepIntent = { ...binding,
              ...(retry ? { previousExecutionAttemptId: retry.intent.previousExecutionAttemptId,
                previousAttemptStatus: retry.intent.previousAttemptStatus, previousAttemptHistory: retry.intent.previousAttemptHistory,
                expectedAttemptNumber: retry.intent.expectedAttemptNumber } : {}),
              datasetBuildSnapshotId: initialRun!.datasetBuildSnapshotId, resolvedDependencyDefinitionVersionId: initialRun!.resolvedDependencyDefinitionVersionId };
            const resources = verifyGuidedBinding(durable,priorBinding,plan);
            if (!resources.attempt || resources.attempt.id !== run.executionAttemptId || resources.snapshot?.id !== run.datasetBuildSnapshotId
              || resources.job.definition !== run.resolvedDependencyDefinitionVersionId) throw stateConflict();
            intent = { ...priorBinding, executionAttemptId: run.executionAttemptId,
              datasetBuildSnapshotId: run.datasetBuildSnapshotId, resolvedDependencyDefinitionVersionId: run.resolvedDependencyDefinitionVersionId,
              airflowDagId: resources.attempt.dag, airflowDagRunId: resources.attempt.run };
          }
        }
        await client.query(`INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent)
          VALUES($1,$2,$3,$4)`, [id, n, requestId, intent]);
        return (await readLedgers(client, id)).find((l) => l.step_number === n)!;
      });
    } catch (error) {
      if (error instanceof DemoSessionError && error.code === 'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN') return this.confirm(session, id, n, requestId);
      throw error;
    }
  }

  async next(session: AuthenticatedDemoSession, id: string, n: number, requestId: string): Promise<StepResponse> {
    this.runtime.sessions.assertTrusted(session);
    const ledger = await this.reserve(session, id, n, requestId);
    if (ledger.status === 'COMPLETED') return ledger.result!;
    await this.options.beforeDomain?.(n);
    const result = await executeGuidedStep(this.runtime, session, ledger);
    if (!result) {
      const plan = stepPlan(ledger.scenario_type,n);
      const resources = verifyGuidedBinding(await readGuidedState(this.runtime.db, session), ledger.intent,plan);
      return { scenarioId: id, stepNumber: n, requestId, stepStatus: 'PENDING', completedStep: n - 1,
        scenarioStatus: 'IN_PROGRESS', stepResult: { datasetVersionId: resources.version.id, jobId: resources.job.id,
          datasetStatus: resources.version.status, jobStatus: resources.job.status,
          executionAttemptId: resources.attempt!.id, attemptStatus: resources.attempt!.status,
          ...(ledger.scenario_type !== 'HAPPY_PATH' ? {attemptNumber:resources.attempt!.number} : {}) } };
    }
    return this.complete(session, ledger, result);
  }

  private async complete(session: AuthenticatedDemoSession, original: StepLedger, result: StepResult): Promise<StepResponse> {
    const id = original.scenario_id; const n = original.step_number; const requestId = original.request_id;
    try {
      return await this.transaction('B', async (client) => {
        const state = await this.lock(client, session, id);
        const ledger = this.select(state, n, requestId);
        if (!ledger || ledger.id !== original.id) throw stateConflict();
        if (ledger.status === 'COMPLETED') return ledger.result!;
        // Durable exact binding/success recheck. No fake/executor call in B.
        const verified = successResult(await readGuidedState(client, session), ledger);
        if (JSON.stringify(verified) !== JSON.stringify(result)) throw stateConflict();
        const response: StepResponse = { scenarioId: id, stepNumber: n, requestId, stepStatus: 'COMPLETED',
          completedStep: n, scenarioStatus: n === stepCount(ledger.scenario_type) ? 'COMPLETED' : 'IN_PROGRESS', stepResult: verified };
        const updated = await client.query(`UPDATE demo_scenario_instances SET completed_step=$2,status=$3,updated_at=clock_timestamp()
          WHERE id=$1 AND completed_step=$4 RETURNING id`, [id, n, response.scenarioStatus, n - 1]);
        if (updated.rowCount !== 1) throw stateConflict();
        await client.query(`UPDATE demo_scenario_step_executions SET status='COMPLETED',result=$2,completed_at=clock_timestamp()
          WHERE id=$1 AND status='PENDING'`, [ledger.id, response]);
        return response;
      });
    } catch (error) {
      if (error instanceof DemoSessionError && error.code === 'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN') {
        const confirmed = await this.confirm(session, id, n, requestId);
        if (confirmed.status === 'COMPLETED') return confirmed.result!;
        // Confirmed rollback: leave PENDING. Same-request retry inspects domain
        // truth, never repeats an already successful operation blindly.
        throw stepUnknown();
      }
      throw error;
    }
  }

  async pending(session: AuthenticatedDemoSession, id: string) {
    this.runtime.sessions.assertTrusted(session);
    // Owned parent and optional child in one read-only PostgreSQL snapshot.
    const result = await this.runtime.db.query<{ pending: { stepNumber: number; requestId: string } | null }>(`SELECT
      (SELECT jsonb_build_object('stepNumber',l.step_number,'requestId',l.request_id)
       FROM demo_scenario_step_executions l WHERE l.scenario_id=sc.id AND l.status='PENDING') AS pending
      FROM demo_scenario_instances sc WHERE sc.id=$1 AND sc.session_id=$2`, [id, session.sessionId]);
    if (!result.rowCount) throw new DemoResourceUnavailableError();
    return { pendingStep: result.rows[0]!.pending };
  }
}
