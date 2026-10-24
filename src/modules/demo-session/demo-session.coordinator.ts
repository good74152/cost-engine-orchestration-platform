import type { AuthenticatedDemoSession, DemoSessionService } from './demo-session.service.js';
import { DemoSessionError, DemoSessionQueueFullError } from './demo-session.errors.js';

interface Queue { tail: Promise<void>; size: number }
export interface ResetReservation { readonly sessionId: string; unknown: boolean }

/** One instance per backend. Not distributed coordination or a SQL lock replacement. */
export class DemoSessionCoordinator {
  private readonly queues = new Map<string, Queue>();
  private readonly resets = new Map<string, ResetReservation>();
  constructor(
    private readonly sessions: DemoSessionService,
    private readonly maxOperations = 32,
    private readonly maxSessions = 1024,
  ) {
    if (![maxOperations, maxSessions].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('Session queue limits must be positive integers');
    }
  }

  get activeSessionCount(): number { return this.queues.size; }

  private assertNotResetting(id: string): void {
    const reset = this.resets.get(id);
    if (reset) throw new DemoSessionError(reset.unknown ? 'DEMO_RESET_OUTCOME_UNKNOWN' : 'RESET_CONFLICT',
      reset.unknown ? 503 : 409, reset.unknown ? 'Demo reset outcome unavailable' : 'Demo reset conflict');
  }

  tryBeginReset(session: AuthenticatedDemoSession): ResetReservation {
    this.sessions.assertTrusted(session);
    return this.reserveCleanup(session.sessionId);
  }

  /** Internal maintenance only: caller must recheck inactive eligibility under SQL lock. */
  reserveCleanup(sessionId: string): ResetReservation {
    // This entire check/reservation is synchronous. Reset never joins the queue.
    this.assertNotResetting(sessionId);
    if (this.queues.has(sessionId)) throw new DemoSessionError('RESET_CONFLICT', 409, 'Demo reset conflict');
    if (this.queues.size + this.resets.size >= this.maxSessions) {
      throw new DemoSessionError('RESET_CONFLICT', 409, 'Demo reset conflict');
    }
    const reservation = { sessionId, unknown: false };
    this.resets.set(sessionId, reservation);
    return reservation;
  }

  finishReset(reservation: ResetReservation): void {
    if (this.resets.get(reservation.sessionId) !== reservation) throw new Error('Invalid reset reservation');
    this.resets.delete(reservation.sessionId);
  }

  async run<T>(session: AuthenticatedDemoSession, body: () => Promise<T>): Promise<T> {
    // Synchronous trusted-context check preserves enqueue order, without DB I/O.
    // Durable eligibility is checked at execution, not before a possibly long wait.
    this.sessions.assertTrusted(session);
    this.assertNotResetting(session.sessionId);
    let queue = this.queues.get(session.sessionId);
    if (queue ? queue.size >= this.maxOperations : this.queues.size + this.resets.size >= this.maxSessions) {
      throw new DemoSessionQueueFullError();
    }
    if (!queue) {
      queue = { tail: Promise.resolve(), size: 0 };
      this.queues.set(session.sessionId, queue);
    }
    const previous = queue.tail;
    const current = queue;
    current.size += 1;
    const operation = previous.then(async () => {
      await this.sessions.revalidate(session);
      return body();
    });
    current.tail = operation.then(() => {}, () => {});
    try { return await operation; }
    finally {
      current.size -= 1;
      if (current.size === 0) this.queues.delete(session.sessionId);
    }
  }
}
