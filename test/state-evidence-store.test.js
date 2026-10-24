'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { ObservationReconciler } = require('../src/observation/reconciler');
const fixture = require('./fixtures/zigbee/sonoff-trvzb-observation.json');
const { checkedStateFixture } = require('./helpers/checked-state-fixture');

test('E09 real Store preserves the last genuine value across an unproved changed cache and restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-state-evidence-'));
  try {
    const file = path.join(directory, 'store.json');
    const store = new Store(file);
    const device = normalizeZigbeeDevice(fixture); await store.upsertDevice(device);
    const property = 'occupied_heating_setpoint';
    const at = '2026-10-24T08:00:00.000Z';
    await store.updateDeviceState(device.id, { [property]: 22 }, { protocol: 'zigbee', reportedStateKeys: [property],
      sourceObservedAtByStateKey: { [property]: at }, sourceReceivedAtByStateKey: { [property]: at } });
    await store.updateDeviceState(device.id, { [property]: 23 }, { protocol: 'zigbee', reportedStateKeys: [property] });
    const reloaded = new Store(file);
    const entity = Object.values(reloaded.getDevice(device.id).entities).find(item => item.stateKey === property);
    assert.equal(entity.lastReported?.value, 22);
    assert.equal(entity.lastReported?.observedAt, at);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('U24/U25 property profile approval cannot send even configuration reads to a private tenant device', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-private-consent-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    const device = normalizeZigbeeDevice(fixture);
    await store.upsertDevice(device, { devicePolicy: { managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant', lifecycle: 'INSTALLED' } });
    const operations = [];
    const reconciler = new ObservationReconciler({ store, resolveDeviceId: () => device.id,
      clock: () => Date.parse('2026-10-24T08:00:00.000Z'), publishBridgeRequest: async (...args) => operations.push(args) });
    await reconciler.onInventory([fixture]); await reconciler.tick();
    assert.deepEqual(operations, []);
    assert.equal(reconciler.status().length, 0, 'private devices are not automatically enrolled by a property profile');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('E22 real Store admits a new hourly checked sample without the old battery ceiling', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-hourly-evidence-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    store.setSyncSourceGeneration(3);
    const now = Date.now(); const observedAt = new Date(now).toISOString();
    const device = { ...normalizeZigbeeDevice(fixture), areaId: 'area', setup: { status: 'ready' } };
    await store.savePlatform({ homeId: 'home', devicePolicies: { [device.id]: {
      managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED', analyticsCategory: 'RADIATOR',
    } } });
    await store.upsertDevice(device);
    const entity = Object.values(store.getDevice(device.id).entities).find(item => item.stateKey === 'occupied_heating_setpoint');
    assert.ok(entity);
    await store.putObservationPolicyRecord('checked-hourly', { key: 'checked-hourly', deviceId: device.id,
      controlId: entity.capability.controlId, endpoint: '1', property: entity.stateKey,
      cluster: 'hvacThermostat', attribute: 'occupiedHeatingSetpoint', sourceGeneration: 3,
      state: 'cadence_verified', evidenceVersion: 2, runtimeSessionId: store.observationSessionId,
      evidenceVerifiedAt: new Date(now - 500).toISOString(), cadence: { verifiedAt: new Date(now - 500).toISOString() },
      readBack: { status: 0, maximumReportInterval: 3600, at: new Date(now - 1000).toISOString() } });
    await store.updateDeviceState(device.id, { occupied_heating_setpoint: 22 }, { protocol: 'zigbee', nowMs: now,
      reportedStateKeys: ['occupied_heating_setpoint'], sourceObservedAtByStateKey: { occupied_heating_setpoint: observedAt },
      sourceReceivedAtByStateKey: { occupied_heating_setpoint: observedAt } });
    const admitted = Object.values(store.getDevice(device.id).entities).find(item => item.stateKey === entity.stateKey);
    assert.equal(admitted.admittedEvidence.quality, 'fresh');
    assert.equal(admitted.sourceValidUntil, new Date(now + 3660000).toISOString());
    assert.equal(admitted.lastReported.sourceKey, admitted.admittedEvidence.sourceKey);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('connected real Zigbee read-back and unchanged reports admit exact evidence; retained packets do not renew it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-real-bridge-evidence-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    const fixture = await checkedStateFixture({ store, directory });
    const entity = Object.values(store.getDevice(fixture.deviceId).entities).find(item => item.stateKey === 'state');
    assert.equal(entity.admittedEvidence.quality, 'fresh');
    assert.ok(fixture.requests.every(item => item.topic.endsWith('/device/reporting/read')), 'no reporting write or actuator command');
    const original = entity.lastReported.observedAt;
    await fixture.report('ON', { retain: true });
    const after = Object.values(store.getDevice(fixture.deviceId).entities).find(item => item.stateKey === 'state');
    assert.equal(after.lastReported.observedAt, original);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
