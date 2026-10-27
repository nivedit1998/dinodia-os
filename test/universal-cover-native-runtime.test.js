const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createHub} = require('../src/server');
const {normalizeZigbeeDevice} = require('../src/integrations/zigbee/exposeNormalizer');

test('tenant descriptor routes explicitly advertised cover OPEN once to the exact source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-cover-native-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const calls = [];
  const mock = () => ({start(){},stop(){},close(){},status(){return {configured:false,connected:false};}});
  const mqtt = {...mock(), command: async (id, payload) => {calls.push({id,payload});}};
  const hub = createHub({config:{nodeEnv:'production',v2Environment:'test',hubId:'catalog-hub',port:0,nativeApiPort:0,
    nativeCommandConfirmationTimeoutMs:200,nativeCommandDispatchTimeoutMs:150,
    appPublicKeys:keys.publicKey.export({type:'spki',format:'pem'}).toString(),dataDir:directory,dataFile:path.join(directory,'dinodia.json'),backupDir:path.join(directory,'backups'),otbrUrl:''},
    mqttBridge:mqtt,matterBridge:mock(),platformSync:mock(),cloudflareTunnel:mock()});
  try {
    const area = await hub.store.saveArea({name:'Room'},'local-room');
    await hub.store.savePlatform({homeId:'test-home',areaBindings:[{hubAreaId:area.id,areaId:'canonical-room'}]});
    const device = normalizeZigbeeDevice({ieee_address:'0x0011223344556688',friendly_name:'synthetic-cover',
      definition:{exposes:[{type:'cover',features:[{type:'enum',property:'state',access:7,values:['OPEN','CLOSE']}]}]}});
    await hub.store.upsertDevice({...device,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'none'});
    const mixed = normalizeZigbeeDevice({ieee_address:'0x0011223344556699',friendly_name:'synthetic-mixed-cover',
      definition:{exposes:[{type:'cover',features:[{type:'enum',property:'state',access:7,values:['OPEN','CLOSE','STOP']}]}]}});
    await hub.store.upsertDevice({...mixed,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(mixed.id,{areaId:area.id,labelId:'none'});
    const switchDevice = normalizeZigbeeDevice({ieee_address:'0x00112233445566aa',friendly_name:'synthetic-switch',
      definition:{exposes:[{type:'switch',features:[{type:'enum',property:'state',access:7,values:['ON','OFF']}]}]}});
    await hub.store.upsertDevice({...switchDevice,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(switchDevice.id,{areaId:area.id,labelId:'none'});
    const mixedSwitch = normalizeZigbeeDevice({ieee_address:'0x00112233445566bb',friendly_name:'synthetic-mixed-switch',
      definition:{exposes:[{type:'switch',features:[{type:'enum',property:'state',access:7,values:['ON','OFF','TOGGLE']}]}]}});
    await hub.store.upsertDevice({...mixedSwitch,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(mixedSwitch.id,{areaId:area.id,labelId:'none'});
    const conflictingSwitch = normalizeZigbeeDevice({ieee_address:'0x00112233445566cc',friendly_name:'synthetic-conflicting-switch',
      definition:{exposes:[{type:'switch',features:[{type:'enum',property:'state',access:7,values:['ON','OFF'],value_on:'TOGGLE'}]}]}});
    await hub.store.upsertDevice({...conflictingSwitch,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(conflictingSwitch.id,{areaId:area.id,labelId:'none'});
    const mixedChannel = normalizeZigbeeDevice({ieee_address:'0x00112233445566dd',friendly_name:'synthetic-mixed-channel',
      definition:{exposes:[{type:'switch',features:[{type:'enum',property:'state_l1',access:7,values:['ON','OFF','TOGGLE']}]}]}});
    await hub.store.upsertDevice({...mixedChannel,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(mixedChannel.id,{areaId:area.id,labelId:'none'});
    const mixedNamedChannel = normalizeZigbeeDevice({ieee_address:'0x00112233445566ff',friendly_name:'synthetic-named-channel',
      definition:{exposes:[{type:'switch',features:[{type:'enum',property:'state_left_upper',access:7,values:['ON','OFF','TOGGLE']}]}]}});
    await hub.store.upsertDevice({...mixedNamedChannel,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(mixedNamedChannel.id,{areaId:area.id,labelId:'none'});
    const light = normalizeZigbeeDevice({ieee_address:'0x00112233445566ee',friendly_name:'synthetic-light',
      definition:{exposes:[{type:'light',features:[{type:'enum',property:'state',access:7,values:['ON','OFF']}]}]}});
    await hub.store.upsertDevice({...light,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(light.id,{areaId:area.id,labelId:'none'});
    await hub.start();
    const now = Math.floor(Date.now()/1000);
    const claims = {iss:'dinodia-platform-v2',aud:'dinodia-hub:catalog-hub',sub:'test-account',sid:'test-session',jti:'test-token',membershipId:'test-membership',trustedDeviceId:'test-phone',hubInstallationId:'catalog-hub',iat:now,exp:now+300,homeId:'test-home',householdRole:'TENANT',areaIds:['canonical-room'],policyRevision:0,scope:['tenant:device-read','tenant:device-command']};
    const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${enc({alg:'EdDSA',typ:'DNO-APP-1',v:1})}.${enc(claims)}`;
    const token = `dno-app-1.${input}.${crypto.sign(null,Buffer.from(input),keys.privateKey).toString('base64url')}`;
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const response = await fetch(`${base}/api/dinodia/v1/devices`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.status,200);
    const devices = (await response.json()).data;
    const dto = devices.find(item=>item.id===device.id);
    assert.ok(dto, 'the synthetic device is visible to the permitted tenant');
    const control = dto.controls.find(item=>item.valueType==='option' && item.constraints?.options?.some(option=>option.value==='OPEN'));
    assert.ok(control, 'the actual descriptor includes the advertised OPEN option');
    const command = {commandId:'command-cover-fixture',homeId:'test-home',homeMembershipId:'test-membership',deviceId:device.id,
      controlId:control.controlId,descriptorRevision:dto.descriptorRevision,value:'OPEN',issuedAt:new Date().toISOString(),idempotencyKey:'cover-command-key-123456'};
    const result = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':command.idempotencyKey},body:JSON.stringify(command)});
    assert.equal(result.status,202,`authorized command should be accepted: ${await result.text()}`);
    for (let i=0; i<20 && calls.length===0; i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(calls,[{id:device.id,payload:{state:'OPEN'}}]);
    const duplicate = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':command.idempotencyKey},body:JSON.stringify(command)});
    assert.equal(duplicate.status,202,'same command identity is receipt reconciliation, not a second dispatch');
    assert.equal(calls.length,1);
    const invalid = {...command,commandId:'command-invalid-fixture',value:'STOP',idempotencyKey:'cover-command-invalid-123456'};
    const invalidResponse = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':invalid.idempotencyKey},body:JSON.stringify(invalid)});
    assert.equal(invalidResponse.status,400);
    assert.equal(calls.length,1, 'an undeclared option must not reach the adapter');
    const otherClaims = {...claims,sub:'other-account',membershipId:'other-membership',areaIds:['other-area']};
    const otherInput = `${enc({alg:'EdDSA',typ:'DNO-APP-1',v:1})}.${enc(otherClaims)}`;
    const otherToken = `dno-app-1.${otherInput}.${crypto.sign(null,Buffer.from(otherInput),keys.privateKey).toString('base64url')}`;
    const unauthorized = {...command,commandId:'command-unauthorized-fixture',homeMembershipId:'other-membership',idempotencyKey:'cover-command-denied-123456'};
    const unauthorizedResponse = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${otherToken}`,'content-type':'application/json','idempotency-key':unauthorized.idempotencyKey},body:JSON.stringify(unauthorized)});
    assert.equal(unauthorizedResponse.status,404,'a tenant without the Area grant cannot address the device');
    assert.equal(calls.length,1);
    const mixedDto = devices.find(item=>item.id===mixed.id);
    const mixedControl = mixedDto?.controls.find(item=>item.valueType==='option');
    assert.ok(mixedControl, 'mixed state remains visible for reading');
    assert.equal(mixedControl.writable,false,'v1 must not represent STOP as an absolute set');
    const stop = {...command,commandId:'command-stop-fixture',deviceId:mixed.id,controlId:mixedControl.controlId,
      descriptorRevision:mixedDto.descriptorRevision,value:'STOP',idempotencyKey:'cover-command-stop-123456'};
    const denied = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':stop.idempotencyKey},body:JSON.stringify(stop)});
    assert.equal(denied.status,400);
    assert.deepEqual(calls,[{id:device.id,payload:{state:'OPEN'}}], 'STOP must never reach the adapter');
    const switchDto = devices.find(item=>item.id===switchDevice.id);
    const switchControl = switchDto?.controls.find(item=>item.valueType==='option');
    assert.ok(switchControl?.writable, 'the advertised switch option is available');
    const on = {...command,commandId:'command-switch-fixture',deviceId:switchDevice.id,controlId:switchControl.controlId,
      descriptorRevision:switchDto.descriptorRevision,value:'ON',idempotencyKey:'switch-command-on-123456'};
    const switchResponse = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':on.idempotencyKey},body:JSON.stringify(on)});
    assert.equal(switchResponse.status,202);
    for (let i=0; i<20 && calls.length<2; i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(calls,[{id:device.id,payload:{state:'OPEN'}},{id:switchDevice.id,payload:{state:'ON'}}]);
    const mixedSwitchControl = devices.find(item=>item.id===mixedSwitch.id)?.controls.find(item=>item.valueType==='option');
    assert.ok(mixedSwitchControl);
    assert.equal(mixedSwitchControl.writable,false,'v1 must not represent TOGGLE as an absolute set');
    const conflictingDto = devices.find(item=>item.id===conflictingSwitch.id);
    const conflictingControl = conflictingDto?.controls.find(item=>item.valueType==='option');
    assert.ok(conflictingControl);
    assert.equal(conflictingControl.writable,false,'a conflicting adapter value must not advertise an absolute command');
    const conflict = {...command,commandId:'command-conflict-fixture',deviceId:conflictingSwitch.id,controlId:conflictingControl.controlId,
      descriptorRevision:conflictingDto.descriptorRevision,value:'ON',idempotencyKey:'switch-command-conflict-123456'};
    const conflictResponse = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':conflict.idempotencyKey},body:JSON.stringify(conflict)});
    assert.equal(conflictResponse.status,400);
    assert.equal(calls.length,2,'conflicting metadata must not reach the adapter');
    const channelControl = devices.find(item=>item.id===mixedChannel.id)?.controls.find(item=>item.valueType==='option');
    assert.ok(channelControl);
    assert.equal(channelControl.writable,false,'a mixed multi-channel control must remain read-only');
    const namedChannelControl = devices.find(item=>item.id===mixedNamedChannel.id)?.controls.find(item=>item.valueType==='option');
    assert.ok(namedChannelControl);
    assert.equal(namedChannelControl.writable,false,'a named mixed multi-channel control must remain read-only');
    const lightDto = devices.find(item=>item.id===light.id);
    const lightControl = lightDto?.controls.find(item=>item.valueType==='option');
    assert.ok(lightControl?.writable);
    const lightOn = {...command,commandId:'command-light-fixture',deviceId:light.id,controlId:lightControl.controlId,
      descriptorRevision:lightDto.descriptorRevision,value:'ON',idempotencyKey:'light-command-on-123456'};
    const lightResponse = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':lightOn.idempotencyKey},body:JSON.stringify(lightOn)});
    assert.equal(lightResponse.status,202);
    for (let i=0; i<20 && calls.length<3; i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(calls[2],{id:light.id,payload:{state:'ON'}},'power ON must not be misinterpreted as brightness');
    const lightOff = {...lightOn,commandId:'command-light-off-fixture',value:'OFF',idempotencyKey:'light-command-off-123456'};
    const offResponse = await fetch(`${base}/api/dinodia/v1/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':lightOff.idempotencyKey},body:JSON.stringify(lightOff)});
    assert.equal(offResponse.status,202);
    for (let i=0; i<20 && calls.length<4; i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(calls[3],{id:light.id,payload:{state:'OFF'}});
  } finally {await hub.stop();await fs.rm(directory,{recursive:true,force:true});}
});
