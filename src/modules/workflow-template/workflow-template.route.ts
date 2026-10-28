import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DemoRuntime } from '../demo-session/demo-runtime.js';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';
import { DemoHttpSecurity, installDemoErrorBoundary, type DemoSessionRouteOptions } from '../demo-session/demo-http-security.js';
import { DemoResourceUnavailableError, DemoSessionError } from '../demo-session/demo-session.errors.js';
import { getWorkflowTemplate, listWorkflowTemplates } from './workflow-template.catalog.js';

export function workflowTemplateRoutes(runtime: DemoRuntime, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  return async (app: FastifyInstance) => {
    const authenticated = new WeakMap<FastifyRequest, AuthenticatedDemoSession>();
    installDemoErrorBoundary(app, false, policy);
    app.addHook('onRequest', async request => {
      authenticated.set(request, await runtime.sessions.authenticate(request.headers.cookie, policy.cookieName));
      policy.assertSameOrigin(request);
    });
    const read = <T>(request: FastifyRequest, body: () => T) =>
      runtime.coordinator.runParallel(authenticated.get(request)!, async () => {
        if (Object.keys(request.query as object).length) throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
        return body();
      });
    app.get('/demo/workflow-templates', async request => read(request, () => ({ templates: listWorkflowTemplates() })));
    app.get<{ Params: { id: string } }>('/demo/workflow-templates/:id', async request => read(request, () => {
      const template = getWorkflowTemplate(request.params.id);
      if (!template) throw new DemoResourceUnavailableError();
      return template;
    }));
  };
}
