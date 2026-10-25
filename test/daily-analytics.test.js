const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../src/sync/analyticsCalendar');
const daily = require('../src/sync/dailyAnalytics');
const { initialUsageState, observeUsage, advanceUsage } = require('../src/sync/usageBuckets');
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
