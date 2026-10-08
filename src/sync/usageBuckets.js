function validInstant(value) {
  const text = String(value || "");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(text);
  if (!match) return null;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  const components = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  const supplied = match.slice(1, 7).map(Number);
  return components.every((value, index) => value === supplied[index]) ? time : null;
}

function initialUsageState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: 1,
    sources: input.sources && typeof input.sources === "object" ? input.sources : {},
    buckets: input.buckets && typeof input.buckets === "object" ? input.buckets : {},
    queuedRevisions: input.queuedRevisions && typeof input.queuedRevisions === "object" ? input.queuedRevisions : {},
    temperatureQueuedKeys: Array.isArray(input.temperatureQueuedKeys) ? input.temperatureQueuedKeys.slice(-1024) : [],
  };
}

function hourStartMs(value) {
  return Math.floor(value / 3_600_000) * 3_600_000;
}

function oneYearAfter(value) {
  const date = new Date(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date;
}

function bucketKey(input, bucketStartMs) {
  return [input.osDeviceId, input.osAreaId, input.category, input.controlId, input.sourceGeneration, bucketStartMs].join("|");
}

function addInterval(state, source, startMs, endMs, activity) {
  let cursor = startMs;
  const changed = new Set();
  while (cursor < endMs) {
    const start = hourStartMs(cursor);
    const stop = Math.min(endMs, start + 3_600_000);
    const seconds = Math.floor((stop - cursor) / 1000);
    if (seconds > 0) {
      const key = bucketKey(source, start);
      const bucket = state.buckets[key] || (state.buckets[key] = {
        osDeviceId: source.osDeviceId,
        osAreaId: source.osAreaId,
        category: source.category,
        controlId: source.controlId,
        bucketStart: new Date(start).toISOString(),
        sourceGeneration: source.sourceGeneration,
        revision: 0,
        onSeconds: 0,
        offSeconds: 0,
        unknownSeconds: 0,
        closedAt: null,
        purgeAt: oneYearAfter(start).toISOString(),
      });
      const field = activity === "on" ? "onSeconds" : activity === "off" ? "offSeconds" : "unknownSeconds";
      bucket[field] += seconds;
      if (stop === start + 3_600_000) bucket.closedAt = new Date(stop).toISOString();
      bucket.revision += 1;
      changed.add(key);
    }
    cursor = stop;
  }
  return [...changed];
}

function activityFor({ category, role, value, available = true }) {
  if (!available) return "unknown";
  const normalizedRole = String(role || "");
  const scalar = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (category === "LIGHT") {
    if (normalizedRole === "power") {
      if (scalar === true || scalar === "on") return "on";
      if (scalar === false || scalar === "off") return "off";
    }
    if (normalizedRole === "brightness" && typeof scalar === "number" && Number.isFinite(scalar)) {
      if (scalar > 0) return "on";
      if (scalar === 0) return "off";
    }
    return "unknown";
  }
  const expectedRole = category === "RADIATOR" ? "active_heat_demand" : category === "BOILER" ? "active_heat_production" : "";
  if (!expectedRole || normalizedRole !== expectedRole) return "unknown";
  if (scalar === true || ["on", "active", "heating", "producing"].includes(scalar)) return "on";
  if (scalar === false || ["off", "idle", "standby", "inactive", "satisfied"].includes(scalar)) return "off";
  return "unknown";
}

function advanceSource(state, source, untilMs) {
  const start = validInstant(source.accountedThroughAt);
  if (start === null || untilMs <= start) return [];
  const expiry = source.validUntil == null ? start : validInstant(source.validUntil);
  const knownUntil = expiry === null ? start : Math.min(untilMs, Math.max(start, expiry));
  const changed = [];
  if (knownUntil > start) changed.push(...addInterval(state, source, start, knownUntil, source.activity));
  if (untilMs > knownUntil) changed.push(...addInterval(state, source, knownUntil, untilMs, "unknown"));
  source.accountedThroughAt = new Date(untilMs).toISOString();
  return [...new Set(changed)];
}

function observeUsage(stateValue, input) {
  const state = initialUsageState(stateValue);
  const observedAt = validInstant(input?.observedAt);
  const validUntil = input?.validUntil == null ? null : validInstant(input.validUntil);
  if (!input || !observedAt || !["LIGHT", "BOILER", "RADIATOR"].includes(input.category)
    || !input.osDeviceId || !input.osAreaId || !input.controlId || !Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 1
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < observedAt
    || input.activity !== "on" && input.activity !== "off" && input.activity !== "unknown"
    || input.activity !== "unknown" && (validUntil === null || validUntil <= observedAt)) {
    throw new Error("Invalid native activity observation");
  }
  const key = [input.osDeviceId, input.category, input.controlId, input.sourceGeneration].join("|");
  const prior = state.sources[key];
  const modified = [];
  if (prior) {
    const priorObserved = validInstant(prior.lastObservedAt);
    const accountedThrough = validInstant(prior.accountedThroughAt);
    if (priorObserved === observedAt) {
      if (prior.activity !== input.activity || prior.validUntil !== (validUntil === null ? null : new Date(validUntil).toISOString())) throw new Error("Conflicting native activity observation timestamp");
      return { state, changedBuckets: [], stale: false };
    }
    if (priorObserved !== null && observedAt < priorObserved || accountedThrough !== null && observedAt < accountedThrough) {
      return { state, changedBuckets: [], stale: true };
    }
    modified.push(...advanceSource(state, prior, observedAt));
  }
  const source = {
    osDeviceId: String(input.osDeviceId), osAreaId: String(input.osAreaId), category: input.category,
    controlId: String(input.controlId), sourceGeneration: input.sourceGeneration,
    activity: input.activity, lastObservedAt: new Date(observedAt).toISOString(),
    accountedThroughAt: new Date(observedAt).toISOString(),
    validUntil: validUntil === null ? null : new Date(validUntil).toISOString(),
  };
  state.sources[key] = source;
  modified.push(...advanceSource(state, source, input.nowMs));
  return { state, changedBuckets: [...new Set(modified)], stale: false };
}

function advanceUsage(stateValue, nowMs) {
  const state = initialUsageState(stateValue);
  if (!Number.isSafeInteger(nowMs)) throw new Error("Invalid activity advance time");
  const changed = new Set();
  for (const source of Object.values(state.sources)) for (const key of advanceSource(state, source, nowMs)) changed.add(key);
  return { state, changedBuckets: [...changed] };
}

module.exports = { activityFor, advanceUsage, initialUsageState, observeUsage };
