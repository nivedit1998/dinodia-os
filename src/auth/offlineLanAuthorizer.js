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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function digestNativeOfflineCommand(command) {
  return crypto.createHash("sha256").update(stableJson(command), "utf8").digest("hex");
}

function createLanChallenge({ homeId, hubInstallId, areaId, deviceId, controlId, valueDigest, nonce = crypto.randomBytes(24).toString("base64url"), now = Date.now() } = {}) {
  return { v: 1, homeId: String(homeId || ""), hubInstallId: String(hubInstallId || ""), areaId: String(areaId || ""), deviceId: String(deviceId || ""), controlId: String(controlId || ""), valueDigest: String(valueDigest || ""), nonce, issuedAt: Number(now) };
}

function createNativeLanChallenge({ grantId, purpose, homeId, hubInstallId, membershipId, trustedDeviceId, policyRevision, areaIds = [], requestPath, deviceId = null, controlId = null, descriptorRevision = null, valueDigest = null, nonce = crypto.randomBytes(24).toString("base64url"), now = Date.now() } = {}) {
  return {
    v: 2,
    grantId: String(grantId || ""),
    purpose: String(purpose || ""),
    homeId: String(homeId || ""),
    hubInstallId: String(hubInstallId || ""),
    membershipId: String(membershipId || ""),
    trustedDeviceId: String(trustedDeviceId || ""),
    policyRevision: Number(policyRevision),
    areaIds: [...new Set((Array.isArray(areaIds) ? areaIds : []).map(String))].sort(),
    requestPath: String(requestPath || ""),
    deviceId: deviceId == null ? null : String(deviceId),
    controlId: controlId == null ? null : String(controlId),
    descriptorRevision: descriptorRevision == null ? null : Number(descriptorRevision),
    valueDigest: valueDigest == null ? null : String(valueDigest),
    nonce: String(nonce),
    issuedAt: Number(now),
  };
}

function signLanChallenge(challenge, privateKey) {
  if (!privateKey) throw new Error("A local private key is required");
  const key = privateKey.type === "private" ? privateKey : crypto.createPrivateKey(privateKey);
  // Trusted-phone enrollment uses the app's Secure Enclave P-256 key. Keep
  // Ed25519 support for existing hub-side fixtures, but use SHA-256/ECDSA for
  // the actual P-256 public key stored by the Platform offline grant.
  const algorithm = key.asymmetricKeyType === "ed25519" ? null : key.asymmetricKeyType === "ec" ? "sha256" : undefined;
  if (algorithm === undefined) throw new Error("The offline proof key type is not supported");
  const message = challenge?.v === 2 ? stableJson(challenge) : JSON.stringify(challenge);
  return crypto.sign(algorithm, Buffer.from(message, "utf8"), key).toString("base64url");
}

function verifyLanProof({ challenge, signature, publicKey, now = Date.now(), maxAgeMs = 30_000 } = {}) {
  if (!challenge || !signature || !publicKey) return false;
  if (Number(now) - Number(challenge.issuedAt) < 0 || Number(now) - Number(challenge.issuedAt) > maxAgeMs) return false;
  try {
    const key = publicKey.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
    const algorithm = key.asymmetricKeyType === "ed25519" ? null : key.asymmetricKeyType === "ec" ? "sha256" : undefined;
    const message = challenge?.v === 2 ? stableJson(challenge) : JSON.stringify(challenge);
    return algorithm !== undefined && crypto.verify(algorithm, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch { return false; }
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
    this.nonceQueue = Promise.resolve();
  }

  records() { return this.store?.getSecurity?.().offlineAuthorisations || {}; }

  currentPrincipal(grantId) {
    const grant = this.records()[String(grantId || "")];
    if (!grant) return null;
    const principal = {
      ...grant,
      principalType: "offline",
      sub: `user:${grant.userId}`,
      membershipId: grant.membershipId,
      homeMembershipId: grant.membershipId,
      scope: [...(grant.scope || [])],
      areaIds: [...(grant.areaIds || [])],
    };
    return this.isCurrent(principal) ? principal : null;
  }

  isCurrent(principal) {
    if (!principal || principal.principalType !== "offline") return false;
    const current = this.records()[String(principal.id || "")];
    if (!current || current.revokedAt || current.expiresAt && Number(current.expiresAt) <= this.now()) return false;
    const platform = this.store?.getPlatform?.() || {};
    return current.homeId === principal.homeId && current.hubInstallId === principal.hubInstallId
      && current.membershipId === principal.membershipId && current.trustedDeviceId === principal.trustedDeviceId
      && current.userId === principal.sub.replace(/^user:/, "")
      && Number(platform.policyRevision ?? current.policyRevision) === Number(current.policyRevision)
      && current.areaIds.length > 0 && current.areaIds.every((id) => principal.areaIds.includes(id));
  }

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
    if (!payload.id || !payload.customerAccountId || !payload.homeId || !payload.hubInstallId || !payload.membershipId || !payload.trustedDeviceId) throw new Error('Offline authorisation envelope identity is incomplete');
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

  async verify({ grantId, challenge, signature, expectedPurpose, expectedPath } = {}) {
    const grant = this.records()[String(grantId || "")];
    if (!grant || grant.revokedAt || (grant.expiresAt && Number(grant.expiresAt) <= this.now())) return null;
    if (challenge?.v === 2) {
      const keys = ["areaIds", "controlId", "descriptorRevision", "deviceId", "grantId", "homeId", "hubInstallId", "issuedAt", "membershipId", "nonce", "policyRevision", "purpose", "requestPath", "trustedDeviceId", "v", "valueDigest"];
      if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)
        || Object.keys(challenge).sort().join("\n") !== keys.join("\n")
        || challenge.v !== 2 || challenge.grantId !== String(grant.id)
        || challenge.purpose !== expectedPurpose || challenge.requestPath !== expectedPath
        || !["native.read", "native.events", "native.command"].includes(challenge.purpose)
        || challenge.homeId !== grant.homeId || challenge.hubInstallId !== grant.hubInstallId
        || challenge.membershipId !== grant.membershipId || challenge.trustedDeviceId !== grant.trustedDeviceId
        || challenge.policyRevision !== grant.policyRevision
        || !Array.isArray(challenge.areaIds) || challenge.areaIds.length === 0
        || challenge.areaIds.some((id) => typeof id !== "string" || !grant.areaIds.includes(id))
        || new Set(challenge.areaIds).size !== challenge.areaIds.length
        || !/^[A-Za-z0-9_-]{20,128}$/.test(String(challenge.nonce || ""))
        || !Number.isSafeInteger(challenge.issuedAt) || this.now() - challenge.issuedAt < 0 || this.now() - challenge.issuedAt > 30_000) return null;
      if (challenge.purpose === "native.command") {
        if (typeof challenge.deviceId !== "string" || !challenge.deviceId || typeof challenge.controlId !== "string" || !challenge.controlId
          || !Number.isSafeInteger(challenge.descriptorRevision) || challenge.descriptorRevision < 0
          || typeof challenge.valueDigest !== "string" || !/^[a-f0-9]{64}$/.test(challenge.valueDigest)) return null;
        const device = this.store?.getDevice?.(challenge.deviceId);
        const hubAreaId = String(device?.areaId || device?.metadata?.areaId || "");
        const bindings = (this.store?.getPlatform?.()?.areaBindings || []).filter((entry) => challenge.areaIds.includes(String(entry?.areaId || "")) && String(entry?.hubAreaId || "") === hubAreaId);
        if (!device || !hubAreaId || bindings.length !== 1) return null;
      } else if (challenge.deviceId !== null || challenge.controlId !== null || challenge.descriptorRevision !== null || challenge.valueDigest !== null) return null;
      const platform = this.store?.getPlatform?.() || {};
      if (Number(platform.policyRevision ?? grant.policyRevision) !== grant.policyRevision) return null;
      let publicKey;
      try { publicKey = crypto.createPublicKey(grant.publicKey); } catch { return null; }
      if (!verifyLanProof({ challenge, signature, publicKey, now: this.now() })) return null;
      const nonce = String(challenge.nonce);
      const previous = this.nonceQueue;
      let release;
      this.nonceQueue = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        const security = this.store.getSecurity();
        if (security.usedLanNonces[nonce]) return null;
        await this.store.saveSecurity({ usedLanNonces: { ...security.usedLanNonces, [nonce]: this.now() } });
      } finally { release(); }
      return { ...grant, principalType: "offline", sub: `user:${grant.userId}`, sid: grant.trustedDeviceId, homeMembershipId: grant.membershipId, scope: [...grant.scope], areaIds: [...challenge.areaIds] };
    }
    const challengeKeys = ["areaId", "controlId", "deviceId", "homeId", "hubInstallId", "issuedAt", "nonce", "v", "valueDigest"];
    if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)
      || Object.keys(challenge).sort().join("\n") !== challengeKeys.join("\n")
      || challenge.v !== 1
      || ["areaId", "controlId", "deviceId", "homeId", "hubInstallId", "nonce", "valueDigest"].some((key) => typeof challenge[key] !== "string" || !challenge[key])) return null;
    // The phone signs the public canonical Area UUID. The hub resolves the
    // target device's private OS alias locally and requires an exact binding.
    const canonicalAreaId = challenge.areaId;
    const device = this.store?.getDevice?.(challenge.deviceId);
    const hubAreaId = String(device?.areaId || device?.metadata?.areaId || "");
    const bindings = (this.store?.getPlatform?.()?.areaBindings || []).filter((entry) => String(entry?.areaId || "") === canonicalAreaId && String(entry?.hubAreaId || "") === hubAreaId);
    if (String(challenge.homeId) !== grant.homeId || String(challenge.hubInstallId) !== grant.hubInstallId || !device || !hubAreaId || bindings.length !== 1 || !canUseArea({ areaIds: grant.areaIds, areaId: canonicalAreaId })) return null;
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

module.exports = { digestOperation, digestOfflineCommand, digestNativeOfflineCommand, createLanChallenge, createNativeLanChallenge, signLanChallenge, verifyLanProof, canUseArea, OfflineLanAuthorisationStore };
