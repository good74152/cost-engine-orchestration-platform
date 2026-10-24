import type { FastifyInstance } from 'fastify';
import { DemoSessionError } from './demo-session.errors.js';
import {
  DemoSessionService,
  SESSION_LIFETIME_SECONDS, publicSession, readSessionCookie,
} from './demo-session.service.js';
import { DemoHttpSecurity, installDemoErrorBoundary, type DemoSessionRouteOptions } from './demo-http-security.js';
export type { DemoSessionRouteOptions } from './demo-http-security.js';

export function demoSessionRoutes(sessions: DemoSessionService, options: DemoSessionRouteOptions = {}) {
  const policy = new DemoHttpSecurity(options);
  const { secure, cookieName: name } = policy;

  return async (app: FastifyInstance) => {
    installDemoErrorBoundary(app, false, policy);
    app.post('/demo/sessions', async (request, reply) => {
      policy.assertMutation(request);
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')
        || typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)
        || Object.keys(request.body).length !== 0) {
        throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
      }
      if (readSessionCookie(request.headers.cookie, name) !== undefined) {
        return reply.status(200).send(publicSession(await sessions.authenticate(request.headers.cookie, name)));
      }
      const created = await sessions.create();
      const maxAge = Math.max(0, Math.min(SESSION_LIFETIME_SECONDS,
        Math.floor((Date.parse(created.session.expiresAt) - Date.now()) / 1000)));
      reply.header('Set-Cookie', `${name}=${created.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}; Expires=${new Date(created.session.expiresAt).toUTCString()}${secure ? '; Secure' : ''}`);
      return reply.status(201).send(publicSession(created.session));
    });
    app.get('/demo/sessions/current', async (request) =>
      publicSession(await sessions.authenticate(request.headers.cookie, name)));
  };
}
