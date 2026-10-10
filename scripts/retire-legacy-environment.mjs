#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RETIRED_ENVIRONMENT_NAMES = Object.freeze([
  "DINODIA_ADMIN_TOKEN",
  "DINODIA_HA_TOKEN",
  "DINODIA_PLATFORM_TOKEN",
  "DINODIA_PLATFORM_BOOTSTRAP_SECRET",
  "DINODIA_HA_PORT",
  "DINODIA_HUB_AGENT_PORT",
  "DINODIA_HA_HOST",
  "DINODIA_PLATFORM_HEARTBEAT_URL",
  "DINODIA_STATE_CHANGE_URL",
  "DINODIA_STATE_CHANGE_SECRET",
  "DINODIA_HA_USERNAME",
  "STAGE1_INTERNAL_OPERATOR_DAY_SESSION",
]);

function argumentsMap(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return values;
}

export function retireLegacyEnvironmentFile({ envPath, backupDirectory, backupName }) {
  const absoluteEnvPath = path.resolve(envPath);
  const original = fs.readFileSync(absoluteEnvPath);
  const text = original.toString("utf8");
  const retired = new Set(RETIRED_ENVIRONMENT_NAMES);
  const removedNames = new Set();
  const retainedLines = text.split(/(?<=\n)/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !retired.has(match[1])) return true;
    removedNames.add(match[1]);
    return false;
  });
  if (removedNames.size === 0) return { backupPath: null, removedNames: [] };

  const stat = fs.statSync(absoluteEnvPath);
  const backupRoot = path.resolve(backupDirectory);
  fs.mkdirSync(backupRoot, { recursive: false, mode: 0o700 });
  if ((fs.statSync(backupRoot).mode & 0o777) !== 0o700) throw new Error("the new environment backup directory is not private");
  const backupPath = path.join(backupRoot, backupName);
  const backupFd = fs.openSync(backupPath, "wx", 0o600);
  try {
    fs.writeFileSync(backupFd, original);
    fs.fsyncSync(backupFd);
  } finally {
    fs.closeSync(backupFd);
  }

  const temporary = path.join(path.dirname(absoluteEnvPath), `.env.stage14-${process.pid}.tmp`);
  const nextContent = Buffer.from(retainedLines.join(""), "utf8");
  const temporaryFd = fs.openSync(temporary, "wx", stat.mode & 0o777);
  try {
    fs.writeFileSync(temporaryFd, nextContent);
    fs.fsyncSync(temporaryFd);
  } finally {
    fs.closeSync(temporaryFd);
  }
  fs.chownSync(temporary, stat.uid, stat.gid);
  fs.chmodSync(temporary, stat.mode & 0o777);
  fs.renameSync(temporary, absoluteEnvPath);
  const directoryFd = fs.openSync(path.dirname(absoluteEnvPath), "r");
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }

  return { backupPath, removedNames: [...removedNames].sort() };
}

function run(argv) {
  if (process.getuid?.() !== 0) throw new Error("run this exact environment migration from the guarded Pi root shell");
  const args = argumentsMap(argv);
  const installDirectory = path.resolve(args.get("--install-dir") || "/opt/dinodia-os");
  const envPath = path.resolve(args.get("--env") || path.join(installDirectory, ".env"));
  const expectedCurrent = String(args.get("--expected-current") || "");
  if (!/^native-v2-[a-f0-9]{24}$/.test(expectedCurrent)) throw new Error("the literal expected-current Native V2 build ID is required");
  const buildPath = path.join(installDirectory, "BUILD.json");
  const current = JSON.parse(fs.readFileSync(buildPath, "utf8"));
  if (current.buildId !== expectedCurrent) throw new Error("the installed build changed; stop and re-review the target");

  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const result = retireLegacyEnvironmentFile({ envPath, backupDirectory: `/var/backups/dinodia-os-env-before-native-v2-${stamp}-${process.pid}`, backupName: "original.env" });
  if (result.removedNames.length === 0) {
    process.stdout.write("Retired environment keys already absent; no file changed.\n");
    return;
  }
  process.stdout.write(`Retired environment keys: ${result.removedNames.join(",")}\n`);
  process.stdout.write(`Restricted original environment backup: ${result.backupPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(process.argv); }
  catch (error) {
    process.stderr.write(`environment migration stopped: ${error.message}\n`);
    process.exitCode = 78;
  }
}
