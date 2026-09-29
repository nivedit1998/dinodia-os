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
  } finally { await hub.stop(); }
});

test("Native v1 command route enforces current DTO, tenant scope and durable idempotency before dispatch", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-v1-command-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hub = createHub({
    config: { nodeEnv: "production", appPublicKeys: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId: "native-command-hub", port: 0, haPort: 0, hubAgentPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
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

    const lockKey = "native-lock-command-idempotency-0001";
    const lockCommand = { ...command, commandId: "command-native-lock", controlId: lock.controlId, value: true, idempotencyKey: lockKey };
    const sendLock = (payload, proof = "") => request(base, "/api/dinodia/v1/commands", { method: "POST", headers: { ...headers, "idempotency-key": payload.idempotencyKey, ...(proof ? { "x-dinodia-step-up-proof": proof } : {}) }, body: JSON.stringify(payload) });
    assert.equal((await sendLock(lockCommand)).response.status, 400);
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "LOCKED");
    const jti = "stepup-operation-native-1";
    const issuedAt = Math.floor(Date.now() / 1000);
    const descriptorDigest = hub.store.getDevice(deviceId).presentation.sourceFingerprint || hub.store.getDevice(deviceId).presentation.descriptorDigest || null;
    const signedValue = descriptorBoundValue({ value: true, controlId: lock.controlId }, { [deviceId]: descriptorDigest });
    const operationDigest = digestOperation({ actorId: "account-command-tenant", trustedDeviceId: "trusted-command", customerSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operationKind: "device_sensitive_command", targetIds: [deviceId], value: signedValue });
    const unsignedProof = { jti, actorId: "account-command-tenant", trustedDeviceId: "trusted-command", customerSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operationDigest, issuedAt, expiresAt: issuedAt + 60 };
    const encodedProof = Buffer.from(JSON.stringify(unsignedProof)).toString("base64url");
    const proof = `${encodedProof}.${crypto.sign(null, Buffer.from(JSON.stringify(unsignedProof)), keys.privateKey).toString("base64url")}`;
    lockCommand.stepUpOperationId = jti;
    const proofCheck = await new StepUpProofVerifier({ publicKeys: [keys.publicKey] }).verify(proof, { actorId: "account-command-tenant", trustedDeviceId: "trusted-command", trustedSessionId: "sid-command", homeId: "home-command", membershipId: "membership-command-tenant", hubInstallId: "native-command-hub", operation: "device_sensitive_command", targetIds: [deviceId], value: signedValue });
    assert.ok(proofCheck, "test proof must verify under the Platform/OS step-up contract");
    const unlocked = await sendLock(lockCommand, proof);
    assert.equal(unlocked.response.status, 202, JSON.stringify(unlocked.body));
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "UNLOCKED");
    const replay = await sendLock({ ...lockCommand, commandId: "command-native-lock-replay", idempotencyKey: "native-lock-command-idempotency-0002" }, proof);
    assert.equal(replay.response.status, 403);
    assert.equal(hub.store.getDevice(deviceId).entities[`${deviceId}:0:lock`].state, "UNLOCKED");

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
