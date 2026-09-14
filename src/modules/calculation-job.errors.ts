export abstract class CalculationJobPreparationError extends Error {
  protected constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class CalculationJobNotFoundError extends CalculationJobPreparationError {
  constructor(jobId: string) {
    super(`Calculation job not found: ${jobId}`, 'CALCULATION_JOB_NOT_FOUND');
  }
}

export class DependencyDefinitionNotReadyError extends CalculationJobPreparationError {
  constructor(calculationTypeCodes: string[]) {
    super(
      `Published dependency definition is not ready for: ${calculationTypeCodes.join(', ')}`,
      'DEPENDENCY_DEFINITION_NOT_READY',
    );
  }
}

export class DependencyNotReadyError extends CalculationJobPreparationError {
  constructor(requiredDomains: string[]) {
    super(
      `Published upstream dataset is not ready for: ${requiredDomains.join(', ')}`,
      'DEPENDENCY_NOT_READY',
    );
  }
}

export class JobNotRunnableError extends CalculationJobPreparationError {
  constructor(jobId: string) {
    super(`Calculation job is not runnable: ${jobId}`, 'JOB_NOT_RUNNABLE');
  }
}

export class CalculationStateInvariantError extends Error {
  readonly code = 'CALCULATION_STATE_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'CalculationStateInvariantError';
  }
}
