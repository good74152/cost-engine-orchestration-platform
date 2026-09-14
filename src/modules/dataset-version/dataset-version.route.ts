import type { FastifyInstance } from 'fastify';
import {
  InvalidDatasetDomainError,
  InvalidDatasetPeriodError,
  InvalidDatasetVersionRequestError,
} from './dataset-version.errors.js';
import { createDatasetVersionService } from './dataset-version.service.js';
import {
  DATASET_DOMAINS,
  DATASET_PERIODS,
} from './dataset-version.types.js';
import type {
  CreateDatasetVersionInput,
  DatasetDomain,
  DatasetPeriod,
} from './dataset-version.types.js';

const requestKeys = new Set([
  'domain',
  'companyCode',
  'fiscalYear',
  'period',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDatasetDomain(value: string): value is DatasetDomain {
  return (DATASET_DOMAINS as readonly string[]).includes(value);
}

function isDatasetPeriod(value: string): value is DatasetPeriod {
  return (DATASET_PERIODS as readonly string[]).includes(value);
}

export function parseCreateDatasetVersionInput(
  body: unknown,
): CreateDatasetVersionInput {
  if (!isRecord(body)) {
    throw new InvalidDatasetVersionRequestError();
  }

  const keys = Object.keys(body);
  if (keys.length !== requestKeys.size || keys.some((key) => !requestKeys.has(key))) {
    throw new InvalidDatasetVersionRequestError();
  }

  const { domain, companyCode, fiscalYear, period } = body;
  if (
    typeof domain !== 'string'
    || typeof companyCode !== 'string'
    || typeof fiscalYear !== 'number'
    || typeof period !== 'string'
  ) {
    throw new InvalidDatasetVersionRequestError();
  }

  if (!isDatasetDomain(domain)) {
    throw new InvalidDatasetDomainError();
  }

  if (!isDatasetPeriod(period)) {
    throw new InvalidDatasetPeriodError();
  }

  if (
    companyCode.length === 0
    || companyCode.length > 20
    || companyCode.trim() !== companyCode
    || !Number.isInteger(fiscalYear)
    || fiscalYear <= 0
    || fiscalYear > 2_147_483_647
  ) {
    throw new InvalidDatasetVersionRequestError();
  }

  return { domain, companyCode, fiscalYear, period };
}

export async function datasetVersionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>('/dataset-versions', async (request, reply) => {
    const input = parseCreateDatasetVersionInput(request.body);
    const result = await createDatasetVersionService(input);
    return reply.status(201).send(result);
  });
}
