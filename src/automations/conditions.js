'use strict';
const { dateParts } = require('./schedule');
function scalar(value) {
  if (!value || typeof value !== 'object') return undefined;
  return value.type === 'boolean' ? value.boolean : value.type === 'number' ? value.number : value.type === 'option' ? value.option : undefined;
}
function sources(payload) {
  if (payload?.kind !== 'device_state') return [];
  return [payload.source, ...(payload.conditions?.items || []).filter(x=>x.kind==='device_state').map(x=>x.source)];
}
function validSource(source) {
  return source && ['deviceId','areaId','controlId','osDeviceId','osAreaId','managementClass'].every(k=>typeof source[k]==='string' && source[k].length>0 && source[k].length<=160)
    && Number.isSafeInteger(source.descriptorRevision) && source.descriptorRevision>0
    && ['PROPERTY_DEVICE','TENANT_DEVICE'].includes(source.managementClass)
    && (source.managementClass==='PROPERTY_DEVICE' ? source.ownerMembershipId===null : typeof source.ownerMembershipId==='string');
}
function validTyped(value) {
  const n=scalar(value);
  return value?.type==='boolean' ? typeof n==='boolean' && Object.keys(value).sort().join(',')==='boolean,type'
    : value?.type==='number' ? Number.isFinite(n) && Object.keys(value).sort().join(',')==='number,type'
    : value?.type==='option' && typeof n==='string' && n.length<=128 && Object.keys(value).sort().join(',')==='option,type';
}
function validDeviceTrigger(payload) {
  if (!payload || Object.keys(payload).some(k=>!['kind','source','operator','value','resetMargin','cooldownSeconds','conditions','timeZoneIdentifier'].includes(k))
    || payload.kind!=='device_state' || !validSource(payload.source) || !['becomes','rises_above','falls_below'].includes(payload.operator)
    || !validTyped(payload.value) || payload.operator!=='becomes' && payload.value.type!=='number'
    || payload.operator==='becomes' && payload.value.type==='number'
    || !Number.isFinite(payload.resetMargin) || payload.resetMargin<0 || payload.resetMargin>1000000 || payload.cooldownSeconds!==30) return false;
  const group=payload.conditions;
  if (!group || Object.keys(group).sort().join(',')!=='items,mode' || !['all','any'].includes(group.mode) || !Array.isArray(group.items) || group.items.length>8) return false;
  return group.items.every(item=>{
    if (item?.kind==='time_window') return Object.keys(item).sort().join(',')==='endMinute,kind,startMinute,weekdays'
      && [item.startMinute,item.endMinute].every(n=>Number.isInteger(n)&&n>=0&&n<1440) && item.startMinute!==item.endMinute
      && Array.isArray(item.weekdays) && item.weekdays.length>0 && item.weekdays.length<=7 && new Set(item.weekdays).size===item.weekdays.length && item.weekdays.every(n=>Number.isInteger(n)&&n>=1&&n<=7);
    if (item?.kind!=='device_state' || Object.keys(item).some(k=>!['kind','source','operator','value','upperValue'].includes(k)) || !validSource(item.source) || !validTyped(item.value)
      || !['equals','not_equals','above','below','between'].includes(item.operator)) return false;
    if (['above','below','between'].includes(item.operator) && item.value.type!=='number') return false;
    return item.operator==='between' ? validTyped(item.upperValue) && item.upperValue.type==='number' && scalar(item.upperValue)>scalar(item.value) : item.upperValue===undefined;
  });
}
function evaluateCondition(item, read, date, timeZone) {
  if (item.kind==='time_window') {
    const p=dateParts(date,timeZone), n=p.minuteOfDay;
    // For an overnight window, early-morning hours belong to the preceding selected day.
    const overnight=item.startMinute>item.endMinute;
    const day=overnight && n<item.endMinute ? (p.weekday===1?7:p.weekday-1) : p.weekday;
    return item.weekdays.includes(day) && (overnight ? n>=item.startMinute || n<item.endMinute : n>=item.startMinute && n<item.endMinute);
  }
  const sample=read(item.source);
  if (!sample || sample.quality!=='fresh' || sample.value==null) return null;
  const expected=scalar(item.value), actual=sample.value;
  if (typeof actual!==typeof expected) return null;
  switch(item.operator) {
    case 'equals': return Object.is(actual,expected);
    case 'not_equals': return !Object.is(actual,expected);
    case 'above': return actual>expected;
    case 'below': return actual<expected;
    case 'between': return actual>=expected && actual<=scalar(item.upperValue);
    default:return null;
  }
}
function evaluateConditions(group,read,date,timeZone) {
  const results=(group?.items || []).map(item=>evaluateCondition(item,read,date,timeZone));
  if (!results.length) return {result:true,results};
  const result=group.mode==='any' ? results.includes(true)?true:results.includes(null)?null:false
    : results.includes(false)?false:results.includes(null)?null:true;
  return {result,results};
}
function crossed(payload,previous,next,latch) {
  const target=scalar(payload.value);
  if (typeof previous!==typeof next || typeof next!==typeof target) return {fire:false,armed:false};
  if(payload.operator==='becomes') return {fire:!Object.is(previous,next)&&Object.is(next,target),armed:true};
  let armed=latch;
  if(payload.operator==='falls_below') {
    if(next>=target+payload.resetMargin) armed=true;
    const fire=armed && previous>=target && next<target;
    return {fire,armed:fire?false:armed};
  }
  if(next<=target-payload.resetMargin) armed=true;
  const fire=armed && previous<=target && next>target;
  return {fire,armed:fire?false:armed};
}
module.exports={scalar,sources,validDeviceTrigger,evaluateCondition,evaluateConditions,crossed};
