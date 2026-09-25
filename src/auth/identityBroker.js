const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");

const MAX_MESSAGE_BYTES = 64 * 1024;
const ALLOWED = new Set([
  "getPublicIdentity",
  "getIdentityStatus",
  "signProvisioningEnvelope",
  "signPlatformRequest",
  "signCloudChallenge",
  "decryptMachineCredentialEnvelope",
]);

function assertBrokerInput(operation, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("identity broker input is invalid");
  if (operation === "getPublicIdentity" || operation === "getIdentityStatus") {
    if (Object.keys(input).length !== 0) throw new Error("identity broker input is invalid");
    return;
  }
  if (operation === "signProvisioningEnvelope" || operation === "signCloudChallenge") {
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("identity broker payload is invalid");
    const required = operation === "signProvisioningEnvelope"
      ? ["version", "serial", "identityGeneration", "attemptId", "publicKeyPem", "encryptionPublicKeyPem", "publicKeyFingerprint", "encryptionKeyFingerprint", "baseUrl", "issuedAt", "expiresAt"]
      : ["version", "serial", "cloudUrl", "challenge", "tunnelId", "tunnelName", "timestamp", "bodyHash", "identityFingerprint", "identityGeneration"];
    if (required.some((key) => input.payload[key] === undefined || input.payload[key] === null)) throw new Error("identity broker payload is incomplete");
    if (operation === "signCloudChallenge") {
      const keys = Object.keys(input.payload);
      if (keys.length !== required.length || required.some((key) => !keys.includes(key))) throw new Error("identity broker CloudURL fields are invalid");
      if (input.payload.version !== 1 || typeof input.payload.timestamp !== "number" || !Number.isSafeInteger(input.payload.timestamp) || typeof input.payload.identityGeneration !== "number" || !Number.isInteger(input.payload.identityGeneration) || input.payload.identityGeneration < 1) throw new Error("identity broker CloudURL fields are invalid");
      for (const key of ["serial", "cloudUrl", "challenge", "tunnelId", "tunnelName", "identityFingerprint", "bodyHash"]) {
        if (typeof input.payload[key] !== "string" || !input.payload[key].trim()) throw new Error("identity broker CloudURL fields are invalid");
      }
      if (!/^[a-f0-9]{64}$/i.test(input.payload.bodyHash)) throw new Error("identity broker CloudURL body hash is invalid");
    }
    if (JSON.stringify(input.payload).length > 32 * 1024) throw new Error("identity broker payload is too large");
    return;
  }
  if (operation === "signPlatformRequest") {
    if (Object.keys(input).length > 12 || typeof input.method !== "string" || typeof input.path !== "string" || typeof input.nonce !== "string" || typeof input.bodyHash !== "string") throw new Error("platform signing input is invalid");
    return;
  }
  if (operation === "decryptMachineCredentialEnvelope") {
    const envelope = input.envelope;
    // This operation is deliberately limited to the two fixed hub-delivery
    // envelopes. It is not an arbitrary decryptor: no caller-selected key,
    // file, algorithm or purpose is accepted.
    if (!new Set(["machine-credential", "operator-session", "operator-handoff", "support-session"]).has(String(input.purpose)) || !envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.algorithm !== "x25519-hkdf-sha256/aes-256-gcm" || input.version === undefined) throw new Error("credential envelope is not allowed");
    if (JSON.stringify(envelope).length > 32 * 1024) throw new Error("credential envelope is too large");
  }
}

function canonicalCloudChallenge(input) {
  return JSON.stringify({ version: 1, serial: String(input.serial), cloudUrl: String(input.cloudUrl), challenge: String(input.challenge), tunnelId: String(input.tunnelId), tunnelName: String(input.tunnelName), timestamp: Number(input.timestamp), bodyHash: String(input.bodyHash), identityFingerprint: String(input.identityFingerprint), identityGeneration: Number(input.identityGeneration) });
}

function canonicalCloudChallengeUnsigned(input) {
  return JSON.stringify({ version: 1, serial: String(input.serial), cloudUrl: String(input.cloudUrl), challenge: String(input.challenge), tunnelId: String(input.tunnelId), tunnelName: String(input.tunnelName), timestamp: Number(input.timestamp), identityFingerprint: String(input.identityFingerprint), identityGeneration: Number(input.identityGeneration) });
}

function canonicalProvisioning(input) {
  return JSON.stringify({ version: input.version, serial: input.serial, identityGeneration: input.identityGeneration, attemptId: input.attemptId, publicKeyPem: input.publicKeyPem, encryptionPublicKeyPem: input.encryptionPublicKeyPem, publicKeyFingerprint: input.publicKeyFingerprint, encryptionKeyFingerprint: input.encryptionKeyFingerprint, baseUrl: input.baseUrl, issuedAt: input.issuedAt, expiresAt: input.expiresAt });
}

function canonicalPlatformRequest(input) {
  const method = String(input.method || '').trim().toUpperCase();
  const requestPath = String(input.path || '').trim();
  const timestamp = Number(input.timestamp);
  const nonce = String(input.nonce || '').trim();
  const bodyHash = String(input.bodyHash || '').trim().toLowerCase();
  if (!/^[A-Z]+$/.test(method) || !requestPath.startsWith('/') || requestPath.includes("\n") || !Number.isSafeInteger(timestamp) || !nonce || !/^[a-f0-9]{32,128}$/.test(bodyHash)) throw new Error('platform request signing fields are invalid');
  return [method, requestPath, String(timestamp), nonce, bodyHash].join("\n");
}

// This is the only certificate body signed by the offline manufacturing
// authority.  It intentionally excludes attempt, URL and expiry fields; those
// are transient hub-signed provisioning fields and must never change the
// manufacturing certificate bytes.
function stableManufacturingIdentityPayload(input = {}) {
  return JSON.stringify({
    serial: String(input.serial || ""),
    identityGeneration: Number(input.identityGeneration ?? input.generation ?? 1),
    publicKeyPem: String(input.publicKeyPem || input.signingPublicKeyPem || ""),
    encryptionPublicKeyPem: String(input.encryptionPublicKeyPem || ""),
    publicKeyFingerprint: String(input.publicKeyFingerprint || ""),
    encryptionKeyFingerprint: String(input.encryptionKeyFingerprint || ""),
  });
}

function readJsonLine(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("identity broker timeout")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) { clearTimeout(timer); socket.destroy(); reject(new Error("identity broker response too large")); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch { reject(new Error("identity broker returned invalid JSON")); }
      socket.destroy();
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { if (buffer && !buffer.includes("\n")) { clearTimeout(timer); reject(new Error("identity broker closed early")); } });
  });
}

class IdentityBrokerClient {
  constructor({ socketPath = "/run/dinodia-identityd.sock", timeoutMs = 3000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(operation, input = {}) {
    if (!ALLOWED.has(operation)) throw new Error("identity broker operation is not allowed");
    const socket = net.createConnection(this.socketPath);
    const response = readJsonLine(socket, this.timeoutMs);
    socket.on("connect", () => {
      const message = JSON.stringify({ version: 1, id: crypto.randomUUID(), operation, input });
      if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) { socket.destroy(new Error("identity broker request too large")); return; }
      socket.end(`${message}\n`);
    });
    const result = await response;
    if (!result || result.ok !== true) throw new Error(String(result?.error || "identity broker rejected request"));
    return result.result;
  }

  getPublicIdentity() { return this.request("getPublicIdentity"); }
  getIdentityStatus() { return this.request("getIdentityStatus"); }
  signProvisioningEnvelope(input) { return this.request("signProvisioningEnvelope", input); }
  signPlatformRequest(input) { return this.request("signPlatformRequest", input); }
  signCloudChallenge(input) { return this.request("signCloudChallenge", input); }
  decryptMachineCredentialEnvelope(input) { return this.request("decryptMachineCredentialEnvelope", input); }
}

function deriveFileKey(wrappingKey, serial, purpose, generation) {
  return crypto.hkdfSync("sha256", wrappingKey, Buffer.from(`${serial}:${purpose}:${generation}`), Buffer.from("dinodia-os-identity-v1"), 32);
}

function encryptPrivateKey(privateKeyPem, wrappingKey, { serial, purpose, generation }) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`${serial}:${purpose}:${generation}`, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveFileKey(wrappingKey, serial, purpose, generation), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: "aes-256-gcm", serial, purpose, generation, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

function decryptPrivateKey(raw, wrappingKey, { serial, purpose, generation }) {
  const value = JSON.parse(raw);
  if (value.version !== 1 || value.algorithm !== "aes-256-gcm" || value.serial !== serial || value.purpose !== purpose || Number(value.generation) !== Number(generation)) throw new Error("identity blob context mismatch");
  const aad = Buffer.from(`${serial}:${purpose}:${generation}`, "utf8");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveFileKey(wrappingKey, serial, purpose, generation), Buffer.from(value.iv, "base64"));
  decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function assertSecurePath(target, expectedMode) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("identity symlink is forbidden");
  if (stat.uid !== 0 || (stat.mode & 0o777) !== expectedMode) throw new Error("identity ownership or mode is insecure");
}

async function atomicWrite(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fsPromises.open(temp, "wx", mode);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await fsPromises.chmod(temp, mode); await fsPromises.chown(temp, 0, 0); await fsPromises.rename(temp, filePath);
  const dirHandle = await fsPromises.open(directory, "r"); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}

async function nextIdentityGeneration(directory, serial, requestedGeneration) {
  let generation = Number(requestedGeneration) || 1;
  for (const filename of ["identity.json", "identity.pending.json"]) {
    try {
      const previous = JSON.parse(await fsPromises.readFile(path.join(directory, filename), "utf8"));
      if (previous?.serial === serial && Number.isInteger(Number(previous.generation))) generation = Math.max(generation, Number(previous.generation) + 1);
    } catch {}
  }
  return generation;
}

function publicIdentityMaterial({ serial, generation, signingPublicKeyPem, encryptionPublicKeyPem, publicKeyFingerprint, encryptionKeyFingerprint }) {
  return { version: 1, serial, generation, signingPublicKeyPem, encryptionPublicKeyPem, publicKeyFingerprint, encryptionKeyFingerprint };
}

async function prepareIdentity({ directory = "/etc/dinodia-os/identity", serial, generation = 1 } = {}) {
  if (process.getuid?.() !== 0) throw new Error("identity preparation requires root");
  const normalizedSerial = String(serial || "").trim();
  if (!normalizedSerial) throw new Error("serial is required");
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  await fsPromises.chown(directory, 0, 0);

  // A resumable preparation returns the same public material instead of
  // replacing a still-unissued local key pair.
  try {
    const pending = JSON.parse(await fsPromises.readFile(path.join(directory, "identity.pending.json"), "utf8"));
    assertSecurePath(path.join(directory, "identity.pending.json"), 0o644);
    assertSecurePath(path.join(directory, "identity.key"), 0o600);
    assertSecurePath(path.join(directory, "signing-private.enc"), 0o600);
    assertSecurePath(path.join(directory, "encryption-private.enc"), 0o600);
    if (pending.serial === normalizedSerial) return { ...pending, certificatePayload: stableManufacturingIdentityPayload(pending) };
  } catch {}

  const identityGeneration = await nextIdentityGeneration(directory, normalizedSerial, generation);
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  const signingPublicKeyPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  const encryptionPublicKeyPem = encryption.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signingPublicKey = crypto.createPublicKey(signingPublicKeyPem);
  const encryptionPublicKey = crypto.createPublicKey(encryptionPublicKeyPem);
  const publicKeyFingerprint = crypto.createHash("sha256").update(signingPublicKey.export({ type: "spki", format: "der" })).digest("hex");
  const encryptionKeyFingerprint = crypto.createHash("sha256").update(encryptionPublicKey.export({ type: "spki", format: "der" })).digest("hex");
  const wrappingKey = crypto.randomBytes(32);
  const pending = publicIdentityMaterial({ serial: normalizedSerial, generation: identityGeneration, signingPublicKeyPem, encryptionPublicKeyPem, publicKeyFingerprint, encryptionKeyFingerprint });
  await atomicWrite(path.join(directory, "identity.key"), wrappingKey, 0o600);
  await atomicWrite(path.join(directory, "signing-private.enc"), encryptPrivateKey(signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), wrappingKey, { serial: normalizedSerial, purpose: "signing", generation: identityGeneration }), 0o600);
  await atomicWrite(path.join(directory, "encryption-private.enc"), encryptPrivateKey(encryption.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), wrappingKey, { serial: normalizedSerial, purpose: "encryption", generation: identityGeneration }), 0o600);
  await atomicWrite(path.join(directory, "identity.pending.json"), JSON.stringify(pending, null, 2), 0o644);
  return { ...pending, certificatePayload: stableManufacturingIdentityPayload(pending) };
}

function parseManufacturingRootKeys(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || "").replaceAll("\\n", "\n").match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) || [];
}

async function finalizeIdentity({ directory = "/etc/dinodia-os/identity", manufacturingSignature = "", manufacturingRootPublicKeys = [] } = {}) {
  if (process.getuid?.() !== 0) throw new Error("identity finalization requires root");
  const signatureText = String(manufacturingSignature || "").trim();
  if (!signatureText) throw new Error("a manufacturing-root identity certificate is required");
  const pendingPath = path.join(directory, "identity.pending.json");
  assertSecurePath(directory, 0o700);
  assertSecurePath(pendingPath, 0o644);
  const pending = JSON.parse(await fsPromises.readFile(pendingPath, "utf8"));
  const roots = parseManufacturingRootKeys(manufacturingRootPublicKeys);
  if (!roots.length) throw new Error("manufacturing-root public key is required");
  const signature = Buffer.from(signatureText, "base64url");
  const certificate = stableManufacturingIdentityPayload(pending);
  const trusted = roots.some((pem) => {
    try { return crypto.verify(null, Buffer.from(certificate, "utf8"), crypto.createPublicKey(pem), signature); } catch { return false; }
  });
  if (!trusted) throw new Error("manufacturing-root identity certificate rejected");
  assertSecurePath(path.join(directory, "identity.key"), 0o600);
  assertSecurePath(path.join(directory, "signing-private.enc"), 0o600);
  assertSecurePath(path.join(directory, "encryption-private.enc"), 0o600);
  await atomicWrite(path.join(directory, "identity.json"), JSON.stringify({ ...pending, manufacturingSignature: signatureText }, null, 2), 0o644);
  await fsPromises.unlink(pendingPath);
  const dirHandle = await fsPromises.open(directory, "r"); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  return loadIdentity(directory);
}

async function initializeIdentity({ directory = "/etc/dinodia-os/identity", serial, generation = 1, manufacturingSignature = "" } = {}) {
  await prepareIdentity({ directory, serial, generation });
  return finalizeIdentity({ directory, manufacturingSignature, manufacturingRootPublicKeys: process.env.DINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS });
}

function loadIdentity(directory = "/etc/dinodia-os/identity") {
  assertSecurePath(directory, 0o700);
  const metadataPath = path.join(directory, "identity.json");
  assertSecurePath(metadataPath, 0o644);
  const identity = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assertSecurePath(path.join(directory, "identity.key"), 0o600);
  assertSecurePath(path.join(directory, "signing-private.enc"), 0o600);
  assertSecurePath(path.join(directory, "encryption-private.enc"), 0o600);
  if (!identity.serial || !Number.isInteger(identity.generation) || !identity.signingPublicKeyPem || !identity.encryptionPublicKeyPem || !String(identity.manufacturingSignature || "").trim()) throw new Error("identity metadata is incomplete");
  const signingPublicKey = crypto.createPublicKey(identity.signingPublicKeyPem);
  const encryptionPublicKey = crypto.createPublicKey(identity.encryptionPublicKeyPem);
  if (signingPublicKey.asymmetricKeyType !== "ed25519" || encryptionPublicKey.asymmetricKeyType !== "x25519") throw new Error("identity key types are invalid");
  const wrappingKey = fs.readFileSync(path.join(directory, "identity.key")); if (wrappingKey.length !== 32) throw new Error("identity wrapping key is invalid");
  const signingPrivateKey = crypto.createPrivateKey(decryptPrivateKey(fs.readFileSync(path.join(directory, "signing-private.enc"), "utf8"), wrappingKey, { serial: identity.serial, purpose: "signing", generation: identity.generation }));
  const encryptionPrivateKey = crypto.createPrivateKey(decryptPrivateKey(fs.readFileSync(path.join(directory, "encryption-private.enc"), "utf8"), wrappingKey, { serial: identity.serial, purpose: "encryption", generation: identity.generation }));
  return { ...identity, signingPrivateKey, encryptionPrivateKey, signingPublicKey, encryptionPublicKey };
}

function brokerResult(operation, input, identity) {
  if (operation === "getPublicIdentity") return { serial: identity.serial, generation: identity.generation, signingPublicKeyPem: identity.signingPublicKeyPem, encryptionPublicKeyPem: identity.encryptionPublicKeyPem, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint, manufacturingSignature: identity.manufacturingSignature || "" };
  if (operation === "getIdentityStatus") return { serial: identity.serial, generation: identity.generation, healthy: true, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint };
  if (operation === "signProvisioningEnvelope") return { signature: crypto.sign(null, Buffer.from(canonicalProvisioning(input.payload), "utf8"), identity.signingPrivateKey).toString("base64url") };
  if (operation === "signPlatformRequest") return { signature: crypto.sign(null, Buffer.from(canonicalPlatformRequest(input), "utf8"), identity.signingPrivateKey).toString("base64url") };
  if (operation === "signCloudChallenge") return { signature: crypto.sign(null, Buffer.from(canonicalCloudChallenge(input.payload), "utf8"), identity.signingPrivateKey).toString("base64url") };
  if (operation === "decryptMachineCredentialEnvelope") {
    const envelope = input.envelope; if (!envelope || envelope.algorithm !== "x25519-hkdf-sha256/aes-256-gcm" || !new Set(["machine-credential", "operator-session", "operator-handoff", "support-session"]).has(String(input.purpose))) throw new Error("credential envelope is not allowed");
    const sender = crypto.createPublicKey(String(envelope.ephemeralPublicKeyPem || "")); if (sender.asymmetricKeyType !== "x25519") throw new Error("credential sender key is invalid");
    const shared = crypto.diffieHellman({ privateKey: identity.encryptionPrivateKey, publicKey: sender });
    const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(`dinodia-os-${input.purpose}`), Buffer.from(String(input.version)), 32));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(envelope.iv), "base64")); decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
    return { credential: Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), "base64")), decipher.final()]).toString("utf8") };
  }
  throw new Error("identity operation is not implemented");
}

function createIdentityBrokerServer({ socketPath = "/run/dinodia-identityd.sock", directory = "/etc/dinodia-os/identity", allowedGid = null, logger = console } = {}) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
      const end = buffer.indexOf("\n"); if (end < 0) return;
      let request; try { request = JSON.parse(buffer.slice(0, end)); } catch { socket.end(JSON.stringify({ ok: false, error: "invalid request" }) + "\n"); return; }
      if (request?.version !== 1 || typeof request.id !== "string" || request.id.length > 128 || !ALLOWED.has(request.operation)) { socket.end(JSON.stringify({ ok: false, error: "identity broker request is not authorised" }) + "\n"); return; }
      const peer = socket.getPeerCredentials?.();
      // The Unix socket mode/group is the primary caller boundary. Node does
      // not expose SO_PEERCRED on every supported Pi runtime; when it does,
      // enforce it as an additional check, never as a weaker fallback.
      const peerGid = Number(peer?.gid);
      if (peer && Number(peer.uid) !== 0 && (!Number.isInteger(Number(allowedGid)) || peerGid !== Number(allowedGid))) { socket.end(JSON.stringify({ ok: false, error: "identity broker caller is not authorised" }) + "\n"); return; }
      try { assertBrokerInput(request.operation, request.input || {}); const identity = loadIdentity(directory); const result = brokerResult(request.operation, request.input || {}, identity); socket.end(JSON.stringify({ ok: true, result }) + "\n"); } catch (error) { logger.warn(`[identityd] ${error.message}`); socket.end(JSON.stringify({ ok: false, error: "identity operation rejected" }) + "\n"); }
    });
  });
  server.on("listening", () => { try { fs.chmodSync(socketPath, 0o660); fs.chownSync(socketPath, 0, Number(allowedGid) || 0); } catch {} });
  return server;
}

module.exports = { IdentityBrokerClient, initializeIdentity, prepareIdentity, finalizeIdentity, loadIdentity, createIdentityBrokerServer, canonicalCloudChallenge, canonicalCloudChallengeUnsigned, canonicalProvisioning, canonicalPlatformRequest, stableManufacturingIdentityPayload, encryptPrivateKey, decryptPrivateKey };
