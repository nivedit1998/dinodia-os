const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  DEFAULT_HEATING_DEMAND_CONFIG,
  HeatingDemandController,
  evaluateHeatingDemand,
  evaluateRadiatorDemand,
  buildReadOnlyVerification,
} = require("../src/heatingDemandController");

const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function snapshot(overrides = {}) {
  return {
    deviceId: "device",
    name: "Device",
    protocol: "virtual",
    mode: "off",
    action: "idle",
    targetTemperature: 20,
    currentTemperature: 20,
    heatDemand: undefined,
    available: true,
    fresh: true,
    observedAt: new Date(NOW - 30_000).toISOString(),
    temperatureWritable: true,
    modeWritable: true,
    ...overrides,
  };
}

function device(id, label, attributes = {}) {
  const surface = {
    id: `${id}:surface`,
    sourceId: `${id}:surface`,
    deviceId: id,
    haEntityId: `climate.${id}`,
    name: id,
    domain: "climate",
    state: attributes.hvac_mode || "off",
    available: true,
    visibility: "household",
    sourceEntityIds: [],
    serviceRoutes: {
      "climate.set_hvac_mode": { entityId: `${id}:surface`, serviceId: "climate.set_hvac_mode" },
      "climate.set_temperature": { entityId: `${id}:surface`, serviceId: "climate.set_temperature" },
    },
    attributes: {
      hvac_mode: "off",
      hvac_modes: ["off", "heat"],
      temperature: 20,
      current_temperature: 20,
      min_temp: 5,
      max_temp: 35,
      ...attributes,
    },
    capability: {
      readable: true,
      writable: true,
      bindings: [
        { serviceId: "climate.set_hvac_mode" },
        { serviceId: "climate.set_temperature" },
      ],
    },
  };
  return {
    id,
    name: id,
    protocol: "virtual",
    labels: [label],
    labelIds: [label],
    areaId: "room-1",
    available: true,
    updatedAt: new Date(NOW - 30_000).toISOString(),
    setup: { status: "ready" },
    state: {},
    presentation: { status: "ready", surfaces: { [surface.id]: surface } },
  };
}

test("multiple Boiler candidates are never guessed when enabling", () => {
  const boilers = [device("boiler-1", "boiler"), device("boiler-2", "boiler")];
  assert.throws(() => require("../src/heatingDemandController").normalizeHeatingDemandConfig({ enabled: true, radiatorDeviceIds: ["radiator"] }, [...boilers, device("radiator", "radiator")]), (error) => error.code === "multiple_boilers_require_selection");
});

function fakeStore(config, initialRuntime = {}) {
  let storedConfig = { ...config };
  let storedRuntime = { ...initialRuntime };
  return {
    getHeatingDemandController: () => ({ config: { ...storedConfig }, runtime: { ...storedRuntime } }),
    saveHeatingDemandControllerConfig: async (next) => { storedConfig = { ...storedConfig, ...next }; return { config: storedConfig, runtime: storedRuntime }; },
    saveHeatingDemandControllerRuntime: async (next) => { storedRuntime = { ...storedRuntime, ...next }; return { config: storedConfig, runtime: storedRuntime }; },
  };
}

test("radiator demand uses off, deadband, explicit demand and stale-state safety", () => {
  const config = { ...DEFAULT_HEATING_DEMAND_CONFIG, deadbandCelsius: 0.3 };
  assert.equal(evaluateRadiatorDemand(snapshot({ mode: "off" }), config).demand, "off");
  assert.equal(evaluateRadiatorDemand(snapshot({ mode: "heat", targetTemperature: 20.2, currentTemperature: 20 }), config).demand, "satisfied");
  assert.equal(evaluateRadiatorDemand(snapshot({ mode: "heat", targetTemperature: 20.4, currentTemperature: 20 }), config).demand, "calling");
  assert.equal(evaluateRadiatorDemand(snapshot({ mode: "heat", heatDemand: true }), config).demand, "calling");
  assert.equal(evaluateRadiatorDemand(snapshot({ fresh: false }), config).demand, "unknown");
  assert.equal(evaluateRadiatorDemand(snapshot({ available: false }), config).demand, "unavailable");
});

test("heating demand requests heat, releases it, and holds unknown state during grace", () => {
  const config = { ...DEFAULT_HEATING_DEMAND_CONFIG, unknownGraceSeconds: 300 };
  const boiler = snapshot({ deviceId: "boiler", mode: "off" });
  const calling = snapshot({ deviceId: "radiator", mode: "heat", targetTemperature: 21, currentTemperature: 19 });
  const satisfied = snapshot({ deviceId: "radiator", mode: "heat", targetTemperature: 19, currentTemperature: 19 });
  assert.equal(evaluateHeatingDemand({ boiler, radiators: [calling], config }).desiredBoilerMode, "heat");
  assert.equal(evaluateHeatingDemand({ boiler, radiators: [satisfied], config }).desiredBoilerMode, "off");
  assert.equal(evaluateHeatingDemand({ boiler, radiators: [snapshot({ deviceId: "radiator", fresh: false })], config, runtime: { unknownSince: new Date(NOW).toISOString() }, now: NOW + 60_000 }).desiredBoilerMode, null);
  assert.equal(evaluateHeatingDemand({ boiler, radiators: [snapshot({ deviceId: "radiator", fresh: false })], config, runtime: { unknownSince: new Date(NOW - 301_000).toISOString() }, now: NOW }).desiredBoilerMode, "off");
});

test("read-only verification never invokes the command executor and reports zero writes", () => {
  const boiler = device("boiler", "boiler", { hvac_mode: "off" });
  const radiator = device("radiator", "radiator", { hvac_mode: "heat", temperature: 21, current_temperature: 19 });
  const verification = buildReadOnlyVerification({
    controllerConfig: { ...DEFAULT_HEATING_DEMAND_CONFIG, boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"] },
    devices: [boiler, radiator],
    integrations: {},
    now: NOW,
  });
  assert.equal(verification.writesAttempted, 0);
  assert.equal(verification.physicalActuationVerified, false);
  assert.match(verification.note, /Read-only/);
  assert.ok(verification.checks.some((check) => check.name === "command_adapter_validation"));
});

test("read-only provider checks stay protocol-neutral for Zigbee, Matter, Hive and Google Nest", () => {
  const integrationFor = {
    zigbee: { configured: true, connected: true, reachable: true, status: "connected", service: { running: true } },
    matter: { configured: true, connected: true, reachable: true, status: "connected", service: { running: true } },
    hive: { configured: true, connected: true, reachable: true, status: "connected", service: { running: true } },
    googleNest: { configured: true, connected: true, reachable: true, status: "connected", service: { running: true } },
  };
  for (const [protocol, integrationKey] of [["zigbee", "zigbee"], ["matter", "matter"], ["hive", "hive"], ["google_nest", "googleNest"]]) {
    const boiler = { ...device(`${protocol}-boiler`, "boiler"), protocol };
    const radiator = { ...device(`${protocol}-radiator`, "radiator", { hvac_mode: "heat", temperature: 21, current_temperature: 19 }), protocol };
    const result = buildReadOnlyVerification({ controllerConfig: { boilerDeviceId: boiler.id, radiatorDeviceIds: [radiator.id] }, devices: [boiler, radiator], integrations: { [integrationKey]: integrationFor[integrationKey] }, now: NOW });
    assert.equal(result.writesAttempted, 0);
    assert.equal(result.physicalActuationVerified, false);
    assert.equal(result.checks.find((check) => check.name === "provider_connectivity").result, "pass");
  }
});

test("controller is disabled by default and controls a mapped boiler only after explicit enablement", async () => {
  const boiler = device("boiler", "boiler", { hvac_mode: "off", temperature: 30 });
  const radiator = device("radiator", "radiator", { hvac_mode: "heat", temperature: 21, current_temperature: 19 });
  const devices = [boiler, radiator];
  const writes = [];
  const store = fakeStore({ ...DEFAULT_HEATING_DEMAND_CONFIG, boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"] });
  const controller = new HeatingDemandController({
    store,
    eventBus: new EventEmitter(),
    getDevices: () => devices,
    getIntegrations: () => ({}),
    executeAction: async (action) => { writes.push(action); },
    now: () => NOW,
    activity: { record: async () => {} },
  });
  await controller.evaluate({ execute: true });
  assert.equal(writes.length, 0);
  await controller.configure({ ...DEFAULT_HEATING_DEMAND_CONFIG, enabled: true, boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"], requestTemperatureEnabled: false });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].serviceId, "climate.set_hvac_mode");
  assert.deepEqual(writes[0].data, { hvac_mode: "heat" });
  boiler.presentation.surfaces["boiler:surface"].attributes.hvac_mode = "heat";
  await controller.evaluate({ execute: true });
  assert.equal(writes.length, 1);
  radiator.presentation.surfaces["radiator:surface"].attributes.temperature = 19;
  radiator.presentation.surfaces["radiator:surface"].attributes.current_temperature = 19;
  await controller.evaluate({ execute: true });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].serviceId, "climate.set_hvac_mode");
  assert.deepEqual(writes[1].data, { hvac_mode: "off" });
  controller.stop();
});

test("restart clears only the transient pending marker and does not send a command", async () => {
  const boiler = device("boiler", "boiler", { hvac_mode: "heat" });
  const radiator = device("radiator", "radiator", { hvac_mode: "heat", temperature: 21, current_temperature: 19 });
  const store = fakeStore({ ...DEFAULT_HEATING_DEMAND_CONFIG, enabled: true, boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"] }, { commandPending: { desiredMode: "heat" }, lastPhysicalActuationVerifiedAt: "2026-09-05T11:00:00.000Z" });
  let writes = 0;
  const controller = new HeatingDemandController({ store, getDevices: () => [boiler, radiator], getIntegrations: () => ({}), executeAction: async () => { writes += 1; }, now: () => NOW });
  assert.equal(controller.status().runtime.commandPending, null);
  await controller.start();
  assert.equal(store.getHeatingDemandController().runtime.commandPending, null);
  assert.equal(writes, 0);
  controller.stop();
});

test("command failures use a bounded exponential retry window", async () => {
  const boiler = device("boiler", "boiler", { hvac_mode: "off" });
  const radiator = device("radiator", "radiator", { hvac_mode: "heat", temperature: 21, current_temperature: 19 });
  const store = fakeStore({ ...DEFAULT_HEATING_DEMAND_CONFIG, enabled: true, boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"], requestTemperatureEnabled: false });
  let now = NOW;
  let writes = 0;
  const controller = new HeatingDemandController({
    store,
    getDevices: () => [boiler, radiator],
    getIntegrations: () => ({}),
    executeAction: async () => { writes += 1; throw Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }); },
    now: () => now,
    activity: { record: async () => {} },
  });
  await controller.evaluate({ execute: true });
  const firstFailure = store.getHeatingDemandController().runtime;
  assert.equal(writes, 1);
  assert.equal(firstFailure.consecutiveFailures, 1);
  assert.equal(firstFailure.retryDelaySeconds, 15);
  assert.ok(firstFailure.nextRetryAt);
  await controller.evaluate({ execute: true });
  assert.equal(writes, 1);
  now += 15_000;
  await controller.evaluate({ execute: true });
  const secondFailure = store.getHeatingDemandController().runtime;
  assert.equal(writes, 2);
  assert.equal(secondFailure.consecutiveFailures, 2);
  assert.equal(secondFailure.retryDelaySeconds, 30);
  assert.ok(secondFailure.nextRetryAt);
});

test("store-side mapping cleanup disables safely when a mapped device disappears", async () => {
  const store = fakeStore({ ...DEFAULT_HEATING_DEMAND_CONFIG, enabled: true, boilerDeviceId: "boiler", radiatorDeviceIds: ["radiator"] });
  const controller = new HeatingDemandController({ store, getDevices: () => [], activity: { record: async () => {} }, now: () => NOW });
  await controller.syncMappings();
  const saved = store.getHeatingDemandController();
  assert.equal(saved.config.enabled, false);
  assert.equal(saved.config.boilerDeviceId, null);
  assert.deepEqual(saved.config.radiatorDeviceIds, []);
});
