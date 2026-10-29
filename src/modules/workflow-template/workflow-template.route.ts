import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DemoRuntime } from '../demo-session/demo-runtime.js';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';
import { DemoHttpSecurity, installDemoErrorBoundary, type DemoSessionRouteOptions } from '../demo-session/demo-http-security.js';
import { DemoResourceUnavailableError, DemoSessionError } from '../demo-session/demo-session.errors.js';
import { getWorkflowTemplate, listWorkflowTemplates } from './workflow-template.catalog.js';
import { admissionUnavailable, type DemoAdmissionState } from '../demo-admission/demo-admission.repository.js';
import type { WorkflowCatalogResponse, WorkflowTemplateResponse } from './workflow-template.types.js';

export function workflowTemplateRoutes(runtime: DemoRuntime, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  return async (app: FastifyInstance) => {
    const authenticated = new WeakMap<FastifyRequest, AuthenticatedDemoSession>();
    installDemoErrorBoundary(app, false, policy);
    app.addHook('onRequest', async request => {
      authenticated.set(request, await runtime.sessions.authenticate(request.headers.cookie, policy.cookieName));
      policy.assertSameOrigin(request);
    });
    const read = <T>(request: FastifyRequest, body: (state: DemoAdmissionState['state']) => T) =>
      runtime.coordinator.runParallel(authenticated.get(request)!, async () => {
        if (Object.keys(request.query as object).length) throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
        // A single committed observation is sufficient for a read projection. Mutations
        // retain their existing admission transactions; this GET never locks/writes Gate.
        let state: DemoAdmissionState['state'];
        try {
          const rows = await runtime.db.query<{ state: DemoAdmissionState['state'] }>('SELECT state FROM demo_admission_control WHERE id=1');
          if (rows.rowCount !== 1 || !['LEGACY_OPEN', 'DRAINING', 'WORKFLOW_OPEN'].includes(rows.rows[0]!.state)) throw admissionUnavailable();
          state = rows.rows[0]!.state;
        } catch { throw admissionUnavailable(); }
        return body(state);
      });
    const availability = (state: DemoAdmissionState['state']): 'PREVIEW' | 'AVAILABLE' => state === 'WORKFLOW_OPEN' ? 'AVAILABLE' : 'PREVIEW';
    app.get('/demo/workflow-templates', async request => read(request, (state): WorkflowCatalogResponse => ({ admissionState: state,
      templates: listWorkflowTemplates().map(t => ({ ...t, availability: availability(state) })) })));
    app.get<{ Params: { id: string } }>('/demo/workflow-templates/:id', async request => read(request, (state): WorkflowTemplateResponse => {
      const template = getWorkflowTemplate(request.params.id);
      if (!template) throw new DemoResourceUnavailableError();
      return { ...template, availability: availability(state) };
    }));
  };
}
