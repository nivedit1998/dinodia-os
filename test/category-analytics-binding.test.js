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
