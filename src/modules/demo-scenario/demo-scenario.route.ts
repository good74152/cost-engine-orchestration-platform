import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DemoRuntime } from '../demo-session/demo-runtime.js';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';
import { DemoHttpSecurity, exactDemoBody, installDemoErrorBoundary, type DemoSessionRouteOptions } from '../demo-session/demo-http-security.js';
import { DemoSessionError, DemoResourceUnavailableError } from '../demo-session/demo-session.errors.js';
import { validResourceId } from '../demo-session/demo-read.pagination.js';

export function demoScenarioRoutes(runtime: DemoRuntime, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  return async (app: FastifyInstance) => {
    const authenticated = new WeakMap<FastifyRequest, AuthenticatedDemoSession>();
    installDemoErrorBoundary(app, false, policy);
    app.addHook('onRequest', async (request) => {
      authenticated.set(request, await runtime.sessions.authenticate(request.headers.cookie, policy.cookieName));
      if (request.method === 'POST') policy.assertMutation(request); else policy.assertSameOrigin(request);
    });
    const operate = <T>(request: FastifyRequest, body: (session: AuthenticatedDemoSession) => Promise<T>) => {
      const session = authenticated.get(request)!;
      return runtime.coordinator.run(session, () => {
        if (Object.keys(request.query as object).length) throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
        return body(session);
      });
    };
    app.post('/demo/scenarios', async (request, reply) => operate(request, async (session) => {
      const { scenarioType } = exactDemoBody(request.body, ['scenarioType']);
      if (scenarioType !== 'HAPPY_PATH') throw new DemoSessionError('INVALID_REQUEST', 400, 'Unsupported scenario type');
      const result = await runtime.scenarios.create(session);
      return reply.status(result.created ? 201 : 200).send(result.scenario);
    }));
    app.get('/demo/scenarios/current', async (request) => operate(request, (session) => runtime.scenarios.get(session)));
    app.get<{ Params: { id: string } }>('/demo/scenarios/:id', async (request) => operate(request, (session) => {
      if (!validResourceId(request.params.id)) throw new DemoResourceUnavailableError();
      return runtime.scenarios.get(session, request.params.id);
    }));
  };
}
