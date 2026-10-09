const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const https = require("node:https");
const tls = require("node:tls");
const net = require("node:net");
const { createUpdaterControlServer } = require("../src/updater/service");
const { parsePublicKeys, verifyAppAccessToken } = require("../src/auth/appTokenVerifier");
const { verifyAlexaCommandToken, verifyAlexaStateToken } = require("../src/auth/alexaCommandTokenVerifier");
const { createHub } = require("../src/server");
const crypto = require("node:crypto");
const { createOperatorSessionToken } = require("../src/auth/operatorSession");
const { validateCommand: validateNativeCommand } = require("../src/contracts/dinodiaV1");
const { digestOperation, descriptorBoundValue, StepUpProofVerifier } = require("../src/auth/stepUpProofVerifier");
const { OfflineLanAuthorisationStore, createNativeLanChallenge, digestNativeOfflineCommand, signLanChallenge } = require("../src/auth/offlineLanAuthorizer");
const { LanTlsIdentity, pinForCertificate } = require("../src/transport/lanTlsIdentity");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

async function freeLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function appToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-APP-1", v: 1 })}.${encode(claims)}`;
  return `dno-app-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

function alexaCommandToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-ALEXA-CMD-1", v: 1 })}.${encode({
    iss: "dinodia-platform-v2", aud: `dinodia-hub:${claims.hubInstallationId}`,
    sub: claims.accountId, linkId: claims.linkId, endpointId: claims.endpointId,
    homeId: claims.homeId, membershipId: claims.membershipId, hubInstallationId: claims.hubInstallationId,
    areaId: claims.areaId, deviceId: claims.deviceId, controlId: claims.controlId,
    descriptorRevision: claims.descriptorRevision, commandId: claims.commandId,
    idempotencyKey: claims.idempotencyKey, valueDigest: claims.valueDigest,
    policyRevision: claims.policyRevision, jti: claims.jti, iat: claims.issuedAt, exp: claims.expiresAt,
    ...(claims.extraPayload || {}),
  })}`;
  return `dno-alexa-command-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

function alexaStateToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-ALEXA-STATE-1", v: 1 })}.${encode({
    iss: "dinodia-platform-v2", aud: `dinodia-hub:${claims.hubInstallationId}`,
    sub: claims.accountId, linkId: claims.linkId, endpointId: claims.endpointId,
    homeId: claims.homeId, membershipId: claims.membershipId, hubInstallationId: claims.hubInstallationId,
    areaId: claims.areaId, deviceId: claims.deviceId, controlIds: claims.controlIds,
    descriptorRevision: claims.descriptorRevision, policyRevision: claims.policyRevision,
    jti: claims.jti, iat: claims.issuedAt, exp: claims.expiresAt,
  })}`;
  return `dno-alexa-state-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}

function pinnedTlsRequest(base, route, options, certificatePem, expectedPin) {
  const url = new URL(route, base);
  const method = options?.method || "GET";
    const headers = { "content-type": "application/json", ...(options?.headers || {}) };
    return new Promise((resolve, reject) => {
      const client = https.request({
        hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers,
        agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
        servername: url.hostname, ca: certificatePem, rejectUnauthorized: true,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "function") { callback = options; options = {}; }
        if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      },
      checkServerIdentity: (hostname, certificate) => {
        const ordinaryTrust = tls.checkServerIdentity(hostname, certificate);
        if (ordinaryTrust) return ordinaryTrust;
        return pinForCertificate(certificate.raw) === expectedPin ? undefined : new Error("Customer LAN SPKI pin mismatch");
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ response: { status: response.statusCode, headers: response.headers }, body: JSON.parse(body || "{}") }));
    });
    client.once("error", reject);
    if (options?.body !== undefined) client.write(options.body);
    client.end();
  });
}

function websocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OS WebSocket response timed out")), 2000);
    socket.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function websocketMessageMatching(socket, predicate, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("Expected Native V1 event did not arrive")); }, timeoutMs);
    const onMessage = (data) => {
      let value;
      try { value = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(value)) return;
      clearTimeout(timer); socket.off("message", onMessage); resolve(value);
    };
    socket.on("message", onMessage);
  });
}

test("updater maintenance routes enforce tenant/operator scope and expose only the disabled signed-update boundary", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-updater-route-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const controlDir = path.join(directory, "control");
  await fs.mkdir(controlDir, { mode: 0o700 });
  const socketPath = path.join(controlDir, "control.sock");
  let updateCalls = 0;
  const updaterState = { phase: "idle", activeReleaseVersion: null, lastAttempt: null, busy: false };
  const controlServer = createUpdaterControlServer({
    socketPath,
    executor: {
      policy: { enabled: false },
      status: () => updaterState,
      execute: async () => { updateCalls += 1; return { ok: false, code: "UPDATER_DISABLED" }; },
    },
  });
  await new Promise((resolve, reject) => { controlServer.once("error", reject); controlServer.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => controlServer.close(resolve)));

  const appKeys = crypto.generateKeyPairSync("ed25519");
  const operatorKeys = crypto.generateKeyPairSync("ed25519");
  const hubId = "maintenance-route-hub";
  const hub = createHub({
    config: {
      nodeEnv: "production", v2Environment: "test", updaterControlSocketPath: socketPath,
      appPublicKeys: appKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      operatorPublicKey: operatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      hubId, port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
    },
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.savePlatform({ hubInstallId: hubId, homeId: "home-maintenance", policyRevision: 0 });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const now = Math.floor(Date.now() / 1000);
  const makeAppToken = (role, suffix) => appToken({
    iss: "dinodia-platform-v2", aud: `dinodia-hub:${hubId}`, sub: `account-${suffix}`,
    sid: `sid-${suffix}`, jti: `jti-${suffix}`, membershipId: `membership-${suffix}`,
    trustedDeviceId: `trusted-${suffix}`, hubInstallationId: hubId, iat: now, exp: now + 300,
    homeId: "home-maintenance", householdRole: role, areaIds: [], policyRevision: 0,
    scope: ["tenant:device-command"],
  }, appKeys.privateKey);
  const tenant = makeAppToken("TENANT", "tenant");
  const owner = makeAppToken("OWNER", "owner");
  assert.ok(verifyAppAccessToken(owner, { publicKeys: parsePublicKeys(appKeys.publicKey.export({ type: "spki", format: "pem" }).toString()), hubId, policyRevision: 0 }), "test owner token is valid for this hub");
  assert.equal(hub.store.getPlatform().hubInstallId, hubId);
  assert.equal(hub.store.getIdentity().serial, hubId);
  const operator = createOperatorSessionToken({ sub: "operator-maintenance", hubId, scope: ["os:admin"], recentAuthAt: Date.now() }, operatorKeys.privateKey);
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  try {
    const anonymous = await request(base, "/api/dinodia/v1/maintenance/status");
    assert.equal(anonymous.response.status, 401);
    const ownerRead = await request(base, "/api/dinodia/v1/maintenance/status", { headers: auth(owner) });
    assert.equal(ownerRead.response.status, 403, `${JSON.stringify(ownerRead.body)} owner visibility must not grant tenant transport/status authority`);
    const tenantRead = await request(base, "/api/dinodia/v1/maintenance/status", { headers: auth(tenant) });
    assert.equal(tenantRead.response.status, 200, JSON.stringify(tenantRead.body));
    assert.equal(tenantRead.body.schemaVersion, "dinodia.v1");
    assert.equal(tenantRead.body.status.trustState, "unprovisioned");
    assert.equal(tenantRead.body.status.phase, "idle");
    assert.equal(tenantRead.body.status.busy, false);
    assert.equal(tenantRead.body.status.activeReleaseVersion, null);
    assert.equal("attemptId" in tenantRead.body.status, false);
    assert.equal("releaseId" in tenantRead.body.status, false);
    assert.equal(JSON.stringify(tenantRead.body).includes("privateKey"), false);
    assert.equal(JSON.stringify(tenantRead.body).includes("artifactUrl"), false);

    const tenantUpdate = await request(base, "/api/dinodia/v1/maintenance/update", {
      method: "POST", headers: auth(tenant), body: JSON.stringify({ schemaVersion: "dinodia.v1", envelope: {} }),
    });
    assert.equal(tenantUpdate.response.status, 403);
    const operatorMalformed = await request(base, "/api/dinodia/v1/maintenance/update", {
      method: "POST", headers: auth(operator), body: JSON.stringify({ schemaVersion: "dinodia.v1", envelope: {}, shell: "not-allowed" }),
    });
    assert.equal(operatorMalformed.response.status, 400);
    const operatorUpdate = await request(base, "/api/dinodia/v1/maintenance/update", {
      method: "POST", headers: auth(operator), body: JSON.stringify({ schemaVersion: "dinodia.v1", envelope: { payload: {}, signature: "test-only" } }),
    });
    assert.equal(operatorUpdate.response.status, 503);
    assert.equal(operatorUpdate.body.error?.code, "FEATURE_NOT_ENABLED");
    const oversizedUpdate = await request(base, "/api/dinodia/v1/maintenance/update", {
      method: "POST", headers: auth(operator), body: `{"schemaVersion":"dinodia.v1","envelope":{},"padding":"${"x".repeat(17 * 1024)}"}`,
    });
    assert.equal(oversizedUpdate.response.status, 400);
    assert.equal(oversizedUpdate.body.error?.code, "VALIDATION_FAILED");
    assert.equal(updateCalls, 1, "disabled and oversized update requests never reach the executor");
    updaterState.phase = "unexpected_internal_value";
    const invalidStatus = await request(base, "/api/dinodia/v1/maintenance/status", { headers: auth(tenant) });
    assert.equal(invalidStatus.response.status, 503);
    assert.equal(invalidStatus.body.error?.code, "HUB_UNAVAILABLE");
    updaterState.phase = "idle";
    assert.equal((await request(base, "/api/dinodia/v1/maintenance/status", { headers: auth(operator) })).response.status, 200);
  } finally {
    await hub.stop();
    await hub.store.persist();
  }
});

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
    const health = await request(base, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.mode, "native-v2");
    assert.equal(health.body.buildId, undefined);

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
    const token = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:app-scope-hub", sub: "user-22", sid: "sid-1", jti: "jti-1", membershipId: "membership-1", trustedDeviceId: "trusted-1", hubInstallationId: "app-scope-hub", iat: now, exp: now + 300, homeId: "home-7", householdRole: "OWNER", areaIds: ["area-1"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
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

test("Native v1 device route emits a home-bound contract envelope and never returns HA projection fields", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-v1-read-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hub = createHub({
    config: { nodeEnv: "production", appPublicKeys: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId: "native-v1-hub", port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.upsertDevice({ id: "tenant-owned-light", name: "Private lamp", protocol: "virtual", areaId: "area-kitchen", setup: { status: "installed", completedAt: new Date().toISOString() }, managementClass: "tenant_device", tenantOwnerMembershipId: "membership-tenant-a", metadata: { managementClass: "tenant_device", tenantOwnerMembershipId: "membership-tenant-a" } });
  await hub.store.savePlatform({ homeId: "home-a", areaBindings: [{ areaId: "area-uuid-kitchen", hubAreaId: "area-kitchen" }] });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const unauthenticated = await request(base, "/api/dinodia/v1/devices");
    assert.equal(unauthenticated.response.status, 401);
    assert.deepEqual(Object.keys(unauthenticated.body.error).sort(), ["code", "message", "requestId", "retryable"]);
    assert.equal(unauthenticated.body.error.code, "AUTH_REQUIRED");
    assert.equal(Object.hasOwn(unauthenticated.body, "data"), false);
    const now = Math.floor(Date.now() / 1000);
    const token = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: "account-tenant-a", sid: "sid-native-v1", jti: "jti-native-v1", membershipId: "membership-tenant-a", trustedDeviceId: "trusted-a", hubInstallationId: "native-v1-hub", iat: now, exp: now + 300, homeId: "home-a", householdRole: "TENANT", areaIds: ["area-uuid-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const result = await request(base, "/api/dinodia/v1/devices", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.schemaVersion, "dinodia.v1");
    assert.equal(result.body.homeId, "home-a");
    assert.equal(result.body.data.length, 1);
    assert.equal(result.body.data[0].ownerMembershipId, "membership-tenant-a");
    assert.deepEqual(result.body.data[0].areaIds, ["area-uuid-kitchen"]);
    assert.equal(JSON.stringify(result.body).includes("area-kitchen"), false, "private OS area aliases must not escape in the Native DTO");
    assert.equal("protocol" in result.body.data[0], false);
    assert.equal("entity_id" in result.body.data[0], false);

    const wrongHomeToken = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: "account-tenant-a", sid: "sid-native-v1b", jti: "jti-native-v1b", membershipId: "membership-tenant-b", trustedDeviceId: "trusted-a", hubInstallationId: "native-v1-hub", iat: now, exp: now + 300, homeId: "home-b", householdRole: "TENANT", areaIds: ["area-uuid-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const wrongHome = await request(base, "/api/dinodia/v1/devices", { headers: { authorization: `Bearer ${wrongHomeToken}` } });
    assert.equal(wrongHome.response.status, 403);
    assert.equal(wrongHome.body.error.code, "HOME_MISMATCH");
    assert.equal(wrongHome.body.error.retryable, false);
    assert.equal(JSON.stringify(wrongHome.body).includes("Private lamp"), false);

    const expiredToken = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: "account-tenant-a", sid: "sid-expired-customer", jti: "jti-expired-customer", membershipId: "membership-tenant-a", trustedDeviceId: "trusted-a", hubInstallationId: "native-v1-hub", iat: now - 301, exp: now - 1, homeId: "home-a", householdRole: "TENANT", areaIds: ["area-uuid-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const expiredRead = await request(base, "/api/dinodia/v1/devices", { headers: { authorization: `Bearer ${expiredToken}` } });
    assert.equal(expiredRead.response.status, 401);
    assert.equal(expiredRead.body.error.code, "AUTH_REQUIRED");
    assert.equal(Object.hasOwn(expiredRead.body, "data"), false);
    assert.equal(JSON.stringify(expiredRead.body).includes("Private lamp"), false);

    const privateDeviceNonOwners = [
      { name: "owner", accountId: "account-owner", membershipId: "membership-owner", role: "OWNER", areaIds: ["area-uuid-kitchen"] },
      { name: "manager", accountId: "account-manager", membershipId: "membership-manager", role: "PROPERTY_MANAGER", areaIds: ["area-uuid-kitchen"] },
      { name: "other tenant", accountId: "account-tenant-b", membershipId: "membership-tenant-b", role: "TENANT", areaIds: ["area-uuid-kitchen"] },
      { name: "tenant without this area grant", accountId: "account-tenant-a", membershipId: "membership-tenant-a", role: "TENANT", areaIds: ["area-uuid-bedroom"] },
    ];
    for (const [index, scenario] of privateDeviceNonOwners.entries()) {
      const nonOwnerToken = appToken({
        iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: scenario.accountId,
        sid: `sid-private-device-${index}`, jti: `jti-private-device-${index}`, membershipId: scenario.membershipId,
        trustedDeviceId: `trusted-private-device-${index}`, hubInstallationId: "native-v1-hub",
        iat: now, exp: now + 300, homeId: "home-a", householdRole: scenario.role,
        areaIds: scenario.areaIds, policyRevision: 0, scope: ["tenant:device-command"],
      }, keys.privateKey);
      const hidden = await request(base, "/api/dinodia/v1/devices", { headers: { authorization: `Bearer ${nonOwnerToken}` } });
      if (scenario.role === "TENANT") {
        assert.equal(hidden.response.status, 200, `${scenario.name} receives a valid empty scoped inventory`);
        assert.deepEqual(hidden.body.data, [], `${scenario.name} must not receive another tenant's private device`);
      } else {
        assert.equal(hidden.response.status, 403, `${scenario.name} has no direct OS inventory authority`);
        assert.equal(Object.hasOwn(hidden.body, "data"), false, `${scenario.name} receives no protected device payload`);
      }
      assert.equal(JSON.stringify(hidden.body).includes("tenant-owned-light"), false, `${scenario.name} must not receive the private device ID`);
      assert.equal(JSON.stringify(hidden.body).includes("Private lamp"), false, `${scenario.name} must not receive the private device label`);
    }

    // The older scoped HTTP capability and support-bundle projections are
    // separate routes from the Native inventory. Exercise their real handlers
    // so a future omission of appCanReadDevice cannot leak tenant-private
    // identity through an adjacent GET endpoint.
    const tenantOwnsPrivateDevice = appToken({
      iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: "account-tenant-a",
      sid: "sid-private-subroute-owner", jti: "jti-private-subroute-owner", membershipId: "membership-tenant-a",
      trustedDeviceId: "trusted-private-subroute-owner", hubInstallationId: "native-v1-hub",
      iat: now, exp: now + 300, homeId: "home-a", householdRole: "TENANT",
      areaIds: ["area-uuid-kitchen"], policyRevision: 0, scope: ["tenant:device-command"],
    }, keys.privateKey);
    const privateSubroutes = [
      "/_dinodia/admin/api/devices/tenant-owned-light/capabilities",
      "/_dinodia/admin/api/devices/tenant-owned-light/support-bundle",
    ];
    for (const route of privateSubroutes) {
      const ownRead = await request(base, route, { headers: { authorization: `Bearer ${tenantOwnsPrivateDevice}` } });
      assert.equal(ownRead.response.status, 200, `the owning tenant may use the scoped read route ${route}`);
      assert.equal(JSON.stringify(ownRead.body).includes("tenant-owned-light"), true);

      for (const [index, scenario] of privateDeviceNonOwners.entries()) {
        const outsider = appToken({
          iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: scenario.accountId,
          sid: `sid-private-subroute-outsider-${index}`, jti: `jti-private-subroute-outsider-${index}`,
          membershipId: scenario.membershipId, trustedDeviceId: `trusted-private-subroute-outsider-${index}`,
          hubInstallationId: "native-v1-hub", iat: now, exp: now + 300, homeId: "home-a",
          householdRole: scenario.role, areaIds: scenario.areaIds, policyRevision: 0,
          scope: ["tenant:device-command"],
        }, keys.privateKey);
        const denied = await request(base, route, { headers: { authorization: `Bearer ${outsider}` } });
        assert.equal(denied.response.status, 403, `${scenario.name} must be denied at ${route}`);
        assert.equal(denied.body.errorCode, "device_scope_denied");
        assert.equal(JSON.stringify(denied.body).includes("tenant-owned-light"), false, `${scenario.name} must receive zero private identity bytes from ${route}`);
        assert.equal(JSON.stringify(denied.body).includes("Private lamp"), false, `${scenario.name} must receive zero private label bytes from ${route}`);
      }
    }

    await hub.store.savePlatform({ ...(hub.store.getPlatform() || {}), policyRevision: 1 });
    const revokedPolicyToken = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-v1-hub", sub: "account-tenant-a", sid: "sid-revoked-policy", jti: "jti-revoked-policy", membershipId: "membership-tenant-a", trustedDeviceId: "trusted-a", hubInstallationId: "native-v1-hub", iat: now, exp: now + 300, homeId: "home-a", householdRole: "TENANT", areaIds: ["area-uuid-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const revokedPolicyRead = await request(base, "/api/dinodia/v1/devices", { headers: { authorization: `Bearer ${revokedPolicyToken}` } });
    assert.equal(revokedPolicyRead.response.status, 401, "a token from before the current policy revision is revoked");
    assert.equal(revokedPolicyRead.body.error.code, "AUTH_REQUIRED");
    assert.equal(Object.hasOwn(revokedPolicyRead.body, "data"), false);
    assert.equal(JSON.stringify(revokedPolicyRead.body).includes("tenant-owned-light"), false);
  } finally { await hub.stop(); }
});

test("tenant-owned Native V1 removal requires exact fresh proof and creates one physical unpair plus durable tombstone", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-tenant-remove-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hubId = "native-tenant-remove-hub";
  let adapterRemovals = 0;
  const matterBridge = { ...mockIntegration(), async remove(deviceId) { assert.equal(deviceId, "tenant-matter-lamp"); adapterRemovals += 1; return true; }, forgetDevice() {} };
  const hub = createHub({
    config: { nodeEnv: "production", appPublicKeys: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId, port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(), matterBridge,
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.savePlatform({ hubInstallId: hubId, homeId: "home-remove-a", policyRevision: 4,
    areaBindings: [{ areaId: "area-uuid-remove-kitchen", hubAreaId: "os-area-remove-kitchen" }],
    devicePolicies: { "tenant-matter-lamp": { osDeviceId: "tenant-matter-lamp", managementClass: "TENANT_DEVICE", ownerMembershipId: "membership-remove-a", lifecycle: "INSTALLED", analyticsCategory: "NONE", descriptorRevision: 1, descriptorDigest: null, osAreaIds: ["os-area-remove-kitchen"] } },
  });
  await hub.store.upsertDevice({ id: "tenant-matter-lamp", name: "Private tenant lamp", protocol: "matter", areaId: "os-area-remove-kitchen", descriptorRevision: 1, managementClass: "tenant_device", tenantOwnerMembershipId: "membership-remove-a", metadata: { managementClass: "tenant_device", tenantOwnerMembershipId: "membership-remove-a" } });
  const descriptorRevision = Number(hub.store.getDevice("tenant-matter-lamp")?.presentation?.descriptorRevision || hub.store.getDevice("tenant-matter-lamp")?.descriptorRevision || 1);
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const targetIds = ["tenant-matter-lamp"];
  const value = { operation: "remove_tenant_device", descriptorRevision };
  const operationDigest = digestOperation({ actorId: "account-remove-a", trustedDeviceId: "trusted-account-remove-a", customerSessionId: "session-remove-a", homeId: "home-remove-a", membershipId: "membership-remove-a", hubInstallId: hubId, operationKind: "tenant_device_remove", targetIds, value });
  const unsignedProof = { jti: "tenant-remove-proof-0001", actorId: "account-remove-a", trustedDeviceId: "trusted-account-remove-a", customerSessionId: "session-remove-a", homeId: "home-remove-a", membershipId: "membership-remove-a", hubInstallId: hubId, operationDigest, issuedAt, expiresAt: issuedAt + 60 };
  const proof = `${Buffer.from(JSON.stringify(unsignedProof)).toString("base64url")}.${crypto.sign(null, Buffer.from(JSON.stringify(unsignedProof)), keys.privateKey).toString("base64url")}`;
  const now = issuedAt;
  const makeToken = (accountId, membershipId, sessionId) => appToken({ iss: "dinodia-platform-v2", aud: `dinodia-hub:${hubId}`, sub: accountId, sid: sessionId, jti: `jti-${sessionId}`, membershipId, trustedDeviceId: `trusted-${accountId}`, hubInstallationId: hubId, iat: now, exp: now + 300, homeId: "home-remove-a", householdRole: "TENANT", areaIds: ["area-uuid-remove-kitchen"], policyRevision: 4, scope: ["tenant:device-command"] }, keys.privateKey);
  const ownerToken = makeToken("account-remove-a", "membership-remove-a", "session-remove-a");
  const otherToken = makeToken("account-remove-b", "membership-remove-b", "session-remove-b");
  const idempotencyKey = "tenant-device-remove-once-0001";
  const body = { schemaVersion: "dinodia.v1", homeId: "home-remove-a", homeMembershipId: "membership-remove-a", deviceId: "tenant-matter-lamp", descriptorRevision, idempotencyKey };
  const beforeEvents = hub.store.getSyncOutbox().events.length;
  try {
    const missingProof = await request(base, "/api/dinodia/v1/devices/tenant-matter-lamp", { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
    assert.equal(missingProof.response.status, 400);
    const wrongTenant = await request(base, "/api/dinodia/v1/devices/tenant-matter-lamp", { method: "DELETE", headers: { authorization: `Bearer ${otherToken}`, "idempotency-key": idempotencyKey, "x-dinodia-step-up-proof": proof }, body: JSON.stringify({ ...body, homeMembershipId: "membership-remove-b" }) });
    assert.equal(wrongTenant.response.status, 404);
    assert.equal(JSON.stringify(wrongTenant.body).includes("Private tenant lamp"), false);
    assert.equal(adapterRemovals, 0);
    assert.ok(hub.store.getDevice("tenant-matter-lamp"));
    assert.equal(hub.store.getSyncOutbox().events.length, beforeEvents);

    const removed = await request(base, "/api/dinodia/v1/devices/tenant-matter-lamp", { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": idempotencyKey, "x-dinodia-step-up-proof": proof }, body: JSON.stringify(body) });
    assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.state, "REMOVED");
    assert.equal(removed.body.hubEnforcement, "ENFORCED");
    assert.equal(adapterRemovals, 1);
    assert.equal(hub.store.getDevice("tenant-matter-lamp"), null);
    assert.equal(hub.store.getSyncOutbox().events.some((event) => event.type === "device.tombstone" && event.aggregateId === "tenant-matter-lamp"), true);

    const exactRetry = await request(base, "/api/dinodia/v1/devices/tenant-matter-lamp", { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": idempotencyKey, "x-dinodia-step-up-proof": proof }, body: JSON.stringify(body) });
    assert.equal(exactRetry.response.status, 200);
    assert.equal(exactRetry.body.state, "REMOVED");
    assert.equal(adapterRemovals, 1, "an exact lost-response retry reconciles the durable receipt and does not unpair twice");

    const conflictingRetry = await request(base, "/api/dinodia/v1/devices/tenant-matter-lamp", { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": idempotencyKey, "x-dinodia-step-up-proof": proof }, body: JSON.stringify({ ...body, descriptorRevision: 8 }) });
    assert.equal(conflictingRetry.response.status, 409);
    assert.equal(conflictingRetry.body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(adapterRemovals, 1);
  } finally { await hub.stop(); }
});

test("Native v1 command route enforces current DTO, tenant scope and durable idempotency before dispatch", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-v1-command-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hubSigningKeys = crypto.generateKeyPairSync("ed25519");
  const hubEncryptionKeys = crypto.generateKeyPairSync("ed25519");
  let hubSignatureCount = 0;
  const identityBroker = {
    async getPublicIdentity() {
      return {
        serial: "native-command-hub",
        generation: 7,
        signingPublicKeyPem: hubSigningKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        encryptionPublicKeyPem: hubEncryptionKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
    },
    async signPlatformRequest({ method, path: requestPath, timestamp, nonce, bodyHash }) {
      hubSignatureCount += 1;
      const canonical = [String(method).toUpperCase(), String(requestPath), String(timestamp), String(nonce), String(bodyHash).toLowerCase()].join("\n");
      return { signature: crypto.sign(null, Buffer.from(canonical, "utf8"), hubSigningKeys.privateKey).toString("base64url") };
    },
  };
  let controlledClock = Date.now();
  const makeHub = () => createHub({
    config: { nodeEnv: "production", v2Environment: "test", nativeCommandConfirmationTimeoutMs: 200, appPublicKeys: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId: "native-command-hub", port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    identityBroker,
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() { }, status() { return { configured: false }; } },
    clock: () => controlledClock,
  });
  let hub = makeHub();
  const area = await hub.store.saveArea({ name: "Kitchen" }, "area-command-kitchen");
  await hub.store.savePlatform({ homeId: "home-command", areaBindings: [{ areaId: "area-uuid-command-kitchen", hubAreaId: area.id }] });
  const deviceId = "device-native-command";
  await hub.store.upsertDevice({
    id: deviceId, name: "Kitchen switch legacy display name exceeding the forty character public limit", protocol: "virtual", areaId: area.id,
    managementClass: "tenant_device", tenantOwnerMembershipId: "membership-command-tenant",
    entities: { [`${deviceId}:0:state`]: {
      id: `${deviceId}:0:state`, sourceId: `${deviceId}:0:state`, deviceId, endpointId: "0", logicalKey: "state", stateKey: "state", domain: "switch", state: "OFF",
      stateRevision: 1, lastChanged: new Date(controlledClock).toISOString(),
      capability: { runtime: "dinodia_os", kind: "binary", category: "control", readable: true, writable: true, observable: true, primary: true, semanticRole: "power", bindings: [{ serviceId: "switch.turn_on" }, { serviceId: "switch.turn_off" }] },
    }, [`${deviceId}:0:lock`]: {
      id: `${deviceId}:0:lock`, sourceId: `${deviceId}:0:lock`, deviceId, endpointId: "0", logicalKey: "lock", stateKey: "lock", domain: "lock", state: "LOCKED",
      capability: { runtime: "dinodia_os", kind: "binary", category: "control", readable: true, writable: true, observable: true, primary: true, semanticRole: "security_lock", stepUpPolicy: "required", bindings: [{ serviceId: "lock.lock" }, { serviceId: "lock.unlock" }] },
    } },
  });
  await hub.store.completeDeviceSetup(deviceId, { areaId: area.id, labelId: "light" });
  await hub.start();
  let originalUpdateEntity = hub.store.updateEntity.bind(hub.store);
  let base = `http://127.0.0.1:${hub.server.address().port}`;
  let socket;
  let nativeSocket;
  let releaseQueuedCommand = () => {};
  let restoreSaveSecurity = () => {};
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-command-hub", sub: "account-command-tenant", sid: "sid-command", jti: "jti-command", membershipId: "membership-command-tenant", trustedDeviceId: "trusted-command", hubInstallationId: "native-command-hub", iat: now, exp: now + 300, homeId: "home-command", householdRole: "TENANT", areaIds: ["area-uuid-command-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const headers = { authorization: `Bearer ${token}` };
    socket = new WebSocket(`${base.replace("http", "ws")}/api/websocket`);
    assert.equal((await websocketMessage(socket)).type, "auth_required");
    socket.send(JSON.stringify({ type: "auth", access_token: token }));
    assert.equal((await websocketMessage(socket)).type, "auth_invalid", "Native V2 customer authority is never accepted by the HA-shaped compatibility socket");
    await new Promise((resolve) => socket.once("close", resolve));
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, 0, "rejected compatibility authentication causes no command event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "OFF", "rejected compatibility authentication has no virtual-device effect");
    const catalog = await request(base, "/api/dinodia/v1/devices", { headers });
    assert.equal(catalog.response.status, 200);
    const dto = catalog.body.data.find((item) => item.id === deviceId);
    assert.ok(dto);
    assert.ok(dto.descriptorRevision >= 1, "installed controls have a nonzero descriptor revision suitable for operation-bound step-up");
    assert.equal(dto.customerLabel.length, 40, "an over-bound legacy label is safely bounded without dropping the device");
    assert.equal(dto.controls.length, 2, "label projection must preserve the device's control descriptors");
    const nativeSnapshot = await request(base, "/api/dinodia/v1/snapshot", { headers });
    assert.equal(nativeSnapshot.response.status, 200, JSON.stringify(nativeSnapshot.body));
    assert.equal(nativeSnapshot.body.homeId, "home-command");
    assert.match(nativeSnapshot.body.streamId, /^native:[0-9a-f-]{36}$/i, "the event stream identity is opaque and persisted, not derived from the hub serial");
    assert.equal(nativeSnapshot.body.streamId.includes("native-command-hub"), false, "the public stream envelope never exposes the hub serial");
    assert.deepEqual(nativeSnapshot.body.data.devices.map((item) => item.id), [deviceId]);
    assert.ok(nativeSnapshot.body.data.states.some((state) => state.deviceId === deviceId && state.homeId === "home-command"));
    const initialDeviceDto = nativeSnapshot.body.data.devices.find((item) => item.id === deviceId);
    const powerControlId = initialDeviceDto?.controls.find((control) => control.semanticRole === "power")?.controlId;
    const initialPowerState = nativeSnapshot.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(initialPowerState?.value, false, `adapter-reported uppercase OFF normalizes to a real boolean observation; states=${JSON.stringify(nativeSnapshot.body.data.states)}`);
    assert.equal(initialPowerState?.quality, "fresh");
    assert.equal(initialPowerState?.analyticsActivity, "off");
    const originalStateDevice = hub.store.getDevice(deviceId);
    const stateEntity = hub.store.state.devices[deviceId].entities[`${deviceId}:0:state`];
    stateEntity.state = "ON";
    delete stateEntity.lastChanged;
    delete stateEntity.last_changed;
    delete stateEntity.updatedAt;
    const missingTimeSnapshot = await request(base, "/api/dinodia/v1/snapshot", { headers });
    const missingTimeState = missingTimeSnapshot.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(missingTimeState?.value, null, "missing adapter observation time cannot publish a retained value");
    assert.equal(missingTimeState?.quality, "unknown");
    assert.equal(missingTimeState?.analyticsActivity, "unknown");
    assert.equal(missingTimeState?.observedAt, null, "snapshot time is never substituted for the missing observation timestamp");
    assert.equal(missingTimeState?.validUntil, null, "missing telemetry has no newly extended validity window");
    const repeatedMissingTimeSnapshot = await request(base, "/api/dinodia/v1/snapshot", { headers });
    const repeatedMissingTimeState = repeatedMissingTimeSnapshot.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(repeatedMissingTimeState?.value, null, "a repeated snapshot cannot manufacture or extend telemetry");
    assert.equal(repeatedMissingTimeState?.quality, "unknown");
    hub.store.state.devices[deviceId] = originalStateDevice;
    const observedAt = initialPowerState.observedAt;
    const validUntilMs = Date.parse(initialPowerState.validUntil);
    controlledClock = validUntilMs - 1;
    const beforeValidityEnd = await request(base, "/api/dinodia/v1/snapshot", { headers });
    const beforeValidityState = beforeValidityEnd.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(beforeValidityState?.quality, "fresh", "the observation remains fresh immediately before its finite deadline");
    controlledClock = validUntilMs;
    const atValidityEnd = await request(base, "/api/dinodia/v1/snapshot", { headers });
    const expiredValidityState = atValidityEnd.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(expiredValidityState?.quality, "unknown", "the exact validity deadline expires inclusively");
    assert.equal(expiredValidityState?.value, null);
    assert.equal(expiredValidityState?.analyticsActivity, "unknown");
    controlledClock = Date.now();
    await originalUpdateEntity(deviceId, `${deviceId}:0:state`, { state: "OFF", stateRevision: 2, lastChanged: new Date(controlledClock).toISOString(), updatedAt: new Date(controlledClock).toISOString() });
    const recoveredObservation = await request(base, "/api/dinodia/v1/snapshot", { headers });
    const recoveredState = recoveredObservation.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(recoveredState?.quality, "fresh", "a new genuine observation restores finite freshness");
    const recoveredObservedAt = recoveredState?.observedAt;
    const activityFixtures = [
      { id: "native-activity-light", role: "power", state: "ON", expected: "on" },
      { id: "native-activity-radiator", role: "active_heat_demand", state: "ON", expected: "on" },
      { id: "native-activity-boiler", role: "active_heat_production", state: "ON", expected: "on" },
      { id: "native-activity-target-temperature", role: "target_temperature", state: 21, kind: "number", expected: "unknown" },
    ];
    for (const fixture of activityFixtures) {
      const entityId = `${fixture.id}:0:activity`;
      await hub.store.upsertDevice({
        id: fixture.id, name: fixture.id, protocol: "virtual", areaId: area.id,
        managementClass: "tenant_device", tenantOwnerMembershipId: "membership-command-tenant",
        entities: { [entityId]: {
          id: entityId, sourceId: entityId, deviceId: fixture.id, endpointId: "0", logicalKey: "activity", stateKey: "activity",
          domain: "switch", state: fixture.state, stateRevision: 1, lastChanged: new Date(controlledClock).toISOString(),
          capability: { runtime: "dinodia_os", kind: fixture.kind || "binary", category: "control", readable: true, writable: false, observable: true, primary: true, semanticRole: fixture.role, bindings: [] },
        } },
      });
      await hub.store.completeDeviceSetup(fixture.id, { areaId: area.id, labelId: "light" });
    }
    const activitySnapshot = await request(base, "/api/dinodia/v1/snapshot", { headers });
    for (const fixture of activityFixtures) {
      const activityState = activitySnapshot.body.data.states.find((state) => state.deviceId === fixture.id);
      assert.equal(activityState?.analyticsActivity, fixture.expected, `${fixture.role} comes from observed activity, not target temperature or enabled mode`);
      assert.equal(activityState?.quality, "fresh");
    }
    nativeSocket = null;
    await hub.stop();
    hub = makeHub();
    await hub.start();
    originalUpdateEntity = hub.store.updateEntity.bind(hub.store);
    base = `http://127.0.0.1:${hub.server.address().port}`;
    const afterRestart = await request(base, "/api/dinodia/v1/snapshot", { headers });
    const restartedState = afterRestart.body.data.states.find((state) => state.deviceId === deviceId && state.controlId === powerControlId);
    assert.equal(restartedState?.observedAt, recoveredObservedAt, "restart preserves the adapter observation time instead of refreshing it");
    assert.equal(restartedState?.validUntil, recoveredState?.validUntil, "restart preserves the original validity deadline");
    nativeSocket = new WebSocket(`${base.replace("http", "ws")}/api/dinodia/v1/events?after=${nativeSnapshot.body.sequence}`, { headers });
    await new Promise((resolve, reject) => { nativeSocket.once("open", resolve); nativeSocket.once("error", reject); });
    const nativeAreas = await request(base, "/api/dinodia/v1/areas", { headers });
    assert.equal(nativeAreas.response.status, 200);
    assert.deepEqual(nativeAreas.body.data.map((item) => item.id), ["area-uuid-command-kitchen"]);
    const nativeDetail = await request(base, `/api/dinodia/v1/devices/${encodeURIComponent(deviceId)}`, { headers });
    assert.equal(nativeDetail.response.status, 200);
    assert.equal(nativeDetail.body.data.id, deviceId);
    const nativeControlCatalog = await request(base, `/api/dinodia/v1/control-catalog?deviceId=${encodeURIComponent(deviceId)}`, { headers });
    assert.equal(nativeControlCatalog.response.status, 200);
    assert.equal(nativeControlCatalog.body.data.controls.length, 2);
    const otherTenant = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-command-hub", sub: "account-command-other", sid: "sid-command-other", jti: "jti-command-other", membershipId: "membership-command-other", trustedDeviceId: "trusted-command-other", hubInstallationId: "native-command-hub", iat: now, exp: now + 300, homeId: "home-command", householdRole: "TENANT", areaIds: ["area-uuid-command-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const privateDetail = await request(base, `/api/dinodia/v1/devices/${encodeURIComponent(deviceId)}`, { headers: { authorization: `Bearer ${otherTenant}` } });
    assert.equal(privateDetail.response.status, 404);
    assert.equal(JSON.stringify(privateDetail.body).includes("Kitchen switch"), false);
    const storedDevice = hub.store.getDevice(deviceId);
    for (const [length, expectedLength] of [[0, deviceId.length], [1, 1], [40, 40], [41, 40], [80, 40]]) {
      await hub.store.upsertDevice({ ...storedDevice, name: "L".repeat(length) || deviceId });
      const labelRead = await request(base, "/api/dinodia/v1/devices", { headers });
      const labelDto = labelRead.body.data.find((item) => item.id === deviceId);
      assert.ok(labelDto, `label length ${length} must not drop device identity`);
      assert.equal(labelDto.customerLabel?.length ?? null, expectedLength, `public label length ${length} must map to the canonical bound`);
      assert.equal(labelDto.controls.length, 2, `label length ${length} must not remove controls`);
      assert.equal(labelDto.managementClass, "tenant_device", `label length ${length} must not change ownership class`);
    }
    const labelFixture = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures/contracts/dinodia-v1/fixtures/customer-label-unicode-boundaries.json"), "utf8"));
    for (const item of labelFixture.cases) {
      const raw = typeof item.value === "string" ? item.value : String(item.repeat || "").repeat(Number(item.repeatCount || 0));
      if (raw.length === 0) continue; // The store deliberately preserves an existing label on an empty update; serializer-null is covered below in the contract unit.
      await hub.store.upsertDevice({ ...storedDevice, name: raw });
      const labelRead = await request(base, "/api/dinodia/v1/devices", { headers });
      const labelDto = labelRead.body.data.find((candidate) => candidate.id === deviceId);
      assert.ok(labelDto, `Unicode label ${item.id} must not remove device identity`);
      const expected = raw.length === 0 ? null : Array.from(raw).slice(0, 40).join("");
      assert.equal(labelDto.customerLabel, expected, `OS Unicode projection ${item.id}`);
      assert.equal(Array.from(labelDto.customerLabel || "").length, item.projectedCodePoints, `OS code-point bound ${item.id}`);
      assert.equal(labelDto.controls.length, 2, `Unicode label ${item.id} must preserve current descriptors`);
      assert.equal(labelDto.managementClass, "tenant_device", `Unicode label ${item.id} must not change ownership`);
    }
    const power = dto.controls.find((control) => control.semanticRole === "power");
    const lock = dto.controls.find((control) => control.semanticRole === "security_lock");
    assert.ok(power && lock);
    assert.equal(power.valueType, "boolean");
    const stepUpNonce = crypto.randomBytes(24).toString("base64url");
    const stepUpChallenge = await request(base, "/api/step-up/descriptor-challenge", {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId, controlId: lock.controlId, serviceId: "lock.unlock", value: true, nonce: stepUpNonce }),
    });
    assert.equal(stepUpChallenge.response.status, 200, JSON.stringify(stepUpChallenge.body));
    assert.equal(hubSignatureCount, 1, "the valid selected sensitive operation obtains exactly one hub attestation");
    assert.equal(stepUpChallenge.body.descriptorRevision, dto.descriptorRevision);
    assert.equal(stepUpChallenge.body.identityGeneration, 7);
    assert.equal(stepUpChallenge.body.controlId, lock.controlId);
    const signedDescriptor = {
      version: Number(stepUpChallenge.body.version),
      serial: String(stepUpChallenge.body.serial),
      identityGeneration: Number(stepUpChallenge.body.identityGeneration),
      actorId: String(stepUpChallenge.body.actorId),
      customerSessionId: String(stepUpChallenge.body.customerSessionId),
      trustedDeviceId: String(stepUpChallenge.body.trustedDeviceId),
      homeId: String(stepUpChallenge.body.homeId),
      membershipId: String(stepUpChallenge.body.membershipId),
      hubInstallId: String(stepUpChallenge.body.hubInstallId),
      operationKind: String(stepUpChallenge.body.operationKind),
      targetIds: stepUpChallenge.body.targetIds.map(String),
      controlId: String(stepUpChallenge.body.controlId),
      descriptorRevision: Number(stepUpChallenge.body.descriptorRevision),
      descriptorDigest: stepUpChallenge.body.descriptorDigest == null ? null : String(stepUpChallenge.body.descriptorDigest),
      operationDigest: String(stepUpChallenge.body.operationDigest),
      nonce: String(stepUpChallenge.body.nonce),
      issuedAt: Number(stepUpChallenge.body.issuedAt),
    };
    const bodyHash = crypto.createHash("sha256").update(JSON.stringify(signedDescriptor), "utf8").digest("hex");
    const signedRequest = ["POST", "/api/step-up/descriptor-challenge", String(signedDescriptor.issuedAt), signedDescriptor.nonce, bodyHash].join("\n");
    assert.equal(crypto.verify(null, Buffer.from(signedRequest, "utf8"), hubSigningKeys.publicKey, Buffer.from(stepUpChallenge.body.hubSignature, "base64url")), true, "the returned challenge must be signed by the isolated hub identity over the exact current descriptor");
    const nonSensitiveChallenge = await request(base, "/api/step-up/descriptor-challenge", {
      method: "POST", headers,
      body: JSON.stringify({ deviceId, controlId: power.controlId, value: true, nonce: crypto.randomBytes(24).toString("base64url") }),
    });
    assert.equal(nonSensitiveChallenge.response.status, 403, "the descriptor attestation path is only for sensitive controls");
    const invalidSensitiveValue = await request(base, "/api/step-up/descriptor-challenge", {
      method: "POST", headers,
      body: JSON.stringify({ deviceId, controlId: lock.controlId, value: "unlock", nonce: crypto.randomBytes(24).toString("base64url") }),
    });
    assert.equal(invalidSensitiveValue.response.status, 400, "step-up cannot attest a value that violates the live boolean descriptor");
    assert.equal(hubSignatureCount, 1, "denied targets and invalid values are rejected before hub signing");
    const key = "native-command-idempotency-0001";
    const command = { commandId: "command-native-1", homeId: "home-command", homeMembershipId: "membership-command-tenant", deviceId, controlId: power.controlId, descriptorRevision: dto.descriptorRevision, value: true, issuedAt: new Date().toISOString(), idempotencyKey: key };
    assert.equal(validateNativeCommand(command, dto, power, "membership-command-tenant"), true);
    const send = (payload) => request(base, "/api/dinodia/v1/commands", { method: "POST", headers: { ...headers, "idempotency-key": payload.idempotencyKey }, body: JSON.stringify(payload) });
    const beforeImpossibleTimestamp = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const impossibleTimestamp = await send({ ...command, commandId: "command-native-impossible-date", idempotencyKey: "native-command-impossible-date", issuedAt: "2026-02-31T10:00:00Z" });
    assert.equal(impossibleTimestamp.response.status, 400, JSON.stringify(impossibleTimestamp.body));
    assert.equal(impossibleTimestamp.body.error.code, "VALIDATION_FAILED");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "OFF", "invalid command time must have no fake-device effect");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeImpossibleTimestamp, "invalid command time must create no dispatch event");
    const accepted = await send(command);
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.body.status, "applied", "the virtual adapter's versioned matching observation completes the receipt");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON");
    const streamedCommand = await websocketMessageMatching(nativeSocket, (item) => item.data?.commandId === command.commandId);
    assert.equal(streamedCommand.homeId, "home-command");
    assert.ok(streamedCommand.sequence > nativeSnapshot.body.sequence, "Native events have monotonic resume sequence after the snapshot cursor");
    const alexaCommand = { ...command, commandId: "alexa-command-native-test-1", value: false, issuedAt: new Date().toISOString(), idempotencyKey: "alexa-command-native-idempotency-0001" };
    const alexaNow = Math.floor(Date.now() / 1000);
    const alexaClaims = {
      accountId: "account-command-tenant", linkId: "alexa-link-native-test", endpointId: "dos_NativeAlexaEndpoint0000000001",
      homeId: alexaCommand.homeId, membershipId: alexaCommand.homeMembershipId, hubInstallationId: "native-command-hub",
      areaId: dto.areaIds[0], deviceId, controlId: power.controlId, descriptorRevision: dto.descriptorRevision,
      commandId: alexaCommand.commandId, idempotencyKey: alexaCommand.idempotencyKey,
      valueDigest: crypto.createHash("sha256").update(JSON.stringify(alexaCommand.value), "utf8").digest("hex"),
      policyRevision: 0, jti: "alexa-command-jti-native-test-1", issuedAt: alexaNow, expiresAt: alexaNow + 15,
    };
    const alexaToken = alexaCommandToken(alexaClaims, keys.privateKey);
    const publicKeys = parsePublicKeys(keys.publicKey.export({ type: "spki", format: "pem" }).toString());
    assert.ok(verifyAlexaCommandToken(alexaToken, { publicKeys, hubId: "native-command-hub", policyRevision: 0 }));
    assert.equal(verifyAlexaCommandToken(alexaToken, { publicKeys, hubId: "other-hub", policyRevision: 0 }), null, "Alexa command delegation cannot cross hubs");
    const extraClaimToken = alexaCommandToken({ ...alexaClaims, extraPayload: { householdRole: "OWNER" } }, keys.privateKey);
    assert.equal(verifyAlexaCommandToken(extraClaimToken, { publicKeys, hubId: "native-command-hub", policyRevision: 0 }), null, "Alexa command delegation rejects caller-added authority claims");
    const beforeAlexaEffects = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const sendAlexa = (token, payload = alexaCommand, route = "/api/dinodia/v1/alexa/commands") => request(base, route, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": payload.idempotencyKey }, body: JSON.stringify(payload),
    });
    const alexaAccepted = await sendAlexa(alexaToken);
    assert.equal(alexaAccepted.response.status, 202, JSON.stringify(alexaAccepted.body));
    assert.equal(alexaAccepted.body.status, "applied", "Alexa delegates through the same native descriptor and virtual adapter");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "OFF");
    const expectedObservationRevision = Number(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].stateRevision);
    assert.ok(Number.isSafeInteger(expectedObservationRevision) && expectedObservationRevision >= 0, "the test command is bound to the current native state revision");
    const guardedAlexaCommand = { ...alexaCommand, commandId: "alexa-command-native-revision-guard", value: true,
      issuedAt: new Date().toISOString(), idempotencyKey: "alexa-command-native-revision-guard-0001", expectedObservationRevision };
    const guardedAlexaClaims = { ...alexaClaims, commandId: guardedAlexaCommand.commandId, idempotencyKey: guardedAlexaCommand.idempotencyKey,
      valueDigest: crypto.createHash("sha256").update(JSON.stringify(guardedAlexaCommand.value), "utf8").digest("hex"),
      jti: "alexa-command-jti-native-revision-guard", issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 15,
      extraPayload: { expectedObservationRevision } };
    const guardedAlexaToken = alexaCommandToken(guardedAlexaClaims, keys.privateKey);
    assert.ok(verifyAlexaCommandToken(guardedAlexaToken, { publicKeys, hubId: "native-command-hub", policyRevision: 0 }));
    const guardedAlexaAccepted = await sendAlexa(guardedAlexaToken, guardedAlexaCommand);
    assert.equal(guardedAlexaAccepted.response.status, 202, JSON.stringify(guardedAlexaAccepted.body));
    assert.equal(guardedAlexaAccepted.body.status, "applied", "a signed expected observation revision is enforced at the OS effect boundary");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON");
    const effectsBeforeStaleObservation = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const staleObservationCommand = { ...guardedAlexaCommand, commandId: "alexa-command-stale-observation-revision", value: false,
      issuedAt: new Date().toISOString(), idempotencyKey: "alexa-stale-observation-revision-0001" };
    const staleObservationClaims = { ...guardedAlexaClaims, commandId: staleObservationCommand.commandId,
      idempotencyKey: staleObservationCommand.idempotencyKey,
      valueDigest: crypto.createHash("sha256").update(JSON.stringify(staleObservationCommand.value), "utf8").digest("hex"),
      jti: "alexa-command-jti-stale-observation", issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 15 };
    const staleObservationToken = alexaCommandToken(staleObservationClaims, keys.privateKey);
    const staleObservationDenied = await sendAlexa(staleObservationToken, staleObservationCommand);
    assert.equal(staleObservationDenied.response.status, 409, "an adjustment based on an observation consumed by a prior command is denied at dispatch");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, effectsBeforeStaleObservation,
      "stale-observation denial produces zero command effects");
    const stateClaims = {
      accountId: "account-command-tenant", linkId: "alexa-link-native-test", endpointId: "dos_NativeAlexaEndpoint0000000001",
      homeId: command.homeId, membershipId: command.homeMembershipId, hubInstallationId: "native-command-hub",
      areaId: dto.areaIds[0], deviceId, controlIds: [power.controlId], descriptorRevision: dto.descriptorRevision,
      policyRevision: 0, jti: "alexa-state-jti-native-test-1", issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 15,
    };
    const alexaStateBearer = alexaStateToken(stateClaims, keys.privateKey);
    assert.ok(verifyAlexaStateToken(alexaStateBearer, { publicKeys, hubId: "native-command-hub", policyRevision: 0 }));
    const alexaState = await request(base, "/api/dinodia/v1/alexa/state", { method: "POST",
      headers: { authorization: `Bearer ${alexaStateBearer}` }, body: JSON.stringify({ deviceId, controlIds: stateClaims.controlIds }) });
    assert.equal(alexaState.response.status, 200, JSON.stringify(alexaState.body));
    assert.equal(alexaState.body.endpointId, stateClaims.endpointId);
    assert.equal(alexaState.body.descriptorRevision, dto.descriptorRevision);
    assert.equal(alexaState.body.states.every((state) => state.deviceId === deviceId && state.controlId === power.controlId), true);
    assert.equal(JSON.stringify(alexaState.body).includes("tenantOwnerMembershipId"), false, "ReportState returns only the bound native observation, not device metadata");
    const alteredState = await request(base, "/api/dinodia/v1/alexa/state", { method: "POST",
      headers: { authorization: `Bearer ${alexaStateBearer}` }, body: JSON.stringify({ deviceId, controlIds: [lock.controlId] }) });
    assert.equal(alteredState.response.status, 403, "the state delegation cannot widen to an unapproved control");
    const alexaStateGenericRead = await request(base, "/api/dinodia/v1/snapshot", { headers: { authorization: `Bearer ${alexaStateBearer}` } });
    assert.equal(alexaStateGenericRead.response.status, 401, "Alexa state authority cannot read a household snapshot");
    const afterAlexaEffects = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    assert.equal(afterAlexaEffects, beforeAlexaEffects + 2);
    const alexaRetry = await sendAlexa(alexaToken);
    assert.equal(alexaRetry.response.status, 202);
    assert.equal(alexaRetry.body.commandId, alexaCommand.commandId);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, afterAlexaEffects, "Alexa retry reconciles the exact durable command without redispatch");
    const alexaAltered = await sendAlexa(alexaToken, { ...alexaCommand, value: !alexaCommand.value });
    assert.equal(alexaAltered.response.status, 403, "the delegation cannot be changed to a different value");
    const wrongAreaCommand = { ...alexaCommand, commandId: "alexa-command-wrong-area", idempotencyKey: "alexa-command-wrong-area-idempotency-0001" };
    const alexaWrongArea = alexaCommandToken({ ...alexaClaims, areaId: "area-uuid-command-other", commandId: wrongAreaCommand.commandId, idempotencyKey: wrongAreaCommand.idempotencyKey }, keys.privateKey);
    const wrongAreaResult = await sendAlexa(alexaWrongArea, wrongAreaCommand);
    assert.equal(wrongAreaResult.response.status, 404, "a signed delegation for another Area cannot resolve this device");
    const appRouteAttempt = await sendAlexa(alexaToken, alexaCommand, "/api/dinodia/v1/commands");
    assert.equal(appRouteAttempt.response.status, 401, "an Alexa-purpose token is not an app-session token");
    const alexaExpired = alexaCommandToken({ ...alexaClaims, commandId: "alexa-command-expired", idempotencyKey: "alexa-command-expired-idempotency-0001", issuedAt: now - 30, expiresAt: now - 1 }, keys.privateKey);
    const expiredResult = await sendAlexa(alexaExpired, { ...alexaCommand, commandId: "alexa-command-expired", idempotencyKey: "alexa-command-expired-idempotency-0001" });
    assert.equal(expiredResult.response.status, 401, "an expired Alexa delegation is rejected before effect");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "denied Alexa attempts preserve the last state committed by the revision-bound command");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, afterAlexaEffects, "altered, wrong-area, wrong-route and expired delegation attempts have zero dispatch effects");
    const commandReceipt = await request(base, `/api/dinodia/v1/commands/${encodeURIComponent(command.commandId)}`, { headers });
    assert.equal(commandReceipt.response.status, 200);
    assert.equal(commandReceipt.body.status, "applied");
    const foreignReceipt = await request(base, `/api/dinodia/v1/commands/${encodeURIComponent(command.commandId)}`, { headers: { authorization: `Bearer ${otherTenant}` } });
    assert.equal(foreignReceipt.response.status, 404, "another membership cannot retrieve a command receipt");
    const dispatchCount = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const retry = await send(command);
    assert.equal(retry.response.status, 202);
    assert.equal(retry.body.commandId, command.commandId);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount);
    const sameIdNewKeyRetry = await send({ ...command, idempotencyKey: "native-command-same-id-same-body-0001" });
    assert.equal(sameIdNewKeyRetry.response.status, 202, JSON.stringify(sameIdNewKeyRetry.body));
    assert.equal(sameIdNewKeyRetry.body.commandId, command.commandId);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount, "same command ID and operation with a replacement idempotency key cannot dispatch again");
    const conflicting = await send({ ...command, idempotencyKey: "native-command-same-id-different-body-0001", value: false });
    assert.equal(conflicting.response.status, 409);
    assert.equal(conflicting.body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount, "same command ID with a different body has no second dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "same-ID conflict has no second fake-device effect");
    const stale = await send({ ...command, commandId: "command-native-stale", idempotencyKey: "native-command-idempotency-0002", descriptorRevision: dto.descriptorRevision - 1 });
    assert.equal(stale.response.status, 409);
    const wrongHome = await send({ ...command, commandId: "command-native-wrong-home", idempotencyKey: "native-command-idempotency-0003", homeId: "home-other" });
    assert.equal(wrongHome.response.status, 403);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount);
    if (nativeSocket?.readyState === WebSocket.OPEN) {
      const nativeSocketClosed = new Promise((resolve) => nativeSocket.once("close", resolve));
      nativeSocket.close();
      await nativeSocketClosed;
      nativeSocket = null;
    }
    await hub.stop();
    hub = makeHub();
    await hub.start();
    originalUpdateEntity = hub.store.updateEntity.bind(hub.store);
    base = `http://127.0.0.1:${hub.server.address().port}`;
    const restartedSnapshot = await request(base, "/api/dinodia/v1/snapshot", { headers });
    nativeSocket = new WebSocket(`${base.replace("http", "ws")}/api/dinodia/v1/events?after=${restartedSnapshot.body.sequence}`, { headers });
    await new Promise((resolve, reject) => { nativeSocket.once("open", resolve); nativeSocket.once("error", reject); });
    const persistedDispatchCount = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const persistedRetry = await send(command);
    assert.equal(persistedRetry.response.status, 202, JSON.stringify(persistedRetry.body));
    assert.equal(persistedRetry.body.commandId, command.commandId);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, persistedDispatchCount, "restart preserves the original receipt and does not redispatch");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON");
    for (const [index, role] of ["OWNER", "PROPERTY_MANAGER"].entries()) {
      const nonTenantToken = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-command-hub", sub: `account-${role.toLowerCase()}`, sid: `sid-${role.toLowerCase()}`, jti: `jti-${role.toLowerCase()}`, membershipId: `membership-${role.toLowerCase()}`, trustedDeviceId: `trusted-${role.toLowerCase()}`, hubInstallationId: "native-command-hub", iat: now, exp: now + 300, homeId: "home-command", householdRole: role, areaIds: ["area-uuid-command-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
      const idempotencyKey = `native-command-non-tenant-${index}-0001`;
      const nonTenantCommand = await request(base, "/api/dinodia/v1/commands", { method: "POST", headers: { authorization: `Bearer ${nonTenantToken}`, "idempotency-key": idempotencyKey }, body: JSON.stringify({ ...command, commandId: `command-native-non-tenant-${index}`, idempotencyKey }) });
      assert.equal(nonTenantCommand.response.status, 403, `${role} is authenticated but has no direct-to-OS tenant command authority`);
      assert.equal(Object.hasOwn(nonTenantCommand.body, "data"), false);
      assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON");
      assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount, `${role} denial has no dispatch effect`);
    }

    const lockKey = "native-lock-command-idempotency-0001";
    const lockCommand = { ...command, commandId: "command-native-lock", controlId: lock.controlId, value: true, idempotencyKey: lockKey };
    const sendLock = (payload, proof = "") => request(base, "/api/dinodia/v1/commands", { method: "POST", headers: { ...headers, "idempotency-key": payload.idempotencyKey, ...(proof ? { "x-dinodia-step-up-proof": proof } : {}) }, body: JSON.stringify(payload) });
    const stepUpDispatchEvents = () => hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const beforeStepUpDenials = stepUpDispatchEvents();
    assert.equal((await sendLock(lockCommand)).response.status, 400);
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "LOCKED");
    const jti = "stepup-operation-native-1";
    const issuedAt = Math.floor(Date.now() / 1000);
    const descriptorDigest = require('../src/auth/stepUpDescriptorDigest').stepUpDescriptorDigest(hub.store.getDevice(deviceId));
    assert.match(descriptorDigest, /^[0-9a-f]{64}$/, 'the operation proof uses the canonical raw-hex descriptor digest');
    const signedValue = descriptorBoundValue({ value: true, controlId: lock.controlId }, { [deviceId]: descriptorDigest });
    const operationDigest = digestOperation({ actorId: "account-command-tenant", trustedDeviceId: "trusted-command", customerSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operationKind: "device_sensitive_command", targetIds: [deviceId], value: signedValue });
    const unsignedProof = { jti, actorId: "account-command-tenant", trustedDeviceId: "trusted-command", customerSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operationDigest, issuedAt, expiresAt: issuedAt + 60 };
    const encodedProof = Buffer.from(JSON.stringify(unsignedProof)).toString("base64url");
    const proof = `${encodedProof}.${crypto.sign(null, Buffer.from(JSON.stringify(unsignedProof)), keys.privateKey).toString("base64url")}`;
    const encodeProof = (payload) => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${crypto.sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString("base64url")}`;
    lockCommand.stepUpOperationId = jti;
    const proofCheck = await new StepUpProofVerifier({ publicKeys: [keys.publicKey] }).verify(proof, { actorId: "account-command-tenant", trustedDeviceId: "trusted-command", trustedSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operation: "device_sensitive_command", targetIds: [deviceId], value: signedValue });
    assert.ok(proofCheck, "test proof must verify under the Platform/OS step-up contract");
    const expiredProofPayload = { ...unsignedProof, jti: "stepup-operation-native-expired", expiresAt: issuedAt - 1 };
    const expiredProof = encodeProof(expiredProofPayload);
    const expiredAttempt = await sendLock({ ...lockCommand, commandId: "command-native-lock-expired-proof", idempotencyKey: "native-lock-command-expired-proof-0001", stepUpOperationId: expiredProofPayload.jti }, expiredProof);
    assert.equal(expiredAttempt.response.status, 403, JSON.stringify(expiredAttempt.body));
    assert.equal(expiredAttempt.body.error?.code, "STEP_UP_REQUIRED");
    assert.equal(stepUpDispatchEvents(), beforeStepUpDenials, "an expired operation proof creates no command event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "LOCKED", "an expired operation proof has no fake-device effect");
    const wrongValue = descriptorBoundValue({ value: false, controlId: lock.controlId }, { [deviceId]: descriptorDigest });
    const mismatchedOperationPayload = {
      ...unsignedProof,
      jti: "stepup-operation-native-wrong-value",
      operationDigest: digestOperation({ actorId: "account-command-tenant", trustedDeviceId: "trusted-command", customerSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operationKind: "device_sensitive_command", targetIds: [deviceId], value: wrongValue }),
    };
    const mismatchedOperationProof = encodeProof(mismatchedOperationPayload);
    const mismatchedOperationAttempt = await sendLock({ ...lockCommand, commandId: "command-native-lock-wrong-proof-value", idempotencyKey: "native-lock-command-wrong-proof-value-0001", stepUpOperationId: mismatchedOperationPayload.jti }, mismatchedOperationProof);
    assert.equal(mismatchedOperationAttempt.response.status, 403, JSON.stringify(mismatchedOperationAttempt.body));
    assert.equal(mismatchedOperationAttempt.body.error?.code, "STEP_UP_REQUIRED");
    assert.equal(stepUpDispatchEvents(), beforeStepUpDenials, "a proof for a different exact value creates no command event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "LOCKED", "a proof for a different exact value has no fake-device effect");
    const unlocked = await sendLock(lockCommand, proof);
    assert.equal(unlocked.response.status, 202, JSON.stringify(unlocked.body));
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "UNLOCKED");
    const replay = await sendLock({ ...lockCommand, commandId: "command-native-lock-replay", idempotencyKey: "native-lock-command-idempotency-0002" }, proof);
    assert.equal(replay.response.status, 403);
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "UNLOCKED");

    const beforeMalformedDigest = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const descriptorBeforeMalformedDigest = hub.store.getDevice(deviceId);
    const validFingerprint = descriptorBeforeMalformedDigest.presentation.sourceFingerprint;
    hub.store.state.devices[deviceId].presentation.sourceFingerprint = "sha256:malformed";
    const malformedDigestCommand = { ...lockCommand, commandId: "command-native-lock-malformed-digest", idempotencyKey: "native-command-malformed-descriptor-digest-0001", stepUpOperationId: "operation-malformed-descriptor-digest" };
    const malformedDigestResponse = await sendLock(malformedDigestCommand, proof);
    assert.equal(malformedDigestResponse.response.status, 409, JSON.stringify(malformedDigestResponse.body));
    assert.equal(malformedDigestResponse.body.error?.code, "CATALOG_REVISION_MISMATCH");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeMalformedDigest, "an invalid descriptor fingerprint is denied before a command event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "UNLOCKED", "an invalid descriptor fingerprint has zero fake-device effect");
    hub.store.state.devices[deviceId].presentation.sourceFingerprint = validFingerprint;

    const beforeReadOnlyProbe = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const currentDevice = hub.store.getDevice(deviceId);
    const readOnlyEntity = currentDevice.entities[`${deviceId}:0:state`];
    const originalSaveSecurity = hub.store.saveSecurity.bind(hub.store);
    restoreSaveSecurity = () => { hub.store.saveSecurity = originalSaveSecurity; };
    let signalDispatchClaim;
    const dispatchClaimSaved = new Promise((resolve) => { signalDispatchClaim = resolve; });
    const dispatchClaimGate = new Promise((resolve) => { releaseQueuedCommand = resolve; });
    hub.store.saveSecurity = async (patch) => {
      const result = await originalSaveSecurity(patch);
      if (Object.values(patch.nativeCommandResults || {}).some((entry) => entry?.status === "dispatching")) {
        signalDispatchClaim();
        await dispatchClaimGate;
      }
      return result;
    };
    const queuedCommand = { ...command, commandId: "command-native-queued-descriptor-change", idempotencyKey: "native-command-idempotency-queued-change", value: false };
    const queuedRequest = send(queuedCommand);
    await dispatchClaimSaved;
    await hub.store.upsertDevice({
      ...currentDevice,
      entities: {
        ...currentDevice.entities,
        [`${deviceId}:0:state`]: {
          ...readOnlyEntity,
          capability: { ...readOnlyEntity.capability, writable: false },
        },
      },
    });
    releaseQueuedCommand();
    const queuedDenied = await queuedRequest;
    restoreSaveSecurity();
    assert.equal(queuedDenied.response.status, 409, JSON.stringify(queuedDenied.body));
    assert.equal(queuedDenied.body.error.code, "CATALOG_REVISION_MISMATCH");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeReadOnlyProbe, "a control made read-only while its dispatch claim was being persisted has no event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "a control made read-only while queued has no fake-device effect");
    const queuedRetry = await send(queuedCommand);
    assert.ok([400, 409].includes(queuedRetry.response.status), "an exact retry of a known pre-dispatch denial remains denied");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeReadOnlyProbe, "an exact denied retry cannot dispatch later");
    const changedCatalog = await request(base, "/api/dinodia/v1/devices", { headers });
    const changedDto = changedCatalog.body.data.find((item) => item.id === deviceId);
    const changedPower = changedDto?.controls.find((control) => control.semanticRole === "power");
    assert.ok(changedPower, "a newly read-only descriptor remains visible for read-only use");
    assert.equal(changedPower.writable, false);
    const readOnlyAttempt = await send({ ...command, commandId: "command-native-read-only", idempotencyKey: "native-command-idempotency-read-only", descriptorRevision: changedDto.descriptorRevision });
    assert.ok([400, 409].includes(readOnlyAttempt.response.status), JSON.stringify(readOnlyAttempt.body));
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeReadOnlyProbe, "a newly read-only control has no dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "a newly read-only control has no fake-device effect");
    // A control can disappear after the durable dispatch claim is written but
    // before the final dispatch check. Treat removal as loss of authority, not
    // as permission to dispatch the previously captured protocol binding.
    const beforeRemovedControlProbe = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const beforeRemovalDevice = hub.store.getDevice(deviceId);
    const powerEntityKey = Object.keys(beforeRemovalDevice.entities).find((key) => beforeRemovalDevice.entities[key].capability?.semanticRole === "power");
    assert.ok(powerEntityKey, "the removal race starts with the current power control");
    const currentPowerEntity = beforeRemovalDevice.entities[powerEntityKey];
    await hub.store.upsertDevice({
      ...beforeRemovalDevice,
      entities: { ...beforeRemovalDevice.entities, [powerEntityKey]: { ...currentPowerEntity, capability: { ...currentPowerEntity.capability, writable: true } } },
    });
    const writableCatalog = await request(base, "/api/dinodia/v1/devices", { headers });
    const writableDto = writableCatalog.body.data.find((item) => item.id === deviceId);
    const writablePower = writableDto?.controls.find((control) => control.semanticRole === "power");
    assert.equal(writablePower?.writable, true, "the removal race must begin with a currently writable descriptor");
    const removedControlCommand = {
      ...command,
      commandId: "command-native-queued-control-removed",
      controlId: writablePower.controlId,
      descriptorRevision: writableDto.descriptorRevision,
      idempotencyKey: "native-command-idempotency-queued-control-removed",
      value: false,
    };
    let signalRemovedControlClaim;
    const removedControlClaimSaved = new Promise((resolve) => { signalRemovedControlClaim = resolve; });
    let releaseRemovedControlGate = () => {};
    const removedControlGate = new Promise((resolve) => { releaseRemovedControlGate = resolve; });
    restoreSaveSecurity();
    hub.store.saveSecurity = async (patch) => {
      const result = await originalSaveSecurity(patch);
      if (Object.values(patch.nativeCommandResults || {}).some((entry) => entry?.status === "dispatching" && entry?.commandDigest)) {
        signalRemovedControlClaim();
        await removedControlGate;
      }
      return result;
    };
    releaseQueuedCommand = releaseRemovedControlGate;
    const removedControlRequest = send(removedControlCommand);
    await removedControlClaimSaved;
    assert.equal(await hub.store.removeEntity(deviceId, powerEntityKey), true, "the registry removal path must remove the current raw control");
    releaseRemovedControlGate();
    const removedControlDenied = await removedControlRequest;
    restoreSaveSecurity();
    assert.equal(removedControlDenied.response.status, 409, JSON.stringify(removedControlDenied.body));
    assert.equal(removedControlDenied.body.error.code, "CATALOG_REVISION_MISMATCH");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeRemovedControlProbe, "a control removed while queued has no device-command event");
    assert.equal(hub.store.getDevice(deviceId).entities[powerEntityKey], undefined, "the queued removal remains in force after denial");
    const catalogAfterRemoval = await request(base, "/api/dinodia/v1/devices", { headers });
    const deviceAfterRemoval = catalogAfterRemoval.body.data.find((item) => item.id === deviceId);
    assert.ok(deviceAfterRemoval, "removing one control must preserve the device's remaining identity");
    assert.equal(deviceAfterRemoval.controls.some((candidate) => candidate.controlId === writablePower.controlId), false, "a removed control cannot remain in the live Native V1 catalogue");

    const afterRemovalDevice = hub.store.getDevice(deviceId);
    await hub.store.upsertDevice({
      ...afterRemovalDevice,
      entities: { ...afterRemovalDevice.entities, [powerEntityKey]: { ...currentPowerEntity, capability: { ...currentPowerEntity.capability, writable: true } } },
    });

    const beforeOwnershipChange = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const beforeOwnershipDevice = hub.store.getDevice(deviceId);
    const ownershipEntity = beforeOwnershipDevice.entities[`${deviceId}:0:state`];
    await hub.store.upsertDevice({
      ...beforeOwnershipDevice,
      tenantOwnerMembershipId: "membership-other-tenant",
      metadata: { ...beforeOwnershipDevice.metadata, tenantOwnerMembershipId: "membership-other-tenant" },
      entities: { ...beforeOwnershipDevice.entities, [`${deviceId}:0:state`]: { ...ownershipEntity, capability: { ...ownershipEntity.capability, writable: true } } },
    });
    const changedOwnerCatalog = await request(base, "/api/dinodia/v1/devices", { headers });
    assert.equal(changedOwnerCatalog.response.status, 200);
    assert.equal(changedOwnerCatalog.body.data.some((item) => item.id === deviceId), false, "current ownership change immediately removes the device from the prior tenant view");
    assert.equal(JSON.stringify(changedOwnerCatalog.body).includes(deviceId), false);
    const changedOwnerAttempt = await send({ ...command, commandId: "command-native-changed-owner", idempotencyKey: "native-command-idempotency-changed-owner" });
    assert.equal(changedOwnerAttempt.response.status, 404, JSON.stringify(changedOwnerAttempt.body));
    assert.equal(changedOwnerAttempt.body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "a command after ownership changes has no fake-device effect");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeOwnershipChange, "a command after ownership changes has no dispatch event");
    const changedOwnerDevice = hub.store.getDevice(deviceId);
    await hub.store.upsertDevice({ ...changedOwnerDevice, tenantOwnerMembershipId: "membership-command-tenant", metadata: { ...changedOwnerDevice.metadata, tenantOwnerMembershipId: "membership-command-tenant" } });

    const concurrentCatalog = await request(base, "/api/dinodia/v1/devices", { headers });
    const concurrentDevice = concurrentCatalog.body.data.find((item) => item.id === deviceId);
    const concurrentPower = concurrentDevice.controls.find((control) => control.semanticRole === "power");
    const concurrentCommands = [
      { ...command, commandId: "command-native-concurrent-id", controlId: concurrentPower.controlId, descriptorRevision: concurrentDevice.descriptorRevision, idempotencyKey: "native-command-concurrent-false-0001", value: false },
      { ...command, commandId: "command-native-concurrent-id", controlId: concurrentPower.controlId, descriptorRevision: concurrentDevice.descriptorRevision, idempotencyKey: "native-command-concurrent-true-0001", value: true },
    ];
    const beforeConcurrentDispatch = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const concurrentResults = await Promise.all(concurrentCommands.map(send));
    assert.deepEqual(concurrentResults.map((item) => item.response.status).sort(), [202, 409], "serialized commands sharing an ID elect exactly one operation");
    const winnerIndex = concurrentResults.findIndex((item) => item.response.status === 202);
    assert.equal(concurrentResults[1 - winnerIndex].body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeConcurrentDispatch + 1, "concurrent conflicting command IDs cause exactly one device effect");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, concurrentCommands[winnerIndex].value ? "ON" : "OFF", "the virtual device matches the sole accepted concurrent operation");

    const stateEntityId = `${deviceId}:0:state`;
    const outcomeCatalog = await request(base, "/api/dinodia/v1/devices", { headers });
    const outcomeDevice = outcomeCatalog.body.data.find((item) => item.id === deviceId);
    const outcomePower = outcomeDevice.controls.find((item) => item.semanticRole === "power");
    const beforeFailedCommandEffects = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    hub.store.updateEntity = async () => { throw Object.assign(new Error("controlled virtual adapter rejection"), { code: "controlled_rejection", statusCode: 409 }); };
    const failedCommand = { ...command, commandId: "command-native-definite-failure", controlId: outcomePower.controlId, descriptorRevision: outcomeDevice.descriptorRevision, idempotencyKey: "native-command-definite-failure-0001", value: true };
    const failedOutcome = await send(failedCommand);
    hub.store.updateEntity = originalUpdateEntity;
    assert.equal(failedOutcome.response.status, 202);
    assert.equal(failedOutcome.body.status, "failed", "a known pre-effect adapter rejection becomes a durable failed receipt");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeFailedCommandEffects, "known adapter rejection has no command effect");

    const timeoutCommand = { ...command, commandId: "command-native-confirmation-timeout", controlId: outcomePower.controlId, descriptorRevision: outcomeDevice.descriptorRevision, idempotencyKey: "native-command-confirmation-timeout-0001", value: false };
    hub.store.updateEntity = async (id, entityId, patch) => originalUpdateEntity(id, entityId, { ...patch, state: "ON" });
    const pendingOutcome = await send(timeoutCommand);
    hub.store.updateEntity = originalUpdateEntity;
    assert.equal(pendingOutcome.response.status, 202);
    assert.equal(pendingOutcome.body.status, "accepted", "a mismatching observation does not imply application");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const timedOutOutcome = await request(base, `/api/dinodia/v1/commands/${encodeURIComponent(timeoutCommand.commandId)}`, { headers });
    assert.equal(timedOutOutcome.body.status, "timed_out", "lack of a matching observation becomes an explicit bounded timeout, not success");
    const timedOutRecord = Object.values(hub.store.getSecurity().nativeCommandResults).find((entry) => entry.result?.commandId === timeoutCommand.commandId);
    assert.ok(timedOutRecord, "the timed-out command retains a durable observation baseline");
    await originalUpdateEntity(deviceId, stateEntityId, { state: "OFF", stateRevision: Number(timedOutRecord.observationRevision || 0) + 1, lastChanged: new Date().toISOString() });
    hub.eventBus.emit("state_changed", { entity_id: stateEntityId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lateOutcome = await request(base, `/api/dinodia/v1/commands/${encodeURIComponent(timeoutCommand.commandId)}`, { headers });
    assert.equal(lateOutcome.body.status, "applied", "a later correlated matching observation resolves the same receipt without redispatch");

    const beforeRetiredProbe = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    await hub.store.updateDeviceState(deviceId, { state: "ON" }, { protocol: "virtual", available: true });
    const retiredDevice = { ...hub.store.getDevice(deviceId), retired: true };
    await hub.store.upsertDevice(retiredDevice);
    hub.eventBus.emit("registry_updated", { registry: "device", id: deviceId });
    const retiredTombstone = await websocketMessageMatching(nativeSocket, (event) => event.data?.deviceId === deviceId && Array.isArray(event.data?.deletedControlIds));
    assert.deepEqual(new Set(retiredTombstone.data.deletedControlIds), new Set([power.controlId, lock.controlId]), "retiring a current device emits a control tombstone for open native screens");
    const retiredInventory = await request(base, "/api/dinodia/v1/devices", { headers });
    assert.equal(retiredInventory.response.status, 200);
    assert.equal(retiredInventory.body.data.some((item) => item.id === deviceId), false, "retired predecessors are absent from current inventory");
    assert.equal(JSON.stringify(retiredInventory.body).includes(deviceId), false, "current inventory does not disclose retired identity");
    assert.equal((await request(base, `/api/dinodia/v1/devices/${encodeURIComponent(deviceId)}`, { headers })).response.status, 404);
    const retiredAttempt = await send({ ...command, commandId: "command-native-retired", idempotencyKey: "native-command-idempotency-retired" });
    assert.ok([400, 409].includes(retiredAttempt.response.status), JSON.stringify(retiredAttempt.body));
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeRetiredProbe, "retired command denial has no dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "retired command denial has no fake-device effect");

    // Policy revocation must be checked again at the command boundary, not
    // inferred from an earlier successful catalog read or WebSocket auth.
    await hub.store.savePlatform({ ...(hub.store.getPlatform() || {}), policyRevision: 1 });
    const beforeRevokedPolicyCommand = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const revokedPolicyCommand = await send({
      ...command,
      commandId: "command-native-revoked-policy",
      idempotencyKey: "native-command-idempotency-revoked-policy",
    });
    assert.equal(revokedPolicyCommand.response.status, 401, JSON.stringify(revokedPolicyCommand.body));
    assert.equal(revokedPolicyCommand.body.error?.code, "AUTH_REQUIRED");
    assert.equal(Object.hasOwn(revokedPolicyCommand.body, "data"), false, "revoked command denial returns no protected DTO");
    assert.equal(JSON.stringify(revokedPolicyCommand.body).includes(deviceId), false, "revoked command denial does not reveal the device identity");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeRevokedPolicyCommand, "a stale policy token creates no command event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "a stale policy token has zero fake-device effect");
  } finally {
    releaseQueuedCommand(); restoreSaveSecurity(); nativeSocket?.close(); socket?.close();
    await hub.stop();
    await hub.store.persist();
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
  await hub.store.upsertDevice({ id: "property-light", name: "Property light", protocol: "virtual", areaId: "area-1", managementClass: "property_device", metadata: { label: "tenant_device", managementClass: "property_device" } });
  await hub.store.upsertDevice({ id: "private-lamp", name: "Tenant lamp", protocol: "virtual", areaId: "area-1", managementClass: "tenant_device", tenantOwnerMembershipId: "membership-tenant-42", metadata: { label: "Tenant's lamp", managementClass: "tenant_device", tenantOwnerMembershipId: "membership-tenant-42" } });
  await hub.store.savePlatform({ areaBindings: [{ areaId: "area-1", hubAreaId: "area-1" }] });
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

test("offline enrolled authority reaches only the actual loopback customer TLS listener and dispatches one current signed command", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-offline-route-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cloudPort = await freeLoopbackPort();
  const lanPort = await freeLoopbackPort();
  // The real iOS trusted-device identity is Secure Enclave P-256. Keep the
  // route proof on that curve, not a test-only Ed25519 key the app cannot use.
  const identityKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const hubId = "offline-native-hub";
  const lanTlsIdentity = new LanTlsIdentity({ dataDir: path.join(directory, "lan-identity") });
  const loopbackDiscovery = {
    start() {}, stop() {},
    observation() { return { version: 1, state: "CURRENT", address: "127.0.0.1", baseUrl: `http://127.0.0.1:${lanPort}`, discoveryHost: `dinodia-${hubId}.local` }; },
  };
  const hub = createHub({
    config: { nodeEnv: "production", v2Environment: "test", loopbackLanListenerForTest: true, customerLanPortForTest: lanPort, hubId, port: 0, haPort: cloudPort, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    lanTlsIdentityForTest: lanTlsIdentity,
    setupDiscoveryForTest: loopbackDiscovery,
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  const area = await hub.store.saveArea({ name: "Kitchen" }, "area-offline-kitchen");
  await hub.store.savePlatform({ homeId: "home-offline", policyRevision: 4, areaBindings: [{ areaId: "area-public-offline", hubAreaId: area.id }] });
  const deviceId = "device-offline-switch";
  const entityId = `${deviceId}:state`;
  await hub.store.upsertDevice({
    id: deviceId, name: "Offline switch", protocol: "virtual", areaId: area.id,
    managementClass: "tenant_device", tenantOwnerMembershipId: "membership-offline-tenant",
    entities: { [entityId]: { id: entityId, sourceId: entityId, deviceId, endpointId: "0", logicalKey: "state", stateKey: "state", domain: "switch", state: "OFF", stateRevision: 1, lastChanged: new Date().toISOString(), capability: { runtime: "dinodia_os", kind: "binary", category: "control", readable: true, writable: true, observable: true, primary: true, semanticRole: "power", bindings: [{ serviceId: "switch.turn_on" }, { serviceId: "switch.turn_off" }] } } },
  });
  await hub.store.completeDeviceSetup(deviceId, { areaId: area.id, labelId: "light" });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const lanTlsReport = lanTlsIdentity.publicReport();
  const lanListener = hub.getLanHttpsServer();
  assert.equal(lanListener?.listening, true, "createHub starts its actual authenticated customer HTTPS listener");
  assert.deepEqual(lanListener.address(), { address: "127.0.0.1", family: "IPv4", port: lanPort }, "the TLS listener is confined to loopback in this integration test");
  const storedLanIdentity = JSON.parse(require("node:fs").readFileSync(path.join(directory, "lan-identity", "lan-tls", "identity.json"), "utf8"));
  const lanCertificatePem = require("node:fs").readFileSync(path.join(directory, "lan-identity", "lan-tls", storedLanIdentity.current.certificateFile));
  const customerLanBase = `https://${lanTlsReport.host}:${lanPort}`;
  const tlsRequest = (route, options = {}, pin = lanTlsReport.currentSpkiPin) => pinnedTlsRequest(customerLanBase, route, options, lanCertificatePem, pin);
  const resolverReference = `DNO-HOME-${crypto.randomBytes(32).toString("base64url")}`;
  const issuedResolverChallenge = {
    version: 1, serial: "offline-native-hub", identityGeneration: 1,
    challengeId: crypto.randomUUID(), challenge: crypto.randomBytes(24).toString("base64url"),
    resolverGeneration: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    timestamp: String(Date.now()), nonce: crypto.randomBytes(24).toString("base64url"),
    bodyHash: crypto.createHash("sha256").update("controlled-test-proof").digest("hex"),
    hubSignature: crypto.randomBytes(48).toString("base64url"),
  };
  const resolverReferences = [];
  hub.pairing.requestPermanentClaimChallenge = async (reference) => {
    resolverReferences.push(reference);
    return issuedResolverChallenge;
  };
  const resolverPath = "/api/dinodia/v1/claim-resolver/challenge";
  const tlsResolver = await tlsRequest(resolverPath, { method: "POST", body: JSON.stringify({ reference: resolverReference }) });
  assert.equal(tlsResolver.response.status, 200, JSON.stringify(tlsResolver.body));
  assert.deepEqual(resolverReferences, [resolverReference], "only the current identity-pinned HTTPS listener may ask Platform for a permanent-label challenge");
  const wrongHostResolver = await tlsRequest(resolverPath, { method: "POST", headers: { host: `wrong.local:${lanPort}` }, body: JSON.stringify({ reference: resolverReference }) });
  assert.equal(wrongHostResolver.response.status, 404);
  const installerHttpResolver = await request(base, `/_dinodia/setup/claim-challenge?reference=${encodeURIComponent(resolverReference)}`);
  assert.equal(installerHttpResolver.response.status, 404, "installer HTTP is not a Home-claim authority path");
  assert.deepEqual(resolverReferences, [resolverReference], "wrong-host TLS and installer HTTP denials have zero challenge issuance effects");
  const offline = new OfflineLanAuthorisationStore({ store: hub.store });
  const grant = await offline.enroll({ id: "offline-grant-1", homeId: "home-offline", hubInstallId: hubId, membershipId: "membership-offline-tenant", trustedDeviceId: "trusted-offline", userId: "account-offline", householdRole: "TENANT", publicKey: identityKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), areaIds: ["area-public-offline"], scope: ["tenant:device-command"], policyRevision: 4 });
  const now = Date.now();
  const offlineHeaders = (purpose, requestPath, values = {}) => {
    const challenge = createNativeLanChallenge({
      grantId: grant.id, purpose, homeId: grant.homeId, hubInstallId: grant.hubInstallId,
      membershipId: grant.membershipId, trustedDeviceId: grant.trustedDeviceId,
      policyRevision: grant.policyRevision, areaIds: grant.areaIds, requestPath,
      ...values, now,
    });
    return {
      "x-dinodia-offline-grant": grant.id,
      "x-dinodia-offline-challenge": Buffer.from(JSON.stringify(challenge)).toString("base64url"),
      "x-dinodia-offline-signature": signLanChallenge(challenge, identityKeys.privateKey),
    };
  };
  const issueOfflineChallenge = async (purpose, requestPath, values = {}) => {
    const response = await tlsRequest("/api/dinodia/v1/offline/challenges", {
      method: "POST",
      headers: { "x-dinodia-offline-grant": grant.id },
      body: JSON.stringify({ purpose, requestPath, ...values }),
    });
    assert.equal(response.response.status, 200, JSON.stringify(response.body));
    assert.equal(typeof response.body.signingPayload, "string");
    const challenge = response.body.challenge;
    const signedBytes = Buffer.from(response.body.signingPayload, "base64url");
    assert.deepEqual(JSON.parse(signedBytes.toString("utf8")), challenge, "the hub supplies the exact canonical signing payload");
    return {
      "x-dinodia-offline-grant": grant.id,
      "x-dinodia-offline-challenge": Buffer.from(JSON.stringify(challenge)).toString("base64url"),
      "x-dinodia-offline-signature": signLanChallenge(challenge, identityKeys.privateKey),
    };
  };
  try {
    const readPath = "/api/dinodia/v1/devices";
    await assert.rejects(() => tlsRequest(readPath, { headers: offlineHeaders("native.read", readPath) }, "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), /pin mismatch/);
    const read = await tlsRequest(readPath, { headers: offlineHeaders("native.read", readPath) });
    assert.equal(read.response.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.data.map((item) => item.id), [deviceId]);
    assert.equal(JSON.stringify(read.body).includes("hubAreaId"), false);
    const serverIssuedReadHeaders = await issueOfflineChallenge("native.read", readPath);
    const serverIssuedRead = await tlsRequest(readPath, { headers: serverIssuedReadHeaders });
    assert.equal(serverIssuedRead.response.status, 200, JSON.stringify(serverIssuedRead.body));
    assert.deepEqual(serverIssuedRead.body.data.map((item) => item.id), [deviceId]);
    const wrongChallenge = await tlsRequest("/api/dinodia/v1/offline/challenges", {
      method: "POST", headers: { "x-dinodia-offline-grant": grant.id },
      body: JSON.stringify({ purpose: "native.read", requestPath: "/api/devices", homeId: "home-other" }),
    });
    assert.equal(wrongChallenge.response.status, 400, "the client cannot widen challenge route or home scope");
    const wrongHomeChallenge = createNativeLanChallenge({ grantId: grant.id, purpose: "native.read", homeId: "home-other", hubInstallId: grant.hubInstallId, membershipId: grant.membershipId, trustedDeviceId: grant.trustedDeviceId, policyRevision: grant.policyRevision, areaIds: grant.areaIds, requestPath: readPath, now });
    const wrongHomeRead = await tlsRequest(readPath, { headers: { "x-dinodia-offline-grant": grant.id, "x-dinodia-offline-challenge": Buffer.from(JSON.stringify(wrongHomeChallenge)).toString("base64url"), "x-dinodia-offline-signature": signLanChallenge(wrongHomeChallenge, identityKeys.privateKey) } });
    assert.equal(wrongHomeRead.response.status, 401);
    assert.equal(Object.hasOwn(wrongHomeRead.body, "data"), false);
    const oldPath = "/api/devices";
    const oldApi = await tlsRequest(oldPath, { headers: offlineHeaders("native.read", oldPath) });
    assert.equal(oldApi.response.status, 401, "offline authority is rejected before any HA-shaped compatibility response");
    assert.equal(JSON.stringify(oldApi.body).includes(deviceId), false);
    const cloudFallbackAttempt = await request(base, readPath, { headers: offlineHeaders("native.read", readPath) });
    assert.equal(cloudFallbackAttempt.response.status, 401, "offline authority cannot cross the loopback CloudURL/HTTP listener");
    assert.equal(Object.hasOwn(cloudFallbackAttempt.body, "data"), false);

    const snapshot = await tlsRequest(readPath, { headers: offlineHeaders("native.read", readPath) });
    const device = snapshot.body.data.find((item) => item.id === deviceId);
    const control = device.controls.find((item) => item.semanticRole === "power");
    const command = { commandId: crypto.randomUUID(), homeId: grant.homeId, homeMembershipId: grant.membershipId, deviceId, controlId: control.controlId, descriptorRevision: device.descriptorRevision, value: true, issuedAt: new Date(now).toISOString(), idempotencyKey: crypto.randomBytes(24).toString("base64url") };
    const commandPath = "/api/dinodia/v1/commands";
    const makeCommandHeaders = async (body) => ({ ...await issueOfflineChallenge("native.command", commandPath, { deviceId, controlId: control.controlId, descriptorRevision: device.descriptorRevision, valueDigest: digestNativeOfflineCommand(body) }), "idempotency-key": body.idempotencyKey });
    const acceptedHeaders = await makeCommandHeaders(command);
    const accepted = await tlsRequest(commandPath, { method: "POST", headers: acceptedHeaders, body: JSON.stringify(command) });
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.body.status, "applied", "the virtual adapter's matching post-dispatch observation supplies the terminal receipt");
    assert.equal(hub.store.getDevice(deviceId).entities[entityId].state, "ON", "the actual virtual adapter receives the authorized local effect");
    const effectCount = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    assert.equal(effectCount, 1);

    const exactRetry = await tlsRequest(commandPath, { method: "POST", headers: await makeCommandHeaders(command), body: JSON.stringify(command) });
    assert.equal(exactRetry.response.status, 202, JSON.stringify(exactRetry.body));
    assert.equal(exactRetry.body.commandId, command.commandId);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, effectCount, "freshly signed exact retry reconciles the receipt without redispatch");

    const altered = { ...command, value: false, commandId: command.commandId };
    const conflict = await tlsRequest(commandPath, { method: "POST", headers: await makeCommandHeaders(altered), body: JSON.stringify(altered) });
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
    assert.equal(hub.store.getDevice(deviceId).entities[entityId].state, "ON");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, effectCount);

    const replay = await tlsRequest(commandPath, { method: "POST", headers: acceptedHeaders, body: JSON.stringify(command) });
    assert.equal(replay.response.status, 401, "consumed offline nonce cannot authorize a different request");
    const cloudForwarded = await tlsRequest(readPath, { headers: { ...offlineHeaders("native.read", readPath), "x-forwarded-for": "203.0.113.7" } });
    assert.equal(cloudForwarded.response.status, 401, "offline authority cannot traverse a forwarded CloudURL request");
    assert.equal(hub.store.getDevice(deviceId).entities[entityId].state, "ON");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, effectCount);
    await hub.store.savePlatform({ policyRevision: 5 });
    const changedPolicy = await tlsRequest(readPath, { headers: offlineHeaders("native.read", readPath) });
    assert.equal(changedPolicy.response.status, 401, "a newer locally synchronized policy revokes the older offline grant before reading");
    assert.equal(Object.hasOwn(changedPolicy.body, "data"), false);
  } finally {
    await hub.stop();
  }
});
