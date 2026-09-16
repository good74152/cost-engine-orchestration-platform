import type { FastifyInstance } from 'fastify';
import type { CalculationExecutor } from '../executors/calculation-executor.js';
import { runCalculationJobService } from './calculation-job-run.service.js';

export function calculationJobRoutes(executor: CalculationExecutor) {
  return async function registerCalculationJobRoutes(
    app: FastifyInstance,
  ): Promise<void> {
    app.post<{ Params: { jobId: string } }>(
      '/calculation-jobs/:jobId/run',
      async (request, reply) => {
        const result = await runCalculationJobService(
          request.params.jobId,
          executor,
        );
        return reply.status(result.attemptStatus === 'DISPATCHING' ? 202 : 200)
          .send(result);
      },
    );
  };
}
