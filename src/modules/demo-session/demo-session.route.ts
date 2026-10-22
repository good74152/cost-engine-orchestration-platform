import type { FastifyInstance } from 'fastify';
import { DemoSessionError } from './demo-session.errors.js';
import {
  DemoSessionService, LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE,
  SESSION_LIFETIME_SECONDS, publicSession, readSessionCookie,
} from './demo-session.service.js';

export interface DemoSessionRouteOptions {
  nodeEnvironment?: string;
  secureCookies?: boolean;
  origin?: string;
}

export function demoSessionRoutes(sessions: DemoSessionService, options: DemoSessionRouteOptions = {}) {
  const environments = [options.nodeEnvironment, process.env.NODE_ENV].filter((e) => e !== undefined);
  const local = environments.length > 0 && environments.every((e) => ['development', 'test'].includes(e));
  if (options.secureCookies === false && !local) throw new Error('Insecure demo cookies require development/test');
  const secure = options.secureCookies ?? !local;
  const name = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE;
  const origin = options.origin === undefined ? undefined : new URL(options.origin).origin;
  if (origin && !/^https?:\/\//.test(origin)) throw new Error('Invalid demo browser origin');

  return async (app: FastifyInstance) => {
    app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    // Encapsulated boundary: credential-bearing DB errors never reach general logging.
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DemoSessionError) {
        return reply.status(error.statusCode).send({ message: error.message, code: error.code });
      }
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413 || status === 415) {
        return reply.status(status).send({ message: 'Invalid request', code: 'INVALID_REQUEST' });
      }
      request.log.error({ event: 'demo_session_internal_failure', requestId: request.id });
      return reply.status(500).send({ message: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR' });
    });
    app.post('/demo/sessions', async (request, reply) => {
      if (request.headers['x-demo-session'] !== '1'
        || request.headers['sec-fetch-site'] === 'cross-site'
        || (request.headers.origin !== undefined
          && request.headers.origin !== (origin ?? `${request.protocol}://${request.host}`))) {
        throw new DemoSessionError('DEMO_SESSION_CSRF_REJECTED', 403, 'Demo session request rejected');
      }
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
