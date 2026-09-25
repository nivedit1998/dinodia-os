const crypto = require("node:crypto");

function digestOperation(operation) {
  return crypto.createHash("sha256").update(JSON.stringify(operation || {}), "utf8").digest("hex");
}

function digestOfflineCommand({ deviceId, entityId, controlId, serviceId, value } = {}) {
  return digestOperation({
    deviceId: String(deviceId || ""),
    entityId: String(entityId || ""),
    controlId: String(controlId || ""),
    serviceId: String(serviceId || ""),
    value: value || {},
  });
}

function createLanChallenge({ homeId, hubInstallId, areaId, deviceId, controlId, valueDigest, nonce = crypto.randomBytes(24).toString("base64url"), now = Date.now() } = {}) {
  return { v: 1, homeId: String(homeId || ""), hubInstallId: String(hubInstallId || ""), areaId: String(areaId || ""), deviceId: String(deviceId || ""), controlId: String(controlId || ""), valueDigest: String(valueDigest || ""), nonce, issuedAt: Number(now) };
}

function signLanChallenge(challenge, privateKey) {
  if (!privateKey) throw new Error("A local private key is required");
  return crypto.sign(null, Buffer.from(JSON.stringify(challenge), "utf8"), privateKey).toString("base64url");
}

function verifyLanProof({ challenge, signature, publicKey, now = Date.now(), maxAgeMs = 30_000 } = {}) {
  if (!challenge || !signature || !publicKey) return false;
  if (Number(now) - Number(challenge.issuedAt) < 0 || Number(now) - Number(challenge.issuedAt) > maxAgeMs) return false;
  try { return crypto.verify(null, Buffer.from(JSON.stringify(challenge), "utf8"), publicKey, Buffer.from(signature, "base64url")); } catch { return false; }
}

function canUseArea({ areaIds = [], areaId } = {}) {
  return Array.isArray(areaIds) && areaIds.map(String).includes(String(areaId || ""));
}

class OfflineLanAuthorisationStore {
  constructor({ store, now = () => Date.now(), maxOfflineMs = 0, platformPublicKeys = [] } = {}) {
    this.store = store;
    this.now = now;
    this.maxOfflineMs = maxOfflineMs;
    this.platformPublicKeys = platformPublicKeys;
  }

  records() { return this.store?.getSecurity?.().offlineAuthorisations || {}; }

  async enroll(input = {}) {
    if (!input.homeId || !input.hubInstallId || !input.membershipId || !input.trustedDeviceId || !input.publicKey) throw new Error("Offline authorization identity is incomplete");
    if (!Array.isArray(input.areaIds) || input.areaIds.length === 0) throw new Error("Offline authorization requires an area scope");
    if (!Array.isArray(input.scope) || !input.scope.includes("tenant:device-command")) throw new Error("Offline authorization requires tenant device command scope");
    const id = String(input.id || crypto.randomUUID());
    const issuedAt = Number(input.issuedAt || this.now());
    const expiresAt = input.expiresAt == null || !this.maxOfflineMs ? null : Math.min(Number(input.expiresAt), issuedAt + this.maxOfflineMs);
    const grant = {
      version: 1,
      id,
      homeId: String(input.homeId),
      hubInstallId: String(input.hubInstallId),
      membershipId: String(input.membershipId),
      trustedDeviceId: String(input.trustedDeviceId),
      userId: String(input.userId || ""),
      householdRole: String(input.householdRole || "TENANT"),
      publicKey: String(input.publicKey),
      areaIds: [...new Set(input.areaIds.map(String))],
      scope: [...new Set(input.scope.map(String))],
      policyRevision: Number(input.policyRevision || 0),
      issuedAt,
      expiresAt,
      revokedAt: null,
    };
    await this.store.saveSecurity({ offlineAuthorisations: { ...this.records(), [id]: grant } });
    return { ...grant };
  }

  async acceptPlatformEnvelope(envelope = {}) {
    const encoded = String(envelope.signature || '').split('.')[0];
    const signature = String(envelope.signature || '').split('.')[1];
    if (!encoded || !signature || JSON.stringify(envelope.payload || {}) !== Buffer.from(encoded, 'base64url').toString('utf8')) throw new Error('Offline authorisation envelope is malformed');
    let valid = false;
    for (const key of this.platformPublicKeys) {
      try { if (crypto.verify(null, Buffer.from(encoded, 'utf8'), key, Buffer.from(signature, 'base64url'))) { valid = true; break; } } catch {}
    }
    if (!valid) throw new Error('Offline authorisation envelope signature is invalid');
    const payload = envelope.payload || {};
    if (!payload.id || !payload.homeId || !payload.hubInstallId || !payload.membershipId || !payload.trustedDeviceId) throw new Error('Offline authorisation envelope identity is incomplete');
    if (payload.revokedAt) return this.revoke(String(payload.id), String(payload.revokeReason || 'cloud_policy_revoked'));
    return this.enroll({ id: payload.id, homeId: payload.homeId, hubInstallId: payload.hubInstallId, membershipId: payload.membershipId, trustedDeviceId: payload.trustedDeviceId, userId: payload.customerAccountId, householdRole: payload.householdRole, publicKey: payload.publicKey, areaIds: payload.areaIds, scope: payload.scope, policyRevision: payload.policyRevision, issuedAt: payload.issuedAt, expiresAt: null });
  }

  async revoke(id, reason = "revoked") {
    const current = this.records()[String(id)];
    if (!current) return false;
    await this.store.saveSecurity({ offlineAuthorisations: { ...this.records(), [String(id)]: { ...current, revokedAt: this.now(), revokeReason: String(reason).slice(0, 128) } } });
    return true;
  }

  async revokeDevice(trustedDeviceId, reason = "trusted_device_removed") {
    const records = this.records();
    const next = { ...records };
    let count = 0;
    for (const [id, grant] of Object.entries(records)) if (String(grant.trustedDeviceId) === String(trustedDeviceId) && !grant.revokedAt) { next[id] = { ...grant, revokedAt: this.now(), revokeReason: String(reason).slice(0, 128) }; count += 1; }
    if (count) await this.store.saveSecurity({ offlineAuthorisations: next });
    return count;
  }

  async verify({ grantId, challenge, signature } = {}) {
    const grant = this.records()[String(grantId || "")];
    if (!grant || grant.revokedAt || (grant.expiresAt && Number(grant.expiresAt) <= this.now())) return null;
    if (String(challenge?.homeId) !== grant.homeId || String(challenge?.hubInstallId) !== grant.hubInstallId || !canUseArea({ areaIds: grant.areaIds, areaId: challenge?.areaId || challenge?.areaIds?.[0] })) return null;
    if (!grant.scope.includes("tenant:device-command") || grant.householdRole !== "TENANT") return null;
    let publicKey;
    try { publicKey = crypto.createPublicKey(grant.publicKey); } catch { return null; }
    if (!verifyLanProof({ challenge, signature, publicKey, now: this.now() })) return null;
    const nonce = String(challenge.nonce || "");
    if (!nonce) return null;
    const security = this.store.getSecurity();
    if (security.usedLanNonces[nonce]) return null;
    await this.store.saveSecurity({ usedLanNonces: { ...security.usedLanNonces, [nonce]: this.now() } });
    return { ...grant, principalType: "offline", sub: `user:${grant.userId}`, areaIds: [...grant.areaIds], scope: [...grant.scope] };
  }

  async prune() {
    const security = this.store.getSecurity();
    const cutoff = this.now() - Math.max(this.maxOfflineMs, 24 * 60 * 60 * 1000);
    const usedLanNonces = Object.fromEntries(Object.entries(security.usedLanNonces || {}).filter(([, at]) => Number(at) > cutoff));
    await this.store.saveSecurity({ usedLanNonces });
  }
}

module.exports = { digestOperation, digestOfflineCommand, createLanChallenge, signLanChallenge, verifyLanProof, canUseArea, OfflineLanAuthorisationStore };
