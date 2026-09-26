const crypto = require("node:crypto");

function supportProofRequestDigest(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: 2,
    serial: String(input.serial),
    ticketId: String(input.ticketId),
    requestId: String(input.requestId),
    employeeId: String(input.employeeId),
    homeId: String(input.homeId),
    codeHash: String(input.codeHash),
    identityGeneration: Number(input.identityGeneration),
    nonce: String(input.nonce),
    proofExpiresAt: Number(input.proofExpiresAt),
  }), "utf8").digest("hex");
}

function supportProofMessage(input) {
  return Buffer.from(JSON.stringify({
    version: 2,
    serial: String(input.serial),
    ticketId: String(input.ticketId),
    requestId: String(input.requestId),
    employeeId: String(input.employeeId),
    homeId: String(input.homeId),
    codeHash: String(input.codeHash),
    identityGeneration: Number(input.identityGeneration),
    nonce: String(input.nonce),
    proofExpiresAt: Number(input.proofExpiresAt),
    requestBodyDigest: String(input.requestBodyDigest),
  }), "utf8");
}

function createSupportProofOfPossession({ privateKeyPem, ...input }) {
  const requestBodyDigest = supportProofRequestDigest(input);
  const signature = crypto.sign(null, supportProofMessage({ ...input, requestBodyDigest }), crypto.createPrivateKey(String(privateKeyPem))).toString("base64url");
  return { requestBodyDigest, signature };
}

module.exports = { supportProofRequestDigest, supportProofMessage, createSupportProofOfPossession };
