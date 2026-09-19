const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createBackup, decryptBackup } = require("../src/backup");

test("backups are versioned and encrypted, including the encrypted vault records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-backup-"));
  const dataFile = path.join(directory, "dinodia.json");
  const backupDir = path.join(directory, "backups");
  await fs.writeFile(dataFile, JSON.stringify({ version: 3, cloudflare: { token: "legacy-secret" }, devices: {} }));
  await fs.writeFile(path.join(directory, "vault.json"), JSON.stringify({ "platform.syncSecret": { algorithm: "aes-256-gcm", ciphertext: "encrypted" } }));
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
