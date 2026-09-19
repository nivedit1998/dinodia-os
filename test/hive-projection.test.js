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

test("Hive heating projection matches the existing HA-compatible Boiler contract", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-hive-contract-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    hiveBridge: { status: () => ({ enabled: true, configured: false, status: "disconnected" }), start() {}, async close() {}, async command() {}, async ignoreDevice() {} },
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  const area = await hub.store.saveArea({ name: "Living room" }, "living-room");
  const device = normalizeHiveDevices(JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "hive", "heating-hot-water-account.json"), "utf8")), { machineKey: hub.vault.key }).devices[0];
  await hub.store.upsertDevice(device);
  assert.equal(hub.model.states().some((state) => state.entity_id.includes("target_temperature")), false, "unassigned Hive zones are not published");
  await hub.store.completeDeviceSetup(device.id, { name: "Living room boiler", areaId: area.id, labelId: "boiler" });
  const states = hub.model.states().filter((state) => state.entity_id.includes(device.id.replaceAll(":", "_")) || state.attributes.device_id === device.id);
  const climate = hub.model.states().find((state) => state.entity_id.startsWith("climate."));
  assert.ok(climate);
  assert.equal(climate.attributes.current_temperature, 20);
  assert.equal(climate.attributes.temperature, 21);
  assert.equal(climate.attributes.area_id, area.id);
  assert.deepEqual(hub.model.deviceRegistry()[0].labels, ["boiler"]);
  assert.equal(states.some((state) => state.attributes.friendly_name === "Current temperature"), false, "diagnostics are not household surfaces");
  assert.equal(hub.model.entityRegistry().some((entity) => entity.platform === "hive" && entity.area_id === area.id), true);
  assert.equal(hub.model.states().some((state) => state.entity_id.startsWith("water_heater.")), false);
  await hub.stop();
});
