const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createHub } = require("../src/server");
const { createOperatorSessionToken } = require("../src/auth/operatorSession");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function mockIntegration() {
  return {
    start() {},
    close() {},
    status() { return { configured: false, connected: false, lastError: null }; },
    async command() {},
    async refresh() { return []; },
    async permitJoin() {},
  };
}

function mockCloudflare() {
  return { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}

function websocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2000);
    socket.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

test("Stage B serves the dashboard and HA compatibility only on unified 8123", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-unified-listener-"));
  const [unifiedPort, agentPort] = await Promise.all([freePort(), freePort()]);
  const hub = createHub({
    config: {
      nodeEnv: "development",
      adminToken: "admin-token-for-unified-test",
      haToken: "ha-token-for-unified-test",
      port: 3000,
      haPort: unifiedPort,
      hubAgentPort: agentPort,
      dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"),
      backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"),
      otbrUrl: "",
    },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });

  try {
    await hub.start();
    const unified = `http://127.0.0.1:${unifiedPort}`;
    const admin = { authorization: "Bearer admin-token-for-unified-test" };
    const ha = { authorization: "Bearer ha-token-for-unified-test" };

    const unifiedRoot = await fetch(`${unified}/`);
    assert.equal(unifiedRoot.status, 200);
    assert.match(await unifiedRoot.text(), /Good to see you/);
    assert.equal(hub.server, hub.haServer);
    assert.equal(hub.server.listening, true);
    assert.equal(Object.prototype.hasOwnProperty.call(hub, "legacyDashboardServer"), false);

    const adminStatus = await request(unified, "/_dinodia/admin/api/status", { headers: admin });
    assert.equal(adminStatus.response.status, 200);
    const unauthorizedAdmin = await request(unified, "/_dinodia/admin/api/status");
    assert.equal(unauthorizedAdmin.response.status, 401);
    const haHealth = await request(unified, "/api/health");
    assert.equal(haHealth.response.status, 200);
    assert.equal(haHealth.body.port, unifiedPort);
    const states = await request(unified, "/api/states", { headers: ha });
    assert.equal(states.response.status, 200);
    assert.equal((await request(unified, "/api/states", { headers: admin })).response.status, 401);
    assert.equal((await request(unified, "/_dinodia/admin/api/status", { headers: ha })).response.status, 401);
    assert.equal((await request(unified, "/api/status", { headers: admin })).response.status, 401);

    await hub.store.saveAuth({
      haTokenHash: crypto.createHash("sha256").update("persisted-different-token").digest("hex"),
    });
    assert.equal((await request(unified, "/api/states", { headers: ha })).response.status, 200);
    assert.equal((await request(unified, "/api/states", { headers: { authorization: "Bearer persisted-different-token" } })).response.status, 200);

    const ws = new WebSocket(`${unified.replace("http", "ws")}/api/websocket`);
    try {
      assert.equal((await websocketMessage(ws)).type, "auth_required");
      ws.send(JSON.stringify({ type: "auth", access_token: "ha-token-for-unified-test" }));
      assert.equal((await websocketMessage(ws)).type, "auth_ok");
      ws.send(JSON.stringify({ id: 1, type: "get_states" }));
      const result = await websocketMessage(ws);
      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.result));
    } finally {
      ws.close();
    }
    const dashboardWs = new WebSocket(`${unified.replace("http", "ws")}/api/websocket`);
    try {
      assert.equal((await websocketMessage(dashboardWs)).type, "auth_required");
      dashboardWs.send(JSON.stringify({ type: "auth", access_token: "admin-token-for-unified-test" }));
      assert.equal((await websocketMessage(dashboardWs)).type, "auth_ok");
      dashboardWs.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "dinodia_dashboard_updated" }));
      assert.equal((await websocketMessage(dashboardWs)).result, true);
      hub.eventBus.emit("dinodia_dashboard_updated", { kind: "device", deviceId: "live-device" });
      const pushed = await websocketMessage(dashboardWs);
      assert.equal(pushed.type, "event");
      assert.equal(pushed.event.event_type, "dinodia_dashboard_updated");
      assert.equal(pushed.event.data.deviceId, "live-device");
      hub.eventBus.emit("registry_updated", { registry: "device", id: "live-device" });
      const registryPushed = await websocketMessage(dashboardWs);
      assert.equal(registryPushed.event.event_type, "dinodia_dashboard_updated");
      assert.equal(registryPushed.event.data.kind, "registry");
      assert.equal(registryPushed.event.data.registry, "device");
    } finally {
      dashboardWs.close();
    }
  } finally {
    await hub.stop();
  }
});

test("physical installer listener serves a bounded authenticated dashboard and idempotent Area commissioning only", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-installer-commissioning-"));
  const [unifiedPort, agentPort, customerPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const keys = crypto.generateKeyPairSync("ed25519");
  const hubId = "installer-listener-hub";
  const operatorToken = createOperatorSessionToken({ sub: "assigned-installer", hubId, scope: ["os:admin"], recentAuthAt: Date.now() }, keys.privateKey);
  const hub = createHub({
    config: {
      nodeEnv: "production", v2Environment: "test", loopbackLanListenerForTest: true, customerLanPortForTest: customerPort,
      hubId, operatorPublicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      port: 0, haPort: unifiedPort, hubAgentPort: agentPort, dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
    },
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(), cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  try {
    await hub.start();
    await new Promise((resolve, reject) => { hub.setupServer.once("error", reject); hub.setupServer.listen(0, "127.0.0.1", resolve); });
    const physical = `http://127.0.0.1:${hub.setupServer.address().port}`;
    const operator = { authorization: `Bearer ${operatorToken}` };
    const home = await fetch(`${physical}/`, { headers: operator });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /area-create-form/);
    assert.equal((await fetch(`${physical}/styles.css`, { headers: operator })).status, 200);
    assert.equal((await fetch(`${physical}/js/api.js`, { headers: operator })).status, 200);
    assert.equal((await fetch(`${physical}/`, { headers: { authorization: "Bearer customer-or-ha-token" } })).status, 401);
    assert.equal((await fetch(`${physical}/_dinodia/admin/api/status`, { headers: operator })).status, 200);
    assert.equal((await fetch(`${physical}/_dinodia/admin/api/status`)).status, 401);

    const id = crypto.randomUUID();
    const create = () => request(physical, "/_dinodia/admin/api/areas", { method: "POST", headers: operator, body: JSON.stringify({ id, name: "Kitchen", icon: "room" }) });
    const created = await create();
    assert.equal(created.response.status, 201);
    assert.equal(created.body.id, id);
    const firstOutbox = hub.store.getSyncOutbox().events.filter((entry) => entry.type === "area.upsert" && entry.aggregateId === id);
    assert.equal(firstOutbox.length, 1, "Area and its durable sync event are committed once");
    const retry = await create();
    assert.equal(retry.response.status, 200);
    assert.equal(hub.store.getSyncOutbox().events.filter((entry) => entry.type === "area.upsert" && entry.aggregateId === id).length, 1);
    const changedRetry = await request(physical, "/_dinodia/admin/api/areas", { method: "POST", headers: operator, body: JSON.stringify({ id, name: "Bedroom", icon: "room" }) });
    assert.equal(changedRetry.response.status, 409);
    assert.equal(hub.store.getArea(id).name, "Kitchen");
    const duplicateName = await request(physical, "/_dinodia/admin/api/areas", { method: "POST", headers: operator, body: JSON.stringify({ id: crypto.randomUUID(), name: " kitchen ", icon: "room" }) });
    assert.equal(duplicateName.response.status, 409);
    const invalid = await request(physical, "/_dinodia/admin/api/areas", { method: "POST", headers: operator, body: JSON.stringify({ id: crypto.randomUUID(), name: "\u0000", icon: "room" }) });
    assert.equal(invalid.response.status, 400);
    const areaCount = hub.store.listAreas().length;
    const deniedArea = await request(physical, "/_dinodia/admin/api/areas", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), name: "Private", icon: "room" }) });
    assert.equal(deniedArea.response.status, 401);
    assert.equal(JSON.stringify(deniedArea.body).includes("Kitchen"), false);
    assert.equal(hub.store.listAreas().length, areaCount);

    const insecureMatterPayload = await request(physical, `/_dinodia/installer/commissioning/sessions/${crypto.randomUUID()}/matter-payload`, {
      method: "POST",
      headers: { origin: new URL(physical).origin, cookie: "dinodia_setup_csrf=disposable-csrf", "x-dinodia-setup-csrf": "disposable-csrf" },
      body: JSON.stringify({ schemaVersion: "dinodia.v1", setupPayload: "MT:DISPOSABLE-TEST-CODE" }),
    });
    assert.equal(insecureMatterPayload.response.status, 403, "Matter setup material is rejected before authentication/body processing on installer HTTP");
    assert.equal(insecureMatterPayload.body.error?.code, "SECURE_TRANSPORT_REQUIRED");
    assert.equal(JSON.stringify(insecureMatterPayload.body).includes("DISPOSABLE-TEST-CODE"), false);

    const queueBefore = hub.store.getSyncOutbox().events.length;
    assert.equal((await request(physical, "/_dinodia/admin/api/entities/test-device/service", { method: "POST", headers: operator, body: JSON.stringify({ serviceId: "light.turn_on" }) })).response.status, 404);
    assert.equal((await fetch(`${physical}/api/websocket`, { headers: operator })).status, 404);
    assert.equal(hub.store.getSyncOutbox().events.length, queueBefore, "installer HTTP exposes no customer/HA command surface");
    assert.equal((await fetch(`${physical}/_dinodia/setup/status`)).status, 403, "setup status remains locked until the originating browser completes its one-use handoff");
  } finally {
    await hub.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("unified listener stops the unified and Hub Agent sockets cleanly", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-unified-stop-"));
  const [unifiedPort, agentPort] = await Promise.all([freePort(), freePort()]);
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "stop-admin-token", haToken: "stop-ha-token", port: 3000, haPort: unifiedPort, hubAgentPort: agentPort, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  await hub.stop();
  assert.equal(hub.server.listening, false);
  assert.equal(hub.hubAgentServer.listening, false);
  assert.equal(Object.prototype.hasOwnProperty.call(hub, "legacyDashboardServer"), false);
});
