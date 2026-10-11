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
    exp: Math.floor(Date.now() / 1000) + 600, recentAuthAt: Date.now(), ...claims });
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
    handoffId, homeId, hubInstallId, workflow, requestId, employeeSessionId, workRevision: 3,
    identityGeneration: 8, areaIds: [areaId], areaOptions: [{ id: areaId, name: privateAreaName }] }, keys.privateKey);
  const canonicalOrigin = "https://dinodia-platform-v2.vercel.app";
  const originalFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const requestUrl = String(input);
    if (!requestUrl.startsWith(canonicalOrigin)) return originalFetch(input, options);
    const body = JSON.parse(String(options.body || "{}"));
    const payload = body.phase === "prepare" ? { handoffSecretEnvelope: "{}" }
      : { sessionGrant: { version: 1, envelope: "{}" }, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const hub = createHub({
    config: { nodeEnv: "production", v2Environment: "test", platformApiUrl: canonicalOrigin, hubId,
      operatorPublicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), port: 0, nativeApiPort: 0,
      dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    identityBroker: { async getPublicIdentity() { return { serial: hubId, generation: 9 }; } },
    mqttBridge: { status: () => ({ connected: true }), start() {}, close() {}, pairingStatus: () => ({ active: false, found: [] }) },
    matterBridge: { status: () => ({ connected: false }), start() {}, close() {} },
    cloudflareTunnel: { start() {}, async stop() {}, status: () => ({ configured: false, connected: false, running: false, mode: "disabled", hostname: "", publicUrl: "" }) },
    platformSync: { start() {}, stop() {}, status: () => ({ configured: false }) },
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(async () => { await hub.stop().catch(() => {}); global.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
  await hub.store.savePlatform({ homeId, hubInstallId, paired: true });
  let liveIdentityGeneration = 8;
  hub.pairing.getPublicIdentity = async () => ({ serial: hubId, generation: liveIdentityGeneration });
  hub.pairing.start = () => {};
  hub.pairing.signPlatformRequest = async () => "test-signature";
  hub.pairing.decryptCredentialDelivery = async (_delivery, purpose) => purpose === "operator-handoff" ? "disposable-handoff" : operatorToken;
  hub.pairing.requestWithHubIdentity = async (route, body) => {
    if (route.endsWith("/operator-session/attempt")) return { setupAttemptId: body.setupAttemptId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (route.endsWith("/operator-session/revalidate")) return { active: true };
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
  const sessionCookie = established.headers.getSetCookie().map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("dinodia_os_operator_session="));
  assert.ok(sessionCookie);
  const authorityCookie = `${cookieHeader}; ${sessionCookie}`;
  const liveContext = await fetch(`${setupOrigin}/_dinodia/installer/commissioning`, { headers: { cookie: authorityCookie } });
  const liveBody = await liveContext.json();
  assert.equal(liveContext.status, 200);
  assert.deepEqual(liveBody.areas.map((area) => area.name), [privateAreaName]);
  const liveDevices = await fetch(`${setupOrigin}/_dinodia/installer/commissioning/devices`, { headers: { cookie: authorityCookie } });
  assert.equal(liveDevices.status, 200);

  liveIdentityGeneration = 9;
  const context = await fetch(`${setupOrigin}/_dinodia/installer/commissioning`, { headers: { cookie: authorityCookie } });
  const body = await context.json();
  assert.equal(context.status, 403);
  assert.equal(body.error?.code, "COMMISSIONING_AUTHORITY_DENIED");
  assert.equal(JSON.stringify(body).includes(privateAreaName), false, "unvalidated Area metadata must not be disclosed");
  assert.equal(JSON.stringify(body).includes(areaId), false);
});
