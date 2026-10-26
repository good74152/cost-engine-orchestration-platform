import type { CalculationExecutor, DispatchCalculationCommand, DispatchResult,
  ExecutionIdentity, ExecutorExecutionStatus } from '../../executors/calculation-executor.js';

/** Demo-02E Step 2 only. No behavior queue, identity allocation or mutable state.
 * The delegate must actually create/confirm the execution before ACK loss.
 * Repeated dispatch preserves ALREADY_EXISTS so core recovery can confirm it. */
export class LostAcknowledgementExecutor implements CalculationExecutor {
  constructor(private readonly delegate: CalculationExecutor) {}

  async dispatch(command: DispatchCalculationCommand): Promise<DispatchResult> {
    const result = await this.delegate.dispatch(command);
    return result.kind === 'ACCEPTED'
      ? { kind: 'UNKNOWN', message: 'Demo execution created but dispatch acknowledgement lost' }
      : result;
  }

  getExecutionStatus(identity: ExecutionIdentity): Promise<ExecutorExecutionStatus> {
    return this.delegate.getExecutionStatus(identity);
  }
}
