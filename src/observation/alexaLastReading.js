"use strict";

// What the Alexa state endpoint may carry beside a state that is not current: the last value the device itself reported, with
// the time it reported it. It is never presented as current (quality and value stay strict); the Platform labels it with its
// true age. Only a read-only room temperature qualifies: a value the device reported, not inferred from a command or a
// check-in, and only while the device is not known to be offline or the clock untrusted.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const BLOCKED_STATUS = new Set(["clock_untrusted", "device_offline", "no_observation"]);

function lastReadingFrom({ control, state, evidence, now }) {
  if (!control || !state || state.quality === "fresh" || control.writable === true
    || control.semanticRole !== "ambient_temperature" || control.valueType !== "number"
    || !Number.isSafeInteger(state.revision) || state.revision < 1) return null;
  const last = evidence?.lastReported;
  if (!last || last.provenance !== "device_report" || typeof last.observedAt !== "string") return null;
  if (BLOCKED_STATUS.has(evidence?.evidence?.status)) return null;
  const observedMs = Date.parse(last.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > now || now - observedMs > MAX_AGE_MS) return null;
  if (typeof last.value !== "number" || !Number.isFinite(last.value)) return null;
  return { value: last.value, observedAt: last.observedAt, revision: state.revision };
}

module.exports = { lastReadingFrom, LAST_READING_MAX_AGE_MS: MAX_AGE_MS };
