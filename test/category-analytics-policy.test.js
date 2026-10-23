'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { matchObservationProfile } = require('../src/observation/profiles');
const template = require('./fixtures/zigbee/sonoff-trvzb-observation.json');
function device(vendor, model) {
  const raw = structuredClone(template);
  raw.definition.vendor = vendor; raw.definition.model = model; raw.model_id = model;
  raw.endpoints = { 1: { clusters: { input: ['hvacThermostat'] }, configured_reportings: [
    { cluster: 'hvacThermostat', attribute: 'runningState', minimum_report_interval: 0,
      maximum_report_interval: 600, reportable_change: 0 }
  ] } };
  raw.power_source = 'Battery'; raw.type = 'EndDevice';
  return normalizeZigbeeDevice(raw);
}
test('next policy: discovery of an existing exact reporting capability is not manufacturer-gated', () => {
  const known = device('SONOFF', 'TRVZB');
  const generic = device('Synthetic other manufacturer', 'SYNTHETIC-HVAC');
  const control = d => Object.values(d.entities).find(e => e.stateKey === 'running_state');
  assert.equal(control(generic).capability.semanticRole, 'active_heat_demand');
  assert.equal(control(generic).capability.observable, true);
  assert.ok(matchObservationProfile(known, control(known)), 'positive legacy seam control');
  // This tests the current strategy-discovery seam only. Discovery is NOT permission to configure.
  assert.ok(matchObservationProfile(generic, control(generic)),
    'identical declared endpoint/attribute capability needs a generic discovery strategy, with writes separately authorized');
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
