const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store');
const {AutomationScheduler}=require('../src/automations/scheduler');
const {AutomationExecutor}=require('../src/automations/executor');
const {DeviceTriggerCoordinator}=require('../src/automations/deviceTriggerCoordinator');
const {evaluateConditions,crossed,validDeviceTrigger}=require('../src/automations/conditions');
const source={deviceId:'source',areaId:'area',controlId:'temperature',osDeviceId:'sensor',osAreaId:'room',descriptorRevision:1,managementClass:'PROPERTY_DEVICE',ownerMembershipId:null};
const payload={kind:'device_state',source,operator:'falls_below',value:{type:'number',number:18},resetMargin:1,cooldownSeconds:30,conditions:{mode:'all',items:[]},timeZoneIdentifier:'Europe/London'};
test('typed trigger and condition inputs reject malformed values and unknown fields',()=>{
 assert.equal(validDeviceTrigger(payload),true);assert.equal(validDeviceTrigger({...payload,arbitrary:'x'}),false);
 assert.equal(validDeviceTrigger({...payload,value:{type:'number',number:NaN}}),false);
 assert.equal(validDeviceTrigger({...payload,conditions:{mode:'all',items:new Array(9).fill({})}}),false);
});
test('all/any use three-valued logic; stale readings never pass negative conditions',()=>{
 const condition={kind:'device_state',source,operator:'not_equals',value:{type:'boolean',boolean:true}};
 assert.equal(evaluateConditions({mode:'all',items:[condition]},()=>({quality:'stale',value:false}),new Date(),'UTC').result,null);
 const cond2={...condition,source:{...source,controlId:'other'}};
 const read=s=>s.controlId==='other'?{quality:'fresh',value:false}:{quality:'unknown',value:null};
 assert.equal(evaluateConditions({mode:'any',items:[condition,cond2]},read,new Date(),'UTC').result,true);
 assert.equal(evaluateConditions({mode:'all',items:[condition,cond2]},read,new Date(),'UTC').result,null);
 assert.equal(evaluateConditions({mode:'all',items:[]},read,new Date(),'UTC').result,true);
});
test('overnight windows use the preceding selected weekday, not phone timezone',()=>{
 const group={mode:'all',items:[{kind:'time_window',startMinute:1320,endMinute:120,weekdays:[1]}]};
 assert.equal(evaluateConditions(group,()=>null,new Date('2026-11-03T01:00:00Z'),'Europe/London').result,true);
 assert.equal(evaluateConditions(group,()=>null,new Date('2026-11-03T03:00:00Z'),'Europe/London').result,false);
});
test('crossing hysteresis re-arms only after the reset margin',()=>{
 assert.deepEqual(crossed(payload,19,17,true),{fire:true,armed:false});
 assert.deepEqual(crossed(payload,17,17.9,false),{fire:false,armed:false});
 assert.deepEqual(crossed(payload,18.5,17,false),{fire:false,armed:false});
 assert.deepEqual(crossed(payload,17,19,false),{fire:false,armed:true});
});
async function fixture(t,conditions={mode:'all',items:[]},options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-device-trigger-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(path.join(dir,'store.json'));
 let time=Date.parse('2026-11-02T10:00:00Z'),seq=0;
 let sample={value:20,quality:'fresh',point:true,observationId:'old',sourceKey:'source1',observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString()};
 let allowed=true;const sent=[];
 const action={id:'action',deviceId:'radiator',controlId:'target',targetValue:{type:'number',number:21},sortOrder:0};
 await store.mutateNativeAutomation(state=>{
 state.automations.rule={id:'rule',homeId:'home',enabled:true,revision:1,source:'platform_sync'};
 state.automationTriggers.trigger={id:'trigger',automationId:'rule',type:'device_state',payload:{...payload,...options.trigger,conditions}};
 state.automationActions.action={...action,automationId:'rule'};
 });
 const service={projected:()=>({health:{executable:true}})};
 const executor=new AutomationExecutor({store,executeControl:async input=>{sent.push(input);return {confirmedByObservation:options.confirmed!==false};},now:()=>new Date(time),logger:{error(){}}});
 const scheduler=new AutomationScheduler({store,service,executor,now:()=>new Date(time)});
 const coordinator=new DeviceTriggerCoordinator({store,service,scheduler,executor,readSource:()=>sample,authorize:()=>allowed,now:()=>time,logger:{error(){}}});
 coordinator.start();
 t.after(async()=>{await coordinator.stop();await fs.rm(dir,{recursive:true,force:true});});
 const report=async(value,extra={})=>{time+=1000;sample={...sample,value,observationId:`event${++seq}`,observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString(),...extra};await coordinator.onDeviceChanged('sensor');};
 return {store,sent,coordinator,scheduler,report,setAllowed:x=>{allowed=x;},advance:n=>{time+=n;},restart:()=>{coordinator.stop();coordinator.start();}};
}
test('real Store -> claim -> executor: seed, crossing, duplicate and unchanged reports dispatch once',async t=>{
 const f=await fixture(t);await f.report(20);assert.equal(f.sent.length,0);await f.report(17);assert.equal(f.sent.length,1);
 await f.coordinator.onDeviceChanged('sensor');await f.report(17);assert.equal(f.sent.length,1);
 assert.equal(Object.values(f.store.state.automationOccurrences)[0].status,'succeeded');
});
test('unknown condition skips one occurrence, later condition changes never replay it',async t=>{
 const f=await fixture(t,{mode:'all',items:[{kind:'device_state',source,operator:'above',value:{type:'number',number:10}}]});
 await f.report(20);await f.report(17,{quality:'stale'});assert.equal(f.sent.length,0);
 assert.equal(f.store.state.automationExecutions[0].reason,'condition_unknown');
 await f.report(17,{quality:'fresh'});assert.equal(f.sent.length,0);
});
test('cached/invalid samples, source changes, restart and revoked authority do not invent events',async t=>{
 const f=await fixture(t);await f.report(20);await f.report(17,{point:false});assert.equal(f.sent.length,0);
 await f.report(17,{point:true});assert.equal(f.sent.length,0);
 await f.report(20);f.restart();await f.report(17);assert.equal(f.sent.length,0);
 await f.report(20);f.setAllowed(false);await f.report(17);assert.equal(f.sent.length,0);
});
test('cooldown is persisted before dispatch and suppressed occurrences are not queued',async t=>{
 const f=await fixture(t);await f.report(20);await f.report(17);await f.report(20);await f.report(17);
 assert.equal(f.sent.length,1);assert.equal(f.store.state.automationExecutions[0].reason,'cooldown');
 f.advance(31000);await f.coordinator.onDeviceChanged('sensor');assert.equal(f.sent.length,1);
 await f.report(20);await f.report(17);assert.equal(f.sent.length,2);
});

test('offline recovery cannot seed from a cached pre-gap sample',async t=>{
 const f=await fixture(t);await f.report(20);await f.report(20,{point:false});
 await f.report(20,{point:true,receivedAt:'2026-11-02T10:00:00Z'});
 await f.report(17);assert.equal(f.sent.length,0,'the first genuine post-gap report only seeds');
 await f.report(20);f.advance(31000);await f.report(17);assert.equal(f.sent.length,1);
});

test('queued reports retain their individual points instead of collapsing into the latest value',async t=>{
 const f=await fixture(t);await f.report(20);
 // All notifications arrive before the serialized evaluation microtask drains.
 await Promise.all([f.report(17),f.report(20),f.report(17)]);
 assert.equal(f.sent.length,1);assert.equal(f.store.state.automationExecutions[0].reason,'cooldown');
 assert.equal(Object.keys(f.store.state.automationOccurrences).length,2);
});

for(const value of [false,'idle']) test(`boolean/option genuine transition ${value} fires only on a new matching change`,async t=>{
 const f=await fixture(t,undefined,{trigger:{operator:'becomes',value:{type:typeof value==='boolean'?'boolean':'option',[typeof value==='boolean'?'boolean':'option']:value}}});
 await f.report(typeof value==='boolean'?true:'heat');await f.report(value);await f.report(value);assert.equal(f.sent.length,1);
});
test('restart retains cooldown, seeds once and never retries an uncertain physical action',async t=>{
 const f=await fixture(t,undefined,{confirmed:false});await f.report(20);await f.report(17);
 assert.equal(f.sent.length,1);assert.equal(f.store.state.automationExecutions[0].actionOutcomes[0].status,'uncertain');
 f.restart();await f.report(20);await f.report(17);assert.equal(f.sent.length,1);
 assert.equal(f.store.state.automationExecutions[0].reason,'cooldown');
 await f.scheduler.recover();assert.equal(f.sent.length,1);
});
test('persisted dispatch budget and repeat guard refuse before any physical dispatch',async t=>{
 for(const reason of ['dispatch_budget','repeat_guard_paused']) {
 const f=await fixture(t);await f.report(20);
 await f.store.mutateNativeAutomation(state=>{state.automationRuntime.deviceTriggers={minute:Math.floor(Date.parse('2026-11-02T10:00:00Z')/60000),home:reason==='dispatch_budget'?32:0,devices:{},rules:reason==='repeat_guard_paused'?{'rule:1':{runs:[],suspended:true}}:{}};});
 await f.report(17);assert.equal(f.sent.length,0);assert.equal(f.store.state.automationExecutions[0].reason,reason);
 }
});
test('expired queued evidence never catches up',async t=>{
 const f=await fixture(t);await f.report(20);f.advance(40000);await f.report(17,{receivedAt:'2026-11-02T10:00:01.001Z'});assert.equal(f.sent.length,0);
});
test('a logical reading is indexed by its physical pairing without changing its exact source control',async t=>{
 const f=await fixture(t);const original=f.store.getDevice.bind(f.store);
 f.store.getDevice=id=>id==='sensor'?{physicalDeviceId:'paired-hardware'}:original(id);
 f.coordinator.rebuild();await f.report(20);await f.coordinator.onDeviceChanged('paired-hardware');
 await f.report(17);await f.coordinator.onDeviceChanged('paired-hardware');assert.equal(f.sent.length,1);
});
