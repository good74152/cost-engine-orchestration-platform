import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DemoRuntime } from './demo-runtime.js';
import type { AuthenticatedDemoSession } from './demo-session.service.js';
import { DemoHttpSecurity, exactDemoBody, installDemoErrorBoundary, type DemoSessionRouteOptions } from './demo-http-security.js';

export function demoSessionResetRoutes(runtime: DemoRuntime, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  return async (app: FastifyInstance) => {
    installDemoErrorBoundary(app, false, policy);
    const authenticated = new WeakMap<FastifyRequest, AuthenticatedDemoSession>();
    app.addHook('onRequest', async (request) => {
      authenticated.set(request, await runtime.sessions.authenticate(request.headers.cookie, policy.cookieName));
      policy.assertMutation(request);
    });
    app.post('/demo/sessions/reset', async (request, reply) => {
      exactDemoBody(request.body, []);
      await runtime.reset.reset(authenticated.get(request)!);
      policy.clearCookie(reply);
      return reply.status(204).send();
    });
  };
}
