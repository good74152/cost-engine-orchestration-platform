import type { PoolClient } from "pg";

export async function allocateRawIngestionSeries(
    client: PoolClient,
    params: {
        newSeriesId: string;
        domain: string;
        businessKey: string;
    }): Promise<{
        ingestionSeriesId: string;
        batchSequence: number;
    }> {
    console.log(`Allocating raw ingestion batch for domain: ${params.domain}, businessKey: ${params.businessKey}, newSeriesId: ${params.newSeriesId}`);
    const sql = `
            INSERT INTO raw_ingestion_series (id, domain, business_key, last_batch_sequence)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (domain, business_key)
            DO UPDATE 
            SET last_batch_sequence = raw_ingestion_series.last_batch_sequence + 1
            RETURNING id, last_batch_sequence;
            `;
    const result = await client.query(sql, [params.newSeriesId, params.domain, params.businessKey]);
    console.log(`Raw ingestion series allocated with id: ${result.rows[0].id}, last_batch_sequence: ${result.rows[0].last_batch_sequence}`);
    return {
        ingestionSeriesId: result.rows[0].id,
        batchSequence: result.rows[0].last_batch_sequence
    };
}

export async function createRawIngestionBatch(
    client: PoolClient,
    params: {
        batchId: string;
        ingestionSeriesId: string;
        batchSequence: number;
    }
): Promise<void> {
    console.log(`Creating raw ingestion batch with batchId: ${params.batchId}, ingestionSeriesId: ${params.ingestionSeriesId}, batchSequence: ${params.batchSequence}`);
    const sql = `
        INSERT INTO raw_ingestion_batches (id, ingestion_series_id, batch_sequence, status)
        VALUES ($1, $2, $3, 'LOADING')
        RETURNING id, created_at;
    `;
    const result = await client.query(sql, [params.batchId, params.ingestionSeriesId, params.batchSequence]);
    console.log(`Raw ingestion batch created with batchId: ${params.batchId}, created_at: ${result.rows[0].created_at}`);
}