const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}
function dashboardRoute(route) { return `/_dinodia/admin${route}`; }

test("locked setup page serves its JavaScript without dashboard authentication", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-setup-assets-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "setup-assets-admin", haToken: "setup-assets-ha", port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const page = await fetch(`${base}/setup`);
    assert.equal(page.status, 200);
    const script = await fetch(`${base}/setup.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") || "", /javascript/);
    assert.match(await script.text(), /_dinodia\/setup\/pairing/);
    assert.match(await (await fetch(`${base}/setup.js`)).text(), /window\.location\.assign\(destination\)/);
  } finally {
    await hub.stop();
  }
});

test("locked setup sends CSRF on its status read and reports a valid hub identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-setup-status-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "setup-status-admin", haToken: "setup-status-ha", hubId: "setup-status-hub", port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const base = "http://127.0.0.1:" + hub.server.address().port;
  try {
    const page = await fetch(base + "/setup");
    const cookies = page.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
    const cookieHeader = cookies.join("; ");
    const csrf = cookies.find((value) => value.startsWith("dinodia_setup_csrf="))?.slice("dinodia_setup_csrf=".length);
    assert.ok(csrf);
    const withoutCsrf = await fetch(base + "/_dinodia/setup/status", { headers: { cookie: cookieHeader } });
    assert.equal(withoutCsrf.status, 403);
    const withCsrf = await fetch(base + "/_dinodia/setup/status", { headers: { cookie: cookieHeader, "x-dinodia-setup-csrf": csrf } });
    assert.equal(withCsrf.status, 200);
    const body = await withCsrf.json();
    assert.equal(body.ok, true);
    assert.equal(body.identity.serial, "setup-status-hub");
    assert.match(await (await fetch(base + "/setup.js")).text(), /_dinodia\/setup\/status[\s\S]*?x-dinodia-setup-csrf/);
  } finally {
    await hub.stop();
  }
});

test("paired operator bootstrap can start over the private LAN before Cloudflare verification", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-local-operator-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "local-operator-admin", haToken: "local-operator-ha", port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const page = await fetch(`${base}/support-access`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("set-cookie") || "", /dinodia_operator_binding=/);
  } finally {
    await hub.stop();
  }
});

test("restricted setup listener exposes the authenticated operator handoff page", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-setup-operator-listener-"));
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "operator-listener-admin", haToken: "operator-listener-ha", port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  await new Promise((resolve, reject) => {
    hub.setupServer.once("error", reject);
    hub.setupServer.listen(0, "127.0.0.1", resolve);
  });
  const address = hub.setupServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${base}/support-access`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(page.headers.getSetCookie().join("; "), /dinodia_operator_binding=/);
    assert.match(await page.text(), /<title>Dinodia OS setup<\/title>/);
    const script = await fetch(`${base}/setup.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /dinodia-operator-attempt/);
  } finally {
    await hub.stop();
  }
});

test("secure Cloudflare setup page serves the non-secret handoff script", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-remote-setup-assets-"));
  const hub = createHub({
    config: { nodeEnv: "production", adminToken: "remote-assets-admin", port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "", cloudflarePublicHostname: "secure.example.test" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: true, connected: true, running: true, mode: "local", hostname: "secure.example.test", publicUrl: "https://secure.example.test" }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { host: "secure.example.test", origin: "https://secure.example.test", "x-forwarded-proto": "https" };
  try {
    const page = await fetch(`${base}/support-access`, { headers });
    assert.equal(page.status, 200);
    const script = await fetch(`${base}/setup.js`, { headers });
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") || "", /javascript/);
    assert.match(await script.text(), /dinodia-operator-handoff/);
  } finally {
    await hub.stop();
  }
});

test("retired HA, hub-agent and bootstrap routes stay absent while Native V2 setup remains available", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-only-routes-"));
  const hub = createHub({
    config: { nodeEnv: "production", hubId: "native-only-routes", port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    assert.equal(Object.hasOwn(hub, "hubAgentServer"), false);
    for (const path of ["/api/states", "/api/services/light/turn_on", "/api/config", "/_dinodia/platform/v1/alexa/catalog"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, `${path} is not an application compatibility route`);
    }
    assert.equal((await fetch(`${base}/_dinodia/admin/api/provisioning/pair`, { method: "POST" })).status, 401);
    assert.match(await (await fetch(`${base}/setup.js`)).text(), /_dinodia\/setup\/pairing/);
  } finally {
    await hub.stop();
  }
});
