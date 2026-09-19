const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");
const { normalizeRaw } = require("../src/integrations/googleNest/deviceNormalizer");

function mockIntegration() { return { start() {}, close() {}, status() { return { configured: false, connected: false }; }, async command() {}, async refresh() {} }; }
function mockCloudflare() { return { start() {}, async stop() {}, status() { return { configured: false, connected: false, hostname: "" }; } }; }

test("Configured Google Nest thermostat uses the existing Boiler climate contract", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-google-nest-projection-"));
  const hub = createHub({ config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" }, mqttBridge: mockIntegration(), matterBridge: mockIntegration(), cloudflareTunnel: mockCloudflare(), platformSync: { start() {}, stop() {}, status() { return { configured: false }; } } });
  const area = await hub.store.saveArea({ name: "Living room" }, "living-room");
  const device = normalizeRaw(JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "google-nest", "thermostat-heating.json"), "utf8")), { machineKey: hub.vault.key, accountFingerprint: "hmac-sha256:acct" }).devices[0];
  await hub.store.upsertDevice(device);
  assert.equal(hub.model.states().some((item) => item.entity_id.startsWith("climate.")), false);
  await hub.store.completeDeviceSetup(device.id, { name: "Living room boiler", areaId: area.id, labelId: "boiler" });
  const climate = hub.model.states().find((item) => item.entity_id.startsWith("climate."));
  assert.ok(climate);
  assert.equal(climate.attributes.current_temperature, 20.3);
  assert.equal(climate.attributes.temperature, 21);
  assert.equal(climate.attributes.hvac_mode, "heat");
  assert.deepEqual(climate.attributes.hvac_modes, ["off", "heat"]);
  assert.equal(climate.attributes.hvac_action, "heating");
  assert.equal(climate.attributes.area_id, area.id);
  assert.equal(hub.model.entityRegistry().some((item) => item.platform === "google_nest" && item.area_id === area.id), true);
  assert.equal(hub.model.states().some((item) => item.entity_id.startsWith("sensor.")), false, "diagnostics remain outside household states");
  await hub.stop();
});
