const crypto = require('node:crypto');
const { validTimezone, calendarDay, calendarWeek, annualDayCutoff } = require('./analyticsCalendar');

function settings(value) {
  return value && value.version === 1 && value.enabled === true && validTimezone(value.timezone)
    && typeof value.writerFrom === 'string' && Number.isFinite(Date.parse(value.writerFrom))
    && new Date(value.writerFrom).toISOString() === value.writerFrom && Date.parse(value.writerFrom) % 3600000 === 0
    && (value.detailPruneBefore == null || typeof value.detailPruneBefore === 'string'
      && Number.isFinite(Date.parse(value.detailPruneBefore)) && new Date(value.detailPruneBefore).toISOString() === value.detailPruneBefore)
    ? { version: 1, enabled: true, timezone: value.timezone, writerFrom: value.writerFrom,
      ...(value.detailPruneBefore ? { detailPruneBefore: value.detailPruneBefore } : {}) } : null;
}
function initialize(usage, configuration, now) {
  const config = settings(configuration); if (!config) { if (usage.dailyAnalytics) usage.dailyAnalytics.active = false; return null; }
  let existing = usage.dailyAnalytics;
  if (existing && (existing.config.timezone !== config.timezone || existing.config.writerFrom !== config.writerFrom))
    if (!existing.barrierQueued && !Object.keys(existing.days).length && Number.isFinite(now) && Date.parse(config.writerFrom) > now) {
      delete usage.dailyAnalytics; existing = null;
    } else throw new Error('Daily analytics writer identity cannot change without reconciliation');
  const daily = usage.dailyAnalytics ||= { version: 1, config, days: {}, temperatures: {}, queuedRevisions: {}, queuedSequences: {}, assignmentEpochs: {}, barrierQueued: false };
  daily.queuedSequences ||= {}; daily.assignmentEpochs ||= {};
  daily.config = config;
  if (!daily.preparedAt && Number.isFinite(now)) daily.preparedAt = new Date(now).toISOString();
  if (daily.preparedAt && Date.parse(daily.preparedAt) > Date.parse(config.writerFrom) && !daily.barrierQueued) {
    daily.active = false; daily.notReadyReason = 'writer_handover_was_received_late'; return null;
  }
  daily.notReadyReason = null;
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
    coverageStartAt: null, coverageEndAt: null, closedAt: null };
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
      const beforeLast = { lastCelsius: row.lastCelsius, lastObservedAt: row.lastObservedAt, lastValidUntil: row.lastValidUntil };
      if (!row.knownMilliseconds) { row.coverageStartAt = new Date(cursor).toISOString(); row.sampleCount = 0; }
      const ms = stop - cursor; row.knownMilliseconds += ms;
      row.celsiusMilliseconds = Math.round((row.celsiusMilliseconds + ms * value) * 100) / 100;
      row.minimumCelsius = row.minimumCelsius === null ? value : Math.min(row.minimumCelsius, value);
      row.maximumCelsius = row.maximumCelsius === null ? value : Math.max(row.maximumCelsius, value);
      row.lastCelsius = value; row.lastObservedAt = source.observedAt; row.lastValidUntil = source.validUntil;
      const bin = String(Math.round(value * 100)); row._histogram[bin] = (row._histogram[bin] || 0) + ms;
      source._integrations ||= [];
      if (!source._integrations.some(segment => segment.key === keyFor(source, kind, day.start))) row.sampleCount++;
      const previous = source._integrations.at(-1);
      if (previous && previous.key === keyFor(source, kind, day.start) && previous.end === cursor) previous.end = stop;
      else source._integrations.push({ key: keyFor(source, kind, day.start), start: cursor, end: stop, beforeLast });
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
function assignmentStart(usage, device, policy) {
  const daily = usage.dailyAnalytics; if (!daily?.active) return undefined;
  const signed = policy?.osAreaIds?.includes(String(device.areaId)) ? Date.parse(policy.analyticsAssignmentStartedAt) : NaN;
  // Cloud assignment identity and local receipt time have different meanings.
  // Delayed registration must not invent a later epoch than the signed one.
  if (Number.isFinite(signed)) return new Date(Math.max(Date.parse(daily.config.writerFrom), Math.floor(signed / 1000) * 1000)).toISOString();
  return new Date(Math.max(Date.parse(daily.config.writerFrom),
    Date.parse(daily.assignmentEpochs[device.id]) || 0)).toISOString();
}
function temperatureKey(source) {
  return [source.osDeviceId, source.osAreaId, source.controlId, source.sourceGeneration,
    source.bindingRevision || 0, source.assignmentEpochAt || ''].join('|');
}

// Correct only fragments wholly inside the CURRENT signed assignment. Earlier
// room visits, different sources/authority and overlapping fragments stay intact.
// Immutable outbox envelopes are untouched; corrected absolute snapshots travel
// through the ordinary authenticated writer, which rechecks all cloud authority.
function reconcileAssignment(usage, device, policy) {
  const daily = usage.dailyAnalytics, interval = policy?.analyticsInterval;
  if (!daily?.active || policy?.managementClass !== 'PROPERTY_DEVICE' || policy.ownerMembershipId
    || policy.lifecycle !== 'INSTALLED' || !interval?.writerEnabled
    || !policy.osAreaIds?.includes(String(device.areaId))) return false;
  const signed = Date.parse(policy.analyticsAssignmentStartedAt);
  if (!Number.isFinite(signed)) return false;
  const canonical = assignmentStart(usage, device, policy), boundary = Math.max(signed, Date.parse(daily.config.writerFrom));
  const matches = source => source.osDeviceId === device.id && source.osAreaId === String(device.areaId)
    && source.sourceGeneration === interval.sourceGeneration && source.bindingRevision === interval.revision
    && source.analyticsIntervalId === interval.id
    && (source.category || source.analyticsCategory) === policy.analyticsCategory
    && Date.parse(source.assignmentEpochAt) > Date.parse(canonical);
  const moves = [];
  const targets = new Set();
  for (const [key, row] of Object.entries(daily.days)) {
    if (!matches(row) || Date.parse(row.coverageStartAt) < boundary || !Number.isFinite(Date.parse(row.coverageStartAt))) continue;
    const target = keyFor({ ...row, category: row.analyticsCategory, assignmentEpochAt: canonical }, row.kind, Date.parse(row.dayStartAt));
    if (target !== key && daily.days[target] || targets.has(target)) return false; // never merge potentially overlapping absolute counters
    targets.add(target);
    moves.push({ key, target, row });
  }
  const temperatures = Object.entries(daily.temperatures).filter(([, source]) => matches(source) && Date.parse(source.observedAt) >= boundary);
  if (temperatures.some(([key, source]) => {
    const target = temperatureKey({ ...source, assignmentEpochAt: canonical });
    return target !== key && daily.temperatures[target];
  })) return false;
  let changed = false;
  const renamed = new Map();
  for (const { key, target, row } of moves) {
    delete daily.days[key]; delete daily.queuedRevisions[key]; delete daily.queuedSequences[key];
    row.assignmentEpochAt = canonical; row.revision++;
    daily.days[target] = row; renamed.set(key, target); changed = true;
  }
  for (const [key, source] of temperatures) {
    delete daily.temperatures[key]; source.assignmentEpochAt = canonical;
    for (const segment of source._integrations || []) if (renamed.has(segment.key)) segment.key = renamed.get(segment.key);
    daily.temperatures[temperatureKey(source)] = source; changed = true;
  }
  for (const source of Object.values(usage.sources || {})) if (matches(source) && source.assignmentEndedAt == null
    && Date.parse(source.lastObservedAt) >= boundary) { source.assignmentEpochAt = canonical; changed = true; }
  return changed;
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
  const key = temperatureKey(source);
  const previous = daily.temperatures[key]; const observed = Date.parse(source.observedAt);
  if (!Number.isFinite(observed) || observed > now) return;
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
      if (segment.end - removed <= segment.start) {
        row.sampleCount = Math.max(0, row.sampleCount - 1);
        if (row.knownMilliseconds && segment.beforeLast) Object.assign(row, segment.beforeLast);
      }
      if (!row.knownMilliseconds) {
        row.celsiusMilliseconds = 0; row.sampleCount = 0; row.lastCelsius = null; row.lastObservedAt = null; row.lastValidUntil = null;
      } else if (Date.parse(row.coverageEndAt) <= segment.end) {
        row.coverageEndAt = new Date(Math.max(Date.parse(row.coverageStartAt), observed)).toISOString();
      }
      row.revision++; segment.end -= removed;
    }
    previous.accountedThrough = Math.min(previous.accountedThrough, observed);
    advanceTemperature(daily, previous, Math.min(now, observed));
  }
  if (!Number.isFinite(source.value) || !Number.isFinite(Date.parse(source.validUntil)) || Date.parse(source.validUntil) <= observed) {
    daily.temperatures[key] = { ...source, validUntil: new Date(observed).toISOString(), accountedThrough: observed, _integrations: [] };
    return;
  }
  const next = { ...source, accountedThrough: Math.max(observed, Date.parse(daily.config.writerFrom)) };
  daily.temperatures[key] = next; advanceTemperature(daily, next, now);
}
function advanceDaily(usage, now) {
  const daily = usage.dailyAnalytics; if (!daily?.active) return;
  for (const source of Object.values(daily.temperatures)) advanceTemperature(daily, source, now);
  const cutoff = annualDayCutoff(now, daily.config.timezone);
  for (const day of Object.values(daily.days)) if (!day.closedAt && Date.parse(day.dayEndAt) <= now) {
    day.closedAt = day.dayEndAt; day.revision++;
  }
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
    const boundary = Number.isFinite(at) ? at : source.accountedThrough;
    advanceTemperature(daily, source, boundary);
    source.validUntil = new Date(Math.min(Date.parse(source.validUntil), boundary)).toISOString();
  }
}
function dailyEvents(usage) {
  const daily = usage.dailyAnalytics; if (!daily?.active) return [];
  return Object.entries(daily.days).filter(([key, row]) => row.coverageStartAt
    && row.revision > (daily.queuedRevisions[key] || 0))
    .map(([key, row]) => { const { _histogram, ...payload } = row;
      return { key, aggregateId: crypto.createHash('sha256').update(key).digest('hex'), payload }; });
}
function detailPruneBoundary(daily, now) {
  if (!daily?.config.detailPruneBefore) return -Infinity;
  return Math.min(Date.parse(daily.config.detailPruneBefore), calendarWeek(now, daily.config.timezone).start);
}
module.exports = { settings, initialize, assignmentStart, reconcileAssignment, recordUsageInterval, observeTemperature, advanceDaily, capDailyAtLastAlive, endDevice, dailyEvents, detailPruneBoundary };
