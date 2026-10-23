import type { Pool } from 'pg';
import { isApprovedFakeExecutorEnvironment } from '../../executors/executor-factory.js';
import { FakeExecutor } from '../../executors/fake-executor.js';
import { DemoSessionCoordinator } from './demo-session.coordinator.js';
import { DemoSessionError } from './demo-session.errors.js';
import { DemoOwnershipValidator } from './demo-session.ownership.js';
import { DemoSessionService, type AuthenticatedDemoSession } from './demo-session.service.js';

export function assertDemoEnvironment(nodeEnvironment?: string): void {
  if (!isApprovedFakeExecutorEnvironment(nodeEnvironment)) {
    throw new Error('Demo FakeExecutor requires development/test and cannot run in production');
  }
  if (process.env.EXECUTOR_TYPE !== undefined && process.env.EXECUTOR_TYPE.toLowerCase() !== 'fake') {
    throw new Error('Demo runtime only supports explicitly selected FakeExecutor');
  }
}

interface RegistryOptions {
  createExecutor?: () => FakeExecutor;
  maxExecutors?: number;
}

export class DemoExecutorRegistry {
  private readonly instances = new Map<string, FakeExecutor>();
  private readonly assigned = new WeakSet<FakeExecutor>();
  private readonly capacity: number;

  constructor(private readonly sessions: DemoSessionService, private readonly options: RegistryOptions = {}) {
    this.capacity = options.maxExecutors ?? 1024;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new Error('Invalid executor registry capacity');
  }

  get size(): number { return this.instances.size; }

  forSession(session: AuthenticatedDemoSession): FakeExecutor {
    this.sessions.assertTrusted(session);
    const existing = this.instances.get(session.sessionId);
    if (existing) return existing;
    if (this.instances.size >= this.capacity) {
      throw new DemoSessionError('DEMO_EXECUTOR_CAPACITY_REACHED', 503, 'Demo executor capacity reached');
    }
    const executor = this.options.createExecutor?.() ?? new FakeExecutor();
    if (!(executor instanceof FakeExecutor) || this.assigned.has(executor)) {
      throw new Error('Each demo session must receive a distinct FakeExecutor');
    }
    this.assigned.add(executor);
    this.instances.set(session.sessionId, executor);
    return executor;
  }
}

/** One runtime per application, never a module-global fake or session queue. */
export class DemoRuntime {
  readonly sessions: DemoSessionService;
  readonly coordinator: DemoSessionCoordinator;
  readonly ownership: DemoOwnershipValidator;
  readonly executors: DemoExecutorRegistry;

  constructor(readonly db: Pool, nodeEnvironment?: string, options: RegistryOptions = {}) {
    assertDemoEnvironment(nodeEnvironment);
    this.sessions = new DemoSessionService(db);
    this.coordinator = new DemoSessionCoordinator(this.sessions);
    this.ownership = new DemoOwnershipValidator(db, this.sessions);
    this.executors = new DemoExecutorRegistry(this.sessions, options);
  }
}
