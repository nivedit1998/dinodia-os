const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function loadOrCreateKey(keyFile) {
  try {
    const key = fs.readFileSync(keyFile);
    if (key.length === 32) return key;
  } catch {
    // The normal service creates this key on first boot; the CLI backup path
    // also creates it so a backup can be made before the service starts.
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  return key;
}

function encryptBackup(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("dinodia-backup-v1"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptBackup(envelope, key) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported backup format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from("dinodia-backup-v1"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

async function createBackup({ dataFile, backupDir, keyFile = path.join(path.dirname(dataFile), "machine.key"), vaultFile = path.join(path.dirname(dataFile), "vault.json"), keep = 10 }) {
  await fs.promises.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const exists = await fs.promises.stat(dataFile).catch(() => null);
  if (!exists) throw new Error(`No data file exists at ${dataFile}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupDir, `dinodia-${stamp}.backup.json`);
  const raw = JSON.parse(await fs.promises.readFile(dataFile, "utf8"));
  if (raw && raw.cloudflare && typeof raw.cloudflare === "object") raw.cloudflare.token = "";
  const vault = JSON.parse(await fs.promises.readFile(vaultFile, "utf8").catch(() => "{}"));
  const snapshot = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    data: raw,
    vault,
  };
  const envelope = encryptBackup(JSON.stringify(snapshot), loadOrCreateKey(keyFile));
  await fs.promises.writeFile(destination, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.chmod(destination, 0o600);
  const entries = (await fs.promises.readdir(backupDir))
    .filter((entry) => entry.startsWith("dinodia-") && entry.endsWith(".backup.json"))
    .sort()
    .reverse();
  await Promise.all(entries.slice(keep).map((entry) => fs.promises.unlink(path.join(backupDir, entry))));
  return destination;
}

module.exports = { createBackup, encryptBackup, decryptBackup, loadOrCreateKey };
