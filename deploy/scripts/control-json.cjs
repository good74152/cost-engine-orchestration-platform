// Deployment DTO/Container checks only. Configuration truth stays in the existing
// Cutover Status Operator; no financial/configuration validator is duplicated.
const fs = require('node:fs');
const [mode, project, name, image, version] = process.argv.slice(2);
const requireValue = value => { if (!value) throw Error('Invalid deployment observation'); };
try {
  const data = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (mode === 'config') {
    const {database: d, backend: b, web: w, operator: o} = data.services;
    const v = b.environment.DEPLOYMENT_VERSION;
    requireValue(/^[A-Za-z0-9._-]{1,80}$/.test(v) && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(data.name));
    requireValue(typeof b.container_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,128}$/.test(b.container_name));
    for (const [service, target] of [[b,'backend'],[w,'web'],[o,'operator']]) requireValue(service.image === `cost-engine-demo-${target}:${v}`);
    requireValue(d.image === 'postgres:18' && !d.ports?.length && !b.ports?.length && data.networks.database.internal && data.networks.proxy.internal);
    requireValue(!d.network_mode && !b.network_mode && !w.network_mode && !o.network_mode);
    requireValue(Object.keys(d.networks).sort().join(',') === 'database' && Object.keys(b.networks).sort().join(',') === 'database,proxy');
    requireValue(Object.keys(w.networks).sort().join(',') === 'edge,proxy' && Object.keys(o.networks).sort().join(',') === 'database');
    requireValue(b.restart === 'no' && w.restart === 'no' && w.profiles?.includes('public-web') && o.profiles?.includes('operations'));
    requireValue(b.read_only && b.cap_drop.includes('ALL') && b.security_opt.includes('no-new-privileges:true'));
    requireValue((b.deploy?.replicas ?? 1) === 1 && b.depends_on.database.condition === 'service_healthy');
    requireValue(b.environment.APP_MODE === 'demo' && b.environment.NODE_ENV === 'production' && b.environment.DEMO_PUBLIC_ENABLED === 'true');
    const origin = new URL(b.environment.DEMO_PUBLIC_ORIGIN);
    requireValue(origin.protocol === 'https:' && origin.origin === b.environment.DEMO_PUBLIC_ORIGIN && !origin.username && !origin.password);
    requireValue(w.environment.DEMO_PUBLIC_ORIGIN === origin.origin && typeof w.environment.ACME_EMAIL === 'string' && w.environment.ACME_EMAIL.includes('@'));
    for (const service of [b,o]) {
      requireValue(service.environment.DATABASE_URL_FILE === '/run/secrets/database_url' && !service.environment.DATABASE_URL);
      requireValue(service.secrets.some(s => s.source === 'database_url' && ['database_url','/run/secrets/database_url'].includes(s.target)));
    }
    console.log([v,data.name,b.container_name,b.image,w.image].join('|'));
  } else if (mode === 'workflow-status') {
    requireValue(data && !Array.isArray(data) && Object.keys(data).sort().join(',') === 'configuration,state,updatedAt');
    requireValue(data.state === 'WORKFLOW_OPEN' && data.configuration === 'WORKFLOW');
    requireValue(typeof data.updatedAt === 'string' && new Date(data.updatedAt).toISOString() === data.updatedAt);
    console.log('WORKFLOW_CONFIRMED');
  } else {
    requireValue(Array.isArray(data));
    const inactive = c => !c.State.Running && !c.State.Restarting && !c.State.Paused && ['exited','dead','created'].includes(c.State.Status);
    for (const c of data) requireValue(c.Config.Labels['com.docker.compose.project'] === project);
    if (mode === 'stopped') {
      requireValue(data.every(c => inactive(c) && c.HostConfig.RestartPolicy.Name === 'no'));
    } else {
      requireValue(data.length <= 1);
      for (const c of data) requireValue(c.Name === '/'+name && c.Config.Labels['com.docker.compose.service'] === 'backend');
      if (mode === 'offline') requireValue(data.every(c => inactive(c) && c.HostConfig.RestartPolicy.Name === 'no'));
      else if (mode === 'backend-state') console.log(data[0]?.State.Running ? 'RUNNING' : 'STOPPED');
      else if (mode === 'backend') {
        const c = data[0]; requireValue(c && c.State.Running && !c.State.Paused && c.State.Health?.Status === 'healthy');
        requireValue(c.HostConfig.RestartPolicy.Name === 'no' && c.Config.Image === image);
        requireValue(c.Config.Env.includes('DEPLOYMENT_VERSION='+version));
      } else throw Error('Unsupported observation');
    }
  }
} catch { console.error('Deployment observation rejected; verify state and compatibility privately'); process.exitCode = 1; }
