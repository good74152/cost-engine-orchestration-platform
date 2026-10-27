import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PublicDemoConfig } from './public-demo-config.js';

/** Fixed windows, bounded keys, no active-key eviction that bypasses limits. */
class WindowLimit {
  private window = -1;
  private readonly counts = new Map<string, number>();
  constructor(private readonly maximum: number, private readonly maxKeys = 4096) {}
  take(key: string): boolean {
    const window = Math.floor(Date.now() / 60000);
    if (window !== this.window) { this.window = window; this.counts.clear(); }
    const count = this.counts.get(key) ?? 0;
    if (count >= this.maximum || (!count && this.counts.size >= this.maxKeys)) return false;
    this.counts.set(key, count + 1); return true;
  }
}

export function installPublicDemoHttp(app: FastifyInstance, config: PublicDemoConfig): void {
  const creates = new WindowLimit(config.createsPerMinute);
  const mutations = new WindowLimit(config.mutationsPerMinute);
  const global = new WindowLimit(config.globalMutationsPerMinute, 1);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // The process-local readiness probe never uses forwarded headers.
    if (request.url === '/health/ready' && request.method === 'GET'
      && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return;
    const key = request.headers['x-demo-proxy-key'];
    const address = request.headers['x-demo-client-ip'];
    if (typeof key !== 'string' || Buffer.byteLength(key) !== Buffer.byteLength(config.proxySecret)
      || !timingSafeEqual(Buffer.from(key), Buffer.from(config.proxySecret))
      || typeof address !== 'string' || !isIP(address)) {
      return reply.code(403).send({ code: 'DEMO_PROXY_REQUIRED', message: 'Demo entry unavailable' });
    }
    if (request.url.startsWith('/demo/') && (request.headers['sec-fetch-site'] === 'cross-site'
      || (request.headers.origin !== undefined && request.headers.origin !== config.origin)
      || (request.method === 'POST' && (request.headers.origin !== config.origin
        || request.headers['x-demo-session'] !== '1')))) {
      return reply.code(403).send({ code: 'DEMO_SESSION_CSRF_REJECTED', message: 'Demo session request rejected' });
    }
    if (request.method === 'POST' && (!global.take('all') || !mutations.take(address)
      || (request.url.split('?')[0] === '/demo/sessions' && !creates.take(address)))) {
      request.log.warn({ event: 'demo_rate_limit', requestId: request.id });
      return reply.header('Retry-After', '60').code(429).send({ code: 'DEMO_RATE_LIMITED', message: 'Demo request limit reached' });
    }
  });
}
