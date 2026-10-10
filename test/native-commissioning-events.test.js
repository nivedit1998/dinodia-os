const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const WebSocket = require("ws");
const { createHub } = require("../src/server");

function integration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

function token(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-APP-1", v: 1 })}.${encode(claims)}`;
  return `dno-app-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

function message(socket, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("Commissioning WebSocket timed out")); }, timeoutMs);
    const onMessage = (data) => {
      let value;
      try { value = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(value)) return;
      clearTimeout(timer); socket.off("message", onMessage); resolve(value);
    };
    socket.on("message", onMessage);
  });
}

async function upgradeStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => { socket.terminate(); reject(new Error("Unauthorized commissioning event socket unexpectedly opened")); });
    socket.once("unexpected-response", (_request, response) => { resolve(response.statusCode); socket.terminate(); });
    socket.once("error", (error) => {
      const rejected = String(error.message).match(/Unexpected server response: (\d{3})/);
      if (rejected) { resolve(Number(rejected[1])); socket.terminate(); return; }
      reject(error);
    });
  });
}

test("commissioning event WebSocket sends scoped durable snapshots and closes when authority changes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-commissioning-events-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const appKeys = crypto.generateKeyPairSync("ed25519");
  const operatorKeys = crypto.generateKeyPairSync("ed25519");
  const hubId = "commissioning-events-hub";
  const hub = createHub({
    config: {
      nodeEnv: "test", v2Environment: "test", appPublicKeys: appKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      operatorPublicKey: operatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), hubId,
      port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, "dinodia.json"),
      backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
      nativeCommissioningCapabilities: { nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false },
    },
    mqttBridge: integration(), matterBridge: integration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.savePlatform({ hubInstallId: hubId, homeId: "home-commissioning-events", policyRevision: 0 });
  await hub.store.saveIdentity({ serial: hubId, instanceId: "commissioning-events-instance", generation: 1 });
  await hub.start();
  t.after(() => hub.stop());

  const now = Math.floor(Date.now() / 1000);
  const makeToken = (suffix) => token({
    iss: "dinodia-platform-v2", aud: `dinodia-hub:${hubId}`, sub: `account-${suffix}`, sid: `session-${suffix}`, jti: `token-${suffix}`,
    membershipId: `membership-${suffix}`, trustedDeviceId: `trusted-${suffix}`, hubInstallationId: hubId,
    iat: now, exp: now + 300, homeId: "home-commissioning-events", householdRole: "TENANT", areaIds: ["area-events"],
    policyRevision: 0, scope: ["tenant:device-command"],
  }, appKeys.privateKey);
  const tenantToken = makeToken("allowed");
  const sessionId = crypto.randomUUID();
  const eventAt = new Date().toISOString();
  const savedSession = {
    sessionId, protocol: "zigbee", actorType: "TENANT", requesterAccountId: "account-allowed", requesterSessionId: "session-allowed",
    requesterTrustedDeviceId: "trusted-allowed", requesterTokenHash: crypto.createHash("sha256").update(tenantToken).digest("hex"),
    ownerMembershipId: "membership-allowed", homeId: "home-commissioning-events", hubInstallationId: hubId,
    identityGeneration: Number(hub.store.getIdentity().generation || 1), allowedAreaIds: ["area-events"], status: "searching",
    createdAt: eventAt, updatedAt: eventAt, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), revision: 1,
    expectedPlatformRevision: 1, candidates: [], events: [{ sequence: 1, type: "session_started", at: eventAt, protocol: "zigbee" }],
    cleanup: { state: "NONE", pendingIds: [] },
  };
  await hub.store.saveSecurity({ nativeCommissioningSessions: { [sessionId]: savedSession } });

  const base = `ws://127.0.0.1:${hub.server.address().port}/api/dinodia/v1/commissioning/sessions/${sessionId}/events`;
  const statusResponse = await fetch(`${base.replace("ws://", "http://").replace(/\/events$/, "")}`, { headers: { authorization: `Bearer ${tenantToken}` } });
  assert.equal(statusResponse.status, 200, JSON.stringify(await statusResponse.json()));
  assert.equal(await upgradeStatus(`${base}?after=0`), 401, "anonymous users cannot subscribe");
  assert.equal(await upgradeStatus(`${base}?after=0`, { authorization: `Bearer ${makeToken("foreign")}` }), 403, "a different account cannot subscribe to another tenant's session");

  const socket = new WebSocket(`${base}?after=0`, { headers: { authorization: `Bearer ${tenantToken}` } });
  t.after(() => { if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate(); });
  const initialMessage = message(socket, (value) => value.sessionId === sessionId);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const initial = await initialMessage;
  assert.equal(initial.status, "searching");
  assert.equal(initial.events[0].sequence, 1);
  for (const privateValue of [tenantToken, "account-allowed", "session-allowed", "trusted-allowed", "requesterTokenHash"]) {
    assert.equal(JSON.stringify(initial).includes(privateValue), false, `public event projection excludes ${privateValue}`);
  }

  const security = hub.store.getSecurity();
  const changed = security.nativeCommissioningSessions[sessionId];
  changed.revision = 2;
  changed.updatedAt = new Date().toISOString();
  changed.events = [...changed.events, { sequence: 2, type: "candidate_discovered", at: changed.updatedAt, count: 1 }];
  await hub.store.saveSecurity({ nativeCommissioningSessions: security.nativeCommissioningSessions });
  hub.eventBus.emit("dinodia_dashboard_updated", { kind: "commissioning", sessionId, at: changed.updatedAt });
  const update = await message(socket, (value) => value.sessionId === sessionId && value.revision === 2);
  assert.equal(update.events.at(-1).sequence, 2);

  const close = new Promise((resolve) => socket.once("close", (_code, reason) => resolve(String(reason))));
  const latestSecurity = hub.store.getSecurity();
  latestSecurity.nativeCommissioningSessions[sessionId].ownerMembershipId = "membership-revoked";
  await hub.store.saveSecurity({ nativeCommissioningSessions: latestSecurity.nativeCommissioningSessions });
  hub.eventBus.emit("dinodia_dashboard_updated", { kind: "commissioning", sessionId, at: new Date().toISOString() });
  const reason = await close;
  assert.match(reason, /Commissioning authority changed/);
});
