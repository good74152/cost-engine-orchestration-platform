import type { FastifyInstance } from 'fastify';
import { allocateRawIngestionBatch } from './raw-ingestion.service.js';
import { AllocateRawIngestionBatchInput } from './raw-ingestion.types.js';

export async function rawIngestionRoutes(app: FastifyInstance): Promise<void> {
    app.post<{ Body: AllocateRawIngestionBatchInput }>('/raw-ingestion-batches', async (request, reply) => {
        const input = request.body;
        const result = await allocateRawIngestionBatch(input);
        reply.status(201).send(result);
    });
}