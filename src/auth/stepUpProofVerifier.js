const crypto = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value == null ? null : value);
}

function digestOperation(input = {}) {
  return crypto.createHash("sha256").update(canonical({
    actorId: String(input.actorId || ""),
    trustedDeviceId: String(input.trustedDeviceId || ""),
    customerSessionId: String(input.customerSessionId || input.trustedSessionId || ""),
    homeId: String(input.homeId || ""),
    membershipId: String(input.membershipId || ""),
    hubInstallId: String(input.hubInstallId || ""),
    operationKind: String(input.operationKind || input.operation || ""),
    targetIds: (input.targetIds || []).map(String).sort(),
    value: input.value,
  }), "utf8").digest("hex");
}

// This must remain byte-for-byte compatible with Platform's
// descriptorBoundValue().  Sensitive device operations are authorised against
// the current OS descriptor as well as the requested value; the descriptor is
// therefore part of the operation digest, not an advisory client field.
function descriptorBoundValue(value, descriptorDigests = {}) {
  const ordered = Object.fromEntries(Object.entries(descriptorDigests)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, digest]) => [String(id), digest == null ? null : String(digest)]));
  return { requestedValue: value == null ? null : value, descriptorDigests: ordered };
}

function decode(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("step-up proof format is invalid");
  const proof = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  proof.signature = parts[1];
  return proof;
}

class StepUpProofVerifier {
  constructor({ publicKeys = [], now = () => Date.now(), store = null } = {}) {
    this.publicKeys = publicKeys;
    this.now = now;
    this.used = new Map();
    this.store = store;
    for (const [jti, usedAt] of Object.entries(store?.getSecurity?.().usedStepUpProofs || {})) this.used.set(String(jti), Number(usedAt));
  }

  async verify(encoded, expected = {}) {
    let proof;
    try { proof = decode(encoded); } catch { return null; }
    const nowSeconds = Math.floor(this.now() / 1000);
    if (!proof?.jti || !proof.signature || Number(proof.expiresAt) <= nowSeconds || Number(proof.issuedAt) > nowSeconds + 5) return null;
    if (String(proof.actorId) !== String(expected.actorId) || String(proof.homeId) !== String(expected.homeId) || (expected.membershipId != null && String(proof.membershipId || "") !== String(expected.membershipId)) || (expected.hubInstallId != null && String(proof.hubInstallId || "") !== String(expected.hubInstallId)) || (expected.trustedDeviceId != null && String(proof.trustedDeviceId || "") !== String(expected.trustedDeviceId)) || (expected.trustedSessionId != null && String(proof.customerSessionId || "") !== String(expected.trustedSessionId))) return null;
    const digest = digestOperation(expected);
    const persistedUsed = this.store?.getSecurity?.().usedStepUpProofs || {};
    if (proof.operationDigest !== digest || this.used.has(String(proof.jti)) || persistedUsed[String(proof.jti)]) return null;
    const unsigned = { jti: String(proof.jti), actorId: String(proof.actorId), trustedDeviceId: proof.trustedDeviceId ? String(proof.trustedDeviceId) : undefined, customerSessionId: proof.customerSessionId ? String(proof.customerSessionId) : undefined, homeId: String(proof.homeId), membershipId: proof.membershipId ? String(proof.membershipId) : undefined, hubInstallId: proof.hubInstallId ? String(proof.hubInstallId) : undefined, operationDigest: proof.operationDigest, issuedAt: Number(proof.issuedAt), expiresAt: Number(proof.expiresAt) };
    const input = Buffer.from(JSON.stringify(unsigned), "utf8");
    const signature = Buffer.from(String(proof.signature), "base64url");
    const valid = this.publicKeys.some((key) => { try { return crypto.verify(null, input, key, signature); } catch { return false; } });
    if (!valid) return null;
    this.used.set(String(proof.jti), this.now());
    if (this.store?.saveSecurity) {
      try { await this.store.saveSecurity({ usedStepUpProofs: { ...(this.store.getSecurity?.().usedStepUpProofs || {}), [String(proof.jti)]: this.now() } }); } catch { return null; }
    }
    return Object.freeze({ ...unsigned });
  }

  prune() {
    const cutoff = this.now() - 120_000;
    for (const [jti, usedAt] of this.used) if (usedAt < cutoff) this.used.delete(jti);
  }
}

module.exports = { digestOperation, descriptorBoundValue, StepUpProofVerifier };
