const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PlatformPairing } = require("../src/platformPairing");

function pairingWith({ events = [], ack = 10, lastSuccessAgoMs = 5000, incidents = 0, endpoint = false } = {}) {
  const pairing = Object.create(PlatformPairing.prototype);
  const now = Date.parse("2026-10-19T21:00:00.000Z");
  pairing.clock = () => now;
  pairing.lastSuccess = lastSuccessAgoMs == null ? null : new Date(now - lastSuccessAgoMs).toISOString();
  pairing.pendingEndpointHeartbeat = endpoint;
  pairing.store = {
    getSyncOutbox: () => ({ acknowledgedSequence: ack, events }),
    listPendingIncidentEnvelopes: () => Array.from({ length: incidents }),
  };
  pairing.calls = 0;
  pairing.syncNow = async () => { pairing.calls += 1; return {}; };
  return pairing;
}

test("an idle hub with only routine telemetry queued does not call Platform", async () => {
  const pairing = pairingWith({ events: [{ sequence: 11, type: "usage.bucket" }, { sequence: 12, type: "temperature.sample" }, { sequence: 13, type: "analytics.day" }] });
  await pairing.scheduledSync();
  assert.equal(pairing.calls, 0);
});

test("an urgent event wakes the scheduled sync immediately", async () => {
  for (const type of ["device.upsert", "area.upsert", "control.catalog.upsert", "automation.outcome", "incident.transition", "update.status", "analytics.daily.barrier"]) {
    const pairing = pairingWith({ events: [{ sequence: 11, type }] });
    await pairing.scheduledSync();
    assert.equal(pairing.calls, 1, type);
  }
});

test("the idle cadence still syncs routine telemetry once four minutes have passed, and not before", async () => {
  const early = pairingWith({ events: [{ sequence: 11, type: "usage.bucket" }], lastSuccessAgoMs: 200000 });
  await early.scheduledSync();
  assert.equal(early.calls, 0, "three minutes of quiet telemetry never wakes the hub");
  const pairing = pairingWith({ events: [{ sequence: 11, type: "usage.bucket" }], lastSuccessAgoMs: 241000 });
  await pairing.scheduledSync();
  assert.equal(pairing.calls, 1);
});

test("a device.upsert that only moves the last-seen time is routine; any real change still wakes the hub", async () => {
  const shape = { osDeviceId: "d1", name: "Radiator", areaId: "a1", protocol: "zigbee", descriptorRevision: 3, descriptorDigest: "x", available: true };
  const sent = { aggregateId: "d1", payload: { ...shape, observedAt: "2026-10-19T20:00:00.000Z" } };
  const only = pairingWith({ events: [{ sequence: 11, type: "device.upsert", aggregateId: "d1", payload: { ...shape, observedAt: "2026-10-19T20:59:00.000Z" } }] });
  only.lastSentUpsertShape = new Map([["d1", JSON.stringify(shape)]]);
  await only.scheduledSync();
  assert.equal(only.calls, 0, "last seen alone is not news");
  for (const change of [{ available: false }, { name: "Renamed" }, { descriptorRevision: 4 }, { areaId: "a2" }]) {
    const real = pairingWith({ events: [{ sequence: 11, type: "device.upsert", aggregateId: "d1", payload: { ...shape, ...change, observedAt: "2026-10-19T20:59:00.000Z" } }] });
    real.lastSentUpsertShape = new Map([["d1", JSON.stringify(shape)]]);
    await real.scheduledSync();
    assert.equal(real.calls, 1, JSON.stringify(change));
  }
  const fresh = pairingWith({ events: [{ sequence: 11, type: "device.upsert", aggregateId: "d1", payload: sent.payload }] });
  fresh.lastSentUpsertShape = new Map();
  await fresh.scheduledSync();
  assert.equal(fresh.calls, 1, "the first upsert after a restart is always sent");
});

test("pending incidents, endpoint reports or no prior success always sync", async () => {
  for (const options of [{ incidents: 1 }, { endpoint: true }, { lastSuccessAgoMs: null }]) {
    const pairing = pairingWith(options);
    await pairing.scheduledSync();
    assert.equal(pairing.calls, 1, JSON.stringify(options));
  }
});

test("only urgent events trigger the immediate follow-up after a successful sync", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/platformPairing.js"), "utf8");
  assert.match(source, /const ROUTINE_SYNC_EVENT_TYPES = new Set\(\["usage\.bucket", "temperature\.sample", "analytics\.day"\]\)/);
  assert.match(source, /\(nextUrgent && installationSyncMode === "ACTIVE"\)/);
  assert.match(source, /setInterval\(\(\) => this\.scheduledSync\(\)/);
});
