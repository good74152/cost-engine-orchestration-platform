import type { FastifyInstance } from 'fastify';
import { allocateRawIngestionBatch } from './raw-ingestion.service.js';
import type {
  AllocateRawIngestionBatchInput,
  RawIngestionDomain,
} from './raw-ingestion.types.js';

const RAW_DOMAINS = new Set<RawIngestionDomain>([
  'FAB_COST_RAW',
  'CAPEX_RAW',
  'DPR_RAW',
]);
const RAW_KEYS = new Set(['domain', 'businessKey']);

interface BadRequestError extends Error {
  statusCode: 400;
}

function invalidRequest(): BadRequestError {
  const error = new Error('Invalid raw ingestion request') as BadRequestError;
  error.statusCode = 400;
  return error;
}

function parseAllocateRawIngestionBatchInput(body: unknown): AllocateRawIngestionBatchInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest();
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== RAW_KEYS.size
    || keys.some((key) => !RAW_KEYS.has(key))
    || typeof record.domain !== 'string'
    || !RAW_DOMAINS.has(record.domain as RawIngestionDomain)
    || typeof record.businessKey !== 'string'
    || record.businessKey.length === 0
    || record.businessKey.length > 255
  ) {
    throw invalidRequest();
  }
  return {
    domain: record.domain as RawIngestionDomain,
    businessKey: record.businessKey,
  };
}

export async function rawIngestionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>('/raw-ingestion-batches', async (request, reply) => {
    const input = parseAllocateRawIngestionBatchInput(request.body);
    const result = await allocateRawIngestionBatch(input);
    return reply.status(201).send(result);
  });
}
