const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../src/store');
const {normalizeZigbeeDevice}=require('../src/integrations/zigbee/exposeNormalizer');
const {MqttBridge}=require('../src/mqttBridge');
const {mergeObservationConfiguration}=require('../src/integrations/zigbee/observationConfigPatch');

test('actual normalized thermostat reports advance observation revision, not metadata or cache updates',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-command-observation-'));
  try {
    const store=new Store(path.join(directory,'store.json'));
    const fixture=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/zigbee/sonoff-trvzb-observation.json'),'utf8'));
    const d=normalizeZigbeeDevice(fixture);
    await store.upsertDevice(d);
    const property='occupied_heating_setpoint';
    const entity=()=>Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey===property);
    const before=entity().stateRevision||0;
    const at=new Date(Date.now()-2000).toISOString();
    await store.updateDeviceState(d.id,{[property]:21},{protocol:'zigbee',reportedStateKeys:[property],
      sourceObservedAtByStateKey:{[property]:at},sourceReceivedAtByStateKey:{[property]:at}});
    assert.equal(entity().stateRevision,before+1);
    await store.upsertDevice({...store.getDevice(d.id),name:'Metadata only'});
    assert.equal(entity().stateRevision,before+1);
    await store.updateDeviceState(d.id,{battery:80},{protocol:'zigbee',reportedStateKeys:['battery']});
    assert.equal(entity().stateRevision,before+1);
    const newer=new Date(Date.now()-1000).toISOString();
    await store.updateDeviceState(d.id,{[property]:21},{protocol:'zigbee',reportedStateKeys:[property],
      sourceObservedAtByStateKey:{[property]:newer},sourceReceivedAtByStateKey:{[property]:newer}});
    assert.equal(entity().stateRevision,before+2,'a genuinely newer identical physical report is new evidence');
    await store.updateDeviceState(d.id,{[property]:22},{protocol:'zigbee',reportedStateKeys:[property]});
    assert.equal(entity().stateRevision,before+2,'an unproved composed/cache update is not a physical observation');
    assert.equal(entity().sourceObservedAt,null);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});

test('actual MQTT control evidence requires that exact control property to be excluded from composed cache',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-command-mqtt-'));
  try {
    const store=new Store(path.join(directory,'store.json'));
    const fixture=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/zigbee/sonoff-trvzb-observation.json'),'utf8'));
    const d=normalizeZigbeeDevice(fixture);await store.upsertDevice(d);
    const property='occupied_heating_setpoint';
    const configPath=path.join(directory,'configuration.yaml');
    const identity={friendlyName:fixture.friendly_name,ieeeAddress:fixture.ieee_address};
    const original=`advanced:\n  last_seen: ISO_8601\ndevices:\n  '${identity.ieeeAddress}':\n    friendly_name: ${identity.friendlyName}\n    optimistic: false\n    filtered_cache: [running_state, local_temperature]\n`;
    await fs.writeFile(configPath,original);
    const bridge=new MqttBridge({url:'',store,observationConfigPath:configPath,logger:{log(){},error(){}}});
    const report=async(time,retain=false)=>bridge.handleMessage(`zigbee2mqtt/${identity.friendlyName}`,Buffer.from(JSON.stringify({[property]:21,last_seen:time})),{retain});
    const entity=()=>Object.values(store.getDevice(d.id).entities).find(e=>e.stateKey===property);
    await report(new Date(Date.now()-3000).toISOString());
    assert.equal(entity().sourceObservedAt,null,'cached setpoint cannot confirm an action');
    const merged=mergeObservationConfiguration(original,{...identity,additionalProperties:[property]});
    assert.equal(mergeObservationConfiguration(merged,{...identity,additionalProperties:[property]}),merged);
    await fs.writeFile(configPath,merged);
    const at=new Date(Date.now()-2000).toISOString();await report(at);
    assert.equal(entity().sourceObservedAt,at);
    assert.equal(entity().stateRevision,1);
    await report(new Date(Date.now()-1000).toISOString(),true);
    assert.equal(entity().stateRevision,1,'retained replay cannot renew control evidence');
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
