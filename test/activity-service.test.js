const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { ActivityService } = require("../src/activity/activityService");

test("activity ledger records configuration changes and persistent offline recovery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const area = await store.saveArea({ name: "Utility room" }, "utility");
  await store.saveLabel({ name: "Radiator" }, "radiator");
  const original = await store.upsertDevice({ id: "radiator-1", name: "Radiator upstairs", protocol: "zigbee", areaId: area.id, labelIds: ["radiator"], labels: ["radiator"], state: { power: "OFF", temperature: 19 }, available: true, metadata: { manufacturer: "SONOFF", model: "TRVZB" } });
  let currentTime = new Date("2026-09-04T10:00:00.000Z");
  const activity = new ActivityService({ store, now: () => new Date(currentTime), startupWarmupMs: 0, incidentThresholds: { mains: 1000, battery: 1000 }, eventBus: { emit() {} } });

  await activity.recordDeviceChanged(original, null);
  const unavailable = await store.updateDeviceState(original.id, {}, { available: false });
  await activity.recordDeviceChanged(unavailable, original);
  assert.equal(store.getActiveIncident("device_offline:radiator-1").state, "watching");
  assert.equal(store.listActivity({ deviceId: "radiator-1" }).records.some((record) => record.type === "device_unavailable" && record.severity === "warning"), true);

  currentTime = new Date(currentTime.getTime() + 1001);
  await activity.sweep();
  const critical = store.listActivity({ deviceId: "radiator-1" }).records.find((record) => record.type === "device_offline_incident");
  assert.equal(critical.severity, "critical");
  assert.equal(store.listPendingIncidentEnvelopes().length, 1);

  const recovered = await store.updateDeviceState(original.id, {}, { available: true });
  await activity.recordDeviceChanged(recovered, unavailable);
  const records = store.listActivity({ deviceId: "radiator-1" }).records;
  assert.equal(records.some((record) => record.type === "device_recovered"), false);
  currentTime = new Date(currentTime.getTime() + 120001);
  await activity.sweep();
  assert.equal(store.listActivity({ deviceId: "radiator-1" }).records.some((record) => record.type === "device_recovered" && record.statusLabel === "success"), true);
  assert.equal(store.getActiveIncident("device_offline:radiator-1"), null);
  assert.equal(store.listPendingIncidentEnvelopes().length, 2);
  assert.equal(new Set(store.listPendingIncidentEnvelopes().map((entry) => entry.envelope.state)).size, 2);
  const filtered = store.listActivity({ deviceId: "radiator-1", severity: "critical" });
  assert.equal(filtered.records.every((record) => record.severity === "critical"), true);
  await store.acknowledgeIncidentEnvelopes(store.listPendingIncidentEnvelopes().map((entry) => entry.id));
  assert.equal(store.listPendingIncidentEnvelopes().length, 0);
});

test("offline incident recovery is stable and flapping keeps one incident identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-flap-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  let currentTime = new Date("2026-09-04T10:00:00.000Z");
  const activity = new ActivityService({ store, now: () => new Date(currentTime), startupWarmupMs: 0, recoveryStableMs: 2000, incidentThresholds: { mains: 1000 }, eventBus: { emit() {} } });
  const device = await store.upsertDevice({ id: "flap", name: "Flapping device", protocol: "zigbee", state: { power: "OFF" }, available: true });
  const offline = await store.updateDeviceState(device.id, {}, { available: false });
  await activity.recordDeviceChanged(offline, device);
  currentTime = new Date(currentTime.getTime() + 1001);
  await activity.sweep();
  const opened = store.listPendingIncidentEnvelopes()[0].envelope;
  const online = await store.updateDeviceState(device.id, {}, { available: true });
  await activity.recordDeviceChanged(online, offline);
  currentTime = new Date(currentTime.getTime() + 1000);
  await activity.sweep();
  assert.equal(store.getActiveIncident("device_offline:flap").state, "recovering");
  const flappedOffline = await store.updateDeviceState(device.id, {}, { available: false });
  await activity.recordDeviceChanged(flappedOffline, online);
  assert.equal(store.getActiveIncident("device_offline:flap").state, "open");
  assert.equal(store.listPendingIncidentEnvelopes().filter((entry) => entry.envelope.incidentId === opened.incidentId).length, 1);
  currentTime = new Date(currentTime.getTime() + 2001);
  const onlineAgain = await store.updateDeviceState(device.id, {}, { available: true });
  await activity.recordDeviceChanged(onlineAgain, flappedOffline);
  currentTime = new Date(currentTime.getTime() + 2001);
  await activity.sweep();
  const revisions = store.listPendingIncidentEnvelopes().filter((entry) => entry.envelope.incidentId === opened.incidentId);
  assert.equal(revisions.length, 2);
  assert.equal(new Set(revisions.map((entry) => entry.envelope.incidentId)).size, 1);
  assert.equal(revisions.find((entry) => entry.envelope.state === "resolved").envelope.revision > opened.revision, true);
});

test("battery thresholds create one warning and one reportable critical incident", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-battery-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const activity = new ActivityService({ store, startupWarmupMs: 0, eventBus: { emit() {} } });
  const device = await store.upsertDevice({ id: "battery-device", name: "Battery device", protocol: "zigbee", battery: 80, metadata: { power_source: "Battery" }, available: true });
  await activity.recordDeviceChanged(await store.updateDeviceState(device.id, {}, { battery: 20 }), device);
  const lowBattery = await store.getDevice(device.id);
  const criticalBattery = await store.updateDeviceState(device.id, {}, { battery: 10 });
  await activity.recordDeviceChanged(criticalBattery, lowBattery);
  assert.equal(store.listActivity({ deviceId: device.id }).records.filter((record) => record.type === "battery_low").length, 1);
  assert.equal(store.listActivity({ deviceId: device.id }).records.filter((record) => record.type === "battery_critical").length, 1);
  assert.equal(store.listPendingIncidentEnvelopes().length, 1);
  const critical = await store.getDevice(device.id);
  await activity.recordDeviceChanged(await store.updateDeviceState(device.id, {}, { battery: 30 }), critical);
  assert.equal(store.listPendingIncidentEnvelopes().filter((entry) => entry.envelope.state === "resolved").length, 1);
});

test("material state activity coalesces rapid slider-like updates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-coalesce-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const activity = new ActivityService({ store, eventBus: { emit() {} } });
  await activity.record({ type: "device_state_changed", device: { id: "slider", name: "Slider", protocol: "zigbee" }, summary: "Setpoint changed", change: { after: 20 }, dedupeKey: "state:slider", coalesceKey: "state:slider" });
  await activity.record({ type: "device_state_changed", device: { id: "slider", name: "Slider", protocol: "zigbee" }, summary: "Setpoint changed", change: { after: 21 }, dedupeKey: "state:slider", coalesceKey: "state:slider" });
  const records = store.listActivity({ deviceId: "slider" }).records.filter((record) => record.type === "device_state_changed");
  assert.equal(records.length, 1);
  assert.equal(records[0].occurrences, 2);
  assert.equal(records[0].change.after, 21);
});

test("reportable activity and its outbox entry roll back together on a storage failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-atomic-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const activity = new ActivityService({ store, eventBus: { emit() {} } });
  const before = store.snapshot();
  store.persist = async () => { throw new Error("disk full"); };
  await assert.rejects(() => activity.record({ type: "device_offline_incident", device: { id: "atomic", name: "Atomic", protocol: "zigbee" }, reportable: true, incident: { incidentId: "device_offline:atomic", kind: "device_offline", state: "open", revision: 1 } }), /disk full/);
  assert.deepEqual(store.snapshot().activity, before.activity);
  assert.deepEqual(store.snapshot().incidentOutbox, before.incidentOutbox);
});

test("activity ledger uses stable cursors and bounded retention", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-page-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  for (let index = 0; index < 2050; index += 1) await store.appendActivity({ type: "system_test", summary: `Event ${index}`, occurredAt: new Date(Date.now() + index).toISOString() });
  const first = store.listActivity({ limit: 50 });
  assert.equal(first.records.length, 50);
  assert.equal(first.hasMore, true);
  const second = store.listActivity({ limit: 50, before: first.nextCursor });
  assert.equal(second.records.length, 50);
  assert.equal(first.records[0].sequence > second.records[0].sequence, true);
  assert.equal(store.getActivityState().records.length, 2000);
});

test("activity ledger keeps exactly four calendar months and deletes older or undated records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-retention-"));
  const file = path.join(directory, "dinodia.json");
  const now = new Date("2026-09-04T12:00:00.000Z");
  await fs.writeFile(file, JSON.stringify({ version: 6, activity: { records: [
    { id: "boundary", sequence: 1, type: "system_test", occurredAt: "2026-05-04T12:00:00.000Z" },
    { id: "old", sequence: 2, type: "system_test", occurredAt: "2026-05-04T11:59:59.999Z" },
    { id: "undated", sequence: 3, type: "system_test", occurredAt: "not-a-date" },
  ] } }));
  const store = new Store(file);
  await store.pruneActivity(now);

  assert.equal(store.getActivityState().retentionMonths, 4);
  assert.deepEqual(store.getActivityState().records.map((record) => record.id), ["boundary"]);
  assert.equal(store.listActivity({}).records.every((record) => record.id === "boundary"), true);
});

test("activity retention is normalized to four months for existing stores", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-retention-migration-"));
  const file = path.join(directory, "dinodia.json");
  await fs.writeFile(file, JSON.stringify({ version: 6, activity: { retentionDays: 30, records: [] } }));
  const store = new Store(file);
  const activity = store.getActivityState();
  assert.equal(activity.retentionMonths, 4);
  assert.equal(Object.hasOwn(activity, "retentionDays"), false);
});
