import { Client, type Pool, type PoolClient } from 'pg';
import { DemoSessionError } from '../demo-session/demo-session.errors.js';
import { admissionUnavailable, lockDemoAdmission, type DemoAdmissionState } from './demo-admission.repository.js';

export interface AdmissionOperatorOptions {
  // Trusted test-only transport seams, never CLI input.
  beforeCommit?: () => Promise<void>;
  commit?: (client: PoolClient) => Promise<void>;
  recoveryClient?: () => Client;
}
export interface DrainResult extends DemoAdmissionState { confirmation: 'COMMITTED' | 'DURABLE_RELOAD' }

export class DemoAdmissionOperator {
  constructor(private readonly db: Pool, private readonly options: AdmissionOperatorOptions = {}) {}

  async status(): Promise<DemoAdmissionState> {
    let client: PoolClient | undefined;
    try {
      client = await this.db.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      const state = await lockDemoAdmission(client);
      await client.query('COMMIT');
      return state;
    } catch { throw admissionUnavailable(); }
    finally { client?.release(true); }
  }

  async drain(): Promise<DrainResult> {
    let client: PoolClient | undefined;
    let commitSent = false;
    try {
      client = await this.db.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      const previous = await lockDemoAdmission(client, true);
      if (previous.state === 'LEGACY_OPEN') await client.query("UPDATE demo_admission_control SET state='DRAINING' WHERE id=1");
      const state = await lockDemoAdmission(client, true);
      await this.options.beforeCommit?.();
      commitSent = true;
      if (this.options.commit) await this.options.commit(client); else await client.query('COMMIT');
      client.release(); client = undefined;
      return { ...state, confirmation: 'COMMITTED' };
    } catch {
      // Closing the suspect socket is essential before independent confirmation.
      client?.release(true); client = undefined;
      if (!commitSent) throw admissionUnavailable();
      return this.confirmDrain();
    } finally { client?.release(true); }
  }

  private async confirmDrain(): Promise<DrainResult> {
    let recovery: Client | undefined;
    try {
      recovery = this.options.recoveryClient?.() ?? new Client({
        ...this.db.options, connectionTimeoutMillis: 3000, query_timeout: 6000,
      });
      recovery.on('error', () => {});
      await recovery.connect();
      await recovery.query('BEGIN');
      await recovery.query("SET LOCAL lock_timeout='3s'");
      await recovery.query("SET LOCAL statement_timeout='5s'");
      const state = await lockDemoAdmission(recovery, true);
      await recovery.query('COMMIT');
      if (state.state === 'LEGACY_OPEN') throw new DemoSessionError('DEMO_ADMISSION_DRAIN_NOT_APPLIED', 503, 'Durable Demo admission remains open; retry drain');
      return { ...state, confirmation: 'DURABLE_RELOAD' };
    } catch (error) {
      if (error instanceof DemoSessionError && error.code === 'DEMO_ADMISSION_DRAIN_NOT_APPLIED') throw error;
      throw new DemoSessionError('DEMO_ADMISSION_DRAIN_OUTCOME_UNKNOWN', 503, 'Demo drain outcome unavailable; confirm status on a fresh connection');
    } finally { await recovery?.end().catch(() => {}); }
  }
}
