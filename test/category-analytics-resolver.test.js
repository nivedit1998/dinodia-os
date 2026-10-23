'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCategoryBinding } = require('../src/analytics/resolveBinding');
const { projectActivity } = require('../src/analytics/projectActivity');
const policy = { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED', analyticsCategory: 'LIGHT' };
const power = { controlId: 'power', endpointId: '1', semanticRole: 'power', observable: true };
const resolve = (controls, signedPolicy = policy, selection = null) => resolveCategoryBinding({ controls, signedPolicy, selection });
test('category eligibility never admits private, NONE, retired or owner-bearing devices', () => {
  for (const change of [{ managementClass: 'TENANT_DEVICE' }, { ownerMembershipId: 'tenant' },
    { analyticsCategory: 'NONE' }, { lifecycle: 'REMOVED' }]) assert.equal(resolve([power], { ...policy, ...change }).status, 'ineligible');
});
test('power wins within one group; a missing value cannot rebind to brightness', () => {
  const controls = [power, { ...power, controlId: 'brightness', semanticRole: 'brightness' }];
  assert.equal(resolve(controls).primaryControlId, 'power');
  assert.equal(resolve(controls).hasAuthoritativePower, true);
});
test('unverified remembered brightness alone never qualifies as actual output', () => {
  const brightness = { ...power, semanticRole: 'brightness' };
  assert.equal(resolve([brightness]).status, 'unsupported');
  assert.equal(resolve([{ ...brightness, brightnessMeaning: 'actual_output' }]).status, 'resolved');
});
test('independent groups require an exact selection; unknown selection remains unresolved', () => {
  const controls = [power, { ...power, endpointId: '2', controlId: 'power2' }];
  assert.equal(resolve(controls).status, 'ambiguous');
  assert.equal(resolve(controls, policy, '2').primaryControlId, 'power2');
  assert.equal(resolve(controls, policy, 'missing').status, 'ambiguous');
});
test('aliases deduplicate by verified physical source, not human names', () => {
  const controls = [{ ...power, physicalSourceKey: '1/onOff' }, { ...power, controlId: 'alias', physicalSourceKey: '1/onOff' }];
  assert.equal(resolve(controls).status, 'resolved');
  assert.equal(resolve([power, { ...power, controlId: 'different-source' }]).status, 'ambiguous');
});
test('target/mode do not become heating and demand cannot become production', () => {
  const radiator = { ...policy, analyticsCategory: 'RADIATOR' }, boiler = { ...policy, analyticsCategory: 'BOILER' };
  for (const semanticRole of ['target_temperature', 'mode', 'unknown'])
    assert.equal(resolve([{ ...power, semanticRole }], radiator).status, 'unsupported');
  assert.equal(resolve([{ ...power, semanticRole: 'active_heat_demand' }], boiler).status, 'unsupported');
  assert.equal(resolve([{ ...power, semanticRole: 'active_heat_demand', writable: true }], radiator).status, 'unsupported');
});
test('projection fails closed on clock, authority, endpoint source identity and deadline', () => {
  const binding = resolve([power]);
  const nowMs = Date.parse('2026-10-23T08:00:00Z');
  const sample = { controlId: 'power', observedAt: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + 60_000).toISOString(), quality: 'fresh', value: false };
  const input = { binding, sample, nowMs, authorityValid: true, clockTrusted: true, deviceAvailable: true };
  assert.equal(projectActivity(input), 'off');
  for (const change of [{ authorityValid: false }, { clockTrusted: false }, { deviceAvailable: false },
    { sample: { ...sample, controlId: 'other' } }, { sample: { ...sample, value: 'OFF' } },
    { nowMs: nowMs + 60_000 }]) assert.equal(projectActivity({ ...input, ...change }), 'unknown');
});
