const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createHub } = require("../src/server");
const crypto = require("node:crypto");
const { createOperatorSessionToken } = require("../src/auth/operatorSession");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

function appToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-APP-1" })}.${encode(claims)}`;
  return `dno-app-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}

test("production rejects legacy admin, HA, bootstrap and dashboard credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-stage1-production-boundary-"));
  const hub = createHub({
    config: { nodeEnv: "production", adminToken: "legacy-admin-secret", haToken: "legacy-ha-secret", platformBootstrapSecret: "legacy-bootstrap-secret", port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    for (const token of ["legacy-admin-secret", "legacy-ha-secret", "legacy-bootstrap-secret"]) {
      assert.equal((await request(base, "/_dinodia/admin/api/status", { headers: { authorization: `Bearer ${token}` } })).response.status, 401);
      assert.equal((await request(base, "/api/states", { headers: { authorization: `Bearer ${token}` } })).response.status, 401);
      assert.equal((await request(base, "/_dinodia/admin/api/provisioning/pair", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ bootstrapSecret: token }) })).response.status, 401);
    }
    assert.equal((await request(base, "/_dinodia/admin/api/status")).response.status, 401);
    assert.equal((await request(base, "/api/health")).response.status, 200);

    const socket = new WebSocket(`${base.replace("http", "ws")}/api/websocket`);
    const messages = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => socket.once("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    socket.send(JSON.stringify({ type: "auth", access_token: "legacy-admin-secret" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(messages.some((message) => message.type === "auth_ok"), false);
    assert.equal(messages.some((message) => message.type === "auth_invalid"), true);
    socket.close();
  } finally {
    await hub.stop();
  }
});

test("production app authorization is scoped and owners cannot command the hub", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-stage1-app-scope-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hub = createHub({
    config: { nodeEnv: "production", appPublicKeys: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId: "app-scope-hub", port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = appToken({ iss: "dinodia-platform", aud: "dinodia-hub:app-scope-hub", sub: "user:22", sid: "sid-1", jti: "jti-1", membershipId: "membership-1", trustedDeviceId: "trusted-1", hubInstallId: "app-scope-hub", iat: now, exp: now + 300, homeId: 7, householdRole: "OWNER", areaIds: ["area-1"], policyRevision: 1, scope: ["tenant:device-command"] }, keys.privateKey);
    const allowedRead = await request(base, "/_dinodia/admin/api/devices", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(allowedRead.response.status, 200, JSON.stringify(allowedRead.body));
    const forbiddenAdmin = await request(base, "/_dinodia/admin/api/integrations/alexa", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(forbiddenAdmin.response.status, 403);
    const forbiddenOwnerCommand = await request(base, "/_dinodia/admin/api/entities/missing/service", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ serviceId: "light.turn_on" }) });
    assert.notEqual(forbiddenOwnerCommand.response.status, 401);
    assert.notEqual(forbiddenOwnerCommand.response.status, 200);
  } finally {
    await hub.stop();
  }
});

test("support operator sessions are read-only and cannot leak private tenant devices", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-stage1-support-scope-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hubId = "support-scope-hub";
  const hub = createHub({
    config: { nodeEnv: "production", hubId, operatorPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.upsertDevice({ id: "property-light", name: "Property light", protocol: "virtual", areaId: "area-1", metadata: { label: "Light" } });
  await hub.store.upsertDevice({ id: "private-lamp", name: "Tenant lamp", protocol: "virtual", areaId: "area-1", metadata: { label: "tenant_device", tenantOwnerId: "tenant-42" } });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const token = createOperatorSessionToken({ sub: "employee-support", hubId, scope: ["os:support"], supportScope: "PROPERTY_SCOPE", areaIds: ["area-1"], includesTenantDevices: false, recentAuthAt: Date.now() }, keys.privateKey);
  try {
    const list = await request(base, "/_dinodia/admin/api/devices", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.devices.map((device) => device.id), ["property-light"]);
    assert.equal((await request(base, "/_dinodia/admin/api/devices/private-lamp", { headers: { authorization: `Bearer ${token}` } })).response.status, 403);
    assert.equal((await request(base, "/_dinodia/admin/api/entities/property-light/service", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ serviceId: "light.turn_on" }) })).response.status, 403);
  } finally {
    await hub.stop();
  }
});
