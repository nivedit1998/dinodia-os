const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");

function mockIntegration() {
  return {
    start() {},
    close() {},
    status() { return { configured: false, connected: false, lastError: null }; },
    async command() {},
    async refresh() { return []; },
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", connection: "close", authorization: "Bearer test-token", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function virtualize(device, id) {
  const replaceId = (value) => {
    const text = String(value || "");
    return text === device.id ? id : text.startsWith(`${device.id}:`) ? `${id}${text.slice(device.id.length)}` : value;
  };
  return {
    ...device,
    id,
    protocol: "virtual",
    name: "Test Radiator (simulated)",
    metadata: { ...(device.metadata || {}), friendly_name: id, ieee_address: "fixture-test-radiator-001", test_simulated: true },
    protocolIdentity: { legacyId: id },
    entities: Object.fromEntries(Object.entries(device.entities || {}).map(([key, entity]) => [replaceId(key), { ...entity, id: replaceId(entity.id), sourceId: replaceId(entity.sourceId), deviceId: id }])),
    available: true,
  };
}

test("device setup API returns separated controls and commits one device-level assignment", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-device-setup-api-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  const area = await hub.store.saveArea({ name: "Kitchen" }, "kitchen");
  const device = normalizeZigbeeDevice({ friendly_name: "Kitchen switch", ieee_address: "0xabc", definition: { exposes: [{ type: "switch", features: [{ type: "binary", property: "state", access: 7 }, { type: "numeric", property: "voltage", access: 1 }] }] } });
  await hub.store.upsertDevice(device);
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;

  const before = await request(base, `/_dinodia/admin/api/devices/${encodeURIComponent(device.id)}/capabilities`);
  assert.equal(before.response.status, 200);
  assert.equal(before.body.setup.status, "needs_setup");
  assert.deepEqual(before.body.controlsShownInApps, []);
  assert.equal(before.body.statusAndDiagnostics.length, 2);

  const rejected = await request(base, `/_dinodia/admin/api/devices/${encodeURIComponent(device.id)}/setup`, { method: "PUT", body: JSON.stringify({ areaId: area.id, labelId: "light", entities: { "not-allowed": { areaId: area.id } } }) });
  assert.equal(rejected.response.status, 400);

  const saved = await request(base, `/_dinodia/admin/api/devices/${encodeURIComponent(device.id)}/setup`, { method: "PUT", body: JSON.stringify({ name: "Kitchen lights", areaId: area.id, labelId: "light" }) });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.setup.status, "ready");
  assert.equal(saved.body.device.name, "Kitchen lights");
  assert.equal(saved.body.surfacePreview.surfaces.length, 1);
  // The selected label is presentation-only; the adapter declares this as a switch.
  assert.equal(saved.body.surfacePreview.surfaces[0].domain, "switch");

  const capabilities = await request(base, `/_dinodia/admin/api/devices/${encodeURIComponent(device.id)}/capabilities`);
  assert.equal(capabilities.body.controlsShownInApps.length, 1);
  assert.equal(capabilities.body.statusAndDiagnostics.length, 1);
  assert.equal(capabilities.body.statusAndDiagnostics[0].name, "Voltage");
  assert.equal(capabilities.body.presentation.status, "ready");

  const cleared = await request(base, `/_dinodia/admin/api/devices/${encodeURIComponent(device.id)}/setup`, { method: "PUT", body: JSON.stringify({ areaId: area.id, labelId: "not-approved" }) });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.surfacePreview.surfaces[0].domain, "switch");
  await hub.stop();
});

test("virtual radiator exercises the same public climate controls as a live device", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-device-setup-simulator-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  const area = await hub.store.saveArea({ name: "Bedroom" }, "bedroom");
  const fixturePath = path.join(__dirname, "fixtures", "zigbee", "radiator-device.json");
  const device = virtualize(normalizeZigbeeDevice(JSON.parse(await fs.readFile(fixturePath, "utf8"))), "test-radiator-simulated");
  await hub.store.upsertDevice(device);
  await hub.store.completeDeviceSetup(device.id, { areaId: area.id, labelId: "radiator" });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const before = await request(base, "/_dinodia/admin/api/devices");
  assert.equal(before.response.status, 200);
  const surface = hub.model.entities().find((item) => item.device.id === "test-radiator-simulated" && item.domain === "climate");
  assert.ok(surface);
  assert.equal(surface.haId.split(".")[0], "climate");
  const entityRoute = `/_dinodia/admin/api/entities/${encodeURIComponent(surface.haId)}/service`;
  const temperature = await request(base, entityRoute, { method: "POST", body: JSON.stringify({ serviceId: "climate.set_temperature", data: { temperature: 21 } }) });
  assert.equal(temperature.response.status, 200);
  const afterTemperature = hub.store.getDevice("test-radiator-simulated");
  assert.equal(Object.values(afterTemperature.entities).find((item) => item.capability?.semanticRole === "target_temperature")?.state, 21);
  const mode = await request(base, entityRoute, { method: "POST", body: JSON.stringify({ serviceId: "climate.set_hvac_mode", data: { hvac_mode: "off" } }) });
  assert.equal(mode.response.status, 200);
  const afterMode = hub.store.getDevice("test-radiator-simulated");
  assert.equal(Object.values(afterMode.entities).find((item) => item.capability?.semanticRole === "operating_mode")?.state, "off");
  await hub.stop();
});
