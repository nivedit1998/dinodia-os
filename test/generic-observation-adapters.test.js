const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { ObservationReconciler } = require('../src/observation/reconciler');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const fixture = require('./fixtures/zigbee/sonoff-trvzb-observation.json');
test('installer readiness makes ambiguity and unsupported integration provenance explicit', () => {
  const { analyticsReadiness } = require('../src/analytics/readiness');
  const entity = (id, endpointId) => ({ id, endpointId, capability: { controlId: id, semanticRole: 'power', observable: true } });
  const policy = { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED', analyticsCategory: 'LIGHT' };
  const device = { id: 'd', protocol: 'zigbee', available: true, entities: { a: entity('a', '1'), b: entity('b', '2') } };
  assert.equal(analyticsReadiness({}, device, policy).state, 'ambiguous');
  const selected = { ...policy, analyticsInterval: { selectedControlId: 'a', authorizedControlIds: ['a', 'b'] } };
  assert.equal(analyticsReadiness({}, device, selected).reason, 'periodic_collection_not_verified');
  assert.equal(analyticsReadiness({}, { ...device, protocol: 'matter' }, selected).reason, 'matter_report_provenance_unavailable');
  assert.equal(analyticsReadiness({}, { ...device, protocol: 'hive' }, selected).reason, 'provider_observation_unverified');
  assert.equal(analyticsReadiness({}, device, { ...selected, analyticsCategory: 'NONE' }).state, 'ineligible');
  assert.equal(analyticsReadiness({}, { ...device, available: false }, selected).state, 'paused');
});
test('reporting reply for a different attribute cannot verify the requested capability', async () => {
  let saved; const record = { key: 'x', deviceId: 'd', profileId: 'generic.c', endpoint: '1', attribute: 'runningState', cluster: 'hvacThermostat',
    desired: { minimumReportInterval: 0, maximumReportInterval: 600, reportableChange: 0 }, lastTransaction: 'dinodia-obs-x', lastRequestKind: 'read', state: 'read_back_pending' };
  const runtime = new ObservationReconciler({ store: { getObservationPolicyRecords: () => ({ x: record }), putObservationPolicyRecord: async (_key, value) => { saved = value; } },
    resolveDeviceId: () => 'd', publishBridgeRequest: async () => {}, clock: () => Date.parse('2026-10-23T10:00:00Z') });
  await runtime.onBridgeResponse('read', { status: 'ok', transaction: 'dinodia-obs-x', data: { endpoint: 1, cluster: 'hvacThermostat', configs: [{ attrId: 0, status: 0, minRepIntval: 0, maxRepIntval: 600, repChange: 0 }] } });
  assert.notEqual(saved.state, 'cadence_pending');
});
test('unknown manufacturer reaches real reporting read-back and cadence without a model entry or configure permission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-generic-'));
  try {
    const raw = structuredClone(fixture); raw.definition.vendor = 'Previously unseen'; raw.definition.model = 'other'; raw.model_id = 'other';
    raw.endpoints = { 1: { clusters: { input: ['hvacThermostat'] }, configured_reportings: [] } };
    const store = new Store(path.join(dir, 'store.json'));
    const normalized = normalizeZigbeeDevice(raw);
    await store.upsertDevice(normalized, { devicePolicy: { managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED', analyticsCategory: 'RADIATOR',
      analyticsInterval: { id: 'interval', revision: 1, writerEnabled: false, genericCollectionEnabled: true } } });
    let now = Date.parse('2026-10-23T10:00:00Z'); const sent = [];
    const make = target => new ObservationReconciler({ store: target, resolveDeviceId: () => normalized.id, clock: () => now,
      publishBridgeRequest: async (kind, payload) => sent.push({ kind, payload }) });
    let runtime = make(store); await runtime.onInventory([raw]); await runtime.tick();
    assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'device/reporting/read');
    await runtime.onBridgeResponse('read', { status: 'ok', transaction: sent[0].payload.transaction,
      data: { endpoint: 1, cluster: 'hvacThermostat', configs: [{ attrId: 41, status: 0, minRepIntval: 0, maxRepIntval: 600, repChange: 0 }] } });
    for (let i = 0; i < 4; i++) { now += 600000; await runtime.onValueObserved(normalized.id, 'running_state', '1', new Date(now).toISOString()); }
    assert.equal(runtime.status()[0].state, 'cadence_verified');
    assert.equal(runtime.lifetimeFor(normalized.id, 'running_state', '1'), 660);
    assert.equal(sent.some(item => item.kind.endsWith('configure')), false);
    runtime = make(new Store(path.join(dir, 'store.json'))); now += 1;
    assert.equal(runtime.lastCommandAt, Date.parse('2026-10-23T10:00:00Z'), 'Hub-wide management spacing persists');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
