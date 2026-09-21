const crypto = require("node:crypto");

const CREDENTIAL_TYPES = Object.freeze({
  OPERATOR_SESSION: "operator_session",
  APP_ACCESS: "app_access",
  HUB_AGENT: "hub_agent",
  OFFLINE_LAN: "offline_lan",
  RETIRED_LEGACY: "retired_legacy",
});

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 32);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function constantTimeHashMatch(value, expectedHash) {
  const actual = Buffer.from(hash(value));
  const expected = Buffer.from(String(expectedHash || ""));
  return actual.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * In-memory credential policy used by the hub. The Store owns persistence;
 * this class deliberately contains only hashes/fingerprints and never a
 * reusable plaintext credential.
 */
class CredentialRegistry {
  constructor({ now = () => Date.now(), onRevoke = () => {} } = {}) {
    this.now = now;
    this.onRevoke = onRevoke;
    this.records = new Map();
  }

  load(records = []) {
    this.records.clear();
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !record.fingerprint || !record.type) continue;
      this.records.set(String(record.fingerprint), {
        type: String(record.type),
        fingerprint: String(record.fingerprint),
        hash: String(record.hash || ""),
        version: Number(record.version || 0),
        homeId: record.homeId == null ? null : String(record.homeId),
        jti: record.jti ? String(record.jti) : null,
        expiresAt: record.expiresAt ? Number(record.expiresAt) : null,
        revokedAt: record.revokedAt ? Number(record.revokedAt) : null,
        policyRevision: Number(record.policyRevision || 0),
      });
    }
  }

  snapshot() {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  register({ type, credential, credentialHash, version = 0, homeId = null, jti = null, expiresAt = null, policyRevision = 0 } = {}) {
    const normalizedType = String(type || "");
    if (!Object.values(CREDENTIAL_TYPES).includes(normalizedType)) throw new Error("Unknown credential type");
    const hashValue = credentialHash || (credential ? hash(credential) : "");
    if (!hashValue || !/^[a-f0-9]{64}$/i.test(hashValue)) throw new Error("A SHA-256 credential hash is required");
    const entry = {
      type: normalizedType,
      fingerprint: fingerprint(credential || hashValue),
      hash: hashValue.toLowerCase(),
      version: Number(version || 0),
      homeId: homeId == null ? null : String(homeId),
      jti: jti ? String(jti) : null,
      expiresAt: expiresAt == null ? null : Number(expiresAt),
      revokedAt: null,
      policyRevision: Number(policyRevision || 0),
    };
    this.records.set(entry.fingerprint, entry);
    return { ...entry };
  }

  verify(credential, { type, homeId, jti, now = this.now(), minimumPolicyRevision = 0 } = {}) {
    const supplied = String(credential || "");
    if (!supplied || supplied.length > 16384) return null;
    const matching = [...this.records.values()].find((record) => (
      (!type || record.type === type) &&
      (homeId == null || record.homeId === String(homeId)) &&
      (!jti || record.jti === String(jti)) &&
      !record.revokedAt &&
      (!record.expiresAt || record.expiresAt > Number(now)) &&
      record.policyRevision >= Number(minimumPolicyRevision || 0) &&
      constantTimeHashMatch(supplied, record.hash)
    ));
    return matching ? { ...matching } : null;
  }

  revoke({ fingerprint: targetFingerprint, type, homeId, reason = "revoked" } = {}) {
    const targets = [...this.records.values()].filter((record) => (
      (!targetFingerprint || record.fingerprint === String(targetFingerprint)) &&
      (!type || record.type === type) &&
      (homeId == null || record.homeId === String(homeId)) &&
      !record.revokedAt
    ));
    const revokedAt = Number(this.now());
    for (const record of targets) {
      record.revokedAt = revokedAt;
      this.onRevoke({ fingerprint: record.fingerprint, type: record.type, homeId: record.homeId, reason, revokedAt });
    }
    return targets.length;
  }

  removeExpired(now = this.now()) {
    let removed = 0;
    for (const [key, record] of this.records.entries()) {
      if (record.expiresAt && record.expiresAt <= Number(now)) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { CREDENTIAL_TYPES, CredentialRegistry, fingerprint, hash, constantTimeHashMatch };
