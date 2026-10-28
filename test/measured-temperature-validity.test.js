const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { buildPresentation } = require('../src/capabilities/devicePresentation');
const measured = require('../src/observation/measuredTemperature');

const control = { maxStateValiditySeconds: 1800, expectedReportingIntervalSeconds: 120 };
const T0 = Date.parse('2026-10-28T10:00:00Z');

test('cold start uses the descriptor hint, then two times the median gap, within floor and ceiling', () => {
  let history = measured.recordObservation(undefined, T0, 1800);
  assert.equal(measured.measuredValiditySeconds(control, history), 360);
  for (const gap of [100, 110, 120, 130]) history = measured.recordObservation(history, history.lastObservedMs + gap * 1000, 1800);
  assert.equal(measured.measuredValiditySeconds(control, history), 360, 'floor is three times the declared interval');
  let slow = measured.recordObservation(undefined, T0, 1800);
  for (let i = 0; i < 4; i++) slow = measured.recordObservation(slow, slow.lastObservedMs + 600000, 1800);
  assert.equal(measured.measuredValiditySeconds(control, slow), 1260, '2 x 600 s + 60 s grace');
  let sparse = measured.recordObservation(undefined, T0, 1800);
  for (let i = 0; i < 4; i++) sparse = measured.recordObservation(sparse, sparse.lastObservedMs + 1500000, 1800);
  assert.equal(measured.measuredValiditySeconds(control, sparse), 1800, 'never above the descriptor ceiling');
});

test('duplicates, replays, outages and bad descriptors are not turned into coverage', () => {
  let history = measured.recordObservation(undefined, T0, 1800);
  assert.deepEqual(measured.recordObservation(history, T0, 1800), history);
  assert.deepEqual(measured.recordObservation(history, T0 - 1000, 1800), history);
  const afterOutage = measured.recordObservation(history, T0 + 3 * 3600000, 1800);
  assert.deepEqual(afterOutage.gaps, [], 'a multi-hour silence is an outage, not the sensor cadence');
  assert.equal(measured.measuredValiditySeconds({ maxStateValiditySeconds: 0 }, history), null);
  assert.equal(measured.measuredValiditySeconds({}, history), null);
  assert.equal(measured.measuredValiditySeconds({ maxStateValiditySeconds: 900 }, history), 300, 'no hint falls back to five minutes');
  assert.deepEqual(measured.sanitizeHistory({ lastObservedMs: 'x', gaps: [1, -2, 'a', 3] }), { lastObservedMs: null, gaps: [1, 3] });
});

async function radiator(t, { intervalVersion = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measured-temperature-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');
  const store = new Store(file); store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
  const device = normalizeZigbeeDevice(structuredClone(require('./fixtures/zigbee/sonoff-trvzb-observation.json')));
  device.areaId = 'room-2'; device.setup = { status: 'ready', assignmentMode: 'device_inherited_v1' };
  device.state = { local_temperature: 19.5, running_state: 'idle', system_mode: 'heat', occupied_heating_setpoint: 20 };
  device.presentation = buildPresentation(device);
  await store.saveArea({ name: 'Room 2', icon: 'room' }, 'room-2');
  await store.savePlatform({ homeId: 'home' });
  const policy = { osDeviceId: device.id, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, analyticsCategory: 'RADIATOR',
    lifecycle: 'INSTALLED', descriptorDigest: 'b'.repeat(64), osAreaIds: ['room-2'], analyticsAssignmentStartedAt: new Date(T0 - 3600000).toISOString(),
    analyticsInterval: { id: 'interval-1', revision: 1, writerEnabled: true, analyticsPolicyVersion: intervalVersion, sourceGeneration: 1,
      validFrom: new Date(T0 - 3600000).toISOString() } };
  await store.upsertDevice(device, { nowMs: T0 - 1800000, devicePolicy: policy });
  const report = async (offsetMs, value) => {
    const at = new Date(T0 + offsetMs).toISOString();
    await store.updateDeviceState(device.id, { local_temperature: value }, { nowMs: T0 + offsetMs, reportedStateKeys: ['local_temperature'],
      requireExplicitObservation: true, sourceObservedAtByStateKey: { local_temperature: at }, sourceReceivedAtByStateKey: { local_temperature: at } });
    return at;
  };
  const samples = () => store.getSyncOutbox().events.filter(event => event.type === 'temperature.sample').map(event => event.payload);
  return { store, device, report, samples, file };
}

test('a policy-3 radiator without a reporting proof still gets bounded temperature coverage', async t => {
  const h = await radiator(t);
  for (let i = 0; i < 6; i++) await h.report(i * 120000, 19 + i / 10);
  const samples = h.samples();
  assert.equal(samples.length, 6);
  for (const sample of samples) {
    const seconds = (Date.parse(sample.validUntil) - Date.parse(sample.sourceObservedAt)) / 1000;
    assert.equal(sample.quality, 'fresh');
    assert.equal(sample.analyticsPolicyVersion, 3);
    assert.ok(seconds >= 360 && seconds <= 420, `validity ${seconds}s stays within floor and ceiling`);
  }
});

test('measured cadence survives a Store restart and a policy-2 radiator is unchanged', async t => {
  const h = await radiator(t);
  for (let i = 0; i < 4; i++) await h.report(i * 300000, 20);
  const reopened = new Store(h.file);
  const cadence = Object.values(reopened.snapshot().syncUsage.temperatureCadence || {});
  assert.equal(cadence.length, 1);
  assert.deepEqual(cadence[0].gaps, [300, 300, 300]);
  const two = await radiator(t, { intervalVersion: 2 });
  await two.report(0, 20);
  const ceiling = 420; // the fixture descriptor's own maximum validity
  assert.equal((Date.parse(two.samples()[0].validUntil) - Date.parse(two.samples()[0].sourceObservedAt)) / 1000, ceiling);
  assert.equal(two.samples()[0].analyticsPolicyVersion, undefined);
});

test('offline or untrusted-clock readings are never given measured coverage', async t => {
  const h = await radiator(t);
  h.store.setUsageClockTrust(() => false);
  await h.report(0, 20);
  assert.ok(h.samples().every(sample => sample.validUntil === sample.sourceObservedAt && sample.quality === 'unknown'),
    'an untrusted clock cannot be turned into coverage');
});

test('daily temperature coverage stops at the measured window instead of the quiet hour', () => {
  const daily = require('../src/sync/dailyAnalytics');
  const { initialUsageState } = require('../src/sync/usageBuckets');
  const usage = initialUsageState();
  daily.initialize(usage, { version: 1, enabled: true, timezone: 'Europe/London', writerFrom: new Date(T0 - 7200000).toISOString() }, T0 - 7200000);
  const base = { osDeviceId: 'd', osAreaId: 'a', category: 'RADIATOR', controlId: 'temp', sourceGeneration: 1, bindingRevision: 1,
    analyticsIntervalId: 'i', analyticsPolicyVersion: 3, assignmentEpochAt: new Date(T0 - 7200000).toISOString() };
  let history = measured.recordObservation(undefined, T0, 1800);
  const validity = measured.measuredValiditySeconds(control, history);
  daily.observeTemperature(usage, { ...base, observedAt: new Date(T0).toISOString(), validUntil: new Date(T0 + validity * 1000).toISOString(), value: 20 }, T0);
  daily.advanceDaily(usage, T0 + 3600000);
  const rows = Object.values(usage.dailyAnalytics.days).filter(row => row.kind === 'TEMPERATURE');
  assert.equal(rows.reduce((sum, row) => sum + Number(row.knownMilliseconds), 0) / 1000, validity, 'known time is the window, not the silent hour');
});
