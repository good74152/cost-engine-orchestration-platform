export abstract class DatasetVersionError extends Error {
  protected constructor(
    message: string,
    readonly code: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidDatasetVersionRequestError extends DatasetVersionError {
  constructor() {
    super(
      'Request body must contain valid domain, companyCode, fiscalYear, and period values only',
      'INVALID_REQUEST',
      400,
    );
  }
}

export class InvalidDatasetDomainError extends DatasetVersionError {
  constructor() {
    super('Dataset domain is not supported', 'INVALID_DOMAIN', 400);
  }
}

export class InvalidDatasetPeriodError extends DatasetVersionError {
  constructor() {
    super('Period must be one of Q1, Q2, Q3, or Q4', 'INVALID_PERIOD', 400);
  }
}

export class ActiveDatasetVersionExistsError extends DatasetVersionError {
  constructor() {
    super(
      'An active dataset version already exists for this dataset series',
      'ACTIVE_DATASET_VERSION_EXISTS',
      409,
    );
  }
}

export class CalculationTypeNotConfiguredError extends DatasetVersionError {
  constructor() {
    super(
      'No active calculation types are configured for this domain',
      'CALCULATION_TYPE_NOT_CONFIGURED',
      409,
    );
  }
}

export class DatasetVersionNotFoundError extends DatasetVersionError {
  constructor(datasetVersionId: string) {
    super(`Dataset version not found: ${datasetVersionId}`, 'DATASET_VERSION_NOT_FOUND', 404);
  }
}

export class DatasetNotReadyForValidationError extends DatasetVersionError {
  constructor() {
    super('Dataset is not ready for validation', 'DATASET_NOT_READY_FOR_VALIDATION', 409);
  }
}

export class DatasetHasActiveExecutionError extends DatasetVersionError {
  constructor() {
    super('Dataset has an active execution attempt', 'DATASET_HAS_ACTIVE_EXECUTION', 409);
  }
}

export class DatasetStateConflictError extends DatasetVersionError {
  constructor() {
    super('Dataset lifecycle state conflicts with this command', 'STATE_CONFLICT', 409);
  }
}

export class DatasetStateInvariantError extends Error {
  readonly code = 'DATASET_STATE_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'DatasetStateInvariantError';
  }
}
