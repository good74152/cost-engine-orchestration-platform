import type { CalculationExecutor } from './calculation-executor.js';
import { FakeExecutor } from './fake-executor.js';

export interface ExecutorConfiguration {
  executorType?: string;
  nodeEnvironment?: string;
}

export function createConfiguredCalculationExecutor(
  configuration: ExecutorConfiguration = {},
): CalculationExecutor {
  const executorType = configuration.executorType ?? process.env.EXECUTOR_TYPE;
  const nodeEnvironment = configuration.nodeEnvironment ?? process.env.NODE_ENV;

  if (!executorType) {
    throw new Error('EXECUTOR_TYPE must explicitly select a calculation executor');
  }
  if (executorType.toLowerCase() !== 'fake') {
    throw new Error(`Unsupported calculation executor type: ${executorType}`);
  }
  if (nodeEnvironment?.toLowerCase() === 'production') {
    throw new Error('FakeExecutor cannot be enabled in production');
  }
  return new FakeExecutor();
}
