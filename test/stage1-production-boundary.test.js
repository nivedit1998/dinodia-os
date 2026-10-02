const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createHub } = require("../src/server");
const crypto = require("node:crypto");
const { createOperatorSessionToken } = require("../src/auth/operatorSession");
const { validateCommand: validateNativeCommand } = require("../src/contracts/dinodiaV1");
const { digestOperation, descriptorBoundValue, StepUpProofVerifier } = require("../src/auth/stepUpProofVerifier");

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

function appToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-APP-1", v: 1 })}.${encode(claims)}`;
  return `dno-app-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}

function websocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OS WebSocket response timed out")), 2000);
    socket.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
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
  await hub.store.upsertDevice({ id: "tenant-owned-light", name: "Private lamp", protocol: "virtual", areaId: "area-kitchen", managementClass: "tenant_device", tenantOwnerMembershipId: "membership-tenant-a", metadata: { managementClass: "tenant_device", tenantOwnerMembershipId: "membership-tenant-a" } });
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
  const hub = createHub({
    config: { nodeEnv: "production", v2Environment: "test", appPublicKeys: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId: "native-command-hub", port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    identityBroker,
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  const area = await hub.store.saveArea({ name: "Kitchen" }, "area-command-kitchen");
  await hub.store.savePlatform({ homeId: "home-command", areaBindings: [{ areaId: "area-uuid-command-kitchen", hubAreaId: area.id }] });
  const deviceId = "device-native-command";
  await hub.store.upsertDevice({
    id: deviceId, name: "Kitchen switch legacy display name exceeding the forty character public limit", protocol: "virtual", areaId: area.id,
    managementClass: "tenant_device", tenantOwnerMembershipId: "membership-command-tenant",
    entities: { [`${deviceId}:0:state`]: {
      id: `${deviceId}:0:state`, sourceId: `${deviceId}:0:state`, deviceId, endpointId: "0", logicalKey: "state", stateKey: "state", domain: "switch", state: "OFF",
      capability: { runtime: "dinodia_os", kind: "binary", category: "control", readable: true, writable: true, observable: true, primary: true, semanticRole: "power", bindings: [{ serviceId: "switch.turn_on" }, { serviceId: "switch.turn_off" }] },
    }, [`${deviceId}:0:lock`]: {
      id: `${deviceId}:0:lock`, sourceId: `${deviceId}:0:lock`, deviceId, endpointId: "0", logicalKey: "lock", stateKey: "lock", domain: "lock", state: "LOCKED",
      capability: { runtime: "dinodia_os", kind: "binary", category: "control", readable: true, writable: true, observable: true, primary: true, semanticRole: "security_lock", stepUpPolicy: "required", bindings: [{ serviceId: "lock.lock" }, { serviceId: "lock.unlock" }] },
    } },
  });
  await hub.store.completeDeviceSetup(deviceId, { areaId: area.id, labelId: "light" });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  let socket;
  let releaseQueuedCommand = () => {};
  let restoreSaveSecurity = () => {};
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = appToken({ iss: "dinodia-platform-v2", aud: "dinodia-hub:native-command-hub", sub: "account-command-tenant", sid: "sid-command", jti: "jti-command", membershipId: "membership-command-tenant", trustedDeviceId: "trusted-command", hubInstallationId: "native-command-hub", iat: now, exp: now + 300, homeId: "home-command", householdRole: "TENANT", areaIds: ["area-uuid-command-kitchen"], policyRevision: 0, scope: ["tenant:device-command"] }, keys.privateKey);
    const headers = { authorization: `Bearer ${token}` };
    socket = new WebSocket(`${base.replace("http", "ws")}/api/websocket`);
    assert.equal((await websocketMessage(socket)).type, "auth_required");
    socket.send(JSON.stringify({ type: "auth", access_token: token }));
    assert.equal((await websocketMessage(socket)).type, "auth_ok");
    const catalog = await request(base, "/api/dinodia/v1/devices", { headers });
    assert.equal(catalog.response.status, 200);
    const dto = catalog.body.data.find((item) => item.id === deviceId);
    assert.ok(dto);
    assert.ok(dto.descriptorRevision >= 1, "installed controls have a nonzero descriptor revision suitable for operation-bound step-up");
    assert.equal(dto.customerLabel.length, 40, "an over-bound legacy label is safely bounded without dropping the device");
    assert.equal(dto.controls.length, 2, "label projection must preserve the device's control descriptors");
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
    const wsPowerEntity = hub.model.entities().find((entity) => entity.device.id === deviceId && entity.entity?.capability?.semanticRole === "power");
    const wsLockEntity = hub.model.entities().find((entity) => entity.device.id === deviceId && entity.entity?.capability?.semanticRole === "security_lock");
    assert.ok(wsPowerEntity?.haId && wsLockEntity?.haId, "test device has current WebSocket entity bindings");
    const beforeMixedTarget = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    socket.send(JSON.stringify({ id: 101, type: "call_service", domain: "switch", service: "turn_on", target: { entity_id: wsPowerEntity.haId, device_id: "device-outside-scope" } }));
    const mixedTargetResult = await websocketMessage(socket);
    assert.equal(mixedTargetResult.success, false);
    assert.equal(mixedTargetResult.error.code, "insufficient_scope");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeMixedTarget, "mixed selectors must have no WebSocket dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "OFF", "mixed selectors must have no WebSocket fake-device effect");
    const beforeSensitiveWithoutProof = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    socket.send(JSON.stringify({ id: 102, type: "call_service", domain: "lock", service: "unlock", target: { entity_id: wsLockEntity.haId }, descriptorDigests: { [deviceId]: hub.store.getDevice(deviceId).presentation.sourceFingerprint || hub.store.getDevice(deviceId).presentation.descriptorDigest || null } }));
    const sensitiveResult = await websocketMessage(socket);
    assert.equal(sensitiveResult.success, false);
    assert.equal(sensitiveResult.error.code, "insufficient_scope");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeSensitiveWithoutProof, "sensitive denial must have no WebSocket dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "LOCKED", "sensitive denial must have no fake-device effect");
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
    assert.equal(accepted.body.status, "accepted");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON");
    const dispatchCount = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const retry = await send(command);
    assert.equal(retry.response.status, 202);
    assert.equal(retry.body.commandId, command.commandId);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount);
    const conflicting = await send({ ...command, value: false });
    assert.equal(conflicting.response.status, 409);
    const stale = await send({ ...command, commandId: "command-native-stale", idempotencyKey: "native-command-idempotency-0002", descriptorRevision: dto.descriptorRevision - 1 });
    assert.equal(stale.response.status, 409);
    const wrongHome = await send({ ...command, commandId: "command-native-wrong-home", idempotencyKey: "native-command-idempotency-0003", homeId: "home-other" });
    assert.equal(wrongHome.response.status, 403);
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, dispatchCount);
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
    socket.send(JSON.stringify({ id: 103, type: "call_service", domain: "switch", service: "turn_off", target: { entity_id: wsPowerEntity.haId } }));
    const readOnlySocketResult = await websocketMessage(socket);
    assert.equal(readOnlySocketResult.success, false);
    assert.equal(readOnlySocketResult.error.code, "insufficient_scope");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeReadOnlyProbe, "a changed-to-read-only descriptor has no WebSocket dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "a changed-to-read-only descriptor has no WebSocket fake-device effect");

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
    assert.deepEqual(changedOwnerCatalog.body.data, [], "current ownership change immediately removes the device from the prior tenant view");
    assert.equal(JSON.stringify(changedOwnerCatalog.body).includes(deviceId), false);
    const changedOwnerAttempt = await send({ ...command, commandId: "command-native-changed-owner", idempotencyKey: "native-command-idempotency-changed-owner" });
    assert.equal(changedOwnerAttempt.response.status, 404, JSON.stringify(changedOwnerAttempt.body));
    assert.equal(changedOwnerAttempt.body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "a command after ownership changes has no fake-device effect");
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeOwnershipChange, "a command after ownership changes has no dispatch event");
    const changedOwnerDevice = hub.store.getDevice(deviceId);
    await hub.store.upsertDevice({ ...changedOwnerDevice, tenantOwnerMembershipId: "membership-command-tenant", metadata: { ...changedOwnerDevice.metadata, tenantOwnerMembershipId: "membership-command-tenant" } });

    const beforeRetiredProbe = hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length;
    const retiredDevice = { ...hub.store.getDevice(deviceId), retired: true };
    await hub.store.upsertDevice(retiredDevice);
    const retiredAttempt = await send({ ...command, commandId: "command-native-retired", idempotencyKey: "native-command-idempotency-retired" });
    assert.ok([400, 409].includes(retiredAttempt.response.status), JSON.stringify(retiredAttempt.body));
    assert.equal(hub.store.listEvents(500).filter((event) => event.type === "device_command" && event.deviceId === deviceId).length, beforeRetiredProbe, "retired command denial has no dispatch event");
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:state`].state, "ON", "retired command denial has no fake-device effect");
  } finally { releaseQueuedCommand(); restoreSaveSecurity(); socket?.close(); await hub.stop(); }
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
