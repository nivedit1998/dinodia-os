const crypto = require("node:crypto");

/**
 * Cross-runtime Stage 1 support proof. Platform stores only the hash of the
 * encrypted employee grant and the approved one-use code. The hub proves it
 * decrypted that grant and knows the code without sending either authority
 * value back to Platform.
 */
function supportProofOfPossessionDigest({ employeeProofHash, serial, ticketId, requestId, codeHash, identityGeneration }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: 1,
    employeeProofHash: String(employeeProofHash),
    serial: String(serial),
    ticketId: String(ticketId),
    requestId: String(requestId),
    codeHash: String(codeHash),
    identityGeneration: Number(identityGeneration),
  }), "utf8").digest("hex");
}

module.exports = { supportProofOfPossessionDigest };
