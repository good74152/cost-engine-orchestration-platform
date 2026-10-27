import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DemoSessionError, DemoSessionUnavailableError } from './demo-session.errors.js';

export const SESSION_LIFETIME_SECONDS = 4 * 60 * 60;
export const SECURE_SESSION_COOKIE = '__Host-ce_demo_session';
export const LOCAL_SESSION_COOKIE = 'ce_demo_session';
const trustedContext: unique symbol = Symbol('AuthenticatedDemoSession');
export interface AuthenticatedDemoSession {
  readonly [trustedContext]: true;
  readonly sessionId: string;
  readonly companyCode: string;
  readonly expiresAt: string;
  readonly status: 'ACTIVE';
}

interface SessionRow { id: string; company_code: string; expires_at: Date }
interface Candidate { id: string; token: Buffer; companyCode: string }
export interface DemoSessionServiceOptions {
  // Dependency seams for deterministic tests; never derived from HTTP input.
  candidate?: () => Candidate;
  now?: () => Promise<Date>;
  capacity?: { active: number; retained: number };
}

export function readSessionCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const values = header.split(';').map((part) => part.trim())
    .filter((part) => part.split('=', 1)[0] === name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new DemoSessionUnavailableError();
  const token = values[0]!.slice(name.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)
    || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new DemoSessionUnavailableError();
  }
  return token;
}

/** Raw bearers live only in cookie handling; contexts hold no credential/hash. */
export class DemoSessionService {
  private readonly contexts = new WeakSet<object>();
  constructor(private readonly db: Pool, private readonly options: DemoSessionServiceOptions = {}) {}

  private context(row: SessionRow): AuthenticatedDemoSession {
    const context: AuthenticatedDemoSession = Object.freeze({
      [trustedContext]: true as const,
      sessionId: row.id, companyCode: row.company_code,
      expiresAt: row.expires_at.toISOString(), status: 'ACTIVE' as const,
    });
    this.contexts.add(context);
    return context;
  }

  private async time(): Promise<Date | null> {
    return this.options.now ? this.options.now() : null;
  }

  async create(): Promise<{ session: AuthenticatedDemoSession; token: string }> {
    if (!this.options.capacity) return this.allocate(this.db);
    const client = await this.db.connect();
    let commitSent = false;
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      // Admission only: serialize capacity checks and insert in one transaction.
      // Core version allocation/row-lock protocols are not involved.
      await client.query('LOCK TABLE demo_sessions IN SHARE ROW EXCLUSIVE MODE');
      const counts = (await client.query<{ active: number; retained: number }>(`SELECT count(*)::int AS retained,
        count(*) FILTER (WHERE revoked_at IS NULL AND expires_at>clock_timestamp())::int AS active FROM demo_sessions`)).rows[0]!;
      if (counts.active >= this.options.capacity.active || counts.retained >= this.options.capacity.retained) {
        throw new DemoSessionError('DEMO_SESSION_CAPACITY_REACHED', 503, 'Demo session capacity reached');
      }
      const created = await this.allocate(client);
      commitSent = true;
      await client.query('COMMIT');
      return created;
    } catch (error) {
      discard = true;
      if (!commitSent) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof DemoSessionError) throw error;
      throw new Error('Demo session persistence failed');
    } finally { client.release(discard); }
  }

  private async allocate(db: Pool | PoolClient): Promise<{ session: AuthenticatedDemoSession; token: string }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = this.options.candidate?.() ?? {
        id: randomUUID(), token: randomBytes(32),
        companyCode: `DEMO_${randomBytes(8).toString('hex').slice(0, 15).toUpperCase()}`,
      };
      if (candidate.token.length !== 32) throw new Error('Invalid session candidate');
      const hash = createHash('sha256').update(candidate.token).digest();
      try {
        // The caller returns a cookie only after autocommit/the admission COMMIT.
        const result = await db.query<SessionRow>(
          // Match the millisecond precision of the public ISO timestamp exactly.
          `WITH instant AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS now)
           INSERT INTO demo_sessions (id, company_code, token_hash, created_at, expires_at)
           SELECT $1, $2, $3, now, now + INTERVAL '4 hours' FROM instant
           WHERE NOT EXISTS (SELECT 1 FROM dataset_series WHERE company_code = $2::varchar)
           ON CONFLICT DO NOTHING
           RETURNING id, company_code, expires_at`,
          [candidate.id, candidate.companyCode, hash],
        );
        // Existing datasets must never become owned by a newly allocated session.
        // Unique session collisions also consume a candidate without insertion. This
        // statement assumes the approved single Demo backend/no external writer.
        const row = result.rows[0];
        if (!row) continue;
        return { session: this.context(row), token: candidate.token.toString('base64url') };
      } catch (error: unknown) {
        const pg = error as { code?: string; constraint?: string } | null;
        if (pg?.code === '23505' && [
          'demo_sessions_pkey', 'uq_demo_sessions_company_code', 'uq_demo_sessions_token_hash',
        ].includes(pg.constraint ?? '')) continue;
        // PostgreSQL errors can contain credential hashes in detail/bindings.
        throw new Error('Demo session persistence failed');
      }
    }
    throw new Error('Demo session allocation exhausted');
  }

  async authenticate(cookie: string | undefined, name: string): Promise<AuthenticatedDemoSession> {
    const token = readSessionCookie(cookie, name);
    if (!token) throw new DemoSessionUnavailableError();
    const hash = createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
    const now = await this.time();
    try {
      const result = await this.db.query<SessionRow>(
        `SELECT id, company_code, expires_at FROM demo_sessions
         WHERE token_hash = $1 AND revoked_at IS NULL
           AND expires_at > COALESCE($2::timestamptz, clock_timestamp())`, [hash, now],
      );
      if (!result.rows[0]) throw new DemoSessionUnavailableError();
      return this.context(result.rows[0]);
    } catch (error) {
      if (error instanceof DemoSessionUnavailableError) throw error;
      throw new Error('Demo session authentication failed');
    }
  }

  assertTrusted(session: AuthenticatedDemoSession): void {
    if (!this.contexts.has(session)) throw new DemoSessionUnavailableError();
  }

  async revalidate(session: AuthenticatedDemoSession): Promise<void> {
    this.assertTrusted(session);
    const result = await this.db.query(
      `SELECT id FROM demo_sessions WHERE id = $1 AND company_code = $2
       AND revoked_at IS NULL AND expires_at > COALESCE($3::timestamptz, clock_timestamp())`,
      [session.sessionId, session.companyCode, await this.time()],
    );
    if (result.rows.length !== 1) throw new DemoSessionUnavailableError();
  }

  /** Internal trusted service boundary; deliberately no public revoke route. */
  async revoke(sessionId: string): Promise<void> {
    await this.db.query(`UPDATE demo_sessions
      SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE id = $1`, [sessionId]);
  }
}

export function publicSession(session: AuthenticatedDemoSession) {
  return { sessionId: session.sessionId, companyCode: session.companyCode,
    expiresAt: session.expiresAt, status: session.status };
}
