import type { FastifyInstance } from 'fastify';
import type { CalculationExecutor } from '../executors/calculation-executor.js';
import { InvalidCalculationJobIdError } from './calculation-job.errors.js';
import { reconcileCalculationJobService } from './calculation-job-reconciliation.service.js';
import { runCalculationJobService } from './calculation-job-run.service.js';

// Match the existing dataset lifecycle UUID shape policy.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function parseJobId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidCalculationJobIdError();
  }
  return value;
}

export function calculationJobRoutes(executor: CalculationExecutor) {
  return async function registerCalculationJobRoutes(
    app: FastifyInstance,
  ): Promise<void> {
    app.post<{ Params: { jobId: string } }>(
      '/calculation-jobs/:jobId/run',
      async (request, reply) => {
        const result = await runCalculationJobService(
          parseJobId(request.params.jobId),
          executor,
        );
        return reply.status(result.attemptStatus === 'DISPATCHING' ? 202 : 200)
          .send(result);
      },
    );

    app.post<{ Params: { jobId: string } }>(
      '/calculation-jobs/:jobId/reconcile',
      async (request, reply) => {
        const result = await reconcileCalculationJobService(
          parseJobId(request.params.jobId),
          executor,
        );
        return reply.status(200).send(result);
      },
    );
  };
}
