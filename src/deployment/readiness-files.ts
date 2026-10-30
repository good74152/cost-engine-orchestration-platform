import { constants } from 'node:fs';
import { lstat, open, opendir, mkdir, rename, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertPrivateDirectory } from './private-directory.js';
import { ReadinessError, requireEvidence } from './readiness-evidence.js';

// Limits reject the entire assessment. No partial/truncated success is emitted.
export const readinessLimits = Object.freeze({ entries: 1000, jsonBytes: 32 * 1024 * 1024,
  manifestBytes: 65536, drillBytes: 8 * 1024 * 1024, offHostBytes: 32768, policyBytes: 65536,
  archiveBytes: 64 * 1024 ** 3, totalArchiveBytes: 256 * 1024 ** 3 });
export class ReadBudget {
  private entries = 0; private json = 0; private archives = 0;
  entry() { requireEvidence(++this.entries <= readinessLimits.entries, 'RESOURCE_LIMIT'); }
  bytes(size: number, kind: 'json' | 'archive', max: number) {
    requireEvidence(Number.isSafeInteger(size) && size >= 0 && size <= max, 'RESOURCE_LIMIT');
    if (kind === 'json') requireEvidence((this.json += size) <= readinessLimits.jsonBytes, 'RESOURCE_LIMIT');
    else requireEvidence((this.archives += size) <= readinessLimits.totalArchiveBytes, 'RESOURCE_LIMIT');
  }
}
export function privateDirectory(path: string): string {
  try { return assertPrivateDirectory(path); } catch { throw new ReadinessError('UNSAFE_INPUT'); }
}
export async function* entries(root: string, budget: ReadBudget): AsyncGenerator<string> {
  try {
    const directory = await opendir(root);
    for await (const entry of directory) { budget.entry(); yield entry.name; }
  } catch (e) { if (e instanceof ReadinessError) throw e; throw new ReadinessError('INPUT_UNREADABLE'); }
}
function stable(a: Awaited<ReturnType<FileHandle['stat']>>, b: Awaited<ReturnType<FileHandle['stat']>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function readProtected<T>(path: string, budget: ReadBudget, kind: 'json' | 'archive', max: number,
  read: (file: FileHandle, size: number) => Promise<T>): Promise<T> {
  let file: FileHandle | undefined;
  try {
    const before = await lstat(path);
    requireEvidence(before.isFile() && !before.isSymbolicLink() && (process.platform === 'win32'
      || ((before.mode & 0o077) === 0 && before.uid === process.getuid!())), 'UNSAFE_INPUT');
    budget.bytes(before.size, kind, max);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    requireEvidence(stable(before, await file.stat()), 'UNSAFE_INPUT');
    const result = await read(file, before.size);
    requireEvidence(stable(before, await file.stat()) && stable(before, await lstat(path)), 'UNSAFE_INPUT'); return result;
  } catch (e) {
    if (e instanceof ReadinessError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ReadinessError('UNSAFE_INPUT');
    throw new ReadinessError('INPUT_UNREADABLE');
  } finally { await file?.close(); }
}
export async function readJson(path: string, max: number, budget: ReadBudget) {
  return readProtected(path, budget, 'json', max, async (file, size) => {
    const bytes = Buffer.alloc(size), result = await file.read(bytes, 0, size, 0);
    requireEvidence(result.bytesRead === size, 'INPUT_UNREADABLE');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ReadinessError('UNSAFE_INPUT'); }
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}
export async function archiveIntegrity(path: string, budget: ReadBudget, tick: () => unknown) {
  return readProtected(path, budget, 'archive', readinessLimits.archiveBytes, async (file, size) => {
    const buffer = Buffer.alloc(65536), hash = createHash('sha256'); let offset = 0;
    while (offset < size) {
      tick(); const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      requireEvidence(bytesRead > 0, 'INPUT_UNREADABLE');
      if (offset === 0) requireEvidence(bytesRead >= 5 && buffer.subarray(0,5).toString('ascii') === 'PGDMP', 'ARCHIVE_INTEGRITY_FAILED');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    requireEvidence(size >= 5, 'ARCHIVE_INTEGRITY_FAILED'); return { sizeBytes: String(size), sha256: hash.digest('hex') };
  });
}

/** New exclusive 0700 directory makes the atomic final rename non-overwriting.
 * Only this invocation's known partial file and empty owned directory are removed. */
export async function publishReadiness(root: string, id: string, report: unknown, tick: () => unknown): Promise<void> {
  requireEvidence(/^readiness-[a-f0-9]{32}$/.test(id), 'REPORT_WRITE_FAILED');
  const directory = join(root,id), partial = join(directory,'report.json.partial'); let owned = false, partialOwned = false;
  let identity: { dev: number; ino: number } | undefined;
  try {
    requireEvidence(privateDirectory(root) === root, 'REPORT_WRITE_FAILED');
    await mkdir(directory, { mode: 0o700 }); owned = true; identity = await lstat(directory); privateDirectory(directory);
    const file = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); partialOwned = true;
    try { await file.writeFile(JSON.stringify(report) + '\n'); await file.sync(); } finally { await file.close(); }
    tick(); const current = await lstat(directory);
    requireEvidence(current.dev === identity.dev && current.ino === identity.ino && privateDirectory(root) === root, 'REPORT_WRITE_FAILED');
    await rename(partial, join(directory,'report.json')); partialOwned = false; owned = false;
  } catch {
    if (owned && identity) {
      try {
        const current = await lstat(directory);
        if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
          if (partialOwned) await unlink(partial); await rmdir(directory);
        }
      } catch { /* Unknown/replaced resources are left for private Owner inspection. */ }
    }
    throw new ReadinessError('REPORT_WRITE_FAILED');
  }
}
