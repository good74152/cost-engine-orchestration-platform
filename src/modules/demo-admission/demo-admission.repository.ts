import type { PoolClient, Client } from 'pg';
import { DemoSessionError } from '../demo-session/demo-session.errors.js';

export interface DemoAdmissionState { state: 'LEGACY_OPEN' | 'DRAINING' | 'WORKFLOW_OPEN'; updatedAt: string }
export const admissionUnavailable = () => new DemoSessionError('DEMO_ADMISSION_UNAVAILABLE', 503, 'Demo admission unavailable');

/** Caller owns a READ COMMITTED transaction; always lock BEFORE capacity/session locks. */
export async function lockDemoAdmission(client: PoolClient | Client, exclusive = false): Promise<DemoAdmissionState> {
  try {
    const locked = await client.query(`SELECT id FROM demo_admission_control WHERE id=1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`);
    if (locked.rowCount !== 1) throw admissionUnavailable();
    // Fresh statement after the wait, never an old MVCC snapshot of the gate.
    const row = (await client.query<{ state: string; updated_at: Date }>(
      'SELECT state,updated_at FROM demo_admission_control WHERE id=1')).rows[0];
    if (!row || !['LEGACY_OPEN', 'DRAINING', 'WORKFLOW_OPEN'].includes(row.state) || !(row.updated_at instanceof Date)) throw admissionUnavailable();
    return { state: row.state as DemoAdmissionState['state'], updatedAt: row.updated_at.toISOString() };
  } catch { throw admissionUnavailable(); }
}

export function assertLegacyAdmission(state: DemoAdmissionState): void {
  if (state.state === 'WORKFLOW_OPEN') throw new DemoSessionError('DEMO_LEGACY_ADMISSION_CLOSED', 503, 'New legacy Scenarios are closed');
  if (state.state !== 'LEGACY_OPEN') throw new DemoSessionError('DEMO_ADMISSION_DRAINING', 503, 'New legacy Demo admission is closed');
}

export function assertSessionAdmission(state: DemoAdmissionState): void {
  if (state.state === 'DRAINING') throw new DemoSessionError('DEMO_ADMISSION_DRAINING', 503, 'New legacy Demo admission is closed');
}
