import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CalculationJobError } from '../calculation-job.errors.js';
import { DatasetVersionError } from '../dataset-version/dataset-version.errors.js';
import { DemoResourceUnavailableError, DemoSessionError } from './demo-session.errors.js';
import { LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE } from './demo-session.service.js';

export interface DemoSessionRouteOptions {
  nodeEnvironment?: string;
  secureCookies?: boolean;
  origin?: string;
}

/** Shared by session creation and every protected Demo mutation. */
export class DemoHttpSecurity {
  readonly secure: boolean;
  readonly cookieName: string;
  private readonly origin: string | undefined;

  constructor(options: DemoSessionRouteOptions = {}) {
    const environments = [options.nodeEnvironment, process.env.NODE_ENV].filter((e) => e !== undefined);
    const local = environments.length > 0 && environments.every((e) => ['development', 'test'].includes(e));
    if (options.secureCookies === false && !local) throw new Error('Insecure demo cookies require development/test');
    this.secure = options.secureCookies ?? !local;
    this.cookieName = this.secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE;
    this.origin = options.origin === undefined ? undefined : new URL(options.origin).origin;
    if (this.origin && !/^https?:\/\//.test(this.origin)) throw new Error('Invalid demo browser origin');
  }

  assertMutation(request: FastifyRequest): void {
    this.assertSameOrigin(request);
    if (request.headers['x-demo-session'] !== '1') {
      throw new DemoSessionError('DEMO_SESSION_CSRF_REJECTED', 403, 'Demo session request rejected');
    }
  }

  assertSameOrigin(request: FastifyRequest): void {
    if (request.headers['sec-fetch-site'] === 'cross-site'
      || (request.headers.origin !== undefined
        && request.headers.origin !== (this.origin ?? `${request.protocol}://${request.host}`))) {
      throw new DemoSessionError('DEMO_SESSION_CSRF_REJECTED', 403, 'Demo session request rejected');
    }
  }

  clearCookie(reply: FastifyReply): void {
    reply.header('Set-Cookie', `${this.cookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`);
  }
}

export function installDemoErrorBoundary(app: FastifyInstance, domainErrors = false, policy?: DemoHttpSecurity): void {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    if (domainErrors && (error instanceof CalculationJobError || error instanceof DatasetVersionError)) {
      if (error.statusCode === 404) {
        const unavailable = new DemoResourceUnavailableError();
        return reply.status(404).send({ message: unavailable.message, code: unavailable.code });
      }
      return reply.status(error.statusCode).send({ message: error.message, code: error.code });
    }
    if (error instanceof DemoSessionError) {
      if (error.code === 'DEMO_SESSION_UNAVAILABLE' && error.statusCode === 401) policy?.clearCookie(reply);
      return reply.status(error.statusCode).send({ message: error.message, code: error.code });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 413 || status === 415) {
      return reply.status(status).send({ message: 'Invalid request', code: 'INVALID_REQUEST' });
    }
    // Never serialize arbitrary credential/SQL-bearing errors or request headers.
    request.log.error({ event: 'demo_request_internal_failure', requestId: request.id });
    return reply.status(500).send({ message: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR' });
  });
}

export function exactDemoBody(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)
    || Object.keys(body).length !== keys.length || Object.keys(body).some((key) => !keys.includes(key))) {
    throw new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');
  }
  return body as Record<string, unknown>;
}
