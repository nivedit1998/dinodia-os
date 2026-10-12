const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

function signedOperatorToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "DNO-OPS-1" });
  const payload = encode({ iss: "dinodia-platform", aud: `dinodia-os:${claims.hubId}`, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1800, recentAuthAt: Date.now(), credentialVersion: 0, ...claims });
  const input = `${header}.${payload}`;
  return `dno1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

test("assigned commissioning route serves a current grant and denies stale identity before disclosing Areas or radio readiness", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-assigned-context-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const hubId = "assigned-context-test-hub";
  const homeId = crypto.randomUUID(); const hubInstallId = crypto.randomUUID(); const areaId = crypto.randomUUID();
  const handoffId = crypto.randomUUID(); const workflow = crypto.randomUUID(); const requestId = crypto.randomUUID();
  const employeeSessionId = crypto.randomUUID(); const sub = crypto.randomUUID(); const sid = crypto.randomUUID(); const jti = crypto.randomUUID();
  const privateAreaName = "Secret assigned Area";
  const operatorToken = signedOperatorToken({ sub, sid, jti, hubId, scope: ["os:permanent-installation"],
    handoffId, homeId, workflow, requestId, employeeSessionId, workRevision: 3,
    identityGeneration: 8, areaIds: [areaId], areaOptions: [{ id: areaId, name: privateAreaName }] }, keys.privateKey);
  const canonicalOrigin = "https://dinodia-platform-v2.vercel.app";
  const originalFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const requestUrl = String(input);
    if (!requestUrl.startsWith(canonicalOrigin)) return originalFetch(input, options);
    const body = JSON.parse(String(options.body || "{}"));
    const payload = body.phase === "prepare" ? { handoffSecretEnvelope: "{}" }
      : { sessionGrant: { version: 1, envelope: "{}" }, expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const hub = createHub({
    config: { nodeEnv: "production", v2Environment: "test", platformApiUrl: canonicalOrigin, hubId,
      nativeCommissioningCapabilities: { nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false,
        nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: true },
      operatorPublicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), port: 0, nativeApiPort: 0,
      dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    identityBroker: { async getPublicIdentity() { return { serial: hubId, generation: 9 }; } },
    mqttBridge: { status: () => ({ connected: true }), start() {}, close() {}, pairingStatus: () => ({ active: false, found: [] }),
      startPairing: async () => ({ active: true }), stopPairing: async () => ({ active: false }) },
    matterBridge: { status: () => ({ connected: true }), start() {}, close() {}, commission: async () => ({}) },
    cloudflareTunnel: { start() {}, async stop() {}, status: () => ({ configured: false, connected: false, running: false, mode: "disabled", hostname: "", publicUrl: "" }) },
    platformSync: { start() {}, stop() {}, status: () => ({ configured: false }) },
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(async () => { await hub.stop().catch(() => {}); global.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
  await hub.store.saveArea({ name: privateAreaName }, "os-area-1");
  await hub.store.savePlatform({ homeId, hubInstallId, paired: true, areaBindings: [{ areaId, hubAreaId: "os-area-1" }] });
  await hub.store.saveZigbee({ adapterPath: "/dev/ttyUSB-test-zigbee" });
  const existingDeviceId = "zigbee:assigned-route-radiator";
  await hub.store.upsertDevice({ id: existingDeviceId, protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Assigned-route radiator", name: "Assigned-route radiator", areaId: "os-area-1",
    protocolIdentity: { ieeeAddress: "0x00124b0000000abc" }, setup: { status: "ready" },
    entities: { climate: { name: "Heating", capability: { category: "control", semanticRole: "target_temperature", readable: true, writable: true } } },
    metadata: { manufacturer: "SONOFF", model: "TRVZB" } });
  await hub.store.addEvent({ type: "device_setup_completed", deviceId: existingDeviceId, areaId: "os-area-1", timestamp: new Date().toISOString() });
  let liveIdentityGeneration = 8;
  hub.pairing.getPublicIdentity = async () => ({ serial: hubId, generation: liveIdentityGeneration });
  hub.pairing.start = () => {};
  hub.pairing.signPlatformRequest = async () => "test-signature";
  hub.pairing.decryptCredentialDelivery = async (_delivery, purpose) => purpose === "operator-handoff" ? "disposable-handoff" : operatorToken;
  let revalidatedHomeId = homeId;
  let revalidatedHubInstallId = hubInstallId;
  hub.pairing.requestWithHubIdentity = async (route, body) => {
    if (route.endsWith("/operator-session/attempt")) return { setupAttemptId: body.setupAttemptId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (route.endsWith("/operator-session/revalidate")) return { active: true, homeId: revalidatedHomeId, hubInstallationId: revalidatedHubInstallId };
    if (route.endsWith("/commissioning-sessions")) return body.action === "create"
      ? { sessionId: body.sessionId, expiresAt: body.expiresAt, revision: 1 }
      : { sessionId: body.sessionId, revision: Number(body.expectedRevision) + 1, state: body.status };
    return { ok: true };
  };

  await hub.start();
  const setupOrigin = await listen(hub.setupServer);
  const setupPage = await fetch(`${setupOrigin}/support-access`);
  assert.equal(setupPage.status, 200);
  const cookies = setupPage.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
  const cookieHeader = cookies.join("; ");
  const csrf = cookies.find((value) => value.startsWith("dinodia_setup_csrf="))?.split("=", 2)[1];
  const commonHeaders = { cookie: cookieHeader, origin: setupOrigin, "x-dinodia-setup-csrf": csrf, "content-type": "application/json" };
  const attempt = await fetch(`${setupOrigin}/_dinodia/setup/operator-attempt`, { method: "POST", headers: commonHeaders, body: "{}" });
  assert.equal(attempt.status, 200, await attempt.clone().text());
  const startHandoff = await fetch(`${setupOrigin}/_dinodia/setup/operator-session`, { method: "POST", headers: commonHeaders, body: JSON.stringify({ handoffId }) });
  assert.equal(startHandoff.status, 202);
  let established;
  for (let count = 0; count < 40; count += 1) {
    const poll = await fetch(`${setupOrigin}/_dinodia/setup/operator-session`, { method: "POST", headers: commonHeaders, body: JSON.stringify({ action: "status" }) });
    if (poll.status === 200) { established = poll; break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(established, "disposable assigned staff handoff should establish for this route test");
  const establishedBody = await established.clone().json();
  assert.match(establishedBody.sessionSelector, /^[A-Za-z0-9_-]{24,64}$/);
  assert.match(establishedBody.destination, new RegExp(`^/_dinodia/operator/${establishedBody.sessionSelector}/installation$`));
  const sessionCookie = established.headers.getSetCookie().map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("dinodia_os_operator_session_"));
  assert.ok(sessionCookie);
  assert.ok(sessionCookie.startsWith(`dinodia_os_operator_session_${establishedBody.sessionSelector}=`), "the cookie name binds this browser window to its own scoped session selector");
  const authorityCookie = `${cookieHeader}; ${sessionCookie}`;
  const operatorHeaders = { cookie: authorityCookie, "x-dinodia-operator-session": establishedBody.sessionSelector };
  const localAssignedWorkspace = await fetch(`${setupOrigin}${establishedBody.destination}`, { headers: operatorHeaders });
  assert.equal(localAssignedWorkspace.status, 200, "the restricted LAN listener must serve the assigned-installation workspace after its authenticated handoff");
  assert.match(await localAssignedWorkspace.text(), /Permanent device installation/);
  const localFullDashboard = await fetch(`${setupOrigin}/_dinodia/operator/${establishedBody.sessionSelector}`, { headers: operatorHeaders });
  assert.equal(localFullDashboard.status, 403, "the local listener must route full-dashboard selectors to OS scope enforcement, not hide them behind a 404");
  const sessionStatus = await fetch(`${setupOrigin}/_dinodia/admin/api/operator-session`, { headers: operatorHeaders });
  const sessionStatusBody = await sessionStatus.json();
  assert.equal(sessionStatus.status, 200, JSON.stringify(sessionStatusBody));
  const liveContext = await fetch(`${setupOrigin}/_dinodia/installer/commissioning`, { headers: operatorHeaders });
  const liveBody = await liveContext.json();
  assert.equal(liveContext.status, 200, JSON.stringify(liveBody));
  assert.deepEqual(liveBody.areas.map((area) => area.name), [privateAreaName]);
  const liveDevices = await fetch(`${setupOrigin}/_dinodia/installer/commissioning/devices`, { headers: operatorHeaders });
  const liveDevicesBody = await liveDevices.json();
  assert.equal(liveDevices.status, 200);
  assert.equal(liveDevicesBody.devices.length, 1, "the actual assigned route lists an eligible previously-interviewed local device");
  assert.equal(liveDevicesBody.devices[0].name, "Assigned-route radiator");
  assert.equal(JSON.stringify(liveDevicesBody).includes(existingDeviceId), false, "local device IDs remain opaque to the browser");

  const startHeaders = { ...commonHeaders, ...operatorHeaders, "idempotency-key": "assigned-route-zigbee-0001" };
  const startZigbee = await fetch(`${setupOrigin}/_dinodia/installer/commissioning/sessions`, {
    method: "POST", headers: startHeaders, body: JSON.stringify({ schemaVersion: "dinodia.v1", operationKind: "PAIR_NEW", protocol: "zigbee" }),
  });
  const zigbeeSession = await startZigbee.json();
  assert.equal(startZigbee.status, 201, JSON.stringify(zigbeeSession));
  assert.equal(zigbeeSession.status, "searching");

  const cancel = await fetch(`${setupOrigin}/_dinodia/installer/commissioning/sessions/${encodeURIComponent(zigbeeSession.sessionId)}/cancel`, {
    method: "POST", headers: { ...commonHeaders, ...operatorHeaders }, body: JSON.stringify({ schemaVersion: "dinodia.v1" }),
  });
  assert.equal(cancel.status, 200, await cancel.clone().text());
  const startMatter = await fetch(`${setupOrigin}/_dinodia/installer/commissioning/sessions`, {
    method: "POST", headers: { ...startHeaders, "idempotency-key": "assigned-route-matter-0001" },
    body: JSON.stringify({ schemaVersion: "dinodia.v1", operationKind: "PAIR_NEW", protocol: "matter" }),
  });
  const matterSession = await startMatter.json();
  assert.equal(startMatter.status, 201, JSON.stringify(matterSession));
  assert.equal(matterSession.status, "awaiting_payload");

  liveIdentityGeneration = 9;
  const context = await fetch(`${setupOrigin}/_dinodia/installer/commissioning`, { headers: operatorHeaders });
  const body = await context.json();
  assert.equal(context.status, 403);
  assert.equal(body.error?.code, "COMMISSIONING_AUTHORITY_DENIED");
  assert.equal(JSON.stringify(body).includes(privateAreaName), false, "unvalidated Area metadata must not be disclosed");
  assert.equal(JSON.stringify(body).includes(areaId), false);

  revalidatedHomeId = crypto.randomUUID();
  const mismatchedHome = await fetch(`${setupOrigin}/_dinodia/installer/commissioning`, { headers: operatorHeaders });
  const mismatchedBody = await mismatchedHome.json();
  assert.ok([401, 403].includes(mismatchedHome.status), JSON.stringify(mismatchedBody));
  assert.equal(JSON.stringify(mismatchedBody).includes(privateAreaName), false, "a revalidated different Home must not disclose assigned Area metadata");
});
