'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const template = require('./fixtures/zigbee/dimmable-light.json');
const at = Date.parse('2026-10-23T08:00:00.000Z');
async function withLight(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-uc03-light-'));
  try {
    const store = new Store(path.join(directory, 'synthetic.json'));
    store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
    await store.saveArea({ name: 'Synthetic room' }, 'area');
    await store.savePlatform({ homeId: 'synthetic-home' });
    const device = await store.upsertDevice({ ...normalizeZigbeeDevice(structuredClone(template)), areaId: 'area',
      setup: { status: 'ready', assignmentMode: 'device_inherited_v1' } },
    { devicePolicy: { managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'LIGHT', lifecycle: 'INSTALLED' } });
    const report = async (values, now) => store.updateDeviceState(device.id, values, {
      nowMs: now, reportedStateKeys: Object.keys(values),
      sourceObservedAtByStateKey: Object.fromEntries(Object.keys(values).map(key => [key, new Date(now).toISOString()])),
      sourceReceivedAtByStateKey: Object.fromEntries(Object.keys(values).map(key => [key, new Date(now).toISOString()])) });
    await run({ store, report });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test('real Store: power OFF overrides remembered positive brightness in recorded seconds', async () => {
  await withLight(async ({ store, report }) => {
    await report({ state: 'OFF', brightness: 128 }, at);
    await store.advanceSyncUsage(at + 60_000);
    const totals = Object.values(store.snapshot().syncUsage.buckets).reduce((sum, row) =>
      [sum[0] + row.onSeconds, sum[1] + row.offSeconds], [0, 0]);
    assert.deepEqual(totals, [0, 60]);
  });
});
test('real Store: stale authoritative power never falls back to a fresh brightness report', async () => {
  await withLight(async ({ store, report }) => {
    await report({ state: 'OFF', brightness: 0 }, at);
    await store.advanceSyncUsage(at + 421_000);
    await report({ brightness: 128 }, at + 421_000);
    await store.advanceSyncUsage(at + 481_000);
    const totals = Object.values(store.snapshot().syncUsage.buckets).reduce((sum, row) =>
      [sum[0] + row.onSeconds, sum[1] + row.unknownSeconds], [0, 0]);
    assert.equal(totals[0], 0);
    assert.equal(totals[1], 61);
  });
});
test('next binding policy: two unselected light endpoints must not silently select the first', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-uc02-'));
  try {
    const store = new Store(path.join(directory, 'synthetic.json'));
    store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
    await store.saveArea({ name: 'Synthetic room' }, 'area');
    await store.savePlatform({ homeId: 'synthetic-home' });
    const d = normalizeZigbeeDevice(structuredClone(template));
    const prototype = Object.values(d.entities).find(e => e.capability.semanticRole === 'power');
    d.entities = Object.fromEntries(['1', '2'].map(endpoint => {
      const id = d.id + ':' + endpoint + ':state';
      const stateKey = 'state_' + endpoint;
      return [id, { ...structuredClone(prototype), id, sourceId: id, endpointId: endpoint,
        logicalKey: stateKey, stateKey, binding: { adapter: 'zigbee', property: stateKey, endpoint },
        capability: { ...structuredClone(prototype.capability), stateKey },
        converter: { ...prototype.converter, endpoint, path: 'endpoint.' + endpoint, parentPath: 'endpoint.' + endpoint } }];
    }));
    const saved = await store.upsertDevice({ ...d, areaId: 'area',
      setup: { status: 'ready', assignmentMode: 'device_inherited_v1' } },
      { devicePolicy: { managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'LIGHT', lifecycle: 'INSTALLED' } });
    assert.equal(Object.keys(saved.entities).length, 2, 'both independent source candidates exist');
    await store.updateDeviceState(saved.id, { state_1: 'ON', state_2: 'OFF' }, {
      nowMs: at, reportedStateKeys: ['state_1', 'state_2'],
      sourceObservedAtByStateKey: { state_1: new Date(at).toISOString(), state_2: new Date(at).toISOString() },
      sourceReceivedAtByStateKey: { state_1: new Date(at).toISOString(), state_2: new Date(at).toISOString() }
    });
    const observed = Object.values(store.getDevice(saved.id).entities);
    assert.ok(observed.every(e => e.sourceObservedAt === new Date(at).toISOString()),
      'both genuine synthetic observations must reach the real Store');
    assert.equal(Object.keys(store.snapshot().syncUsage.sources).length, 0,
      'ambiguous unselected groups must stay Unknown, not choose array position zero');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
