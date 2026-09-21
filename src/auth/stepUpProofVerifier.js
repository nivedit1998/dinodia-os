const crypto = require("node:crypto");

function digestOperation(input = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    actorId: String(input.actorId || ""),
    homeId: String(input.homeId || ""),
    membershipId: String(input.membershipId || ""),
    hubInstallId: String(input.hubInstallId || ""),
    operation: String(input.operation || ""),
    targetIds: (input.targetIds || []).map(String).sort(),
    value: input.value,
  }), "utf8").digest("hex");
}

function decode(value) { return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")); }

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
    if (String(proof.actorId) !== String(expected.actorId) || String(proof.homeId) !== String(expected.homeId) || (expected.membershipId != null && String(proof.membershipId || "") !== String(expected.membershipId)) || (expected.hubInstallId != null && String(proof.hubInstallId || "") !== String(expected.hubInstallId))) return null;
    const digest = digestOperation(expected);
    const persistedUsed = this.store?.getSecurity?.().usedStepUpProofs || {};
    if (proof.operationDigest !== digest || this.used.has(String(proof.jti)) || persistedUsed[String(proof.jti)]) return null;
    const unsigned = { jti: String(proof.jti), actorId: String(proof.actorId), homeId: String(proof.homeId), membershipId: proof.membershipId ? String(proof.membershipId) : undefined, hubInstallId: proof.hubInstallId ? String(proof.hubInstallId) : undefined, operationDigest: proof.operationDigest, issuedAt: Number(proof.issuedAt), expiresAt: Number(proof.expiresAt) };
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

module.exports = { digestOperation, StepUpProofVerifier };
