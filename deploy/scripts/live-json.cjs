// Operational backup DTOs only; Workflow/Schema validation stays in TypeScript.
module.exports = (data, mode, project, name, image, version) => {
  const requireValue = value => { if (!value) throw Error('Invalid operational backup observation'); };
  const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const iso = v => typeof v === 'string' && new Date(v).toISOString() === v;
  const evidence = v => v && Object.keys(v).sort().join(',') === 'admissionState,admissionUpdatedAt,configuration,configurationSha256,counts,dataSha256,deploymentVersion,migrations,postgresVersion,result,schemaSha256'
    && v.result === 'PASS' && v.postgresVersion === '18' && v.admissionState === 'WORKFLOW_OPEN' && v.configuration === 'WORKFLOW'
    && /^[A-Za-z0-9._-]{1,80}$/.test(v.deploymentVersion) && iso(v.admissionUpdatedAt)
    && Array.isArray(v.migrations) && v.migrations.length > 0 && v.migrations.every(n => /^\d+_[a-z0-9-]+$/.test(n))
    && v.counts && Object.keys(v.counts).length === 21 && Object.values(v.counts).every(n => Number.isSafeInteger(n) && n >= 0)
    && digest(v.schemaSha256) && digest(v.configurationSha256) && digest(v.dataSha256);
  const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  const identity = v => /^cost-engine-live-backup-[A-Za-z0-9_-]+$/.test(v);
  if (mode === 'live-holder') {
    requireValue(Array.isArray(data) && data.length === 1); const c = data[0];
    requireValue(c.Name === '/' + name && c.Config.Image === 'cost-engine-demo-operator:' + version
      && c.Config.Labels?.['com.docker.compose.project'] === project
      && c.Config.Labels?.['cost-engine.backup.owner'] === image && identity(image)
      && c.Config.Labels?.['cost-engine.backup.purpose'] === 'demo05d3a');
    return;
  }
  if (mode === 'live-snapshot') {
    requireValue(data && Object.keys(data).sort().join(',') === 'evidence,snapshot' && evidence(data.evidence)
      && /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/.test(data.snapshot));
    console.log(data.snapshot); return;
  }
  if (mode === 'live-manifest') {
    requireValue(evidence(data.evidence) && identity(project) && /^[1-9][0-9]*$/.test(name) && digest(image) && iso(version));
    console.log(JSON.stringify({ formatVersion: 1, purpose: 'OPERATIONAL', result: 'BACKUP_CREATED', identity: project,
      fileName: 'backup.dump', sizeBytes: name, sha256: image, startedAt: version, createdAt: new Date().toISOString(), snapshot: data.evidence })); return;
  }
  const manifest = mode === 'live-restore-result' ? data.manifest : data;
  requireValue(manifest && Object.keys(manifest).sort().join(',') === 'createdAt,fileName,formatVersion,identity,purpose,result,sha256,sizeBytes,snapshot,startedAt');
  requireValue(manifest.formatVersion === 1 && manifest.purpose === 'OPERATIONAL' && manifest.result === 'BACKUP_CREATED'
    && manifest.fileName === 'backup.dump' && identity(manifest.identity) && /^[1-9][0-9]*$/.test(manifest.sizeBytes)
    && digest(manifest.sha256) && evidence(manifest.snapshot) && iso(manifest.createdAt) && iso(manifest.startedAt)
    && manifest.startedAt <= manifest.createdAt);
  if (mode === 'live-backup-metadata') {
    requireValue(manifest.identity === project && manifest.sizeBytes === name && manifest.sha256 === image);
    console.log([manifest.snapshot.deploymentVersion, manifest.sha256, manifest.identity].join('|'));
  } else if (mode === 'live-restore-result') {
    requireValue(evidence(data.restored) && same(manifest.snapshot, data.restored));
    console.log(JSON.stringify({ result: 'RESTORE_VERIFIED', purpose: 'OPERATIONAL', backupIdentity: manifest.identity,
      sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, postgresVersion: '18', configuration: 'WORKFLOW', admissionState: 'WORKFLOW_OPEN',
      deploymentVersion: data.restored.deploymentVersion, migrations: data.restored.migrations, schemaSha256: data.restored.schemaSha256,
      configurationSha256: data.restored.configurationSha256, dataSha256: data.restored.dataSha256, counts: data.restored.counts,
      isolation: { container: project, volume: name, database: 'restore_' + image, network: 'none', publishedPorts: 0, cleaned: true } }));
  } else throw Error('Unsupported operational observation');
};
