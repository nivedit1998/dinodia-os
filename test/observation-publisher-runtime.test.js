const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { MqttBridge } = require('../src/mqttBridge');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { observationPropertiesForDevice } = require('../src/integrations/zigbee/observationPublisher');
const { resolveStateEvidence } = require('../src/observation/stateEvidence');

test('real MQTT inventory/options/report/Store path bootstraps a new unknown-brand thermostat and retains genuine target/temperature', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-observation-bootstrap-'));
  try {
    let now = Date.now();
    const raw = structuredClone(require('./fixtures/zigbee/sonoff-trvzb-observation.json'));
    raw.definition.vendor = 'Unknown manufacturer'; raw.definition.model = 'Capability thermostat';
    const store = new Store(path.join(directory,'store.json')); store.setSyncSourceGeneration(3);
    const d = normalizeZigbeeDevice(raw); d.areaId = 'arbitrary-new-room'; d.setup = {status:'ready'};
    await store.upsertDevice(d);
    const configPath = path.join(directory,'configuration.yaml');
    const sent=[];
    const bridge = new MqttBridge({url:'mqtt://synthetic-only',store,clock:()=>now,observationConfigPath:configPath,logger:{log(){},error(){},warn(){}}});
    bridge.connected=true; bridge.connectionGeneration=1;
    bridge.client={publish(topic,payload,options,cb){sent.push({topic,payload:JSON.parse(payload),options});cb();}};
    const config={advanced:{last_seen:'ISO_8601'},devices:{[raw.ieee_address]:{friendly_name:raw.friendly_name}}};
    const deliver=(topic,payload,packet={retain:false})=>bridge.handleMessage(`zigbee2mqtt/${topic}`,Buffer.from(JSON.stringify(payload)),packet);
    await deliver('bridge/info',{restart_required:false,config});
    await deliver('bridge/devices',[raw],{retain:true});
    assert.equal(sent.length,1);assert.equal(sent[0].topic,'zigbee2mqtt/bridge/request/device/options');
    assert.equal(sent[0].payload.options.optimistic,false);
    const properties=observationPropertiesForDevice(store.getDevice(d.id));
    for(const p of ['running_state','local_temperature','occupied_heating_setpoint'])assert.ok(properties.includes(p));
    Object.assign(config.devices[raw.ieee_address],sent[0].payload.options);
    fs.writeFileSync(configPath,['advanced:','  last_seen: ISO_8601','devices:',`  '${raw.ieee_address}':`,
      `    friendly_name: ${raw.friendly_name}`,'    optimistic: false','    filtered_cache:',...properties.map(p=>`      - ${p}`),''].join('\n'));
    await deliver('bridge/info',{restart_required:false,config});
    await deliver(raw.friendly_name,{occupied_heating_setpoint:35,local_temperature:30,running_state:'heat',last_seen:new Date(now).toISOString()});
    assert.ok(Object.values(store.getDevice(d.id).entities).every(e=>!e.sourceObservedAt),'cache flush does not fabricate observations');
    now+=1000;
    await deliver(raw.friendly_name,{occupied_heating_setpoint:19,local_temperature:22.1,running_state:'idle',last_seen:new Date(now).toISOString()});
    const saved=store.getDevice(d.id);
    for(const [property,value] of [['occupied_heating_setpoint',19],['local_temperature',22.1],['running_state','idle']]) {
      const entity=Object.values(saved.entities).find(e=>e.stateKey===property);
      assert.equal(entity.sourceObservedAt,new Date(now).toISOString());
      assert.equal(entity.lastReported.value,value);
    }
    const entity=Object.values(saved.entities).find(e=>e.stateKey==='occupied_heating_setpoint');
    const result=resolveStateEvidence({device:saved,entity,control:{controlId:entity.capability.controlId,semanticRole:'target_temperature',valueType:'number',constraints:{minimum:5,maximum:35}},
      sourceGeneration:3,authorityValid:true,clockTrusted:true,now});
    assert.equal(result.lastReported.value,19);assert.notEqual(result.quality,'fresh','publisher options do not invent a reporting guarantee');
    const originalTime=entity.sourceObservedAt;
    await deliver(raw.friendly_name,{occupied_heating_setpoint:35,last_seen:new Date(now-1).toISOString()});
    assert.equal(Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint').lastReported.value,19,'an older differing report cannot replace the latest genuine value');
    assert.equal(Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint').sourceObservedAt,originalTime);
    const update=store.updateDeviceState.bind(store);
    let newerCommitted;
    const committed=new Promise(resolve=>{newerCommitted=resolve;});
    store.updateDeviceState=async(id,state,options)=>{
      if(state.occupied_heating_setpoint===18)await committed;
      const updated=await update(id,state,options);
      if(state.occupied_heating_setpoint===20)newerCommitted();
      return updated;
    };
    now+=3000;
    await Promise.all([
      deliver(raw.friendly_name,{occupied_heating_setpoint:20,last_seen:new Date(now).toISOString()}),
      deliver(raw.friendly_name,{occupied_heating_setpoint:18,last_seen:new Date(now-1).toISOString()}),
    ]);
    store.updateDeviceState=update;
    assert.equal(Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint').state,20,'overlapping handlers cannot apply an older differing value after a newer commit');
    assert.equal(Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint').sourceObservedAt,new Date(now).toISOString());
    bridge.publisherObservation.reset();
    now+=1000;
    await deliver(raw.friendly_name,{occupied_heating_setpoint:30,last_seen:new Date(now).toISOString()});
    assert.equal(Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint').lastReported.value,20,'local YAML alone after reconnect cannot admit new values');
    now+=1000;
    await deliver(raw.friendly_name,{occupied_heating_setpoint:35,last_seen:new Date(now).toISOString()},{retain:true});
    assert.equal(Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint').lastReported.value,20);
    assert.equal(sent.length,1,'no actuator command, device read or reporting write is generated');
    await store.writeQueue;
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('lights do not need radiator-only fields to timestamp their exact on/off and brightness observations',async()=>{
  const {readObservationConfiguration}=require('../src/integrations/zigbee/observationContract');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dinodia-light-publisher-'));
  try {
    const file=path.join(directory,'config.yaml');
    fs.writeFileSync(file,"advanced:\n  last_seen: ISO_8601\ndevices:\n  '0x0011223344556677':\n    optimistic: false\n    filtered_cache: [state_l1, state_l2, brightness_l1]\n");
    const r=await readObservationConfiguration(file,{ieeeAddress:'0x0011223344556677'},{includeProperties:true,properties:null});
    assert.equal(r.ok,true);assert.deepEqual(r.properties,['state_l1','state_l2','brightness_l1']);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
