import { DemoSessionError } from './demo-session.errors.js';

export const DEMO_READ_MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const validResourceId = (id: string): boolean => UUID.test(id);
type Kind = 'datasets' | 'jobs' | 'attempts';
export interface ReadPage { limit: number; after: string | number | null }
const invalid = () => new DemoSessionError('INVALID_REQUEST', 400, 'Invalid request');

export function readPage(query: unknown, kind: Kind, scope: string): ReadPage {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const values = query as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== 'limit' && key !== 'cursor')) throw invalid();
  const rawLimit = values.limit ?? '20';
  if (typeof rawLimit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(rawLimit)) throw invalid();
  const limit = Number(rawLimit);
  if (limit > DEMO_READ_MAX_LIMIT) throw invalid();
  if (values.cursor === undefined) return { limit, after: null };
  const cursor = values.cursor;
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  try {
    const buffer = Buffer.from(cursor, 'base64url');
    if (buffer.toString('base64url') !== cursor) throw invalid();
    const decoded: unknown = JSON.parse(buffer.toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw invalid();
    const item = decoded as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'after,kind,scope,v'
      || item.v !== 1 || item.kind !== kind || item.scope !== scope) throw invalid();
    if (kind === 'attempts' ? typeof item.after !== 'number' || !Number.isInteger(item.after)
      || item.after < 1 || item.after > 2147483647
      : typeof item.after !== 'string' || !validResourceId(item.after)) throw invalid();
    return { limit, after: item.after as string | number };
  } catch { throw invalid(); }
}

export function publicPage<T>(rows: T[], page: ReadPage, kind: Kind, scope: string, key: (row: T) => string | number) {
  const items = rows.slice(0, page.limit);
  const nextCursor = rows.length > page.limit
    ? Buffer.from(JSON.stringify({ v: 1, kind, scope, after: key(items[items.length - 1]!) })).toString('base64url') : null;
  return { items, nextCursor };
}
