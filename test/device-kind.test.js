const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { describeKind } = require('../src/commissioning/deviceKind');
const { PROPERTY_ANALYTICS_CATEGORIES } = require('../src/analytics/categoryPolicies');

const fixture = (name) => normalizeZigbeeDevice(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zigbee', name), 'utf8')));

test('only an unambiguous signal from the device suggests a kind; a plain on/off device suggests nothing but is still on/off', () => {
  assert.deepEqual(describeKind(fixture('dimmable-light.json')), { suggestedKind: 'Light', onOff: true }, 'a dimmable light says it is a light');
  const radiator = describeKind(fixture('radiator-device.json'));
  assert.equal(radiator.suggestedKind, 'Radiator');
  const relay = normalizeZigbeeDevice({ ieee_address: '0x1', friendly_name: '0x1', supported: true, interview_completed: true,
    definition: { vendor: 'Anyone', model: 'Wall relay', exposes: [{ type: 'switch', features: [{ type: 'binary', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }] }] } });
  assert.deepEqual(describeKind(relay), { suggestedKind: null, onOff: true }, 'a relay cannot say what it switches');
  const sensor = normalizeZigbeeDevice({ ieee_address: '0x2', friendly_name: '0x2', supported: true, interview_completed: true,
    definition: { vendor: 'Anyone', model: 'Contact', exposes: [{ type: 'binary', property: 'contact', access: 1, value_on: false, value_off: true }] } });
  assert.deepEqual(describeKind(sensor), { suggestedKind: null, onOff: false });
});

test('the installer may choose the on/off category for any on/off device', () => {
  assert.ok(PROPERTY_ANALYTICS_CATEGORIES.includes('SOCKET'));
  for (const closed of ['TV', 'BLIND', 'AC', 'WASHING_MACHINE']) assert.ok(!PROPERTY_ANALYTICS_CATEGORIES.includes(closed), `${closed} stays closed`);
});
