const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { buildPresentation, getSurfaces } = require("../src/capabilities/devicePresentation");
const { serializeDevice } = require("../src/contracts/dinodiaV1");
const { activityFor } = require("../src/sync/usageBuckets");
const { Store } = require("../src/store");
const { PlatformPairing } = require("../src/platformPairing");
const { MqttBridge } = require("../src/mqttBridge");
const { strictUtcTimestamp, validateObservationConfiguration } = require("../src/integrations/zigbee/observationContract");
const { applyObservationConfiguration, clearStaleTrackedState, mergeObservationConfiguration } = require("../src/integrations/zigbee/observationConfigPatch");

function trvFixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
}

function readyTrv() {
  const device = normalizeZigbeeDevice(trvFixture());
  device.areaId = "os-area-room-1";
  device.setup = { status: "ready", assignmentMode: "device_inherited_v1" };
  device.state = {
    occupied_heating_setpoint: 20,
    local_temperature: 19.5,
    system_mode: "heat",
    running_state: "heat",
    battery: 80,
  };
  device.presentation = buildPresentation(device);
  return device;
}

function publicDescriptor(device) {
  return serializeDevice({
    device,
    homeId: "home-fixture",
    homeMembershipId: "membership-fixture",
    role: "OWNER",
    areaIds: ["os-area-room-1"],
    surfaces: getSurfaces(device),
    revision: device.presentation.descriptorRevision,
  });
}

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-radiator-observation-"));
  return { directory, store: new Store(path.join(directory, "store.json")) };
}

function publisherConfiguration() {
  return [
    "advanced:", "  last_seen: ISO_8601", "devices:",
    "  '0x00124b00c09b9eff':", "    friendly_name: room-1-radiator", "    optimistic: false",
    "    filtered_cache:", "      - running_state", "      - local_temperature", "",
  ].join("\n");
}

test("only the exact current UTC/per-device Z2M report settings establish the observation contract", () => {
  const options = { friendlyName: "room-1-radiator", ieeeAddress: "0x00124b00c09b9eff" };
  assert.deepEqual(validateObservationConfiguration(publisherConfiguration(), options), { ok: true, reason: null });
  assert.equal(validateObservationConfiguration(publisherConfiguration().replace("ISO_8601", "disable"), options).ok, false);
  assert.equal(validateObservationConfiguration(publisherConfiguration().replace("optimistic: false", "optimistic: true"), options).ok, false);
  assert.equal(validateObservationConfiguration(publisherConfiguration().replace("- local_temperature", "- battery"), options).ok, false);
  assert.equal(strictUtcTimestamp("2026-10-13T19:00:00.123Z", Date.parse("2026-10-13T19:00:01Z")), "2026-10-13T19:00:00.123Z");
  assert.equal(strictUtcTimestamp("2026-02-31T19:00:00Z", Date.parse("2026-10-13T19:00:01Z")), null);
  assert.equal(strictUtcTimestamp("2026-10-13T19:01:00Z", Date.parse("2026-10-13T19:00:00Z")), null);
});

test("publisher configuration merge preserves coordinator/network and unrelated device settings; stale-state cleanup is exact", () => {
  const identity = { friendlyName: "Room 1 Radiator", ieeeAddress: "0xc09b9efffeadb2a3" };
  const original = [
    "version: 4", "mqtt:", "  base_topic: zigbee2mqtt", "  server: mqtt://mosquitto:1883",
    "serial:", "  port: /dev/serial/by-id/usb-SONOFF_38fd-if00-port0", "  adapter: zstack",
    "advanced:", "  log_level: info", "  last_seen: disable", "devices:",
    "  '0xf044d3fffe34c107':", "    friendly_name: Other Device", "    optimistic: true", "    retain: true",
    "  '0xc09b9efffeadb2a3':", "    friendly_name: Room 1 Radiator", "    optimistic: true", "    debounce: 0.5", "    retain: true", "",
  ].join("\n");
  const patched = mergeObservationConfiguration(original, identity);
  assert.deepEqual(validateObservationConfiguration(patched, identity), { ok: true, reason: null });
  for (const preserved of [
    "  base_topic: zigbee2mqtt", "  server: mqtt://mosquitto:1883",
    "  port: /dev/serial/by-id/usb-SONOFF_38fd-if00-port0", "  adapter: zstack",
    "    friendly_name: Other Device", "    optimistic: true", "    retain: true",
    "    debounce: 0.5", "    friendly_name: Room 1 Radiator", "    retain: true",
  ]) assert.ok(patched.includes(preserved), `preserve unrelated configuration line: ${preserved}`);
  assert.equal(mergeObservationConfiguration(patched, identity), patched, "the merge is idempotent");

  const originalState = {
    "0xc09b9efffeadb2a3": { running_state: "heat", local_temperature: 19.5, battery: 80, child_lock: "UNLOCK" },
    "0xf044d3fffe34c107": { running_state: "idle", local_temperature: 18, battery: 75 },
  };
  const result = clearStaleTrackedState(JSON.stringify(originalState), identity.ieeeAddress);
  const cleaned = JSON.parse(result.contents);
  assert.deepEqual(result.removed.sort(), ["local_temperature", "running_state"]);
  assert.deepEqual(cleaned["0xc09b9efffeadb2a3"], { battery: 80, child_lock: "UNLOCK" });
  assert.deepEqual(cleaned["0xf044d3fffe34c107"], originalState["0xf044d3fffe34c107"]);
  assert.throws(() => clearStaleTrackedState(JSON.stringify({ ...originalState, "c09b9efffeadb2a3": {} }), identity.ieeeAddress), /missing or ambiguous/);
});

test("the owner-checkpoint CLI validates without writes and atomically applies only its exact target edits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-radiator-config-cli-"));
  try {
    const configPath = path.join(directory, "configuration.yaml");
    const statePath = path.join(directory, "state.json");
    const config = ["serial:", "  port: /dev/serial/by-id/usb-SONOFF_38fd-if00-port0", "  adapter: zstack",
      "advanced:", "  last_seen: disable", "devices:", "  '0xc09b9efffeadb2a3':", "    friendly_name: Room 1 Radiator", "    retain: true", ""].join("\n");
    const state = { "0xc09b9efffeadb2a3": { running_state: "heat", local_temperature: 19.5, battery: 80 },
      "0xf044d3fffe34c107": { running_state: "idle" } };
    fs.writeFileSync(configPath, config, { mode: 0o600 });
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const script = path.join(__dirname, "..", "scripts", "radiator_observation_config.mjs");
    const args = [script, "--config", configPath, "--state", statePath, "--friendly-name", "Room 1 Radiator", "--ieee-address", "0xc09b9efffeadb2a3"];
    const dryRun = spawnSync(process.execPath, [...args, "--dry-run"], { encoding: "utf8" });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.deepEqual(JSON.parse(dryRun.stdout).targetStatePropertiesRemoved.sort(), ["local_temperature", "running_state"]);
    assert.equal(fs.readFileSync(configPath, "utf8"), config, "dry run is read-only");
    assert.equal(fs.readFileSync(statePath, "utf8"), JSON.stringify(state), "dry run leaves cached state untouched");

    const applied = spawnSync(process.execPath, [...args, "--apply"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).applied, true);
    assert.deepEqual(validateObservationConfiguration(fs.readFileSync(configPath, "utf8"), { friendlyName: "Room 1 Radiator", ieeeAddress: "0xc09b9efffeadb2a3" }), { ok: true, reason: null });
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(saved["0xc09b9efffeadb2a3"], { battery: 80 });
    assert.deepEqual(saved["0xf044d3fffe34c107"], state["0xf044d3fffe34c107"]);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("publisher config is rolled back exactly if tracked cache cleanup fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-radiator-config-rollback-"));
  try {
    const configPath = path.join(directory, "configuration.yaml");
    const statePath = path.join(directory, "state.json");
    const config = ["serial:", "  port: /dev/serial/by-id/usb-SONOFF_38fd-if00-port0", "  adapter: zstack",
      "advanced:", "  last_seen: disable", "devices:", "  '0xc09b9efffeadb2a3':", "    friendly_name: Room 1 Radiator", "    retain: true", ""].join("\n");
    const state = JSON.stringify({ "0xc09b9efffeadb2a3": { running_state: "heat", local_temperature: 19.5, battery: 80 } });
    fs.writeFileSync(configPath, config);
    fs.writeFileSync(statePath, state);
    const writes = [];
    assert.throws(() => applyObservationConfiguration({
      configPath, statePath, identity: { friendlyName: "Room 1 Radiator", ieeeAddress: "0xc09b9efffeadb2a3" },
      write(filePath, contents) {
        writes.push(filePath);
        if (filePath === statePath) throw new Error("injected state-cache write failure");
        fs.writeFileSync(filePath, contents);
      },
    }), /injected state-cache write failure/);
    assert.deepEqual(writes, [configPath, statePath, configPath], "only the exact modified configuration is rolled back");
    assert.equal(fs.readFileSync(configPath, "utf8"), config);
    assert.equal(fs.readFileSync(statePath, "utf8"), state);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sanitized real-shaped TRVZB exposes produce public heat-demand and numeric read-only temperature controls", () => {
  const device = readyTrv();
  const descriptor = publicDescriptor(device);
  const heat = descriptor.controls.find((control) => control.semanticRole === "active_heat_demand");
  const temperature = descriptor.controls.find((control) => control.semanticRole === "ambient_temperature");
  const mode = descriptor.controls.find((control) => control.semanticRole === "operating_mode");
  const setpoint = descriptor.controls.find((control) => control.semanticRole === "target_temperature");

  assert.ok(heat, "running_state must survive normalization, presentation, and serialization");
  assert.equal(heat.valueType, "option");
  assert.equal(heat.writable, false);
  assert.deepEqual(heat.constraints.options.map((option) => option.value), ["idle", "heat"]);
  assert.deepEqual([temperature.valueType, temperature.writable], ["number", false]);
  assert.deepEqual([mode.semanticRole, mode.valueType, mode.writable], ["operating_mode", "option", true]);
  assert.deepEqual([setpoint.semanticRole, setpoint.valueType, setpoint.writable], ["target_temperature", "number", true]);
});

test("radiator activity accepts only heat/idle on an active_heat_demand signal", () => {
  assert.equal(activityFor({ category: "RADIATOR", role: "active_heat_demand", value: "heat" }), "on");
  assert.equal(activityFor({ category: "RADIATOR", role: "active_heat_demand", value: "idle" }), "off");
  assert.equal(activityFor({ category: "RADIATOR", role: "operating_mode", value: "heat" }), "unknown");
  assert.equal(activityFor({ category: "RADIATOR", role: "target_temperature", value: 25 }), "unknown");
  assert.equal(activityFor({ category: "RADIATOR", role: "active_heat_demand", value: "unknown" }), "unknown");
});

test("missing broker identity generation blocks telemetry; a verified generation starts it prospectively", async () => {
  const { store } = temporaryStore();
  try {
    const device = readyTrv();
    await store.saveArea({ name: "Room 1", icon: "room" }, "os-area-room-1");
    await store.upsertDevice(device);
    const stored = store.getDevice(device.id);
    await store.savePlatform({
      homeId: "home-fixture",
      devicePolicies: { [device.id]: {
        osDeviceId: device.id, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
        analyticsCategory: "RADIATOR", lifecycle: "INSTALLED", descriptorRevision: stored.presentation.descriptorRevision,
        descriptorDigest: "b".repeat(64), osAreaIds: ["os-area-room-1"],
      } },
    });
    const update = async (observedAt) => store.updateDeviceState(device.id, {
      running_state: "heat", local_temperature: 19.5,
    }, {
      sourceObservedAtByStateKey: { running_state: observedAt, local_temperature: observedAt },
      sourceReceivedAtByStateKey: { running_state: new Date().toISOString(), local_temperature: new Date().toISOString() },
      reportedStateKeys: ["running_state", "local_temperature"],
      requireExplicitObservation: true,
      nowMs: Date.now(),
    });

    await update(new Date(Date.now() - 4_000).toISOString());
    assert.equal(store.getSyncOutbox().events.some((event) => ["usage.bucket", "temperature.sample"].includes(event.type)), false,
      "a local Store identity record cannot stand in for the signed installation generation");

    store.setSyncSourceGeneration(4);
    const currentObservation = new Date(Date.now() - 1_000).toISOString();
    await update(currentObservation);
    const telemetry = store.getSyncOutbox().events.filter((event) => ["usage.bucket", "temperature.sample"].includes(event.type));
    assert.ok(telemetry.some((event) => event.type === "usage.bucket" && event.payload.sourceGeneration === 4));
    assert.ok(telemetry.some((event) => event.type === "temperature.sample"
      && event.payload.sourceGeneration === 4 && event.payload.sourceObservedAt === currentObservation));
  } finally {
    fs.rmSync(path.dirname(store.filePath), { recursive: true, force: true });
  }
});

test("actual MQTT state handling updates declared endpoint properties without fallback duplicates or local-time freshness", async () => {
  const { directory, store } = temporaryStore();
  try {
    const initial = readyTrv();
    await store.saveIdentity({ serial: "fixture-hub", instanceId: "fixture-instance" });
    const identityKeys = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = identityKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const pairing = new PlatformPairing({
      store,
      serial: "fixture-hub",
      runtime: { nodeEnv: "production" },
      identityBroker: { getPublicIdentity: async () => ({
        serial: "fixture-hub", signingPublicKeyPem: publicKeyPem, encryptionPublicKeyPem: publicKeyPem, generation: 4,
      }) },
    });
    await pairing.getPublicIdentity();
    await store.saveArea({ name: "Room 1", icon: "room" }, "os-area-room-1");
    await store.upsertDevice(initial);
    const storedInitial = store.getDevice(initial.id);
    await store.savePlatform({
      homeId: "home-fixture",
      devicePolicies: {
        [initial.id]: {
          osDeviceId: initial.id, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
          analyticsCategory: "RADIATOR", lifecycle: "INSTALLED", descriptorRevision: storedInitial.presentation.descriptorRevision,
          descriptorDigest: "a".repeat(64), osAreaIds: ["os-area-room-1"],
        },
      },
    });
    const configPath = path.join(directory, "configuration.yaml");
    fs.writeFileSync(configPath, publisherConfiguration());
    const mqttClient = new EventEmitter();
    mqttClient.subscribe = (_topic, callback) => callback(null);
    let messageHandled;
    const bridge = new MqttBridge({ url: "mqtt://disposable.invalid", store, observationConfigPath: configPath,
      mqttConnect: () => mqttClient, onDeviceChanged: (updated) => { messageHandled?.(updated); messageHandled = null; },
      logger: { log() {}, error() {} } });
    const observedAt = new Date(Date.now() - 5_000).toISOString();
    bridge.start();
    mqttClient.emit("connect");
    await new Promise((resolve) => setImmediate(resolve));
    const firstMessage = new Promise((resolve) => { messageHandled = resolve; });
    mqttClient.emit("message", "zigbee2mqtt/room-1-radiator", Buffer.from(JSON.stringify({
      local_temperature: 19.5,
      running_state: "heat",
      system_mode: "heat",
      occupied_heating_setpoint: 20,
      last_seen: observedAt,
    })), { retain: false, qos: 0, dup: false });
    await firstMessage;

    let device = store.getDevice(initial.id);
    assert.equal(Object.values(device.entities).filter((entity) => entity.stateKey === "running_state").length, 1);
    assert.equal(Object.values(device.entities).filter((entity) => entity.stateKey === "local_temperature").length, 1);
    assert.equal(device.entities[`${initial.id}:1:running_state`].sourceObservedAt, observedAt);
    assert.equal(device.entities[`${initial.id}:1:local_temperature`].sourceObservedAt, observedAt);
    const repeatedAt = new Date(Date.now() - 2_000).toISOString();
    const sameValueMessage = new Promise((resolve) => { messageHandled = resolve; });
    mqttClient.emit("message", "zigbee2mqtt/room-1-radiator", Buffer.from(JSON.stringify({
      local_temperature: 19.5, running_state: "heat", last_seen: repeatedAt,
    })), { retain: false, qos: 0, dup: false });
    await sameValueMessage;
    device = store.getDevice(initial.id);
    assert.equal(device.entities[`${initial.id}:1:running_state`].sourceObservedAt, repeatedAt,
      "a genuinely newer same-valued report renews only that property's source time");
    assert.ok(Date.parse(device.entities[`${initial.id}:1:running_state`].sourceReceivedAt) >= Date.parse(repeatedAt));
    assert.equal(device.entities[`${initial.id}:1:running_state`].sourceReceivedAt, device.entities[`${initial.id}:1:local_temperature`].sourceReceivedAt);
    assert.ok(store.getSyncOutbox().events.some((event) => event.type === "usage.bucket"
      && event.payload.osDeviceId === initial.id && event.payload.analyticsCategory === "RADIATOR"));
    assert.ok(store.getSyncOutbox().events.some((event) => event.type === "temperature.sample"
      && event.payload.osDeviceId === initial.id && event.payload.sourceObservedAt === observedAt));
    assert.ok(store.getSyncOutbox().events.filter((event) => ["usage.bucket", "temperature.sample"].includes(event.type)
      && event.payload.osDeviceId === initial.id).every((event) => event.payload.sourceGeneration === 4),
    "real MQTT observations use the generation returned by the identity broker, not Store-local identity metadata");

    const heatSourceTime = device.entities[`${initial.id}:1:running_state`].sourceObservedAt;
    const temperatureSourceTime = device.entities[`${initial.id}:1:local_temperature`].sourceObservedAt;
    await bridge.handleMessage("zigbee2mqtt/room-1-radiator", Buffer.from(JSON.stringify({
      battery: 79,
      last_seen: new Date(Date.now()).toISOString(),
    })), { retain: false, qos: 0, dup: false });
    device = store.getDevice(initial.id);
    assert.equal(device.entities[`${initial.id}:1:running_state`].sourceObservedAt, heatSourceTime);
    assert.equal(device.entities[`${initial.id}:1:local_temperature`].sourceObservedAt, temperatureSourceTime);

    const retainedAt = new Date(Date.now() + 1_000).toISOString();
    await bridge.handleMessage("zigbee2mqtt/room-1-radiator", Buffer.from(JSON.stringify({
      local_temperature: 18,
      running_state: "idle",
      last_seen: retainedAt,
    })), { retain: true, qos: 1, dup: false });
    device = store.getDevice(initial.id);
    assert.equal(device.entities[`${initial.id}:1:running_state`].sourceObservedAt, null);
    assert.equal(device.entities[`${initial.id}:1:local_temperature`].sourceObservedAt, null);

    await bridge.handleMessage("zigbee2mqtt/room-1-radiator", Buffer.from(JSON.stringify({
      running_state: "heat", local_temperature: 19.8,
    })), { retain: false, qos: 0, dup: false });
    device = store.getDevice(initial.id);
    assert.equal(device.entities[`${initial.id}:1:running_state`].sourceObservedAt, null,
      "a non-retained message with no validated source clock cannot establish freshness");
    const futureAt = new Date(Date.now() + 60_000).toISOString();
    await bridge.handleMessage("zigbee2mqtt/room-1-radiator", Buffer.from(JSON.stringify({
      local_temperature: 19.9, last_seen: futureAt,
    })), { retain: false, qos: 0, dup: false });
    device = store.getDevice(initial.id);
    assert.equal(device.entities[`${initial.id}:1:local_temperature`].sourceObservedAt, null,
      "a future source timestamp cannot establish freshness");

    // A later Store metadata/snapshot merge must not turn local lastChanged
    // or updatedAt into a claimed publisher observation.
    await store.upsertDevice({ ...device, name: "Room 1 Radiator" });
    device = store.getDevice(initial.id);
    assert.ok(Object.values(device.entities).every((entity) => entity.sourceObservedAt == null
      || entity.sourceObservedAt === heatSourceTime || entity.sourceObservedAt === temperatureSourceTime));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("endpoint fallback with a durable automation reference is retained and flagged without retargeting", async () => {
  const { directory, store } = temporaryStore();
  try {
    const device = readyTrv();
    await store.upsertDevice(device);
    const current = store.getDevice(device.id);
    const fallbackId = `${device.id}:running_state`;
    const fallbackControlId = require("../src/store").nativeControlId(device.id, "0", "running_state");
    const persisted = store.snapshot();
    persisted.devices[device.id].entities[fallbackId] = {
      id: fallbackId, sourceId: fallbackId, deviceId: device.id, stateKey: "running_state", endpointId: "0",
      logicalKey: "running_state", name: "Running State", state: "heat", capability: {
        controlId: fallbackControlId, kind: "sensor", readable: true, writable: false, observable: true,
        semanticRole: "unknown", bindings: [],
      },
    };
    persisted.automations = { "automation-a": { trigger: { controlId: fallbackControlId } } };
    fs.writeFileSync(path.join(directory, "store.json"), JSON.stringify(persisted));
    const restarted = new Store(path.join(directory, "store.json"));
    await restarted.saveIdentity({ serial: "fixture-hub", instanceId: "fixture-instance", generation: 1 });
    await restarted.savePlatform({ homeId: "home-fixture", devicePolicies: {
      [device.id]: { osDeviceId: device.id, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
        analyticsCategory: "RADIATOR", lifecycle: "INSTALLED", descriptorRevision: current.presentation.descriptorRevision,
        descriptorDigest: "b".repeat(64), osAreaIds: ["os-area-room-1"] },
    } });
    const refreshed = await restarted.upsertDevice({ ...current, state: { ...current.state, running_state: "heat" } });
    const runningEntities = Object.values(refreshed.entities).filter((entity) => entity.stateKey === "running_state");
    assert.equal(runningEntities.length, 2, "do not delete a referenced legacy record behind an automation");
    const retainedFallback = refreshed.entities[fallbackId];
    assert.equal(retainedFallback.reconciliationAttention.reason, "generated_endpoint_fallback_has_durable_reference");
    assert.deepEqual(retainedFallback.reconciliationAttention.canonicalEntityIds, [`${device.id}:1:running_state`]);
    assert.equal(restarted.snapshot().automations["automation-a"].trigger.controlId, fallbackControlId,
      "existing automation references are not silently redirected");
    assert.equal(restarted.getSyncOutbox().events.some((event) => event.type === "control.catalog.tombstone"
      && event.payload.controlIds.includes(fallbackControlId)), false,
    "a legacy unknown sensor that was never in the public catalogue must not get a fabricated tombstone");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unreferenced exact generated endpoint-0 fallback is retired, but similar diagnostic entities remain", async () => {
  const { directory, store } = temporaryStore();
  try {
    const device = readyTrv();
    await store.upsertDevice(device);
    const current = store.getDevice(device.id);
    const fallbackId = `${device.id}:running_state`;
    const fallbackControlId = require("../src/store").nativeControlId(device.id, "0", "running_state");
    const persisted = store.snapshot();
    persisted.devices[device.id].entities[fallbackId] = {
      id: fallbackId, sourceId: fallbackId, deviceId: device.id, stateKey: "running_state", endpointId: "0",
      logicalKey: "running_state", name: "Running State", state: "heat", capability: {
        controlId: fallbackControlId, kind: "sensor", readable: true, writable: false, observable: true,
        semanticRole: "unknown", bindings: [],
      },
    };
    const diagnosticId = `${device.id}:diagnostic:firmware`;
    persisted.devices[device.id].entities[diagnosticId] = {
      id: diagnosticId, sourceId: diagnosticId, deviceId: device.id, stateKey: "firmware", endpointId: "0",
      logicalKey: "firmware", name: "Firmware Diagnostic", state: "1.0",
      capability: { controlId: "firmware-diagnostic", kind: "sensor", readable: true, writable: false, observable: true, semanticRole: "unknown", bindings: [] },
    };
    fs.writeFileSync(path.join(directory, "store.json"), JSON.stringify(persisted));
    const restarted = new Store(path.join(directory, "store.json"));
    await restarted.saveIdentity({ serial: "fixture-hub", instanceId: "fixture-instance", generation: 1 });
    const refreshed = await restarted.upsertDevice({ ...current, state: { ...current.state, running_state: "heat" } });
    assert.equal(refreshed.entities[fallbackId], undefined, "remove only the proven generated fallback");
    assert.equal(refreshed.entities[diagnosticId].name, "Firmware Diagnostic");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
