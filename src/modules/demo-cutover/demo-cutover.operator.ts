import { Client, type Pool, type PoolClient } from 'pg';
import { DemoSessionError } from '../demo-session/demo-session.errors.js';
import { lockDemoAdmission, type DemoAdmissionState } from '../demo-admission/demo-admission.repository.js';
import { applyCapexCutover, lockCutoverConfiguration, requireCutoverQuiescence, verifyCutoverConfiguration } from './demo-cutover.configuration.js';

const unavailable = () => new DemoSessionError('DEMO_CUTOVER_UNAVAILABLE', 503, 'Demo cutover unavailable');
const unknown = () => new DemoSessionError('DEMO_CUTOVER_OUTCOME_UNKNOWN', 503, 'Demo cutover outcome unavailable; confirm durable status before retry');
export interface CutoverOptions {
  beforeCommit?: () => Promise<void>;
  commit?: (client: PoolClient) => Promise<void>;
  recoveryClient?: () => Client;
}
export interface CutoverResult extends DemoAdmissionState { outcome: 'APPLIED' | 'ALREADY_APPLIED'; confirmation: 'COMMITTED' | 'DURABLE_RELOAD' }

async function begin(client: Client | PoolClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='5s'");
}

export class DemoCutoverOperator {
  constructor(private readonly db: Pool, private readonly options: CutoverOptions = {}) {}

  async status() {
    let client: PoolClient | undefined;
    try {
      client = await this.db.connect(); await begin(client);
      const gate = await lockDemoAdmission(client);
      await lockCutoverConfiguration(client, false);
      const configuration = gate.state === 'WORKFLOW_OPEN' ? 'WORKFLOW' : 'LEGACY';
      await verifyCutoverConfiguration(client, configuration);
      await client.query('COMMIT');
      client.release(); client = undefined;
      return { ...gate, configuration };
    } catch (error) { if (error instanceof DemoSessionError) throw error; throw unavailable(); }
    finally { client?.release(true); }
  }

  async cutover(): Promise<CutoverResult> {
    let client: PoolClient | undefined; let commitSent = false;
    let outcome: CutoverResult['outcome'] = 'APPLIED';
    try {
      client = await this.db.connect(); await begin(client);
      const gate = await lockDemoAdmission(client, true);
      await lockCutoverConfiguration(client, true);
      if (gate.state === 'WORKFLOW_OPEN') {
        await verifyCutoverConfiguration(client, 'WORKFLOW');
        outcome = 'ALREADY_APPLIED'; commitSent = true;
        if (this.options.commit) await this.options.commit(client); else await client.query('COMMIT');
        client.release(); client = undefined;
        return { ...gate, outcome: 'ALREADY_APPLIED', confirmation: 'COMMITTED' };
      }
      if (gate.state !== 'DRAINING') throw new DemoSessionError('DEMO_CUTOVER_REQUIRES_DRAIN', 503, 'Demo cutover requires confirmed DRAINING admission');
      await requireCutoverQuiescence(client);
      await verifyCutoverConfiguration(client, 'LEGACY');
      await applyCapexCutover(client);
      await verifyCutoverConfiguration(client, 'WORKFLOW');
      await client.query("UPDATE demo_admission_control SET state='WORKFLOW_OPEN' WHERE id=1");
      const state = await lockDemoAdmission(client, true);
      await this.options.beforeCommit?.(); commitSent = true;
      if (this.options.commit) await this.options.commit(client); else await client.query('COMMIT');
      client.release(); client = undefined;
      return { ...state, outcome: 'APPLIED', confirmation: 'COMMITTED' };
    } catch (error) {
      if (!commitSent) {
        await client?.query('ROLLBACK').catch(() => {}); client?.release(true); client = undefined;
        if (error instanceof DemoSessionError) throw error;
        throw unavailable();
      }
      client?.release(true); client = undefined;
      return this.confirm(outcome);
    } finally { client?.release(true); }
  }

  private async confirm(outcome: CutoverResult['outcome']): Promise<CutoverResult> {
    let recovery: Client | undefined;
    try {
      recovery = this.options.recoveryClient?.() ?? new Client({ ...this.db.options, connectionTimeoutMillis: 3000, query_timeout: 6000 });
      recovery.on('error', () => {}); await recovery.connect(); await begin(recovery);
      const gate = await lockDemoAdmission(recovery, true);
      await lockCutoverConfiguration(recovery, true);
      if (gate.state === 'WORKFLOW_OPEN') {
        await verifyCutoverConfiguration(recovery, 'WORKFLOW'); await recovery.query('COMMIT');
        return { ...gate, outcome, confirmation: 'DURABLE_RELOAD' };
      }
      if (gate.state === 'DRAINING') {
        await verifyCutoverConfiguration(recovery, 'LEGACY'); await recovery.query('COMMIT');
        throw new DemoSessionError('DEMO_CUTOVER_NOT_APPLIED', 503, 'Durable legacy configuration remains drained; explicit cutover retry may recheck preconditions');
      }
      throw unknown();
    } catch (error) {
      if (error instanceof DemoSessionError && error.code === 'DEMO_CUTOVER_NOT_APPLIED') throw error;
      throw unknown();
    } finally { await recovery?.end().catch(() => {}); }
  }
}
