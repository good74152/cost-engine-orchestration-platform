export type AppMode = 'core' | 'demo';

export function resolveAppMode(configured?: string, runtime = process.env.APP_MODE): AppMode {
  for (const value of [configured, runtime]) {
    if (value !== undefined && value !== 'core' && value !== 'demo') {
      throw new Error('APP_MODE must be core or demo');
    }
  }
  if (configured !== undefined && runtime !== undefined && configured !== runtime) {
    throw new Error('Conflicting APP_MODE configuration');
  }
  return (configured ?? runtime ?? 'core') as AppMode;
}
