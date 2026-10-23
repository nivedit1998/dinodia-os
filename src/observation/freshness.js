// Hub-side freshness helpers for the observation policy (plan revision 3, §4 and §6).

/// Why a value is Unknown now (null while it is a current measured reading). Explains Unknown; never
/// a fourth usage category.
function unknownReason({ nowMs, hubRunning = true, clockTrusted = true, deviceAvailable, deviceLastSeenMs, valueObservedMs, valueValidUntilMs, reachabilityWindowSeconds }) {
  if (!hubRunning) return "hub_not_running";
  if (!clockTrusted) return "clock_not_trusted";
  if (Number.isSafeInteger(valueObservedMs) && Number.isSafeInteger(valueValidUntilMs) && valueObservedMs <= nowMs && nowMs < valueValidUntilMs) return null;
  if (deviceAvailable === false) return "device_unreachable";
  const window = Number.isSafeInteger(reachabilityWindowSeconds) && reachabilityWindowSeconds > 0 ? reachabilityWindowSeconds * 1000 : 0;
  const reachable = Number.isSafeInteger(deviceLastSeenMs) && window > 0 && nowMs - deviceLastSeenMs <= window;
  if (!Number.isSafeInteger(valueObservedMs)) return reachable ? "value_never_reported" : "device_unreachable";
  return reachable ? "value_not_recently_reported" : "device_unreachable";
}

/// Bounded device reads (fallback strategy). Returns the values due for a read now, honouring the
/// per-value interval, a per-device hourly cap and a Hub-wide minimum spacing. A configuration whose
/// budget cannot serve every enabled value at its interval is refused rather than leaving silent gaps.
function planBoundedReads({ nowMs, values, lastReadAtByKey = {}, readsInLastHourByDevice = {}, lastHubReadAtMs = 0,
  perDeviceHourlyCap = 12, hubSpacingMs = 10_000 }) {
  const enabled = values.filter((value) => value.enabled && value.power === "mains" && value.available !== false);
  const requiredPerHour = enabled.reduce((sum, value) => sum + Math.ceil(3600 / value.intervalSeconds), 0);
  if (requiredPerHour * hubSpacingMs > 3_600_000) {
    return { refused: true, reason: "hub_read_budget_insufficient", due: [] };
  }
  const perDevice = {};
  for (const value of enabled) perDevice[value.deviceId] = (perDevice[value.deviceId] || 0) + Math.ceil(3600 / value.intervalSeconds);
  if (Object.values(perDevice).some((count) => count > perDeviceHourlyCap)) {
    return { refused: true, reason: "device_read_budget_insufficient", due: [] };
  }
  if (nowMs - lastHubReadAtMs < hubSpacingMs) return { refused: false, due: [] };
  const due = enabled
    .filter((value) => nowMs - (lastReadAtByKey[value.key] ?? -Infinity) >= value.intervalSeconds * 1000)
    .filter((value) => (readsInLastHourByDevice[value.deviceId] || 0) < perDeviceHourlyCap)
    .sort((a, b) => (lastReadAtByKey[a.key] ?? -Infinity) - (lastReadAtByKey[b.key] ?? -Infinity));
  return { refused: false, due: due.slice(0, 1) };
}

module.exports = { planBoundedReads, unknownReason };
