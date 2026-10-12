const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
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

test("Native V2 unified listener keeps the scoped operator UI and retires HA REST/WebSocket routes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-unified-listener-"));
  const unifiedPort = await freePort();
  const hub = createHub({
    config: {
      nodeEnv: "development",
      adminToken: "admin-token-for-unified-test",
      port: 3000,
      nativeApiPort: unifiedPort,
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

    const unifiedRoot = await fetch(`${unified}/`);
    assert.equal(unifiedRoot.status, 200);
    assert.match(await unifiedRoot.text(), /Good to see you/);
    assert.equal(hub.server.listening, true);
    assert.equal(Object.prototype.hasOwnProperty.call(hub, "legacyDashboardServer"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(hub, "hubAgentServer"), false);

    const adminStatus = await request(unified, "/_dinodia/admin/api/status", { headers: admin });
    assert.equal(adminStatus.response.status, 200);
    const unauthorizedAdmin = await request(unified, "/_dinodia/admin/api/status");
    assert.equal(unauthorizedAdmin.response.status, 401);
    const nativeHealth = await request(unified, "/api/health");
    assert.equal(nativeHealth.response.status, 200);
    assert.equal(nativeHealth.body.mode, "native-v2");
    assert.equal(nativeHealth.body.ok, true);
    assert.equal((await request(unified, "/api/dinodia/v1/health")).response.status, 200);
    for (const [method, route] of [["GET", "/api/states"], ["POST", "/api/services/light/turn_on"], ["GET", "/api/config/device_registry/list"], ["GET", "/api/status"]]) {
      assert.equal((await request(unified, route, { method, headers: admin })).response.status, 404, `${method} ${route} is not an active legacy API`);
    }
    assert.equal((await fetch(`${unified}/api/websocket`)).status, 404);
    assert.equal((await request(unified, "/_dinodia/admin/api/status", { headers: { authorization: "Bearer retired-ha-token" } })).response.status, 401);
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
      port: 0, nativeApiPort: unifiedPort, dataDir: directory,
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

test("physical full-Home dashboard allows scoped device removal only for os:admin and prunes after adapter acknowledgement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-installer-device-removal-"));
  const [unifiedPort, customerPort] = await Promise.all([freePort(), freePort()]);
  const keys = crypto.generateKeyPairSync("ed25519");
  const hubId = "installer-device-removal-hub";
  const adminToken = createOperatorSessionToken({ sub: "assigned-installer", hubId, scope: ["os:admin"], recentAuthAt: Date.now() }, keys.privateKey);
  const installationToken = createOperatorSessionToken({ sub: "assigned-installer", hubId, scope: ["os:permanent-installation"], recentAuthAt: Date.now() }, keys.privateKey);
  const adapterCalls = [];
  const mqttBridge = {
    ...mockIntegration(),
    async remove(deviceId, force) { adapterCalls.push({ operation: "remove", deviceId, force }); return { status: "ok" }; },
    forgetDevice(deviceId) { adapterCalls.push({ operation: "forget", deviceId }); },
  };
  const hub = createHub({
    config: {
      nodeEnv: "production", v2Environment: "test", loopbackLanListenerForTest: true, customerLanPortForTest: customerPort,
      hubId, operatorPublicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      port: 0, nativeApiPort: unifiedPort, dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
    },
    mqttBridge, matterBridge: mockIntegration(), cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  try {
    await hub.start();
    await hub.store.upsertDevice({ id: "zigbee:disposable-removal", name: "Disposable Zigbee device", protocol: "zigbee", metadata: { friendly_name: "disposable-removal", ieee_address: "0x1234567890abcdef" }, state: { temperature: 20 } });
    await new Promise((resolve, reject) => { hub.setupServer.once("error", reject); hub.setupServer.listen(0, "127.0.0.1", resolve); });
    const physical = `http://127.0.0.1:${hub.setupServer.address().port}`;
    const route = "/_dinodia/admin/api/devices/zigbee%3Adisposable-removal";
    const unauthenticated = await request(physical, route, { method: "DELETE", body: "{}" });
    assert.equal(unauthenticated.response.status, 401);
    assert.ok(hub.store.getDevice("zigbee:disposable-removal"));
    assert.deepEqual(adapterCalls, []);

    const installationOnly = await request(physical, route, { method: "DELETE", headers: { authorization: `Bearer ${installationToken}` }, body: "{}" });
    assert.equal(installationOnly.response.status, 403);
    assert.ok(hub.store.getDevice("zigbee:disposable-removal"));
    assert.deepEqual(adapterCalls, []);

    const removed = await request(physical, route, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ force: false }) });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(hub.store.getDevice("zigbee:disposable-removal"), null);
    assert.deepEqual(adapterCalls, [
      { operation: "remove", deviceId: "zigbee:disposable-removal", force: false },
      { operation: "forget", deviceId: "zigbee:disposable-removal" },
    ]);
  } finally {
    await hub.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restricted assigned Home dashboard can inspect and reconnect only the existing reserved tunnel", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-tunnel-recovery-listener-"));
  const [unifiedPort, customerPort] = await Promise.all([freePort(), freePort()]);
  const hubId = "tunnel-recovery-listener-hub";
  const tunnelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reservation = {
    tunnelId,
    reservedTunnelName: "Dinodia Existing Home",
    reservedHostname: "dinodia-existing-home.dinodiasmartliving.com",
    reservationToken: "R".repeat(48),
  };
  const platform = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/hub-agent/v2/pairing/reservation") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorCode: "not_found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reservation));
  });
  await new Promise((resolve, reject) => { platform.once("error", reject); platform.listen(0, "127.0.0.1", resolve); });

  const hubIdentity = crypto.generateKeyPairSync("ed25519");
  const encryptionIdentity = crypto.generateKeyPairSync("x25519");
  const identityBroker = {
    async getPublicIdentity() {
      return {
        serial: hubId,
        signingPublicKeyPem: hubIdentity.publicKey.export({ format: "pem", type: "spki" }).toString(),
        encryptionPublicKeyPem: encryptionIdentity.publicKey.export({ format: "pem", type: "spki" }).toString(),
        generation: 1,
      };
    },
    async signPlatformRequest() { return { signature: "disposable-test-signature" }; },
  };
  const operatorKeys = crypto.generateKeyPairSync("ed25519");
  const adminToken = createOperatorSessionToken({
    sub: "assigned-installation-staff", hubId, homeId: "assigned-home",
    employeeSessionId: "employee-session", scope: ["os:admin"], recentAuthAt: Date.now(),
  }, operatorKeys.privateKey);
  const installationToken = createOperatorSessionToken({
    sub: "assigned-installation-staff", hubId, homeId: "assigned-home",
    employeeSessionId: "employee-session", workflow: "installation-work",
    requestId: "installation-request", areaIds: [], areaOptions: [], workRevision: 1,
    scope: ["os:permanent-installation"], recentAuthAt: Date.now(),
  }, operatorKeys.privateKey);
  const reconnectCalls = [];
  const cloudflareTunnel = {
    start() {}, async stop() {},
    status() {
      return {
        configured: true, mode: "local", running: false, connected: false,
        tunnelId, tunnelName: reservation.reservedTunnelName,
        hostname: reservation.reservedHostname, publicUrl: `https://${reservation.reservedHostname}`,
        recoveryState: "RECONNECT_REQUIRED", setupAllowed: false,
      };
    },
    async reconnectExisting(input) {
      reconnectCalls.push(input.reservation);
      return { recoveryState: "RECONNECTING", configured: true, mode: "local" };
    },
  };
  const hub = createHub({
    config: {
      nodeEnv: "production", v2Environment: "test", loopbackLanListenerForTest: true,
      customerLanPortForTest: customerPort, hubId,
      operatorPublicKey: operatorKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      platformApiUrl: `http://127.0.0.1:${platform.address().port}`,
      port: 0, nativeApiPort: unifiedPort, dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
    },
    identityBroker, mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel,
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });

  try {
    await new Promise((resolve, reject) => { hub.setupServer.once("error", reject); hub.setupServer.listen(0, "127.0.0.1", resolve); });
    const physical = `http://127.0.0.1:${hub.setupServer.address().port}`;
    const route = "/_dinodia/admin/api/integrations/cloudflare";
    const auth = (token) => ({ authorization: `Bearer ${token}` });

    const anonymous = await request(physical, route);
    assert.equal(anonymous.response.status, 401);
    const installationOnly = await request(physical, route, { headers: auth(installationToken) });
    assert.equal(installationOnly.response.status, 403);

    const status = await request(physical, route, { headers: auth(adminToken) });
    assert.equal(status.response.status, 200);
    assert.equal(status.body.recoveryState, "RECONNECT_REQUIRED");
    assert.equal(status.body.tunnelId, tunnelId);
    assert.equal("reservationToken" in status.body, false);

    const deniedMutation = await request(physical, route, {
      method: "POST", headers: auth(installationToken), body: JSON.stringify({ action: "reconnect-existing" }),
    });
    assert.equal(deniedMutation.response.status, 403);
    assert.equal(reconnectCalls.length, 0);

    const recovered = await request(physical, route, {
      method: "POST", headers: auth(adminToken), body: JSON.stringify({ action: "reconnect-existing" }),
    });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.recoveryState, "RECONNECTING");
    assert.deepEqual(reconnectCalls, [reservation], "recovery uses the current signed Platform reservation, never a browser-selected tunnel");
    assert.equal((await request(physical, route, { method: "DELETE", headers: auth(adminToken) })).response.status, 404);
  } finally {
    await hub.stop();
    await new Promise((resolve) => platform.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("retired Hub Agent port has no listener and the Native V2 server stops cleanly", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-unified-stop-"));
  const [unifiedPort, agentPort] = await Promise.all([freePort(), freePort()]);
  const hub = createHub({
    config: { nodeEnv: "development", adminToken: "stop-admin-token", port: 3000, nativeApiPort: unifiedPort, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  const legacyHubAgentConnected = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: agentPort });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  assert.equal(legacyHubAgentConnected, false, "the retired 8099 Hub Agent listener is not opened");
  await hub.stop();
  assert.equal(hub.server.listening, false);
  assert.equal(Object.prototype.hasOwnProperty.call(hub, "hubAgentServer"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(hub, "legacyDashboardServer"), false);
});
