import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DemoRuntime } from './demo-runtime.js';
import type { AuthenticatedDemoSession } from './demo-session.service.js';
import { DemoResourceUnavailableError, DemoSessionError } from './demo-session.errors.js';
import { DemoHttpSecurity, installDemoErrorBoundary, type DemoSessionRouteOptions } from './demo-http-security.js';
import { DemoReadRepository, readScope } from './demo-read.repository.js';
import { readPage, validResourceId } from './demo-read.pagination.js';

export function demoReadRoutes(runtime: DemoRuntime, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  const reads = new DemoReadRepository(runtime.db);
  return async (app: FastifyInstance) => {
    const authenticated = new WeakMap<FastifyRequest, AuthenticatedDemoSession>();
    installDemoErrorBoundary(app, false, policy);
    app.addHook('onRequest', async (request) => {
      authenticated.set(request, await runtime.sessions.authenticate(request.headers.cookie, policy.cookieName));
      policy.assertSameOrigin(request); // GET needs no mutation header.
    });
    const operate = <T>(request: FastifyRequest, body: (s: AuthenticatedDemoSession) => Promise<T>) => {
      const session = authenticated.get(request)!;
      return runtime.coordinator.runParallel(session, () => body(session));
    };
    app.get('/demo/dataset-versions', async (request) => operate(request, (s) =>
      reads.datasets(s, readPage(request.query, 'datasets', readScope(s)))));
    for (const kind of ['dataset-versions', 'calculation-jobs'] as const) {
      app.get<{ Params: { id: string } }>(`/demo/${kind}/:id`, async (request) => operate(request, async (s) => {
        if (!validResourceId(request.params.id)) throw new DemoResourceUnavailableError();
        if (Object.keys(request.query as object).length) throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
        return kind === 'dataset-versions' ? reads.dataset(s, request.params.id) : reads.job(s, request.params.id);
      }));
    }
    app.get<{ Params: { id: string } }>('/demo/dataset-versions/:id/calculation-jobs', async (request) => operate(request, (s) => {
      if (!validResourceId(request.params.id)) throw new DemoResourceUnavailableError();
      return reads.jobs(s, request.params.id, readPage(request.query, 'jobs', readScope(s, request.params.id)));
    }));
    app.get<{ Params: { id: string } }>('/demo/calculation-jobs/:id/execution-attempts', async (request) => operate(request, (s) => {
      if (!validResourceId(request.params.id)) throw new DemoResourceUnavailableError();
      return reads.attempts(s, request.params.id, readPage(request.query, 'attempts', readScope(s, request.params.id)));
    }));
  };
}
