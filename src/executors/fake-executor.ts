import type {
  CalculationExecutor,
  DispatchCalculationCommand,
  DispatchResult,
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
  state: 'RUNNING';
}

export interface FakeExecutorOptions {
  defaultBehavior?: FakeDispatchBehavior;
  scriptedBehaviors?: FakeDispatchBehavior[];
}

function executionKey(command: DispatchCalculationCommand): string {
  return `${command.airflowDagId}\u0000${command.airflowDagRunId}`;
}

export class FakeExecutor implements CalculationExecutor {
  private readonly externalExecutions = new Map<string, FakeExternalExecution>();
  private readonly dispatchHistory: DispatchCalculationCommand[] = [];
  private readonly scriptedBehaviors: FakeDispatchBehavior[];
  private defaultBehavior: FakeDispatchBehavior;

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
}
