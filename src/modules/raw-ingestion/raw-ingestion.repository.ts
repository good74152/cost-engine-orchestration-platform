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
            VALUES ($1, $2, $3, 0)
            ON CONFLICT (domain, business_key)
            DO UPDATE 
            SET last_batch_sequence = last_batch_sequence + 1
            RETURNING id, last_batch_sequence;
            `;
    const result = await client.query(sql, [params.newSeriesId, params.domain, params.businessKey]);
    console.log(`Raw ingestion series allocated with id: ${result.rows[0].id}, last_batch_sequence: ${result.rows[0].last_batch_sequence}`);
    return {
        ingestionSeriesId: result.rows[0].id,
        batchSequence: result.rows[0].last_batch_sequence
    };
}