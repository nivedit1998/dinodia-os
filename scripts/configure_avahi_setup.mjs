#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { privateInterface } = require("../src/setupDiscovery");
const { configureSetupDiscovery } = require("../src/avahiSetupConfig");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

const input = argument("--input");
const output = argument("--output");
const identityPath = argument("--identity");
const interfaceName = argument("--interface-name") || argument("--interface-address");
const printInterfaceName = process.argv.includes("--print-interface-name");
if (!input || !output || !identityPath) {
  process.stderr.write("Usage: configure_avahi_setup.mjs --input FILE --output FILE --identity FILE [--interface-name NAME]\n");
  process.exit(2);
}

const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
const serial = String(identity.serialNumber || identity.serial || "");
const selected = privateInterface(interfaceName, os.networkInterfaces());
if (!selected) throw new Error("No physical private setup interface is available");
const source = fs.readFileSync(input, "utf8");
const candidate = configureSetupDiscovery(source, { serial, interfaceName: selected.name });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, candidate, { mode: 0o600 });
process.stdout.write(printInterfaceName ? selected.name : selected.address);
