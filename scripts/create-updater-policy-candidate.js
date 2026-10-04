"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { NATIVE_AUTOMATION_STORE_VERSION } = require("../src/automations/constants");
const { validatePolicyFile } = require("../src/updater/trustProvisioning");

const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function parseArgs(argv) {
  const values = new Map();
  const hosts = [];
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("invalid arguments");
    if (name === "--artifact-host") hosts.push(value);
    else {
      if (values.has(name)) throw new Error("invalid arguments");
      values.set(name, value);
    }
  }
  if (values.size !== 3 || !values.has("--public-key") || !values.has("--key-id") || !values.has("--output")
      || hosts.length === 0 || hosts.length > 8) {
    throw new Error("usage: create-updater-policy-candidate.js --public-key FILE --key-id ID --artifact-host HOST [--artifact-host HOST...] --output FILE");
  }
  return { publicKeyPath: values.get("--public-key"), keyId: values.get("--key-id"), hosts, outputPath: values.get("--output") };
}

function readPublicKey(filePath, ownerUid) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || (before.mode & 0o022) !== 0 || before.size > 16 * 1024) {
    throw new Error("public-key input must be an owned, bounded, non-writable regular file");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== ownerUid) {
      throw new Error("public-key input changed while it was being opened");
    }
    const chunks = [];
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 16 * 1024) throw new Error("public-key input exceeds its size limit");
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.includes("PRIVATE KEY")) throw new Error("private signing material is not accepted");
    const key = crypto.createPublicKey(text);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("release trust requires Ed25519 public key material");
    return key.export({ type: "spki", format: "pem" }).toString();
  } finally { fs.closeSync(fd); }
}

function createCandidate({ publicKeyPath, keyId, hosts, outputPath }, { ownerUid = process.getuid?.() ?? fs.statSync(publicKeyPath).uid } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) throw new Error("key ID is invalid");
  if (new Set(hosts).size !== hosts.length || hosts.some((host) => host !== host.toLowerCase() || !HOST_PATTERN.test(host))) {
    throw new Error("artifact host list must contain unique exact lowercase DNS hostnames");
  }
  const parentPath = path.dirname(outputPath);
  const parent = fs.lstatSync(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== ownerUid || (parent.mode & 0o022) !== 0) {
    throw new Error("candidate directory must be owner-controlled and non-writable by others");
  }
  const publicKey = readPublicKey(publicKeyPath, ownerUid);
  const policy = {
    enabled: true,
    approvedChannel: "stable",
    targetArch: "aarch64",
    apiVersion: 2,
    storeSchemaVersion: NATIVE_AUTOMATION_STORE_VERSION,
    signingKeyId: keyId,
    releaseSigningPublicKey: publicKey,
    allowedArtifactHosts: hosts,
    maxManifestLifetimeMs: 7 * 24 * 60 * 60 * 1000,
    downloadTimeoutMs: 60_000,
    minimumFreeBytes: 64 * 1024 * 1024,
  };
  const bytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  const fd = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    try {
      if (process.getuid?.() === 0) fs.fchownSync(fd, ownerUid, process.getgid?.() ?? fs.fstatSync(fd).gid);
      else if (fs.fstatSync(fd).uid !== ownerUid) throw new Error("candidate owner identity does not match the approved local owner");
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const dirFd = fs.openSync(parentPath, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
  try {
    const validated = validatePolicyFile(outputPath, { ownerUid });
    return {
      candidatePath: outputPath,
      policySha256: validated.sha256,
      publicKeyFingerprint: validated.fingerprint,
      signingKeyId: validated.signingKeyId,
      channel: validated.channel,
      storeSchemaVersion: validated.policy.storeSchemaVersion,
      allowedArtifactHosts: validated.allowedArtifactHosts,
    };
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  const result = createCandidate(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`Updater public policy candidate stopped safely: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, createCandidate };
