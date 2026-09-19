const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub, hiveCredentialTransportAllowed } = require("../src/server");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() { return []; } };
}

function mockCloudflare() {
  return { start() {}, async stop() {}, status() { return { configured: true, connected: true, hostname: "hub.example.com", publicUrl: "https://hub.example.com" }; } };
}

function fakeHive() {
  let current = { enabled: true, configured: false, status: "disconnected", maskedUsername: "", heatingDeviceCount: 0 };
  return {
    status: () => ({ ...current }),
    start() {},
    async close() {},
    async connect({ username }) { current = { ...current, configured: true, status: "connected", maskedUsername: `${String(username)[0]}***@example.com`, heatingDeviceCount: 1 }; return { status: "connected", discovered: 1, needsSetup: [] }; },
    async submitMfa() { return { status: "connected", discovered: 1, needsSetup: [] }; },
    cancelSetup() { return true; },
    async refresh() { return { heatingDeviceCount: current.heatingDeviceCount }; },
    async restoreDevice() { return true; },
    async disconnect() { current = { enabled: true, configured: false, status: "disconnected", heatingDeviceCount: 0 }; return { ok: true, remote: { supported: false, deregistered: false } }; },
    async command() {},
    async ignoreDevice() {},
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", connection: "close", authorization: "Bearer test-token", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}

test("Hive credential endpoints require secure remote production transport and never return credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-hive-api-"));
  const hub = createHub({
    config: { nodeEnv: "production", adminToken: "test-token", cloudflarePublicHostname: "hub.example.com", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    hiveBridge: fakeHive(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const route = "/_dinodia/admin/api/integrations/hive/connect";
  assert.equal(hiveCredentialTransportAllowed({ headers: { host: "wrong.example.com", origin: "http://wrong.example.com" }, socket: { remoteAddress: "192.168.1.10" } }, { nodeEnv: "production", configuredHostname: "hub.example.com" }), false);
  assert.equal(hiveCredentialTransportAllowed({ headers: { host: "hub.example.com", origin: "https://hub.example.com" }, socket: { remoteAddress: "192.168.1.10" } }, { nodeEnv: "production", configuredHostname: "hub.example.com" }), false);
  assert.equal(hiveCredentialTransportAllowed({ headers: { host: "hub.example.com", "x-forwarded-proto": "https" }, socket: { remoteAddress: "192.168.1.10" } }, { nodeEnv: "production", configuredHostname: "hub.example.com" }), true);

  const secure = await request(base, route, { method: "POST", headers: { host: "hub.example.com", origin: "https://hub.example.com", "x-forwarded-proto": "https" }, body: JSON.stringify({ username: "owner@example.com", password: "secret" }) });
  assert.equal(secure.response.status, 200);
  assert.equal(JSON.stringify(secure.body).includes("secret"), false);
  const status = await request(base, "/_dinodia/admin/api/integrations/hive");
  assert.equal(status.body.configured, true);
  assert.equal(status.body.maskedUsername, "o***@example.com");
  assert.equal(JSON.stringify(status.body).includes("owner@example.com"), false);
  const disconnected = await request(base, "/_dinodia/admin/api/integrations/hive/account", { method: "DELETE", body: JSON.stringify({}) });
  assert.equal(disconnected.response.status, 200);
  assert.equal(disconnected.body.ok, true);
  await hub.stop();
});
