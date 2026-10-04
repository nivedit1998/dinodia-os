"use strict";

const crypto = require("node:crypto");

const PAYLOAD_KEYS = Object.freeze([
  "version", "releaseId", "releaseVersion", "channel", "targetArch",
  "minimumApiVersion", "apiVersion", "minimumStoreSchemaVersion",
  "storeSchemaVersion", "artifactUrl", "artifactSha256", "signingKeyId",
  "releasedAt", "expiresAt", "rollbackPolicy", "attemptId",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function strictUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const wholeSecond = `${value.slice(0, 19)}Z`;
  const time = Date.parse(wholeSecond);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function compareVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string") return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) return null;
    const prerelease = match[4] ? match[4].split(".") : [];
    if (prerelease.some((part) => !part || !/^[0-9A-Za-z-]+$/.test(part) || /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
    return { numbers: match.slice(1, 4).map(BigInt), prerelease };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]; const rightPart = b.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart); const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length < b.prerelease.length ? -1 : 1;
}

function fail(code) { return { ok: false, code }; }

/** Verify a bounded signed release description without performing I/O or logging its URL. */
function verifyReleaseManifest(envelope, policy, { now = Date.now(), activeRelease = null, usedAttemptIds = [] } = {}) {
  if (!Number.isFinite(now)) return fail("CLOCK_UNAVAILABLE");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).sort().join("\n") !== "payload\nsignature"
    || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)
    || Object.keys(envelope.payload).sort().join("\n") !== [...PAYLOAD_KEYS].sort().join("\n")) return fail("MANIFEST_SHAPE_INVALID");
  const payload = envelope.payload;
  if (payload.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(String(payload.releaseId || ""))
    || String(payload.releaseId).includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(String(payload.attemptId || ""))) return fail("MANIFEST_ID_INVALID");
  if (payload.channel !== policy?.approvedChannel || payload.targetArch !== policy?.targetArch
    || !Number.isSafeInteger(payload.apiVersion) || payload.apiVersion !== policy?.apiVersion
    || !Number.isSafeInteger(payload.minimumApiVersion) || payload.minimumApiVersion < 1 || payload.minimumApiVersion > payload.apiVersion
    || !Number.isSafeInteger(payload.storeSchemaVersion) || payload.storeSchemaVersion !== policy?.storeSchemaVersion
    || !Number.isSafeInteger(payload.minimumStoreSchemaVersion) || payload.minimumStoreSchemaVersion < 1 || payload.minimumStoreSchemaVersion > payload.storeSchemaVersion) return fail("TARGET_OR_COMPATIBILITY_MISMATCH");
  if (typeof payload.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.artifactSha256)
    || typeof payload.signingKeyId !== "string" || payload.signingKeyId !== policy?.signingKeyId
    || payload.rollbackPolicy !== "restore-previous-release") return fail("ARTIFACT_POLICY_INVALID");
  let artifact;
  try { artifact = new URL(payload.artifactUrl); } catch { return fail("ARTIFACT_URL_INVALID"); }
  if (artifact.protocol !== "https:" || !policy?.allowedArtifactHosts?.includes(artifact.hostname.toLowerCase())
    || artifact.username || artifact.password || artifact.hash || artifact.port && artifact.port !== "443"
    || artifact.pathname === "/" || artifact.pathname.includes("\\") || artifact.pathname.split("/").some((part) => part === "." || part === "..")) return fail("ARTIFACT_URL_INVALID");
  if (!strictUtc(payload.releasedAt) || !strictUtc(payload.expiresAt)) return fail("MANIFEST_TIME_INVALID");
  const releasedAt = Date.parse(payload.releasedAt); const expiresAt = Date.parse(payload.expiresAt);
  const maxLifetime = Number(policy?.maxManifestLifetimeMs || 7 * 24 * 60 * 60 * 1000);
  if (releasedAt > now || expiresAt <= now || expiresAt <= releasedAt || expiresAt - releasedAt > maxLifetime) return fail("MANIFEST_EXPIRED_OR_UNBOUNDED");
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(envelope.signature)) return fail("MANIFEST_SIGNATURE_INVALID");
  let publicKey;
  try {
    const configuredKey = policy?.releaseSigningPublicKey;
    publicKey = configuredKey?.type === "public" ? configuredKey : crypto.createPublicKey(configuredKey);
  } catch { return fail("SIGNING_KEY_UNAVAILABLE"); }
  if (publicKey.asymmetricKeyType !== "ed25519") return fail("SIGNING_KEY_INVALID");
  let signature;
  try { signature = Buffer.from(envelope.signature, "base64url"); } catch { return fail("MANIFEST_SIGNATURE_INVALID"); }
  let verified = false;
  try { verified = crypto.verify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, signature); } catch {}
  if (!verified) return fail("MANIFEST_SIGNATURE_INVALID");

  const priorVersion = activeRelease?.releaseVersion;
  if (activeRelease?.releaseId === payload.releaseId && activeRelease?.manifestDigest === crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex")) {
    return { ok: true, idempotent: true, payload, manifestDigest: activeRelease.manifestDigest };
  }
  if (Array.isArray(usedAttemptIds) && usedAttemptIds.some((entry) => {
    if (typeof entry === "string") return entry === payload.attemptId;
    return entry && entry.attemptId === payload.attemptId && strictUtc(entry.expiresAt) && Date.parse(entry.expiresAt) > now;
  })) return fail("MANIFEST_REPLAYED");
  if (priorVersion) {
    const order = compareVersions(payload.releaseVersion, priorVersion);
    if (order === null || order <= 0) return fail("RELEASE_DOWNGRADE_OR_REPLAY");
  } else if (compareVersions(payload.releaseVersion, "0.0.0") === null) return fail("RELEASE_VERSION_INVALID");
  const manifestDigest = crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { ok: true, idempotent: false, payload, manifestDigest };
}

function verifyArtifactDigest(bytes, expectedSha256) {
  return Buffer.isBuffer(bytes) && typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(expectedSha256)
    && crypto.timingSafeEqual(crypto.createHash("sha256").update(bytes).digest(), Buffer.from(expectedSha256, "hex"));
}

module.exports = { canonicalJson, strictUtc, compareVersions, verifyReleaseManifest, verifyArtifactDigest };
