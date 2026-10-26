const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createHub} = require('../src/server');
const {normalizeZigbeeDevice} = require('../src/integrations/zigbee/exposeNormalizer');
const mock = () => ({start(){},stop(){},close(){},status(){return {configured:false,connected:false};}});
for (const competingWrite of ['state event','catalogue']) test(`genuine report confirmation survives queued ${competingWrite} persistence without a periodic guarantee`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-receipt-runtime-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const hub = createHub({config:{nodeEnv:'production',v2Environment:'test',hubId:'receipt-hub',port:0,nativeApiPort:0,
    appPublicKeys:keys.publicKey.export({type:'spki',format:'pem'}).toString(),dataDir:directory,dataFile:path.join(directory,'dinodia.json'),backupDir:path.join(directory,'backups'),otbrUrl:''},
    mqttBridge:mock(),matterBridge:mock(),platformSync:mock(),cloudflareTunnel:mock()});
  let release = () => {};
  try {
    const area = await hub.store.saveArea({name:'Room'},'local-room');
    await hub.store.savePlatform({homeId:'test-home',areaBindings:[{hubAreaId:area.id,areaId:'canonical-room'}]});
    const fixture = JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/zigbee/sonoff-trvzb-observation.json')));
    const device = normalizeZigbeeDevice(fixture);
    await hub.store.upsertDevice({...device,areaId:area.id,managementClass:'property_device'});
    await hub.store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'radiator'});
    await hub.start();
    const now = Math.floor(Date.now()/1000);
    const claims = {iss:'dinodia-platform-v2',aud:'dinodia-hub:receipt-hub',sub:'test-account',sid:'test-session',jti:'test-token',membershipId:'test-membership',trustedDeviceId:'test-phone',hubInstallationId:'receipt-hub',iat:now,exp:now+300,homeId:'test-home',householdRole:'TENANT',areaIds:['canonical-room'],policyRevision:0,scope:['tenant:device-read','tenant:device-command']};
    const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${enc({alg:'EdDSA',typ:'DNO-APP-1',v:1})}.${enc(claims)}`;
    const token = `dno-app-1.${input}.${crypto.sign(null,Buffer.from(input),keys.privateKey).toString('base64url')}`;
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const get = async route => {const r=await fetch(base+route,{headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,200);return r.json();};
    const dto = (await get('/api/dinodia/v1/devices')).data.find(d=>d.id===device.id);
    assert.ok(dto);
    const control = dto.controls.find(c=>c.semanticRole==='target_temperature');
    assert.ok(control);
    const acceptedAt = new Date(Date.now()-5000).toISOString();
    await hub.store.saveSecurity({nativeCommandResults:{receipt:{deviceId:device.id,controlId:control.controlId,homeId:claims.homeId,accountId:claims.sub,membershipId:claims.membershipId,areaIds:claims.areaIds,policyRevision:0,
      membershipFingerprint:crypto.createHash('sha256').update(claims.membershipId).digest('hex'),requestedValue:25.5,observationRevision:0,status:'accepted',result:{commandId:'test-command',homeId:claims.homeId,status:'accepted',acceptedAt,completedAt:null,errorCode:null}}}});
    const old = new Date(Date.parse(acceptedAt)-1000).toISOString();
    await hub.store.updateDeviceState(device.id,{occupied_heating_setpoint:25.5},{protocol:'zigbee',reportedStateKeys:['occupied_heating_setpoint'],sourceObservedAtByStateKey:{occupied_heating_setpoint:old},sourceReceivedAtByStateKey:{occupied_heating_setpoint:old}});
    assert.equal((await get('/api/dinodia/v1/commands/test-command')).status,'accepted','a matching pre-command report cannot confirm');
    const at = new Date().toISOString();
    await hub.store.updateDeviceState(device.id,{occupied_heating_setpoint:25.5},{protocol:'zigbee',reportedStateKeys:['occupied_heating_setpoint'],sourceObservedAtByStateKey:{occupied_heating_setpoint:at},sourceReceivedAtByStateKey:{occupied_heating_setpoint:at}});
    const receipt = await get('/api/dinodia/v1/commands/test-command');
    assert.equal(receipt.status,'applied');
    const security = hub.store.getSecurity();
    const accepted = {...security.nativeCommandResults.receipt,status:'accepted',result:{...security.nativeCommandResults.receipt.result,status:'accepted',completedAt:null}};
    await hub.store.saveSecurity({nativeCommandResults:{receipt:accepted}});
    let journalQueued, catalogQueued;
    const gate = new Promise(resolve=>{release=resolve;});
    const journalReady = new Promise(resolve=>{journalQueued=resolve;});
    const catalogReady = new Promise(resolve=>{catalogQueued=resolve;});
    const originalSave = hub.store.saveSecurity.bind(hub.store);
    hub.store.saveSecurity = patch => {
      const result = originalSave(patch);
      if (patch.nativeEvents) journalQueued();
      if (patch.nativeCatalogIndex) catalogQueued();
      return result;
    };
    const blocker = hub.store.mutateAtomically(async()=>{await gate;});
    await new Promise(resolve=>setImmediate(resolve));
    const entity = Object.values(hub.store.getDevice(device.id).entities).find(e=>e.stateKey==='occupied_heating_setpoint');
    hub.eventBus.emit('state_changed',{entity_id:entity.id});
    const bounded = promise => {
      let timer;
      return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('queued writer not reached')),2000);})]).finally(()=>clearTimeout(timer));
    };
    await bounded(journalReady);
    let catalog;
    if (competingWrite === 'catalogue') {
      catalog = get('/api/dinodia/v1/devices');
      await bounded(catalogReady);
    }
    release();
    await blocker;
    await catalog;
    await hub.store.mutationQueue;
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(hub.store.getSecurity().nativeCommandResults.receipt.status,'applied',`queued ${competingWrite} persistence must not restore the accepted receipt`);
    const persisted = JSON.parse(await fs.readFile(path.join(directory,'dinodia.json')));
    assert.equal(persisted.security.nativeCommandResults.receipt.status,'applied','confirmation is durable, not just an in-memory result');
    hub.store.saveSecurity = originalSave;
  } finally {release();await hub.stop();await fs.rm(directory,{recursive:true,force:true});}
});
