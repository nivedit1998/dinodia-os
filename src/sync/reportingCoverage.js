// Capability-driven reading lifetimes for usage history (proposal; not wired into descriptors yet).
//
// A reading counts as measured only for as long as the integration guarantees another report
// of that same value. A device check-in, battery report or another attribute never renews it:
// Zigbee2MQTT counts any message as availability, which says the device is reachable, not that
// a radiator is still heating or a light still on.

// Zigbee2MQTT exposed property -> the Zigbee cluster/attribute whose reporting guarantees it.
const ZIGBEE_REPORTED_ATTRIBUTE = Object.freeze({
  running_state: { cluster: "hvacThermostat", attribute: "runningState" },
  local_temperature: { cluster: "hvacThermostat", attribute: "localTemp" },
  state: { cluster: "genOnOff", attribute: "onOff" },
  brightness: { cluster: "genLevelCtrl", attribute: "currentLevel" },
});

// Explicit product policy, deliberately conservative:
// - No missed report is tolerated: once the guaranteed maximum interval (plus delivery grace)
//   passes without a new report of the value, the time is Unknown.
// - Delivery grace covers radio retries and MQTT delivery, not a missed report.
const MISSED_REPORTS_TOLERATED = 0;
const DELIVERY_GRACE_SECONDS = 60;
// Zigbee uses 0xFFFF (and 0) to mean "no periodic report"; above 65000 is treated the same.
const ZIGBEE_NO_PERIODIC_REPORT = 65000;

/// The configured maximum report interval for one exposed Zigbee property, from a
/// Zigbee2MQTT bridge/devices entry, or null when no periodic report is configured.
function zigbeeMaxReportIntervalSeconds(rawDevice, property) {
  const target = ZIGBEE_REPORTED_ATTRIBUTE[property];
  if (!target || !rawDevice || typeof rawDevice !== "object") return null;
  let best = null;
  for (const endpoint of Object.values(rawDevice.endpoints || {})) {
    for (const reporting of Array.isArray(endpoint?.configured_reportings) ? endpoint.configured_reportings : []) {
      if (reporting?.cluster !== target.cluster || reporting?.attribute !== target.attribute) continue;
      const max = Number(reporting.maximum_report_interval);
      if (!Number.isSafeInteger(max) || max <= 0 || max >= ZIGBEE_NO_PERIODIC_REPORT) continue;
      best = best === null ? max : Math.min(best, max);
    }
  }
  return best;
}

/// How the integration guarantees fresh values for one capability.
///   { kind: "periodic_report", maxIntervalSeconds }   Zigbee configured reporting, Matter subscription max interval
///   { kind: "polling", intervalSeconds }               Hub polls a cloud API (Hive, Google Nest)
///   { kind: "report_on_change" }                       no guarantee beyond the device's own reports
function readingLifetimeSeconds(guarantee, fallbackSeconds) {
  const fallback = Number.isSafeInteger(fallbackSeconds) && fallbackSeconds > 0 ? fallbackSeconds : 420;
  if (guarantee?.kind === "periodic_report" && Number.isSafeInteger(guarantee.maxIntervalSeconds) && guarantee.maxIntervalSeconds > 0) {
    return guarantee.maxIntervalSeconds * (1 + MISSED_REPORTS_TOLERATED) + DELIVERY_GRACE_SECONDS;
  }
  if (guarantee?.kind === "polling" && Number.isSafeInteger(guarantee.intervalSeconds) && guarantee.intervalSeconds > 0) {
    return guarantee.intervalSeconds * (1 + MISSED_REPORTS_TOLERATED) + DELIVERY_GRACE_SECONDS;
  }
  return fallback;
}

/// Why a value is Unknown right now (null when it is a current measured reading). Explains
/// Unknown; it is not a fourth usage category: On + Off + Unknown still partition all time.
function unknownReason({ nowMs, deviceAvailable, deviceLastSeenMs, valueObservedMs, valueValidUntilMs, reachabilityWindowSeconds }) {
  if (Number.isSafeInteger(valueObservedMs) && Number.isSafeInteger(valueValidUntilMs) && valueObservedMs <= nowMs && nowMs < valueValidUntilMs) return null;
  if (deviceAvailable === false) return "device_unreachable";
  const window = Number.isSafeInteger(reachabilityWindowSeconds) && reachabilityWindowSeconds > 0 ? reachabilityWindowSeconds * 1000 : 0;
  const reachable = Number.isSafeInteger(deviceLastSeenMs) && window > 0 && nowMs - deviceLastSeenMs <= window;
  if (!Number.isSafeInteger(valueObservedMs)) return reachable ? "value_never_reported" : "device_unreachable";
  return reachable ? "value_not_recently_reported" : "device_unreachable";
}

module.exports = {
  DELIVERY_GRACE_SECONDS,
  MISSED_REPORTS_TOLERATED,
  ZIGBEE_REPORTED_ATTRIBUTE,
  readingLifetimeSeconds,
  unknownReason,
  zigbeeMaxReportIntervalSeconds,
};
