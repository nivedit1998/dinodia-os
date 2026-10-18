"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");
const { applyCloudConfiguration } = require("../src/sync/cloudConfiguration");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; }, async command() {}, async refresh() {}, async permitJoin() {} };
}

function appToken(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "DNO-APP-1", v: 1 })}.${encode(claims)}`;
  return `dno-app-1.${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

async function send(base, token, payload) {
  const route = payload.operation === "context" ? "tenant-device-context"
    : ["layout_save", "presentation", "remove"].includes(payload.operation) ? "tenant-device-intents" : "tenant-automations";
  const response = await fetch(`${base}/api/dinodia/v1/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test("tenant Hub delegation is online-tenant-only and forwards only fixed Platform intents", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-tenant-hub-delegation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const appKeys = crypto.generateKeyPairSync("ed25519");
  const hubId = "tenant-delegation-hub";
  const homeId = "a8218a24-8394-4d5b-8f23-06d205887abb";
  const membershipId = "76b31e09-ebdd-4970-959a-6b9a9423cbbd";
  const hub = createHub({
    config: {
      nodeEnv: "production", v2Environment: "test", appPublicKeys: appKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      hubId, port: 0, nativeApiPort: 0, dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
    },
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.store.savePlatform({ hubInstallId: hubId, homeId, policyRevision: 4 });
  const localConfiguration = {
    revision: 4, policyRevision: 4,
    areas: [{ id: "area-room-1", osAreaId: "Room 1", originalName: "Room 1", overrideName: null, revision: 1 }],
    memberships: [{ id: membershipId, role: "TENANT", accessRevision: 2, areaIds: ["area-room-1"], grantRevisions: [{ areaId: "area-room-1", revision: 2 }] }],
    devicePolicies: [], automations: [],
    tenantAutomationProjection: { version: 1, executionEnabled: false, propertyTimeZone: "Europe/London", automations: [] },
    releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
  };
  localConfiguration.checksum = crypto.createHash("sha256").update(canonical(localConfiguration)).digest("hex");
  await applyCloudConfiguration(hub.store, localConfiguration);
  await hub.store.applySyncConfigurationSnapshot(4);
  const forwarded = [];
  hub.pairing.requestWithHubIdentity = async (route, body) => {
    forwarded.push({ route, body });
    return { schemaVersion: "dinodia.v1", ok: true, homeId, membershipId, automations: [] };
  };
  await hub.start();
  t.after(async () => {
    await hub.stop();
    await hub.store.persist();
  });

  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const now = Math.floor(Date.now() / 1000);
  const makeToken = (role, membership = membershipId) => appToken({
    iss: "dinodia-platform-v2", aud: `dinodia-hub:${hubId}`, sub: `account-${role.toLowerCase()}`,
    sid: `session-${role.toLowerCase()}`, jti: `jti-${crypto.randomUUID()}`, membershipId: membership,
    trustedDeviceId: "trusted-phone-fixture", hubInstallationId: hubId, iat: now, exp: now + 300,
    homeId, householdRole: role, areaIds: ["area-room-1"], policyRevision: 4, scope: ["tenant:device-command"],
  }, appKeys.privateKey);
  const tenant = makeToken("TENANT");
  const owner = makeToken("OWNER");
  const accountAccessToken = `dno-customer-access-${"A".repeat(48)}`;
  const basePayload = { schemaVersion: "dinodia.v1", homeId, membershipId, accountAccessToken };

  const contextResponse = await fetch(`${base}/api/dinodia/v1/tenant-device-context`, {
    method: "POST", headers: { authorization: `Bearer ${tenant}`, "content-type": "application/json" },
    body: JSON.stringify(basePayload),
  });
  assert.equal(contextResponse.status, 200);
  assert.equal(forwarded[0].route, "/api/hub-agent/v2/tenant-device-context");
  assert.deepEqual(forwarded[0].body, { schemaVersion: "dinodia.v1", homeId, membershipId, accountAccessToken });

  const localList = await send(base, tenant, { ...basePayload, operation: "list" });
  assert.equal(localList.status, 200, JSON.stringify(localList.body));
  assert.equal(localList.body.membershipId, membershipId);
  assert.equal(localList.body.delivery.state, "activation_disabled");
  assert.deepEqual(localList.body.automations, []);
  assert.equal(forwarded.length, 1, "a valid applied local projection must not call Platform");

  const idempotencyKey = crypto.randomUUID();
  const automation = await send(base, tenant, {
    ...basePayload, operation: "create", idempotencyKey,
    definition: { name: "Test schedule", trigger: { minuteOfDay: 420, weekdays: [1] }, actions: [] },
  });
  assert.equal(automation.status, 200, JSON.stringify(automation.body));
  assert.equal(forwarded[1].route, "/api/hub-agent/v2/tenant-automations");
  assert.equal(forwarded[1].body.operation, "create");
  assert.equal(forwarded[1].body.schemaVersion, "dinodia.v1");
  assert.equal(forwarded[1].body.idempotencyKey, idempotencyKey);
  assert.deepEqual(forwarded[1].body.definition, { name: "Test schedule", trigger: { minuteOfDay: 420, weekdays: [1] }, actions: [] });
  assert.equal("accountAccessToken" in forwarded[1].body, true);
  assert.equal("url" in forwarded[1].body, false);

  const layout = await send(base, tenant, {
    ...basePayload, operation: "layout_save", expectedRevision: 3,
    document: { tiles: ["temperature"], version: 1 },
  });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  assert.equal(forwarded[2].route, "/api/hub-agent/v2/tenant-device-intents");
  assert.deepEqual(forwarded[2].body, {
    schemaVersion: "dinodia.v1", homeId, membershipId, accountAccessToken,
    operation: "layout_save", expectedRevision: 3, document: { tiles: ["temperature"], version: 1 },
  });

  const beforeDenied = forwarded.length;
  const ownerResult = await send(base, owner, { ...basePayload, operation: "list" });
  assert.equal(ownerResult.status, 403);
  assert.equal(forwarded.length, beforeDenied, "owner role must be denied before any Hub delegation");

  const wrongMembership = await send(base, makeToken("TENANT", "different-membership"), { ...basePayload, operation: "list" });
  assert.equal(wrongMembership.status, 400);
  assert.equal(forwarded.length, beforeDenied, "token membership must match the selected payload membership");

  const unsupported = await send(base, tenant, { ...basePayload, operation: "fetch", url: "https://attacker.invalid/" });
  assert.equal(unsupported.status, 400);
  assert.equal(forwarded.length, beforeDenied, "the Hub route cannot become an arbitrary proxy");
});
