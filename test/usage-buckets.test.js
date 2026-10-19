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

test("activity needs the actual semantic signal; target/mode stay unknown and Light power or brightness is measured", () => {
  assert.equal(activityFor({ category: "RADIATOR", role: "target_temperature", value: 22 }), "unknown");
  assert.equal(activityFor({ category: "BOILER", role: "operating_mode", value: "heating" }), "unknown");
  assert.equal(activityFor({ category: "LIGHT", role: "brightness", value: 80 }), "on");
  assert.equal(activityFor({ category: "LIGHT", role: "brightness", value: 0 }), "off");
  assert.equal(activityFor({ category: "LIGHT", role: "brightness", value: "80" }), "unknown");
  assert.equal(activityFor({ category: "LIGHT", role: "brightness", value: 80, available: false }), "unknown");
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
  assert.equal(bucket.coverageStartAt, "2026-10-04T10:30:00.000Z");
  assert.equal(bucket.coverageEndAt, "2026-10-04T11:00:00.000Z");
  assert.equal(bucket.onSeconds + bucket.offSeconds + bucket.unknownSeconds,
    (Date.parse(bucket.coverageEndAt) - Date.parse(bucket.coverageStartAt)) / 1000);
  assert.equal(bucket.closedAt, "2026-10-04T11:00:00.000Z");
  assert.equal(advanced.changedBuckets.length, 1);
});

test("millisecond observation and expiry boundaries keep usage counters equal to reported coverage", () => {
  const result = observeUsage(initialUsageState(), observed({
    observedAt: "2026-10-04T10:30:00.800Z",
    validUntil: "2026-10-04T10:30:05.300Z",
    nowMs: Date.parse("2026-10-04T10:30:07.800Z"),
  }));
  const bucket = Object.values(result.state.buckets)[0];
  assert.ok(bucket);
  assert.deepEqual([bucket.onSeconds, bucket.offSeconds, bucket.unknownSeconds], [5, 0, 2]);
  assert.equal(bucket.coverageStartAt, "2026-10-04T10:30:01.000Z");
  assert.equal(bucket.coverageEndAt, "2026-10-04T10:30:08.000Z");
  assert.equal(bucket.onSeconds + bucket.offSeconds + bucket.unknownSeconds,
    (Date.parse(bucket.coverageEndAt) - Date.parse(bucket.coverageStartAt)) / 1000,
    "every transmitted whole-second coverage interval must reconcile exactly with its activity counters");
});

test("an exact hour boundary closes an existing bucket even when the final raw fragment contributes zero seconds", () => {
  const almost = observeUsage(initialUsageState(), observed({
    category: "RADIATOR", controlId: "control-heat",
    observedAt: "2026-10-16T15:00:00.000Z", validUntil: "2026-10-16T15:59:59.000Z",
    nowMs: Date.parse("2026-10-16T15:59:59.500Z"),
  }));
  const [before] = Object.values(almost.state.buckets);
  const beforeRevision = before.revision;
  assert.deepEqual([before.onSeconds, before.offSeconds, before.unknownSeconds], [3599, 0, 1]);
  assert.equal(before.coverageEndAt, "2026-10-16T16:00:00.000Z");
  assert.equal(before.closedAt, null, "the hour must not be declared closed before the raw clock reaches its boundary");

  const atBoundary = advanceUsage(almost.state, Date.parse("2026-10-16T16:00:00.000Z"));
  const [after] = Object.values(atBoundary.state.buckets);
  assert.equal(after.closedAt, "2026-10-16T16:00:00.000Z");
  assert.equal(after.revision, beforeRevision + 1, "closure-only state changes receive their own monotonic revision");
  assert.equal(atBoundary.changedBuckets.length, 1, "the closure-only revision must be visible to the queue owner");
  assert.equal(after.onSeconds + after.offSeconds + after.unknownSeconds, 3600);
});

test("legacy closed partial bucket recovers its bounded covered span without padding to a full hour", () => {
  const legacy = initialUsageState({
    sources: {}, buckets: { "legacy": {
      osDeviceId: "device-a", osAreaId: "area-a", category: "LIGHT", controlId: "control-power",
      sourceGeneration: 2, bucketStart: "2026-10-04T10:00:00.000Z", revision: 3,
      onSeconds: 120, offSeconds: 0, unknownSeconds: 1680,
      closedAt: "2026-10-04T11:00:00.000Z", purgeAt: "2027-10-04T10:00:00.000Z",
    } },
  });
  const bucket = legacy.buckets.legacy;
  assert.equal(bucket.coverageStartAt, "2026-10-04T10:30:00.000Z");
  assert.equal(bucket.coverageEndAt, "2026-10-04T11:00:00.000Z");
  assert.equal(bucket.onSeconds + bucket.offSeconds + bucket.unknownSeconds, 1800);
});

test("out-of-order observations cannot move source coverage backward or alter newer counters", () => {
  const first = observeUsage(initialUsageState(), observed());
  assert.equal(first.changed, true, "a newly accepted observation mutates durable source accounting");
  const duplicate = observeUsage(first.state, observed());
  assert.equal(duplicate.changed, false, "an identical duplicate does not require a new durable write");
  const stale = observeUsage(first.state, observed({
    activity: "off", observedAt: "2026-10-04T10:34:00.000Z", validUntil: "2026-10-04T10:36:00.000Z",
    nowMs: Date.parse("2026-10-04T10:40:00.000Z"),
  }));
  assert.equal(stale.stale, true);
  assert.equal(stale.changed, false, "a stale sample does not mutate the durable usage cursor");
  assert.deepEqual(stale.changedBuckets, []);
  assert.deepEqual(stale.state, first.state);
});

test("invalid calendar observations and contradictory same-time values are rejected", () => {
  assert.throws(() => observeUsage(initialUsageState(), observed({ observedAt: "2026-02-31T10:00:00Z" })), /Invalid native activity/);
  const first = observeUsage(initialUsageState(), observed());
  assert.throws(() => observeUsage(first.state, observed({ activity: "off" })), /Conflicting native activity/);
});
