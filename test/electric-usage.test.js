const test = require('node:test');
const assert = require('node:assert/strict');
const { ElectricUsageTracker, classify } = require('../src/electricUsage');

function clock(value) { return new Date(value); }

test('electric tracker records only Light-labelled public controls and preserves area epochs', async () => {
  let now = clock('2026-09-05T10:00:00.000Z');
  const labels = { light: { name: 'Light' }, radiator: { name: 'Radiator' } };
  const store = {
    state: { electricUsage: { schemaVersion: 1, entities: {}, pending: [], lastResetAt: null } },
    getLabel(id) { return labels[id] || null; },
    getArea(id) { return id ? { id, name: id === 'kitchen' ? 'Kitchen' : 'Hall' } : null; },
    listDevices() { return []; },
    persist: async () => {},
  };
  const tracker = new ElectricUsageTracker({ store, now: () => now });
  const light = (areaId, state = 'on') => ({
    id: 'light.lamp',
    deviceId: 'lamp',
    entityName: 'Lamp',
    areaId,
    areaName: store.getArea(areaId)?.name || null,
    classification: classify({ state }, { available: true }),
  });
  tracker.observe(light('kitchen'), now);
  now = clock('2026-09-05T10:01:00.000Z');
  tracker.observe(light('kitchen'), now);
  assert.equal(tracker.state().entities['light.lamp'].onSeconds, 60);

  now = clock('2026-09-05T10:02:00.000Z');
  tracker.observe(light('hall', 'off'), now);
  const payload = tracker.payload();
  assert.equal(payload.devices.length, 2);
  assert.equal(payload.devices[0].areaName, 'Kitchen');
  assert.equal(payload.devices[0].retired, true);
  assert.equal(payload.devices[1].areaName, 'Hall');
  assert.equal(payload.devices[1].onSeconds, 0);
  assert.equal(payload.devices[1].offSeconds, 0);
});

test('electric tracker treats long gaps as UNKNOWN and removes retired rows only after acknowledgement', async () => {
  let now = clock('2026-09-05T10:00:00.000Z');
  const store = { state: { electricUsage: { schemaVersion: 1, entities: {}, pending: [], lastResetAt: null } }, persist: async () => {} };
  const tracker = new ElectricUsageTracker({ store, now: () => now, unknownGapAfterSeconds: 600 });
  const descriptor = (state) => ({ entityId: 'switch.lamp', entityName: 'Lamp', areaId: 'room', areaName: 'Room', classification: classify({ state }, {}) });
  tracker.observe(descriptor('on'), now);
  now = clock('2026-09-05T11:00:00.000Z');
  tracker.observe(descriptor('on'), now);
  assert.equal(tracker.state().entities['switch.lamp'].onSeconds, 0);
  assert.equal(tracker.state().entities['switch.lamp'].unknownSeconds, 3600);
  const rows = tracker.payload().devices;
  tracker.state().entities['switch.lamp'].retired = true;
  tracker.acknowledgeUploaded(rows);
  assert.equal(tracker.state().entities['switch.lamp'], undefined);
});

test('electric tracker reset creates one shared acknowledgement epoch', () => {
  const store = { state: { electricUsage: { schemaVersion: 1, entities: {}, pending: [], lastResetAt: null } }, persist: async () => {} };
  const tracker = new ElectricUsageTracker({ store });
  tracker.applyReset('2026-09-05T12:00:00.000Z');
  assert.equal(tracker.resetAcknowledgement(), '2026-09-05T12:00:00.000Z');
  tracker.acknowledgeReset('2026-09-05T12:00:00.000Z');
  assert.equal(tracker.resetAcknowledgement(), null);
});
