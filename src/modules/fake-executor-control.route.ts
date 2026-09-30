import type { FastifyInstance } from 'fastify';
import type { FakeExecutionState } from '../executors/fake-executor.js';
import { FakeExecutor } from '../executors/fake-executor.js';
import { FakeExecutionNotFoundError } from './calculation-job.errors.js';

function registerStateRoute(
  app: FastifyInstance,
  executor: FakeExecutor,
  action: 'succeed' | 'fail',
  state: FakeExecutionState,
): void {
  app.post<{ Params: { dagRunId: string } }>(
    `/internal/fake-executor/executions/:dagRunId/${action}`,
    async (request, reply) => {
      const execution = executor.setExecutionStateByDagRunId(
        request.params.dagRunId,
        state,
      );
      if (!execution) {
        throw new FakeExecutionNotFoundError(request.params.dagRunId);
      }
      return reply.status(200).send({
        airflowDagId: execution.airflowDagId,
        airflowDagRunId: execution.airflowDagRunId,
        state: execution.state,
      });
    },
  );
}

export function fakeExecutorControlRoutes(executor: FakeExecutor) {
  return async function registerFakeExecutorControlRoutes(
    app: FastifyInstance,
  ): Promise<void> {
    registerStateRoute(app, executor, 'succeed', 'SUCCEEDED');
    registerStateRoute(app, executor, 'fail', 'FAILED');
  };
}
