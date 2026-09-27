#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planAvahiSetupReconciliation } = require("../src/avahiSetupSupervisor");

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function configuredInterface(environmentPath) {
  if (!environmentPath || !fs.existsSync(environmentPath)) return "";
  const matches = fs.readFileSync(environmentPath, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*DINODIA_SETUP_INTERFACE\s*=\s*([A-Za-z0-9_.:-]{1,15})\s*(?:#.*)?$/))
    .filter(Boolean);
  if (matches.length > 1) throw new Error("setup interface configuration is ambiguous");
  return matches[0]?.[1] || "";
}

function systemctl(args) {
  const result = spawnSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  if (result.error || result.status !== 0) throw new Error("Avahi interface reconciliation could not update the daemon");
}

function atomicReplace(filePath, content) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.dinodia-avahi-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o644, flag: "wx" });
    fs.chownSync(temporary, 0, 0);
    fs.chmodSync(temporary, 0o644);
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function reconcileAvahiSetup({ identityPath, environmentPath, configPath, interfaces = os.networkInterfaces(), physicalCheck, active, isActive = () => spawnSync("systemctl", ["is-active", "--quiet", "avahi-daemon"], { stdio: "ignore" }).status === 0, runSystemctl = systemctl, replaceConfig = atomicReplace }) {
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const serial = String(identity.serialNumber || identity.serial || "").trim().toLowerCase();
  if (!serial) throw new Error("enrolled identity does not contain a setup serial");
  const configText = fs.readFileSync(configPath, "utf8");
  const daemonActive = active ?? isActive();
  const plan = planAvahiSetupReconciliation({
    serial,
    interfaceName: configuredInterface(environmentPath),
    interfaces,
    physicalCheck,
    configText,
    active: daemonActive,
  });

  if (!plan.selected) {
    if (plan.action === "stop") runSystemctl(["stop", "avahi-daemon"]);
    return { state: "UNAVAILABLE", action: plan.action };
  }
  if (plan.action === "none") return { state: "CURRENT", action: "none", interfaceName: plan.selected.name };

  if (plan.configText !== configText) replaceConfig(configPath, plan.configText);
  runSystemctl([daemonActive ? "restart" : "start", "avahi-daemon"]);
  if (!isActive()) throw new Error("Avahi daemon did not become active after interface reconciliation");
  return { state: "CURRENT", action: "restart", interfaceName: plan.selected.name };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.getuid?.() !== 0) {
    process.stderr.write("Setup discovery reconciliation must run as root\n");
    process.exit(2);
  }
  const identityPath = arg("--identity", "/etc/dinodia-os/identity/identity.json");
  const environmentPath = arg("--environment", "/opt/dinodia-os/.env");
  const configPath = arg("--config", "/etc/avahi/avahi-daemon.conf");
  try {
    const result = reconcileAvahiSetup({ identityPath, environmentPath, configPath });
    process.stdout.write(`mDNS interface state=${result.state}${result.interfaceName ? ` interface=${result.interfaceName}` : ""}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || "Avahi interface reconciliation failed").slice(0, 180)}\n`);
    process.exit(1);
  }
}
