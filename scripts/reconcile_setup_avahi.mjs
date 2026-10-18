#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const modulePath = fileURLToPath(import.meta.url);
const resolvedModulePath = (() => {
  try { return fs.realpathSync(modulePath); }
  catch { return modulePath; }
})();
// `--preserve-symlinks-main` leaves import.meta.url at the invoked release
// link. Resolve CommonJS siblings from the immutable release file so the
// supported systemd/current-symlink entry remains valid in either mode.
const require = createRequire(pathToFileURL(resolvedModulePath));
const { planAvahiSetupReconciliation } = require("../src/avahiSetupSupervisor");
const { avahiSetupConfigMatches } = require("../src/avahiSetupConfig");

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

  const configChanged = plan.configText !== configText;
  if (configChanged) replaceConfig(configPath, plan.configText);
  try {
    runSystemctl([daemonActive ? "restart" : "start", "avahi-daemon"]);
    const appliedConfig = fs.readFileSync(configPath, "utf8");
    if (!avahiSetupConfigMatches(appliedConfig, { serial, interfaceName: plan.selected.name })) {
      throw new Error("Avahi interface configuration did not match the selected physical interface after reconciliation");
    }
    if (!isActive()) throw new Error("Avahi daemon did not become active after interface reconciliation");
  } catch (error) {
    // Never leave a possibly unusable daemon configuration behind after a
    // failed restart or postcondition. Restore the exact prior bytes and make
    // a best-effort daemon reload only when it was active before this attempt.
    if (configChanged) {
      try {
        replaceConfig(configPath, configText);
        if (daemonActive) runSystemctl(["restart", "avahi-daemon"]);
      } catch {
        throw new Error("Avahi reconciliation failed and the previous configuration could not be restored");
      }
    }
    throw error;
  }
  return { state: "CURRENT", action: "restart", interfaceName: plan.selected.name };
}

function invokedAsMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Node's default mode resolves import.meta.url while argv[1] may retain
    // the invoked link. `--preserve-symlinks-main` does the reverse. Compare
    // canonical paths on both sides so release symlinks and chains execute
    // the guarded CLI exactly once under either supported launch mode.
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

function dryRunPlan({ identityPath, environmentPath, configPath, interfacesJson = "" }) {
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const serial = String(identity.serialNumber || identity.serial || "").trim().toLowerCase();
  if (!serial) throw new Error("enrolled identity does not contain a setup serial");
  const configText = fs.readFileSync(configPath, "utf8");
  const interfaces = interfacesJson ? JSON.parse(interfacesJson) : os.networkInterfaces();
  const plan = planAvahiSetupReconciliation({
    serial,
    interfaceName: configuredInterface(environmentPath),
    interfaces,
    // Simulated interfaces are accepted only by this non-mutating diagnostic
    // mode. The root-owned service always uses the real physical-device test.
    ...(interfacesJson ? { physicalCheck: (name) => Object.hasOwn(interfaces, name) } : {}),
    configText,
    active: true,
  });
  return plan;
}

if (invokedAsMainModule()) {
  const identityPath = arg("--identity", "/etc/dinodia-os/identity/identity.json");
  const environmentPath = arg("--environment", "/opt/dinodia-os/.env");
  const configPath = arg("--config", "/etc/avahi/avahi-daemon.conf");
  try {
    if (process.argv.includes("--dry-run")) {
      const plan = dryRunPlan({ identityPath, environmentPath, configPath, interfacesJson: arg("--interfaces-json") });
      process.stdout.write(`mDNS interface plan state=${plan.selected ? "AVAILABLE" : "UNAVAILABLE"} action=${plan.action}${plan.selected ? ` interface=${plan.selected.name}` : ""}\n`);
      process.exitCode = plan.selected ? 0 : 3;
    } else {
      if (process.getuid?.() !== 0) {
        process.stderr.write("Setup discovery reconciliation must run as root\n");
        process.exit(2);
      }
    const result = reconcileAvahiSetup({ identityPath, environmentPath, configPath });
    process.stdout.write(`mDNS interface state=${result.state}${result.interfaceName ? ` interface=${result.interfaceName}` : ""}\n`);
    }
  } catch (error) {
    process.stderr.write(`${String(error?.message || "Avahi interface reconciliation failed").slice(0, 180)}\n`);
    process.exit(1);
  }
}
