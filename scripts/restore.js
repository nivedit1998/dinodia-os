#!/usr/bin/env node
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const config = require("../src/config");
const { decryptBackup, readExistingKey } = require("../src/backup");
const { Store } = require("../src/store");
const { SecretVault } = require("../src/secretVault");
const { RESTORE_PENDING_SUFFIX, persistStoreJson, writeBytesAtomically } = require("../src/durableStoreFile");

function fail(message, code = "restore_refused") {
  throw Object.assign(new Error(message), { code });
}

function regularBytes(filePath, label) {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`, "restore_file_type_invalid");
  return fs.readFileSync(filePath);
}

function assertServiceStopped() {
  if (process.env.DINODIA_TEST_MODE === "1") return;
  const status = spawnSync("systemctl", ["show", "dinodia-os.service", "--property=MainPID", "--property=ActiveState"], { encoding: "utf8" });
  if (status.error?.code === "ENOENT") return; // Development hosts without systemd.
  if (status.error || status.status !== 0) fail("Could not prove dinodia-os.service is stopped", "restore_service_state_unknown");
  const fields = Object.fromEntries(status.stdout.trim().split(/\r?\n/).map((line) => line.split("=", 2)));
  if (fields.MainPID !== "0" || !["inactive", "failed"].includes(fields.ActiveState)) {
    fail("Stop dinodia-os.service before restoring a Store and vault", "restore_service_not_stopped");
  }
}

function paired(document) {
  const platform = document?.platform || {};
  return platform.paired === true || Boolean(platform.hubInstallId || platform.homeId);
}

async function syncDirectory(directory) {
  const handle = await fsPromises.open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function createPrivateRollbackCopy(directory, storeBytes, vaultBytes) {
  const evidenceDir = await fsPromises.mkdtemp(path.join(directory, ".restore-rollback-"));
  await fsPromises.chmod(evidenceDir, 0o700);
  await fsPromises.writeFile(path.join(evidenceDir, "dinodia.json"), storeBytes, { mode: 0o600, flag: "wx" });
  await fsPromises.writeFile(path.join(evidenceDir, "vault.json"), vaultBytes, { mode: 0o600, flag: "wx" });
  const manifest = [
    `${crypto.createHash("sha256").update(storeBytes).digest("hex")}  dinodia.json`,
    `${crypto.createHash("sha256").update(vaultBytes).digest("hex")}  vault.json`,
  ].join("\n") + "\n";
  await fsPromises.writeFile(path.join(evidenceDir, "SHA256SUMS"), manifest, { mode: 0o600, flag: "wx" });
  await syncDirectory(evidenceDir);
  await syncDirectory(directory);
  return evidenceDir;
}

async function restoreSnapshot(backupPath) {
  assertServiceStopped();
  const absolute = path.resolve(backupPath || "");
  const backupDir = path.resolve(config.backupDir);
  if (path.dirname(absolute) !== backupDir || !absolute.endsWith(".backup.json")) {
    fail(`Backup must be a .backup.json file inside ${backupDir}`, "restore_backup_path_invalid");
  }
  const key = readExistingKey(path.join(config.dataDir, "machine.key"));
  const envelopeBytes = regularBytes(absolute, "Encrypted backup");
  let snapshot;
  try { snapshot = decryptBackup(JSON.parse(envelopeBytes.toString("utf8")), key); }
  catch (error) { fail(`Encrypted backup could not be authenticated (${error.message})`, "restore_backup_authentication_failed"); }
  if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.data || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)
    || !snapshot.vault || typeof snapshot.vault !== "object" || Array.isArray(snapshot.vault)) {
    fail("Backup does not contain a supported Store and encrypted vault snapshot", "restore_snapshot_invalid");
  }
  if (paired(snapshot.data)) fail("Paired Native V2 Stores require signed Platform stream reconciliation; generic restore is not permitted", "restore_requires_signed_reconciliation");

  const dataFile = config.dataFile;
  const vaultFile = path.join(config.dataDir, "vault.json");
  const currentStoreBytes = regularBytes(dataFile, "Current Native OS Store");
  const currentVaultBytes = regularBytes(vaultFile, "Current encrypted vault");
  let currentStore;
  try { currentStore = JSON.parse(currentStoreBytes.toString("utf8")); }
  catch (error) { fail(`Current Store is invalid JSON (${error.message}); use the incident-specific recovery procedure`, "restore_current_store_invalid"); }
  if (paired(currentStore)) fail("Current Home is paired; generic restore could roll back identity or sync authority", "restore_requires_signed_reconciliation");

  const evidenceDir = await createPrivateRollbackCopy(config.dataDir, currentStoreBytes, currentVaultBytes);
  const stageDir = await fsPromises.mkdtemp(path.join(config.dataDir, ".restore-stage-"));
  await fsPromises.chmod(stageDir, 0o700);
  const stageData = path.join(stageDir, "dinodia.json");
  const stageVault = path.join(stageDir, "vault.json");
  const stageKey = path.join(stageDir, "machine.key");
  const pendingMarker = `${dataFile}${RESTORE_PENDING_SUFFIX}`;
  const pendingContents = Buffer.from(`dinodia-store-restore-v1\nbackup=${path.basename(absolute)}\nevidence=${path.basename(evidenceDir)}\n`, "utf8");
  let transactionStarted = false;
  try {
    await fsPromises.writeFile(stageData, `${JSON.stringify(snapshot.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const stagedStore = new Store(stageData);
    const normalizedStore = stagedStore.snapshot();
    if (paired(normalizedStore)) fail("Normalized restore candidate unexpectedly contains a paired Home", "restore_requires_signed_reconciliation");
    await fsPromises.writeFile(stageVault, `${JSON.stringify(snapshot.vault, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fsPromises.writeFile(stageKey, key, { mode: 0o600, flag: "wx" });
    const stagedVault = new SecretVault({ dataDir: stageDir, keyFile: stageKey, vaultFile: stageVault });
    for (const name of Object.keys(stagedVault.records)) {
      if (stagedVault.get(name) === null) fail(`Encrypted backup vault record failed authentication: ${name}`, "restore_vault_record_invalid");
    }

    try { fs.lstatSync(pendingMarker); fail("An earlier Store restore transaction is still pending", "restore_already_pending"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await writeBytesAtomically(pendingMarker, pendingContents, { mode: 0o600 });
    transactionStarted = true;
    await writeBytesAtomically(vaultFile, Buffer.from(`${JSON.stringify(snapshot.vault, null, 2)}\n`, "utf8"), { mode: 0o600 });
    await persistStoreJson(dataFile, `${JSON.stringify(normalizedStore, null, 2)}\n`);

    const committedStore = JSON.parse(regularBytes(dataFile, "Restored Store").toString("utf8"));
    const committedVault = JSON.parse(regularBytes(vaultFile, "Restored encrypted vault").toString("utf8"));
    if (JSON.stringify(committedStore) !== JSON.stringify(normalizedStore)
      || JSON.stringify(committedVault) !== JSON.stringify(snapshot.vault)) {
      fail("Restored Store/vault read-back does not match the validated staged snapshot", "restore_readback_mismatch");
    }
    await fsPromises.unlink(pendingMarker);
    await syncDirectory(config.dataDir);
    transactionStarted = false;
    return { restored: true, evidenceDir, storeVersion: Number(committedStore.version), paired: false };
  } catch (error) {
    if (transactionStarted) {
      // The marker deliberately remains: Store.load() refuses to activate a
      // potentially mixed Store/vault pair after interruption or uncertainty.
      try {
        fs.lstatSync(pendingMarker);
      } catch (markerError) {
        if (markerError?.code === "ENOENT") await writeBytesAtomically(pendingMarker, pendingContents, { mode: 0o600 }).catch(() => {});
      }
      error.recoveryEvidenceDir = evidenceDir;
    }
    throw error;
  } finally {
    if (!transactionStarted) await fsPromises.rm(stageDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const backupPath = args.find((argument) => !argument.startsWith("--"));
  if (!backupPath || !args.includes("--confirm") || args.some((argument) => ![backupPath, "--confirm"].includes(argument))) {
    throw new Error("Usage: node scripts/restore.js /path/to/dinodia-<timestamp>.backup.json --confirm (unpaired Stores only; paired Stores require signed reconciliation)");
  }
  const result = await restoreSnapshot(backupPath);
  console.log(`Restored ${backupPath}; previous Store/vault preserved in private evidence ${result.evidenceDir}.`);
  console.log("Restart Dinodia OS only after reviewing the restore summary.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RESTORE_REFUSED code=${String(error.code || "restore_failed")} message=${error.message}`);
    if (error.recoveryEvidenceDir) console.error(`Store restore transaction marker remains; preserve evidence ${error.recoveryEvidenceDir} and keep Dinodia OS stopped.`);
    process.exitCode = 1;
  });
}

module.exports = { restoreSnapshot };
