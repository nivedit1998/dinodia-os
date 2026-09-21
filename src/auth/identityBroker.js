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
      ? ["version", "serial", "identityGeneration", "attemptId", "publicKeyPem", "encryptionPublicKeyPem", "publicKeyFingerprint", "baseUrl", "issuedAt", "expiresAt"]
      : ["serial", "cloudUrl", "challenge", "identityFingerprint", "identityGeneration"];
    if (required.some((key) => input.payload[key] === undefined || input.payload[key] === null)) throw new Error("identity broker payload is incomplete");
    if (JSON.stringify(input.payload).length > 32 * 1024) throw new Error("identity broker payload is too large");
    return;
  }
  if (operation === "signPlatformRequest") {
    if (Object.keys(input).length > 12 || typeof input.method !== "string" || typeof input.path !== "string" || typeof input.nonce !== "string" || typeof input.bodyHash !== "string") throw new Error("platform signing input is invalid");
    return;
  }
  if (operation === "decryptMachineCredentialEnvelope") {
    const envelope = input.envelope;
    if (input.purpose !== "machine-credential" || !envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.algorithm !== "x25519-hkdf-sha256/aes-256-gcm" || input.version === undefined) throw new Error("credential envelope is not allowed");
    if (JSON.stringify(envelope).length > 32 * 1024) throw new Error("credential envelope is too large");
  }
}

function canonicalCloudChallenge(input) {
  return JSON.stringify({ version: 1, serial: String(input.serial), cloudUrl: String(input.cloudUrl), challenge: String(input.challenge), identityFingerprint: String(input.identityFingerprint), identityGeneration: Number(input.identityGeneration) });
}

function canonicalProvisioning(input) {
  return JSON.stringify({ version: input.version, serial: input.serial, identityGeneration: input.identityGeneration, attemptId: input.attemptId, publicKeyPem: input.publicKeyPem, encryptionPublicKeyPem: input.encryptionPublicKeyPem, publicKeyFingerprint: input.publicKeyFingerprint, baseUrl: input.baseUrl, issuedAt: input.issuedAt, expiresAt: input.expiresAt });
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

async function initializeIdentity({ directory = "/etc/dinodia-os/identity", serial, generation = 1, manufacturingSignature = "" } = {}) {
  if (process.getuid?.() !== 0) throw new Error("identity initialization requires root");
  const normalizedSerial = String(serial || "").trim(); if (!normalizedSerial) throw new Error("serial is required");
  try {
    const previous = JSON.parse(await fsPromises.readFile(path.join(directory, "identity.json"), "utf8"));
    if (previous?.serial === normalizedSerial && Number.isInteger(Number(previous.generation))) generation = Math.max(Number(generation), Number(previous.generation) + 1);
  } catch {}
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  const signingPublicKeyPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  const encryptionPublicKeyPem = encryption.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signingPrivateKeyPem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const encryptionPrivateKeyPem = encryption.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signingPublicKey = crypto.createPublicKey(signingPublicKeyPem);
  const encryptionPublicKey = crypto.createPublicKey(encryptionPublicKeyPem);
  const publicKeyFingerprint = crypto.createHash("sha256").update(signingPublicKey.export({ type: "spki", format: "der" })).digest("hex");
  const encryptionKeyFingerprint = crypto.createHash("sha256").update(encryptionPublicKey.export({ type: "spki", format: "der" })).digest("hex");
  const wrappingKey = crypto.randomBytes(32);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700); await fsPromises.chown(directory, 0, 0);
  await atomicWrite(path.join(directory, "identity.key"), wrappingKey, 0o600);
  await atomicWrite(path.join(directory, "signing-private.enc"), encryptPrivateKey(signingPrivateKeyPem, wrappingKey, { serial: normalizedSerial, purpose: "signing", generation }), 0o600);
  await atomicWrite(path.join(directory, "encryption-private.enc"), encryptPrivateKey(encryptionPrivateKeyPem, wrappingKey, { serial: normalizedSerial, purpose: "encryption", generation }), 0o600);
  await atomicWrite(path.join(directory, "identity.json"), JSON.stringify({ version: 1, serial: normalizedSerial, generation, signingPublicKeyPem, encryptionPublicKeyPem, publicKeyFingerprint, encryptionKeyFingerprint, manufacturingSignature: String(manufacturingSignature || "") }, null, 2), 0o644);
  return { serial: normalizedSerial, generation, signingPublicKeyPem, encryptionPublicKeyPem, publicKeyFingerprint, encryptionKeyFingerprint };
}

function loadIdentity(directory = "/etc/dinodia-os/identity") {
  assertSecurePath(directory, 0o700);
  const identity = JSON.parse(fs.readFileSync(path.join(directory, "identity.json"), "utf8"));
  assertSecurePath(path.join(directory, "identity.key"), 0o600);
  assertSecurePath(path.join(directory, "signing-private.enc"), 0o600);
  assertSecurePath(path.join(directory, "encryption-private.enc"), 0o600);
  if (!identity.serial || !Number.isInteger(identity.generation) || !identity.signingPublicKeyPem || !identity.encryptionPublicKeyPem) throw new Error("identity metadata is incomplete");
  const wrappingKey = fs.readFileSync(path.join(directory, "identity.key")); if (wrappingKey.length !== 32) throw new Error("identity wrapping key is invalid");
  const signingPrivateKey = crypto.createPrivateKey(decryptPrivateKey(fs.readFileSync(path.join(directory, "signing-private.enc"), "utf8"), wrappingKey, { serial: identity.serial, purpose: "signing", generation: identity.generation }));
  const encryptionPrivateKey = crypto.createPrivateKey(decryptPrivateKey(fs.readFileSync(path.join(directory, "encryption-private.enc"), "utf8"), wrappingKey, { serial: identity.serial, purpose: "encryption", generation: identity.generation }));
  return { ...identity, signingPrivateKey, encryptionPrivateKey, signingPublicKey: crypto.createPublicKey(identity.signingPublicKeyPem), encryptionPublicKey: crypto.createPublicKey(identity.encryptionPublicKeyPem) };
}

function brokerResult(operation, input, identity) {
  if (operation === "getPublicIdentity") return { serial: identity.serial, generation: identity.generation, signingPublicKeyPem: identity.signingPublicKeyPem, encryptionPublicKeyPem: identity.encryptionPublicKeyPem, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint, manufacturingSignature: identity.manufacturingSignature || "" };
  if (operation === "getIdentityStatus") return { serial: identity.serial, generation: identity.generation, healthy: true, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint };
  if (operation === "signProvisioningEnvelope") return { signature: crypto.sign(null, Buffer.from(canonicalProvisioning(input.payload), "utf8"), identity.signingPrivateKey).toString("base64url") };
  if (operation === "signPlatformRequest") return { signature: crypto.sign(null, Buffer.from(canonicalPlatformRequest(input), "utf8"), identity.signingPrivateKey).toString("base64url") };
  if (operation === "signCloudChallenge") return { signature: crypto.sign(null, Buffer.from(canonicalCloudChallenge(input.payload), "utf8"), identity.signingPrivateKey).toString("base64url") };
  if (operation === "decryptMachineCredentialEnvelope") {
    const envelope = input.envelope; if (!envelope || envelope.algorithm !== "x25519-hkdf-sha256/aes-256-gcm" || input.purpose !== "machine-credential") throw new Error("credential envelope is not allowed");
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

module.exports = { IdentityBrokerClient, initializeIdentity, loadIdentity, createIdentityBrokerServer, canonicalCloudChallenge, canonicalProvisioning, canonicalPlatformRequest, encryptPrivateKey, decryptPrivateKey };
