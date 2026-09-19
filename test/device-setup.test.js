const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { HomeAssistantModel } = require("../src/haModel");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { normalizeMatterNode } = require("../src/integrations/matter/nodeNormalizer");

async function testStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-device-setup-"));
  return new Store(path.join(directory, "dinodia.json"));
}

test("device setup promotes one assignment into multiple light control surfaces", async () => {
  const store = await testStore();
  const area = await store.saveArea({ name: "Living room" }, "living-room");
  const device = normalizeZigbeeDevice({
    friendly_name: "three-gang-switch",
    ieee_address: "0x00124b0001",
    definition: { vendor: "SONOFF", model: "Switch", exposes: [{ type: "switch", features: [
      { type: "binary", property: "state_l1", access: 7 },
      { type: "binary", property: "state_l2", access: 7 },
      { type: "binary", property: "state_l3", access: 7 },
      { type: "numeric", property: "brightness_l1", access: 7, value_min: 0, value_max: 254 },
      { type: "numeric", property: "voltage", access: 1 },
    ] }] },
  });
  await store.upsertDevice(device);
  assert.equal(store.getDevice(device.id).setup.status, "needs_setup");
  assert.equal(store.listDevices().length, 1);

  const updated = await store.completeDeviceSetup(device.id, { name: "Living room lights", areaId: area.id, labelId: "light" });
  assert.equal(updated.setup.status, "ready");
  assert.equal(updated.areaId, area.id);
  assert.deepEqual(updated.labelIds, ["light"]);
  assert.equal(updated.presentation.status, "ready");
  const surfaces = Object.values(updated.presentation.surfaces);
  assert.deepEqual(surfaces.map((surface) => surface.domain), ["light", "light", "light"]);
  assert.deepEqual(surfaces.map((surface) => surface.name), ["Living room lights 1", "Living room lights 2", "Living room lights 3"]);
  assert.ok(surfaces.every((surface) => surface.serviceRoutes["light.turn_on"]));
  assert.ok(surfaces.every((surface) => surface.sourceEntityIds.every((id) => id.startsWith(`${device.id}:`))));
  assert.equal(surfaces.some((surface) => surface.sourceEntityIds.some((id) => id.endsWith(":voltage"))), false);

  const calls = [];
  const model = new HomeAssistantModel({
    store,
    commandDevice: async () => { throw new Error("surface command should use its raw route"); },
    commandEntity: async (...args) => calls.push(args),
  });
  const publicEntities = model.entities();
  assert.equal(publicEntities.length, 3);
  assert.ok(publicEntities.every((item) => item.domain === "light"));
  assert.ok(publicEntities.every((item) => item.entity.attributes.area_id === area.id));
  assert.ok(publicEntities.every((item) => item.entity.attributes.dinodia_presentation));
  assert.equal(model.entityRegistry().every((item) => item.area_id === area.id), true);
  await model.callService("light", "turn_on", { entity_id: publicEntities[0].haId, brightness: 100 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2], "switch.turn_on");
  assert.equal(calls[0][1].stateKey, "state_l1");
  assert.equal(calls[0][3].brightness, 100);
  assert.equal(calls[1][2], "number.set_value");
  assert.equal(calls[1][1].stateKey, "brightness_l1");
  assert.equal(calls[1][3].value, 100);

  const cleared = await store.clearDeviceSetup(device.id);
  assert.equal(cleared.setup.status, "needs_setup");
  assert.equal(Object.keys(cleared.presentation.surfaces).length, 0);
  assert.equal(model.entities().length, 0);
});

test("radiator setup produces one climate surface from Matter thermostat capabilities", async () => {
  const store = await testStore();
  const area = await store.saveArea({ name: "Bedroom" }, "bedroom");
  const device = normalizeMatterNode({
    node_id: 7,
    fabric_id: "fabric-a",
    name: "Matter thermostat",
    endpoints: {
      1: {
        device_types: [{ id: 769 }],
        clusters: {
          513: { attributes: { 0: 2100, 18: 1950, 28: "heat", 41: "heat" } },
        },
      },
    },
  });
  await store.upsertDevice(device);
  const updated = await store.completeDeviceSetup(device.id, { areaId: area.id, labelId: "radiator" });
  const surfaces = Object.values(updated.presentation.surfaces);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].domain, "climate");
  assert.ok(surfaces[0].serviceRoutes["climate.set_temperature"]);
  assert.ok(surfaces[0].serviceRoutes["climate.set_hvac_mode"]);
  assert.equal(surfaces[0].attributes.temperature, 1950);
  assert.equal(surfaces[0].attributes.current_temperature, 2100);
  assert.equal(Object.values(updated.entities).some((entity) => entity.stateKey === "ThermostatRunningState" && entity.capability.writable), false);

  const calls = [];
  const model = new HomeAssistantModel({ store, commandDevice: async () => {}, commandEntity: async (...args) => calls.push(args) });
  const [entity] = model.entities();
  assert.equal(entity.domain, "climate");
  await model.callService("climate", "set_temperature", { entity_id: entity.haId, temperature: 2000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "climate.set_temperature");
  assert.equal(calls[0][3].temperature, 2000);
});

test("legacy child assignments are preserved and conflicting assignments require device setup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-legacy-assignments-"));
  const file = path.join(directory, "dinodia.json");
  await fs.writeFile(file, JSON.stringify({ version: 4, areas: {
    one: { id: "one", name: "One" },
    two: { id: "two", name: "Two" },
  }, devices: {
    switch: { id: "switch", protocol: "zigbee", areaId: null, labels: [], entities: {
      "switch:one": { id: "switch:one", areaId: "one", labelIds: ["light"] },
      "switch:two": { id: "switch:two", areaId: "two", labelIds: ["light"] },
    } },
  } }));
  const store = new Store(file);
  const device = store.getDevice("switch");
  assert.equal(device.setup.status, "needs_setup");
  assert.equal(device.setup.reason, "conflicting_legacy_assignments");
  assert.deepEqual(device.legacyEntityAssignments["switch:one"], { areaId: "one", labelIds: ["light"] });
  assert.equal(Object.keys(device.presentation.surfaces).length, 0);
});
