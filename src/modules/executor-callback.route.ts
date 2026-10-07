import type { FastifyInstance } from 'fastify';
import type {
  CalculationExecutor,
  ExecutionIdentity,
} from '../executors/calculation-executor.js';
import { reconcileExecutionByIdentityService } from './calculation-job-reconciliation.service.js';

const CALLBACK_KEYS = new Set(['airflowDagId', 'airflowDagRunId']);

interface BadRequestError extends Error {
  statusCode: 400;
}

function invalidRequest(): BadRequestError {
  const error = new Error('Invalid executor callback request') as BadRequestError;
  error.statusCode = 400;
  return error;
}

function parseExecutionIdentity(body: unknown): ExecutionIdentity {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest();
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CALLBACK_KEYS.size
    || keys.some((key) => !CALLBACK_KEYS.has(key))
    || typeof record.airflowDagId !== 'string'
    || typeof record.airflowDagRunId !== 'string'
    || record.airflowDagId.length === 0
    || record.airflowDagRunId.length === 0
  ) {
    throw invalidRequest();
  }
  return {
    airflowDagId: record.airflowDagId,
    airflowDagRunId: record.airflowDagRunId,
  };
}

export function executorCallbackRoutes(executor: CalculationExecutor) {
  return async function registerExecutorCallbackRoutes(
    app: FastifyInstance,
  ): Promise<void> {
    app.post<{ Body: unknown }>(
      '/executor-callbacks/airflow',
      async (request, reply) => {
        const identity = parseExecutionIdentity(request.body);
        const result = await reconcileExecutionByIdentityService(
          identity,
          executor,
        );
        return reply.status(200).send(result);
      },
    );
  };
}
