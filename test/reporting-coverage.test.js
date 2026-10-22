const test = require("node:test");
const assert = require("node:assert/strict");
const { advanceUsage, initialUsageState, observeUsage } = require("../src/sync/usageBuckets");
const { readingLifetimeSeconds, unknownReason, zigbeeMaxReportIntervalSeconds } = require("../src/sync/reportingCoverage");

// Fixtures in Zigbee2MQTT bridge/devices shape. The TRVZB entry mirrors the live Hub's stored
// configuration on 22 Oct 2026 (hvacThermostat localTemp, occupiedHeatingSetpoint and
// systemMode reporting, max 3600 s; nothing for runningState).
const reporting = (cluster, attribute, max, min = 0) => ({ cluster, attribute, minimum_report_interval: min, maximum_report_interval: max, reportable_change: 0 });
const trvzbToday = { model_id: "TRVZB", power_source: "Battery", endpoints: { 1: { configured_reportings: [
  reporting("hvacThermostat", "localTemp", 3600), reporting("hvacThermostat", "occupiedHeatingSetpoint", 3600),
  reporting("hvacThermostat", "systemMode", 3600, 10),
] } } };
const trvzbWithRunningState = { ...trvzbToday, endpoints: { 1: { configured_reportings: [
  ...trvzbToday.endpoints[1].configured_reportings, reporting("hvacThermostat", "runningState", 600),
] } } };
const lightWithOnOffReporting = { power_source: "Mains (single phase)", endpoints: { 11: { configured_reportings: [reporting("genOnOff", "onOff", 3600)] } } };
const lightWithoutReporting = { power_source: "Mains (single phase)", endpoints: { 1: { configured_reportings: [] } } };
const switchDisabledReporting = { power_source: "Mains (single phase)", endpoints: { 1: { configured_reportings: [reporting("genOnOff", "onOff", 65535)] } } };

test("periodic-report guarantees come only from the value's own configured reporting", () => {
  assert.equal(zigbeeMaxReportIntervalSeconds(trvzbToday, "running_state"), null, "today the TRVZB has no periodic heating-state report");
  assert.equal(zigbeeMaxReportIntervalSeconds(trvzbToday, "local_temperature"), 3600);
  assert.equal(zigbeeMaxReportIntervalSeconds(trvzbWithRunningState, "running_state"), 600);
  assert.equal(zigbeeMaxReportIntervalSeconds(lightWithOnOffReporting, "state"), 3600);
  assert.equal(zigbeeMaxReportIntervalSeconds(lightWithoutReporting, "state"), null, "no universal on/off default is assumed");
  assert.equal(zigbeeMaxReportIntervalSeconds(switchDisabledReporting, "state"), null, "0xFFFF means no periodic report");
});

test("reading lifetimes follow the guarantee with an explicit zero-missed-report policy", () => {
  assert.equal(readingLifetimeSeconds({ kind: "report_on_change" }, 1800), 1800, "battery report-on-change keeps today's 30 minutes");
  assert.equal(readingLifetimeSeconds({ kind: "periodic_report", maxIntervalSeconds: 600 }, 1800), 660, "10-minute reports: 10 min + 60 s delivery grace, no missed report tolerated");
  assert.equal(readingLifetimeSeconds({ kind: "periodic_report", maxIntervalSeconds: 3600 }, 420), 3660, "hourly on/off reports keep an hour");
  assert.equal(readingLifetimeSeconds({ kind: "periodic_report", maxIntervalSeconds: 60 }, 420), 120, "Matter subscription, 60 s ceiling");
  assert.equal(readingLifetimeSeconds({ kind: "polling", intervalSeconds: 120 }, 420), 180, "Hive cloud polling every 2 minutes");
  assert.equal(readingLifetimeSeconds(undefined, undefined), 420);
});

function replay(reports, lifetimeSeconds, untilAt) {
  let state = initialUsageState();
  for (const [at, activity] of reports) {
    const observedMs = Date.parse(at);
    state = observeUsage(state, { osDeviceId: "trv", osAreaId: "room", category: "RADIATOR", controlId: "demand", sourceGeneration: 1,
      activity, observedAt: at, validUntil: new Date(observedMs + lifetimeSeconds * 1000).toISOString(), nowMs: observedMs }).state;
  }
  state = advanceUsage(state, Date.parse(untilAt)).state;
  return Object.values(state.buckets).reduce((sum, bucket) => [sum[0] + bucket.onSeconds, sum[1] + bucket.offSeconds, sum[2] + bucket.unknownSeconds], [0, 0, 0]);
}

test("today's observed heating messages give 30 minutes known out of six hours", () => {
  // Live log 22 Oct: idle 16:48:43, heat 16:49:13, then no heating-state message before 23:30.
  const totals = replay([["2026-10-22T15:48:43.000Z", "off"], ["2026-10-22T15:49:13.000Z", "on"]], 1800, "2026-10-22T21:49:13.000Z");
  assert.deepEqual(totals, [1800, 30, 6 * 3600 - 1800]);
});

test("ten-minute heating-state reports make the same six hours measured; a missed report is Unknown, not Heating", () => {
  const reports = [];
  for (let minute = 0; minute <= 360; minute += 10) reports.push([new Date(Date.parse("2026-10-22T15:49:13.000Z") + minute * 60000).toISOString(), "on"]);
  assert.deepEqual(replay(reports, 660, "2026-10-22T21:49:13.000Z"), [6 * 3600, 0, 0]);
  const withMissed = reports.filter(([, ], index) => index !== 10); // the 100-minute report never arrives
  assert.deepEqual(replay(withMissed, 660, "2026-10-22T21:49:13.000Z"), [6 * 3600 - 540, 0, 540],
    "after a missed report the 9 minutes beyond the 11-minute lifetime are Unknown");
});

test("Unknown carries a reason without becoming a fourth usage category", () => {
  const now = Date.parse("2026-10-22T23:00:00.000Z");
  const minutesAgo = (minutes) => now - minutes * 60000;
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: minutesAgo(1), valueObservedMs: minutesAgo(5), valueValidUntilMs: minutesAgo(-25) }), null);
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: minutesAgo(21), valueObservedMs: minutesAgo(379), valueValidUntilMs: minutesAgo(349), reachabilityWindowSeconds: 1800 }),
    "value_not_recently_reported", "live radiator: reachable, heating state 6 h 19 min old");
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: false, deviceLastSeenMs: minutesAgo(1), valueObservedMs: minutesAgo(40), valueValidUntilMs: minutesAgo(10), reachabilityWindowSeconds: 1800 }), "device_unreachable");
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: minutesAgo(90), valueObservedMs: minutesAgo(120), valueValidUntilMs: minutesAgo(90), reachabilityWindowSeconds: 1800 }), "device_unreachable");
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: minutesAgo(2), valueObservedMs: undefined, valueValidUntilMs: undefined, reachabilityWindowSeconds: 1800 }), "value_never_reported");
});
