'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { matchObservationProfile } = require('../src/observation/profiles');
// Discovery is deliberately separate from the legacy profile's lifetime/write permission.
let discoverCollectionStrategy;
try { ({ discoverCollectionStrategy } = require('../src/observation/strategyResolver')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const template = require('./fixtures/zigbee/sonoff-trvzb-observation.json');
function device(vendor, model) {
  const raw = structuredClone(template);
  raw.definition.vendor = vendor; raw.definition.model = model; raw.model_id = model;
  raw.endpoints = { 1: { clusters: { input: ['hvacThermostat'] }, configured_reportings: [
    { cluster: 'hvacThermostat', attribute: 'runningState', minimum_report_interval: 0,
      maximum_report_interval: 600, reportable_change: 0 }
  ] } };
  raw.power_source = 'Battery'; raw.type = 'EndDevice';
  const normalized = normalizeZigbeeDevice(raw);
  // The bridge adds exact endpoint discovery separately from the expose normalizer.
  normalized.metadata.endpoints = structuredClone(raw.endpoints);
  return normalized;
}
test('next policy: discovery of an existing exact reporting capability is not manufacturer-gated', () => {
  const known = device('SONOFF', 'TRVZB');
  const generic = device('Synthetic other manufacturer', 'SYNTHETIC-HVAC');
  const control = d => Object.values(d.entities).find(e => e.stateKey === 'running_state');
  assert.equal(control(generic).capability.semanticRole, 'active_heat_demand');
  assert.equal(control(generic).capability.observable, true);
  assert.ok(matchObservationProfile(known, control(known)), 'positive legacy seam control');
  assert.equal(typeof discoverCollectionStrategy, 'function', 'pure discovery seam must exist');
  const discovered = discoverCollectionStrategy(generic, control(generic));
  assert.equal(discovered.strategy, 'verify_existing_reporting');
  assert.equal(discovered.approvedForAutomaticConfiguration, false);
  assert.equal(discovered.lifetimeSeconds, undefined, 'discovery alone grants no lifetime');
  assert.equal(matchObservationProfile(generic, control(generic)), null, 'legacy write approval must not broaden');
});
test('writable thermostat mode is not measured heat demand (existing safety guard)', () => {
  const d = device('SONOFF', 'TRVZB');
  const modes = Object.values(d.entities).filter(e => e.capability?.writable &&
    ['mode', 'system_mode'].includes(e.stateKey));
  assert.ok(modes.length, 'fixture must contain a real writable thermostat mode');
  for (const e of modes) {
    assert.notEqual(e.capability.semanticRole, 'active_heat_demand');
    assert.equal(matchObservationProfile(d, e), null);
  }
});

test('on/off state categories record only once the signed state-analytics writer is on; other state categories stay closed', () => {
  const { analyticsEligible } = require('../src/analytics/categoryPolicies');
  const policy = (analyticsCategory, interval) => ({ managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED', analyticsCategory,
    ...(interval ? { analyticsInterval: interval } : {}) });
  for (const category of ['LIGHT', 'RADIATOR', 'BOILER']) assert.equal(analyticsEligible(policy(category)), true);
  for (const category of ['SOCKET', 'TV']) {
    assert.equal(analyticsEligible(policy(category)), false, 'no signed state policy yet');
    assert.equal(analyticsEligible(policy(category, { analyticsPolicyVersion: 4, writerEnabled: false })), false, 'writer off');
    assert.equal(analyticsEligible(policy(category, { analyticsPolicyVersion: 3, writerEnabled: true })), false, 'wrong policy version');
    assert.equal(analyticsEligible(policy(category, { analyticsPolicyVersion: 4, writerEnabled: true })), true);
  }
  for (const category of ['BLIND', 'AC', 'WASHING_MACHINE', 'NONE']) {
    assert.equal(analyticsEligible(policy(category, { analyticsPolicyVersion: 4, writerEnabled: true })), false, `${category} stays closed`);
  }
  assert.equal(analyticsEligible({ ...policy('SOCKET', { analyticsPolicyVersion: 4, writerEnabled: true }), managementClass: 'TENANT_DEVICE', ownerMembershipId: 'm' }), false, 'a tenant device is never eligible');
});
