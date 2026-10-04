"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createUpdaterControlServer, disabledPolicy, loadRootPolicy, packageSourceFingerprint, preflightCandidate, preflightStoreCopy, requestMatches } = require("../src/updater/service");
const { initialState } = require("../src/store");
const { NATIVE_AUTOMATION_STORE_VERSION } = require("../src/automations/constants");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-updater-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function send(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("control socket timed out")); });
    socket.on("connect", () => socket.write(`${value}\n`));
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); if (response.includes("\n")) { socket.end(); resolve(JSON.parse(response.trim())); } });
    socket.on("error", reject);
  });
}

test("updater trust policy is root-owned, bounded, Ed25519-only and safely disabled by default", (t) => {
  const root = tempRoot(t);
  const policyDir = path.join(root, "etc");
  fs.mkdirSync(policyDir, { mode: 0o700 });
  const policyPath = path.join(policyDir, "updater-policy.json");
  const pair = crypto.generateKeyPairSync("ed25519");
  const valid = {
    enabled: true, approvedChannel: "stable", targetArch: "aarch64", apiVersion: 2, storeSchemaVersion: NATIVE_AUTOMATION_STORE_VERSION,
    signingKeyId: "release-key-1", releaseSigningPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedArtifactHosts: ["releases.example.invalid"], maxManifestLifetimeMs: 604800000,
    downloadTimeoutMs: 60000, minimumFreeBytes: 67108864,
  };
  fs.writeFileSync(policyPath, JSON.stringify(valid), { mode: 0o600 });
  const expectedOwnerUid = process.getuid?.() ?? fs.statSync(policyPath).uid;
  assert.equal(loadRootPolicy(policyPath, { expectedOwnerUid }).enabled, true);
  fs.writeFileSync(policyPath, JSON.stringify({ ...valid, releaseSigningPublicKey: "private-key-must-not-be-used" }), { mode: 0o600 });
  assert.equal(loadRootPolicy(policyPath, { expectedOwnerUid }).enabled, false);
  fs.chmodSync(policyPath, 0o644);
  assert.equal(loadRootPolicy(policyPath, { expectedOwnerUid }).enabled, false);
  assert.equal(loadRootPolicy(path.join(root, "missing-policy.json"), { expectedOwnerUid }).enabled, false);
  assert.equal(disabledPolicy().storeSchemaVersion, NATIVE_AUTOMATION_STORE_VERSION);
});

test("updater preflight is data-only, checks production configuration and returns the installed build fingerprint", (t) => {
  const root = tempRoot(t);
  const source = path.join(root, "candidate");
  for (const dir of ["src", "public", "scripts", "docker", "systemd", "docs", "node_modules"]) fs.mkdirSync(path.join(source, dir), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "server.js"), "candidate source\n");
  fs.writeFileSync(path.join(source, "systemd", "service"), "fixed service\n");
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "4.2.0", dependencies: {}, optionalDependencies: {} }));
  for (const name of ["package-lock.json", "Dockerfile", "docker-compose.yml", ".env.example", "requirements-hive.in", "requirements-hive.lock", "THIRD_PARTY_NOTICES.md"]) fs.writeFileSync(path.join(source, name), "reviewed test input\n");
  fs.writeFileSync(path.join(source, ".env"), "NODE_ENV=production\nDINODIA_PLATFORM_API_URL=https://dinodia-platform-v2.vercel.app\nDINODIA_APP_PUBLIC_KEYS=public-only\nDINODIA_OPERATOR_PUBLIC_KEY=public-only\nDINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS=public-only\n");
  const identityDir = path.join(root, "identity");
  fs.mkdirSync(identityDir);
  fs.writeFileSync(path.join(identityDir, "identity.json"), JSON.stringify({ serial: "din-home-test", generation: 1 }));
  const payload = { releaseId: packageSourceFingerprint(source), minimumStoreSchemaVersion: NATIVE_AUTOMATION_STORE_VERSION, storeSchemaVersion: NATIVE_AUTOMATION_STORE_VERSION };
  assert.equal(preflightCandidate(source, payload, { identityPath: identityDir }), payload.releaseId);
  payload.storeSchemaVersion -= 1;
  assert.throws(() => preflightCandidate(source, payload, { identityPath: identityDir }), /incompatible/);
});

test("candidate store compatibility executes the real Store against a disposable copy and preserves core rows", (t) => {
  const root = tempRoot(t);
  const dataFile = path.join(root, "data", "dinodia.json");
  fs.mkdirSync(path.dirname(dataFile));
  const state = initialState();
  state.identity.serial = "disposable-hub";
  state.setup.state = "PAIRED";
  state.areas["area:one"] = { id: "area:one", name: "Test area" };
  state.devices["device:one"] = { id: "device:one", areaId: "area:one", name: "Virtual device" };
  state.aliases["legacy:one"] = "device:one";
  fs.writeFileSync(dataFile, JSON.stringify(state), { mode: 0o600 });
  const expected = NATIVE_AUTOMATION_STORE_VERSION;
  const result = preflightStoreCopy(path.resolve(__dirname, ".."), dataFile, {
    minimumStoreSchemaVersion: expected, storeSchemaVersion: expected,
  }, { serviceUser: "unused-in-test", scratchRoot: path.join(root, "preflight"), runAsServiceUser: false });
  assert.deepEqual(result, { ok: true, version: expected });
  const persistedCopy = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(persistedCopy.identity.serial, "disposable-hub");
  assert.equal(persistedCopy.setup.state, "PAIRED");
  assert.deepEqual(Object.keys(persistedCopy.areas), ["area:one"]);
  assert.deepEqual(Object.keys(persistedCopy.devices), ["device:one"]);
  assert.deepEqual(Object.keys(persistedCopy.aliases), ["legacy:one"]);

  const tooOld = { ...state, version: expected - 1 };
  fs.writeFileSync(dataFile, JSON.stringify(tooOld), { mode: 0o600 });
  assert.throws(() => preflightStoreCopy(path.resolve(__dirname, ".."), dataFile, {
    minimumStoreSchemaVersion: expected, storeSchemaVersion: expected,
  }, { serviceUser: "unused-in-test", scratchRoot: path.join(root, "preflight"), runAsServiceUser: false }), /compatibility range/);
});

test("installed updater package layout matches systemd and loads all modules from the immutable release", (t) => {
  const root = tempRoot(t);
  const release = path.join(root, "releases", "native-v2-layout-test");
  const updaterDir = path.join(release, "src", "updater");
  const automationsDir = path.join(release, "src", "automations");
  fs.mkdirSync(updaterDir, { recursive: true });
  fs.mkdirSync(automationsDir, { recursive: true });
  for (const name of ["service.js", "executor.js", "releaseManifest.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", "src", "updater", name), path.join(updaterDir, name));
  }
  fs.copyFileSync(path.join(__dirname, "..", "src", "automations", "constants.js"), path.join(automationsDir, "constants.js"));
  const unit = fs.readFileSync(path.join(__dirname, "..", "systemd", "dinodia-os-updater.service"), "utf8");
  fs.writeFileSync(path.join(release, "dinodia-os-updater.service"), unit);
  const current = path.join(root, "current");
  fs.symlinkSync(release, current);
  const execStart = unit.match(/^ExecStart=\/usr\/bin\/node (\S+)$/m)?.[1];
  assert.ok(execStart);
  assert.ok(execStart.startsWith("/usr/lib/dinodia-os-updater/current/"));
  const relativeExecutable = execStart.slice("/usr/lib/dinodia-os-updater/current/".length);
  const installedExecutable = path.join(current, relativeExecutable);
  assert.equal(fs.existsSync(installedExecutable), true);
  const installedService = require(installedExecutable);
  assert.equal(typeof installedService.createUpdaterControlServer, "function");
  assert.equal(typeof installedService.preflightCandidate, "function");
  assert.equal(fs.existsSync(path.join(updaterDir, "executor.js")), true);
  assert.equal(fs.existsSync(path.join(updaterDir, "releaseManifest.js")), true);
});

test("local updater IPC exposes only status and signed-envelope apply, never arbitrary privileged commands", async (t) => {
  const root = tempRoot(t);
  const socketPath = path.join(root, "control.sock");
  const seen = [];
  const executor = {
    status: () => ({ phase: "idle", trustState: "unprovisioned" }),
    execute: async (envelope) => { seen.push(envelope); return { ok: true, status: { phase: "active" } }; },
    policy: { enabled: false },
  };
  const server = createUpdaterControlServer({ socketPath, executor, maxRequestBytes: 1024 });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.deepEqual(await send(socketPath, JSON.stringify({ operation: "status" })), { ok: true, status: { phase: "idle", trustState: "unprovisioned" } });
  const envelope = { payload: { releaseId: "native-v2-test" }, signature: "signed-test-envelope" };
  assert.deepEqual(await send(socketPath, JSON.stringify({ operation: "apply", envelope })), { ok: true, status: { phase: "active" } });
  assert.deepEqual(seen, [envelope]);
  assert.deepEqual(await send(socketPath, JSON.stringify({ operation: "apply", command: "arbitrary-root-command" })), { ok: false, code: "INVALID_REQUEST" });
  assert.equal(requestMatches({ operation: "apply", envelope, shell: "id" }), false);
  assert.deepEqual(await send(socketPath, "x".repeat(1100)), { ok: false, code: "REQUEST_TOO_LARGE" });
});
