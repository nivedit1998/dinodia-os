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
const { resolveStateEvidence } = require('../src/observation/stateEvidence');

test('offline then online cannot revive a pre-disconnection guarantee', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-offline-proof-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    const checked = await checkedStateFixture({ store, directory });
    await checked.bridge.handleMessage(`zigbee2mqtt/${checked.raw.friendly_name}/availability`, Buffer.from('"offline"'));
    await checked.bridge.handleMessage(`zigbee2mqtt/${checked.raw.friendly_name}/availability`, Buffer.from('"online"'));
    const device = store.getDevice(checked.deviceId), entity = Object.values(device.entities).find(item => item.stateKey === 'state');
    const evidence = resolveStateEvidence({ device, entity, control: { controlId: entity.capability.controlId, semanticRole: 'power', valueType: 'boolean', maxStateValiditySeconds: 360 },
      records: store.getObservationPolicyRecords(), sourceGeneration: 3, authorityValid: true, clockTrusted: true,
      runtimeSessionId: store.observationSessionId, now: checked.clock() });
    assert.notEqual(evidence.quality, 'fresh'); assert.equal(evidence.lastReported.value, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('removal discards old proof and a late callback cannot attach it to re-pairing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-repair-proof-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    const checked = await checkedStateFixture({ store, directory });
    const old = Object.values(store.getObservationPolicyRecords())[0];
    await checked.runtime.send(old, 'read', checked.clock());
    const oldTransaction = checked.requests.at(-1).value.transaction;
    await store.deleteDevice(checked.deviceId);
    assert.equal(Object.keys(store.getObservationPolicyRecords()).length, 0);
    await store.upsertDevice({ ...normalizeZigbeeDevice(checked.raw), areaId: 'fixture-area', setup: { status: 'ready' } });
    await checked.runtime.save(old);
    assert.equal(Object.keys(store.getObservationPolicyRecords()).length, 0, 'late old-lifecycle response must not recreate proof');
    await checked.runtime.onInventory([checked.raw]);
    await checked.runtime.onBridgeResponse('read', { status: 'ok', transaction: oldTransaction, data: {
      endpoint: 1, cluster: 'genOnOff', configs: [{ attrId: 0, status: 0, minRepIntval: 0, maxRepIntval: 300, repChange: 0 }] } });
    const replacement = Object.values(store.getObservationPolicyRecords())[0];
    assert.equal(replacement.readBack, null, 'retired transaction identity cannot verify replacement configuration');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('malformed newer numeric report invalidates currentness but retains the real value and age', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-malformed-report-'));
  try {
    const store = new Store(path.join(directory, 'store.json')); store.setSyncSourceGeneration(3);
    const device = normalizeZigbeeDevice(fixture); await store.upsertDevice(device);
    const property = 'occupied_heating_setpoint';
    for (const [value, at] of [[22, '2026-10-24T08:00:00.000Z'], ['bad number', '2026-10-24T08:01:00.000Z']]) {
      await store.updateDeviceState(device.id, { [property]: value }, { protocol: 'zigbee', reportedStateKeys: [property],
        sourceObservedAtByStateKey: { [property]: at }, sourceReceivedAtByStateKey: { [property]: at } });
    }
    const entity = Object.values(store.getDevice(device.id).entities).find(item => item.stateKey === property);
    assert.equal(entity.lastReported.value, 22); assert.equal(entity.lastReported.observedAt, '2026-10-24T08:00:00.000Z');
    assert.notEqual(entity.admittedEvidence?.quality, 'fresh');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

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
      deviceLifecycleId: store.getDevice(device.id).stateEvidenceLifecycleId,
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

test('a real provider Store path retains typed private values without inventing observation time', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-provider-limited-'));
  try {
    const store = new Store(path.join(directory, 'store.json')); store.setSyncSourceGeneration(3);
    await store.upsertDevice({ id: 'private-provider', protocol: 'hive', entities: { power: { id: 'power', stateKey: 'power', state: false,
      capability: { controlId: 'power', semanticRole: 'power', kind: 'binary', readable: true, observable: true } } } },
      { devicePolicy: { managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant', lifecycle: 'INSTALLED' } });
    const device = store.getDevice('private-provider');
    const result = require('../src/observation/stateEvidence').resolveStateEvidence({ device,
      entity: Object.values(device.entities)[0], control: { controlId: 'power', semanticRole: 'power', valueType: 'boolean', maxStateValiditySeconds: 420 },
      sourceGeneration: 3, authorityValid: true, clockTrusted: true });
    assert.equal(result.lastReported.value, false);
    assert.equal(result.lastReported.observedAt, null);
    assert.equal(result.evidence.status, 'timestamp_unavailable');
    assert.equal(result.value, null);
    assert.equal(store.getSyncOutbox().events.some(event => ['device.upsert', 'usage.bucket', 'temperature.sample'].includes(event.type)), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an actual hourly reporting read-back and cadence are not replaced with a desired 5-minute fiction', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-hourly-bridge-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    const fixture = await checkedStateFixture({ store, directory, reportingIntervalSeconds: 3600 });
    const entity = Object.values(store.getDevice(fixture.deviceId).entities).find(item => item.stateKey === 'state');
    assert.equal(entity.admittedEvidence.quality, 'fresh');
    assert.equal(Date.parse(entity.admittedEvidence.validUntil) - Date.parse(entity.sourceObservedAt), 3660000);
    assert.equal(fixture.requests.some(item => item.topic.includes('/configure')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy approved evidence schedules read-back without inheriting verification or refunding attempts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-proof-upgrade-'));
  try {
    const store = new Store(path.join(directory, 'store.json')); store.setSyncSourceGeneration(3);
    const device = normalizeZigbeeDevice(fixture); await store.upsertDevice(device);
    const operations = []; const create = () => new ObservationReconciler({ store, resolveDeviceId: () => device.id,
      publishBridgeRequest: async kind => operations.push(kind), clock: Date.now });
    let runtime = create(); await runtime.onInventory([fixture]);
    const [record] = Object.values(store.getObservationPolicyRecords());
    await store.putObservationPolicyRecord(record.key, { ...record, state: 'cadence_verified', attempts: 2,
      readBack: { status: 0, at: new Date().toISOString(), maximumReportInterval: 600 } });
    runtime = create(); await runtime.onInventory([fixture]);
    assert.equal(runtime.status()[0].state, 'configuration_unknown');
    assert.equal(runtime.status()[0].attempts, 2);
    await runtime.tick();
    assert.deepEqual(operations, ['device/reporting/read']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
