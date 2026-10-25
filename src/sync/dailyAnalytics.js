const crypto = require('node:crypto');
const { validTimezone, calendarDay, annualDayCutoff } = require('./analyticsCalendar');

function settings(value) {
  return value && value.version === 1 && value.enabled === true && validTimezone(value.timezone)
    && Number.isFinite(Date.parse(value.writerFrom)) && Date.parse(value.writerFrom) % 3600000 === 0
    ? { version: 1, enabled: true, timezone: value.timezone, writerFrom: value.writerFrom } : null;
}
function initialize(usage, configuration) {
  const config = settings(configuration); if (!config) { if (usage.dailyAnalytics) usage.dailyAnalytics.active = false; return null; }
  const existing = usage.dailyAnalytics;
  if (existing && (existing.config.timezone !== config.timezone || existing.config.writerFrom !== config.writerFrom))
    throw new Error('Daily analytics writer identity cannot change without reconciliation');
  const daily = usage.dailyAnalytics ||= { version: 1, config, days: {}, temperatures: {}, queuedRevisions: {}, queuedSequences: {}, assignmentEpochs: {}, barrierQueued: false };
  daily.queuedSequences ||= {}; daily.assignmentEpochs ||= {};
  daily.active = true; return daily;
}
function keyFor(source, kind, start) {
  return [source.osDeviceId, source.osAreaId, kind, source.category || 'RADIATOR', source.controlId,
    source.sourceGeneration, source.bindingRevision || 0, source.assignmentEpochAt || '', start].join('|');
}
function record(daily, source, kind, day) {
  const key = keyFor(source, kind, day.start);
  const row = daily.days[key] ||= { osDeviceId: source.osDeviceId, osAreaId: source.osAreaId, kind,
    analyticsCategory: source.category || 'RADIATOR', controlId: source.controlId, sourceGeneration: source.sourceGeneration,
    bindingRevision: source.bindingRevision || 0, analyticsIntervalId: source.analyticsIntervalId || null,
    analyticsPolicyVersion: source.analyticsPolicyVersion || 2, timezone: daily.config.timezone,
    writerFrom: daily.config.writerFrom, dayStartAt: new Date(day.start).toISOString(), dayEndAt: new Date(day.end).toISOString(),
    assignmentEpochAt: source.assignmentEpochAt || daily.config.writerFrom,
    revision: 0, onSeconds: 0, offSeconds: 0, unknownSeconds: 0,
    knownMilliseconds: 0, celsiusMilliseconds: 0, minimumCelsius: null, maximumCelsius: null,
    sampleCount: 0, lastCelsius: null, lastObservedAt: null, lastValidUntil: null, _histogram: {},
    coverageStartAt: null, coverageEndAt: null };
  return { key, row };
}
function add(daily, source, kind, start, end, value) {
  let cursor = Math.max(start, Date.parse(daily.config.writerFrom), Date.parse(source.assignmentEpochAt || daily.config.writerFrom));
  while (cursor < end) {
    const day = calendarDay(cursor, daily.config.timezone); const stop = Math.min(end, day.end);
    const { row } = record(daily, source, kind, day);
    if (kind === 'USAGE') {
      const seconds = Math.max(0, Math.ceil(stop / 1000) - Math.ceil(cursor / 1000));
      const field = value === 'on' ? 'onSeconds' : value === 'off' ? 'offSeconds' : 'unknownSeconds';
      row[field] += seconds;
    } else {
      const ms = stop - cursor; row.knownMilliseconds += ms;
      row.celsiusMilliseconds = Math.round((row.celsiusMilliseconds + ms * value) * 100) / 100;
      row.minimumCelsius = row.minimumCelsius === null ? value : Math.min(row.minimumCelsius, value);
      row.maximumCelsius = row.maximumCelsius === null ? value : Math.max(row.maximumCelsius, value);
      row.lastCelsius = value; row.lastObservedAt = source.observedAt; row.lastValidUntil = source.validUntil;
      const bin = String(Math.round(value * 100)); row._histogram[bin] = (row._histogram[bin] || 0) + ms;
      source._integrations ||= [];
      const previous = source._integrations.at(-1);
      if (previous && previous.key === keyFor(source, kind, day.start) && previous.end === cursor) previous.end = stop;
      else source._integrations.push({ key: keyFor(source, kind, day.start), start: cursor, end: stop });
    }
    row.coverageStartAt ||= new Date(cursor).toISOString(); row.coverageEndAt = new Date(stop).toISOString();
    row.revision++; cursor = stop;
  }
}
function recordUsageInterval(usage, source, start, end, activity) {
  const daily = usage.dailyAnalytics; if (!daily?.active || end <= Date.parse(daily.config.writerFrom)) return;
  const assignmentEpochAt = source.assignmentEpochAt || daily.config.writerFrom;
  add(daily, { ...source, assignmentEpochAt }, 'USAGE', Math.max(start, Date.parse(assignmentEpochAt)), end, activity);
}
function advanceTemperature(daily, source, through) {
  const start = Math.max(source.accountedThrough, Date.parse(source.observedAt), Date.parse(daily.config.writerFrom));
  const end = Math.min(through, Date.parse(source.validUntil));
  if (end > start) add(daily, source, 'TEMPERATURE', start, end, source.value);
  source.accountedThrough = Math.max(source.accountedThrough, through);
}
function observeTemperature(usage, source, now) {
  const daily = usage.dailyAnalytics; if (!daily?.active) return;
  source = { ...source, assignmentEpochAt: source.assignmentEpochAt || daily.config.writerFrom };
  const key = [source.osDeviceId, source.osAreaId, source.controlId, source.sourceGeneration, source.bindingRevision || 0, source.assignmentEpochAt || ''].join('|');
  const previous = daily.temperatures[key]; const observed = Date.parse(source.observedAt);
  if (!Number.isFinite(observed) || observed > now || !Number.isFinite(source.value)
    || !Number.isFinite(Date.parse(source.validUntil)) || Date.parse(source.validUntil) <= observed) return;
  // An existing genuine observation may seed the initial writer boundary, but
  // moving a device does not turn its old-room reading into new-room evidence.
  if (Date.parse(source.assignmentEpochAt) > Date.parse(daily.config.writerFrom)
    && observed < Date.parse(source.assignmentEpochAt)) return;
  if (previous && Date.parse(previous.observedAt) >= observed) return;
  if (previous) {
    // Only the current observation can have been provisionally integrated beyond
    // a delayed successor's source time. Undo that bounded tail before replacing
    // it. The per-value histogram preserves extrema without retaining raw history.
    for (const segment of previous._integrations || []) {
      const removed = Math.max(0, segment.end - Math.max(segment.start, observed));
      if (!removed) continue;
      const row = daily.days[segment.key]; if (!row) continue;
      row.knownMilliseconds -= removed;
      row.celsiusMilliseconds = Math.round((row.celsiusMilliseconds - removed * previous.value) * 100) / 100;
      const bin = String(Math.round(previous.value * 100)); row._histogram[bin] -= removed;
      if (row._histogram[bin] <= 0) delete row._histogram[bin];
      const values = Object.keys(row._histogram).map(x => Number(x) / 100);
      row.minimumCelsius = values.length ? Math.min(...values) : null;
      row.maximumCelsius = values.length ? Math.max(...values) : null;
      row.coverageEndAt = new Date(Math.min(Date.parse(row.coverageEndAt), observed)).toISOString();
      row.revision++; segment.end -= removed;
    }
    previous.accountedThrough = Math.min(previous.accountedThrough, observed);
    advanceTemperature(daily, previous, Math.min(now, observed));
  }
  const next = { ...source, accountedThrough: Math.max(observed, Date.parse(daily.config.writerFrom)) };
  daily.temperatures[key] = next; advanceTemperature(daily, next, now);
  const day = calendarDay(Math.max(observed, Date.parse(daily.config.writerFrom)), daily.config.timezone);
  if (day.start <= now && day.end > Date.parse(daily.config.writerFrom)) {
    const { row } = record(daily, next, 'TEMPERATURE', day); row.sampleCount++; row.revision++;
  }
}
function advanceDaily(usage, now) {
  const daily = usage.dailyAnalytics; if (!daily?.active) return;
  for (const source of Object.values(daily.temperatures)) advanceTemperature(daily, source, now);
  const cutoff = annualDayCutoff(now, daily.config.timezone);
  for (const [key, day] of Object.entries(daily.days)) if (Date.parse(day.dayEndAt) <= cutoff) {
    delete daily.days[key]; delete daily.queuedRevisions[key]; delete daily.queuedSequences[key];
  }
}
function capDailyAtLastAlive(usage, alive) {
  if (!Number.isFinite(alive) || !usage.dailyAnalytics) return;
  for (const source of Object.values(usage.dailyAnalytics.temperatures)) {
    source.validUntil = new Date(Math.min(Date.parse(source.validUntil), alive)).toISOString();
  }
}
function endDevice(usage, deviceId, at) {
  const daily = usage.dailyAnalytics; if (!daily) return;
  for (const source of Object.values(daily.temperatures)) if (source.osDeviceId === deviceId) {
    advanceTemperature(daily, source, at);
    source.validUntil = new Date(Math.min(Date.parse(source.validUntil), at)).toISOString();
  }
}
function dailyEvents(usage) {
  const daily = usage.dailyAnalytics; if (!daily?.active) return [];
  return Object.entries(daily.days).filter(([key, row]) => row.coverageStartAt
    && (row.kind !== 'TEMPERATURE' || row.knownMilliseconds > 0)
    && row.revision > (daily.queuedRevisions[key] || 0))
    .map(([key, row]) => { const { _histogram, ...payload } = row;
      return { key, aggregateId: crypto.createHash('sha256').update(key).digest('hex'), payload }; });
}
module.exports = { settings, initialize, recordUsageInterval, observeTemperature, advanceDaily, capDailyAtLastAlive, endDevice, dailyEvents };
