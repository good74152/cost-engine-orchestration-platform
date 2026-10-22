import type { AuthenticatedDemoSession, DemoSessionService } from './demo-session.service.js';
import { DemoSessionQueueFullError } from './demo-session.errors.js';

interface Queue { tail: Promise<void>; size: number }

/** One instance per backend. Not distributed coordination or a SQL lock replacement. */
export class DemoSessionCoordinator {
  private readonly queues = new Map<string, Queue>();
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

  async run<T>(session: AuthenticatedDemoSession, body: () => Promise<T>): Promise<T> {
    // Synchronous trusted-context check preserves enqueue order, without DB I/O.
    // Durable eligibility is checked at execution, not before a possibly long wait.
    this.sessions.assertTrusted(session);
    let queue = this.queues.get(session.sessionId);
    if (queue ? queue.size >= this.maxOperations : this.queues.size >= this.maxSessions) {
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
