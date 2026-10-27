'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCategoryBinding } = require('../src/analytics/resolveBinding');
const { analyticsEligible } = require('../src/analytics/categoryPolicies');
const { projectActivity } = require('../src/analytics/projectActivity');
const { BoundedReadCoordinator, readTargets } = require('../src/observation/readCoordinator');
const { analyticsReadiness } = require('../src/analytics/readiness');

const property = { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED' };
const power = { controlId: 'power:1', endpointId: '1', semanticRole: 'power', observable: true, writable: false };

for (const category of ['SOCKET', 'TV']) {
  test(`${category}: an explicitly categorized property device can bind its measured power capability`, () => {
    const result = resolveCategoryBinding({ signedPolicy: { ...property, analyticsCategory: category }, controls: [power] });
    assert.equal(result.status, 'resolved');
    assert.equal(result.primaryControlId, power.controlId);
  });
}

for (const category of ['BLIND', 'AC', 'WASHING_MACHINE']) {
  test(`${category}: a categorized property device without a measured activity signal is unsupported, not ineligible`, () => {
    const result = resolveCategoryBinding({ signedPolicy: { ...property, analyticsCategory: category }, controls: [] });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'required_signal_missing');
  });
}

test('BLIND can bind an actual observed position without relying on a device model', () => {
  const position = { controlId: 'position:1', endpointId: '1', semanticRole: 'opening_percentage',
    observable: true, writable: false, observationMeaning: 'actual_position', constraints: { minimum: 0, maximum: 100 } };
  const result = resolveCategoryBinding({ signedPolicy: { ...property, analyticsCategory: 'BLIND' }, controls: [position] });
  assert.equal(result.status, 'resolved');
  assert.equal(result.primaryControlId, position.controlId);
});

test('blind position without explicit actual-source semantics is not bound', () => {
  const target = { controlId: 'target:1', endpointId: '1', semanticRole: 'opening_percentage', observable: true, writable: false };
  assert.equal(resolveCategoryBinding({ signedPolicy: { ...property, analyticsCategory: 'BLIND' }, controls: [target] }).status, 'unsupported');
});

test('AC mode alone is not a measured cooling or heating signal', () => {
  const mode = { controlId: 'mode:1', endpointId: '1', semanticRole: 'operating_mode', observable: true, writable: true };
  const result = resolveCategoryBinding({ signedPolicy: { ...property, analyticsCategory: 'AC' }, controls: [mode] });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'required_signal_missing');
});

test('new categories never admit private or uncategorized devices to property analytics', () => {
  for (const policy of [
    { ...property, analyticsCategory: 'NONE' },
    { ...property, analyticsCategory: 'SOCKET', managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant:1' },
    { ...property, analyticsCategory: 'TV', ownerMembershipId: 'tenant:1' },
  ]) assert.equal(resolveCategoryBinding({ signedPolicy: policy, controls: [power] }).status, 'ineligible');
});

test('new binding recognition does not enable the legacy collection or binary accounting paths', () => {
  for (const analyticsCategory of ['SOCKET', 'TV', 'BLIND', 'AC', 'WASHING_MACHINE']) {
    const signedPolicy = { ...property, analyticsCategory };
    assert.equal(analyticsEligible(signedPolicy), false);
    const binding = resolveCategoryBinding({ signedPolicy, controls: [power] });
    assert.equal(projectActivity({ binding, sample: { controlId: power.controlId, value: true,
      observedAt: '2026-10-27T12:00:00.000Z', validUntil: '2026-10-27T12:10:00.000Z', quality: 'fresh' },
    nowMs: Date.parse('2026-10-27T12:01:00.000Z'), authorityValid: true, clockTrusted: true, deviceAvailable: true }), 'unknown');
  }
});

test('new categories cannot schedule or dispatch legacy radio reads', async () => {
  const policy = { ...property, analyticsCategory: 'SOCKET', analyticsInterval: { genericCollectionEnabled: true, revision: 1 } };
  const entity = { id: power.controlId, endpointId: '1', stateKey: 'state', capability: power };
  const device = { id: 'device', protocol: 'zigbee', available: true, entities: { power: entity } };
  const store = { getPlatform: () => ({ devicePolicies: { device: policy } }), listDevices: () => [device],
    getObservationPolicyRecords: () => ({}), putObservationPolicyRecord: async () => {} };
  let reads = 0;
  const coordinator = new BoundedReadCoordinator({ store, clock: () => 1_000_000,
    adapters: { zigbee: { supports: () => true, read: async () => { reads++; } } }, admit: async () => {} });
  assert.deepEqual(readTargets(store), []);
  await coordinator.tick([{ key: 'device|power:1|1', deviceId: 'device', integration: 'zigbee', enabled: true, available: true, intervalSeconds: 300 }]);
  assert.equal(reads, 0);
});

test('a resolved new category reports limited until a compatible writer exists', () => {
  const policy = { ...property, analyticsCategory: 'SOCKET' };
  const device = { id: 'device', protocol: 'zigbee', available: true, entities: { power: { id: power.controlId, endpointId: '1', capability: power } } };
  const readiness = analyticsReadiness({ getObservationPolicyRecords: () => ({}) }, device, policy);
  assert.equal(readiness.state, 'limited');
  assert.equal(readiness.reason, 'compatible_analytics_writer_unavailable');
});
