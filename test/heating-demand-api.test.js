const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {} };
}

function mockCloudflare() {
  return { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } };
}

function climatePresentation(id, mode = "off") {
  const surfaceId = `${id}:surface`;
  return {
    version: 1,
    status: "ready",
    surfaces: {
      [surfaceId]: {
        id: surfaceId,
        sourceId: surfaceId,
        deviceId: id,
        haEntityId: `climate.${id}`,
        name: id,
        domain: "climate",
        state: mode,
        available: true,
        visibility: "household",
        sourceEntityIds: [],
        serviceRoutes: {
          "climate.set_hvac_mode": { entityId: surfaceId, serviceId: "climate.set_hvac_mode" },
          "climate.set_temperature": { entityId: surfaceId, serviceId: "climate.set_temperature" },
        },
        attributes: { hvac_mode: mode, hvac_modes: ["off", "heat"], temperature: 20, current_temperature: 20, min_temp: 5, max_temp: 35 },
        capability: { readable: true, writable: true, bindings: [{ serviceId: "climate.set_hvac_mode" }, { serviceId: "climate.set_temperature" }] },
      },
    },
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", authorization: "Bearer test-token", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => null) };
}

test("heating controller API persists mappings and verifies read-only without writing climate state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-heating-api-"));
  const hub = createHub({
    config: { nodeEnv: "development", haPort: 0, hubAgentPort: 0, adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.upsertDevice({ id: "boiler", name: "Boiler", protocol: "virtual", labelIds: ["boiler"], labels: ["boiler"], areaId: "room-1", setup: { status: "ready" }, state: {} });
  await hub.store.upsertDevice({ id: "radiator", name: "Radiator", protocol: "virtual", labelIds: ["radiator"], labels: ["radiator"], areaId: "room-1", setup: { status: "ready" }, state: {} });
  hub.store.state.devices.boiler.presentation = climatePresentation("boiler", "off");
  hub.store.state.devices.radiator.presentation = climatePresentation("radiator", "heat");
  hub.store.state.devices.radiator.presentation.surfaces["radiator:surface"].attributes.current_temperature = 19;
  hub.store.state.devices.radiator.presentation.surfaces["radiator:surface"].attributes.temperature = 21;
  await hub.store.persist();
  await hub.store.saveArea({ name: "Room 1" }, "room-1");
  await hub.store.saveHeatingDemandControllerConfig({ boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"], enabled: false });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const status = await request(base, "/_dinodia/admin/api/heating-demand-controller");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.config.boilerDeviceId, "boiler");
  assert.deepEqual(status.body.config.radiatorDeviceIds, ["radiator"]);
  assert.equal(status.body.config.enabled, false);
  const verify = await request(base, "/_dinodia/admin/api/heating-demand-controller/verify", { method: "POST", body: "{}" });
  assert.equal(verify.response.status, 200);
  assert.equal(verify.body.writesAttempted, 0);
  assert.equal(verify.body.physicalActuationVerified, false);
  assert.match(verify.body.note, /does not change temperatures or heating modes/);
  await hub.stop();
});
