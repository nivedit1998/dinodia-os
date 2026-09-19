#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../src/config");
const { decryptBackup } = require("../src/backup");

async function main() {
  const backupPath = path.resolve(process.argv[2] || "");
  if (!backupPath || !backupPath.endsWith(".backup.json")) throw new Error("Usage: node scripts/restore.js /path/to/dinodia-<timestamp>.backup.json --confirm");
  if (!process.argv.includes("--confirm")) throw new Error("Restore is destructive; add --confirm after stopping Dinodia OS");
  const backupDir = path.resolve(config.backupDir);
  if (path.dirname(backupPath) !== backupDir) throw new Error(`Backup must be inside ${backupDir}`);
  const key = await fs.readFile(path.join(config.dataDir, "machine.key"));
  if (key.length !== 32) throw new Error("The matching machine.key is required to restore an encrypted backup");
  const envelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const snapshot = decryptBackup(envelope, key);
  if (!snapshot.data || typeof snapshot.data !== "object") throw new Error("Backup does not contain a Dinodia data snapshot");
  await fs.writeFile(config.dataFile, `${JSON.stringify(snapshot.data, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(config.dataDir, "vault.json"), `${JSON.stringify(snapshot.vault || {}, null, 2)}\n`, { mode: 0o600 });
  console.log(`Restored ${backupPath}. Restart Dinodia OS to load it.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
