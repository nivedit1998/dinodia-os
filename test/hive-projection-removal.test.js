const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");
const { normalizeHiveDevices } = require("../src/integrations/hive/deviceNormalizer");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() { return []; } };
}

test("a Hive zone projects to standard climate controls and removes cleanly", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-hive-projection-"));
  const hiveState = { enabled: true, configured: true, status: "connected", ignoredDeviceIds: [], ignoredDeviceSummaries: [] };
  const hive = {
    status: () => ({ ...hiveState, ignoredDeviceIds: [...hiveState.ignoredDeviceIds] }),
    start() {},
    async close() {},
    async command() {},
    async ignoreDevice(device) { hiveState.ignoredDeviceIds.push(device.protocolIdentity.cloudId); return { cloudId: device.protocolIdentity.cloudId }; },
  };
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    hiveBridge: hive,
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  const area = await hub.store.saveArea({ name: "Downstairs" }, "downstairs");
  const device = normalizeHiveDevices({ accountId: "account-1", devices: [{ cloudId: "zone-1", kind: "thermostat", haName: "Downstairs", model: "V4", online: true, state: { mode: "SCHEDULE", currentTemperature: 19, targetTemperature: 21, action: false, minTemperature: 5, maxTemperature: 32 } }] }, { machineKey: hub.vault.key }).devices[0];
  await hub.store.upsertDevice(device);
  await hub.store.completeDeviceSetup(device.id, { name: "Downstairs heating", areaId: area.id, labelId: "boiler" });
  const surfaces = hub.model.entities().filter((item) => item.device.id === device.id);
  assert.equal(surfaces.some((item) => item.domain === "climate"), true);
  assert.equal(surfaces.length, 1, "heating mode and setpoint are one climate surface");
  const registryDevice = hub.model.deviceRegistry()[0];
  assert.equal(registryDevice.area_id, area.id);
  assert.deepEqual(registryDevice.labels, ["boiler"]);
  const state = hub.model.states().find((item) => item.entity_id.startsWith("climate."));
  assert.equal(state.attributes.temperature, 21);
  assert.equal(state.attributes.area_id, area.id);

  hub.store.state.states[device.id] = { state: "stale" };
  await hub.store.saveAutomation({ id: "hive-automation", name: "Hive automation", trigger: { deviceId: device.id, field: "mode", equals: "auto" }, actions: [{ deviceId: device.id, command: { mode: "OFF" } }] });
  const removed = await hub.model.removeDevice({ device_id: device.id });
  assert.equal(removed, true);
  assert.equal(hub.store.getDevice(device.id), null);
  assert.equal(hub.model.entities().some((item) => item.device.id === device.id), false);
  assert.equal(hub.store.state.states[device.id], undefined);
  assert.equal(hub.store.getAutomation("hive-automation"), null);
  assert.deepEqual(hiveState.ignoredDeviceIds, ["zone-1"]);
  await hub.stop();
});

test("disconnect clears every local Hive projection but preserves unrelated hub data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-hive-clear-"));
  const { Store } = require("../src/store");
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveConfigEntry({ entry_id: "ce_hive", domain: "hive", title: "Hive" });
  await store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
  await store.upsertDevice({ id: "hive:zone-1", name: "Downstairs", protocol: "hive", state: { mode: "auto" }, entities: { "hive:zone-1:mode": { id: "hive:zone-1:mode", state: "auto" } } });
  await store.upsertDevice({ id: "zigbee:lamp", name: "Lamp", protocol: "zigbee", state: { state: "ON" } });
  store.state.states["hive:zone-1:mode"] = { state: "auto" };
  await store.persist();
  await store.clearHive();
  assert.equal(store.getDevice("hive:zone-1"), null);
  assert.equal(store.getDevice("zigbee:lamp").name, "Lamp");
  assert.equal(store.getConfigEntries().ce_hive, undefined);
  assert.ok(store.getConfigEntries().ce_zigbee);
  assert.equal(store.getHive().configured, false);
  assert.equal(store.getHive().ignoredDeviceIds.length, 0);
});
