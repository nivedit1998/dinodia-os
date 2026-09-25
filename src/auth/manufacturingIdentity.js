const crypto = require("node:crypto");

function generateManufacturingIdentity({ serial } = {}) {
  const normalizedSerial = String(serial || "").trim();
  if (!normalizedSerial) throw new Error("A Dinodia serial is required");
  // Signing and encryption are deliberately different identities. The
  // manufacturing system supplies the root certificate/signature; a hub may
  // never self-certify a production identity from this helper alone.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const encryptionPublicKeyDer = encryption.publicKey.export({ type: "spki", format: "der" });
  return {
    serial: normalizedSerial,
    publicKey,
    privateKey,
    signingPublicKey: publicKey,
    signingPrivateKey: privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    publicKeyFingerprint: crypto.createHash("sha256").update(publicKeyDer).digest("hex"),
    encryptionKeyFingerprint: crypto.createHash("sha256").update(encryptionPublicKeyDer).digest("hex"),
  };
}

// This is the byte-stable certificate body signed by Dinodia's offline
// manufacturing root. It intentionally excludes provisioning-attempt data;
// Platform and the enrolment script use the same field order and JSON shape.
function stableManufacturingIdentityPayload(input = {}) {
  return JSON.stringify({
    serial: String(input.serial || ""),
    identityGeneration: Number(input.identityGeneration ?? input.generation ?? 1),
    publicKeyPem: String(input.publicKeyPem || input.signingPublicKeyPem || (input.publicKey?.export?.({ type: "spki", format: "pem" }) || "")),
    encryptionPublicKeyPem: String(input.encryptionPublicKeyPem || (input.encryptionPublicKey?.export?.({ type: "spki", format: "pem" }) || "")),
    publicKeyFingerprint: String(input.publicKeyFingerprint || ""),
    encryptionKeyFingerprint: String(input.encryptionKeyFingerprint || ""),
  });
}

function createPlatformPairingEnvelope(identity, { attemptId, baseUrl, issuedAt = Date.now(), expiresAt, manufacturingSignature, generation = 1 } = {}) {
  if (!identity?.privateKey || !identity?.publicKey || !identity?.encryptionPublicKey) throw new Error("A complete manufacturing identity is required");
  if (!manufacturingSignature) throw new Error("A manufacturing-root certificate signature is required");
  const publicKeyPem = identity.publicKey.export({ type: "spki", format: "pem" }).toString();
  const encryptionPublicKeyPem = identity.encryptionPublicKey.export({ type: "spki", format: "pem" }).toString();
  const body = {
    version: 1,
    serial: identity.serial,
    identityGeneration: Number(generation),
    attemptId: String(attemptId || ""),
    publicKeyPem,
    encryptionPublicKeyPem,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    encryptionKeyFingerprint: identity.encryptionKeyFingerprint,
    baseUrl: String(baseUrl || "").replace(/\/$/, ""),
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
  };
  const hubSignature = crypto.sign(null, Buffer.from(JSON.stringify(body), "utf8"), identity.privateKey).toString("base64url");
  return { ...body, hubSignature, manufacturingSignature: String(manufacturingSignature) };
}

function privateKeyPem(key) { return key?.export({ type: "pkcs8", format: "pem" }).toString(); }
function publicKeyPem(key) { return key?.export({ type: "spki", format: "pem" }).toString(); }

function vaultIdentityRecord(identity) {
  if (!identity?.privateKey || !identity?.encryptionPrivateKey) throw new Error("A complete manufacturing identity is required");
  return {
    serial: identity.serial,
    signingPrivateKey: privateKeyPem(identity.privateKey),
    signingPublicKey: publicKeyPem(identity.publicKey),
    encryptionPrivateKey: privateKeyPem(identity.encryptionPrivateKey),
    encryptionPublicKey: publicKeyPem(identity.encryptionPublicKey),
    publicKeyFingerprint: identity.publicKeyFingerprint,
    encryptionKeyFingerprint: identity.encryptionKeyFingerprint,
  };
}

function signPairingEnvelope(identity, payload) {
  if (!identity?.privateKey) throw new Error("Manufacturing private key is not loaded");
  const body = { v: 1, serial: identity.serial, ...payload };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return { body, encoded, signature: crypto.sign(null, Buffer.from(encoded), identity.privateKey).toString("base64url") };
}

function verifyPairingEnvelope({ body, encoded, signature, publicKey } = {}) {
  if (!body || !encoded || !signature || !publicKey) return false;
  if (Buffer.from(JSON.stringify(body), "utf8").toString("base64url") !== encoded) return false;
  try { return crypto.verify(null, Buffer.from(encoded), publicKey, Buffer.from(signature, "base64url")); } catch { return false; }
}

module.exports = { generateManufacturingIdentity, stableManufacturingIdentityPayload, createPlatformPairingEnvelope, vaultIdentityRecord, signPairingEnvelope, verifyPairingEnvelope };
