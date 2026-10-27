const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { Store } = require('../src/store');
const { HomeAssistantModel } = require('../src/haModel');
const { commandForBinding } = require('../src/integrations/zigbee/commandAdapter');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('a position-only Zigbee cover does not invent open, close or stop operations', () => {
  const device = normalizeZigbeeDevice({
    ieee_address: '0x0011223344556677', friendly_name: 'synthetic-cover',
    supported: true, interview_completed: true,
    definition: { exposes: [{ type: 'cover', features: [
      { type: 'numeric', property: 'position', access: 7, value_min: 0, value_max: 100 },
    ] }] },
  });
  const position = Object.values(device.entities).find(entity => entity.stateKey === 'position');
  assert.ok(position, 'the real normalizer must discover the position control');
  const services = position.capability.bindings.map(binding => binding.serviceId);
  assert.ok(services.includes('cover.set_cover_position'), 'actual supported position should remain usable');
  assert.deepEqual(services.filter(service => ['cover.open_cover', 'cover.close_cover', 'cover.stop_cover'].includes(service)), [],
    'operations not declared by the source must not be invented');
  assert.deepEqual(commandForBinding(position, 'cover.set_cover_position', {position: 42}), {position: 42});
  assert.throws(() => commandForBinding(position, 'cover.set_cover_position', {position: 101}), /maximum/);
  for (const invalid of [null, '', undefined]) {
    assert.throws(() => commandForBinding(position, 'cover.set_cover_position', {position: invalid}), /numeric/);
  }
});

test('position writes respect the advertised step', () => {
  const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566bb',friendly_name:'synthetic-cover',
    definition:{exposes:[{type:'cover',features:[{type:'numeric',property:'position',access:7,value_min:0,value_max:100,value_step:10}]}]}});
  const position = Object.values(device.entities).find(entity => entity.stateKey === 'position');
  assert.deepEqual(commandForBinding(position,'cover.set_cover_position',{position:20}),{position:20});
  assert.throws(() => commandForBinding(position,'cover.set_cover_position',{position:15}), /step/);
});

test('cover state exposes enable only explicitly advertised matching operations', () => {
  const device = normalizeZigbeeDevice({ieee_address:'0x0011223344556688', friendly_name:'synthetic-cover',
    definition:{exposes:[{type:'cover', features:[{type:'enum',property:'state',access:7,values:['OPEN','CLOSE']}]}]}});
  const state = Object.values(device.entities).find(entity => entity.stateKey === 'state');
  assert.ok(state);
  assert.deepEqual(state.capability.bindings.map(binding => binding.serviceId), ['cover.open_cover','cover.close_cover']);
  assert.deepEqual(commandForBinding(state, 'cover.open_cover'), {state:'OPEN'});
  assert.throws(() => commandForBinding(state, 'cover.stop_cover'), /not supported/);
});

test('position-only cover rejects unsupported stop through the runtime service router', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-cover-routing-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const device = normalizeZigbeeDevice({ ieee_address:'0x0011223344556677', friendly_name:'synthetic-cover',
      definition:{ exposes:[{ type:'cover', features:[{ type:'numeric', property:'position', access:7, value_min:0, value_max:100 }] }] } });
    const area = await store.saveArea({name:'Test room'}, 'test-room');
    await store.upsertDevice(device);
    await store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'none'});
    const calls = [];
    const model = new HomeAssistantModel({store,commandDevice:async()=>{throw new Error('fallback used');},commandEntity:async(...args)=>calls.push(args)});
    const target = model.entities().find(item=>item.device.id===device.id);
    assert.ok(target, 'fixture must be discoverable in the real service model');
    await assert.rejects(() => model.callService('cover','stop_cover',{entity_id:target.haId}), /not supported/);
    assert.equal(calls.length,0,'unsupported action must never reach the adapter');
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('rediscovery replaces obsolete cover bindings without moving the existing device', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-cover-rediscovery-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const input = {ieee_address:'0x0011223344556677', friendly_name:'synthetic-cover',
      definition:{exposes:[{type:'cover',features:[{type:'numeric',property:'position',access:7,value_min:0,value_max:100}]}]}};
    const device = normalizeZigbeeDevice(input);
    const old = structuredClone(device);
    const oldPosition = Object.values(old.entities).find(entity => entity.stateKey === 'position');
    delete oldPosition.capability.bindings.find(binding => binding.serviceId === 'cover.set_cover_position').parameter;
    oldPosition.capability.bindings.push({serviceId:'cover.stop_cover',operation:'stop_cover'});
    assert.throws(() => commandForBinding(oldPosition,'cover.stop_cover'), /not supported/,
      'a persisted obsolete binding must be rejected before rediscovery');
    assert.throws(() => commandForBinding(oldPosition,'cover.set_cover_position',{position:101}), /maximum/,
      'the stored expose bounds remain authoritative before rediscovery');
    const area = await store.saveArea({name:'Test room'}, 'test-room');
    await store.upsertDevice(old);
    await store.completeDeviceSetup(old.id,{areaId:area.id,labelId:'none'});
    const persistedBeforeInventory = Object.values(store.getDevice(device.id).entities).find(entity => entity.stateKey === 'position');
    assert.ok(persistedBeforeInventory.capability.bindings.some(binding => binding.serviceId === 'cover.stop_cover'),
      'fixture must model the old binding still persisted before a fresh inventory');
    assert.throws(() => commandForBinding(persistedBeforeInventory,'cover.stop_cover'), /not supported/);
    assert.throws(() => commandForBinding(persistedBeforeInventory,'cover.set_cover_position',{position:101}), /maximum/);
    await store.upsertDevice(normalizeZigbeeDevice(input));
    const current = store.getDevice(device.id);
    assert.equal(current.areaId,area.id);
    const position = Object.values(current.entities).find(entity => entity.stateKey === 'position');
    assert.ok(position.capability.bindings.some(binding => binding.serviceId === 'cover.set_cover_position'));
    assert.ok(!position.capability.bindings.some(binding => binding.serviceId === 'cover.stop_cover'));
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('a normalized Zigbee cover with no exact binding cannot use the legacy fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-cover-empty-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const device = normalizeZigbeeDevice({ieee_address:'0x0011223344556699', friendly_name:'synthetic-cover',
      definition:{exposes:[{type:'cover',features:[{type:'numeric',property:'position',access:7,value_min:0,value_max:100}]}]}});
    const area = await store.saveArea({name:'Test room'}, 'test-room');
    await store.upsertDevice(device);
    await store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'none'});
    const calls = [];
    const model = new HomeAssistantModel({store,commandDevice:async(...args)=>calls.push(args),commandEntity:async(...args)=>calls.push(args)});
    const target = model.entities().find(item=>item.device.id===device.id);
    assert.ok(target);
    // Directly exercise the empty-binding service decision, including the
    // legacy fallback branch, without mutating persisted household data.
    assert.equal(model.supportsService('cover','stop_cover',{...target,entity:{...target.entity,capability:{...target.entity.capability,bindings:[]}}}), false);
    assert.equal(calls.length,0);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('a cover cannot fall back to a generic physical command if exact adapter routing is unavailable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-cover-fallback-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566aa', friendly_name:'synthetic-cover',
      definition:{exposes:[{type:'cover',features:[{type:'numeric',property:'position',access:7,value_min:0,value_max:100}]}]}});
    const area = await store.saveArea({name:'Test room'}, 'test-room');
    await store.upsertDevice(device);
    await store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'none'});
    const calls = [];
    const model = new HomeAssistantModel({store,commandDevice:async(...args)=>calls.push(args)});
    const target = model.entities().find(item=>item.device.id===device.id);
    assert.ok(target);
    await assert.rejects(() => model.callService('cover','set_cover_position',{entity_id:target.haId,position:42}), /exact source binding/);
    assert.equal(calls.length,0);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('runtime cover router with adapter rejects missing, out-of-range and off-step positions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-cover-values-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const device = normalizeZigbeeDevice({ieee_address:'0x00112233445566cc', friendly_name:'synthetic-cover',
      definition:{exposes:[{type:'cover',features:[{type:'numeric',property:'position',access:7,value_min:0,value_max:100,value_step:10}]}]}});
    const area = await store.saveArea({name:'Test room'}, 'test-room');
    await store.upsertDevice(device);
    await store.completeDeviceSetup(device.id,{areaId:area.id,labelId:'none'});
    const calls = [];
    const model = new HomeAssistantModel({store,commandDevice:async()=>{throw new Error('fallback used');},
      commandEntity:async (_device, entity, service, data) => {calls.push(commandForBinding(entity,service,data));}});
    const target = model.entities().find(item=>item.device.id===device.id);
    assert.ok(target);
    for (const position of [null, '', 101, 15]) {
      await assert.rejects(() => model.callService('cover','set_cover_position',{entity_id:target.haId,position}));
    }
    assert.deepEqual(calls,[]);
    await model.callService('cover','set_cover_position',{entity_id:target.haId,position:20});
    assert.deepEqual(calls,[{position:20}]);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
