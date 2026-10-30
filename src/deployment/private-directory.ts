import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { drillRejected } from './drill-report.js';

// Shared unchanged 3B directory boundary. Windows operators must provision ACLs.
export function assertPrivateDirectory(path: string): string {
  if (!isAbsolute(path)) throw drillRejected(); const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw drillRejected(); const physical = realpathSync(path);
  if (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid!())) throw drillRejected();
  for (let ancestor = physical; ; ancestor = dirname(ancestor)) {
    try { lstatSync(join(ancestor, '.git')); throw drillRejected(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
  return physical;
}
