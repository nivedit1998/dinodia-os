const crypto = require("node:crypto");

function operationDigest({ actorId, trustedSessionId, homeId, operation, targetIds = [], value } = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({ actorId, trustedSessionId, homeId, operation, targetIds: [...targetIds].map(String).sort(), value }), "utf8").digest("hex");
}

class StepUpProofRegistry {
  constructor({ now = () => Date.now(), ttlMs = 30_000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.proofs = new Map();
  }

  issue(input = {}) {
    const proof = {
      id: crypto.randomUUID(),
      digest: operationDigest(input),
      actorId: String(input.actorId || ""),
      trustedSessionId: String(input.trustedSessionId || ""),
      homeId: String(input.homeId || ""),
      expiresAt: Number(this.now()) + this.ttlMs,
      usedAt: null,
    };
    if (!proof.actorId || !proof.trustedSessionId || !proof.homeId) throw new Error("Step-up actor, session and home are required");
    this.proofs.set(proof.id, proof);
    return { id: proof.id, expiresAt: proof.expiresAt };
  }

  consume(id, input = {}) {
    const proof = this.proofs.get(String(id));
    if (!proof || proof.usedAt || proof.expiresAt <= Number(this.now())) return null;
    if (proof.digest !== operationDigest(input) || proof.actorId !== String(input.actorId || "") || proof.trustedSessionId !== String(input.trustedSessionId || "") || proof.homeId !== String(input.homeId || "")) return null;
    proof.usedAt = Number(this.now());
    return { id: proof.id, usedAt: proof.usedAt };
  }
}

module.exports = { operationDigest, StepUpProofRegistry };
