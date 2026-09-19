const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { SecretVault } = require("../src/secretVault");
const { GoogleNestBridge } = require("../src/integrations/googleNest/googleNestBridge");
const { selectLegacyGoogleNestDevice } = require("../src/integrations/googleNest/deviceReconciliation");

function apiResponse(body, status = 200) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }; }
function updateSource() { return { scheduled: 0, stopped: 0, schedule() { this.scheduled += 1; }, stop() { this.stopped += 1; }, status() { return { nextPollAt: null, inFlight: false }; } }; }

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-google-nest-bridge-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const vault = new SecretVault({ dataDir: directory });
  await vault.set("integration:google-nest:developer:v1", JSON.stringify({ deviceAccessProjectId: "project-1", oauthClientId: "client-1", oauthClientSecret: "client-secret", registeredRedirectUri: "https://hub.example/_dinodia/oauth/google-nest/callback", releaseChannel: "sandbox_beta" }));
  await vault.set("integration:google-nest:account:v1", JSON.stringify({ refreshToken: "refresh-1", grantedScope: "https://www.googleapis.com/auth/sdm.service" }));
  await store.saveGoogleNest({ configured: true, status: "connected", releaseChannel: "sandbox_beta" });
  return { directory, store, vault };
}

test("Google Nest bridge restores an account, polls once, and keeps tokens out of status", async () => {
  const { store, vault } = await setup();
  const fixture = { devices: [{ name: "enterprises/project-1/devices/t1", type: "sdm.devices.types.THERMOSTAT", traits: { "sdm.devices.traits.Info": { customName: "Boiler" }, "sdm.devices.traits.Connectivity": { status: "ONLINE" }, "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] }, "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21 } } }] };
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); if (String(url).includes("/token")) return apiResponse({ access_token: "access-1", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" }); return apiResponse(fixture); };
  const source = updateSource();
  const bridge = new GoogleNestBridge({ store, vault, config: { googleNestEnabled: true, googleNestOperationTimeoutMs: 2000, googleNestRefreshSkewMs: 300000, googleNestMaxDevices: 100, googleNestReleaseChannel: "sandbox_beta" }, fetchImpl, updateSource: source, onSnapshot: async ({ devices }) => { for (const device of devices) await store.upsertDevice(device); } });
  await bridge.start();
  assert.equal(store.listDevices().length, 1);
  assert.equal(bridge.status().status, "connected");
  assert.equal(JSON.stringify(bridge.status()).includes("access-1"), false);
  assert.equal(calls.filter((call) => call.url.includes("/token")).length, 1);
  assert.equal(source.scheduled, 1);
});

test("Google Nest bridge command confirms authoritative state and tombstones removal", async () => {
  const { store, vault } = await setup();
  const raw = { name: "enterprises/project-1/devices/t1", type: "sdm.devices.types.THERMOSTAT", traits: { "sdm.devices.traits.Info": { customName: "Boiler" }, "sdm.devices.traits.Connectivity": { status: "ONLINE" }, "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] }, "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21 } } };
  const calls = [];
  const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); if (String(url).includes("/token")) return apiResponse({ access_token: "access-1", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" }); if (String(url).includes(":executeCommand")) return apiResponse({ results: [] }); if (String(url).includes("/devices/t1")) return apiResponse(raw); return apiResponse({ devices: [raw] }); };
  const bridge = new GoogleNestBridge({ store, vault, config: { googleNestEnabled: true, googleNestOperationTimeoutMs: 2000, googleNestRefreshSkewMs: 300000, googleNestMaxDevices: 100 }, fetchImpl, updateSource: updateSource(), onSnapshot: async ({ devices }) => { for (const device of devices) await store.upsertDevice(device); } });
  await bridge.start();
  const device = store.listDevices()[0];
  assert.ok(device, `expected discovered device; bridge status=${JSON.stringify(bridge.status())}`);
  assert.equal(device.protocol, "google_nest");
  await bridge.command(device, "climate.set_temperature", { temperature: 22 });
  assert.equal(calls.some((call) => call.url.includes(":executeCommand") && call.options.body.includes("heatCelsius")), true);
  await bridge.ignoreDevice(device);
  await store.deleteDevice(device.id);
  assert.equal(store.listDevices().length, 0);
  const status = bridge.status();
  assert.equal(status.ignoredDeviceCount, 1);
  assert.equal(status.ignoredDevices[0].name, "Boiler");
});

test("Google Nest command recovers a retired SDM resource before retrying once", async () => {
  const { store, vault } = await setup();
  const oldResource = "enterprises/project-1/devices/old-resource";
  const newResource = "enterprises/project-1/devices/new-resource";
  const oldRaw = { name: oldResource, type: "sdm.devices.types.THERMOSTAT", parentRelations: [{ displayName: "Entryway" }], traits: { "sdm.devices.traits.Info": { customName: "Entryway" }, "sdm.devices.traits.Connectivity": { status: "ONLINE" }, "sdm.devices.traits.Temperature": { ambientTemperatureCelsius: 20 }, "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] }, "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21 }, "sdm.devices.traits.ThermostatHvac": { status: "OFF" } } };
  const newRaw = { ...oldRaw, name: newResource };
  let tokenCalls = 0;
  let listCalls = 0;
  const executeResources = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("/token")) return apiResponse({ access_token: `access-${++tokenCalls}`, expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" });
    if (value.includes(":executeCommand")) {
      executeResources.push(value);
      if (value.includes("old-resource")) return apiResponse({ error: { message: "retired resource" } }, 404);
      return apiResponse({ results: [] });
    }
    if (value.includes("/devices/old-resource")) return apiResponse({ error: { message: "retired resource" } }, 404);
    if (value.includes("/devices/") && value.includes("new-resource")) return apiResponse(newRaw);
    if (value.endsWith("/devices")) return apiResponse({ devices: [listCalls++ < 2 ? oldRaw : newRaw] });
    return apiResponse({ devices: [newRaw] });
  };
  const bridge = new GoogleNestBridge({
    store,
    vault,
    config: { googleNestEnabled: true, googleNestOperationTimeoutMs: 2000, googleNestRefreshSkewMs: 300000, googleNestMaxDevices: 100 },
    fetchImpl,
    updateSource: updateSource(),
    onSnapshot: async ({ devices }) => {
      for (const incoming of devices) {
        const existing = selectLegacyGoogleNestDevice({ incoming, incomingDevices: devices, existingDevices: store.listDevices(), usedIds: new Set() });
        if (existing && existing.id !== incoming.id) await store.migrateDeviceIdentity(existing.id, incoming.id, incoming);
        else await store.upsertDevice(incoming);
      }
    },
  });
  await bridge.start();
  const oldDevice = store.listDevices()[0];
  await bridge.command(oldDevice, "climate.set_temperature", { temperature: 22 });
  assert.equal(tokenCalls, 3);
  assert.equal(executeResources.length, 2);
  assert.match(executeResources[0], /old-resource:executeCommand$/);
  assert.match(executeResources[1], /new-resource:executeCommand$/);
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listDevices()[0].protocolIdentity.resourceName, newResource);
  assert.equal(store.getDevice(oldDevice.id).protocolIdentity.resourceName, newResource);
});

test("Google Nest command failures do not crash the hub through an unhandled lock rejection", async () => {
  const { store, vault } = await setup();
  const raw = { name: "enterprises/project-1/devices/retired", type: "sdm.devices.types.THERMOSTAT", parentRelations: [{ displayName: "Entryway" }], traits: { "sdm.devices.traits.Info": { customName: "Entryway" }, "sdm.devices.traits.Connectivity": { status: "ONLINE" }, "sdm.devices.traits.Temperature": { ambientTemperatureCelsius: 20 }, "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] }, "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21 } } };
  let commandAttempts = 0;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/token")) return apiResponse({ access_token: `access-${Date.now()}`, expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" });
    if (value.includes(":executeCommand")) { commandAttempts += 1; return apiResponse({ error: { message: "retired resource" } }, 404); }
    if (value.endsWith("/devices")) return apiResponse({ devices: [raw] });
    return apiResponse(raw);
  };
  const bridge = new GoogleNestBridge({ store, vault, config: { googleNestEnabled: true, googleNestOperationTimeoutMs: 2000, googleNestRefreshSkewMs: 300000, googleNestMaxDevices: 100 }, fetchImpl, updateSource: updateSource(), onSnapshot: async ({ devices }) => { for (const device of devices) await store.upsertDevice(device); } });
  await bridge.start();
  await assert.rejects(() => bridge.command(store.listDevices()[0], "climate.set_temperature", { temperature: 22 }), (error) => error.code === "device_discovery_failed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commandAttempts, 1);
  assert.equal(bridge.commandLocks.size, 0);
});

test("Google Nest bridge refreshes once after a 401 and retries the command without local rate-limit collision", async () => {
  const { store, vault } = await setup();
  const raw = { name: "enterprises/project-1/devices/t1", type: "sdm.devices.types.THERMOSTAT", traits: { "sdm.devices.traits.Info": { customName: "Boiler" }, "sdm.devices.traits.Connectivity": { status: "ONLINE" }, "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] }, "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21 } } };
  let refreshes = 0;
  let commands = 0;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/token")) return apiResponse({ access_token: "access-" + (++refreshes), expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" });
    if (value.includes(":executeCommand")) {
      commands += 1;
      return commands === 1 ? apiResponse({ error: { message: "expired" } }, 401) : apiResponse({ results: [] });
    }
    if (value.includes("/devices/t1")) return apiResponse(raw);
    return apiResponse({ devices: [raw] });
  };
  const bridge = new GoogleNestBridge({ store, vault, config: { googleNestEnabled: true, googleNestOperationTimeoutMs: 2000, googleNestRefreshSkewMs: 300000, googleNestMaxDevices: 100 }, fetchImpl, updateSource: updateSource(), onSnapshot: async ({ devices }) => { for (const device of devices) await store.upsertDevice(device); } });
  await bridge.start();
  await bridge.command(store.listDevices()[0], "climate.turn_on", {});
  assert.equal(commands, 2);
  assert.equal(refreshes, 2);
});
