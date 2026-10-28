import type { CalculationExecutor, DispatchCalculationCommand, ExecutionIdentity } from '../../executors/calculation-executor.js';
import { FakeExecutor, type FakeRunSimulation, type FakeSimulationDecision } from '../../executors/fake-executor.js';
import { DemoSessionError } from './demo-session.errors.js';
import { exactDemoBody } from './demo-http-security.js';

export function parseRunSimulation(body: unknown): FakeRunSimulation | undefined {
  if (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0) return undefined;
  const { simulation } = exactDemoBody(body, ['simulation']);
  const invalid = () => new DemoSessionError('INVALID_REQUEST', 400, 'Invalid simulation');
  if (typeof simulation !== 'object' || simulation === null || Array.isArray(simulation)) throw invalid();
  const dispatch = (simulation as Record<string, unknown>).dispatch;
  if (dispatch === 'ACCEPT' || dispatch === 'ACCEPT_THEN_UNKNOWN') {
    const { completion } = exactDemoBody(simulation, ['dispatch', 'completion']);
    if (completion !== 'RUNNING' && completion !== 'SUCCEEDED' && completion !== 'FAILED') throw invalid();
    return Object.freeze({ dispatch, completion });
  }
  if (dispatch === 'REJECT' || dispatch === 'UNKNOWN_WITHOUT_CREATION') {
    exactDemoBody(simulation, ['dispatch']);
    return Object.freeze({ dispatch });
  }
  throw invalid();
}

export interface SimulationReport {
  requested: FakeRunSimulation;
  applied: FakeRunSimulation | null;
  application: 'APPLIED' | 'EXISTING' | 'UNBOUND' | 'UNKNOWN';
}

/** Per-request adapter; every dispatch/lookup uses the SAME Session fake. */
export class RequestScopedFakeExecutor implements CalculationExecutor {
  private readonly decisions = new Set<FakeSimulationDecision>();
  private readonly releases = new Set<() => void>();
  constructor(private readonly delegate: FakeExecutor, private readonly requested: FakeRunSimulation) {}

  async dispatch(command: DispatchCalculationCommand) {
    const observation = await this.delegate.dispatchWithSimulation(command, this.requested);
    this.releases.add(observation.finish);
    if (observation.applied && observation.decision) this.decisions.add(observation.decision);
    return observation.result;
  }

  getExecutionStatus(identity: ExecutionIdentity) { return this.delegate.getExecutionStatus(identity); }

  report(identity: ExecutionIdentity): SimulationReport {
    const actual = this.delegate.simulationInfo(identity);
    if (actual.kind === 'UNBOUND') return { requested: this.requested, applied: null, application: 'UNBOUND' };
    if (!actual.decision) return { requested: this.requested, applied: null, application: 'UNKNOWN' };
    return { requested: this.requested, applied: actual.decision.simulation,
      application: this.decisions.has(actual.decision) ? 'APPLIED' : 'EXISTING' };
  }

  finish(): void {
    for (const release of this.releases) release();
    this.releases.clear();
  }
}
