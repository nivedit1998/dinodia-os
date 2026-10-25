const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../src/sync/analyticsCalendar');
const daily = require('../src/sync/dailyAnalytics');
const { initialUsageState, observeUsage, advanceUsage } = require('../src/sync/usageBuckets');
const { Store } = require('../src/store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const from = '2026-10-19T00:00:00.000Z';
function state(timezone = 'Europe/London') {
  const value = initialUsageState(); daily.initialize(value, { version: 1, enabled: true, timezone, writerFrom: from }); return value;
}
const source = { osDeviceId: 'device-a', osAreaId: 'area-a', category: 'RADIATOR', controlId: 'heat',
  sourceGeneration: 1, bindingRevision: 1, analyticsIntervalId: 'test-interval', analyticsPolicyVersion: 3 };
test('calendar weeks follow local Monday; DST hours are real distinct elapsed hours', () => {
  const week = calendar.calendarWeek(Date.parse('2026-10-25T12:00:00Z'), 'Europe/London');
  assert.equal(new Date(week.start).toISOString(), '2026-10-18T23:00:00.000Z');
  assert.equal(new Date(week.end).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal((week.end - week.start) / 3600000, 169);
  const day = calendar.calendarDay(Date.parse('2026-10-25T12:00:00Z'), 'Europe/London');
  assert.equal((day.end - day.start) / 3600000, 25);
  assert.equal(calendar.calendarWeek(Date.parse('2026-10-26T00:00:00Z'), 'Europe/London').start, week.end);
});
test('daily usage partitions real intervals at half-hour local midnight', () => {
  const s = state('Asia/Kolkata');
  daily.recordUsageInterval(s, source, Date.parse('2026-10-24T18:20:00Z'), Date.parse('2026-10-24T18:40:00Z'), 'on');
  assert.deepEqual(Object.values(s.dailyAnalytics.days).map(r => r.onSeconds), [600, 600]);
});
test('actual hourly accounting also advances absolute daily counters and survives restart', () => {
  let s = state();
  s = observeUsage(s, { ...source, activity: 'on', observedAt: '2026-10-25T12:00:00.000Z',
    validUntil: '2026-10-25T12:10:00.000Z', nowMs: Date.parse('2026-10-25T12:00:00Z') }).state;
  s = advanceUsage(s, Date.parse('2026-10-25T12:15:00Z')).state;
  const row = Object.values(s.dailyAnalytics.days)[0];
  assert.equal(row.onSeconds, 600); assert.equal(row.unknownSeconds, 300);
  const restored = initialUsageState(JSON.parse(JSON.stringify(s)));
  assert.equal(daily.dailyEvents(restored)[0].payload.onSeconds, 600);
  assert.equal(Object.hasOwn(daily.dailyEvents(restored)[0].payload, '_histogram'), false);
});
test('temperature successors replace a provisionally integrated tail without double-counting', () => {
  const s = state(); const t0 = Date.parse('2026-10-25T12:00:00Z');
  daily.observeTemperature(s, { ...source, observedAt: new Date(t0).toISOString(), validUntil: new Date(t0 + 3600000).toISOString(), value: 20 }, t0 + 600000);
  daily.observeTemperature(s, { ...source, observedAt: new Date(t0 + 300000).toISOString(), validUntil: new Date(t0 + 3600000).toISOString(), value: 24 }, t0 + 600000);
  const row = Object.values(s.dailyAnalytics.days)[0];
  assert.equal(row.knownMilliseconds, 600000);
  assert.equal(row.celsiusMilliseconds / row.knownMilliseconds, 22);
  assert.equal(row.minimumCelsius, 20); assert.equal(row.maximumCelsius, 24);
});
test('offline restart caps the original temperature observation and cannot renew it', () => {
  const s = state(); const t0 = Date.parse('2026-10-25T12:00:00Z');
  const sample = { ...source, observedAt: new Date(t0).toISOString(), validUntil: new Date(t0 + 3600000).toISOString(), value: 20 };
  daily.observeTemperature(s, sample, t0 + 60000); daily.capDailyAtLastAlive(s, t0 + 60000);
  daily.advanceDaily(s, t0 + 1800000); daily.observeTemperature(s, sample, t0 + 1800000);
  assert.equal(Object.values(s.dailyAnalytics.days)[0].knownMilliseconds, 60000);
});
test('disabling the writer retains daily history but stops activity accumulation', () => {
  const s = state(); daily.initialize(s, null);
  daily.recordUsageInterval(s, source, Date.parse('2026-10-25T12:00:00Z'), Date.parse('2026-10-25T13:00:00Z'), 'on');
  assert.equal(Object.keys(s.dailyAnalytics.days).length, 0);
});
test('disabling a writer also stops temperature advancement and publication', () => {
  const s = state(), start = Date.parse('2026-10-25T12:00:00Z');
  daily.observeTemperature(s, { ...source, observedAt: new Date(start).toISOString(),
    validUntil: new Date(start + 3600000).toISOString(), value: 20 }, start + 60000);
  daily.initialize(s, null); daily.advanceDaily(s, start + 1800000);
  assert.equal(Object.values(s.dailyAnalytics.days)[0].knownMilliseconds, 60000);
  assert.deepEqual(daily.dailyEvents(s), []);
});
test('a room switch rejects a cached old-room temperature and preserves separate return epochs', () => {
  const s = state(), start = Date.parse('2026-10-25T12:00:00Z');
  const sample = { ...source, observedAt: new Date(start).toISOString(), validUntil: new Date(start + 3600000).toISOString(), value: 20 };
  daily.observeTemperature(s, sample, start + 60000);
  daily.endDevice(s, source.osDeviceId, start + 60000);
  daily.observeTemperature(s, { ...sample, osAreaId: 'area-b', assignmentEpochAt: new Date(start + 60000).toISOString() }, start + 120000);
  assert.equal(Object.values(s.dailyAnalytics.days).length, 1);
  daily.observeTemperature(s, { ...sample, observedAt: new Date(start + 120000).toISOString(),
    assignmentEpochAt: new Date(start + 120000).toISOString() }, start + 180000);
  assert.equal(Object.values(s.dailyAnalytics.days).length, 2);
  assert.deepEqual(Object.values(s.dailyAnalytics.days).map(row => row.knownMilliseconds), [60000, 60000]);
});

test('actual Store flushes the legacy prefix before its barrier and persists absolute daily snapshots', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-daily-runtime-'));
  try {
    const file = path.join(directory, 'store.json'), store = new Store(file);
    const start = Date.parse('2026-10-25T10:00:00Z'), cutover = start + 3600000;
    store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
    store.state.platform.cloudConfiguration = { analyticsHistory: { version: 1, enabled: true,
      timezone: 'Europe/London', writerFrom: new Date(cutover).toISOString() } };
    store.state.syncUsage = observeUsage(initialUsageState(), { ...source, activity: 'on',
      observedAt: new Date(start).toISOString(), validUntil: new Date(start + 600000).toISOString(), nowMs: start + 900000 }).state;
    await store.advanceSyncUsage(start + 900000);
    await store.advanceSyncUsage(cutover + 900000);
    const events = store.getSyncOutbox().events;
    const marker = events.find(e => e.type === 'analytics.daily.barrier');
    assert.ok(marker);
    const prefix = events.filter(e => e.type === 'usage.bucket' && Date.parse(e.payload.bucketStart) < cutover);
    assert.ok(prefix.length);
    assert.ok(prefix.every(e => e.sequence < marker.sequence));
    const snapshot = events.find(e => e.type === 'analytics.day');
    assert.ok(snapshot.sequence > marker.sequence);
    assert.equal(snapshot.payload.unknownSeconds, 900);
    const batch = await store.prepareSyncBatch('hub-fixture', { kind: 'dinodia_os', version: 'test', capabilities: {} }, cutover + 900000);
    assert.ok(batch);
    const again = await store.prepareSyncBatch('hub-fixture', { kind: 'dinodia_os', version: 'test', capabilities: {} }, cutover + 1000000);
    assert.deepEqual(again, batch, 'an uncertain request is retried byte-for-byte, not regenerated');
    const restarted = new Store(file);
    assert.equal(Object.values(restarted.state.syncUsage.dailyAnalytics.days)[0].unknownSeconds, 900);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('temperature carried across local midnight counts its genuine source, never synthetic future time', () => {
  const s = state(), observed = Date.parse('2026-10-24T22:55:00Z');
  daily.observeTemperature(s, { ...source, observedAt: new Date(observed).toISOString(),
    validUntil: new Date(observed + 1200000).toISOString(), value: 20 }, observed + 1200000);
  const rows = Object.values(s.dailyAnalytics.days);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.sampleCount), [1, 1]);
  assert.equal(rows.reduce((sum, row) => sum + row.knownMilliseconds, 0), 1200000);
});

test('late cutover delivery does not seal legacy history; an unstarted empty writer can be rescheduled safely', () => {
  const usage = initialUsageState(), cutover = Date.parse(from);
  assert.equal(daily.initialize(usage, { version: 1, enabled: true, timezone: 'UTC', writerFrom: from }, cutover + 1), null);
  assert.equal(usage.dailyAnalytics.barrierQueued, false);
  assert.equal(usage.dailyAnalytics.notReadyReason, 'writer_handover_was_received_late');
  const future = new Date(cutover + 3600000).toISOString();
  assert.ok(daily.initialize(usage, { version: 1, enabled: true, timezone: 'UTC', writerFrom: future }, cutover + 1000));
  assert.equal(usage.dailyAnalytics.config.writerFrom, future);
});

test('a newer unverified report ends prior temperature evidence, including a fully cleared next-day fragment', () => {
  const s = state(), observed = Date.parse('2026-10-24T22:55:00Z'), midnight = Date.parse('2026-10-24T23:00:00Z');
  daily.observeTemperature(s, { ...source, observedAt: new Date(observed).toISOString(),
    validUntil: new Date(observed + 1200000).toISOString(), value: 20 }, midnight + 600000);
  daily.observeTemperature(s, { ...source, observedAt: new Date(midnight).toISOString(),
    validUntil: new Date(midnight).toISOString(), value: 24 }, midnight + 600000);
  const next = Object.values(s.dailyAnalytics.days).find(r => r.dayStartAt === new Date(midnight).toISOString());
  assert.equal(next.knownMilliseconds, 0); assert.equal(next.celsiusMilliseconds, 0);
  assert.equal(next.lastCelsius, null);
  assert.ok(daily.dailyEvents(s).some(e => e.payload.knownMilliseconds === 0), 'a clearing correction must replace a previously uploaded positive snapshot');
  daily.advanceDaily(s, midnight + 1800000);
  assert.equal(next.knownMilliseconds, 0, 'Unknown does not renew the former genuine report');
});

test('local compaction never removes current-week detail even with a future signed cutoff', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(daily.detailPruneBoundary({ config: { timezone: 'Europe/London', detailPruneBefore: '2026-11-01T00:00:00.000Z' } }, now),
    Date.parse('2026-10-18T23:00:00Z'));
  assert.equal(daily.detailPruneBoundary(null, now), -Infinity);
});

test('actual Store sweeps resolve logical children without cutting their genuine temperature validity', async t => {
  const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-daily-logical-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(path.join(directory, 'store.json'));
  store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
  await store.saveArea({ name: 'Synthetic room' }, 'area-a');
  const parent = normalizeZigbeeDevice(require('./fixtures/zigbee/two-gang-light.json'));
  await store.upsertDevice(parent);
  const manifest = store.logicalDeviceManifest(parent.id);
  const [child] = await store.assignLogicalDevices(parent.id, { expectedManifestDigest: manifest.digest,
    assignments: [{ channelKey: manifest.channels[0].channelKey, areaId: 'area-a', labelId: 'light', name: 'Synthetic channel' }] });
  const start = Date.parse('2026-10-25T12:00:00Z');
  store.state.platform.cloudConfiguration = { analyticsHistory: { version: 1, enabled: true, timezone: 'UTC', writerFrom: from } };
  store.state.platform.devicePolicies[child.id] = { managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR', lifecycle: 'INSTALLED' };
  daily.initialize(store.state.syncUsage, store.state.platform.cloudConfiguration.analyticsHistory, Date.parse(from));
  daily.observeTemperature(store.state.syncUsage, { ...source, osDeviceId: child.id, observedAt: new Date(start).toISOString(),
    validUntil: new Date(start + 600000).toISOString(), value: 20 }, start);
  await store.advanceSyncUsage(start + 120000);
  await store.advanceSyncUsage(start + 600000);
  assert.equal(Object.values(store.state.syncUsage.dailyAnalytics.days)[0].knownMilliseconds, 600000);
});

test('partial delayed temperature retraction also corrects the coverage horizon', () => {
  const s = state(), start = Date.parse('2026-10-25T10:00:00Z');
  daily.observeTemperature(s, { ...source, observedAt: new Date(start).toISOString(),
    validUntil: new Date(start + 600000).toISOString(), value: 20 }, start + 300000);
  daily.observeTemperature(s, { ...source, observedAt: new Date(start + 120000).toISOString(),
    validUntil: new Date(start + 120000).toISOString(), value: 24 }, start + 300000);
  const row = Object.values(s.dailyAnalytics.days)[0];
  assert.equal(row.knownMilliseconds, 120000);
  assert.equal(row.coverageEndAt, new Date(start + 120000).toISOString());
});
