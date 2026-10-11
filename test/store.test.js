const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { createBackup } = require("../src/backup");
const { allProjectedSurfaces } = require("../src/capabilities/controlSurfaceProjection");
const { serializeDevice } = require("../src/contracts/dinodiaV1");

test("store persists devices and automations atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "virtual", state: { power: "OFF" } });
  const automation = await store.saveAutomation({ name: "Turn on lamp", trigger: { deviceId: "sensor", field: "motion", equals: "ON" }, actions: [{ deviceId: "lamp", command: { state: { power: "ON" } } }] });
  assert.equal(automation.name, "Turn on lamp");
  const restored = new Store(file);
  assert.equal(restored.getDevice("lamp").state.power, "OFF");
  assert.equal(restored.listAutomations().length, 1);
  const backup = await createBackup({ dataFile: file, backupDir: path.join(directory, "backups") });
  assert.match(backup, /dinodia-.*\.json$/);
});

test("permanent-device registration commits its property policy before creating inventory sync", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-property-registration-outbox-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const homeId = "11111111-1111-4111-8111-111111111111";
  const hubInstallId = "22222222-2222-4222-8222-222222222222";
  const canonicalAreaId = "33333333-3333-4333-8333-333333333333";
  const area = await store.saveArea({ name: "Living room" }, "living-room");
  await store.savePlatform({ paired: true, homeId, hubInstallId, devicePolicies: {} });
  const device = await store.upsertDevice({ id: "zigbee:existing-radiator", name: "Living room radiator", protocol: "zigbee", areaId: area.id,
    setup: { status: "ready" }, interviewStatus: "successful", protocolIdentity: { ieeeAddress: "0x00124b0000000999" },
    entities: { heat: { id: "heat", name: "Heat", domain: "climate", capability: { category: "control", controlId: "target-temperature", semanticRole: "target_temperature", readable: true, writable: true, kind: "number", bindings: [{ serviceId: "climate.set_temperature" }] } } } },
  { devicePolicy: { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED", canonicalAreaIds: [canonicalAreaId], platformDeviceId: "44444444-4444-4444-8444-444444444444",
    installationRequestId: "55555555-5555-4555-8555-555555555555", catalogueStatus: "ready", usefulReadings: true, descriptorRevision: 1,
    descriptorDigest: "a".repeat(64), overrideName: "Living room radiator" } });
  const policy = store.getPlatform().devicePolicies[device.id];
  const events = store.getSyncOutbox().events.filter((event) => event.aggregateId === device.id);
  assert.equal(policy.managementClass, "PROPERTY_DEVICE");
  assert.deepEqual(events.map((event) => event.type), ["device.upsert", "control.catalog.upsert"]);
  assert.equal(events[0].payload.osDeviceId, device.id);
  assert.equal(events[0].payload.areaId, area.id);
  const restored = new Store(path.join(directory, "dinodia.json"));
  assert.equal(restored.getPlatform().devicePolicies[device.id].managementClass, "PROPERTY_DEVICE");
  assert.deepEqual(restored.getSyncOutbox().events.filter((event) => event.aggregateId === device.id).map((event) => event.type), ["device.upsert", "control.catalog.upsert"]);
});

test("sensitive capability step-up survives store normalization and restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-sensitive-capability-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.upsertDevice({
    id: "sensitive-switch", name: "Sensitive switch", protocol: "virtual", areaId: "area:one",
    setup: { status: "ready" }, state: { state: false },
    entities: {
      "sensitive-switch:state": {
        name: "Power", stateKey: "state", domain: "switch", category: "control", writable: true, primary: true,
        capability: { kind: "binary", controlId: "control:sensitive-power", semanticRole: "power", readable: true, writable: true, automatable: true, primary: true, sensitive: true, bindings: [{ serviceId: "switch.turn_on" }] },
      },
    },
  });

  const restartedStore = new Store(file);
  const device = restartedStore.getDevice("sensitive-switch");
  const storedCapability = device.entities["sensitive-switch:state"].capability;
  assert.equal(storedCapability.sensitive, true);
  assert.equal(storedCapability.stepUpPolicy, "required");
  assert.equal(storedCapability.automatable, false);
  const dto = serializeDevice({ device, homeId: "home:one", homeMembershipId: "membership:owner", role: "OWNER", areaIds: ["area:one"], surfaces: allProjectedSurfaces(device) });
  assert.ok(dto);
  assert.equal(dto.controls[0].stepUpPolicy, "required");
  assert.equal(dto.controls[0].confirmationPolicy, "step_up");
  assert.equal(dto.controls[0].automatable, false);
});

test("store supports rooms, labels, named devices and labeled child entities", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-model-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const area = await store.saveArea({ name: "Kitchen" });
  const label = await store.saveLabel({ name: "Lights" });
  await store.upsertDevice({ id: "kitchen-light", name: "Kitchen light", protocol: "zigbee", areaId: area.id, state: { state: "ON", brightness: 80 } });
  const entityId = "kitchen-light:brightness";
  const entity = await store.updateEntity("kitchen-light", entityId, { name: "Kitchen brightness", labelIds: [label.id] });
  assert.equal(store.getDevice("kitchen-light").areaId, area.id);
  assert.equal(entity.name, "Kitchen brightness");
  assert.deepEqual(entity.labelIds, [label.id]);
  const restored = new Store(path.join(directory, "dinodia.json"));
  assert.equal(restored.listAreas()[0].name, "Kitchen");
  assert.equal(restored.getDevice("kitchen-light").entities[entityId].labelIds[0], label.id);
});

test("coordinators and radio infrastructure stay out of the user device inventory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-infrastructure-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "zigbee:coordinator", name: "Coordinator", protocol: "zigbee", metadata: { type: "Coordinator" } });
  await store.upsertDevice({ id: "matter:controller", name: "Matter controller", protocol: "matter", role: "controller" });
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "zigbee", metadata: { type: "EndDevice" } });
  assert.deepEqual(store.listDevices().map((device) => device.id), ["lamp"]);
  assert.equal(store.getDevice("zigbee:coordinator").infrastructure, false);
});

test("clearing Zigbee removes the coordinator selection but keeps the household inventory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-zigbee-clear-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveZigbee({ adapterPath: "/dev/serial/by-id/usb-coordinator", adapterName: "Coordinator", adapterType: "ember" });
  await store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "zigbee", state: { power: "OFF" } });

  const cleared = await store.clearZigbee();
  assert.equal(cleared.adapterPath, "");
  assert.equal(cleared.adapterName, "");
  assert.deepEqual(cleared.removedAdapterPaths, ["/dev/serial/by-id/usb-coordinator"]);
  assert.equal(store.getConfigEntries().ce_zigbee, undefined);
  assert.equal(store.getDevice("lamp").name, "Lamp");
});

test("store persists the dedicated Thread RCP configuration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-thread-store-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const saved = await store.saveThread({ configured: true, rcpDevice: "/dev/serial/by-id/usb-thread", rcpName: "Thread MG21", baudRate: 460800 });
  assert.equal(saved.configured, true);
  assert.equal(saved.baudRate, 460800);
  assert.equal(new Store(path.join(directory, "dinodia.json")).getThread().rcpDevice, "/dev/serial/by-id/usb-thread");
});

test("registry mutations roll back in-memory state when persistence fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-rollback-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "virtual", state: { power: "OFF" } });
  const originalPersist = store.persist.bind(store);
  store.persist = async () => { throw new Error("disk full"); };
  await assert.rejects(() => store.renameEntity("lamp", "lamp:power", "switch.lamp_power"), /disk full/);
  assert.ok(store.getDevice("lamp").entities["lamp:power"]);
  assert.equal(store.getDevice("lamp").entities["switch.lamp_power"], undefined);
  store.persist = originalPersist;
});

test("removing an area clears device and child-entity assignments and is idempotent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-area-removal-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const area = await store.saveArea({ name: "Bedroom" }, "bedroom");
  await store.upsertDevice({ id: "radiator", name: "Radiator", protocol: "zigbee", areaId: area.id, state: { power: "ON" } });
  await store.updateEntity("radiator", "radiator:power", { areaId: area.id, name: "Radiator power" });

  const removed = await store.removeArea(area.id);
  assert.deepEqual(removed, {
    removed: true,
    areaId: "bedroom",
    areaName: "Bedroom",
    deviceAssignmentsCleared: 1,
    entityAssignmentsCleared: 1,
  });
  assert.equal(store.getDevice("radiator").areaId, null);
  assert.equal(store.getDevice("radiator").entities["radiator:power"].areaId, null);
  assert.equal((await store.removeArea(area.id)).removed, false);
});

test("deleting a device purges its aliases, state, events, automations, bindings, and child entity references", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-device-removal-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "zigbee:123", name: "Radiator upstairs", protocol: "zigbee", haDeviceId: "device-radiator", legacyIds: ["0x123"], metadata: { friendly_name: "radiator", ieee_address: "0x123" }, state: { temperature: 20 } });
  const device = store.getDevice("zigbee:123");
  const entity = Object.values(device.entities)[0];
  await store.saveRemoteBinding({ id: "binding-radiator", sourceDeviceId: "zigbee:123", targetEntityId: entity.id });
  await store.saveAutomation({ id: "automation-radiator", name: "Radiator schedule", trigger: { deviceId: "zigbee:123" }, actions: [{ deviceId: "device-radiator", command: { state: { temperature: 20 } } }] });
  await store.addEvent({ type: "device_state", deviceId: "zigbee:123" });
  await store.addEvent({ type: "unrelated", deviceId: "other-device" });
  store.state.states["zigbee:123"] = { value: 20 };
  store.state.states["unrelated"] = { value: true };
  store.state.heatingUsage.entities = {
    "climate.radiator": { deviceId: "zigbee:123", onSeconds: 10 },
    "climate.other": { deviceId: "other-device", onSeconds: 10 },
  };
  await store.persist();

  assert.equal(await store.deleteDevice("radiator"), true);
  assert.equal(store.listDevices().length, 0);
  assert.equal(store.getDevice("0x123"), null);
  assert.equal(store.listRemoteBindings().length, 0);
  assert.equal(store.listAutomations().length, 0);
  assert.equal(store.listEvents().some((event) => event.deviceId === "zigbee:123"), false);
  assert.equal(store.listEvents().some((event) => event.deviceId === "other-device"), true);
  assert.equal(store.snapshot().states["zigbee:123"], undefined);
  assert.deepEqual(store.snapshot().states.unrelated, { value: true });
  assert.equal(store.snapshot().heatingUsage.entities["climate.radiator"], undefined);
  assert.deepEqual(store.snapshot().heatingUsage.entities["climate.other"], { deviceId: "other-device", onSeconds: 10 });
  assert.equal(await store.deleteDevice("zigbee:123"), false);
});
