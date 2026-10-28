import type {
  CalculationExecutor,
  DispatchCalculationCommand,
  DispatchResult,
  ExecutionIdentity,
  ExecutorExecutionStatus,
} from './calculation-executor.js';

export type FakeDispatchBehavior =
  | 'ACCEPT'
  | 'REJECT'
  | 'ACCEPT_THEN_UNKNOWN'
  | 'UNKNOWN_WITHOUT_CREATION';

export interface FakeExternalExecution {
  airflowDagId: string;
  airflowDagRunId: string;
  command: DispatchCalculationCommand;
  state: FakeExecutionState;
}

export type FakeExecutionState = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export type FakeRunSimulation =
  | { readonly dispatch: 'ACCEPT' | 'ACCEPT_THEN_UNKNOWN'; readonly completion: FakeExecutionState }
  | { readonly dispatch: 'REJECT' | 'UNKNOWN_WITHOUT_CREATION' };

/** In-memory creation/rejection fact, not operation history or current live state. */
export interface FakeSimulationDecision { readonly simulation: FakeRunSimulation }
export type FakeSimulationInfo =
  | { kind: 'UNBOUND' }
  | { kind: 'BOUND'; decision: FakeSimulationDecision | null };
export interface FakeSimulatedDispatch {
  result: DispatchResult;
  decision: FakeSimulationDecision | null;
  applied: boolean;
  /** Release after the calling Core Run has recorded its outcome (or failed). */
  finish: () => void;
}

export interface FakeExecutorOptions {
  defaultBehavior?: FakeDispatchBehavior;
  scriptedBehaviors?: FakeDispatchBehavior[];
}

function executionKey(identity: ExecutionIdentity): string {
  return `${identity.airflowDagId}\u0000${identity.airflowDagRunId}`;
}

export class FakeExecutor implements CalculationExecutor {
  private readonly externalExecutions = new Map<string, FakeExternalExecution>();
  // ADR-0008: instance-lifetime test/demo state only, not persisted or shared
  // across processes/instances. A real adapter must independently prove no-run.
  private readonly rejectedIdentities = new Set<string>();
  private readonly simulationDecisions = new Map<string, FakeSimulationDecision>();
  private readonly pendingUnboundOutcomes = new Map<string, number>();
  private readonly dispatchHistory: DispatchCalculationCommand[] = [];
  private readonly statusLookupHistory: ExecutionIdentity[] = [];
  private readonly scriptedBehaviors: FakeDispatchBehavior[];
  private defaultBehavior: FakeDispatchBehavior;
  private statusLookupUnavailableMessage: string | null = null;

  constructor(options: FakeExecutorOptions = {}) {
    this.defaultBehavior = options.defaultBehavior ?? 'ACCEPT';
    this.scriptedBehaviors = [...(options.scriptedBehaviors ?? [])];
  }

  setDefaultBehavior(behavior: FakeDispatchBehavior): void {
    this.defaultBehavior = behavior;
  }

  enqueueBehaviors(...behaviors: FakeDispatchBehavior[]): void {
    this.scriptedBehaviors.push(...behaviors);
  }

  getDispatchHistory(): readonly DispatchCalculationCommand[] {
    return this.dispatchHistory;
  }

  getExternalExecutions(): readonly FakeExternalExecution[] {
    return [...this.externalExecutions.values()];
  }

  getStatusLookupHistory(): readonly ExecutionIdentity[] {
    return this.statusLookupHistory;
  }

  setStatusLookupUnavailable(message: string): void {
    this.statusLookupUnavailableMessage = message;
  }

  clearStatusLookupUnavailable(): void {
    this.statusLookupUnavailableMessage = null;
  }

  setExecutionState(
    identity: ExecutionIdentity,
    state: FakeExecutionState,
  ): boolean {
    const execution = this.externalExecutions.get(executionKey(identity));
    if (!execution) {
      return false;
    }
    execution.state = state;
    return true;
  }

  setExecutionStateByDagRunId(
    airflowDagRunId: string,
    state: FakeExecutionState,
  ): FakeExternalExecution | null {
    const matches = [...this.externalExecutions.values()].filter(
      (execution) => execution.airflowDagRunId === airflowDagRunId,
    );
    if (matches.length !== 1) {
      return null;
    }
    matches[0]!.state = state;
    return matches[0]!;
  }

  async dispatch(command: DispatchCalculationCommand): Promise<DispatchResult> {
    return this.decideDispatch(command).result;
  }

  /** Explicit behavior bypasses the shared queue/default; identity checks are shared. */
  async dispatchWithSimulation(command: DispatchCalculationCommand, simulation: FakeRunSimulation): Promise<FakeSimulatedDispatch> {
    return this.decideDispatch(command, simulation);
  }

  simulationInfo(identity: ExecutionIdentity): FakeSimulationInfo {
    const key = executionKey(identity);
    return this.externalExecutions.has(key) || this.rejectedIdentities.has(key)
      ? { kind: 'BOUND', decision: this.simulationDecisions.get(key) ?? null }
      : { kind: 'UNBOUND' };
  }

  private decideDispatch(command: DispatchCalculationCommand, simulation?: FakeRunSimulation): FakeSimulatedDispatch {
    this.dispatchHistory.push(command);
    const key = executionKey(command);
    const observed = (result: DispatchResult, applied = false): FakeSimulatedDispatch => ({
      result, decision: this.simulationDecisions.get(key) ?? null, applied, finish() {},
    });
    const bind = () => {
      if (!simulation) return;
      const copy: FakeRunSimulation = 'completion' in simulation
        ? Object.freeze({ dispatch: simulation.dispatch, completion: simulation.completion })
        : Object.freeze({ dispatch: simulation.dispatch });
      this.simulationDecisions.set(key, Object.freeze({ simulation: copy }));
    };
    const unbound = (message: string): FakeSimulatedDispatch => {
      const outcome = observed({ kind: 'UNKNOWN', message });
      if (!simulation) return outcome; // Legacy calls are exclusively admitted.
      this.pendingUnboundOutcomes.set(key, (this.pendingUnboundOutcomes.get(key) ?? 0) + 1);
      let finished = false;
      outcome.finish = () => {
        if (finished) return;
        finished = true;
        const remaining = this.pendingUnboundOutcomes.get(key)! - 1;
        if (remaining) this.pendingUnboundOutcomes.set(key, remaining);
        else this.pendingUnboundOutcomes.delete(key);
      };
      return outcome;
    };
    // Keep checks and identity decision synchronous (no await): concurrent
    // dispatches on this instance cannot both decide an unseen identity.
    if (this.externalExecutions.has(key)) {
      return observed({ kind: 'ALREADY_EXISTS' });
    }
    if (this.rejectedIdentities.has(key)) {
      return observed({
        kind: 'REJECTED',
        message: 'Fake executor rejected dispatch',
      });
    }

    const behavior = simulation?.dispatch ?? this.scriptedBehaviors.shift() ?? this.defaultBehavior;
    if (behavior === 'REJECT') {
      // A late no-run UNKNOWN must not be recorded after DISPATCH_FAILED. Do
      // not make an irrevocable identity decision while such a Core call is
      // still recording. Creation/recovery remains allowed for this identity.
      if (this.pendingUnboundOutcomes.has(key)) return unbound('Fake rejection deferred while an earlier ambiguous dispatch is recording');
      this.rejectedIdentities.add(key);
      bind();
      return observed({
        kind: 'REJECTED',
        message: 'Fake executor rejected dispatch',
      }, simulation !== undefined);
    }
    if (behavior === 'UNKNOWN_WITHOUT_CREATION') {
      return unbound('Fake executor returned an ambiguous result without creating a run');
    }

    this.externalExecutions.set(key, {
      airflowDagId: command.airflowDagId,
      airflowDagRunId: command.airflowDagRunId,
      command,
      state: simulation && 'completion' in simulation ? simulation.completion : 'RUNNING',
    });
    bind();

    if (behavior === 'ACCEPT_THEN_UNKNOWN') {
      return observed({
        kind: 'UNKNOWN',
        message: 'Fake executor created the run but the response was lost',
      }, simulation !== undefined);
    }
    return observed({ kind: 'ACCEPTED' }, simulation !== undefined);
  }

  async getExecutionStatus(
    identity: ExecutionIdentity,
  ): Promise<ExecutorExecutionStatus> {
    this.statusLookupHistory.push({ ...identity });
    if (this.statusLookupUnavailableMessage !== null) {
      return {
        kind: 'UNAVAILABLE',
        message: this.statusLookupUnavailableMessage,
      };
    }
    const execution = this.externalExecutions.get(executionKey(identity));
    if (!execution) {
      return { kind: 'NOT_FOUND' };
    }
    if (execution.state === 'FAILED') {
      return { kind: 'FAILED' };
    }
    return { kind: execution.state };
  }
}
