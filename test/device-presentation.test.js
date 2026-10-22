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

test("descriptor revision is positive, stable for state updates, and advances on control changes and removal", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dinodia-descriptor-revision-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveArea({ name: "Fixture room" }, "fixture-room");
  const sourceDevice = normalizeZigbeeDevice(fixture("dimmable-light.json"));
  await store.upsertDevice(sourceDevice);
  await store.completeDeviceSetup(sourceDevice.id, { areaId: "fixture-room", labelId: "light" });
  const initialDevice = store.listDevices()[0];
  const trackedId = Object.keys(initialDevice.entities).find((id) => initialDevice.entities[id].capability?.writable);
  assert.ok(trackedId, "fixture contains a writable source control");
  let current = store.getDevice(initialDevice.id);
  let revision = current.presentation.descriptorRevision;
  assert.ok(Number.isSafeInteger(revision) && revision >= 1, "every installed device has a usable nonzero descriptor revision");

  await store.updateEntity(current.id, trackedId, { state: "ON" });
  current = store.getDevice(current.id);
  assert.equal(current.presentation.descriptorRevision, revision, "ordinary value/state changes do not create a new control catalog");

  const source = current.entities[trackedId];
  const changedBindings = [...(source.capability.bindings || []), { serviceId: "switch.turn_off", parameter: null }];
  await store.updateEntity(current.id, trackedId, { capability: { ...source.capability, bindings: changedBindings } });
  current = store.getDevice(current.id);
  assert.equal(current.presentation.descriptorRevision, revision + 1, "a current descriptor change advances the revision");
  revision = current.presentation.descriptorRevision;

  assert.equal(await store.removeEntity(current.id, trackedId), true);
  current = store.getDevice(current.id);
  assert.equal(current.presentation.descriptorRevision, revision + 1, "removing a source control advances the revision");
  assert.equal(Object.values(current.presentation.surfaces).some((surface) => surface.sourceEntityIds.includes(trackedId)), false, "removed source authority is absent from rebuilt surfaces");
});

test("startup backfills revisions and rebuilds an older cached surface against current stored sources", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dinodia-descriptor-upgrade-"));
  const filePath = path.join(directory, "dinodia.json");
  const store = new Store(filePath);
  await store.saveArea({ name: "Fixture room" }, "fixture-room");
  const sourceDevice = normalizeZigbeeDevice(fixture("dimmable-light.json"));
  await store.upsertDevice(sourceDevice);
  await store.completeDeviceSetup(sourceDevice.id, { areaId: "fixture-room", labelId: "light" });

  const oldState = store.snapshot();
  const oldDevice = oldState.devices[sourceDevice.id];
  const removedId = Object.keys(oldDevice.entities).find((id) => oldDevice.entities[id].capability?.writable);
  assert.ok(removedId);
  delete oldDevice.entities[removedId];
  delete oldDevice.presentation.descriptorRevision;
  await fs.promises.writeFile(filePath, `${JSON.stringify(oldState)}\n`, { mode: 0o600 });

  const restored = new Store(filePath).getDevice(sourceDevice.id);
  assert.ok(Number.isSafeInteger(restored.presentation.descriptorRevision) && restored.presentation.descriptorRevision >= 1, "older persisted hubs gain a usable descriptor revision on load");
  assert.equal(Object.values(restored.presentation.surfaces).some((surface) => surface.sourceEntityIds.includes(removedId)), false, "startup reconciliation removes stale cached surface references absent from current source entities");
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

test("Zigbee runtime settings (reporting, bindings, scenes, network address, interview progress) never change the descriptor revision", async () => {
  const device = await configured(normalizeZigbeeDevice(fixture("dimmable-light.json")));
  const revision = device.presentation.descriptorRevision;
  const withRuntime = JSON.parse(JSON.stringify(device));
  withRuntime.metadata.network_address = 4242;
  withRuntime.metadata.interviewing = true;
  withRuntime.metadata.interview_state = "IN_PROGRESS";
  withRuntime.metadata.endpoints = { 1: {
    bindings: [{ cluster: "genOnOff", target: { type: "endpoint", ieee_address: "0x00", endpoint: 1 } }],
    configured_reportings: [{ cluster: "genOnOff", attribute: "onOff", minimum_report_interval: 0, maximum_report_interval: 300, reportable_change: 0 }],
    scenes: [{ id: 1, name: "evening" }],
    clusters: { input: ["genOnOff", "genLevelCtrl"], output: [] },
  } };
  const first = buildPresentation(withRuntime);
  withRuntime.presentation = first;
  withRuntime.metadata.endpoints[1].configured_reportings.push({ cluster: "genLevelCtrl", attribute: "currentLevel", minimum_report_interval: 0, maximum_report_interval: 3600, reportable_change: 1 });
  withRuntime.metadata.endpoints[1].bindings = [];
  withRuntime.metadata.network_address = 999;
  const second = buildPresentation(withRuntime);
  assert.equal(second.descriptorRevision, first.descriptorRevision, "changing reporting or bindings must not look like a new device description");

  // A genuine description change (endpoint clusters, i.e. what the device can do) still bumps it.
  withRuntime.presentation = second;
  withRuntime.metadata.endpoints[1].clusters = { input: ["genOnOff"], output: [] };
  assert.equal(buildPresentation(withRuntime).descriptorRevision, second.descriptorRevision + 1);
  assert.ok(revision >= 1);
});
