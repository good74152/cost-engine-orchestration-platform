import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { runReadiness, type ReadinessOptions } from '../src/deployment/recovery-readiness.js';
import { ReadinessError, requireEvidence } from '../src/deployment/readiness-evidence.js';

export function parseReadinessArguments(args: string[]): ReadinessOptions {
  const flags = new Map([['--backup-dir','backupDirectory'],['--drill-dir','drillDirectory'],['--policy-file','policyFile'],
    ['--report-dir','reportDirectory'],['--off-host-evidence-dir','offHostDirectory']]);
  requireEvidence(args.length === 8 || args.length === 10,'UNSAFE_INPUT'); const values: Record<string,string> = {};
  for (let i=0;i<args.length;i+=2) {
    const flag = flags.get(args[i]!), value = args[i+1];
    requireEvidence(flag && value && isAbsolute(value) && !values[flag],'UNSAFE_INPUT'); values[flag] = value;
  }
  requireEvidence(values.backupDirectory && values.drillDirectory && values.policyFile && values.reportDirectory,'UNSAFE_INPUT');
  return values as unknown as ReadinessOptions;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runReadiness(parseReadinessArguments(process.argv.slice(2))))); }
  catch (error) { console.error(error instanceof ReadinessError ? error.message : 'Recovery readiness failed; no report published'); process.exitCode=1; }
}
