import type { Pool } from 'pg';
import { isApprovedFakeExecutorEnvironment } from '../../executors/executor-factory.js';
import { FakeExecutor } from '../../executors/fake-executor.js';
import { DemoSessionCoordinator } from './demo-session.coordinator.js';
import { DemoSessionError } from './demo-session.errors.js';
import { DemoOwnershipValidator } from './demo-session.ownership.js';
import { DemoSessionService, type AuthenticatedDemoSession } from './demo-session.service.js';
import { DemoSessionResetService, type ResetOptions } from './demo-session-reset.service.js';
import { DemoScenarioService, type ScenarioCreateOptions } from '../demo-scenario/demo-scenario.service.js';
import { DemoStepService, type StepOptions } from '../demo-scenario/demo-step.service.js';

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
  hasSession(sessionId: string): boolean { return this.instances.has(sessionId); }

  async forSession(session: AuthenticatedDemoSession): Promise<FakeExecutor> {
    // Also guards a previously authenticated context retained after revocation.
    await this.sessions.revalidate(session);
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

  sessionIds(): readonly string[] { return [...this.instances.keys()]; }

  /** Called only after durable reset commit or confirmed inactive eligibility. */
  releaseSession(sessionId: string): void { this.instances.delete(sessionId); }
}

/** One runtime per application, never a module-global fake or session queue. */
export class DemoRuntime {
  readonly sessions: DemoSessionService;
  readonly coordinator: DemoSessionCoordinator;
  readonly ownership: DemoOwnershipValidator;
  readonly executors: DemoExecutorRegistry;
  readonly reset: DemoSessionResetService;
  readonly scenarios: DemoScenarioService;
  readonly steps: DemoStepService;

  constructor(readonly db: Pool, nodeEnvironment?: string, options: RegistryOptions = {}, resetOptions: ResetOptions = {}, scenarioOptions: ScenarioCreateOptions = {}, stepOptions: StepOptions = {}) {
    assertDemoEnvironment(nodeEnvironment);
    this.sessions = new DemoSessionService(db);
    this.coordinator = new DemoSessionCoordinator(this.sessions);
    this.ownership = new DemoOwnershipValidator(db, this.sessions);
    this.executors = new DemoExecutorRegistry(this.sessions, options);
    this.reset = new DemoSessionResetService(this, resetOptions);
    this.scenarios = new DemoScenarioService(db, this.sessions, this.executors, scenarioOptions);
    this.steps = new DemoStepService(this, stepOptions);
  }
}
