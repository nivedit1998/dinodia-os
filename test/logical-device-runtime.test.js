'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { HomeAssistantModel } = require('../src/haModel');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const twoGang = require('./fixtures/zigbee/two-gang-light.json');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-logical-runtime-'));
  const file = path.join(directory, 'store.json');
  const store = new Store(file);
  t.after(async () => { await store.persist(); await fs.rm(directory, { recursive: true, force: true }); });
  await store.saveArea({ name: 'Room 1' }, 'room-1');
  await store.saveArea({ name: 'Room 2' }, 'room-2');
  const parent = normalizeZigbeeDevice(twoGang);
  await store.upsertDevice(parent);
  return { store, parent, file };
}

async function assign(f) {
  return f.store.assignLogicalDevices(f.parent.id, {
    expectedManifestDigest: f.store.logicalDeviceManifest(f.parent.id).digest,
    assignments: [
      { channelKey: 'l1', areaId: 'room-1', name: 'Room 1 light', labelId: 'light' },
      { channelKey: 'l2', areaId: 'room-2', name: 'Room 2 light', labelId: 'light' },
    ],
  });
}

test('LD01 real Store and command model independently assign and route two physical channels', async (t) => {
  const f = await fixture(t);
  const children = await assign(f);
  assert.equal(f.store.listDevices().length, 1, 'transport inventory contains one physical parent');
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(child => child.areaId).sort(), ['room-1', 'room-2']);
  const effects = [];
  const model = new HomeAssistantModel({ store: f.store,
    commandEntity: async (...args) => effects.push(args) });
  const first = model.entities().find(entry => entry.entity.attributes.area_id === 'room-1');
  assert.ok(first);
  await model.callService('switch', 'turn_on', { entity_id: first.haId });
  assert.equal(effects.length, 1);
  assert.equal(effects[0][0].id, f.parent.id, 'dispatch resolves to the single physical pairing');
  assert.equal(effects[0][1].stateKey, 'state_l1');
  assert.deepEqual(effects[0][6], { deviceId: children[0].id, mappingRevision: children[0].mappingRevision },
    'every feature write retains the logical authority revision until adapter dispatch');
});

test('LD01 restart and parent re-interview do not merge logical assignments', async (t) => {
  const f = await fixture(t);
  const before = await assign(f);
  const restarted = new Store(f.file);
  await restarted.upsertDevice(normalizeZigbeeDevice({ ...twoGang, friendly_name: 'Renamed hardware' }));
  assert.deepEqual(restarted.listManagedDevices().map(d => [d.id, d.areaId]).sort(),
    before.map(d => [d.id, d.areaId]).sort());
});

test('LD01 deleting a room channel cannot unpair or remove its sibling hardware', async (t) => {
  const f = await fixture(t);
  const children = await assign(f);
  const target = children.find(child => child.areaId === 'room-1');
  const survivor = children.find(child => child.areaId === 'room-2');
  await f.store.suppressLogicalDevice(target.id);
  assert.ok(f.store.getDevice(f.parent.id));
  assert.equal(f.store.getManagedDevice(target.id), null);
  assert.ok(f.store.getManagedDevice(survivor.id));
  await f.store.upsertDevice(normalizeZigbeeDevice(twoGang));
  assert.equal(f.store.getManagedDevice(target.id), null, 'rediscovery cannot resurrect a deleted child');
});

test('LD01 genuine observations stay on their source after logical projection', async (t) => {
  const f = await fixture(t);
  const children = await assign(f);
  const at = '2026-10-24T08:00:00.000Z';
  await f.store.updateDeviceState(f.parent.id, { state_l1: 'ON' }, { protocol: 'zigbee',
    reportedStateKeys: ['state_l1'], sourceObservedAtByStateKey: { state_l1: at },
    sourceReceivedAtByStateKey: { state_l1: at } });
  const first = f.store.getManagedDevice(children.find(c => c.areaId === 'room-1').id);
  const second = f.store.getManagedDevice(children.find(c => c.areaId === 'room-2').id);
  assert.equal(Object.values(first.entities).find(e => e.stateKey === 'state_l1').sourceObservedAt, at);
  assert.equal(Object.values(second.entities).some(e => e.stateKey === 'state_l1'), false);
});

test('physical device removal API on a child suppresses it without unpairing the parent', async (t) => {
  const f = await fixture(t);
  const children = await assign(f);
  const effects = [];
  const model = new HomeAssistantModel({ store: f.store, removeProtocolDevice: async (...args) => effects.push(args) });
  await model.removeDevice({ device_id: children[0].id });
  assert.equal(effects.length, 0);
  assert.ok(f.store.getDevice(f.parent.id));
  assert.ok(f.store.getManagedDevice(children[1].id));
});

test('deleted child reports cannot refill raw parent telemetry through normal Store ingestion', async (t) => {
  const f = await fixture(t);
  const children = await assign(f);
  const child = children.find(c => c.areaId === 'room-1');
  await f.store.suppressLogicalDevice(child.id);
  const at = new Date().toISOString();
  await f.store.updateDeviceState(f.parent.id, { state_l1: 'ON', state_l2: 'OFF' }, { protocol: 'zigbee',
    reportedStateKeys: ['state_l1', 'state_l2'], sourceObservedAtByStateKey: { state_l1: at, state_l2: at },
    sourceReceivedAtByStateKey: { state_l1: at, state_l2: at } });
  const parent = f.store.getDevice(f.parent.id);
  assert.equal(parent.state.state_l1, undefined);
  assert.equal(Object.values(parent.entities).find(e => e.stateKey === 'state_l1').lastReported, undefined);
  assert.equal(Object.values(parent.entities).find(e => e.stateKey === 'state_l2').state, 'OFF');
});
