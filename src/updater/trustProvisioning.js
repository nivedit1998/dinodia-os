"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const INSTALLED_SERVICE_PATH = "/usr/lib/dinodia-os-updater/current/src/updater/service.js";
const POLICY_VALIDATOR_PATH = fs.existsSync(INSTALLED_SERVICE_PATH) ? INSTALLED_SERVICE_PATH : "./service";
const { loadRootPolicy } = require(POLICY_VALIDATOR_PATH);

const POLICY_PATH = "/etc/dinodia-os/updater-policy.json";
const BACKUP_ROOT = "/var/lib/dinodia-os-updater/trust-backups";
const FIELDS = new Set([
  "enabled", "approvedChannel", "targetArch", "apiVersion", "storeSchemaVersion",
  "signingKeyId", "releaseSigningPublicKey", "allowedArtifactHosts",
  "maxManifestLifetimeMs", "downloadTimeoutMs", "minimumFreeBytes",
]);

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function readRegularFile(filePath, expectedOwnerUid) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedOwnerUid || (before.mode & 0o022) !== 0) {
    throw new Error("policy input must be an owned, non-writable regular file");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== expectedOwnerUid) {
      throw new Error("policy input changed while it was being opened");
    }
    const chunks = [];
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 32 * 1024) throw new Error("policy input exceeds its size limit");
    }
    return Buffer.concat(chunks);
  } finally { fs.closeSync(fd); }
}

function validatePolicyFile(filePath, { ownerUid = 0 } = {}) {
  const bytes = readRegularFile(filePath, ownerUid);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("policy input is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== FIELDS.size || Object.keys(value).some((key) => !FIELDS.has(key))) {
    throw new Error("policy input must contain the complete bounded trust tuple");
  }
  if (typeof value.releaseSigningPublicKey !== "string"
      || !/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/.test(value.releaseSigningPublicKey)
      || value.releaseSigningPublicKey.includes("PRIVATE KEY")) {
    throw new Error("policy must contain only an Ed25519 public key");
  }

  const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-updater-trust-check-"));
  const staged = path.join(validationDir, "policy.json");
  try {
    fs.writeFileSync(staged, bytes, { mode: 0o600, flag: "wx" });
    if (typeof process.getuid === "function" && process.getuid() === 0) fs.chownSync(staged, 0, 0);
    const checked = loadRootPolicy(staged, { expectedOwnerUid: ownerUid });
    if (checked.enabled !== true) throw new Error("policy trust tuple failed the updater's own validation");
    const publicKey = crypto.createPublicKey(value.releaseSigningPublicKey);
    const fingerprint = `SHA256:${crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64").replace(/=+$/, "")}`;
    return {
      bytes,
      sha256: sha256(bytes),
      fingerprint,
      signingKeyId: value.signingKeyId,
      channel: value.approvedChannel,
      allowedArtifactHosts: [...value.allowedArtifactHosts],
      policy: checked,
    };
  } finally { fs.rmSync(validationDir, { recursive: true, force: true }); }
}

function ensureProtectedDirectory(directory, ownerUid) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || (stat.mode & 0o077) !== 0) {
    throw new Error("trust backup directory must be protected and owner-controlled");
  }
}

function atomicWrite(target, bytes, ownerUid, ownerGid) {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.fchownSync(fd, ownerUid, ownerGid);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

async function provisionTrustedUpdaterPolicy({
  candidatePath,
  policyPath = POLICY_PATH,
  backupRoot = BACKUP_ROOT,
  approvedSha256,
  ownerUid = 0,
  ownerGid = process.getgid?.() ?? 0,
  restartAndVerify,
}) {
  if (typeof restartAndVerify !== "function") throw new TypeError("a bounded updater restart/status verifier is required");
  const parentPath = path.dirname(policyPath);
  const parent = fs.lstatSync(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== ownerUid || (parent.mode & 0o022) !== 0) {
    throw new Error("updater policy parent is not protected");
  }
  const validated = validatePolicyFile(candidatePath, { ownerUid });
  if (!/^[a-f0-9]{64}$/.test(approvedSha256 || "") || validated.sha256 !== approvedSha256) {
    throw new Error("approved policy SHA-256 does not match the candidate");
  }

  ensureProtectedDirectory(backupRoot, ownerUid);
  const oldExists = fs.existsSync(policyPath);
  const oldStat = oldExists ? fs.lstatSync(policyPath) : null;
  if (oldExists && (!oldStat.isFile() || oldStat.isSymbolicLink() || oldStat.uid !== ownerUid || (oldStat.mode & 0o077) !== 0)) {
    throw new Error("existing updater policy is not a protected regular file");
  }
  const oldBytes = oldExists ? fs.readFileSync(policyPath) : null;
  const oldSha = oldBytes ? sha256(oldBytes) : "absent";
  const backupPath = path.join(backupRoot, `updater-policy.${new Date().toISOString().replace(/[:.]/g, "-")}.${oldSha}.json`);
  if (oldBytes) {
    const backupFd = fs.openSync(backupPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.fchownSync(backupFd, ownerUid, ownerGid); fs.writeFileSync(backupFd, oldBytes); fs.fsyncSync(backupFd); }
    finally { fs.closeSync(backupFd); }
    const backupDirFd = fs.openSync(backupRoot, fs.constants.O_RDONLY);
    try { fs.fsyncSync(backupDirFd); } finally { fs.closeSync(backupDirFd); }
  }

  atomicWrite(policyPath, validated.bytes, ownerUid, ownerGid);
  try {
    const status = await restartAndVerify();
    if (!status || status.trustState !== "ready") throw new Error("updater did not confirm the approved trust state");
  } catch (error) {
    if (oldBytes) atomicWrite(policyPath, oldBytes, ownerUid, ownerGid);
    else fs.rmSync(policyPath, { force: true });
    try { await restartAndVerify(); } catch { /* Preserve the original failure; caller must inspect status locally. */ }
    throw new Error("updater trust provisioning failed and the previous policy was restored");
  }
  return {
    policyPath,
    backupPath: oldBytes ? backupPath : null,
    policySha256: validated.sha256,
    publicKeyFingerprint: validated.fingerprint,
    signingKeyId: validated.signingKeyId,
    channel: validated.channel,
    allowedArtifactHosts: validated.allowedArtifactHosts,
  };
}

module.exports = { validatePolicyFile, provisionTrustedUpdaterPolicy };
