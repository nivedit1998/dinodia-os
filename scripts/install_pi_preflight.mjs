#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CANONICAL_PLATFORM_ORIGIN = "https://dinodia-platform-v2.vercel.app";

function fail(message) {
  const error = new Error(message);
  error.code = "INSTALL_PREFLIGHT_FAILED";
  throw error;
}

export function parseEnvironmentFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) fail(`invalid environment assignment at line ${index + 1}`);
    values.set(match[1], match[2]);
  }
  return values;
}

function required(values, name) {
  const value = String(values.get(name) || "").trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function sourceFingerprint(sourceDir) {
  const files = [
    "package.json",
    "package-lock.json",
    "src/server.js",
    "src/config.js",
    "src/haCompat.js",
    "src/identityd.js",
    "src/cloudflareTunnel.js",
    "public/setup.js",
    "scripts/install-pi.sh",
    "scripts/install_pi_preflight.mjs",
  ];
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    const filePath = path.join(sourceDir, relative);
    if (!fs.statSync(filePath).isFile()) fail(`candidate is missing ${relative}`);
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return `native-v2-${hash.digest("hex").slice(0, 24)}`;
}

export function validateCandidate({ sourceDir, envFile, identityDir }) {
  const values = parseEnvironmentFile(envFile);
  if (values.get("NODE_ENV") !== "production") fail("NODE_ENV=production is required");
  if (String(values.get("DINODIA_PLATFORM_API_URL") || "").replace(/\/$/, "") !== CANONICAL_PLATFORM_ORIGIN) {
    fail("DINODIA_PLATFORM_API_URL must be the canonical V2 origin");
  }
  for (const name of ["DINODIA_ADMIN_TOKEN", "DINODIA_HA_TOKEN", "DINODIA_PLATFORM_TOKEN", "DINODIA_PLATFORM_BOOTSTRAP_SECRET"]) {
    if (values.has(name)) fail(`${name} is forbidden in a Native V2 production environment`);
  }
  for (const name of ["DINODIA_APP_PUBLIC_KEYS", "DINODIA_OPERATOR_PUBLIC_KEY", "DINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS"]) required(values, name);

  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  if (!packageJson.version || packageJson.version === "0.5.0") fail("candidate package version is still the legacy 0.5.0 release");
  if (!fs.statSync(identityDir, { throwIfNoEntry: false })?.isDirectory()) fail("the enrolled identity directory is missing");
  const identityPath = path.join(identityDir, "identity.json");
  if (!fs.statSync(identityPath, { throwIfNoEntry: false })?.isFile()) fail("the enrolled identity file is missing");
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  if (!String(identity.serial || "") || !Number.isInteger(Number(identity.generation)) || Number(identity.generation) < 1) fail("the enrolled identity is incomplete");

  const buildId = sourceFingerprint(sourceDir);
  return { buildId, platformOrigin: CANONICAL_PLATFORM_ORIGIN, packageVersion: packageJson.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  try {
    const result = validateCandidate({ sourceDir: args.get("--source"), envFile: args.get("--env"), identityDir: args.get("--identity") });
    if (args.has("--print-build-id")) process.stdout.write(`${result.buildId}\n`);
    else process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`install preflight failed: ${error.message}\n`);
    process.exitCode = 78;
  }
}
