'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store');const {createHub}=require('../src/server');
const mock=()=>({start(){},stop(){},close(){},status(){return {configured:false,connected:false};},async command(){throw Error('physical dispatch forbidden');}});
for(const distinct of [false,true])for(const privateWhen of [false,true])test(`legacy admin cannot inspect or mutate tenant rules: distinct instance=${distinct}, private WHEN=${privateWhen}`,async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-automation-privacy-'));
 const store=new Store(path.join(dir,'store.json'));await store.saveIdentity({serial:'serial-home',...(distinct?{instanceId:'instance-home'}:{})});
 const hub=createHub({store,config:{nodeEnv:'development',adminToken:'synthetic-admin',nativeAutomationsMode:'enabled',dataDir:dir,dataFile:path.join(dir,'store.json'),backupDir:path.join(dir,'backups'),staticDir:path.join(__dirname,'../public'),otbrUrl:''},mqttBridge:mock(),matterBridge:mock(),platformSync:mock(),cloudflareTunnel:mock(),logger:{log(){},warn(){},error(){}}});
 t.after(async()=>{await hub.stop();await fs.rm(dir,{recursive:true,force:true});});
 hub.nativeAutomationService.internalCatalogue=()=>[{deviceId:'target',configured:true,online:true,controls:[{controlId:'power',label:'Power',valueType:'boolean',writable:true,allowsAutomation:true,constraints:{},execution:{onServiceId:'light.turn_on',offServiceId:'light.turn_off',idempotency:'set_value'}}]}];
 const source={deviceId:'private-sensor-DO-NOT-EXPOSE',areaId:'room',controlId:'temperature',osDeviceId:'private-radio',osAreaId:'room',descriptorRevision:1,managementClass:'TENANT_DEVICE',ownerMembershipId:'tenant'};
 const property={...source,deviceId:'property-sensor',osDeviceId:'property-radio',managementClass:'PROPERTY_DEVICE',ownerMembershipId:null};
 const payload={kind:'device_state',source:privateWhen?source:property,operator:'falls_below',value:{type:'number',number:18},resetMargin:1,cooldownSeconds:30,timeZoneIdentifier:'UTC',conditions:{mode:'all',items:privateWhen?[]:[{kind:'device_state',source,operator:'above',value:{type:'number',number:10}}]}};
 const homeId=distinct?'instance-home':'serial-home';
 await store.mutateNativeAutomation(state=>{
  state.automations.rule={id:'rule',name:'Private bedtime routine',homeId,owner:{type:'platform',subjectId:'cloud-policy'},creatorMembershipId:'tenant',enabled:true,revision:1,source:'platform_sync'};
  state.automationTriggers.trigger={id:'trigger',automationId:'rule',type:'device_state',payload};
  state.automationActions.action={id:'action',automationId:'rule',deviceId:'target',controlId:'power',targetValue:{type:'boolean',boolean:true},sortOrder:0};
  state.automationExecutions=[{automationId:'rule',occurrenceId:'run',status:'skipped',conditionResults:[false],reason:'condition_not_met',definitionSnapshot:{name:'Private bedtime routine'}}];
 });
 await new Promise(r=>hub.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${hub.server.address().port}/_dinodia/admin/api/automations`,headers={authorization:'Bearer synthetic-admin','content-type':'application/json'};
 const list=await fetch(base,{headers});assert.equal(list.status,200);const body=await list.json();
 assert.equal(body.automations.length,0);assert(!JSON.stringify(body).includes('private-sensor'));assert(!JSON.stringify(body).includes('Private bedtime'));
 for(const [suffix,method,data] of [['/rule','GET'],['/rule/executions','GET'],['/rule/duplicate','POST',{}],['/rule/enabled','PATCH',{enabled:false,expectedRevision:1}],['/rule','PUT',{enabled:false,expectedRevision:1}],['/rule','DELETE',{expectedRevision:1}]]) {
  const response=await fetch(base+suffix,{method,headers,...(data?{body:JSON.stringify(data)}:{})});assert.equal(response.status,404,`${method}${suffix}`);assert(!(await response.text()).includes('private-sensor'));
 }
 assert.equal(store.getNativeAutomation('rule').automation.revision,1);
 const runtime=hub.nativeAutomationService.projected('rule',{homeId,runtimeAccess:true});assert(runtime);assert.equal(runtime.health.executable,true);assert.equal(runtime.trigger.payload.conditions.items.length,privateWhen?0:1);
});
