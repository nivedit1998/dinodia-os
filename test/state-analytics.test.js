const test=require('node:test');const assert=require('node:assert/strict');
const writer=require('../src/sync/stateAnalytics');
const base=Date.parse('2026-10-27T00:00:00.000Z');
function fixture(category='TV') {
 const usage={};writer.initialize(usage,{active:true,config:{timezone:'Europe/London',writerFrom:new Date(base).toISOString()}});
 const input={osDeviceId:'d',osAreaId:'a',analyticsCategory:category,controlId:'p',sourceGeneration:1,bindingRevision:1,
  analyticsIntervalId:'11111111-1111-4111-8111-111111111111',analyticsPolicyVersion:4,
  assignmentEpochAt:new Date(base).toISOString(),validFrom:new Date(base).toISOString(),
  evidence:{quality:'fresh',value:true,observedAt:new Date(base).toISOString(),validUntil:new Date(base+60000).toISOString()}};
 return {usage,input};
}
test('measured power expires into Unknown; repeating a report cannot renew it',()=>{
 const {usage,input}=fixture();writer.observe(usage,input,base+120000);
 let [e]=writer.events(usage,base+120000);assert.deepEqual(e.payload.durationsSeconds,{on:60,off:0,unknown:60});
 writer.observe(usage,{...input,evidence:{...input.evidence,validUntil:new Date(base+3600000).toISOString()}},base+180000);
 [e]=writer.events(usage,base+180000);assert.deepEqual(e.payload.durationsSeconds,{on:60,off:0,unknown:120});
});
test('a restart caps prior known state at the last-alive marker',()=>{
 const {usage,input}=fixture();writer.observe(usage,input,base+10000);writer.capAtLastAlive(usage,base+15000);
 const restarted=JSON.parse(JSON.stringify(usage));writer.observe(restarted,input,base+120000);
 assert.deepEqual(writer.events(restarted,base+120000)[0].payload.durationsSeconds,{on:15,off:0,unknown:105});
});
test('a delayed successor corrects the provisionally recorded tail, not just future time',()=>{
 const {usage,input}=fixture();input.evidence.validUntil=new Date(base+600000).toISOString();
 writer.observe(usage,input,base+300000);
 writer.observe(usage,{...input,evidence:{quality:'fresh',value:false,observedAt:new Date(base+120000).toISOString(),validUntil:new Date(base+600000).toISOString()}},base+300000);
 assert.deepEqual(writer.events(usage,base+300000)[0].payload.durationsSeconds,{on:120,off:180,unknown:0});
});
test('a genuine but unverified successor ends previous known activity without promoting it later',()=>{
 const {usage,input}=fixture();input.evidence.validUntil=new Date(base+600000).toISOString();
 writer.observe(usage,input,base+300000);
 const observedAt=new Date(base+120000).toISOString();
 writer.observe(usage,{...input,evidence:{quality:'unknown',lastReported:{observedAt,value:false}}},base+300000);
 assert.deepEqual(writer.events(usage,base+300000)[0].payload.durationsSeconds,{on:120,off:0,unknown:180});
 writer.observe(usage,{...input,evidence:{quality:'fresh',observedAt,value:false,validUntil:new Date(base+600000).toISOString()}},base+360000);
 assert.deepEqual(writer.events(usage,base+360000)[0].payload.durationsSeconds,{on:120,off:0,unknown:240});
});
test('position and activity semantics never infer activity from a target or arbitrary words',()=>{
 assert.equal(writer.activity('BLIND',0),'closed');assert.equal(writer.activity('BLIND',50),'partial');
 assert.equal(writer.activity('BLIND',100),'open');assert.equal(writer.activity('BLIND',101),'unknown');
 assert.equal(writer.activity('AC','heat'),'unknown');assert.equal(writer.activity('AC','heating'),'heating');
 assert.equal(writer.activity('WASHING_MACHINE','running'),'running');assert.equal(writer.activity('TV','ON'),'unknown');
});
test('writer suspension becomes Unknown and never promotes a cached report on resumption',()=>{
 const {usage,input}=fixture();input.evidence.validUntil=new Date(base+600000).toISOString();
 writer.observe(usage,input,base+60000);writer.suspend(usage,'d');
 writer.observe(usage,input,base+180000);
 assert.deepEqual(writer.events(usage,base+180000)[0].payload.durationsSeconds,{on:60,off:0,unknown:120});
 writer.observe(usage,{...input,evidence:{...input.evidence,observedAt:new Date(base+120000).toISOString()}},base+240000);
 assert.deepEqual(writer.events(usage,base+240000)[0].payload.durationsSeconds,{on:60,off:0,unknown:180});
});
test('hourly partitions conserve exact states across midnight and DST',()=>{
 const {usage,input}=fixture();input.evidence.quality='unknown';
 writer.observe(usage,input,base+25*3600000);
 const rows=writer.events(usage,base+25*3600000);assert.equal(rows.length,2);
 for(const {payload:p}of rows){assert.equal(p.hourly.reduce((s,h)=>s+h.durationsSeconds.unknown,0),p.durationsSeconds.unknown);
 assert.equal(Date.parse(p.coverageEndAt)-Date.parse(p.coverageStartAt),p.durationsSeconds.unknown*1000);}
});

test('actual Store records a categorized unknown-manufacturer device through the signed sync outbox',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {Store}=require('../src/store');const {checkedStateFixture}=require('./helpers/checked-state-fixture');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dinodia-state-runtime-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const store=new Store(path.join(directory,'store.json'));store.setUsageClockTrust(()=>true);
 await store.saveArea({name:'Synthetic room'},'area');
 const checked=await checkedStateFixture({store,directory,areaId:'area',now:base,generation:1,controlId:'power'});
 const start=checked.clock();
 const controlId=store.getSyncOutbox().events.filter(e=>e.type==='control.catalog.upsert').at(-1).payload.controls.find(c=>c.semanticRole==='power').controlId;
 store.state.platform.cloudConfiguration={analyticsHistory:{version:1,enabled:true,timezone:'Europe/London',writerFrom:new Date(base).toISOString()}};
 const policy=store.state.platform.devicePolicies[checked.deviceId];
 Object.assign(policy,{analyticsCategory:'TV',osAreaIds:['area'],analyticsAssignmentStartedAt:new Date(start).toISOString(),
  analyticsInterval:{id:'11111111-1111-4111-8111-111111111111',revision:2,sourceGeneration:1,validFrom:new Date(start).toISOString(),
    analyticsPolicyVersion:4,writerEnabled:true,genericCollectionEnabled:false,authorizedControlIds:[controlId],selectedControlId:controlId}});
 await store.advanceSyncUsage(start);
 await checked.report('OFF',{advance:1000});await store.advanceSyncUsage(checked.clock()+60000);
 const event=store.getSyncOutbox().events.find(e=>e.type==='analytics.state.day');
 assert.ok(event,'real runtime must emit the new event');assert.equal(event.payload.analyticsCategory,'TV');
 assert.equal(Object.values(event.payload.durationsSeconds).reduce((a,b)=>a+b,0),61);
 assert.equal(event.payload.durationsSeconds.off,60);
 assert.equal(store.getSyncOutbox().events.some(e=>e.type==='usage.bucket'&&e.payload.analyticsCategory==='TV'),false);
});
