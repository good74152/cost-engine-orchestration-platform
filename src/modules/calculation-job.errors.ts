export class ActiveCalculationJobExistsError extends Error {
    readonly code = 'ACTIVE_CALCULATION_JOB_EXISTS';

    constructor() {
        super('An active calculation job already exists');
        this.name = 'ActiveCalculationJobExistsError';
    }
}

export class CalculationJobNotFoundError extends Error {
    readonly code = 'CALCULATION_JOB_NOT_FOUND';

    constructor(jobId: string) {
        super(`Calculation job not found: ${jobId}`);
        this.name = 'CalculationJobNotFoundError';
    }
}

export class CalculationJobNotStartableError extends Error {
    readonly code = 'CALCULATION_JOB_NOT_STARTABLE';

    constructor(status: string) {
        super(`Calculation job not start from status: ${status}`);
        this.name = 'CalculationJobNotStartableError';
    }
}

export class CalculationStateInvariantError extends Error {
    readonly code = 'CALCULATION_STATE_INVARIANT_VIOLATION';

    constructor(message: string) {
        super(message);
        this.name = 'CalculationStateInvariantError';
    }
}

export class CalculationJobStateConflictError extends Error {
    readonly code = 'CALCULATION_JOB_STATE_CONFLICT';

    constructor(
        currentStatus:string,
        expectedStatus: string
    ){
        super(`Expected calculation job status ${expectedStatus}, but current status is ${currentStatus}`);
        this.name = 'CalculationJobStateConflictError';
    }
}

export class ActiveRawIngestionBatchExistsError extends Error {
    readonly code = 'ACTIVE_RAW_INGESTION_BATCH_EXISTS';

    constructor() {
        super('An active raw ingestion batch already exists');
        this.name = 'ActiveRawIngestionBatchExistsError';
    }
}