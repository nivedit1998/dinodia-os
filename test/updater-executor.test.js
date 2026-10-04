"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const zlib = require("node:zlib");
const test = require("node:test");
const { NativeReleaseExecutor, sealReleaseForRuntime } = require("../src/updater/executor");
const { canonicalJson } = require("../src/updater/releaseManifest");

const fixedNow = Date.parse("2026-10-04T12:00:00.000Z");
const keys = crypto.generateKeyPairSync("ed25519");
const releaseId = (last) => `native-v2-${String(last).padStart(24, "0")}`;

function removeReadonlyTree(root) {
  if (!fs.existsSync(root)) return;
  const info = fs.lstatSync(root);
  if (info.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) removeReadonlyTree(path.join(root, name));
  } else if (!info.isSymbolicLink()) {
    fs.chmodSync(root, 0o600);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture(t, { healthFailures = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-updater-executor-"));
  t.after(() => removeReadonlyTree(root));
  const releaseRoot = path.join(root, "releases");
  const oldId = releaseId(1);
  const oldRelease = path.join(releaseRoot, oldId);
  fs.mkdirSync(oldRelease, { recursive: true });
  fs.writeFileSync(path.join(oldRelease, "BUILD.json"), JSON.stringify({ buildId: oldId, packageVersion: "4.0.0", mode: "native-v2" }));
  fs.writeFileSync(path.join(oldRelease, "marker"), "old-release");
  const currentLink = path.join(root, "dinodia-os");
  fs.symlinkSync(oldRelease, currentLink);
  const envPath = path.join(root, "production.env");
  fs.writeFileSync(envPath, "DISPOSABLE_TEST_ONLY=value\n", { mode: 0o600 });
  const dataFile = path.join(root, "data", "dinodia.json");
  fs.mkdirSync(path.dirname(dataFile));
  fs.writeFileSync(dataFile, "old-compatible-store\n", { mode: 0o600 });
  const statePath = path.join(root, "state", "updater.json");
  const policy = {
    enabled: true,
    approvedChannel: "stable",
    targetArch: "aarch64",
    apiVersion: 2,
    storeSchemaVersion: 3,
    signingKeyId: "disposable-test-only",
    releaseSigningPublicKey: keys.publicKey,
    allowedArtifactHosts: ["releases.example.invalid"],
    minimumFreeBytes: 1024,
    downloadTimeoutMs: 5_000,
  };
  let archive = null;
  let shouldBlockDownload = null;
  const executor = new NativeReleaseExecutor({
    policy,
    releaseRoot,
    currentLink,
    statePath,
    envPath,
    dataFile,
    now: () => fixedNow,
    limits: { healthAttempts: 1, healthDelayMs: 0, archiveBytes: 4 * 1024 * 1024, expandedBytes: 8 * 1024 * 1024 },
    fetchImpl: async (url) => {
      const bytes = archive;
      if (shouldBlockDownload) await shouldBlockDownload;
      return { ok: true, url, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    preflight: async (candidateDir, payload) => {
      assert.equal(fs.readFileSync(path.join(candidateDir, "marker"), "utf8"), payload.releaseId);
      assert.equal(fs.readFileSync(path.join(candidateDir, ".env"), "utf8"), "DISPOSABLE_TEST_ONLY=value\n");
      return payload.releaseId;
    },
    storePreflight: async (candidateDir, payload) => {
      assert.equal(fs.existsSync(candidateDir), true);
      assert.equal(payload.storeSchemaVersion, 3);
      return { ok: true };
    },
    stopService: async () => {},
    startService: async () => {},
    healthCheck: async (expected) => {
      if (healthFailures.includes(expected) && fs.realpathSync(currentLink).endsWith(expected)) {
        fs.writeFileSync(dataFile, "candidate-mutated-store\n");
      }
      const real = fs.realpathSync(currentLink);
      const build = JSON.parse(fs.readFileSync(path.join(real, "BUILD.json"), "utf8"));
      const healthy = build.buildId === expected && !healthFailures.includes(expected);
      return { ok: healthy, mode: build.mode, buildId: build.buildId };
    },
    sleep: async () => {},
  });
  function artifactFor(id) {
    const source = path.join(root, `source-${id}`);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "marker"), id);
    const archivePath = path.join(root, `artifact-${id}.tar.gz`);
    execFileSync("tar", ["--format=ustar", "--owner=0", "--group=0", "--numeric-owner", "-czf", archivePath, "-C", source, "."]);
    return fs.readFileSync(archivePath);
  }
  function envelope(id, version, attempt, artifactBytes) {
    archive = artifactBytes;
    const payload = {
      version: 1,
      releaseId: id,
      releaseVersion: version,
      channel: "stable",
      targetArch: "aarch64",
      minimumApiVersion: 2,
      apiVersion: 2,
      minimumStoreSchemaVersion: 3,
      storeSchemaVersion: 3,
      artifactUrl: `https://releases.example.invalid/native/${id}.tar.gz`,
      artifactSha256: crypto.createHash("sha256").update(artifactBytes).digest("hex"),
      signingKeyId: "disposable-test-only",
      releasedAt: "2026-10-04T11:00:00Z",
      expiresAt: "2026-10-05T11:00:00Z",
      rollbackPolicy: "restore-previous-release",
      attemptId: attempt,
    };
    return { payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey).toString("base64url") };
  }
  return { root, releaseRoot, oldRelease, oldId, currentLink, statePath, dataFile, executor, artifactFor, envelope, setBlockedDownload(promise) { shouldBlockDownload = promise; } };
}

function unsafeTarGzip(name, contents) {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512, 0);
  const put = (offset, length, value) => Buffer.from(String(value)).copy(header, offset, 0, Math.min(length, Buffer.byteLength(String(value))));
  const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";
  put(0, 100, name);
  put(100, 8, octal(0o644, 8));
  put(108, 8, octal(0, 8));
  put(116, 8, octal(0, 8));
  put(124, 12, octal(data.length, 12));
  put(136, 12, octal(1, 12));
  header.fill(32, 148, 156);
  put(156, 1, "0");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - data.length % 512) % 512, 0);
  return zlib.gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024, 0)]));
}

test("executor activates a signed disposable release, reconciles exact retry, restores a failing candidate and forwards safely", async (t) => {
  const f = fixture(t, { healthFailures: [releaseId(3)] });
  const firstId = releaseId(2);
  const first = f.envelope(firstId, "4.1.0", "attempt-00000001", f.artifactFor(firstId));
  const activated = await f.executor.execute(first);
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.equal(activated.status.phase, "active");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.currentLink, "BUILD.json"), "utf8")).buildId, firstId);
  assert.equal(fs.readFileSync(path.join(f.currentLink, ".env"), "utf8"), "DISPOSABLE_TEST_ONLY=value\n");
  const exactRetry = await f.executor.execute(first);
  assert.equal(exactRetry.ok, true);
  assert.equal(exactRetry.idempotent, true);

  const failingId = releaseId(3);
  const failing = f.envelope(failingId, "4.2.0", "attempt-00000002", f.artifactFor(failingId));
  const rejected = await f.executor.execute(failing);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "CANDIDATE_HEALTH_FAILED");
  assert.equal(rejected.status.phase, "rolled_back");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.currentLink, "BUILD.json"), "utf8")).buildId, firstId);
  assert.equal(fs.readFileSync(f.dataFile, "utf8"), "old-compatible-store\n", "failed candidate data is replaced with the paired previous-release snapshot");

  const forwardId = releaseId(4);
  const forward = f.envelope(forwardId, "4.3.0", "attempt-00000003", f.artifactFor(forwardId));
  const recovered = await f.executor.execute(forward);
  assert.equal(recovered.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.currentLink, "BUILD.json"), "utf8")).buildId, forwardId);
  const activeRoot = fs.realpathSync(f.currentLink);
  assert.equal(fs.statSync(activeRoot).mode & 0o777, 0o555, "activated release root is traversable but not writable by the runtime account");
  assert.equal(fs.statSync(activeRoot).mode & 0o022, 0, "activated release root is not group/world writable");
  assert.equal(fs.statSync(path.join(activeRoot, "marker")).mode & 0o777, 0o444, "release payload is readable and immutable to the runtime account");
});

test("runtime sealing preserves the private environment mode and rejects links escaping the release", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-updater-seal-"));
  t.after(() => removeReadonlyTree(root));
  const nested = path.join(root, "src", "updater");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, ".env"), "DISPOSABLE_TEST_ONLY=value\n", { mode: 0o600 });
  fs.writeFileSync(path.join(nested, "service.js"), "module.exports = true\n", { mode: 0o644 });
  sealReleaseForRuntime(root);
  assert.equal(fs.statSync(root).mode & 0o777, 0o555);
  assert.equal(fs.statSync(path.join(nested, "service.js")).mode & 0o777, 0o444);
  assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);

  const badRoot = `${root}-bad`;
  const other = `${root}-outside`;
  fs.mkdirSync(badRoot);
  fs.mkdirSync(other);
  t.after(() => removeReadonlyTree(badRoot));
  t.after(() => removeReadonlyTree(other));
  fs.symlinkSync(other, path.join(badRoot, "escape"));
  assert.throws(() => sealReleaseForRuntime(badRoot), /outside its immutable root/);
});

test("manifest-only commands, invalid signature and unsafe archive paths cannot stop or switch the service", async (t) => {
  const f = fixture(t);
  const originalTarget = fs.readlinkSync(f.currentLink);
  const id = releaseId(2);
  const bytes = f.artifactFor(id);
  const envelope = f.envelope(id, "4.1.0", "attempt-00000011", bytes);
  let forged = { ...envelope, signature: Buffer.from("not a signature").toString("base64url") };
  assert.equal((await f.executor.execute(forged)).ok, false);
  assert.equal((await f.executor.execute({ command: "arbitrary-root-command" })).code, "MANIFEST_SHAPE_INVALID");
  assert.equal(fs.readlinkSync(f.currentLink), originalTarget);

  fs.writeFileSync(path.join(f.root, "escape"), "must never be extracted outside staging");
  const malformed = unsafeTarGzip("../escape", "attacker-controlled-path");
  const envelopeForBadArchive = f.envelope(releaseId(5), "4.1.0", "attempt-00000012", malformed);
  const before = fs.readlinkSync(f.currentLink);
  assert.equal((await f.executor.execute(envelopeForBadArchive)).ok, false);
  assert.equal(fs.readlinkSync(f.currentLink), before);
  assert.equal(fs.readFileSync(path.join(f.root, "escape"), "utf8"), "must never be extracted outside staging");
});

test("one concurrent update wins and interrupted activation restores the recorded prior release", async (t) => {
  const f = fixture(t);
  let resume;
  const blocked = new Promise((resolve) => { resume = resolve; });
  f.setBlockedDownload(blocked);
  const id = releaseId(2);
  const pending = f.executor.execute(f.envelope(id, "4.1.0", "attempt-00000021", f.artifactFor(id)));
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await f.executor.execute(f.envelope(releaseId(3), "4.2.0", "attempt-00000022", f.artifactFor(releaseId(3))));
  assert.equal(concurrent.code, "UPDATE_ALREADY_RUNNING");
  resume();
  const pendingResult = await pending;
  assert.equal(pendingResult.ok, true, JSON.stringify(pendingResult));

  const prior = { kind: "symlink", target: path.join(f.releaseRoot, f.oldId), resolved: path.join(f.releaseRoot, f.oldId) };
  const backupRoot = path.join(path.dirname(f.statePath), "store-backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const storeBackupPath = path.join(backupRoot, "attempt-interrupted.json");
  fs.writeFileSync(storeBackupPath, "pre-interruption-store\n", { mode: 0o600 });
  const backupStat = fs.statSync(f.dataFile);
  const storeBackup = {
    kind: "file", target: storeBackupPath,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(storeBackupPath)).digest("hex"),
    size: fs.statSync(storeBackupPath).size,
    uid: backupStat.uid, gid: backupStat.gid, mode: backupStat.mode & 0o777,
  };
  const interruptedId = releaseId(9);
  fs.mkdirSync(path.join(f.releaseRoot, interruptedId), { recursive: true });
  fs.writeFileSync(path.join(f.releaseRoot, interruptedId, "BUILD.json"), JSON.stringify({ buildId: interruptedId, packageVersion: "9.0.0", mode: "native-v2" }));
  const replacement = `${f.currentLink}.interrupted`;
  fs.symlinkSync(path.join(f.releaseRoot, interruptedId), replacement);
  fs.renameSync(replacement, f.currentLink);
  fs.writeFileSync(f.statePath, JSON.stringify({ version: 1, phase: "health_check", activeRelease: { releaseId: id, releaseVersion: "4.1.0", manifestDigest: "test" }, usedAttemptIds: [], previousTarget: prior, previousBuildId: f.oldId, storeBackup, lastAttempt: { attemptId: "attempt-interrupted", releaseId: interruptedId, phase: "health_check" } }));
  const recovery = new (require("../src/updater/executor").NativeReleaseExecutor)({
    policy: { enabled: true }, releaseRoot: f.releaseRoot, currentLink: f.currentLink, statePath: f.statePath,
    envPath: path.join(f.root, "production.env"), dataFile: f.dataFile, now: () => fixedNow, fetchImpl: async () => { throw new Error("unused"); },
    preflight: async () => "unused", storePreflight: async () => ({}), stopService: async () => {}, startService: async () => {},
    healthCheck: async (expected) => ({ ok: true, mode: "native-v2", buildId: expected }),
  });
  const restored = await recovery.recoverInterruptedAttempt();
  assert.equal(restored.ok, true);
  assert.equal(restored.recovered, true);
  assert.equal(fs.readlinkSync(f.currentLink), prior.target);
  assert.equal(fs.readFileSync(f.dataFile, "utf8"), "pre-interruption-store\n");
});
