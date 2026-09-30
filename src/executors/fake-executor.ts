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

export interface FakeExecutorOptions {
  defaultBehavior?: FakeDispatchBehavior;
  scriptedBehaviors?: FakeDispatchBehavior[];
}

function executionKey(identity: ExecutionIdentity): string {
  return `${identity.airflowDagId}\u0000${identity.airflowDagRunId}`;
}

export class FakeExecutor implements CalculationExecutor {
  private readonly externalExecutions = new Map<string, FakeExternalExecution>();
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
    this.dispatchHistory.push(command);
    const key = executionKey(command);
    if (this.externalExecutions.has(key)) {
      return { kind: 'ALREADY_EXISTS' };
    }

    const behavior = this.scriptedBehaviors.shift() ?? this.defaultBehavior;
    if (behavior === 'REJECT') {
      return {
        kind: 'REJECTED',
        message: 'Fake executor rejected dispatch',
      };
    }
    if (behavior === 'UNKNOWN_WITHOUT_CREATION') {
      return {
        kind: 'UNKNOWN',
        message: 'Fake executor returned an ambiguous result without creating a run',
      };
    }

    this.externalExecutions.set(key, {
      airflowDagId: command.airflowDagId,
      airflowDagRunId: command.airflowDagRunId,
      command,
      state: 'RUNNING',
    });

    if (behavior === 'ACCEPT_THEN_UNKNOWN') {
      return {
        kind: 'UNKNOWN',
        message: 'Fake executor created the run but the response was lost',
      };
    }
    return { kind: 'ACCEPTED' };
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
