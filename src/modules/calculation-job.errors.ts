export abstract class CalculationJobError extends Error {
  protected constructor(
    message: string,
    readonly code: string,
    readonly statusCode: 404 | 409 | 502,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export abstract class CalculationJobPreparationError extends CalculationJobError {}

export class CalculationJobNotFoundError extends CalculationJobPreparationError {
  constructor(jobId: string) {
    super(`Calculation job not found: ${jobId}`, 'CALCULATION_JOB_NOT_FOUND', 404);
  }
}

export class DependencyDefinitionNotReadyError extends CalculationJobPreparationError {
  constructor(calculationTypeCodes: string[]) {
    super(
      `Published dependency definition is not ready for: ${calculationTypeCodes.join(', ')}`,
      'DEPENDENCY_DEFINITION_NOT_READY',
      409,
    );
  }
}

export class DependencyNotReadyError extends CalculationJobPreparationError {
  constructor(requiredDomains: string[]) {
    super(
      `Published upstream dataset is not ready for: ${requiredDomains.join(', ')}`,
      'DEPENDENCY_NOT_READY',
      409,
    );
  }
}

export class JobNotRunnableError extends CalculationJobPreparationError {
  constructor(jobId: string) {
    super(`Calculation job is not runnable: ${jobId}`, 'JOB_NOT_RUNNABLE', 409);
  }
}

export class ExecutorDispatchFailedError extends CalculationJobError {
  constructor(jobId: string) {
    super(
      `Executor rejected dispatch for calculation job: ${jobId}`,
      'EXECUTOR_DISPATCH_FAILED',
      502,
    );
  }
}

export class CalculationStateInvariantError extends Error {
  readonly code = 'CALCULATION_STATE_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'CalculationStateInvariantError';
  }
}
