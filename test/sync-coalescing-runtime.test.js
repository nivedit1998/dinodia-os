const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Store}=require('../src/store');
const {SecretVault}=require('../src/secretVault');
const consumerRoot=process.env.DINODIA_STAGE3_BASE_ROOT||path.resolve(__dirname,'..');
const {PlatformPairing}=require(path.join(consumerRoot,'src/platformPairing'));
const {generateManufacturingIdentity,vaultIdentityRecord}=require('../src/auth/manufacturingIdentity');
function nativeSyncAck(request) {
  const configuration = {
    revision: 1,
    policyRevision: 1,
    areas: [],
    memberships: [],
    devicePolicies: [],
    automations: [],
    releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
  };
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : !value || typeof value !== "object" ? JSON.stringify(value)
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  configuration.checksum = crypto.createHash("sha256").update(canonical(configuration)).digest("hex");
  return {
    streamId: request.streamId,
    cloudRevision: configuration.revision,
    configurationAppliedRevision: request.acknowledgedCloudRevision,
    acceptedThroughSequence: request.toSequence,
    resnapshotRequired: false,
    configuration,
  };
}


async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-stage3-'));
 const store=new Store(path.join(directory,'dinodia.json')),serial='DINODIA-STAGE3';
 await store.saveIdentity({serial});const vault=new SecretVault({dataDir:directory});
 const record=vaultIdentityRecord(generateManufacturingIdentity({serial}));
 for(const [key,value] of Object.entries({identityPrivateKey:record.signingPrivateKey,identityPublicKey:record.signingPublicKey,encryptionPrivateKey:record.encryptionPrivateKey,encryptionPublicKey:record.encryptionPublicKey,identityFingerprint:record.publicKeyFingerprint,encryptionFingerprint:record.encryptionKeyFingerprint,identityGeneration:'1',manufacturingCertificateSignature:'synthetic-certificate'}))await vault.set('platform.'+key,value);
 await store.savePlatform({paired:true,provisioningCredentialVersion:1,hubInstallId:'33333333-3333-4333-8333-333333333333'});
 const f={now:Date.now(),calls:[],hook:null,afterSync:null,serverCursor:0,serverStream:null};
 f.pairing=new PlatformPairing({store,vault,apiUrl:'https://platform.test',serial,clock:()=>f.now,intervalMs:30000,heartbeatIntervalMs:120000,
 logger:{error(){},warn(){}},onSyncResult:async()=>{if(f.afterSync)await f.afterSync();},
 fetchImpl:async(url,options)=>{const route=new URL(url).pathname,body=JSON.parse(options.body);f.calls.push({route,body});if(f.hook)await f.hook(route,body);
 if(route.endsWith('/v2/sync')){f.serverCursor=body.toSequence;f.serverStream=body.streamId;}
 const reply=route.endsWith('/v2/sync')?nativeSyncAck(body):{syncAcceptedSequence:f.serverCursor,syncStreamId:f.serverStream,latestVersion:0,publishedVersion:0,operatorCredentialStates:[],offlineAuthorisations:[],acceptedActivityIncidentIds:[],...(body.lanEndpoint?{lanEndpoint:{revision:body.lanEndpoint.revision,state:body.lanEndpoint.state}}:{})};return {ok:true,status:200,json:async()=>reply};}});
 f.store=store;f.count=suffix=>f.calls.filter(c=>c.route.endsWith(suffix)).length;
 t.after(async()=>{f.pairing.stop();await new Promise(r=>setTimeout(r,20));await fs.rm(directory,{recursive:true,force:true});});return f;
}
async function settle(pairing){for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,10));if(!pairing.syncing&&!pairing.queuedImmediateSync&&!pairing.queuedExplicitSync&&!pairing.immediateSync)return;}assert.fail('follow-up did not settle');}
test('unchanged periodic status respects idle gate: twelve minutes produces three refreshes, not six',async t=>{
 const f=await fixture(t);await f.pairing.syncNow();const first=f.count('/token-state');
 for(let i=0;i<6;i++){f.now+=120000;await f.pairing.requestImmediateHeartbeat({periodic:true});}
 assert.equal(f.count('/token-state')-first,3);assert.equal(f.count('/heartbeat'),4);
 console.log('STAGE3_CONTROLLED periodic window=12min token_state='+ (f.count('/token-state')-first));
});
test('thirty-second ticks coalesce routine-only queue without dropping original events',async t=>{
 const f=await fixture(t);await f.pairing.syncNow();
 // A real persisted usage event waits; it is not removed or given a new timestamp by the idle gate.
 const payload={osDeviceId:'synthetic',temperature:20,observedAt:new Date(f.now).toISOString()};
 const event=await f.store.queueSyncEvent('temperature.sample','sample',payload,{now:f.now});
 const start=f.count('/token-state');
 for(let i=0;i<24;i++){f.now+=30000;await f.pairing.scheduledSync();}
 assert.equal(f.count('/token-state')-start,3);
 const transmitted=f.calls.flatMap(c=>c.body.events||[]).find(e=>e.id===event.id);
 assert.deepEqual(transmitted.payload,payload);assert.equal(f.store.getSyncOutbox().events.length,0);
});
test('endpoint wakeups before the current heartbeat are covered once, without a feedback sync',async t=>{
 const f=await fixture(t);let started,release;const pending=new Promise(r=>started=r),hold=new Promise(r=>release=r);let once=true;
 f.hook=async route=>{if(once&&route.endsWith('/token-state')){once=false;started();await hold;}};
 const syncing=f.pairing.syncNow();await pending;
 for(let i=0;i<8;i++)await f.pairing.requestImmediateHeartbeat();release();await syncing;await settle(f.pairing);
 assert.equal(f.count('/token-state'),1);assert.equal(f.count('/heartbeat'),1);
});
test('explicit urgent wakeup after response handling is retained once; scheduler ticks add no follow-up',async t=>{
 const f=await fixture(t);let once=true;
 f.afterSync=async()=>{if(!once)return;once=false;await f.store.saveArea({name:'Late urgent area'},'late-area');await f.pairing.scheduledSync();for(let i=0;i<6;i++)await f.pairing.syncNow();};
 await f.pairing.syncNow();await settle(f.pairing);assert.equal(f.count('/token-state'),2);assert.equal(f.store.getSyncOutbox().events.length,0);
});
test('stop cancels a queued immediate follow-up',async t=>{
 const f=await fixture(t);let once=true;f.afterSync=async()=>{if(once){once=false;await f.pairing.syncNow();f.pairing.stop();}};
 await f.pairing.syncNow();await settle(f.pairing);assert.equal(f.count('/token-state'),1);
});

test('real server status observer marks unchanged periodic reports routine and recovery changes urgent',async t=>{
 const {createHub}=require(path.join(consumerRoot,'src/server'));
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-stage3-observer-'));let observer,now=Date.now();const calls=[];
 const mock=()=>({start(){},close(){},status(){return {configured:false,connected:false};},async refresh(){return [];}});
 const tunnel={start(){},async stop(){},status(){return {configured:false,connected:false};},setStatusObserver(fn){observer=fn;}};
 const hub=createHub({clock:()=>now,config:{nodeEnv:'test',v2Environment:'test',hubId:'synthetic',dataDir:directory,dataFile:path.join(directory,'store.json'),backupDir:path.join(directory,'backups'),otbrUrl:'',platformApiUrl:''},mqttBridge:mock(),matterBridge:mock(),cloudflareTunnel:tunnel,logger:{log(){},warn(){},error(){}}});
 t.after(async()=>{await hub.stop();await fs.rm(directory,{recursive:true,force:true});});
 hub.pairing.requestImmediateHeartbeat=async options=>{calls.push(options);};
 observer({recoveryState:'READY'});now+=120000;observer({recoveryState:'READY'});now++;observer({recoveryState:'DISCONNECTED'});
 assert.deepEqual(calls,[{periodic:false},{periodic:true},{periodic:false}]);
});
test('failure retains the durable batch and retry backoff; periodic requests cannot bypass it',async t=>{
 const f=await fixture(t);await f.pairing.syncNow();await f.store.saveArea({name:'Durable'},'retry-area');let failedBody;
 f.hook=async(route,body)=>{if(route.endsWith('/v2/sync')){failedBody=body;throw Object.assign(new Error('synthetic unavailable'),{code:'synthetic_unavailable'});}};
 await f.pairing.syncNow();assert.ok(f.pairing.lastError);const frozen=f.store.getSyncOutbox().inFlight;assert.ok(frozen);
 const before=f.calls.length;f.pairing.nextRetryAt=Date.now()+60000;await f.pairing.requestImmediateHeartbeat({periodic:true});assert.equal(f.calls.length,before);
 clearTimeout(f.pairing.retryTimer);f.pairing.retryTimer=null;f.pairing.nextRetryAt=0;f.hook=null;await f.pairing.syncNow();
 const bodies=f.calls.filter(c=>c.route.endsWith('/v2/sync')).map(c=>c.body);assert.deepEqual(bodies.at(-1),failedBody);assert.equal(f.store.getSyncOutbox().events.length,0);
});
