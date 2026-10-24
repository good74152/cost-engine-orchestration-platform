import { Client, type PoolClient } from 'pg';
import type { DemoRuntime } from './demo-runtime.js';
import type { ResetReservation } from './demo-session.coordinator.js';
import type { AuthenticatedDemoSession } from './demo-session.service.js';
import { DemoSessionError, DemoSessionUnavailableError } from './demo-session.errors.js';
import { DemoCleanupIntegrityError, deleteOwnedDemoData } from './demo-session-cleanup.repository.js';

export type DemoLog = (event: string, sessionId?: string, details?: Record<string, number>) => void;
export interface ResetOptions {
  log?: DemoLog;
  // Transport/barrier seams for deterministic tests; no HTTP input controls these.
  beforeCommit?: () => Promise<void>;
  commit?: (client: PoolClient) => Promise<void>;
  recoveryClient?: () => Client;
}
interface Pending { reservation: ResetReservation; inactive: boolean; resolving?: Promise<'committed' | 'rolled-back' | 'unknown'> }
const failed = () => new DemoSessionError('DEMO_RESET_FAILED', 500, 'Demo reset failed');
const unknown = () => new DemoSessionError('DEMO_RESET_OUTCOME_UNKNOWN', 503, 'Demo reset outcome unavailable');

export class DemoSessionResetService {
  private readonly pending = new Map<string, Pending>();
  private log: DemoLog;
  constructor(private readonly runtime: DemoRuntime, private readonly options: ResetOptions = {}) {
    this.log = options.log ?? ((event, sessionId, details) => console.info(JSON.stringify({ event, sessionId, ...details })));
  }

  setLogger(log: DemoLog): void { if (!this.options.log) this.log = log; }

  private releaseFake(id: string): void {
    try { this.runtime.executors.releaseSession(id); }
    catch { this.log('demo_fake_cleanup_failed', id); }
  }

  private finish(reservation: ResetReservation, committed: boolean): void {
    if (committed) this.releaseFake(reservation.sessionId);
    this.pending.delete(reservation.sessionId);
    this.runtime.coordinator.finishReset(reservation);
    this.log(committed ? 'demo_reset_committed' : 'demo_reset_rolled_back', reservation.sessionId);
  }

  async reset(session: AuthenticatedDemoSession): Promise<void> {
    let reservation: ResetReservation;
    try { reservation = this.runtime.coordinator.tryBeginReset(session); }
    catch (error) { this.log('demo_reset_conflict', session.sessionId); throw error; }
    this.log('demo_reset_started', session.sessionId);
    await this.clean(reservation, session);
  }

  private async clean(reservation: ResetReservation, session?: AuthenticatedDemoSession): Promise<void> {
    const id = reservation.sessionId;
    let client: PoolClient | undefined;
    let commitSent = false;
    try {
      client = await this.runtime.db.connect();
      await client.query('BEGIN');
      await client.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [id]);
      const result = await client.query<{ company_code: string; available: boolean }>(`SELECT company_code,
        revoked_at IS NULL AND expires_at>clock_timestamp() AS available
        FROM demo_sessions WHERE id=$1`, [id]);
      const row = result.rows[0];
      if (!row || (session ? !row.available || row.company_code !== session.companyCode : row.available)) {
        throw new DemoSessionUnavailableError();
      }
      await deleteOwnedDemoData(client, row.company_code, id);
      await client.query(`UPDATE demo_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1`, [id]);
      await this.options.beforeCommit?.();
      commitSent = true;
      if (this.options.commit) await this.options.commit(client);
      else await client.query('COMMIT');
      client.release(); client = undefined;
      this.finish(reservation, true);
    } catch (error) {
      if (error instanceof DemoCleanupIntegrityError || (error as { code?: string })?.code === '23503') {
        this.log('demo_reset_integrity_conflict', id);
      }
      if (!commitSent) {
        let rolledBack = !client;
        if (client) {
          try { await client.query('ROLLBACK'); rolledBack = true; } catch { /* Resolve on a fresh connection below. */ }
        }
        client?.release(true); client = undefined;
        if (rolledBack) {
          this.finish(reservation, false);
          if (error instanceof DemoSessionUnavailableError) throw error;
          throw failed();
        }
      }
      // Never return a suspect COMMIT connection to the pool or infer rollback
      // from a network exception. Destroy it before fresh-connection resolution.
      client?.release(true); client = undefined;
      reservation.unknown = true;
      const pending = { reservation, inactive: session === undefined };
      this.pending.set(id, pending);
      this.log('demo_reset_commit_unknown', id);
      const outcome = await this.resolve(pending);
      if (outcome === 'unknown') throw unknown();
      if (outcome === 'rolled-back') throw failed();
    }
  }

  private resolve(pending: Pending): Promise<'committed' | 'rolled-back' | 'unknown'> {
    // Controlled maintenance may retry, but two resolvers must not finish a lease twice.
    if (pending.resolving) return pending.resolving;
    pending.resolving = this.readOutcome(pending).finally(() => { delete pending.resolving; });
    return pending.resolving;
  }

  private async readOutcome(pending: Pending): Promise<'committed' | 'rolled-back' | 'unknown'> {
    let recovery: Client | undefined;
    try {
      // A genuinely separate connection, not another query on the suspect socket.
      recovery = this.options.recoveryClient?.() ?? new Client({
        ...this.runtime.db.options, connectionTimeoutMillis: 3000, query_timeout: 3500,
      });
      recovery.on('error', () => {});
      await recovery.connect();
      await recovery.query('BEGIN');
      await recovery.query("SET LOCAL lock_timeout='2s'");
      await recovery.query("SET LOCAL statement_timeout='3s'");
      const result = await recovery.query<{ revoked: boolean; company_code: string }>(`SELECT
        revoked_at IS NOT NULL AS revoked, company_code
        FROM demo_sessions WHERE id=$1 FOR UPDATE`, [pending.reservation.sessionId]);
      // A separate READ COMMITTED statement gets a fresh snapshot AFTER acquiring
      // the lock. A subquery in the waiting SELECT could see pre-commit children.
      const row = result.rows[0];
      const remaining = row && (await recovery.query<{ remaining: boolean }>(`SELECT
        EXISTS (SELECT 1 FROM dataset_series WHERE company_code=$1)
        OR EXISTS (SELECT 1 FROM demo_scenario_instances WHERE session_id=$2) AS remaining`,
      [row.company_code, pending.reservation.sessionId])).rows[0]!.remaining;
      await recovery.query('COMMIT');
      if (!row || (row.revoked && remaining && !pending.inactive)) return 'unknown';
      const committed = row.revoked && !remaining;
      this.finish(pending.reservation, committed);
      return committed ? 'committed' : 'rolled-back';
    } catch { return 'unknown'; }
    finally { await recovery?.end().catch(() => {}); }
  }

  /** Trusted operator/startup entry points, deliberately not public HTTP APIs. */
  async recoverPendingResets(limit = 50): Promise<number> {
    this.assertBatchSize(limit);
    for (const entry of [...this.pending.values()].slice(0, limit)) await this.resolve(entry);
    return this.pending.size;
  }

  async cleanupInactiveSession(id: string): Promise<void> {
    const reservation = this.runtime.coordinator.reserveCleanup(id);
    try { await this.clean(reservation); }
    catch (error) { this.log('demo_old_session_cleanup_failed', id); throw error; }
  }

  async maintainInactiveSessions(limit = 50): Promise<{ cleaned: number; failed: number; pending: number }> {
    this.assertBatchSize(limit);
    await this.recoverPendingResets(limit);
    const registryIds = this.runtime.executors.sessionIds();
    const candidates = await this.runtime.db.query<{ id: string }>(`SELECT s.id FROM demo_sessions s
      WHERE (revoked_at IS NOT NULL OR expires_at<=clock_timestamp()) AND
      (EXISTS (SELECT 1 FROM dataset_series ds WHERE ds.company_code=s.company_code)
       OR EXISTS (SELECT 1 FROM demo_scenario_instances scenario WHERE scenario.session_id=s.id) OR s.id=ANY($1::uuid[]))
      AND NOT (s.id=ANY($3::uuid[])) ORDER BY created_at,id LIMIT $2`, [registryIds, limit, [...this.pending.keys()]]);
    let cleaned = 0; let failedCount = 0;
    for (const row of candidates.rows) {
      try { await this.cleanupInactiveSession(row.id); cleaned++; } catch { failedCount++; }
    }
    const remaining = await this.runtime.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM demo_sessions s
      WHERE s.id=ANY($2::uuid[]) OR ((revoked_at IS NOT NULL OR expires_at<=clock_timestamp()) AND
      (EXISTS (SELECT 1 FROM dataset_series ds WHERE ds.company_code=s.company_code)
       OR EXISTS (SELECT 1 FROM demo_scenario_instances scenario WHERE scenario.session_id=s.id) OR s.id=ANY($1::uuid[])))`,
    [this.runtime.executors.sessionIds(), [...this.pending.keys()]]);
    const result = { cleaned, failed: failedCount, pending: remaining.rows[0]!.n };
    this.log('demo_old_session_cleanup_batch', undefined, result);
    return result;
  }

  private assertBatchSize(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid cleanup batch size');
  }

  /** Invoke only on real Demo process startup, before listening, not buildApp. */
  async startServer(): Promise<void> {
    // One autocommit statement; acknowledgement is required before HTTP admission.
    // Unknown invalidation outcomes fail startup closed, never guess readiness.
    try {
      const result = await this.runtime.db.query(`UPDATE demo_sessions SET revoked_at=clock_timestamp()
        WHERE revoked_at IS NULL`);
      this.log('demo_startup_session_invalidation', undefined, { revoked: result.rowCount ?? 0 });
    } catch {
      this.log('demo_startup_session_invalidation_failed');
      throw new Error('Demo startup session invalidation failed');
    }
    try { await this.maintainInactiveSessions(); }
    catch { this.log('demo_old_session_cleanup_failed'); }
  }
}
