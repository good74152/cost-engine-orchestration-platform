import type { CalculationExecutor } from './calculation-executor.js';
import { FakeExecutor } from './fake-executor.js';

export interface ExecutorConfiguration {
  executorType?: string;
  nodeEnvironment?: string;
}

/**
 * Fail closed unless development/test is explicitly selected.
 * Runtime NODE_ENV cannot be overridden by conflicting injected options.
 */
export function isApprovedFakeExecutorEnvironment(
  configuredEnvironment?: string,
  runtimeEnvironment: string | undefined = process.env.NODE_ENV,
): boolean {
  const approved = (value: string): boolean => {
    const normalized = value.toLowerCase();
    return normalized === 'development' || normalized === 'test';
  };
  if (configuredEnvironment !== undefined && !approved(configuredEnvironment)) return false;
  if (runtimeEnvironment !== undefined && !approved(runtimeEnvironment)) return false;
  return configuredEnvironment !== undefined || runtimeEnvironment !== undefined;
}

export function createConfiguredCalculationExecutor(
  configuration: ExecutorConfiguration = {},
): CalculationExecutor {
  const executorType = configuration.executorType ?? process.env.EXECUTOR_TYPE;

  if (!executorType) {
    throw new Error('EXECUTOR_TYPE must explicitly select a calculation executor');
  }
  if (executorType.toLowerCase() !== 'fake') {
    throw new Error(`Unsupported calculation executor type: ${executorType}`);
  }
  if (!isApprovedFakeExecutorEnvironment(configuration.nodeEnvironment)) {
    throw new Error('FakeExecutor requires an explicit development or test environment');
  }
  return new FakeExecutor();
}
