'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { commandForBinding } = require('../src/integrations/zigbee/commandAdapter');
const { Store } = require('../src/store');
const { HomeAssistantModel } = require('../src/haModel');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('an unknown manufacturer numeric control retains its exact advertised property and constraints', () => {
  const device = normalizeZigbeeDevice({ ieee_address:'0x0011223344556699', friendly_name:'synthetic-device',
    definition:{vendor:'Unknown vendor',exposes:[{type:'numeric',property:'volume',access:7,value_min:0,value_max:100,value_step:5}]} });
  const volume = Object.values(device.entities).find(entity => entity.stateKey === 'volume');
  assert.ok(volume);
  assert.equal(volume.capability.kind, 'number', 'a declared writable numeric property is not merely a sensor');
  assert.ok(volume.capability.bindings.some(binding => binding.serviceId === 'number.set_value'));
  assert.deepEqual(commandForBinding(volume,'number.set_value',{value:25}),{volume:25});
  for (const value of [null, '', undefined, 23, 101, -1])
    assert.throws(() => commandForBinding(volume,'number.set_value',{value}), /numeric|minimum|maximum|step/);
});

test('numeric properties without an explicit write bit do not gain an unfamiliar set operation', () => {
  for (const access of [undefined, 1, 4, null, '7', [7], 7.5]) {
    const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566b0',friendly_name:'synthetic',
      definition:{exposes:[{type:'numeric',property:'volume',access,value_min:0,value_max:100,value_step:5}]}});
    const volume = Object.values(device.entities).find(entity => entity.stateKey === 'volume');
    assert.ok(volume);
    assert.equal(volume.capability.bindings.length,0);
  }
});

test('generic numeric dispatch rechecks exact stored expose and current limits', () => {
  const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566b1',friendly_name:'synthetic',
    definition:{exposes:[{type:'numeric',property:'volume',access:7,value_min:0,value_max:100,value_step:5}]}});
  const volume = Object.values(device.entities).find(entity => entity.stateKey === 'volume');
  for (const change of [{expose:{...volume.expose,access:1}}, {expose:{...volume.expose,type:'enum'}},
    {binding:{...volume.binding,property:'other'}}, {expose:{...volume.expose,access:'7'}}]) {
    assert.throws(() => commandForBinding({...volume,...change},'number.set_value',{value:25}), /unsupported|not supported/i);
  }
  assert.throws(() => commandForBinding({...volume,expose:{...volume.expose,value_max:50}},'number.set_value',{value:75}), /maximum/);
  assert.throws(() => commandForBinding({...volume,expose:{...volume.expose,value_step:10}},'number.set_value',{value:25}), /step/);
  const legacyExpose = {...volume.expose};
  delete legacyExpose.verifiedNumericAccess;
  assert.throws(() => commandForBinding({...volume,expose:legacyExpose},'number.set_value',{value:25}), /unsupported|not supported/i,
    'legacy coerced metadata cannot prove the access type until a fresh inventory');
  for (const change of [{operation:'toggle'}, {parameter:undefined}]) {
    const stale = {...volume,capability:{...volume.capability,bindings:volume.capability.bindings.map(binding=>({...binding,...change}))}};
    assert.throws(() => commandForBinding(stale,'number.set_value',{value:25}), /unsupported|not supported/i);
  }
});

test('known-looking root numeric property names cannot authorize malformed access metadata', () => {
  for (const access of ['7', [7], 7.5]) {
    const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566b2',friendly_name:'synthetic',
      definition:{exposes:[{type:'numeric',property:'volume_level',access,value_min:0,value_max:100,value_step:5}]}});
    const volume = Object.values(device.entities).find(entity => entity.stateKey === 'volume_level');
    assert.equal(volume.capability.bindings.length,0);
  }
});

test('root numeric properties with unsafe protocol keys are not advertised as writable controls', () => {
  const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566b4',friendly_name:'synthetic',
    definition:{exposes:[{type:'numeric',property:'fan-speed',access:7,value_min:0,value_max:100}]}});
  const control = Object.values(device.entities).find(entity => entity.stateKey === 'fan-speed');
  assert.ok(control);
  assert.equal(control.capability.bindings.length,0,'a descriptor must not advertise a route its exact adapter cannot send');
});

test('malformed numeric bounds and step do not advertise a writable root control', () => {
  for (const change of [{value_step:0}, {value_step:'5'}, {value_min:'0'}, {value_min:100,value_max:0}]) {
    const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566b5',friendly_name:'synthetic',
      definition:{exposes:[{type:'numeric',property:'volume',access:7,value_min:0,value_max:100,value_step:5,...change}]}});
    const control = Object.values(device.entities).find(entity=>entity.stateKey==='volume');
    assert.equal(control.capability.bindings.length,0,JSON.stringify(change));
    assert.notEqual(control.expose.verifiedNumericAccess,true,JSON.stringify(change));
  }
});

test('generic numeric controls do not fall back to physical commands without an exact adapter', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-number-fallback-'));
  try {
    const store = new Store(path.join(directory,'dinodia.json'));
    const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566b3',friendly_name:'synthetic',
      definition:{exposes:[{type:'numeric',property:'volume',access:7,value_min:0,value_max:100,value_step:5}]}});
    const area = await store.saveArea({name:'Test room'},'test-room');
    await store.upsertDevice(device);
    await store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'none'});
    const calls = [];
    const model = new HomeAssistantModel({store,commandDevice:async(...args)=>calls.push(args)});
    const target = model.entities().find(item=>item.device.id===device.id);
    assert.ok(target);
    await assert.rejects(() => model.callService('number','set_value',{entity_id:target.haId,value:25}), /exact source binding/);
    assert.equal(calls.length,0);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
