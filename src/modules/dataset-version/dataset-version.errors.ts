export abstract class DatasetVersionError extends Error {
  protected constructor(
    message: string,
    readonly code: string,
    readonly statusCode: 400 | 409,
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
