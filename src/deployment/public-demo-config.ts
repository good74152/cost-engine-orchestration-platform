import { readFileSync } from 'node:fs';

export interface PublicDemoConfig {
  origin: string;
  proxySecret: string;
  version: string;
  activeSessions: number;
  retainedSessions: number;
  executors: number;
  bodyBytes: number;
  createsPerMinute: number;
  mutationsPerMinute: number;
  globalMutationsPerMinute: number;
  maintenanceIntervalMs: number;
  maintenanceBatch: number;
}

/** Only process entry points read mounted secrets; never print file contents. */
export function loadDeploymentSecrets(env = process.env): void {
  for (const name of ['DATABASE_URL', 'DEMO_PROXY_SECRET'] as const) {
    const file = env[`${name}_FILE`];
    if (file) {
      if (env[name]) throw new Error(`Conflicting ${name} configuration`);
      try { env[name] = readFileSync(file, 'utf8').trim(); }
      catch { throw new Error(`Cannot read ${name} secret`); }
    }
  }
}

/** A profile is never inferred merely from NODE_ENV or an injected executor. */
export function publicDemoConfig(env = process.env): PublicDemoConfig | undefined {
  if (env.DEMO_PUBLIC_ENABLED === undefined || env.DEMO_PUBLIC_ENABLED === 'false') {
    if (env.NODE_ENV === 'production' && env.APP_MODE === 'demo') throw new Error('Demo production requires explicit public profile');
    return undefined;
  }
  const invalid = () => new Error('Invalid restricted public Demo configuration');
  if (env.DEMO_PUBLIC_ENABLED !== 'true' || env.NODE_ENV !== 'production'
    || env.APP_MODE !== 'demo' || env.EXECUTOR_TYPE !== 'fake') throw invalid();
  let origin: URL; let database: URL;
  try { origin = new URL(env.DEMO_PUBLIC_ORIGIN!); database = new URL(env.DATABASE_URL!); }
  catch { throw invalid(); }
  if (origin.protocol !== 'https:' || origin.origin !== env.DEMO_PUBLIC_ORIGIN
    || origin.username || origin.password || !origin.hostname
    || !['postgres:', 'postgresql:'].includes(database.protocol)
    || !database.username || decodeURIComponent(database.password).length < 16
    || !database.hostname || !database.pathname.slice(1)
    || !/^[a-f0-9]{64,128}$/.test(env.DEMO_PROXY_SECRET ?? '')
    || !/^[A-Za-z0-9._-]{1,80}$/.test(env.DEPLOYMENT_VERSION ?? '')) throw invalid();
  const integer = (name: string, fallback: number, max: number, min = 1) => {
    const raw = env[name] ?? String(fallback);
    if (!/^[0-9]+$/.test(raw)) throw invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
    return value;
  };
  const activeSessions = integer('DEMO_MAX_ACTIVE_SESSIONS', 100, 1000);
  const retainedSessions = integer('DEMO_MAX_RETAINED_SESSIONS', 10000, 1000000);
  const executors = integer('DEMO_MAX_EXECUTORS', 100, 1000);
  if (retainedSessions < activeSessions || executors > activeSessions) throw invalid();
  return Object.freeze({
    origin: origin.origin, proxySecret: env.DEMO_PROXY_SECRET!, version: env.DEPLOYMENT_VERSION!,
    activeSessions, retainedSessions, executors,
    bodyBytes: integer('DEMO_BODY_BYTES', 16384, 65536),
    createsPerMinute: integer('DEMO_CREATES_PER_MINUTE', 10, 100),
    mutationsPerMinute: integer('DEMO_MUTATIONS_PER_MINUTE', 120, 1000),
    globalMutationsPerMinute: integer('DEMO_GLOBAL_MUTATIONS_PER_MINUTE', 600, 5000),
    maintenanceIntervalMs: integer('DEMO_MAINTENANCE_INTERVAL_MS', 60000, 3600000, 1000),
    maintenanceBatch: integer('DEMO_MAINTENANCE_BATCH', 25, 100),
  });
}
