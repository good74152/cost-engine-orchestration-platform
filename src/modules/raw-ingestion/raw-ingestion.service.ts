import { randomUUID } from "crypto";
import { AllocateRawIngestionBatchInput, AllocateRawIngestionBatchResult } from "./raw-ingestion.types.js";
import { allocateRawIngestionSeries, createRawIngestionBatch } from "./raw-ingestion.repository.js";
import { withTransaction } from "../../db/transaction.js";
import { ActiveRawIngestionBatchExistsError } from "./raw-ingestion.errors.js";

export async function allocateRawIngestionBatch(
    input: AllocateRawIngestionBatchInput,
): Promise<AllocateRawIngestionBatchResult> {
    try {
        return await withTransaction(async (client) => {
            const newSeriesId = randomUUID();
            const batchId = randomUUID();

            const allocateResult = await allocateRawIngestionSeries(client, {
                newSeriesId,
                domain: input.domain,
                businessKey: input.businessKey,
            });

            await createRawIngestionBatch(client, {
                batchId,
                ingestionSeriesId: allocateResult.ingestionSeriesId,
                batchSequence: allocateResult.batchSequence,
            });

            return {
                batchId,
                ingestionSeriesId: allocateResult.ingestionSeriesId,
                batchSequence: allocateResult.batchSequence,
                status: 'LOADING',
            };
        });
    } catch (error: unknown) {
        if (isPostgresError(error) && 
            error.code === '23505' && 
            error.constraint === 'uq_raw_ingestion_batches_active_series'
        ) {
            throw new ActiveRawIngestionBatchExistsError();
        }
        throw error;
    }
}

interface PostgresError extends Error {
    code?: string;
    constraint?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
    return error instanceof Error &&
    'code' in error;
}