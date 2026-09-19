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
  return {
    start() {},
    async stop() {},
    status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; },
    async disconnect() { return this.status(); },
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test("activity API is authenticated, filterable, paginated, and emits live records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-api-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "test-token", dataFile: path.join(directory, "dinodia.json"), dataDir: directory, backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const unauthorized = await request(base, "/_dinodia/admin/api/activity");
  assert.equal(unauthorized.response.status, 401);
  const headers = { authorization: "Bearer test-token" };
  const area = await request(base, "/_dinodia/admin/api/areas", { method: "POST", headers, body: JSON.stringify({ name: "Kitchen" }) });
  const liveRecord = new Promise((resolve) => hub.eventBus.once("dinodia_activity_created", resolve));
  const device = await request(base, "/_dinodia/admin/api/devices", { method: "POST", headers, body: JSON.stringify({ id: "activity-lamp", name: "Kitchen lamp", protocol: "virtual", areaId: area.body.id, state: { power: "OFF" } }) });
  assert.equal(device.response.status, 201);
  assert.equal((await liveRecord).type, "device_discovered");
  const activity = await request(base, "/_dinodia/admin/api/activity?limit=50&deviceId=activity-lamp", { headers });
  assert.equal(activity.response.status, 200);
  assert.equal(activity.body.records.some((record) => record.device?.name === "Kitchen lamp"), true);
  assert.equal(activity.body.records.every((record) => record.device?.id === "activity-lamp"), true);
  assert.equal(Array.isArray(activity.body.filters.devices), true);
  const removed = await request(base, "/_dinodia/admin/api/devices/activity-lamp", { method: "DELETE", headers, body: "{}" });
  assert.equal(removed.response.status, 200);
  const removedActivity = await request(base, "/_dinodia/admin/api/activity?deviceId=activity-lamp", { headers });
  assert.equal(removedActivity.body.records.some((record) => record.type === "device_unpaired" && record.device?.name === "Kitchen lamp"), true);
  await hub.stop();
});
