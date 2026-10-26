export type RunnableScenarioType = 'HAPPY_PATH' | 'FAILURE_RETRY';
export interface StepPlan {
  scenarioType: RunnableScenarioType;
  step: number;
  count: number;
  operation: 'CREATE' | 'RUN' | 'FAKE' | 'RECONCILE' | 'VALIDATE' | 'PUBLISH';
  attemptNumber: 1 | 2;
  outcome: 'FAILED' | 'SUCCEEDED';
}

// Only the two accepted, fixed teaching flows. Not a configurable workflow engine.
export function stepCount(type: string): number {
  if (type === 'HAPPY_PATH') return 6;
  if (type === 'FAILURE_RETRY') return 9;
  throw new Error('Unsupported guided scenario');
}
export function stepPlan(type: string, step: number): StepPlan {
  const count = stepCount(type);
  const operations = type === 'HAPPY_PATH'
    ? ['CREATE','RUN','FAKE','RECONCILE','VALIDATE','PUBLISH'] as const
    : ['CREATE','RUN','FAKE','RECONCILE','RUN','FAKE','RECONCILE','VALIDATE','PUBLISH'] as const;
  const operation = operations[step - 1];
  if (!operation) throw new Error('Unsupported guided step');
  return { scenarioType: type as RunnableScenarioType, step, count, operation,
    attemptNumber: type === 'FAILURE_RETRY' && step >= 5 ? 2 : 1,
    outcome: type === 'FAILURE_RETRY' && step <= 4 ? 'FAILED' : 'SUCCEEDED' };
}
