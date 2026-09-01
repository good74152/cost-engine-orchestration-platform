export class ActiveRawIngestionBatchExistsError extends Error {
    readonly code = 'ACTIVE_RAW_INGESTION_BATCH_EXISTS';

    constructor() {
        super('An active raw ingestion batch already exists');
        this.name = 'ActiveRawIngestionBatchExistsError';
    }
}