"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { NativeReleaseExecutor } = require("./executor");
const { NATIVE_AUTOMATION_STORE_VERSION } = require("../automations/constants");

const POLICY_PATH = "/etc/dinodia-os/updater-policy.json";
const SOCKET_PATH = "/run/dinodia-os-updater/control.sock";
const CURRENT_LINK = "/opt/dinodia-os";
const RELEASE_ROOT = "/opt/dinodia-os-releases";
const ENV_PATH = "/opt/dinodia-os/.env";
const IDENTITY_PATH = "/etc/dinodia-os/identity";
const STATE_PATH = "/var/lib/dinodia-os-updater/state.json";
const MAX_REQUEST_BYTES = 16 * 1024;

function disabledPolicy() {
  return {
    enabled: false, approvedChannel: "stable", targetArch: "aarch64", apiVersion: 2,
    storeSchemaVersion: NATIVE_AUTOMATION_STORE_VERSION, signingKeyId: "", releaseSigningPublicKey: "",
    allowedArtifactHosts: [], maxManifestLifetimeMs: 7 * 24 * 60 * 60 * 1000,
    downloadTimeoutMs: 60_000, minimumFreeBytes: 64 * 1024 * 1024,
  };
}

function loadRootPolicy(policyPath = POLICY_PATH, { expectedOwnerUid = 0 } = {}) {
  try {
    const parent = fs.lstatSync(path.dirname(policyPath));
    const stat = fs.lstatSync(policyPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expectedOwnerUid
      || (parent.mode & 0o022) !== 0 || !stat.isFile() || stat.isSymbolicLink()
      || stat.uid !== expectedOwnerUid || (stat.mode & 0o077) !== 0) return disabledPolicy();
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const allowed = new Set(["enabled", "approvedChannel", "targetArch", "apiVersion", "storeSchemaVersion", "signingKeyId", "releaseSigningPublicKey", "allowedArtifactHosts", "maxManifestLifetimeMs", "downloadTimeoutMs", "minimumFreeBytes"]);
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some((key) => !allowed.has(key))) return disabledPolicy();
    if (policy.enabled !== true) return disabledPolicy();
    if (policy.approvedChannel !== "stable" || policy.targetArch !== "aarch64"
      || policy.apiVersion !== 2 || policy.storeSchemaVersion !== NATIVE_AUTOMATION_STORE_VERSION
      || typeof policy.signingKeyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(policy.signingKeyId)
      || typeof policy.releaseSigningPublicKey !== "string" || !Array.isArray(policy.allowedArtifactHosts)
      || policy.allowedArtifactHosts.length === 0
      || policy.allowedArtifactHosts.some((host) => typeof host !== "string" || host !== host.toLowerCase() || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host))) return disabledPolicy();
    const key = crypto.createPublicKey(policy.releaseSigningPublicKey);
    if (key.asymmetricKeyType !== "ed25519") return disabledPolicy();
    for (const [name, minimum, maximum] of [["maxManifestLifetimeMs", 60_000, 30 * 24 * 60 * 60 * 1000], ["downloadTimeoutMs", 1_000, 120_000], ["minimumFreeBytes", 64 * 1024 * 1024, 4 * 1024 * 1024 * 1024]]) {
      const value = policy[name];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) return disabledPolicy();
    }
    return { ...disabledPolicy(), ...policy };
  } catch {
    return disabledPolicy();
  }
}

function parseProductionEnv(filePath) {
  const values = new Map();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("unsafe environment file");
    values.set(match[1], match[2]);
  }
  return values;
}

function packageSourceFingerprint(sourceDir) {
  const files = [];
  const roots = ["src", "public", "scripts", "docker", "systemd", "docs"];
  for (const root of roots) {
    const rootPath = path.join(sourceDir, root);
    if (!fs.existsSync(rootPath)) continue;
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && entry.name === "__pycache__") continue;
        if (entry.isFile() && entry.name.endsWith(".pyc")) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() || entry.isSymbolicLink()) files.push(path.relative(sourceDir, absolute));
      }
    };
    visit(rootPath);
  }
  files.push("Dockerfile", "docker-compose.yml", "package.json", "package-lock.json", ".env.example", "requirements-hive.in", "requirements-hive.lock", "THIRD_PARTY_NOTICES.md");
  const hash = crypto.createHash("sha256");
  for (const relative of [...new Set(files)].sort((a, b) => a.localeCompare(b))) {
    const filePath = path.join(sourceDir, relative);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("candidate file inventory is invalid");
    const link = fs.lstatSync(filePath).isSymbolicLink();
    hash.update(relative).update("\0").update(link ? fs.readlinkSync(filePath) : fs.readFileSync(filePath)).update("\0");
  }
  return `native-v2-${hash.digest("hex").slice(0, 24)}`;
}

function preflightCandidate(sourceDir, payload, { identityPath = IDENTITY_PATH } = {}) {
  const values = parseProductionEnv(path.join(sourceDir, ".env"));
  if (values.get("NODE_ENV") !== "production" || String(values.get("DINODIA_PLATFORM_API_URL") || "").replace(/\/$/, "") !== "https://dinodia-platform-v2.vercel.app") throw new Error("candidate production origin is incompatible");
  for (const forbidden of ["DINODIA_ADMIN_TOKEN", "DINODIA_HA_TOKEN", "DINODIA_PLATFORM_TOKEN", "DINODIA_PLATFORM_BOOTSTRAP_SECRET", "DINODIA_HA_PORT", "DINODIA_HUB_AGENT_PORT", "DINODIA_HA_HOST", "DINODIA_PLATFORM_HEARTBEAT_URL", "DINODIA_STATE_CHANGE_URL", "DINODIA_STATE_CHANGE_SECRET", "DINODIA_HA_USERNAME", "STAGE1_INTERNAL_OPERATOR_DAY_SESSION"]) if (values.has(forbidden)) throw new Error("candidate has forbidden compatibility authority");
  for (const required of ["DINODIA_APP_PUBLIC_KEYS", "DINODIA_OPERATOR_PUBLIC_KEY", "DINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS"]) if (!String(values.get(required) || "").trim()) throw new Error("candidate authentication configuration is incomplete");
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  if (!packageJson.version || packageJson.version === "0.5.0") throw new Error("candidate package version is invalid");
  const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.optionalDependencies || {}) };
  const modulesRoot = path.join(sourceDir, "node_modules");
  if (!fs.statSync(modulesRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error("signed artifact is missing prebuilt runtime dependencies");
  for (const dependency of Object.keys(dependencies)) if (!fs.statSync(path.join(modulesRoot, dependency), { throwIfNoEntry: false })?.isDirectory()) throw new Error("signed artifact is missing a declared runtime dependency");
  const identity = JSON.parse(fs.readFileSync(path.join(identityPath, "identity.json"), "utf8"));
  if (!identity.serial || !Number.isInteger(Number(identity.generation)) || Number(identity.generation) < 1) throw new Error("enrolled identity is incomplete");
  const buildId = packageSourceFingerprint(sourceDir);
  if (buildId !== payload.releaseId || !Number.isSafeInteger(payload.minimumStoreSchemaVersion)
    || payload.minimumStoreSchemaVersion < 1 || payload.storeSchemaVersion !== NATIVE_AUTOMATION_STORE_VERSION
    || payload.minimumStoreSchemaVersion > NATIVE_AUTOMATION_STORE_VERSION) {
    throw new Error("candidate build or store schema identity is incompatible");
  }
  return buildId;
}

const STORE_PREFLIGHT_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [candidateDir, storePath, expectedVersion, minimumVersion] = process.argv.slice(1);
(async () => {
  const source = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : null;
  const sourceVersion = source == null ? Number(expectedVersion) : Number(source.version);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < Number(minimumVersion) || sourceVersion > Number(expectedVersion)) {
    throw new Error("STORE_SOURCE_VERSION_UNSUPPORTED");
  }
  const { Store } = require(path.join(candidateDir, "src", "store.js"));
  const store = new Store(storePath);
  if (Number(store.state?.version) !== Number(expectedVersion)) throw new Error("STORE_TARGET_VERSION_UNSUPPORTED");
  const before = source && {
    identitySerial: source.identity?.serial || "",
    setupState: source.setup?.state || "",
    areas: Object.keys(source.areas || {}).sort(),
    devices: Object.keys(source.devices || {}).sort(),
    aliases: Object.keys(source.aliases || {}).sort(),
  };
  await store.persist();
  const after = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (Number(after.version) !== Number(expectedVersion)) throw new Error("STORE_PERSISTED_VERSION_UNSUPPORTED");
  if (before && (before.identitySerial !== (after.identity?.serial || "")
    || before.setupState !== (after.setup?.state || "")
    || JSON.stringify(before.areas) !== JSON.stringify(Object.keys(after.areas || {}).sort())
    || JSON.stringify(before.devices) !== JSON.stringify(Object.keys(after.devices || {}).sort())
    || JSON.stringify(before.aliases) !== JSON.stringify(Object.keys(after.aliases || {}).sort()))) {
    throw new Error("STORE_CORE_DATA_CHANGED_DURING_PREFLIGHT");
  }
  process.stdout.write(JSON.stringify({ ok: true, version: after.version }));
})().catch(() => { process.stderr.write("STORE_PREFLIGHT_FAILED"); process.exitCode = 1; });
`;

/** Run the candidate Store migration against a disposable copy as the OS user. */
function preflightStoreCopy(candidateDir, dataFile, payload, {
  serviceUser = "dinodia", scratchRoot = path.join(path.dirname(dataFile), ".updater-preflight"),
  runAsServiceUser = process.getuid?.() === 0, timeoutMs = 20_000,
} = {}) {
  if (!path.isAbsolute(dataFile) || !Number.isSafeInteger(payload?.storeSchemaVersion)
    || !Number.isSafeInteger(payload?.minimumStoreSchemaVersion)) throw new Error("candidate store preflight inputs are invalid");
  const sourceStat = (() => {
    try { return fs.lstatSync(dataFile); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  })();
  if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 64 * 1024 * 1024)) {
    throw new Error("The durable OS store cannot be copied for compatibility preflight");
  }
  const source = sourceStat ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : null;
  if (source && (!Number.isSafeInteger(Number(source.version))
    || Number(source.version) < payload.minimumStoreSchemaVersion
    || Number(source.version) > payload.storeSchemaVersion)) throw new Error("The current OS store is outside the signed compatibility range");
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o711 });
  const scratchRootStat = fs.lstatSync(scratchRoot);
  if (!scratchRootStat.isDirectory() || scratchRootStat.isSymbolicLink()
    || process.getuid?.() === 0 && scratchRootStat.uid !== 0
    || (scratchRootStat.mode & 0o022) !== 0) throw new Error("The disposable updater preflight directory is not protected");
  if (process.getuid?.() === 0) fs.chmodSync(scratchRoot, 0o711);
  const scratch = fs.mkdtempSync(path.join(scratchRoot, "candidate-store-"));
  const copyPath = path.join(scratch, "dinodia.json");
  try {
    if (sourceStat) fs.copyFileSync(dataFile, copyPath, fs.constants.COPYFILE_EXCL);
    if (runAsServiceUser) {
      const account = spawnSync("/usr/bin/id", ["-u", serviceUser], { encoding: "utf8", timeout: 2_000, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
      const group = spawnSync("/usr/bin/id", ["-g", serviceUser], { encoding: "utf8", timeout: 2_000, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
      if (account.status !== 0 || group.status !== 0) throw new Error("The OS service account is unavailable for store preflight");
      const uid = Number(account.stdout.trim()); const gid = Number(group.stdout.trim());
      fs.chownSync(scratch, uid, gid); fs.chmodSync(scratch, 0o700);
      if (sourceStat) { fs.chownSync(copyPath, uid, gid); fs.chmodSync(copyPath, 0o600); }
    }
    const args = ["-e", STORE_PREFLIGHT_SCRIPT, path.resolve(candidateDir), copyPath,
      String(payload.storeSchemaVersion), String(payload.minimumStoreSchemaVersion)];
    const result = runAsServiceUser
      ? spawnSync("/usr/sbin/runuser", ["-u", serviceUser, "--", process.execPath, ...args], {
        encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024,
        env: { PATH: "/usr/bin:/bin", HOME: scratch, LANG: "C" },
      })
      : spawnSync(process.execPath, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: scratch, LANG: "C" } });
    if (result.error || result.status !== 0 || !/^\{"ok":true,"version":\d+\}$/.test(result.stdout || "")) {
      throw new Error("Candidate store-schema compatibility preflight failed");
    }
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function requestMatches(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.operation === "status") return Object.keys(input).length === 1;
  return input.operation === "apply" && Object.keys(input).length === 2
    && Object.hasOwn(input, "envelope") && input.envelope && typeof input.envelope === "object"
    && !Array.isArray(input.envelope) && Object.keys(input.envelope).sort().join("\n") === "payload\nsignature";
}

function createUpdaterControlServer({ socketPath = SOCKET_PATH, executor, groupId = null, maxRequestBytes = MAX_REQUEST_BYTES } = {}) {
  if (!executor || typeof executor.execute !== "function" || typeof executor.status !== "function") throw new TypeError("The updater control socket requires a fixed executor");
  const server = net.createServer((socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
    let data = Buffer.alloc(0);
    let replied = false;
    const reply = (value) => {
      if (replied) return;
      replied = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on("data", (chunk) => {
      if (replied) return socket.destroy();
      data = Buffer.concat([data, chunk]);
      if (data.length > maxRequestBytes) return reply({ ok: false, code: "REQUEST_TOO_LARGE" });
      const newline = data.indexOf(10);
      if (newline < 0) return;
      if (data.subarray(newline + 1).some((byte) => ![9, 10, 13, 32].includes(byte))) return reply({ ok: false, code: "INVALID_REQUEST" });
      let input;
      try { input = JSON.parse(data.subarray(0, newline).toString("utf8")); } catch { return reply({ ok: false, code: "INVALID_REQUEST" }); }
      if (!requestMatches(input)) return reply({ ok: false, code: "INVALID_REQUEST" });
      if (input.operation === "status") return reply({ ok: true, status: {
        ...executor.status(), trustState: executor.policy.enabled === true ? "ready" : "unprovisioned",
      } });
      void executor.execute(input.envelope).then(reply, () => reply({ ok: false, code: "UPDATE_FAILED" }));
    });
    socket.on("error", () => {});
  });
  return server;
}

function fixedCommand(binary, args, { timeout = 15_000 } = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/root", LANG: "C" } });
  if (result.error || result.status !== 0) throw new Error("fixed updater service operation failed");
  return result.stdout || "";
}

function getDinodiaGroupId() {
  for (const line of fs.readFileSync("/etc/group", "utf8").split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === "dinodia") return Number(fields[2]);
  }
  throw new Error("The Dinodia service group is unavailable");
}

async function main() {
  if (process.getuid?.() !== 0) throw new Error("updater must run as root");
  const policy = loadRootPolicy();
  const active = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(fs.realpathSync(CURRENT_LINK), "BUILD.json"), "utf8")); } catch { return null; }
  })();
  if (active?.mode !== "native-v2") throw new Error("the current Native V2 release identity is unavailable");
  const osEnvironment = parseProductionEnv(ENV_PATH);
  const dataDir = path.resolve(osEnvironment.get("DINODIA_DATA_DIR") || "/var/lib/dinodia-os");
  const dataFile = path.join(dataDir, "dinodia.json");
  const executor = new NativeReleaseExecutor({
    policy, releaseRoot: RELEASE_ROOT, currentLink: CURRENT_LINK, statePath: STATE_PATH, envPath: ENV_PATH, dataFile,
    serviceUser: "dinodia",
    preflight: (candidateDir, payload) => preflightCandidate(candidateDir, payload),
    storePreflight: (candidateDir, payload) => preflightStoreCopy(candidateDir, dataFile, payload, { serviceUser: "dinodia" }),
    stopService: async () => fixedCommand("/bin/systemctl", ["stop", "dinodia-os.service"]),
    startService: async () => fixedCommand("/bin/systemctl", ["start", "dinodia-os.service"]),
    healthCheck: async (expectedBuildId) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch("http://127.0.0.1:8123/api/health", { signal: controller.signal, redirect: "error" });
        const body = await response.json();
        if (!response.ok || body.ok !== true || typeof body.version !== "string"
          || Number(body.storeSchemaVersion) !== policy.storeSchemaVersion || !body.integrations || typeof body.integrations !== "object") return { ok: false };
        const build = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(CURRENT_LINK), "BUILD.json"), "utf8"));
        if (build.mode !== "native-v2" || build.buildId !== expectedBuildId
          || Number(build.storeSchemaVersion ?? body.storeSchemaVersion) !== policy.storeSchemaVersion) return { ok: false };
        return { ok: true, mode: "native-v2", buildId: build.buildId };
      } catch { return { ok: false }; }
      finally { clearTimeout(timeout); }
    },
  });
  const recovered = await executor.recoverInterruptedAttempt();
  if (!recovered.ok) throw new Error("interrupted updater attempt could not be safely restored");
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o755 });
  try {
    const stat = fs.lstatSync(SOCKET_PATH);
    if (!stat.isSocket()) throw new Error("refusing to replace a non-socket updater control path");
    const probe = net.createConnection(SOCKET_PATH);
    const alreadyActive = await new Promise((resolve) => {
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (alreadyActive) throw new Error("another updater control service is already active");
    fs.unlinkSync(SOCKET_PATH);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = createUpdaterControlServer({ socketPath: SOCKET_PATH, executor, groupId: getDinodiaGroupId() });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(SOCKET_PATH, resolve); });
  try {
    fs.chmodSync(SOCKET_PATH, 0o660);
    fs.chownSync(SOCKET_PATH, 0, getDinodiaGroupId());
  } catch {
    await new Promise((resolve) => server.close(resolve));
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    throw new Error("the updater control socket permissions are unavailable");
  }
  const stop = () => server.close(() => { try { fs.unlinkSync(SOCKET_PATH); } catch {} });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) main().catch(() => { process.stderr.write("Dinodia updater service failed closed\n"); process.exitCode = 1; });

module.exports = { loadRootPolicy, packageSourceFingerprint, preflightCandidate, preflightStoreCopy, requestMatches, createUpdaterControlServer, disabledPolicy, MAX_REQUEST_BYTES };
