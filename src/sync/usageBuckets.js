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
  const buckets = input.buckets && typeof input.buckets === "object" ? input.buckets : {};
  const sources = input.sources && typeof input.sources === "object" ? input.sources : {};
  // Older persisted buckets did not store their covered interval. Recover the
  // contiguous accounted span from the existing absolute counters and the
  // known close/accounted-through boundary; never expand a partial bucket to
  // an hour merely because its containing hour has ended.
  for (const bucket of Object.values(buckets)) {
    if (!bucket || typeof bucket !== "object" || bucket.coverageStartAt && bucket.coverageEndAt) continue;
    const start = validInstant(bucket.bucketStart);
    const seconds = Number(bucket.onSeconds || 0) + Number(bucket.offSeconds || 0) + Number(bucket.unknownSeconds || 0);
    if (start === null || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 3600) continue;
    const source = Object.values(sources).find((candidate) => candidate
      && candidate.osDeviceId === bucket.osDeviceId && candidate.osAreaId === bucket.osAreaId
      && candidate.controlId === bucket.controlId && candidate.sourceGeneration === bucket.sourceGeneration
      && validInstant(candidate.accountedThroughAt) !== null
      && validInstant(candidate.accountedThroughAt) >= start && validInstant(candidate.accountedThroughAt) <= start + 3600000);
    const end = validInstant(bucket.closedAt) ?? (source ? validInstant(source.accountedThroughAt) : null) ?? start + seconds * 1000;
    bucket.coverageEndAt = new Date(end).toISOString();
    bucket.coverageStartAt = new Date(end - seconds * 1000).toISOString();
  }
  return {
    schemaVersion: 1,
    sources,
    buckets,
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
    // Quantize both endpoints against the same epoch-second grid. Rounding
    // each fragment's duration independently loses a second whenever a
    // contiguous fragment ends with a smaller millisecond fraction than it
    // started with. That made coverageStartAt/coverageEndAt span more seconds
    // than the activity counters and caused the strict cloud sync contract to
    // reject otherwise valid usage events. Ceil boundaries avoid attributing
    // a whole second before the observation while keeping adjacent fragments
    // contiguous and their integer-second totals exactly reconcilable.
    const coveredStart = Math.ceil(cursor / 1000) * 1000;
    const coveredEnd = Math.ceil(stop / 1000) * 1000;
    const seconds = Math.max(0, (coveredEnd - coveredStart) / 1000);
    const key = bucketKey(source, start);
    const existingBucket = state.buckets[key];
    if (seconds > 0) {
      const bucket = existingBucket || (state.buckets[key] = {
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
        coverageStartAt: null,
        coverageEndAt: null,
        closedAt: null,
        purgeAt: oneYearAfter(start).toISOString(),
      });
      const field = activity === "on" ? "onSeconds" : activity === "off" ? "offSeconds" : "unknownSeconds";
      bucket[field] += seconds;
      const previousStart = validInstant(bucket.coverageStartAt);
      const previousEnd = validInstant(bucket.coverageEndAt);
      bucket.coverageStartAt = new Date(previousStart === null ? coveredStart : Math.min(previousStart, coveredStart)).toISOString();
      bucket.coverageEndAt = new Date(previousEnd === null ? coveredEnd : Math.max(previousEnd, coveredEnd)).toISOString();
      if (stop === start + 3_600_000) bucket.closedAt = new Date(stop).toISOString();
      bucket.revision += 1;
      changed.add(key);
    } else if (existingBucket && stop === start + 3_600_000 && existingBucket.closedAt == null) {
      // Endpoint quantization may already have accounted through the exact
      // hour boundary even though the final raw millisecond fragment rounds
      // to zero seconds. Finalize that existing coverage at the real boundary
      // so it is not serialized as a full-hour/open bucket. Do not invent a
      // bucket or close one whose counted coverage does not end here.
      const coverageStart = validInstant(existingBucket.coverageStartAt);
      const coverageEnd = validInstant(existingBucket.coverageEndAt);
      const accountedSeconds = Number(existingBucket.onSeconds || 0)
        + Number(existingBucket.offSeconds || 0) + Number(existingBucket.unknownSeconds || 0);
      if (coverageStart !== null && coverageEnd === stop && Number.isSafeInteger(accountedSeconds)
        && accountedSeconds === (coverageEnd - coverageStart) / 1000) {
        existingBucket.closedAt = new Date(stop).toISOString();
        existingBucket.revision += 1;
        changed.add(key);
      }
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
  if (category === "RADIATOR" && scalar === "heat") return "on";
  if (scalar === true || ["on", "active", "heating", "producing"].includes(scalar)) return "on";
  if (scalar === false || ["off", "idle", "standby", "inactive", "satisfied"].includes(scalar)) return "off";
  return "unknown";
}

function advanceSource(state, source, untilMs) {
  const start = validInstant(source.accountedThroughAt);
  const assignmentEnd = source.assignmentEndedAt == null ? null : validInstant(source.assignmentEndedAt);
  const boundedUntil = assignmentEnd === null ? untilMs : Math.min(untilMs, assignmentEnd);
  if (start === null || boundedUntil <= start) return [];
  const expiry = source.validUntil == null ? start : validInstant(source.validUntil);
  const knownUntil = expiry === null ? start : Math.min(boundedUntil, Math.max(start, expiry));
  const changed = [];
  if (knownUntil > start) changed.push(...addInterval(state, source, start, knownUntil, source.activity));
  if (boundedUntil > knownUntil) changed.push(...addInterval(state, source, knownUntil, boundedUntil, "unknown"));
  source.accountedThroughAt = new Date(boundedUntil).toISOString();
  return [...new Set(changed)];
}

function endUsageAssignment(stateValue, input) {
  const state = initialUsageState(stateValue);
  const endedAtMs = Number(input?.endedAtMs);
  if (!input?.osDeviceId || !input?.osAreaId || !Number.isSafeInteger(endedAtMs) || endedAtMs < 0) {
    throw new Error("Invalid native usage assignment boundary");
  }
  const changed = new Set();
  const sources = Object.values(state.sources).filter((source) => source.osDeviceId === String(input.osDeviceId)
    && source.osAreaId === String(input.osAreaId) && source.assignmentEndedAt == null);
  for (const source of sources) {
    const accountedThrough = validInstant(source.accountedThroughAt);
    if (accountedThrough === null || endedAtMs < accountedThrough) {
      throw new Error("Native usage assignment boundary precedes accounted coverage");
    }
  }
  for (const source of sources) {
    for (const key of advanceSource(state, source, endedAtMs)) changed.add(key);
    source.assignmentEndedAt = new Date(endedAtMs).toISOString();
  }
  return { state, changedBuckets: [...changed] };
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
    const hasAssignmentEnd = prior.assignmentEndedAt != null;
    const priorAssignmentEnd = prior.assignmentEndedAt == null ? null : validInstant(prior.assignmentEndedAt);
    if (hasAssignmentEnd && priorAssignmentEnd === null) return { state, changedBuckets: [], stale: true, changed: false };
    if (prior.osAreaId !== String(input.osAreaId) && priorAssignmentEnd === null) {
      return { state, changedBuckets: [], stale: true, changed: false };
    }
    if (priorAssignmentEnd !== null) {
      if (observedAt < priorAssignmentEnd || accountedThrough !== priorAssignmentEnd) {
        return { state, changedBuckets: [], stale: true, changed: false };
      }
      // A source sample from the new assignment starts a distinct coverage
      // interval. Never advance the ended Area's source across the move.
    } else {
      if (priorObserved === observedAt) {
        // A restart may have shortened coverage, but not the original observation's
        // identity. Replaying it must neither conflict nor restore the shortened tail.
        const originalDeadline = Object.hasOwn(prior, "observationValidUntil") ? prior.observationValidUntil : prior.validUntil;
        if (prior.activity !== input.activity || originalDeadline !== (validUntil === null ? null : new Date(validUntil).toISOString())) throw new Error("Conflicting native activity observation timestamp");
        return { state, changedBuckets: [], stale: false, changed: false };
      }
      if (priorObserved !== null && observedAt < priorObserved || accountedThrough !== null && observedAt < accountedThrough) {
        return { state, changedBuckets: [], stale: true, changed: false };
      }
      modified.push(...advanceSource(state, prior, observedAt));
    }
  }
  const source = {
    osDeviceId: String(input.osDeviceId), osAreaId: String(input.osAreaId), category: input.category,
    controlId: String(input.controlId), sourceGeneration: input.sourceGeneration,
    activity: input.activity, lastObservedAt: new Date(observedAt).toISOString(),
    accountedThroughAt: new Date(observedAt).toISOString(),
    validUntil: validUntil === null ? null : new Date(validUntil).toISOString(),
    observationValidUntil: validUntil === null ? null : new Date(validUntil).toISOString(),
  };
  state.sources[key] = source;
  modified.push(...advanceSource(state, source, input.nowMs));
  return { state, changedBuckets: [...new Set(modified)], stale: false, changed: true };
}

function advanceUsage(stateValue, nowMs) {
  const state = initialUsageState(stateValue);
  if (!Number.isSafeInteger(nowMs)) throw new Error("Invalid activity advance time");
  const changed = new Set();
  for (const source of Object.values(state.sources)) for (const key of advanceSource(state, source, nowMs)) changed.add(key);
  return { state, changedBuckets: [...changed] };
}

// An availability event ends supported coverage at receipt time. It is not
// another report of the old attribute at that attribute's original timestamp.
function endUsageDeviceAvailability(stateValue, deviceId, nowMs) {
  const state = initialUsageState(stateValue);
  const changed = new Set();
  let capped = false;
  for (const source of Object.values(state.sources)) {
    if (source.osDeviceId !== String(deviceId) || source.assignmentEndedAt != null) continue;
    for (const key of advanceSource(state, source, nowMs)) changed.add(key);
    const deadline = validInstant(source.validUntil);
    const through = validInstant(source.accountedThroughAt);
    const end = Math.max(nowMs, through ?? nowMs);
    if (deadline !== null && deadline > end) {
      if (!Object.hasOwn(source, "observationValidUntil")) source.observationValidUntil = source.validUntil;
      source.validUntil = new Date(end).toISOString();
      capped = true;
    }
  }
  return { state, changedBuckets: [...changed], changed: capped || changed.size > 0 };
}

// After a restart, no reading may count beyond the last moment the Hub is known to have been
// running: the time the Hub was off (a power cut) is not evidence of any device state, so it
// becomes Unknown instead of extending the last reading up to its validity deadline.
function capUsageAtLastAlive(stateValue, aliveThroughMs) {
  const state = initialUsageState(stateValue);
  if (!Number.isSafeInteger(aliveThroughMs)) return state;
  const boundary = new Date(aliveThroughMs).toISOString();
  for (const source of Object.values(state.sources)) {
    if (source.assignmentEndedAt != null || source.validUntil == null) continue;
    const validUntil = validInstant(source.validUntil);
    const accountedThrough = validInstant(source.accountedThroughAt);
    if (validUntil === null || validUntil <= aliveThroughMs) continue;
    if (!Object.hasOwn(source, "observationValidUntil")) source.observationValidUntil = source.validUntil;
    source.validUntil = accountedThrough !== null && accountedThrough > aliveThroughMs ? source.accountedThroughAt : boundary;
  }
  return state;
}

// History may only be recorded under a clock the system has synchronized, and never under a
// clock that is behind the last time the Hub recorded itself running (a Pi without a hardware
// clock can boot with a stale time when it has no internet).
function usageClockTrusted({ synchronized, nowMs, aliveThroughMs }) {
  if (synchronized !== true || !Number.isSafeInteger(nowMs)) return false;
  return !Number.isSafeInteger(aliveThroughMs) || nowMs >= aliveThroughMs;
}

module.exports = { activityFor, advanceUsage, capUsageAtLastAlive, endUsageAssignment, endUsageDeviceAvailability, initialUsageState, observeUsage, usageClockTrusted };
