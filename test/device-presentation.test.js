const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../src/store");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { buildPresentation } = require("../src/capabilities/devicePresentation");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "zigbee", name), "utf8"));
}

async function configured(device, label = "light") {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dinodia-presentation-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveArea({ name: "Fixture room" }, "fixture-room");
  await store.upsertDevice(device);
  return store.completeDeviceSetup(device.id, { areaId: "fixture-room", labelId: label });
}

test("presentation groups two independent Zigbee gangs and hides diagnostics", async () => {
  const device = await configured(normalizeZigbeeDevice(fixture("two-gang-light.json")));
  const surfaces = Object.values(device.presentation.surfaces);
  assert.equal(surfaces.length, 2);
  assert.deepEqual(surfaces.map((surface) => surface.name), ["hall-two-gang 1", "hall-two-gang 2"]);
  assert.equal(surfaces.some((surface) => surface.sourceEntityIds.some((id) => id.includes("voltage") || id.includes("linkquality"))), false);
  assert.equal(new Set(surfaces.map((surface) => surface.haEntityId)).size, 2);
});

test("presentation merges dimming into one light and keeps a stable fingerprint", async () => {
  const device = await configured(normalizeZigbeeDevice(fixture("dimmable-light.json")));
  const [surface] = Object.values(device.presentation.surfaces);
  assert.equal(Object.keys(device.presentation.surfaces).length, 1);
  assert.equal(surface.domain, "light");
  assert.equal(surface.capability.bindings.find((binding) => binding.parameter)?.parameter.key, "brightness");
  assert.ok(surface.serviceRoutes["light.turn_on"].parameters.brightness);
  assert.match(device.presentation.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(buildPresentation(device).surfaces, device.presentation.surfaces);
});

test("presentation folds a Zigbee thermostat mode selector into one radiator surface", async () => {
  const device = await configured(normalizeZigbeeDevice(fixture("radiator-device.json")), "radiator");
  const surfaces = Object.values(device.presentation.surfaces);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].domain, "climate");
  assert.equal(surfaces[0].name, "bedroom-radiator");
  assert.ok(surfaces[0].serviceRoutes["climate.set_temperature"]);
  assert.ok(surfaces[0].serviceRoutes["climate.set_hvac_mode"]);
  assert.equal(surfaces[0].sourceEntityIds.some((id) => id.includes("system_mode")), true);
  assert.equal(surfaces[0].sourceEntityIds.some((id) => id.includes("battery")), false);
});

test("unsupported Zigbee metadata fails closed without a household surface", async () => {
  const device = await configured(normalizeZigbeeDevice(fixture("unsupported-mixed-device.json")));
  assert.equal(device.presentation.status, "no_safe_controls");
  assert.equal(Object.keys(device.presentation.surfaces).length, 0);
});
