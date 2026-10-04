"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { canonicalJson, compareVersions, verifyArtifactDigest, verifyReleaseManifest } = require("../src/updater/releaseManifest");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const policy = {
  approvedChannel: "stable",
  targetArch: "aarch64",
  apiVersion: 2,
  storeSchemaVersion: 3,
  signingKeyId: "dinodia-release-test-key",
  releaseSigningPublicKey: publicKey,
  allowedArtifactHosts: ["releases.example.invalid"],
};
const now = Date.parse("2026-10-04T12:00:00.000Z");

function signed(payload) {
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url");
  return { payload, signature };
}

function payload(overrides = {}) {
  return {
    version: 1,
    releaseId: "native-v2-aabbccddeeff001122334455",
    releaseVersion: "4.1.0",
    channel: "stable",
    targetArch: "aarch64",
    minimumApiVersion: 2,
    apiVersion: 2,
    minimumStoreSchemaVersion: 3,
    storeSchemaVersion: 3,
    artifactUrl: "https://releases.example.invalid/dinodia-os/releases/4.1.0.tar.gz",
    artifactSha256: "a".repeat(64),
    signingKeyId: "dinodia-release-test-key",
    releasedAt: "2026-10-04T11:00:00Z",
    expiresAt: "2026-10-05T11:00:00Z",
    rollbackPolicy: "restore-previous-release",
    attemptId: "attempt-4f8c8c17",
    ...overrides,
  };
}

test("signed release manifest validates and is idempotent only for the exact active payload", () => {
  const envelope = signed(payload());
  const result = verifyReleaseManifest(envelope, policy, { now, activeRelease: { releaseVersion: "4.0.0" } });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, false);
  const retry = verifyReleaseManifest(envelope, policy, {
    now,
    activeRelease: { releaseId: result.payload.releaseId, releaseVersion: result.payload.releaseVersion, manifestDigest: result.manifestDigest },
    usedAttemptIds: [result.payload.attemptId],
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
});

test("signature, expiry, calendar date, target, channel, host and compatibility mismatches fail closed", () => {
  const cases = [
    ["signature", (p) => ({ ...signed(p), signature: "A".repeat(86) })],
    ["expired", (p) => signed({ ...p, expiresAt: "2026-10-04T11:59:59Z" })],
    ["invalid date", (p) => signed({ ...p, releasedAt: "2026-02-31T10:00:00Z" })],
    ["wrong architecture", (p) => signed({ ...p, targetArch: "x86_64" })],
    ["wrong channel", (p) => signed({ ...p, channel: "preview" })],
    ["wrong host", (p) => signed({ ...p, artifactUrl: "https://attacker.invalid/update.tar.gz" })],
    ["incompatible API", (p) => signed({ ...p, minimumApiVersion: 3 })],
  ];
  for (const [name, create] of cases) {
    const result = verifyReleaseManifest(create(payload()), policy, { now, activeRelease: { releaseVersion: "4.0.0" } });
    assert.equal(result.ok, false, name);
  }
});

test("attempt replay and release downgrade are rejected after an active release exists", () => {
  const replay = verifyReleaseManifest(signed(payload()), policy, { now, activeRelease: { releaseVersion: "4.0.0" }, usedAttemptIds: ["attempt-4f8c8c17"] });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "MANIFEST_REPLAYED");
  const downgrade = verifyReleaseManifest(signed(payload({ releaseVersion: "3.9.9", attemptId: "attempt-new" })), policy, { now, activeRelease: { releaseVersion: "4.0.0" } });
  assert.equal(downgrade.ok, false);
  assert.equal(downgrade.code, "RELEASE_DOWNGRADE_OR_REPLAY");
});

test("artifact bytes must match the manifest SHA-256", () => {
  const bytes = Buffer.from("a reviewed package", "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifyArtifactDigest(bytes, digest), true);
  assert.equal(verifyArtifactDigest(bytes, "0".repeat(64)), false);
  assert.equal(verifyArtifactDigest("not bytes", digest), false);
});

test("release ordering uses bounded SemVer precedence rather than floating point", () => {
  assert.equal(compareVersions("4.1.0-alpha.2", "4.1.0-alpha.10"), -1);
  assert.equal(compareVersions("4.1.0-rc.1", "4.1.0"), -1);
  assert.equal(compareVersions("4.1.0+build.2", "4.1.0+build.1"), 0);
  assert.equal(compareVersions("4.01.0", "4.1.0"), null);
});
