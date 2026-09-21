const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("../src/store");
const { SecretVault } = require("../src/secretVault");
const { PlatformPairing, sign } = require("../src/platformPairing");
const { generateManufacturingIdentity, vaultIdentityRecord } = require("../src/auth/manufacturingIdentity");

function encryptedMachineEnvelope(identity, credential, version) {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: identity.encryptionPublicKey });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from("dinodia-os-machine-credential"), Buffer.from(String(version)), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return {
    version,
    purpose: "machine-credential",
    algorithm: "x25519-hkdf-sha256/aes-256-gcm",
    ephemeralPublicKeyPem: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

test("platform pairing signs requests, stores only token hashes, and acknowledges publication", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-pairing-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "hub-test" });
  const vault = new SecretVault({ dataDir: directory });
  const calls = [];
  let tokenStateCalls = 0;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    assert.equal(body.serial, "hub-test");
    const secret = url.includes("/pair") ? "bootstrap" : "sync";
    assert.equal(body.sig, sign(secret, body.serial, body.ts, body.nonce));
    if (url.endsWith("/pair")) return { ok: true, async json() { return { syncSecret: "sync", latestVersion: 2, publishedVersion: 0, hubTokenHashes: [crypto.createHash("sha256").update("hub-token").digest("hex")] }; } };
    tokenStateCalls += 1;
    return { ok: true, async json() { return { latestVersion: 2, publishedVersion: tokenStateCalls > 1 ? 2 : 1, hubTokenHashes: [crypto.createHash("sha256").update("hub-token").digest("hex")], acceptedActivityIncidentIds: (body.activityIncidents?.incidents || []).map((incident) => incident.id) }; } };
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "hub-test", legacyCompatibilityEnabled: true, intervalMs: 60000, getActivityIncidents: () => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), incidents: store.listPendingIncidentEnvelopes(50).map((entry) => entry.envelope) }), onSyncResult: async (result) => store.acknowledgeIncidentEnvelopes(result.acceptedActivityIncidentIds || []), fetchImpl });
  await pairing.configure({ bootstrapSecret: "bootstrap" });
  const paired = await pairing.pair();
  assert.equal(paired.latestVersion, 2);
  assert.equal(vault.get("platform.syncSecret"), "sync");
  assert.equal(store.getPlatform().acceptedTokenHashes.length, 1);
  await store.queueIncidentEnvelope({ id: "offline-1:1", incidentId: "offline-1", revision: 1, kind: "device_offline", state: "open", severity: "critical", summary: "Device offline", firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString() });
  await pairing.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const tokenState = calls.find((call) => call.url.endsWith('/token-state'));
  assert.equal(tokenState.body.hubRuntime.kind, 'dinodia_os');
  assert.equal(tokenState.body.hubRuntime.capabilities.managedAreaProvisioningV1, true);
  assert.equal(tokenState.body.activityIncidents.incidents[0].incidentId, "offline-1");
  assert.equal(store.listPendingIncidentEnvelopes().length, 0);
  assert.equal(tokenStateCalls >= 2, true);
  assert.equal(store.getPlatform().publishedVersion, 2);
  assert.equal(calls.every((call) => !Object.keys(call.body).some((key) => /token/i.test(key) && key !== "agentSeenVersion")), true);
});

test("native provisioning completes the outbound challenge, encrypted credential delivery and acknowledgement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-pairing-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-TEST-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-TEST-HUB" });
  const identityRecord = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", identityRecord.signingPrivateKey);
  await vault.set("platform.identityPublicKey", identityRecord.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", identityRecord.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", identityRecord.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", identityRecord.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", identityRecord.encryptionKeyFingerprint);
  await vault.set("platform.manufacturingCertificateSignature", "factory-signature-for-platform-test");
  const credential = "dno_machine_test_credential";
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    if (url.endsWith("/pairing/register")) return { ok: true, async json() { return { ok: true, attemptId: "attempt-1", pairingId: "pairing-1" }; } };
    if (url.endsWith("/pairing/challenge")) return { ok: true, async json() { return { ok: true, challenge: "challenge-for-hub", expiresAt: new Date(Date.now() + 60_000).toISOString() }; } };
    if (url.endsWith("/pairing/prove")) return { ok: true, async json() { return { ok: true, attemptId: body.attemptId, version: 1, envelope: encryptedMachineEnvelope(identity, credential, 1) }; } };
    if (url.endsWith("/pairing/acknowledge")) {
      assert.equal(body.credentialFingerprint, crypto.createHash("sha256").update(credential).digest("hex"));
      return { ok: true, async json() { return { ok: true, acknowledged: true }; } };
    }
    assert.match(url, /\/token-state$/);
    return { ok: true, async json() { return { latestVersion: 0, publishedVersion: 0, hubTokenHashes: [], acceptedActivityIncidentIds: [] }; } };
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "DINODIA-TEST-HUB", fetchImpl, intervalMs: 60000 });
  const presentation = { attemptId: "attempt-1", code: "short-lived-presentation", expiresAt: Date.now() + 15 * 60_000 };
  const registered = await pairing.registerProvisioningAttempt({ pairing: presentation, baseUrl: "http://192.168.1.76:8123" });
  assert.equal(registered.attemptId, "attempt-1");
  assert.equal(store.getPlatform().paired, false);
  await pairing.syncNow();
  assert.equal(store.getPlatform().paired, true);
  assert.equal(vault.get("platform.machineCredential"), credential);
  assert.deepEqual(calls.map((call) => call.url.split("platform.test")[1]), [
    "/api/hub-agent/v2/pairing/register",
    "/api/hub-agent/v2/pairing/challenge",
    "/api/hub-agent/v2/pairing/prove",
    "/api/hub-agent/v2/pairing/acknowledge",
    "/api/hub-agent/token-state",
  ]);
});
