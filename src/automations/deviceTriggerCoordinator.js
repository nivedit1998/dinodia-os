'use strict';
const crypto=require('node:crypto');
const {sources,evaluateConditions,crossed,scalar,validDeviceTrigger}=require('./conditions');
const {LIMITS}=require('./constants');
const BUDGETS=Object.freeze({cooldownMs:30000,homeActionsPerMinute:32,deviceActionsPerMinute:6,runsPerRulePerHour:30,eventDeadlineMs:30000});
class DeviceTriggerCoordinator {
  constructor({store,service,scheduler,executor,readSource,authorize,now=()=>Date.now(),logger=console}) {
    Object.assign(this,{store,service,scheduler,executor,readSource,authorize,now,logger});
    this.index=new Map();this.baselines=new Map();this.generation=null;this.queue=Promise.resolve();this.running=false;this.pending=0;
  }
  start(){this.running=true;this.rebuild();}
  stop(){this.running=false;return this.queue;}
  rebuild(){
    this.index.clear();this.baselines.clear();
    this.generation=this.store.getPlatform?.()?.cloudRevision;
    for(const row of this.store.listNativeAutomations()) {
      const stored=this.store.getNativeAutomation(row.id);
      if(!row.enabled || stored?.trigger?.type!=='device_state' || !validDeviceTrigger(stored.trigger.payload)) continue;
      const key=stored.trigger.payload.source.osDeviceId;
      const physical=this.store.getDevice(key)?.physicalDeviceId || key;
      if(!this.index.has(physical)) this.index.set(physical,[]);
      this.index.get(physical).push(row.id);
      const sample=this.readSource(stored.trigger.payload.source,row);
      this.baselines.set(row.id,{revision:row.revision,sample,armed:false,seeded:false,barrier:this.now()});
    }
  }
  onDeviceChanged(deviceId){
    if(!this.running)return Promise.resolve();
    if(this.generation!==this.store.getPlatform?.()?.cloudRevision)this.rebuild();
    if(!this.index.has(deviceId))return Promise.resolve();
    if(this.pending>=64){for(const id of this.index.get(deviceId)||[]){const b=this.baselines.get(id);if(b){b.seeded=false;b.sample=null;b.barrier=this.now();}}return Promise.resolve();}
    // Capture the admitted point now: a slow prior action must not collapse
    // several genuine transitions into the latest Store value.
    const samples=new Map((this.index.get(deviceId)||[]).map(id=>{
      const stored=this.store.getNativeAutomation(id);
      const value=stored?.trigger?.type==='device_state'?this.readSource(stored.trigger.payload.source,stored.automation):null;
      const evaluated=value?.point ? evaluateConditions(stored.trigger.payload.conditions,source=>this.readSource(source,stored.automation),new Date(this.now()),stored.trigger.payload.timeZoneIdentifier) : {result:null,results:[]};
      return [id,{sample:value?{...value}:null,evaluated}];
    }));
    this.pending+=1;
    // Serialize occurrences and shared budgets, never overlapping physical dispatches.
    const task=this.queue.then(()=>this.evaluateDevice(deviceId,samples)).finally(()=>{this.pending-=1;});
    this.queue=task.catch(error=>this.logger.error('[automation-trigger] '+String(error.code||'evaluation_failed')));
    return this.queue;
  }
  async skipped(occurrence,stored,reason,evaluated){
    const completedAt=new Date(this.now()).toISOString();
    const actionOutcomes=stored.actions.map(action=>({actionId:action.id,deviceId:action.deviceId,controlId:action.controlId,status:'skipped',completedAt,errorCode:reason}));
    await this.store.mutateNativeAutomation(state=>{
      const row=state.automationOccurrences[occurrence.id];
      if(row)Object.assign(row,{status:'skipped',completedAt,actionOutcomes,reason,conditionResults:evaluated?.results||[]});
      state.automationExecutions=[{occurrenceId:occurrence.id,automationId:stored.automation.id,revision:stored.automation.revision,source:'platform_sync',status:'skipped',startedAt:occurrence.scheduledFor,completedAt,actionOutcomes,reason,conditionResults:evaluated?.results||[]},...(state.automationExecutions||[])].slice(0,LIMITS.maxExecutionHistory);
    });
  }
  async evaluateDevice(deviceId,samples){
    if(!this.running)return;
    if(this.generation!==this.store.getPlatform?.()?.cloudRevision)this.rebuild();
    for(const id of this.index.get(deviceId)||[]) {
      const stored=this.store.getNativeAutomation(id), baseline=this.baselines.get(id);
      if(!stored?.automation.enabled || stored.trigger?.type!=='device_state')continue;
      if(!baseline || baseline.revision!==stored.automation.revision){this.rebuild();continue;}
      const p=stored.trigger.payload;
      if(!this.service.projected(id,{homeId:stored.automation.homeId,runtimeAccess:true})?.health?.executable || !this.authorize(stored)){baseline.sample=null;baseline.seeded=false;baseline.barrier=this.now();continue;}
      const captured=samples?.get(id), sample=captured?.sample ?? null;
      if(!sample?.point || !sample.observationId || sample.value==null){baseline.sample=null;baseline.seeded=false;baseline.barrier=this.now();continue;}
      if(!Number.isFinite(Date.parse(sample.receivedAt)) || Date.parse(sample.receivedAt)>this.now() || Date.parse(sample.receivedAt)<=baseline.barrier)continue;
      const previous=baseline.sample;
      if(previous?.observationId===sample.observationId)continue;
      if(previous && previous.sourceKey===sample.sourceKey && Date.parse(sample.observedAt)<=Date.parse(previous.observedAt))continue;
      baseline.sample=sample;
      if(!previous?.point || previous.sourceKey!==sample.sourceKey || !baseline.seeded){
        baseline.seeded=true;
        baseline.armed=p.operator==='falls_below'?sample.value>=scalar(p.value)+p.resetMargin:sample.value<=scalar(p.value)-p.resetMargin;
        continue;
      }
      const edge=crossed(p,previous.value,sample.value,baseline.armed);baseline.armed=edge.armed;
      if(!edge.fire)continue;
      if(this.now()-Date.parse(sample.receivedAt)>BUDGETS.eventDeadlineMs)continue;
      const hash=crypto.createHash('sha256').update(sample.sourceKey+':'+sample.observationId).digest('hex');
      const occurrence={id:`${id}:${stored.automation.revision}:event:${hash}`,automationId:id,revision:stored.automation.revision,scheduledFor:new Date(sample.receivedAt).toISOString(),source:'platform_sync'};
      if(!await this.scheduler.claim(occurrence,stored.automation,stored.actions))continue;
      const evaluated=captured.evaluated;
      let reason=evaluated.result===null?'condition_unknown':evaluated.result===false?'condition_not_met':null;
      const budgetKey=`${id}:${stored.automation.revision}`;
      if(!reason) await this.store.mutateNativeAutomation(state=>{
        const runtime=state.automationRuntime.deviceTriggers ||= {rules:{},minute:0,home:0,devices:{}};
        const minute=Math.floor(this.now()/60000);
        if(runtime.minute!==minute){runtime.minute=minute;runtime.home=0;runtime.devices={};}
        for(const key of Object.keys(runtime.rules))if(!state.automations[key.split(':')[0]] || Object.keys(runtime.rules).length>200)delete runtime.rules[key];
        const history=(runtime.rules[budgetKey]?.runs||[]).filter(at=>at>this.now()-3600000);
        const last=history[history.length-1];
        if(history.length>=BUDGETS.runsPerRulePerHour){reason='repeat_guard_paused';runtime.rules[budgetKey]={runs:history,suspended:true};return;}
        if(runtime.rules[budgetKey]?.suspended){reason='repeat_guard_paused';return;}
        if(last!=null && this.now()-last<BUDGETS.cooldownMs){reason='cooldown';return;}
        const counts=Object.create(null);for(const action of stored.actions)counts[action.deviceId]=(counts[action.deviceId]||0)+1;
        if(runtime.home+stored.actions.length>BUDGETS.homeActionsPerMinute || Object.entries(counts).some(([key,count])=>(runtime.devices[key]||0)+count>BUDGETS.deviceActionsPerMinute)){reason='dispatch_budget';return;}
        history.push(this.now());runtime.rules[budgetKey]={runs:history};runtime.home+=stored.actions.length;
        for(const [key,count] of Object.entries(counts))runtime.devices[key]=(runtime.devices[key]||0)+count;
      });
      if(!reason && !this.authorize(stored))reason='authority_changed';
      if(reason){await this.skipped(occurrence,stored,reason,evaluated);continue;}
      await this.store.mutateNativeAutomation(state=>Object.assign(state.automationOccurrences[occurrence.id],{conditionResults:evaluated.results,triggerObservedAt:sample.observedAt}));
      await this.executor.executeOccurrence(occurrence,stored.automation,stored.trigger,stored.actions);
    }
  }
}
module.exports={DeviceTriggerCoordinator,BUDGETS};
