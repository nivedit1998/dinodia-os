const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("../src/store");
const { applyCloudConfiguration } = require("../src/sync/cloudConfiguration");

function configChecksum(value) {
  const canonical = (input) => Array.isArray(input) ? `[${input.map(canonical).join(",")}]`
    : input && typeof input === "object" ? `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`
      : JSON.stringify(input);
  return crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

// Offline history: an internet outage must not change what the Hub records; a Hub power cut and
// any time the Hub's clock cannot be trusted must stay Unknown.

const deviceId = "os-radiator-offline-history";
const areaId = "area-offline-history";

async function radiatorStore(directory, validitySeconds = 1800) {
  const store = new Store(path.join(directory, "store.json"));
  store.setSyncSourceGeneration(1);
  await store.saveIdentity({ serial: "hub-offline-history", instanceId: "instance-offline-history" });
  await store.saveArea({ name: "Room 1" }, areaId);
  const device = await store.upsertDevice({
    id: deviceId, name: "Disposable offline radiator", protocol: "zigbee", areaId,
    setup: { status: "ready", assignmentMode: "device_inherited_v1", completedAt: "2026-10-22T09:00:00.000Z" },
    state: { running_state: "idle" },
    entities: { running: { id: "running", stateKey: "running_state", state: "idle", domain: "climate",
      capability: { controlId: "control-offline-demand", kind: "enum", readable: true, writable: false, observable: true,
        semanticRole: "active_heat_demand", maxStateValiditySeconds: validitySeconds, constraints: { options: ["heat", "idle"] }, bindings: [] } } },
  });
  // The device policy arrives in the signed cloud configuration, which the Hub keeps on disk, so it
  // is still known after a restart without internet.
  const unsigned = {
    revision: 1, policyRevision: 1,
    areas: [{ id: "area-public-offline", osAreaId: areaId, originalName: "Room 1", overrideName: null, revision: 1 }],
    memberships: [], automations: [], releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
    devicePolicies: [{ osDeviceId: deviceId, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
      analyticsCategory: "RADIATOR", lifecycle: "INSTALLED", customerLabel: null, overrideName: null,
      descriptorRevision: device.presentation.descriptorRevision, descriptorDigest: "c".repeat(64), osAreaIds: [areaId] }],
  };
  await store.savePlatform({ homeId: "home-offline-history" });
  await applyCloudConfiguration(store, { ...unsigned, checksum: configChecksum(unsigned) });
  return store;
}

function reopen(directory) {
  const store = new Store(path.join(directory, "store.json"));
  store.setSyncSourceGeneration(1);
  return store;
}

const report = (store, value, at) => store.updateDeviceState(deviceId, { running_state: value }, {
  protocol: "zigbee", reportedStateKeys: ["running_state"],
  sourceObservedAtByStateKey: { running_state: at }, sourceReceivedAtByStateKey: { running_state: at }, nowMs: Date.parse(at),
});

const bucketAt = (store, hour) => Object.values(store.snapshot().syncUsage.buckets)
  .find((bucket) => bucket.osDeviceId === deviceId && bucket.bucketStart === hour);
const seconds = (bucket) => bucket && [bucket.onSeconds, bucket.offSeconds, bucket.unknownSeconds];

function withDirectory(run) {
  return async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-offline-history-"));
    try { await run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

test("an internet outage alone keeps recording On/Off in its original interval and keeps it queued across restart", withDirectory(async (directory) => {
  const store = await radiatorStore(directory);
  // No sync acknowledgement happens at all: the Platform is unreachable for the whole period.
  await report(store, "heat", "2026-10-22T10:00:00.000Z");
  await report(store, "idle", "2026-10-22T10:10:00.000Z");
  await store.advanceSyncUsage(Date.parse("2026-10-22T10:15:00.000Z"));
  assert.deepEqual(seconds(bucketAt(store, "2026-10-22T10:00:00.000Z")), [600, 300, 0]);

  const restarted = reopen(directory);
  assert.deepEqual(seconds(bucketAt(restarted, "2026-10-22T10:00:00.000Z")), [600, 300, 0]);
  const queued = restarted.getSyncOutbox().events.filter((event) => event.type === "usage.bucket").at(-1).payload;
  assert.equal(queued.bucketStart, "2026-10-22T10:00:00.000Z", "delayed history keeps its original hour, not the reconnection time");
  assert.deepEqual([queued.onSeconds, queued.offSeconds, queued.unknownSeconds], [600, 300, 0]);
}));

test("a Hub power cut is Unknown, not the device's last state carried across the gap", withDirectory(async (directory) => {
  const store = await radiatorStore(directory, 1800);
  await report(store, "heat", "2026-10-22T10:00:00.000Z");
  await store.markUsageAlive(Date.parse("2026-10-22T10:02:00.000Z"));
  // Power lost after 10:02; the heat reading would otherwise stay valid until 10:30.
  const restarted = reopen(directory);
  await restarted.advanceSyncUsage(Date.parse("2026-10-22T10:20:00.000Z"));
  assert.deepEqual(seconds(bucketAt(restarted, "2026-10-22T10:00:00.000Z")), [120, 0, 1080]);
}));

test("readings after a restart count from their own time; the power cut before them stays Unknown", withDirectory(async (directory) => {
  const store = await radiatorStore(directory, 1800);
  await report(store, "heat", "2026-10-22T10:00:00.000Z");
  await store.markUsageAlive(Date.parse("2026-10-22T10:05:00.000Z"));
  const restarted = reopen(directory);
  await report(restarted, "heat", "2026-10-22T10:15:00.000Z");
  await restarted.advanceSyncUsage(Date.parse("2026-10-22T10:20:00.000Z"));
  assert.deepEqual(seconds(bucketAt(restarted, "2026-10-22T10:00:00.000Z")), [600, 0, 600]);
}));

test("while the Hub's clock cannot be trusted no history is recorded; trusted time resumes and the untrusted span is Unknown", withDirectory(async (directory) => {
  const store = await radiatorStore(directory, 1800);
  await report(store, "heat", "2026-10-22T10:00:00.000Z");
  await store.markUsageAlive(Date.parse("2026-10-22T10:01:00.000Z"));

  const restarted = reopen(directory);
  let trusted = false;
  restarted.setUsageClockTrust(() => trusted);
  // Offline reboot without a hardware clock: these readings carry a guessed time and must not be used.
  await report(restarted, "idle", "2026-10-22T10:03:00.000Z");
  await restarted.advanceSyncUsage(Date.parse("2026-10-22T10:04:00.000Z"));
  assert.equal(bucketAt(restarted, "2026-10-22T10:00:00.000Z"), undefined, "nothing recorded while the clock is untrusted");

  trusted = true;
  await report(restarted, "idle", "2026-10-22T10:30:00.000Z");
  await restarted.advanceSyncUsage(Date.parse("2026-10-22T10:40:00.000Z"));
  assert.deepEqual(seconds(bucketAt(restarted, "2026-10-22T10:00:00.000Z")), [60, 600, 1740]);
}));

test("a clock behind the Hub's last recorded running time is never trusted", () => {
  const { usageClockTrusted } = require("../src/sync/usageBuckets");
  assert.equal(usageClockTrusted({ synchronized: true, nowMs: 1_000, aliveThroughMs: 2_000 }), false);
  assert.equal(usageClockTrusted({ synchronized: false, nowMs: 3_000, aliveThroughMs: 2_000 }), false);
  assert.equal(usageClockTrusted({ synchronized: true, nowMs: 3_000, aliveThroughMs: 2_000 }), true);
  assert.equal(usageClockTrusted({ synchronized: true, nowMs: 3_000, aliveThroughMs: null }), true);
});
