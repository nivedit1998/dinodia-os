const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createBackup, decryptBackup } = require("../src/backup");
const { SecretVault } = require("../src/secretVault");
const { Store } = require("../src/store");
const config = require("../src/config");
const { restoreSnapshot } = require("../scripts/restore");

test("backups are versioned and encrypted, including the encrypted vault records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-backup-"));
  const dataFile = path.join(directory, "dinodia.json");
  const backupDir = path.join(directory, "backups");
  await fs.writeFile(dataFile, JSON.stringify({ version: 3, cloudflare: { token: "legacy-secret" }, devices: {} }));
  const vault = new SecretVault({ dataDir: directory });
  await vault.set("platform.syncSecret", "encrypted-test-secret");
  const backupPath = await createBackup({ dataFile, backupDir, keyFile: path.join(directory, "machine.key"), vaultFile: path.join(directory, "vault.json") });
  assert.match(backupPath, /\.backup\.json$/);
  const envelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(JSON.stringify(envelope).includes("legacy-secret"), false);
  assert.equal(JSON.stringify(envelope).includes("platform.syncSecret"), false);
  const key = await fs.readFile(path.join(directory, "machine.key"));
  const decoded = decryptBackup(envelope, key);
  assert.equal(decoded.data.cloudflare.token, "");
  assert.equal(decoded.vault["platform.syncSecret"].algorithm, "aes-256-gcm");
  const tampered = { ...envelope, tag: crypto.randomBytes(16).toString("base64") };
  assert.throws(() => decryptBackup(tampered, key));
});

test("backup refuses missing key or malformed Store/vault without creating replacement credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-backup-refusal-"));
  const dataFile = path.join(directory, "dinodia.json");
  const vaultFile = path.join(directory, "vault.json");
  const keyFile = path.join(directory, "machine.key");
  const backupDir = path.join(directory, "backups");
  await fs.writeFile(dataFile, JSON.stringify({ version: 10, platform: { paired: true } }));
  await fs.writeFile(vaultFile, "{}\n", { mode: 0o600 });

  await assert.rejects(createBackup({ dataFile, backupDir, keyFile, vaultFile }), { code: "backup_input_missing" });
  await assert.rejects(fs.stat(keyFile), { code: "ENOENT" });
  await assert.rejects(fs.stat(backupDir), { code: "ENOENT" });

  await fs.writeFile(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  await fs.writeFile(dataFile, "not-json");
  await assert.rejects(createBackup({ dataFile, backupDir, keyFile, vaultFile }), { code: "backup_store_invalid" });
  await assert.rejects(fs.stat(backupDir), { code: "ENOENT" });
});

test("generic restore rejects a paired Home and preserves signed stream authority", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-backup-paired-restore-"));
  const priorConfig = { dataDir: config.dataDir, dataFile: config.dataFile, backupDir: config.backupDir };
  const priorTestMode = process.env.DINODIA_TEST_MODE;
  try {
    config.dataDir = directory;
    config.dataFile = path.join(directory, "dinodia.json");
    config.backupDir = path.join(directory, "backups");
    const store = new Store(config.dataFile);
    const vault = new SecretVault({ dataDir: directory });
    await store.savePlatform({ paired: true, homeId: "same-home", hubInstallId: "same-enrolled-hub" });
    const backupPath = await createBackup({ dataFile: config.dataFile, backupDir: config.backupDir, vaultFile: path.join(directory, "vault.json") });
    process.env.DINODIA_TEST_MODE = "1";
    await assert.rejects(restoreSnapshot(backupPath), { code: "restore_requires_signed_reconciliation" });
    assert.equal(store.getPlatform().homeId, "same-home");
    assert.equal(vault.has("platform.machineCredential"), false);
  } finally {
    config.dataDir = priorConfig.dataDir;
    config.dataFile = priorConfig.dataFile;
    config.backupDir = priorConfig.backupDir;
    if (priorTestMode === undefined) delete process.env.DINODIA_TEST_MODE;
    else process.env.DINODIA_TEST_MODE = priorTestMode;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
