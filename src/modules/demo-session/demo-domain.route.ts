import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseCreateDatasetVersionInput } from '../dataset-version/dataset-version.route.js';
import { createDatasetVersionService } from '../dataset-version/dataset-version.service.js';
import { abandonDatasetVersionService, publishDatasetVersionService,
  rejectDatasetVersionService, submitDatasetValidationService } from '../dataset-version/dataset-version-lifecycle.service.js';
import { runCalculationJobService } from '../calculation-job-run.service.js';
import { reconcileCalculationJobService } from '../calculation-job-reconciliation.service.js';
import type { FakeDispatchBehavior } from '../../executors/fake-executor.js';
import { DemoResourceUnavailableError, DemoSessionError } from './demo-session.errors.js';
import type { AuthenticatedDemoSession } from './demo-session.service.js';
import type { DemoRuntime } from './demo-runtime.js';
import { DemoHttpSecurity, exactDemoBody, installDemoErrorBoundary, type DemoSessionRouteOptions } from './demo-http-security.js';

export function demoDomainRoutes(runtime: DemoRuntime, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  return async (app: FastifyInstance) => {
    const authenticated = new WeakMap<FastifyRequest, AuthenticatedDemoSession>();
    installDemoErrorBoundary(app, true, policy);
    app.addHook('onRequest', async (request) => {
      authenticated.set(request, await runtime.sessions.authenticate(request.headers.cookie, policy.cookieName));
      policy.assertMutation(request);
    });
    const operate = <T>(request: FastifyRequest, command: (session: AuthenticatedDemoSession) => Promise<T>) => {
      const session = authenticated.get(request)!;
      return runtime.coordinator.run(session, () => command(session));
    };

    app.post('/demo/dataset-versions', async (request, reply) => operate(request, async (session) => {
      const body = exactDemoBody(request.body, ['domain', 'fiscalYear', 'period']);
      const input = parseCreateDatasetVersionInput({ ...body, companyCode: session.companyCode });
      return reply.status(201).send(await createDatasetVersionService(input));
    }));

    const lifecycle = { 'submit-validation': submitDatasetValidationService,
      publish: publishDatasetVersionService, reject: rejectDatasetVersionService, abandon: abandonDatasetVersionService };
    for (const [command, service] of Object.entries(lifecycle)) {
      app.post<{ Params: { id: string } }>(`/demo/dataset-versions/:id/${command}`, async (request) =>
        operate(request, async (session) => {
          await runtime.ownership.assertOwned(session, 'dataset', request.params.id);
          exactDemoBody(request.body, []);
          return service(request.params.id);
        }));
    }
    for (const command of ['run', 'reconcile'] as const) {
      app.post<{ Params: { id: string } }>(`/demo/calculation-jobs/:id/${command}`, async (request, reply) =>
        operate(request, async (session) => {
          await runtime.ownership.assertOwned(session, 'job', request.params.id);
          exactDemoBody(request.body, []);
          const executor = await runtime.executors.forSession(session);
          const result = command === 'run'
            ? await runCalculationJobService(request.params.id, executor)
            : await reconcileCalculationJobService(request.params.id, executor);
          return reply.status(result.attemptStatus === 'DISPATCHING' ? 202 : 200).send(result);
        }));
    }
    app.post('/demo/fake-executor/dispatch-behavior', async (request) => operate(request, async (session) => {
      const { behavior } = exactDemoBody(request.body, ['behavior']);
      const behaviors = ['ACCEPT', 'REJECT', 'ACCEPT_THEN_UNKNOWN', 'UNKNOWN_WITHOUT_CREATION'];
      if (typeof behavior !== 'string' || !behaviors.includes(behavior)) {
        throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
      }
      (await runtime.executors.forSession(session)).enqueueBehaviors(behavior as FakeDispatchBehavior);
      return { behavior };
    }));
    app.post<{ Params: { id: string } }>('/demo/execution-attempts/:id/fake-state', async (request) =>
      operate(request, async (session) => {
        await runtime.ownership.assertOwned(session, 'attempt', request.params.id);
        const { state } = exactDemoBody(request.body, ['state']);
        if (state !== 'SUCCEEDED' && state !== 'FAILED') {
          throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
        }
        // Resolve immutable execution identity only after ownership, within the
        // same session operation. Never accept client DAG/run IDs or mutate DB state.
        const result = await runtime.db.query<{ airflow_dag_id: string; airflow_dag_run_id: string }>(
          'SELECT airflow_dag_id, airflow_dag_run_id FROM execution_attempts WHERE id=$1', [request.params.id]);
        const identity = result.rows[0];
        if (!identity || !(await runtime.executors.forSession(session)).setExecutionState({
          airflowDagId: identity.airflow_dag_id, airflowDagRunId: identity.airflow_dag_run_id,
        }, state)) throw new DemoResourceUnavailableError();
        return { executionAttemptId: request.params.id, state };
      }));
  };
}
