const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { hasInitializedMarkerSync, writeBytesAtomically } = require("./durableStoreFile");

function vaultError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function regularFile(pathname, label) {
  let info;
  try { info = fs.lstatSync(pathname); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw vaultError(`${label} must be a regular, non-symlink file`, "secret_file_type_invalid");
  return info;
}

function isPairedStore(dataDir) {
  const storePath = path.join(dataDir, "dinodia.json");
  const info = regularFile(storePath, "Native OS Store");
  if (!info) return false;
  let document;
  try { document = JSON.parse(fs.readFileSync(storePath, "utf8")); }
  catch (error) {
    if (hasInitializedMarkerSync(storePath)) throw vaultError("Initialized Native OS Store is unreadable; refusing to replace its credentials", "secret_store_unreadable", error);
    return false;
  }
  const platform = document?.platform || {};
  return platform.paired === true || Boolean(platform.hubInstallId || platform.homeId);
}

function syncDirectorySync(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

class SecretVault {
  constructor({ dataDir, keyFile, vaultFile, logger = console } = {}) {
    this.dataDir = dataDir || process.cwd();
    this.keyFile = keyFile || path.join(this.dataDir, "machine.key");
    this.vaultFile = vaultFile || path.join(this.dataDir, "vault.json");
    this.logger = logger;
    const loadedKey = this.loadOrCreateKey();
    this.key = loadedKey.key;
    this.keyCreated = loadedKey.created;
    this.records = this.load();
    this.keyCreated = false;
    this.writeQueue = Promise.resolve();
  }

  loadOrCreateKey() {
    const existing = regularFile(this.keyFile, "Vault encryption key");
    if (existing) {
      if ((existing.mode & 0o077) !== 0) throw vaultError("Vault encryption key permissions are not private", "secret_key_permissions_invalid");
      const key = fs.readFileSync(this.keyFile);
      if (key.length !== 32) throw vaultError("Vault encryption key has an invalid length", "secret_key_invalid");
      return { key, created: false };
    }

    const existingVault = regularFile(this.vaultFile, "Encrypted vault");
    if (existingVault) throw vaultError("Vault encryption key is missing while encrypted vault data remains; refusing to mint a replacement", "secret_key_missing");
    if (isPairedStore(this.dataDir)) throw vaultError("Vault encryption key is missing for an enrolled Home; refusing to mint a replacement", "secret_key_missing");

    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    let descriptor;
    try {
      descriptor = fs.openSync(this.keyFile, "wx", 0o600);
      fs.writeFileSync(descriptor, key);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      syncDirectorySync(path.dirname(this.keyFile));
      return { key, created: true };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error?.code === "EEXIST") return this.loadOrCreateKey();
      throw vaultError("Could not durably initialize the vault encryption key", "secret_key_durability_uncertain", error);
    }
  }

  load() {
    const info = regularFile(this.vaultFile, "Encrypted vault");
    if (!info) {
      if (!this.keyCreated) throw vaultError("Encrypted vault is missing while its established machine key remains; refusing to replace secrets with an empty vault", "secret_vault_missing");
      fs.mkdirSync(path.dirname(this.vaultFile), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.vaultFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporaryPath, "wx", 0o600);
        fs.writeFileSync(descriptor, "{}\n", "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, this.vaultFile);
        syncDirectorySync(path.dirname(this.vaultFile));
      } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
        throw vaultError("Could not durably initialize the empty vault", "secret_vault_durability_uncertain", error);
      }
      return {};
    }
    if ((info.mode & 0o077) !== 0) throw vaultError("Encrypted vault permissions are not private", "secret_vault_permissions_invalid");
    let records;
    try { records = JSON.parse(fs.readFileSync(this.vaultFile, "utf8")); }
    catch (error) { throw vaultError("Encrypted vault is not valid JSON; refusing to start with an empty vault", "secret_vault_invalid", error); }
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      throw vaultError("Encrypted vault must contain a JSON object", "secret_vault_invalid");
    }
    return records;
  }

  encrypt(value, purpose) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(String(purpose)));
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  decrypt(record, purpose) {
    if (!record || record.algorithm !== "aes-256-gcm") return null;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(String(purpose)));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  get(name) {
    const record = this.records[String(name)];
    return this.decrypt(record, String(name));
  }

  async set(name, value) {
    const key = String(name);
    if (process.env.NODE_ENV === "production" && /(?:platform\.)?(?:identity|encryption)(?:Private|private)|manufacturing.*private/i.test(key)) {
      throw new Error("Manufacturing private keys must be handled by dinodia-identityd");
    }
    if (value === undefined || value === null || value === "") delete this.records[key];
    else this.records[key] = this.encrypt(value, key);
    await this.persist();
  }

  async persist() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const serialized = `${JSON.stringify(this.records, null, 2)}\n`;
      await fsPromises.mkdir(path.dirname(this.vaultFile), { recursive: true, mode: 0o700 });
      await writeBytesAtomically(this.vaultFile, Buffer.from(serialized, "utf8"), { mode: 0o600 });
      this.keyCreated = false;
    });
    await this.writeQueue;
  }

  async clear(name) { return this.set(name, ""); }
  async delete(name) {
    const key = String(name);
    if (!Object.hasOwn(this.records, key)) return false;
    delete this.records[key];
    await this.persist();
    return true;
  }
  async clearAll() {
    this.records = {};
    await this.persist();
  }
  has(name) { return Boolean(this.get(name)); }
}

module.exports = { SecretVault };
