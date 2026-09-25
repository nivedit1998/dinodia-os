const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { CredentialRegistry, CREDENTIAL_TYPES } = require("../src/auth/credentialRegistry");
const { createOperatorSessionToken, verifyOperatorSessionToken } = require("../src/auth/operatorSession");
const { ProvisioningPairingService } = require("../src/auth/provisioningPairing");
const { generateManufacturingIdentity, stableManufacturingIdentityPayload, signPairingEnvelope, verifyPairingEnvelope } = require("../src/auth/manufacturingIdentity");
const { createLanChallenge, signLanChallenge, verifyLanProof, canUseArea } = require("../src/auth/offlineLanAuthorizer");
const { StepUpProofRegistry } = require("../src/auth/stepUpProofs");
const { RevocationCoordinator } = require("../src/auth/revocationCoordinator");
const { Store } = require("../src/store");
const { SecretVault } = require("../src/secretVault");
const { canonicalPlatformRequest, canonicalCloudChallenge, canonicalCloudChallengeUnsigned, encryptPrivateKey, decryptPrivateKey } = require("../src/auth/identityBroker");
const { supportProofOfPossessionDigest } = require("../src/auth/supportProofOfPossession");

test("operator sessions are signed, hub-bound, session-time-limited, with separate recent-auth enforcement", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const now = Date.UTC(2026, 0, 1, 12);
  const token = createOperatorSessionToken({ sub: "employee-1", hubId: "DIN-001", scope: ["os:admin"], recentAuthAt: now }, keys.privateKey, now);
  assert.ok(verifyOperatorSessionToken(token, { publicKey: keys.publicKey, hubId: "DIN-001", now }));
  assert.equal(verifyOperatorSessionToken(token, { publicKey: keys.publicKey, hubId: "DIN-002", now }), null);
  assert.equal(verifyOperatorSessionToken(token, { publicKey: keys.publicKey, hubId: "DIN-001", requiredScope: "os:rotate", now }), null);
  assert.ok(verifyOperatorSessionToken(token, { publicKey: keys.publicKey, hubId: "DIN-001", now: now + 5 * 60_001 }));
  assert.equal(verifyOperatorSessionToken(token, { publicKey: keys.publicKey, hubId: "DIN-001", requireRecentAuth: true, now: now + 5 * 60_001 }), null);
});

test("credential registry stores hashes, rejects expiry and revokes sockets by fingerprint", () => {
  let now = 1_000;
  const revoked = [];
  const registry = new CredentialRegistry({ now: () => now, onRevoke: (event) => revoked.push(event) });
  const record = registry.register({ type: CREDENTIAL_TYPES.OPERATOR_SESSION, credential: "secret-value", homeId: "home-1", expiresAt: 2_000 });
  assert.equal(registry.snapshot()[0].hash.includes("secret-value"), false);
  assert.equal(registry.verify("secret-value", { type: CREDENTIAL_TYPES.OPERATOR_SESSION, homeId: "home-1" })?.fingerprint, record.fingerprint);
  now = 2_000;
  assert.equal(registry.verify("secret-value", { type: CREDENTIAL_TYPES.OPERATOR_SESSION, homeId: "home-1" }), null);
  now = 1_500;
  assert.equal(registry.revoke({ fingerprint: record.fingerprint, reason: "test" }), 1);
  assert.equal(revoked[0].fingerprint, record.fingerprint);
  assert.equal(registry.verify("secret-value", { type: CREDENTIAL_TYPES.OPERATOR_SESSION, homeId: "home-1" }), null);
});

test("provisioning presentation is 15-minute, hub-bound and single-use", () => {
  let now = 10_000;
  const service = new ProvisioningPairingService({ serial: "DIN-001", now: () => now });
  const issued = service.issue({ attemptId: "attempt-1", browserNonce: "browser-nonce-1", browserId: "browser-1", publicKeyFingerprint: "key-1", baseUrl: "http://192.168.1.76:8123" });
  assert.equal(service.status().state, "active");
  assert.equal(service.matchesBrowserSession({ attemptId: "attempt-1", browserNonce: "browser-nonce-1", browserId: "browser-1" }), true);
  assert.equal(service.matchesBrowserSession({ attemptId: "attempt-1", browserNonce: "browser-nonce-1", browserId: "browser-2" }), false);
  assert.equal(service.matchesBrowserSession({ attemptId: "attempt-1", browserNonce: "wrong-browser", browserId: "browser-1" }), false);
  assert.equal(service.matchesBrowserSession({ attemptId: "attempt-2", browserNonce: "browser-nonce-1", browserId: "browser-1" }), false);
  assert.equal(service.redeem({ code: issued.code, attemptId: "attempt-1", serial: "DIN-001", browserNonce: "browser-nonce-1", publicKeyFingerprint: "wrong" }).errorCode, "pairing_key_mismatch");
  assert.equal(service.redeem({ code: issued.code, attemptId: "attempt-1", serial: "DIN-001", browserNonce: "browser-nonce-1", publicKeyFingerprint: "key-1" }).ok, true);
  assert.equal(service.redeem({ code: issued.code, attemptId: "attempt-1", serial: "DIN-001", browserNonce: "browser-nonce-1", publicKeyFingerprint: "key-1" }).errorCode, "pairing_already_consumed");
  const replacement = service.issue({ attemptId: "attempt-2", publicKeyFingerprint: "key-1" });
  assert.notEqual(replacement.code, issued.code);
  now += 15 * 60 * 1000;
  assert.equal(service.redeem({ code: replacement.code, attemptId: "attempt-2", serial: "DIN-001", publicKeyFingerprint: "key-1" }).errorCode, "pairing_expired");
});

test("provisioning presentation survives OS restart without persisting plaintext code", async () => {
  const directory = await require("node:fs/promises").mkdtemp(require("node:path").join(require("node:os").tmpdir(), "dinodia-pairing-restart-"));
  const store = new Store(require("node:path").join(directory, "dinodia.json"));
  const vault = new SecretVault({ dataDir: directory, logger: { warn() {} } });
  const first = new ProvisioningPairingService({ serial: "DIN-RESTART", store, vault, logger: { warn() {} } });
  const issued = first.issue({ attemptId: "attempt-restart", publicKeyFingerprint: "key-1", baseUrl: "http://192.168.1.76:8123" });
  await first.waitForPersistence();
  const serialized = await require("node:fs/promises").readFile(require("node:path").join(directory, "dinodia.json"), "utf8");
  assert.doesNotMatch(serialized, new RegExp(issued.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const afterRestart = new ProvisioningPairingService({ serial: "DIN-RESTART", store, vault, logger: { warn() {} } });
  assert.equal(afterRestart.status().state, "active");
  assert.equal(afterRestart.redeem({ code: issued.code, attemptId: "attempt-restart", serial: "DIN-RESTART", publicKeyFingerprint: "key-1" }).ok, true);
});

test("manufacturing identity signs a pairing envelope and rejects another hub key", () => {
  const identity = generateManufacturingIdentity({ serial: "DIN-001" });
  assert.match(stableManufacturingIdentityPayload({ ...identity, identityGeneration: 1 }), /"identityGeneration":1/);
  assert.match(stableManufacturingIdentityPayload({ ...identity, identityGeneration: 1 }), /"encryptionKeyFingerprint"/);
  const envelope = signPairingEnvelope(identity, { attemptId: "attempt-1", nonce: "n-1" });
  assert.equal(verifyPairingEnvelope({ ...envelope, publicKey: identity.publicKey }), true);
  const other = crypto.generateKeyPairSync("ed25519");
  assert.equal(verifyPairingEnvelope({ ...envelope, publicKey: other.publicKey }), false);
});

test("offline LAN proof is short-lived, area-scoped and operation-bound", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const challenge = createLanChallenge({ homeId: "home-1", hubInstallId: "hub-1", deviceId: "device-1", controlId: "power", valueDigest: "digest", now: 1_000 });
  const signature = signLanChallenge(challenge, keys.privateKey);
  assert.equal(verifyLanProof({ challenge, signature, publicKey: keys.publicKey, now: 1_500 }), true);
  assert.equal(verifyLanProof({ challenge, signature, publicKey: keys.publicKey, now: 31_001 }), false);
  assert.equal(canUseArea({ areaIds: ["a1"], areaId: "a1" }), true);
  assert.equal(canUseArea({ areaIds: ["a1"], areaId: "a2" }), false);
});

test("offline authority is not accepted through forwarded or public transports", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "server.js"), "utf8");
  assert.match(source, /function isPrivateLanRequest/);
  assert.match(source, /cf-connecting-ip/);
  assert.match(source, /challengeHeader && signature && grantId && isPrivateLanRequest\(req\)/);
});

test("generic step-up proof is one-use and exact-operation-bound", () => {
  let now = 10_000;
  const registry = new StepUpProofRegistry({ now: () => now, ttlMs: 1_000 });
  const input = { actorId: "user-1", trustedSessionId: "session-1", homeId: "home-1", operation: "set_temperature", targetIds: ["device-1"], value: 21 };
  const issued = registry.issue(input);
  assert.ok(registry.consume(issued.id, input));
  assert.equal(registry.consume(issued.id, input), null);
  const second = registry.issue(input);
  assert.equal(registry.consume(second.id, { ...input, value: 22 }), null);
  now += 1_001;
  assert.equal(registry.consume(second.id, input), null);
});

test("revocation coordinator closes only matching authenticated sockets", () => {
  const coordinator = new RevocationCoordinator();
  const closed = [];
  const socket = { close: (code, reason) => closed.push({ code, reason }) };
  coordinator.track(socket, { fingerprint: "fp-1", jti: "jti-1", homeId: "home-1" });
  assert.equal(coordinator.revoke({ fingerprint: "fp-2" }), 0);
  assert.equal(coordinator.revoke({ fingerprint: "fp-1", reason: "policy_changed" }), 1);
  assert.deepEqual(closed, [{ code: 4401, reason: "policy_changed" }]);
});

test("revocation coordinator closes sockets when their credential version leaves the accepted set", () => {
  const coordinator = new RevocationCoordinator();
  const closed = [];
  const oldSocket = { close: (code, reason) => closed.push({ name: "old", code, reason }) };
  const currentSocket = { close: (code, reason) => closed.push({ name: "current", code, reason }) };
  coordinator.track(oldSocket, { fingerprint: "old-fp", credentialVersion: 4 });
  coordinator.track(currentSocket, { fingerprint: "current-fp", credentialVersion: 5 });
  assert.equal(coordinator.revoke({ credentialVersion: 4, reason: "grace_expired" }), 1);
  assert.deepEqual(closed, [{ name: "old", code: 4401, reason: "grace_expired" }]);
});

test("identity broker canonical signing is operation-bound and encrypted blobs reject tampering/context swaps", () => {
  const request = canonicalPlatformRequest({ method: "POST", path: "/api/hub-agent/token-state", timestamp: 1_700_000_000_000, nonce: "nonce-identity-1", bodyHash: "a".repeat(64) });
  assert.equal(request, `POST\n/api/hub-agent/token-state\n1700000000000\nnonce-identity-1\n${"a".repeat(64)}`);
  assert.throws(() => canonicalPlatformRequest({ canonical: "arbitrary-admin-payload" }), /invalid/);
  assert.throws(() => canonicalPlatformRequest({ method: "POST", path: "/x\ny", timestamp: 1, nonce: "n", bodyHash: "a".repeat(64) }), /invalid/);

  const wrappingKey = crypto.randomBytes(32);
  const context = { serial: "DIN-IDENTITY-1", purpose: "signing", generation: 4 };
  const blob = encryptPrivateKey("private-key-material", wrappingKey, context);
  assert.equal(decryptPrivateKey(blob, wrappingKey, context), "private-key-material");
  const tampered = JSON.parse(blob);
  tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;
  assert.throws(() => decryptPrivateKey(JSON.stringify(tampered), wrappingKey, context));
  assert.throws(() => decryptPrivateKey(blob, wrappingKey, { ...context, purpose: "encryption" }), /context mismatch/);
});

test("CloudURL challenge signing is byte-stable across identityd and in-process paths", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const payload = { version: 1, serial: "din-home-001", cloudUrl: "https://dinodia-din-home-001.dinodiasmartliving.com", challenge: "challenge-012345678901234567890", tunnelId: "11111111-1111-4111-8111-111111111111", tunnelName: "dinodia-din-home-001", timestamp: 1790000000000, identityFingerprint: "a".repeat(64), identityGeneration: 1 };
  const unsigned = canonicalCloudChallengeUnsigned(payload);
  const bodyHash = crypto.createHash("sha256").update(unsigned, "utf8").digest("hex");
  const complete = { ...payload, bodyHash };
  const expected = JSON.stringify({ version: 1, serial: payload.serial, cloudUrl: payload.cloudUrl, challenge: payload.challenge, tunnelId: payload.tunnelId, tunnelName: payload.tunnelName, timestamp: payload.timestamp, bodyHash, identityFingerprint: payload.identityFingerprint, identityGeneration: 1 });
  assert.equal(canonicalCloudChallenge(complete), expected);
  const signature = crypto.sign(null, Buffer.from(canonicalCloudChallenge(complete), "utf8"), keys.privateKey);
  assert.equal(crypto.verify(null, Buffer.from(canonicalCloudChallenge(complete), "utf8"), keys.publicKey, signature), true);
  for (const field of ["serial", "cloudUrl", "challenge", "tunnelId", "tunnelName", "timestamp", "bodyHash", "identityFingerprint", "identityGeneration"]) {
    const mutated = { ...complete, [field]: field === "timestamp" || field === "identityGeneration" ? Number(complete[field]) + 1 : `${complete[field]}-changed` };
    assert.equal(crypto.verify(null, Buffer.from(canonicalCloudChallenge(mutated), "utf8"), keys.publicKey, signature), false, field);
  }
});

test("identity broker is a root-only, certificate-bearing boundary", () => {
  const identityBroker = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "auth", "identityBroker.js"), "utf8");
  const identityd = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "identityd.js"), "utf8");
  assert.match(identityd, /root privileges are required/);
  assert.match(identityd, /identity socket must be under \/run/);
  assert.match(identityBroker, /assertSecurePath\(metadataPath, 0o644\)/);
  assert.match(identityBroker, /manufacturing-root identity certificate is required/);
  assert.match(identityBroker, /signingPublicKey\.asymmetricKeyType !== "ed25519"/);
  assert.match(identityBroker, /encryptionPublicKey\.asymmetricKeyType !== "x25519"/);
  assert.doesNotMatch(identityBroker, /exportPrivateKey\s*\(/);
  assert.doesNotMatch(identityBroker, /signStepUpDescriptor/);
  assert.match(identityBroker, /machine-credential.*operator-session/);
  assert.match(identityBroker, /operator-session/);
});

test("support proof-of-possession uses the Platform-compatible golden vector", () => {
  assert.equal(supportProofOfPossessionDigest({
    employeeProofHash: "a".repeat(64),
    serial: "din-home-001",
    ticketId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    codeHash: "b".repeat(64),
    identityGeneration: 1,
  }), "1b02c8aca1f3d4c91ef1af9ec2e2de38a2fb72dcc249d094314b86e3b8673139");
});
