const test=require('node:test');
const assert=require('node:assert/strict');
const {PublisherObservationSetup,observationPropertiesForDevice}=require('../src/integrations/zigbee/observationPublisher');
function device(id='zigbee:0011223344556677',properties=['state_l1','state_l2','temperature']) {
  return {id,protocol:'zigbee',metadata:{ieee_address:`0x${id.slice(7)}`},entities:Object.fromEntries(properties.map(property=>[property,
    {stateKey:property,capability:{readable:true,observable:true,kind:'number'}}]))};
}
function fixture(devices=[device()]) {
  let now=100000;const sent=[];
  const setup=new PublisherObservationSetup({devices:()=>devices,publish:async(path,payload)=>sent.push({path,payload}),clock:()=>now});
  const info={restart_required:false,config:{advanced:{last_seen:'ISO_8601'},devices:Object.fromEntries(devices.map(d=>[d.metadata.ieee_address,{friendly_name:d.id,filtered_cache:['^battery$']}]))}};
  return{setup,sent,devices,info,advance:ms=>now+=ms};
}
test('unknown manufacturers and multi-endpoint capabilities get local publisher options automatically, without actuator/reporting requests',async()=>{
  const f=fixture();await f.setup.onInfo(f.info);await f.setup.reconcile();
  assert.equal(f.sent.length,1);const r=f.sent[0];assert.equal(r.path,'device/options');
  assert.equal(r.payload.id,f.devices[0].metadata.ieee_address);
  assert.deepEqual(r.payload.options,{optimistic:false,filtered_cache:['^battery$','state_l1','state_l2','temperature']});
  await f.setup.reconcile();assert.equal(f.sent.length,1,'no duplicate while acknowledgement/info is pending');
  f.info.config.devices[r.payload.id]={...f.info.config.devices[r.payload.id],...r.payload.options};
  await f.setup.onInfo(f.info);await f.setup.reconcile();assert.equal(f.sent.length,1,'effective options are idempotent');
  assert.equal(f.setup.admit(f.devices[0].id,new Date(100000).toISOString()),false,'first live packet flushes old publisher cache');
  assert.equal(f.setup.admit(f.devices[0].id,new Date(100001).toISOString()),true);
  assert.equal(f.sent.every(r=>['device/options','options'].includes(r.path)),true);
});
test('global timestamp option bootstraps once; errors back off; restart-required never grants observation trust',async()=>{
  const f=fixture();f.info.config.advanced.last_seen='disable';await f.setup.onInfo(f.info);await f.setup.reconcile();
  assert.deepEqual(f.sent[0].payload.options,{advanced:{last_seen:'ISO_8601'}});
  await f.setup.onResponse('options',{transaction:f.sent[0].payload.transaction,status:'error'});
  await f.setup.reconcile();assert.equal(f.sent.length,1);
  f.advance(60000);await f.setup.reconcile();assert.equal(f.sent.length,2);
  f.info.restart_required=true;f.info.config.advanced.last_seen='ISO_8601';await f.setup.onInfo(f.info);
  assert.equal(f.setup.admit(f.devices[0].id,new Date(200000).toISOString()),false);
});
test('properties follow exact supported entities, never category, room or manufacturer; write-only and metadata are excluded',()=>{
  const d=device();d.entities.command={stateKey:'command',capability:{readable:false,observable:true}};
  d.entities.action={stateKey:'action',capability:{readable:true,observable:true,kind:'event'}};
  d.entities.unsafe={stateKey:'../set',capability:{readable:true,observable:true}};
  assert.deepEqual(observationPropertiesForDevice(d),['state_l1','state_l2','temperature']);
  assert.deepEqual(observationPropertiesForDevice({...d,retired:true}),[]);
});
test('new devices are reconciled after inventory changes; removed devices and stale replies cannot be configured',async()=>{
  const f=fixture([]);await f.setup.onInfo(f.info);await f.setup.reconcile();assert.equal(f.sent.length,0);
  f.devices.push(device());f.info.config.devices[f.devices[0].metadata.ieee_address]={friendly_name:'new'};
  await f.setup.onInfo(f.info);await f.setup.reconcile();assert.equal(f.sent.length,1);
  f.devices.splice(0);f.advance(60000);await f.setup.onResponse('device/options',{status:'ok',transaction:f.sent[0].payload.transaction});
  await f.setup.reconcile();assert.equal(f.sent.length,1);
});
test('connection reset drops effective proof and cache warmup; only newer non-replayed observations become eligible',async()=>{
  const f=fixture();f.info.config.devices[f.devices[0].metadata.ieee_address]={optimistic:false,filtered_cache:['state_l1','state_l2','temperature']};
  await f.setup.onInfo(f.info);assert.equal(f.setup.admit(f.devices[0].id,new Date(99999).toISOString()),false);
  assert.equal(f.setup.admit(f.devices[0].id,new Date(100000).toISOString()),false);
  assert.equal(f.setup.admit(f.devices[0].id,new Date(100000).toISOString()),false,'same timestamp is still a replay of the cache flush');
  assert.equal(f.setup.admit(f.devices[0].id,new Date(100001).toISOString()),true);
  f.setup.reset();assert.equal(f.setup.admit(f.devices[0].id,new Date(100002).toISOString()),false);
});
