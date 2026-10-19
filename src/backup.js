const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function backupError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function readRegularFile(filePath, label, { privateMode = false } = {}) {
  let info;
  try { info = fs.lstatSync(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") throw backupError(`${label} is missing at ${filePath}`, "backup_input_missing", error);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw backupError(`${label} must be a regular, non-symlink file`, "backup_input_type_invalid");
  if (privateMode && (info.mode & 0o077) !== 0) throw backupError(`${label} permissions are not private`, "backup_input_permissions_invalid");
  return fs.readFileSync(filePath);
}

function readExistingKey(keyFile) {
  const key = readRegularFile(keyFile, "Vault encryption key", { privateMode: true });
  if (key.length !== 32) throw backupError("Vault encryption key has an invalid length", "secret_key_invalid");
  return key;
}

function encryptBackup(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("A 32-byte backup key is required");
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

async function syncDirectory(directory) {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function atomicPrivateWrite(destination, bytes, { mode = 0o600, code = "backup_durability_uncertain" } = {}) {
  const directory = path.dirname(destination);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await fs.promises.open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, destination);
    renamed = true;
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
    if (renamed) throw backupError("Atomic backup replacement completed but directory durability is uncertain", code, error);
    throw error;
  }
}

async function createBackup({ dataFile, backupDir, keyFile = path.join(path.dirname(dataFile), "machine.key"), vaultFile = path.join(path.dirname(dataFile), "vault.json"), keep = 10 }) {
  if (!Number.isSafeInteger(Number(keep)) || Number(keep) < 1 || Number(keep) > 1000) throw new Error("Backup retention must be an integer from 1 through 1000");
  const backupDirectory = path.resolve(backupDir);
  const dataBytes = readRegularFile(dataFile, "Native OS Store");
  const vaultBytes = readRegularFile(vaultFile, "Encrypted vault", { privateMode: true });
  const key = readExistingKey(keyFile);
  let raw;
  let vault;
  try { raw = JSON.parse(dataBytes.toString("utf8")); }
  catch (error) { throw backupError("Native OS Store is invalid JSON; refusing to create a backup", "backup_store_invalid", error); }
  try { vault = JSON.parse(vaultBytes.toString("utf8")); }
  catch (error) { throw backupError("Encrypted vault is invalid JSON; refusing to create a backup", "backup_vault_invalid", error); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw backupError("Native OS Store must be a JSON object", "backup_store_invalid");
  if (!vault || typeof vault !== "object" || Array.isArray(vault)) throw backupError("Encrypted vault must be a JSON object", "backup_vault_invalid");

  if (raw.cloudflare && typeof raw.cloudflare === "object") raw.cloudflare.token = "";
  const snapshot = { schemaVersion: 1, createdAt: new Date().toISOString(), data: raw, vault };
  const envelope = encryptBackup(JSON.stringify(snapshot), key);
  await fs.promises.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.promises.lstat(backupDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw backupError("Backup directory must be a real directory", "backup_directory_invalid");
  await fs.promises.chmod(backupDirectory, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupDirectory, `dinodia-${stamp}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.backup.json`);
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await atomicPrivateWrite(destination, bytes);

  // Independently read/decrypt the committed artifact before any retention
  // work can remove older generations.
  const committed = JSON.parse(readRegularFile(destination, "Committed encrypted backup", { privateMode: true }).toString("utf8"));
  const verified = decryptBackup(committed, key);
  if (JSON.stringify(verified) !== JSON.stringify(snapshot)) {
    throw backupError("Committed encrypted backup did not round-trip to the exact Store/vault snapshot", "backup_readback_mismatch");
  }

  const entries = [];
  for (const entry of await fs.promises.readdir(backupDirectory)) {
    if (!/^dinodia-.*\.backup\.json$/.test(entry)) continue;
    const entryPath = path.join(backupDirectory, entry);
    const info = await fs.promises.lstat(entryPath);
    if (info.isFile() && !info.isSymbolicLink()) entries.push({ entry, mtimeMs: info.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.entry.localeCompare(a.entry));
  for (const candidate of entries.slice(Number(keep))) await fs.promises.unlink(path.join(backupDirectory, candidate.entry));
  if (entries.length > Number(keep)) await syncDirectory(backupDirectory);
  return destination;
}

module.exports = { createBackup, encryptBackup, decryptBackup, readExistingKey };
