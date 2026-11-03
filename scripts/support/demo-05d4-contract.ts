export const scenarios = ['happy-path','backend-startup-failure'] as const;
export type Scenario = typeof scenarios[number];
export function check(v:unknown): asserts v { if(!v)throw Error('Rehearsal assertion failed'); }
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');

/** Checks the effective Compose model, on top of the production checks in control-json.cjs. */
export function assertRehearsalConfig(c:any,project:string,port:number){
  check(c.name===project&&exact(c.services,['database','backend','web','operator']));
  check(c.services.backend.container_name===project+'-backend'&&c.services.backend.restart==='no'&&c.services.web.restart==='no');
  check(!c.services.backend.ports?.length&&!c.services.database.ports?.length&&!c.services.operator.ports?.length);
  for(const s of Object.values(c.services)as any[])check(!s.network_mode&&!s.privileged);
  check(c.services.database.image==='postgres:18'&&c.networks.database.internal===true&&c.networks.proxy.internal===true);
  check(c.services.web.environment.DEMO_TLS_DIRECTIVE==='tls internal'&&c.services.web.environment.DEMO_PUBLIC_ORIGIN==='https://localhost:'+port
    &&c.services.backend.environment.DEMO_PUBLIC_ORIGIN==='https://localhost:'+port);
  check(c.services.database.volumes.length===1&&c.services.database.volumes[0].type==='volume'
    &&c.services.database.volumes[0].source==='postgres_data'&&c.services.database.volumes[0].target==='/var/lib/postgresql');
  const ports=c.services.web.ports;check(Array.isArray(ports)&&ports.length===2);
  for(const protocol of ['tcp','udp'])check(ports.some((p:any)=>p.host_ip==='127.0.0.1'&&p.protocol===protocol&&p.target===port&&Number(p.published)===port));
  for(const v of Object.values({...c.volumes,...c.networks})as any[])check(!v.external);
}
export function assertRuntimePorts(c:any,service:string,port:number){
  const bindings=c.HostConfig.PortBindings??{}, actual=c.NetworkSettings.Ports??{};
  if(service!=='web'){check(Object.keys(bindings).length===0&&Object.values(actual).every(v=>v===null));return;}
  for(const ports of [bindings,actual]){
    const active=Object.entries(ports).filter(([,v])=>v!==null);check(active.length===2);
    for(const protocol of ['tcp','udp']){
      const list=ports[port+'/'+protocol];check(Array.isArray(list)&&list.length===1&&list[0].HostIp==='127.0.0.1'&&list[0].HostPort===String(port));
    }
  }
}
