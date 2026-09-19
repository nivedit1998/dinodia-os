const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { Store } = require("../src/store");
const { AutomationService } = require("../src/automations/service");
const { AutomationExecutor } = require("../src/automations/executor");
const { AutomationScheduler } = require("../src/automations/scheduler");
const { dateParts, scheduledOccurrence } = require("../src/automations/schedule");
const { publicCatalog } = require("../src/automations/controlCatalog");
const { createBackup, decryptBackup } = require("../src/backup");
const execFileAsync = promisify(execFile);
const { createHub } = require("../src/server");

const NOW = new Date("2026-09-17T09:00:00.000Z"); // 10:00 Europe/London during BST

function fakeCatalogue() {
  return [{
    deviceId: "device-1",
    displayName: "Living room lamp",
    areaId: "living-room",
    areaDisplayName: "Living Room",
    labelId: "light",
    labelDisplayName: "Light",
    online: true,
    configured: true,
    controls: [{
      controlId: "device-1:surface:0:light::power",
      deviceId: "device-1",
      surfaceId: "device-1:surface:0:light",
      label: "Power",
      kind: "toggle",
      valueType: "boolean",
      writable: true,
      allowsAutomation: true,
      constraints: {},
      execution: { onServiceId: "light.turn_on", offServiceId: "light.turn_off", idempotency: "set_value" },
    }],
  }];
}

async function makeService(now = () => new Date(NOW)) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-automation-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const service = new AutomationService({ store, homeId: "home-1", now, getDevices: () => [], getAreas: () => [], getLabels: () => [] });
  service.internalCatalogue = () => fakeCatalogue();
  return { store, service, directory };
}

function definition(extra = {}) {
  return {
    schemaVersion: 1,
    name: "Morning lights",
    trigger: { type: "schedule", payload: { minuteOfDay: 600, weekdays: [1, 2, 3, 4, 5, 6, 7], timeZoneIdentifier: "Europe/London" } },
    actions: [{ deviceId: "device-1", controlId: "device-1:surface:0:light::power", targetValue: { type: "boolean", boolean: true } }],
    ...extra,
  };
}

test("native domain uses explicit timezone and ISO weekday semantics", () => {
  const parts = dateParts(NOW, "Europe/London");
  assert.equal(parts.localDate, "2026-09-17");
  assert.equal(parts.localTime, undefined);
  assert.equal(parts.hour, 10);
  assert.equal(parts.weekday, 4);
  const occurrence = scheduledOccurrence({ id: "automation-a", revision: 1 }, { payload: { minuteOfDay: 600, weekdays: [4], timeZoneIdentifier: "Europe/London" } }, NOW);
  assert.equal(occurrence.id, "automation-a:1:2026-09-17:10:00");
});

test("native service persists normalized rows and makes create idempotent", async () => {
  const { service, store } = await makeService();
  const first = await service.create(definition(), {}, { idempotencyKey: "request-1" });
  const second = await service.create(definition(), {}, { idempotencyKey: "request-1" });
  assert.equal(second.id, first.id);
  assert.equal(second.idempotent, true);
  assert.equal(Object.keys(store.state.automations).length, 1);
  assert.equal(Object.values(store.state.automationTriggers).length, 1);
  assert.equal(Object.values(store.state.automationActions).length, 1);
  assert.equal(first.health.state, "ready");
  assert.equal(first.actions[0].targetValue.type, "boolean");
  assert.equal(first.actions[0].targetValue.boolean, true);
});

test("native updates use revision checks and retain stable action IDs", async () => {
  const { service } = await makeService();
  const created = await service.create(definition());
  const updated = await service.update(created.id, { name: "Evening lights", enabled: false }, {}, { expectedRevision: 1 });
  assert.equal(updated.name, "Evening lights");
  assert.equal(updated.enabled, false);
  assert.equal(updated.revision, 2);
  assert.equal(updated.actions[0].id, created.actions[0].id);
  await assert.rejects(() => service.update(created.id, { name: "Lost update" }, {}, { expectedRevision: 1 }), (error) => error.code === "revision_conflict" && error.statusCode === 409);
});

test("native catalogue is public-safe and never exposes execution routes", () => {
  const value = publicCatalog(fakeCatalogue());
  assert.equal(value.devices[0].controls[0].controlId, "device-1:surface:0:light::power");
  assert.equal(value.devices[0].controls[0].execution, undefined);
});

test("scheduler claims one durable occurrence and executor preserves action order", async () => {
  const { service, store } = await makeService(() => new Date(NOW));
  const created = await service.create(definition());
  const order = [];
  const executor = new AutomationExecutor({ store, now: () => new Date(NOW), executeControl: async ({ action }) => { order.push(action.id); } });
  const scheduler = new AutomationScheduler({ store, service, executor, now: () => new Date(NOW), intervalMs: 10000, setIntervalFn: () => null, clearIntervalFn() {} });
  const first = await scheduler.tick(NOW);
  const second = await scheduler.tick(NOW);
  assert.equal(first.claimed, 1);
  assert.equal(second.claimed, 0);
  assert.deepEqual(order, [created.actions[0].id]);
  assert.equal(store.state.automationExecutions[0].status, "succeeded");
  assert.equal(store.state.automationOccurrences[`${created.id}:1:2026-09-17:10:00`].status, "succeeded");
});

test("scheduler catches a missed scheduled minute inside the grace window", async () => {
  const { service, store } = await makeService(() => new Date("2026-09-17T09:03:00.000Z"));
  const created = await service.create(definition());
  store.state.automationRuntime.lastTickAt = "2026-09-17T08:59:00.000Z";
  let calls = 0;
  const executor = new AutomationExecutor({ store, now: () => new Date("2026-09-17T09:03:00.000Z"), executeControl: async () => { calls += 1; } });
  const scheduler = new AutomationScheduler({ store, service, executor, now: () => new Date("2026-09-17T09:03:00.000Z"), intervalMs: 10000, setIntervalFn: () => null, clearIntervalFn() {} });
  const result = await scheduler.tick(new Date("2026-09-17T09:03:00.000Z"));
  assert.equal(result.claimed, 1);
  assert.equal(calls, 1);
  assert.equal(store.state.automationExecutions[0].status, "succeeded");
});

test("restart recovery marks claimed work uncertain instead of replaying it", async () => {
  const { service, store } = await makeService();
  const created = await service.create(definition());
  const occurrence = { id: `${created.id}:1:2026-09-17:10:00`, automationId: created.id, revision: 1, status: "claimed", claimedAt: NOW.toISOString(), actionOutcomes: [{ actionId: created.actions[0].id, status: "pending" }] };
  store.state.automationOccurrences[occurrence.id] = occurrence;
  const scheduler = new AutomationScheduler({ store, service, executor: {}, now: () => new Date(NOW), setIntervalFn: () => null, clearIntervalFn() {} });
  await scheduler.recover();
  assert.equal(store.state.automationOccurrences[occurrence.id].status, "interrupted");
  assert.equal(store.state.automationOccurrences[occurrence.id].actionOutcomes[0].status, "uncertain");
});

test("capability changes suspend a definition without deleting its action rows", async () => {
  const { service, store } = await makeService();
  const created = await service.create(definition());
  service.internalCatalogue = () => [];
  const projection = service.detail(created.id);
  assert.equal(projection.health.state, "needs_attention");
  assert.equal(projection.health.executable, false);
  assert.equal(store.listNativeActionsForDevice("device-1").length, 1);
});

test("duplicate creates fresh disabled rows and idempotency rejects a changed payload", async () => {
  const { service, store } = await makeService();
  const created = await service.create(definition(), {}, { idempotencyKey: "same-key" });
  const duplicate = await service.duplicate(created.id);
  assert.notEqual(duplicate.id, created.id);
  assert.equal(duplicate.enabled, false);
  assert.notEqual(duplicate.actions[0].id, created.actions[0].id);
  await assert.rejects(() => service.create({ ...definition(), name: "Different" }, {}, { idempotencyKey: "same-key" }), (error) => error.code === "idempotency_conflict" && error.statusCode === 409);
  assert.equal(store.listNativeAutomations().length, 2);
});

test("encrypted backup contains native definitions and execution history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-backup-"));
  const dataFile = path.join(directory, "dinodia.json");
  const store = new Store(dataFile);
  const service = new AutomationService({ store, homeId: "home-1", now: () => new Date(NOW), getDevices: () => [], getAreas: () => [], getLabels: () => [] });
  service.internalCatalogue = () => fakeCatalogue();
  await service.create(definition());
  const backupPath = await createBackup({ dataFile, backupDir: path.join(directory, "backups"), keyFile: path.join(directory, "machine.key"), vaultFile: path.join(directory, "vault.json") });
  const envelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const snapshot = decryptBackup(envelope, await fs.readFile(path.join(directory, "machine.key")));
  assert.equal(snapshot.data.version, 10);
  assert.equal(Object.keys(snapshot.data.automations).length, 1);
  assert.equal(Object.keys(snapshot.data.automationTriggers).length, 1);
  assert.equal(Object.keys(snapshot.data.automationActions).length, 1);
  await fs.writeFile(dataFile, JSON.stringify({ version: 3, devices: {} }));
  await execFileAsync(process.execPath, [path.join(__dirname, "../scripts/restore.js"), backupPath, "--confirm"], { cwd: path.join(__dirname, ".."), env: { ...process.env, DINODIA_DATA_DIR: directory } });
  const restored = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(restored.version, 10);
  assert.equal(Object.keys(restored.automations).length, 1);
  assert.equal(Object.keys(restored.automationActions).length, 1);
});

test("v9 automation data is retained losslessly on the legacy path during store migration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-migration-"));
  const file = path.join(directory, "dinodia.json");
  const legacy = { id: "legacy-rule", name: "Old state rule", trigger: { deviceId: "device-1", field: "power", equals: "ON" }, actions: [{ deviceId: "device-1", command: { state: { power: "ON" } } }] };
  await fs.writeFile(file, JSON.stringify({ version: 9, automations: { "legacy-rule": legacy } }));
  const store = new Store(file);
  assert.equal(store.state.version, 10);
  assert.deepEqual(store.getAutomation("legacy-rule"), legacy);
  assert.equal(store.listNativeAutomations().length, 0);
  assert.equal(store.state.nativeAutomationMigration.legacy, 1);
  const reloaded = new Store(file);
  assert.deepEqual(reloaded.getAutomation("legacy-rule"), legacy);
});

test("native admin API exposes catalogue, CRUD, revision conflicts, and execution history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-api-"));
  const quietIntegration = { start() {}, close() {}, status() { return { configured: false, connected: false }; }, async command() {} };
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "native-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "../public"), otbrUrl: "" },
    mqttBridge: quietIntegration,
    matterBridge: quietIntegration,
    cloudflareTunnel: { status() { return { configured: false, connected: false }; }, start() {}, async stop() {} },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  hub.nativeAutomationService.internalCatalogue = () => fakeCatalogue();
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { authorization: "Bearer native-token", "content-type": "application/json" };
  try {
    const unauthorized = await fetch(`${base}/_dinodia/admin/api/automations/catalog`);
    assert.equal(unauthorized.status, 401);
    const catalogue = await fetch(`${base}/_dinodia/admin/api/automations/catalog`, { headers }).then((response) => response.json());
    assert.equal(catalogue.devices[0].controls[0].execution, undefined);
    const createResponse = await fetch(`${base}/_dinodia/admin/api/automations`, { method: "POST", headers: { ...headers, "idempotency-key": "api-create-1" }, body: JSON.stringify(definition()) });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const detail = await fetch(`${base}/_dinodia/admin/api/automations/${encodeURIComponent(created.id)}`, { headers }).then((response) => response.json());
    assert.equal(detail.actions.length, 1);
    const updateResponse = await fetch(`${base}/_dinodia/admin/api/automations/${encodeURIComponent(created.id)}`, { method: "PUT", headers, body: JSON.stringify({ name: "updated", expectedRevision: 1 }) });
    assert.equal(updateResponse.status, 200);
    const conflict = await fetch(`${base}/_dinodia/admin/api/automations/${encodeURIComponent(created.id)}`, { method: "PUT", headers, body: JSON.stringify({ name: "stale", expectedRevision: 1 }) });
    assert.equal(conflict.status, 409);
    const history = await fetch(`${base}/_dinodia/admin/api/automations/${encodeURIComponent(created.id)}/executions`, { headers }).then((response) => response.json());
    assert.deepEqual(history.executions, []);
    const deleted = await fetch(`${base}/_dinodia/admin/api/automations/${encodeURIComponent(created.id)}`, { method: "DELETE", headers, body: JSON.stringify({ expectedRevision: 2 }) });
    assert.equal(deleted.status, 204);
  } finally {
    await hub.stop();
  }
});
