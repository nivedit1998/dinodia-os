'use strict';
// Measured-cadence validity for ambient temperature readings that have no verified
// reporting proof. It is passive: it only uses the source timestamps of readings the
// Hub has already received. It never configures or polls a device, and it never
// extends beyond the descriptor's own maximum validity.
const HISTORY_GAPS = 8;
const MINIMUM_GAPS = 3;
const GRACE_SECONDS = 60;
const FLOOR_SECONDS = 120;
const HINT_MULTIPLE = 3;
const FALLBACK_SECONDS = 300;
const MAXIMUM_SOURCES = 256;

function emptyHistory() { return { lastObservedMs: null, gaps: [] }; }

function sanitizeHistory(value) {
  if (!value || typeof value !== 'object') return emptyHistory();
  const last = Number.isSafeInteger(value.lastObservedMs) ? value.lastObservedMs : null;
  const gaps = Array.isArray(value.gaps) ? value.gaps.filter(gap => Number.isSafeInteger(gap) && gap > 0).slice(-HISTORY_GAPS) : [];
  return { lastObservedMs: last, gaps };
}

// Returns a new history. Duplicates, replays and out-of-order observations change nothing.
// A gap longer than the ceiling is an outage, not the sensor's cadence, so it is not remembered.
function recordObservation(history, observedMs, ceilingSeconds) {
  const current = sanitizeHistory(history);
  if (!Number.isSafeInteger(observedMs)) return current;
  if (current.lastObservedMs !== null && observedMs <= current.lastObservedMs) return current;
  const gaps = [...current.gaps];
  if (current.lastObservedMs !== null) {
    const gap = Math.round((observedMs - current.lastObservedMs) / 1000);
    if (gap >= 1 && (!Number.isSafeInteger(ceilingSeconds) || gap <= ceilingSeconds)) gaps.push(gap);
  }
  return { lastObservedMs: observedMs, gaps: gaps.slice(-HISTORY_GAPS) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// Seconds a reading counts for, or null when the descriptor gives no usable ceiling.
function measuredValiditySeconds(control, history) {
  const ceiling = control?.maxStateValiditySeconds;
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) return null;
  const hint = Number.isSafeInteger(control.expectedReportingIntervalSeconds) && control.expectedReportingIntervalSeconds > 0
    ? control.expectedReportingIntervalSeconds : null;
  const floor = Math.max(FLOOR_SECONDS, hint ? hint * HINT_MULTIPLE : 0);
  const gaps = sanitizeHistory(history).gaps;
  const seconds = gaps.length >= MINIMUM_GAPS ? 2 * median(gaps) + GRACE_SECONDS : hint ? hint * HINT_MULTIPLE : FALLBACK_SECONDS;
  return Math.min(ceiling, Math.max(floor, seconds));
}

function pruneSources(map) {
  const entries = Object.entries(map).map(([key, value]) => [key, sanitizeHistory(value)]);
  if (entries.length <= MAXIMUM_SOURCES) return Object.fromEntries(entries);
  return Object.fromEntries(entries.sort((a, b) => (b[1]?.lastObservedMs || 0) - (a[1]?.lastObservedMs || 0)).slice(0, MAXIMUM_SOURCES));
}

module.exports = { recordObservation, measuredValiditySeconds, sanitizeHistory, pruneSources,
  HISTORY_GAPS, MINIMUM_GAPS, GRACE_SECONDS, FLOOR_SECONDS };
