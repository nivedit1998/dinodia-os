const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createHub } = require("../src/server");
const { sign } = require("../src/platformPairing");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}
function dashboardRoute(route) { return `/_dinodia/admin${route}`; }

test("dashboard provisioning pairs the hub and rotates the 8099 bearer token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-provisioning-"));
  const serial = "hub-provisioning-test";
  const bootstrapSecret = "bootstrap-secret";
  const syncSecret = "sync-secret";
  const tokenOne = "token-one-for-provisioning-test";
  const tokenTwo = "token-two-for-provisioning-test";
  let syncCalls = 0;
  const platform = http.createServer(async (req, res) => {
    const body = await new Promise((resolve) => { let value = ""; req.on("data", (chunk) => { value += chunk; }); req.on("end", () => resolve(JSON.parse(value || "{}"))); });
    const expectedSecret = req.url.endsWith("/pair") ? bootstrapSecret : syncSecret;
    assert.equal(body.sig, sign(expectedSecret, body.serial, body.ts, body.nonce));
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const response = req.url.endsWith("/pair")
      ? { ok: true, syncSecret, latestVersion: 1, publishedVersion: 0, hubTokenHashes: [hash(tokenOne)] }
      : (++syncCalls === 1 ? { ok: true, latestVersion: 1, publishedVersion: 1, hubTokenHashes: [hash(tokenOne)] } : { ok: true, latestVersion: 2, publishedVersion: 2, hubTokenHashes: [hash(tokenTwo)] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${platform.address().port}`;
  const hub = createHub({
    config: { nodeEnv: "production", adminToken: "provisioning-admin", haToken: "configured-ha-token-that-must-not-be-redisplayed", hubId: serial, platformApiUrl: platformUrl, port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const dashboardBase = `http://127.0.0.1:${hub.server.address().port}`;
  const provisioning = await request(dashboardBase, dashboardRoute("/api/provisioning"), { headers: { authorization: "Bearer provisioning-admin" } });
  assert.equal(provisioning.response.status, 200);
  assert.equal(provisioning.body.credentials.oneTimeLongLivedToken, undefined);
  const pair = await request(dashboardBase, dashboardRoute("/api/provisioning/pair"), { method: "POST", headers: { authorization: "Bearer provisioning-admin" }, body: JSON.stringify({ bootstrapSecret }) });
  assert.equal(pair.response.status, 200);
  assert.equal(pair.body.paired, true);
  assert.equal(hub.store.getPlatform().acceptedTokenHashes.length, 1);
  const agentBase = `http://127.0.0.1:${hub.hubAgentServer.address().port}`;
  const accepted = await request(agentBase, "/api/", { headers: { authorization: `Bearer ${tokenOne}` } });
  assert.equal(accepted.response.status, 200);
  const invalid = await request(agentBase, "/api/", { headers: { authorization: "Bearer not-a-token" } });
  assert.equal(invalid.response.status, 401);
  await hub.pairing.syncNow();
  const newToken = await request(agentBase, "/api/", { headers: { authorization: `Bearer ${tokenTwo}` } });
  assert.equal(newToken.response.status, 200);
  const expired = await request(agentBase, "/api/", { headers: { authorization: `Bearer ${tokenOne}` } });
  assert.equal(expired.response.status, 401);
  await hub.stop();
  await new Promise((resolve) => platform.close(resolve));
});
