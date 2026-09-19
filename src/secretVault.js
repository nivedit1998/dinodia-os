const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

class SecretVault {
  constructor({ dataDir, keyFile, vaultFile, logger = console } = {}) {
    this.dataDir = dataDir || process.cwd();
    this.keyFile = keyFile || path.join(this.dataDir, "machine.key");
    this.vaultFile = vaultFile || path.join(this.dataDir, "vault.json");
    this.logger = logger;
    this.key = this.loadOrCreateKey();
    this.records = this.load();
    this.writeQueue = Promise.resolve();
  }

  loadOrCreateKey() {
    try {
      const key = fs.readFileSync(this.keyFile);
      if (key.length === 32) return key;
    } catch {
      // First boot.
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.keyFile, key, { mode: 0o600 });
    try { fs.chmodSync(this.keyFile, 0o600); } catch {}
    return key;
  }

  load() {
    try { return safeObject(JSON.parse(fs.readFileSync(this.vaultFile, "utf8"))); } catch { return {}; }
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
    if (value === undefined || value === null || value === "") delete this.records[key];
    else this.records[key] = this.encrypt(value, key);
    const serialized = JSON.stringify(this.records, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fsPromises.mkdir(path.dirname(this.vaultFile), { recursive: true, mode: 0o700 });
      const temp = `${this.vaultFile}.${process.pid}.tmp`;
      await fsPromises.writeFile(temp, serialized, { mode: 0o600 });
      await fsPromises.chmod(temp, 0o600);
      await fsPromises.rename(temp, this.vaultFile);
    });
    await this.writeQueue;
  }

  async clear(name) { return this.set(name, ""); }
  async clearAll() {
    this.records = {};
    const temp = `${this.vaultFile}.${process.pid}.tmp`;
    await fsPromises.writeFile(temp, "{}\n", { mode: 0o600 });
    await fsPromises.chmod(temp, 0o600);
    await fsPromises.rename(temp, this.vaultFile);
  }
  has(name) { return Boolean(this.get(name)); }
}

module.exports = { SecretVault };
