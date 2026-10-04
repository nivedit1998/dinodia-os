const test = require("node:test");
const assert = require("node:assert/strict");
const { activityFor, advanceUsage, initialUsageState, observeUsage } = require("../src/sync/usageBuckets");

function observed(overrides = {}) {
  return {
    osDeviceId: "device-a", osAreaId: "area-a", category: "LIGHT", controlId: "control-power",
    sourceGeneration: 2, activity: "on", observedAt: "2026-10-04T10:30:00.000Z",
    validUntil: "2026-10-04T10:32:00.000Z", nowMs: Date.parse("2026-10-04T10:35:00.000Z"), ...overrides,
  };
}

test("activity needs the actual semantic signal; target, mode and missing light power stay unknown", () => {
  assert.equal(activityFor({ category: "RADIATOR", role: "target_temperature", value: 22 }), "unknown");
  assert.equal(activityFor({ category: "BOILER", role: "operating_mode", value: "heating" }), "unknown");
  assert.equal(activityFor({ category: "LIGHT", role: "brightness", value: 80 }), "unknown");
  assert.equal(activityFor({ category: "LIGHT", role: "power", value: "ON" }), "on");
  assert.equal(activityFor({ category: "RADIATOR", role: "active_heat_demand", value: false }), "off");
  assert.equal(activityFor({ category: "BOILER", role: "active_heat_production", value: true }), "on");
});

test("source validity expires at its exact deadline and later coverage is Unknown", () => {
  const first = observeUsage(initialUsageState(), observed());
  const buckets = Object.values(first.state.buckets);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].onSeconds, 120);
  assert.equal(buckets[0].unknownSeconds, 180);
  const advanced = advanceUsage(first.state, Date.parse("2026-10-04T11:00:00.000Z"));
  const bucket = Object.values(advanced.state.buckets)[0];
  assert.equal(bucket.onSeconds, 120);
  assert.equal(bucket.unknownSeconds, 1680);
  assert.equal(bucket.closedAt, "2026-10-04T11:00:00.000Z");
  assert.equal(advanced.changedBuckets.length, 1);
});

test("out-of-order observations cannot move source coverage backward or alter newer counters", () => {
  const first = observeUsage(initialUsageState(), observed());
  const stale = observeUsage(first.state, observed({
    activity: "off", observedAt: "2026-10-04T10:34:00.000Z", validUntil: "2026-10-04T10:36:00.000Z",
    nowMs: Date.parse("2026-10-04T10:40:00.000Z"),
  }));
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.changedBuckets, []);
  assert.deepEqual(stale.state, first.state);
});

test("invalid calendar observations and contradictory same-time values are rejected", () => {
  assert.throws(() => observeUsage(initialUsageState(), observed({ observedAt: "2026-02-31T10:00:00Z" })), /Invalid native activity/);
  const first = observeUsage(initialUsageState(), observed());
  assert.throws(() => observeUsage(first.state, observed({ activity: "off" })), /Conflicting native activity/);
});
