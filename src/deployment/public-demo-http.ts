import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PublicDemoConfig } from './public-demo-config.js';

/** Fixed windows, bounded keys, no active-key eviction that bypasses limits. */
class WindowLimit {
  private window = -1;
  private readonly counts = new Map<string, number>();
  constructor(private readonly maximum: number, private readonly maxKeys = 4096) {}
  available(key: string, window: number): boolean {
    if (window !== this.window) { this.window = window; this.counts.clear(); }
    const count = this.counts.get(key) ?? 0;
    return count < this.maximum && (count > 0 || this.counts.size < this.maxKeys);
  }
  consume(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

export function installPublicDemoHttp(app: FastifyInstance, config: PublicDemoConfig, now = Date.now): void {
  const creates = new WindowLimit(config.createsPerMinute);
  const mutations = new WindowLimit(config.mutationsPerMinute);
  const global = new WindowLimit(config.globalMutationsPerMinute, 1);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const path = request.url.split('?')[0]!;
    // DB health is internal only. Caddy does not proxy these paths; enforce the
    // same boundary here even for an authenticated proxy or spoofed IP headers.
    if (path === '/health' || path.startsWith('/health/')) {
      if (path === '/health/ready' && request.method === 'GET'
        && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return;
      return reply.code(404).send();
    }
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
    if (request.method === 'POST') {
      const window = Math.floor(now() / 60000);
      const creation = path === '/demo/sessions';
      // Check local budgets before global. Charge only admitted requests, with
      // no await between checks and consumption in this single-instance runtime.
      if ((creation && !creates.available(address, window)) || !mutations.available(address, window)
        || !global.available('all', window)) {
        request.log.warn({ event: 'demo_rate_limit', requestId: request.id });
        return reply.header('Retry-After', '60').code(429).send({ code: 'DEMO_RATE_LIMITED', message: 'Demo request limit reached' });
      }
      if (creation) creates.consume(address);
      mutations.consume(address);
      global.consume('all');
    }
  });
}
