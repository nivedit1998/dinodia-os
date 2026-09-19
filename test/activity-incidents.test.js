const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { ActivityService, sanitize, friendlyEventCopy } = require("../src/activity/activityService");

function clock(value) {
  let current = new Date(value);
  return {
    now: () => new Date(current),
    advance: (milliseconds) => { current = new Date(current.getTime() + milliseconds); },
  };
}

test("incident copy uses plain language and names the affected service", () => {
  const copy = friendlyEventCopy("integration_offline", {
    integration: "matter",
    incident: {
      firstObservedAt: "2026-09-04T10:00:00.000Z",
      lastObservedAt: "2026-09-04T10:30:00.000Z",
    },
  });
  assert.equal(copy.summary, "Matter services have been offline for over 30 minutes");
  assert.match(copy.detail, /service has not recovered/);

  const deviceCopy = friendlyEventCopy("device_offline_incident", {
    incident: {
      firstObservedAt: "2026-09-04T10:00:00.000Z",
      lastObservedAt: "2026-09-04T11:15:00.000Z",
    },
  }, { name: "Radiator upstairs", protocol: "matter" });
  assert.equal(deviceCopy.summary, "Radiator upstairs has been offline for over 1 hour 15 minutes");
  assert.match(deviceCopy.detail, /Check that it has power/);
});

test("integration outages escalate as one parent incident, not as device incidents", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-parent-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const time = clock("2026-09-04T10:00:00.000Z");
  const activity = new ActivityService({ store, now: time.now, startupWarmupMs: 0, incidentThresholds: { integration: 1000 }, eventBus: { emit() {} } });

  await activity.observeIntegration("zigbee2mqtt", false);
  await activity.sweep();
  time.advance(1001);
  await activity.sweep();

  const records = store.listActivity({}).records;
  assert.equal(records.some((record) => record.type === "integration_offline" && record.severity === "critical"), true);
  assert.equal(records.some((record) => record.type === "device_offline_incident"), false);
  assert.equal(store.listPendingIncidentEnvelopes().at(-1).envelope.kind, "integration_offline");
});

test("offline outages stay local until the one-hour incident threshold", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-one-hour-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const time = clock("2026-09-04T10:00:00.000Z");
  const activity = new ActivityService({ store, now: time.now, startupWarmupMs: 0, eventBus: { emit() {} } });

  await activity.observeIntegration("matter", false);
  time.advance((60 * 60 * 1000) - 1);
  await activity.sweep();
  assert.equal(store.listPendingIncidentEnvelopes().length, 0);
  assert.equal(store.getActiveIncident("integration_offline:matter").state, "watching");

  time.advance(1);
  await activity.sweep();
  assert.equal(store.listPendingIncidentEnvelopes().length, 1);
  assert.equal(store.listPendingIncidentEnvelopes()[0].envelope.state, "open");
  assert.equal(store.listPendingIncidentEnvelopes()[0].envelope.severity, "critical");
});

test("legacy premature open outages are closed and re-timed without losing the incident identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-threshold-migration-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const time = clock("2026-09-04T10:00:00.000Z");
  await store.saveActiveIncident("integration_offline:google_nest", {
    incidentId: "integration_offline:google_nest",
    kind: "integration_offline",
    state: "open",
    revision: 1,
    firstObservedAt: "2026-09-04T09:58:00.000Z",
    lastObservedAt: "2026-09-04T10:00:00.000Z",
    criticalAt: "2026-09-04T10:00:00.000Z",
    openedAt: "2026-09-04T09:59:00.000Z",
    integration: "google_nest",
  });
  const activity = new ActivityService({ store, now: time.now, startupWarmupMs: 0, eventBus: { emit() {} } });

  await activity.sweep();
  const active = store.getActiveIncident("integration_offline:google_nest");
  assert.equal(active.state, "watching");
  assert.equal(active.revision, 0);
  assert.equal(active.criticalAt, "2026-09-04T10:58:00.000Z");
  const resolved = store.listPendingIncidentEnvelopes().map((entry) => entry.envelope).find((envelope) => envelope.state === "resolved");
  assert.equal(resolved.incidentId, "integration_offline:google_nest");
  assert.equal(resolved.severity, "critical");
  assert.equal(resolved.details.reason, "below_one_hour_threshold");
});

test("active offline timers survive a service restart without resetting their deadline", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-restart-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const time = clock("2026-09-04T10:00:00.000Z");
  const first = new ActivityService({ store, now: time.now, startupWarmupMs: 0, incidentThresholds: { mains: 5000 }, eventBus: { emit() {} } });
  const device = await store.upsertDevice({ id: "restart-device", name: "Restart device", protocol: "zigbee", available: false });
  await first.observeUnavailable(device);

  time.advance(4000);
  const afterRestart = new ActivityService({ store, now: time.now, startupWarmupMs: 0, incidentThresholds: { mains: 5000 }, eventBus: { emit() {} } });
  await afterRestart.sweep();
  assert.equal(store.listPendingIncidentEnvelopes().length, 0);

  time.advance(1001);
  await afterRestart.sweep();
  assert.equal(store.listPendingIncidentEnvelopes().length, 1);
  assert.equal(store.listPendingIncidentEnvelopes()[0].envelope.incidentId, "device_offline:restart-device");
});

test("activity sanitization removes secret-like keys and bounds nested payloads", () => {
  const safe = sanitize({ token: "do-not-store", nested: { password: "also-secret", value: "ok" }, values: Array.from({ length: 50 }, (_, index) => index) });
  assert.equal(Object.hasOwn(safe, "token"), false);
  assert.equal(Object.hasOwn(safe.nested, "password"), false);
  assert.equal(safe.nested.value, "ok");
  assert.equal(safe.values.length, 30);
});

test("only critical activity is eligible for the incident outbox", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-reporting-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const activity = new ActivityService({ store, eventBus: { emit() {} } });
  await activity.record({ type: "device_unavailable", device: { id: "warning-device", name: "Warning device", protocol: "zigbee" }, reportable: true, incident: { incidentId: "warning-device", kind: "device_offline", state: "open" } });
  assert.equal(store.listPendingIncidentEnvelopes().length, 0);
});
