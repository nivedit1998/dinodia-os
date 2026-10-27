const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createHub} = require('../src/server');
const {normalizeZigbeeDevice} = require('../src/integrations/zigbee/exposeNormalizer');

test('tenant HTTP catalog retains device but drops a write-only diagnostic capability', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-universal-catalog-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const mock = () => ({start(){},stop(){},close(){},status(){return {configured:false,connected:false};}});
  const hub = createHub({config:{nodeEnv:'production',v2Environment:'test',hubId:'catalog-hub',port:0,nativeApiPort:0,
    appPublicKeys:keys.publicKey.export({type:'spki',format:'pem'}).toString(),dataDir:directory,dataFile:path.join(directory,'dinodia.json'),backupDir:path.join(directory,'backups'),otbrUrl:''},
    mqttBridge:mock(),matterBridge:mock(),platformSync:mock(),cloudflareTunnel:mock()});
  try {
    const area = await hub.store.saveArea({name:'Room'},'local-room');
    await hub.store.savePlatform({homeId:'test-home',areaBindings:[{hubAreaId:area.id,areaId:'canonical-room'}]});
    const fixture = JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/zigbee/sonoff-trvzb-observation.json')));
    const ordinary = normalizeZigbeeDevice(fixture);
    await hub.store.upsertDevice({...ordinary,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(ordinary.id,{areaId:area.id,labelId:'radiator'});
    const withAction = structuredClone(fixture);
    withAction.ieee_address = '0x00124b00c09b9efe';
    withAction.friendly_name = 'other-radiator';
    withAction.definition.exposes.push({type:'binary',property:'identify',access:2,value_on:'ON',value_off:'OFF'});
    const device = normalizeZigbeeDevice(withAction);
    await hub.store.upsertDevice({...device,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'radiator'});
    const unknownFixture = structuredClone(fixture);
    unknownFixture.ieee_address = '0x00124b00c09b9efd';
    unknownFixture.friendly_name = 'synthetic-unknown-manufacturer';
    unknownFixture.model_id = 'unknown-model';
    unknownFixture.definition.vendor = 'unknown-vendor';
    unknownFixture.definition.model = 'unknown-model';
    const unknown = normalizeZigbeeDevice(unknownFixture);
    await hub.store.upsertDevice({...unknown,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(unknown.id,{areaId:area.id,labelId:'radiator'});
    await hub.start();
    const now = Math.floor(Date.now()/1000);
    const claims = {iss:'dinodia-platform-v2',aud:'dinodia-hub:catalog-hub',sub:'test-account',sid:'test-session',jti:'test-token',membershipId:'test-membership',trustedDeviceId:'test-phone',hubInstallationId:'catalog-hub',iat:now,exp:now+300,homeId:'test-home',householdRole:'TENANT',areaIds:['canonical-room'],policyRevision:0,scope:['tenant:device-read','tenant:device-command']};
    const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${enc({alg:'EdDSA',typ:'DNO-APP-1',v:1})}.${enc(claims)}`;
    const token = `dno-app-1.${input}.${crypto.sign(null,Buffer.from(input),keys.privateKey).toString('base64url')}`;
    const response = await fetch(`http://127.0.0.1:${hub.server.address().port}/api/dinodia/v1/devices`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.status,200);
    const devices = (await response.json()).data;
    assert.ok(devices.some(item=>item.id===ordinary.id),'control fixture must appear');
    const projected = devices.find(item=>item.id===device.id);
    assert.ok(projected,'the device remains visible');
    assert.ok(Object.values(device.entities).some(item=>item.stateKey==='identify' && item.capability.writable && !item.capability.readable),'fixture must retain the write-only capability');
    assert.ok(!projected.controls.some(item=>item.label === 'Identify'),'current presentation drops this capability');
    const unknownProjected = devices.find(item=>item.id===unknown.id);
    assert.ok(unknownProjected,'an unknown manufacturer must not hide a standard capability');
    assert.ok(unknownProjected.controls.some(item=>item.semanticRole === 'target_temperature' && item.writable));
    assert.ok(unknownProjected.controls.some(item=>item.semanticRole === 'active_heat_demand' && item.readable));
    assert.equal(hub.store.getPlatform().devicePolicies?.[unknown.id]?.analyticsCategory ?? 'NONE','NONE',
      'a display label does not create an analytics category');
  } finally {await hub.stop();await fs.rm(directory,{recursive:true,force:true});}
});
