const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");

function mockIntegration() {
  return {
    start() {},
    close() {},
    status() { return { configured: false, connected: false, lastError: null }; },
    async command() {},
    async refresh() { return []; },
  };
}

function mockCloudflare() {
  let current = { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null };
  return {
    start() {},
    async stop() {},
    status() { return current; },
    async startQuick() { current = { ...current, configured: true, connected: true, running: true, mode: "quick", publicUrl: "https://test.trycloudflare.com" }; return current; },
    async configure({ hostname }) { current = { ...current, configured: true, connected: true, running: true, mode: "named", publicUrl: hostname ? `https://${hostname}` : "" }; return current; },
    async disconnect() { current = { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; return current; },
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { "content-type": "application/json", connection: "close", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
function dashboardRoute(route) { return `/_dinodia/admin${route}`; }

test("HTTP API protects writes and controls a virtual device", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-http-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const unauthorized = await request(base, dashboardRoute("/api/status"));
  assert.equal(unauthorized.response.status, 401);
  const health = await request(base, "/api/health");
  assert.equal(health.response.status, 200);
  const headers = { authorization: "Bearer test-token" };
  const adapters = await request(base, dashboardRoute("/api/integrations/zigbee/adapters"), { headers });
  assert.equal(Array.isArray(adapters.body.adapters), true);
  const invalidAdapter = await request(base, dashboardRoute("/api/integrations/zigbee/adapter"), { method: "POST", headers, body: JSON.stringify({ path: "/dev/not-connected" }) });
  assert.equal(invalidAdapter.response.status, 400);
  const quickLink = await request(base, dashboardRoute("/api/integrations/cloudflare"), { method: "POST", headers, body: JSON.stringify({ action: "quick" }) });
  assert.equal(quickLink.body.publicUrl, "https://test.trycloudflare.com");
  const area = await request(base, dashboardRoute("/api/areas"), { method: "POST", headers, body: JSON.stringify({ name: "Kitchen" }) });
  const label = await request(base, dashboardRoute("/api/labels"), { method: "POST", headers, body: JSON.stringify({ name: "Lights" }) });
  const created = await request(base, dashboardRoute("/api/devices"), { method: "POST", headers, body: JSON.stringify({ id: "lamp", name: "Lamp", protocol: "virtual", state: { power: "OFF" } }) });
  assert.equal(created.response.status, 201);
  const updated = await request(base, dashboardRoute("/api/devices/lamp"), { method: "PUT", headers, body: JSON.stringify({ name: "Kitchen lamp", areaId: area.body.id }) });
  assert.equal(updated.body.areaId, area.body.id);
  const entityId = encodeURIComponent("lamp:power");
  const entity = await request(base, dashboardRoute(`/api/devices/lamp/entities/${entityId}`), { method: "PUT", headers, body: JSON.stringify({ name: "Lamp power", labelIds: [label.body.id] }) });
  assert.equal(entity.body.name, "Lamp power");
  assert.deepEqual(entity.body.labelIds, [label.body.id]);
  await request(base, dashboardRoute("/api/devices"), { method: "POST", headers, body: JSON.stringify({ id: "fan", name: "Fan", protocol: "virtual", state: { power: "OFF" } }) });
  const automation = await request(base, dashboardRoute("/api/automations"), { method: "POST", headers, body: JSON.stringify({ name: "Lamp to fan", trigger: { deviceId: "lamp", field: "power", equals: "ON" }, actions: [{ deviceId: "fan", command: { state: { power: "ON" } } }] }) });
  assert.equal(automation.response.status, 201);
  const changed = await request(base, dashboardRoute("/api/devices/lamp/command"), { method: "POST", headers, body: JSON.stringify({ state: { power: "ON" } }) });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.state.power, "ON");
  const fan = await request(base, dashboardRoute("/api/devices/fan"), { headers });
  assert.equal(fan.body.state.power, "ON");
  const deleted = await request(base, dashboardRoute(`/api/automations/${automation.body.id}`), { method: "DELETE", headers });
  assert.equal(deleted.response.status, 204);
  const status = await request(base, dashboardRoute("/api/status"), { headers });
  assert.equal(status.body.devices, 2);
  await hub.stop();
});

test("removing the configured Zigbee dongle stops the runtime, clears its selection, and preserves devices", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-zigbee-remove-"));
  const adapterPath = "/dev/serial/by-id/usb-Home_Assistant_Connect_ZBT-1";
  let removed = false;
  const zigbeeService = {
    start() {},
    close() {},
    status() { return { configured: true, available: true, service: "zigbee2mqtt", state: removed ? "not-created" : "running", running: !removed }; },
    async applyConfiguration() { return { ok: true, skipped: true }; },
    async remove() { removed = true; return { ok: true, ...this.status() }; },
  };
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
    zigbeeService,
    serialAdapterLister: async () => [{ path: adapterPath, target: "/dev/ttyACM0", name: "Home Assistant Connect ZBT-1", adapterType: "ember", supported: true, connected: true }],
  });
  await hub.store.saveZigbee({ adapterPath, adapterName: "Home Assistant Connect ZBT-1", adapterType: "ember" });
  await hub.store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
  await hub.store.upsertDevice({ id: "lamp", name: "Kitchen lamp", protocol: "zigbee", state: { power: "OFF" } });
  const configurationPath = path.join(directory, "zigbee2mqtt", "configuration.yaml");
  await fs.mkdir(path.dirname(configurationPath), { recursive: true });
  await fs.writeFile(configurationPath, "serial:\n  port: /dev/serial/by-id/usb-Home_Assistant_Connect_ZBT-1\n");

  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const result = await request(base, dashboardRoute("/api/integrations/zigbee/adapter"), { method: "DELETE", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ path: adapterPath }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.removed.path, adapterPath);
  assert.equal(removed, true);
  assert.equal(hub.store.getZigbee().adapterPath, "");
  assert.equal(hub.store.getConfigEntries().ce_zigbee, undefined);
  assert.equal(hub.store.getDevice("lamp").name, "Kitchen lamp");
  assert.equal(await fs.access(configurationPath).then(() => true).catch(() => false), false);
  assert.match(result.body.archivedConfigurationPath, /configuration\.yaml\.removed-/);
  assert.equal(result.body.rescanAvailable, true);
  const availableAgain = await request(base, dashboardRoute("/api/integrations/zigbee/adapters"), { headers: { authorization: "Bearer test-token" } });
  assert.deepEqual(availableAgain.body.adapters.map((adapter) => adapter.path), [adapterPath]);
  assert.equal(availableAgain.body.selected, null);
  const selectedAgain = await request(base, dashboardRoute("/api/integrations/zigbee/adapter"), { method: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ path: adapterPath }) });
  assert.equal(selectedAgain.response.status, 200);
  assert.equal(hub.store.getZigbee().adapterPath, adapterPath);
  await hub.stop();
});

test("removing a detached environment-configured Zigbee dongle clears the fallback selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-zigbee-detached-remove-"));
  const adapterPath = "/dev/serial/by-id/usb-detached-coordinator";
  let removed = false;
  const zigbeeService = {
    start() {},
    close() {},
    status() { return { configured: true, available: true, service: "zigbee2mqtt", state: removed ? "not-created" : "restarting", running: false }; },
    async remove() { removed = true; return { ok: true, alreadyStopped: true, ...this.status() }; },
  };
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "", zigbeeAdapterPath: adapterPath },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
    zigbeeService,
    serialAdapterLister: async () => [],
  });
  await hub.store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });

  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { authorization: "Bearer test-token" };
  const result = await request(base, dashboardRoute("/api/integrations/zigbee/adapter"), { method: "DELETE", headers, body: JSON.stringify({ path: adapterPath }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(removed, true);
  assert.equal(hub.store.getZigbee().adapterPath, "");
  assert.deepEqual(hub.store.getZigbee().removedAdapterPaths, [adapterPath]);
  const adapters = await request(base, dashboardRoute("/api/integrations/zigbee/adapters"), { headers });
  assert.equal(adapters.body.selected, null);
  assert.deepEqual(adapters.body.adapters, []);
  assert.equal(hub.store.getConfigEntries().ce_zigbee, undefined);
  await hub.stop();
});

test("selecting a Thread RCP starts OTBR at 460800 and keeps it separate from Zigbee", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-thread-http-"));
  const zigbeePath = "/dev/serial/by-id/usb-sonoff-zigbee";
  const threadPath = "/dev/serial/by-id/usb-sonoff-thread";
  let startOptions;
  const threadService = {
    start() {},
    close() {},
    status() { return { configured: true, available: true, service: "otbr", state: startOptions ? "running" : "not-created", running: Boolean(startOptions) }; },
    async start(options) { startOptions = options; return { ok: true, running: true }; },
    async remove() { return { ok: true, running: false }; },
  };
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
    threadService,
    serialAdapterLister: async () => [
      { path: zigbeePath, name: "SONOFF Zigbee MG21", adapterType: "ember", supported: true, connected: true },
      { path: threadPath, name: "SONOFF Thread MG21", adapterType: "ember", supported: true, connected: true },
    ],
  });
  await hub.store.saveZigbee({ adapterPath: zigbeePath, adapterName: "SONOFF Zigbee MG21", adapterType: "ember" });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { authorization: "Bearer test-token" };
  const available = await request(base, dashboardRoute("/api/integrations/thread/adapters"), { headers });
  assert.deepEqual(available.body.adapters.map((adapter) => adapter.path), [threadPath]);
  const result = await request(base, dashboardRoute("/api/integrations/thread/adapter"), { method: "POST", headers, body: JSON.stringify({ path: threadPath }) });
  assert.equal(result.response.status, 200);
  assert.equal(startOptions.rcpDevice, threadPath);
  assert.equal(startOptions.baudRate, 460800);
  assert.equal(startOptions.infraIf, "eth0");
  assert.equal(startOptions.threadIf, "wpan0");
  assert.equal(result.body.hardwareFlowControl, false);
  assert.equal(hub.store.getThread().rcpDevice, threadPath);
  const zigbee = await request(base, dashboardRoute("/api/integrations/zigbee/adapters"), { headers });
  assert.deepEqual(zigbee.body.adapters.map((adapter) => adapter.path), [zigbeePath]);
  const removed = await request(base, dashboardRoute("/api/integrations/thread/adapter"), { method: "DELETE", headers, body: JSON.stringify({ path: threadPath }) });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.rescanAvailable, true);
  const threadAvailableAgain = await request(base, dashboardRoute("/api/integrations/thread/adapters"), { headers });
  assert.deepEqual(threadAvailableAgain.body.adapters.map((adapter) => adapter.path), [threadPath]);
  assert.equal(threadAvailableAgain.body.selected, null);
  const selectedAgain = await request(base, dashboardRoute("/api/integrations/thread/adapter"), { method: "POST", headers, body: JSON.stringify({ path: threadPath }) });
  assert.equal(selectedAgain.response.status, 200);
  assert.equal(hub.store.getThread().rcpDevice, threadPath);
  await hub.stop();
});
