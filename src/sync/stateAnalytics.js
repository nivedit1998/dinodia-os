'use strict';
const crypto = require('node:crypto');
const {calendarDay, calendarWeek, annualDayCutoff} = require('./analyticsCalendar');
const POLICIES = Object.freeze({
  SOCKET:{dimension:'power',states:['on','off','unknown']},TV:{dimension:'power',states:['on','off','unknown']},
  BLIND:{dimension:'position',states:['open','closed','partial','unknown']},
  AC:{dimension:'thermal_activity',states:['heating','cooling','idle','unknown']},
  WASHING_MACHINE:{dimension:'cycle_activity',states:['running','idle','finished','error','unknown']},
});
const iso = n => new Date(n).toISOString();
const quantize = n => Math.ceil(n/1000)*1000;
const empty = category => Object.fromEntries(POLICIES[category].states.map(s=>[s,0]));
function aggregateId(p) {
  return crypto.createHash('sha256').update(JSON.stringify([p.contractVersion,p.osDeviceId,p.osAreaId,p.analyticsCategory,p.dimension,p.controlId,
    p.sourceGeneration,p.bindingRevision,p.analyticsIntervalId,p.assignmentEpochAt,p.writerFrom,p.dayStartAt])).digest('hex');
}
function activity(category,value) {
  if (category==='SOCKET'||category==='TV') return value===true?'on':value===false?'off':'unknown';
  if (category==='BLIND') return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100
    ? value===0?'closed':value===100?'open':'partial':'unknown';
  // These values are permitted only on the corresponding measured activity
  // semantic role. Modes, setpoints and arbitrary device words are not inputs.
  return typeof value==='string'&&POLICIES[category]?.states.includes(value)?value:'unknown';
}
function initialize(usage,config) {
  if (!config?.active) return null;
  const state=usage.stateAnalytics ||= {version:1,config:config.config,sources:{},days:{},queued:{}};
  if (state.config.writerFrom!==config.config.writerFrom||state.config.timezone!==config.config.timezone)
    throw new Error('State analytics writer identity changed without reconciliation');
  state.config=config.config;
  return state;
}
function rowIdentity(state,source,day) {
  return {contractVersion:1,osDeviceId:source.osDeviceId,osAreaId:source.osAreaId,analyticsCategory:source.analyticsCategory,
    dimension:POLICIES[source.analyticsCategory].dimension,controlId:source.controlId,sourceGeneration:source.sourceGeneration,bindingRevision:source.bindingRevision,
    analyticsIntervalId:source.analyticsIntervalId,analyticsPolicyVersion:4,timezone:state.config.timezone,writerFrom:state.config.writerFrom,
    dayStartAt:iso(day.start),dayEndAt:iso(day.end),assignmentEpochAt:source.assignmentEpochAt};
}
function correctTail(state,source,observed,until,nextActivity) {
  let cursor=Math.max(quantize(observed),Date.parse(source.assignmentEpochAt),Date.parse(state.config.writerFrom));
  const oldUntil=Number.isFinite(source.validUntil)?source.validUntil:cursor;
  const end=Math.min(source.accountedThrough,Math.max(oldUntil,until));
  while(cursor<end) {
    const day=calendarDay(cursor,state.config.timezone),hour=Math.floor(cursor/3600000)*3600000;
    const oldState=cursor>=source.observedAt&&cursor<oldUntil?source.activity:'unknown';
    const nextState=cursor<until?nextActivity:'unknown';
    const stop=Math.min(end,day.end,hour+3600000,oldUntil>cursor?oldUntil:end,until>cursor?until:end);
    if(stop<=cursor)throw new Error('State analytics correction did not advance');
    const row=state.days[aggregateId(rowIdentity(state,source,day))];
    if(row&&oldState!==nextState) {
      const seconds=(stop-cursor)/1000;
      if(row.durationsSeconds[oldState]<seconds)throw new Error('State analytics correction exceeds recorded evidence');
      row.durationsSeconds[oldState]-=seconds;row.durationsSeconds[nextState]+=seconds;row.revision++;
      const part=row.hourly.find(h=>h.hourStartAt===iso(hour));
      if(part){
        if(part.durationsSeconds[oldState]<seconds)throw new Error('Hourly analytics correction exceeds recorded evidence');
        part.durationsSeconds[oldState]-=seconds;part.durationsSeconds[nextState]+=seconds;
      }
    }
    cursor=stop;
  }
}
function add(state,source,end,forcedUnknown=false) {
  let cursor=source.accountedThrough;
  if (!Number.isSafeInteger(cursor)||!Number.isSafeInteger(end)||end<=cursor) return;
  while(cursor<end) {
    const day=calendarDay(cursor,state.config.timezone),hour=Math.floor(cursor/3600000)*3600000;
    const deadline=Number.isFinite(source.validUntil)?source.validUntil:cursor;
    const known=!forcedUnknown&&cursor>=source.observedAt&&cursor<deadline;
    const stop=Math.min(end,day.end,hour+3600000,known?deadline:end);
    if(stop<=cursor) throw new Error('State analytics did not advance');
    const p=rowIdentity(state,source,day);
    const key=aggregateId(p), row=state.days[key] ||= {...p,revision:0,coverageStartAt:iso(cursor),coverageEndAt:iso(cursor),
      closedAt:null,durationsSeconds:empty(source.analyticsCategory),hourly:[]};
    const value=known?source.activity:'unknown',seconds=(stop-cursor)/1000;
    row.durationsSeconds[value]+=seconds; row.coverageEndAt=iso(stop); row.revision++;
    if(stop===day.end) row.closedAt=iso(stop);
    let part=row.hourly.find(h=>h.hourStartAt===iso(hour));
    if(!part) { part={hourStartAt:iso(hour),coverageStartAt:iso(cursor),coverageEndAt:iso(cursor),durationsSeconds:empty(source.analyticsCategory)};row.hourly.push(part); }
    part.durationsSeconds[value]+=seconds;part.coverageEndAt=iso(stop);cursor=stop;
  }
  source.accountedThrough=end;
}
/** Called only with current signed assignment and exact-value evidence. This
 * function never configures, reads or commands physical devices. */
function observe(usage,input,now) {
  const state=usage.stateAnalytics;
  if(!state||!Object.hasOwn(POLICIES,input.analyticsCategory)||input.analyticsPolicyVersion!==4) return false;
  let start=quantize(Math.max(Date.parse(state.config.writerFrom),Date.parse(input.assignmentEpochAt),Date.parse(input.validFrom)));
  const end=Math.floor(now/1000)*1000;
  if(!Number.isFinite(start)||end<start) return false;
  const key=input.osDeviceId,old=state.sources[key];
  const identity=JSON.stringify([input.osAreaId,input.analyticsCategory,input.controlId,input.sourceGeneration,input.bindingRevision,input.analyticsIntervalId,input.assignmentEpochAt]);
  if(old&&old.identity!==identity) {
    // The canonical signed boundary closes the previous source. If delivery
    // was late, already-accounted ambiguous data is not proportionally split.
    // Caller must not reactivate this source until recovery resolves it.
    if(old.accountedThrough>start) start=old.accountedThrough;
    else add(state,old,Math.min(end,start));
    old.ended=true;
  }
  let source=state.sources[key];
  if(!source||source.identity!==identity) source=state.sources[key]={...input,identity,accountedThrough:start,activity:'unknown',observedAt:NaN,validUntil:NaN};
  if(source.ended) return false;
  if(source.suspended){add(state,source,end,true);source.suspended=false;source.ignoreThrough=now-1;}
  const e=input.evidence;
  const observed=Date.parse(e?.observedAt || e?.lastReported?.observedAt);
  const rawUntil=Date.parse(e?.validUntil);
  const trusted=e?.quality==='fresh'&&rawUntil>observed;
  const until=trusted?Math.floor(rawUntil/1000)*1000:quantize(observed);
  if(Number.isFinite(observed)&&observed>=start&&observed<=now&&observed>(source.ignoreThrough??-Infinity)
    &&(!Number.isFinite(source.observedAt)||observed>source.observedAt)) {
    const nextActivity=trusted?activity(input.analyticsCategory,e.value):'unknown';
    correctTail(state,source,observed,until,nextActivity);
    const boundary=Math.max(source.accountedThrough,quantize(observed));
    add(state,source,Math.min(end,boundary));
    // Do not extend a repeated observation's deadline after restart/replay.
    source.observedAt=observed;source.validUntil=until;source.activity=nextActivity;
  }
  add(state,source,end);return true;
}
function end(usage,deviceId,now) {const state=usage.stateAnalytics,s=state?.sources[deviceId];if(s&&!s.ended){
  const boundary=Math.floor(now/1000)*1000;add(state,s,boundary);s.validUntil=Math.min(s.validUntil,boundary);
}}
function suspend(usage,deviceId){const s=usage.stateAnalytics?.sources[deviceId];if(s){s.suspended=true;s.validUntil=Math.min(s.validUntil,s.accountedThrough);}}
function capAtLastAlive(usage,alive) {
  for(const s of Object.values(usage.stateAnalytics?.sources||{})) s.validUntil=Math.min(s.validUntil,Math.floor(alive/1000)*1000);
}
function events(usage,now) {
  const state=usage.stateAnalytics;if(!state)return [];
  const cutoff=annualDayCutoff(now,state.config.timezone),week=calendarWeek(now,state.config.timezone);
  const result=[];
  for(const [id,row]of Object.entries(state.days)) {
    if(Date.parse(row.dayEndAt)<=cutoff){delete state.days[id];delete state.queued[id];continue;}
    if(Date.parse(row.dayEndAt)<=week.start) row.hourly=[];
    if(row.revision>(state.queued[id]||0))result.push({aggregateId:id,payload:structuredClone(row)});
  }
  return result;
}
module.exports={POLICIES,activity,aggregateId,initialize,observe,end,suspend,capAtLastAlive,events};
