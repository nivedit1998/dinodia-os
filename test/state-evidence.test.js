'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const at = Date.parse('2026-10-24T08:00:00.000Z');
const device = { id: 'device', protocol: 'zigbee', available: true,
  metadata: { ieee_address: 'synthetic-ieee', endpoints: { 1: { clusters: { input: ['hvacThermostat'] } } } } };
const control = { controlId: 'target', valueType: 'number', semanticRole: 'target_temperature',
  constraints: { minimum: 5, maximum: 35, step: 0.5 }, maxStateValiditySeconds: 7200 };
const entity = { id: 'entity', endpointId: '1', stateKey: 'occupied_heating_setpoint', state: 22,
  stateRevision: 4, sourceObservedAt: new Date(at).toISOString(), sourceReceivedAt: new Date(at + 10).toISOString(),
  sourceValidUntil: new Date(at + 3660000).toISOString(), sourceGeneration: 3 };
const proof = { key: 'proof', deviceId: 'device', controlId: 'target', property: 'occupied_heating_setpoint',
  endpoint: '1', cluster: 'hvacThermostat', attribute: 'occupiedHeatingSetpoint', sourceGeneration: 3,
  state: 'cadence_verified', evidenceVersion: 2, runtimeSessionId: 'boot', evidenceVerifiedAt: new Date(at - 500).toISOString(),
  readBack: { status: 0, maximumReportInterval: 3600, at: new Date(at - 1000).toISOString() },
  cadence: { verifiedAt: new Date(at - 500).toISOString() } };
function resolve(changes = {}) {
  const { resolveStateEvidence, exactSource } = require('../src/observation/stateEvidence');
  const sample = changes.entity || entity;
  // Test fixture represents a persisted source identity, not one invented by the resolver.
  const boundEntity = { ...sample, sourceKey: sample.sourceKey || exactSource(changes.device || device, sample, changes.control || control, 3).sourceKey };
  return resolveStateEvidence({ device, control, records: [proof], sourceGeneration: 3,
    authorityValid: true, clockTrusted: true, runtimeSessionId: 'boot', now: at + 1000, ...changes, entity: boundEntity });
}
test('E01/E22 verified exact-value hourly proof is current without a guessed 30-minute cap', () => {
  const result = resolve({ now: at + 2000000 });
  assert.equal(result.quality, 'fresh'); assert.equal(result.value, 22);
  assert.equal(result.validUntil, new Date(at + 3660000).toISOString());
});
test('E02 configuration read-back without observed cadence is not current', () => {
  const result = resolve({ records: [{ ...proof, state: 'cadence_pending', cadence: null }] });
  assert.equal(result.value, null); assert.equal(result.lastReported.value, 22);
});
test('E03 new point report without a guarantee remains available only as last reported', () => {
  const result = resolve({ records: [] });
  assert.equal(result.quality, 'unknown'); assert.equal(result.lastReported.observedAt, entity.sourceObservedAt);
});
test('E04 expiry equality preserves real value and age without current coverage', () => {
  const result = resolve({ now: at + 3660000 });
  assert.equal(result.value, null); assert.equal(result.lastReported.value, 22);
});
test('E05 longer later proof cannot extend the admitted sample deadline', () => {
  const result = resolve({ entity: { ...entity, sourceValidUntil: new Date(at + 60000).toISOString() }, now: at + 60000 });
  assert.equal(result.quality, 'unknown');
});
for (const [name, changes] of [
  ['E07 other-attribute/device check-in', { records: [], device: { ...device, lastSeenAt: new Date(at + 1000).toISOString() } }],
  ['E11 wrong endpoint', { records: [{ ...proof, endpoint: '2' }] }],
  ['E11 wrong attribute', { records: [{ ...proof, attribute: 'runningState' }] }],
  ['E12 previous installation generation', { records: [{ ...proof, sourceGeneration: 2 }] }],
  ['E13 explicit offline', { device: { ...device, available: false } }],
  ['E14 untrusted clock', { clockTrusted: false }],
  ['E14 future observation', { now: at - 1 }],
  ['E15 disabled reporting sentinel', { records: [{ ...proof, readBack: { ...proof.readBack, maximumReportInterval: 65535 } }] }],
  ['E19 failed cadence', { records: [{ ...proof, state: 'cadence_failed' }] }],
  ['E19 suspended proof', { records: [{ ...proof, suspended: true }] }],
]) test(`${name} never promotes a last report to current`, () => {
  const result = resolve(changes); assert.notEqual(result.quality, 'fresh'); assert.equal(result.value, null);
});
test('U06 authority denial discloses neither current nor last reported value', () => {
  const result = resolve({ authorityValid: false }); assert.equal(result.lastReported, null); assert.equal(result.value, null);
});
test('E10 false and zero are genuine retained values, not missing readings', () => {
  assert.equal(resolve({ control: { ...control, valueType: 'boolean', constraints: {} }, entity: { ...entity, state: false }, records: [] }).lastReported.value, false);
  assert.equal(resolve({ control: { ...control, constraints: { minimum: 0, maximum: 100 } }, entity: { ...entity, state: 0 }, records: [] }).lastReported.value, 0);
});
test('E08 missing physical observation time cannot be replaced with snapshot time', () => {
  assert.equal(resolve({ entity: { ...entity, sourceObservedAt: null, updatedAt: new Date(at).toISOString() } }).lastReported, null);
});
test('E12 sample from a different generation is not retained for this source', () => {
  assert.equal(resolve({ entity: { ...entity, sourceGeneration: 2 } }).lastReported, null);
});
test('U08 private devices use the same display resolver without an analytics category', () => {
  const result = resolve({ device: { ...device, managementClass: 'TENANT_DEVICE', ownerMembershipId: 'owner' }, records: [] });
  assert.equal(result.lastReported.value, 22); assert.equal(result.quality, 'unknown');
});
test('U25 a private device cannot inherit an exact matching property proof', () => {
  const result = resolve({ device: { ...device, managementClass: 'tenant_device', ownerMembershipId: 'tenant' } });
  assert.equal(result.lastReported.value, 22);
  assert.equal(result.quality, 'unknown');
  assert.equal(result.evidence.guaranteeId, null);
});
test('E20 provider snapshots without per-value timestamps remain explicitly limited', () => {
  for (const protocol of ['matter', 'hive', 'google_nest']) {
    const result = resolve({ device: { ...device, protocol }, entity: { ...entity, sourceObservedAt: null, sourceReceivedAt: null } });
    assert.equal(result.lastReported.value, 22);
    assert.equal(result.lastReported.observedAt, null);
    assert.equal(result.evidence.status, 'timestamp_unavailable');
    assert.equal(result.quality, 'unknown');
  }
});
test('invalid calendar dates cannot manufacture an observation', () => {
  assert.equal(resolve({ entity: { ...entity, sourceObservedAt: '2026-02-30T08:00:00Z' } }).lastReported, null);
});
test('a changed exact source cannot relabel a retained observation', () => {
  const { exactSource } = require('../src/observation/stateEvidence');
  const oldKey = exactSource(device, entity, control, 3).sourceKey;
  assert.equal(resolve({ entity: { ...entity, endpointId: '2', sourceKey: oldKey } }).lastReported, null);
});
