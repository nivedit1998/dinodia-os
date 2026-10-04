"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { verifyArtifactDigest, verifyReleaseManifest } = require("./releaseManifest");

const DEFAULT_LIMITS = Object.freeze({
  manifestBytes: 16 * 1024,
  archiveBytes: 256 * 1024 * 1024,
  expandedBytes: 1024 * 1024 * 1024,
  storeBytes: 64 * 1024 * 1024,
  entries: 100_000,
  healthAttempts: 30,
  healthDelayMs: 2_000,
});

function safeComponent(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)
    && !value.includes("..") && value !== ".";
}

function parseOctal(header, start, length) {
  const text = header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("The update archive contains an invalid numeric field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("The update archive exceeds a safe numeric bound");
  return value;
}

function safeArchivePath(rawName) {
  let name = String(rawName || "");
  if (name.startsWith("./")) name = name.slice(2);
  if (name.endsWith("/")) name = name.slice(0, -1);
  if (!name || name.startsWith("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/.test(name)) {
    if (rawName === "./" || rawName === ".") return "";
    throw new Error("The update archive contains an unsafe path");
  }
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("The update archive contains an unsafe path");
  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part) || /\.(?:key|pem)$/i.test(part))) {
    throw new Error("The update archive contains forbidden environment or private-key material");
  }
  return parts.join("/");
}

/** Extract only bounded USTAR regular files, directories and in-tree symlinks. */
function extractSafeUstarGzip(compressed, destination, limits = DEFAULT_LIMITS) {
  if (!Buffer.isBuffer(compressed) || compressed.length === 0 || compressed.length > limits.archiveBytes) {
    throw new Error("The signed release archive exceeds its compressed size bound");
  }
  const tar = zlib.gunzipSync(compressed, { maxOutputLength: limits.expandedBytes });
  if (tar.length > limits.expandedBytes) throw new Error("The signed release archive exceeds its expanded size bound");
  try {
    const destinationStat = fs.lstatSync(destination);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() || fs.readdirSync(destination).length !== 0) {
      throw new Error("The private release staging directory must be a new, empty directory");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  }
  const seen = new Set();
  const links = [];
  let offset = 0;
  let count = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    count += 1;
    if (count > limits.entries) throw new Error("The signed release archive has too many entries");
    const expectedChecksum = parseOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let i = 0; i < header.length; i += 1) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
    if (actualChecksum !== expectedChecksum) throw new Error("The signed release archive has a corrupt header");
    const namePart = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const name = safeArchivePath(prefix ? `${prefix}/${namePart}` : namePart);
    const size = parseOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const linkName = header.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length || !Number.isSafeInteger(dataEnd)) throw new Error("The signed release archive is truncated");
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (!name) continue;
    if (seen.has(name)) throw new Error("The signed release archive contains duplicate paths");
    seen.add(name);
    const target = path.join(destination, ...name.split("/"));
    const root = path.resolve(destination);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("The signed release archive escapes its staging directory");
    if (type === "5") {
      if (size !== 0) throw new Error("The signed release archive contains a malformed directory");
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    } else if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const modeBits = parseOctal(header, 100, 8) & 0o777;
      const mode = modeBits & 0o111 ? 0o755 : 0o644;
      const descriptor = fs.openSync(target, "wx", mode);
      try { fs.writeFileSync(descriptor, tar.subarray(dataStart, dataEnd)); } finally { fs.closeSync(descriptor); }
    } else if (type === "2") {
      if (size !== 0 || !linkName || path.isAbsolute(linkName) || linkName.includes("\\") || /[\u0000-\u001f\u007f]/.test(linkName)) {
        throw new Error("The signed release archive contains an unsafe symbolic link");
      }
      const resolved = path.resolve(path.dirname(target), linkName);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("The signed release archive contains an escaping symbolic link");
      links.push({ target, linkName, resolved });
    } else {
      throw new Error("The signed release archive contains an unsupported link, extension or special file");
    }
  }
  for (const link of links) {
    fs.mkdirSync(path.dirname(link.target), { recursive: true, mode: 0o755 });
    fs.symlinkSync(link.linkName, link.target);
  }
  for (const link of links) {
    let resolved;
    try { resolved = fs.realpathSync(link.target); } catch { throw new Error("The signed release archive contains a broken symbolic link"); }
    const root = path.resolve(destination);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("The signed release archive contains an escaping symbolic link");
  }
  return { entries: count, expandedBytes: tar.length };
}

function writeJsonAtomically(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode, flag: "wx" });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}

/** Seal an extracted release for a read-only, non-root runtime before activation. */
function sealReleaseForRuntime(rootPath) {
  const root = fs.realpathSync(rootPath);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(target);
        const relative = path.relative(root, resolved);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error("The staged release contains a link outside its immutable root");
        }
        continue;
      }
      if (stat.isDirectory()) {
        visit(target);
        fs.chmodSync(target, 0o555);
      } else if (stat.isFile()) {
        if (entry.name === ".env") continue;
        fs.chmodSync(target, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
      } else {
        throw new Error("The staged release contains a non-regular filesystem entry");
      }
    }
  };
  visit(root);
  fs.chmodSync(root, 0o555);
}

class NativeReleaseExecutor {
  constructor({
    policy,
    releaseRoot,
    currentLink,
    statePath,
    envPath,
    dataFile,
    serviceUser = "dinodia",
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    limits = {},
    preflight,
    storePreflight,
    stopService = async () => {},
    startService = async () => {},
    healthCheck,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!policy || !releaseRoot || !currentLink || !statePath || !envPath || !dataFile
      || typeof fetchImpl !== "function" || typeof preflight !== "function"
      || typeof storePreflight !== "function" || typeof healthCheck !== "function") {
      throw new TypeError("The native updater requires root-owned policy, paths and guarded health/preflight handlers");
    }
    this.policy = policy;
    // macOS resolves /tmp to /private/tmp. Canonicalize an existing release
    // root so test and recovery containment checks compare like-for-like paths.
    this.releaseRoot = fs.existsSync(releaseRoot) ? fs.realpathSync(path.resolve(releaseRoot)) : path.resolve(releaseRoot);
    this.currentLink = path.resolve(currentLink);
    this.statePath = path.resolve(statePath);
    this.envPath = path.resolve(envPath);
    this.dataFile = path.resolve(dataFile);
    this.serviceUser = serviceUser;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.preflight = preflight;
    this.storePreflight = storePreflight;
    this.stopService = stopService;
    this.startService = startService;
    this.healthCheck = healthCheck;
    this.sleep = sleep;
    this.busy = false;
    this.state = this.#readState();
    this.#seedActiveReleaseFromCurrentBuild();
  }

  #seedActiveReleaseFromCurrentBuild() {
    if (this.state.activeRelease?.releaseVersion) return;
    try {
      const target = this.#activeTarget();
      if (!target) return;
      const build = JSON.parse(fs.readFileSync(path.join(target.resolved, "BUILD.json"), "utf8"));
      if (build.mode !== "native-v2" || !safeComponent(build.buildId)
        || build.buildId !== path.basename(target.resolved)
        || typeof build.packageVersion !== "string") return;
      this.state = { ...this.state, activeRelease: {
        releaseId: build.buildId,
        releaseVersion: build.packageVersion,
        manifestDigest: null,
      } };
    } catch {}
  }

  #readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (state?.version === 1 && Array.isArray(state.usedAttemptIds)) return state;
    } catch {}
    return { version: 1, phase: "idle", usedAttemptIds: [], activeRelease: null, lastAttempt: null };
  }

  #saveState(next) {
    this.state = { ...this.state, ...next, updatedAt: new Date(this.now()).toISOString() };
    writeJsonAtomically(this.statePath, this.state, 0o600);
  }

  status() {
    const attempt = this.state.lastAttempt;
    return {
      phase: this.state.phase || "idle",
      activeReleaseId: this.state.activeRelease?.releaseId || null,
      activeReleaseVersion: this.state.activeRelease?.releaseVersion || null,
      lastAttempt: attempt ? { attemptId: attempt.attemptId, releaseId: attempt.releaseId, phase: attempt.phase, result: attempt.result || null, updatedAt: attempt.updatedAt || null } : null,
      busy: this.busy,
    };
  }

  async #download(payload) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.min(120_000, Number(this.policy.downloadTimeoutMs || 60_000)));
    try {
      const response = await this.fetchImpl(payload.artifactUrl, { redirect: "error", signal: abort.signal, headers: { Accept: "application/gzip, application/octet-stream" } });
      if (!response?.ok || response.url && new URL(response.url).hostname !== new URL(payload.artifactUrl).hostname) throw new Error("The approved signed release artifact could not be fetched");
      const declared = Number(response.headers?.get?.("content-length") || 0);
      if (declared > this.limits.archiveBytes) throw new Error("The signed release artifact exceeds its download bound");
      const chunks = [];
      let length = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > this.limits.archiveBytes) { await reader.cancel(); throw new Error("The signed release artifact exceeds its download bound"); }
          chunks.push(Buffer.from(value));
        }
      } else {
        const value = Buffer.from(await response.arrayBuffer());
        if (value.length > this.limits.archiveBytes) throw new Error("The signed release artifact exceeds its download bound");
        chunks.push(value); length = value.length;
      }
      return Buffer.concat(chunks, length);
    } finally { clearTimeout(timer); }
  }

  #copyEnvironment(candidateDir) {
    const stat = fs.statSync(this.envPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("The existing private OS environment file is unavailable or has unsafe permissions");
    const target = path.join(candidateDir, ".env");
    fs.copyFileSync(this.envPath, target, fs.constants.COPYFILE_EXCL);
    try { fs.chownSync(target, stat.uid, stat.gid); }
    catch {
      const copied = fs.statSync(target);
      if (copied.uid !== stat.uid || copied.gid !== stat.gid) {
        fs.unlinkSync(target);
        throw new Error("The existing private environment owner could not be preserved");
      }
    }
    fs.chmodSync(target, stat.mode & 0o777);
  }

  #activeTarget() {
    try {
      const stat = fs.lstatSync(this.currentLink);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(this.currentLink);
        const relative = path.relative(this.releaseRoot, resolved);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("The active release symlink escapes its immutable release root");
        return { kind: "symlink", target: fs.readlinkSync(this.currentLink), resolved };
      }
      if (stat.isDirectory()) return { kind: "directory", resolved: this.currentLink };
      throw new Error("The active OS path is neither a release symlink nor a directory");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #switchTo(releasePath, previous, attemptId) {
    const link = `${this.currentLink}.candidate-${attemptId}`;
    try { fs.unlinkSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous?.kind === "directory") {
      const saved = `${this.currentLink}.legacy-${attemptId}`;
      fs.renameSync(this.currentLink, saved);
      this.#saveState({ legacyPath: saved });
    }
    fs.symlinkSync(releasePath, link);
    fs.renameSync(link, this.currentLink);
  }

  #backupStore(attemptId) {
    const backupRoot = path.join(path.dirname(this.statePath), "store-backups");
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const target = path.join(backupRoot, `${attemptId}.json`);
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(this.dataFile);
    } catch (error) {
      if (error.code === "ENOENT") return { kind: "missing", target: null };
      throw error;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > this.limits.storeBytes) {
      throw new Error("The durable OS store cannot be snapshotted safely");
    }
    fs.copyFileSync(this.dataFile, target, fs.constants.COPYFILE_EXCL);
    if (process.getuid?.() === 0) fs.chownSync(target, 0, 0);
    fs.chmodSync(target, 0o600);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    return {
      kind: "file", target, sha256: digest, size: sourceStat.size,
      uid: sourceStat.uid, gid: sourceStat.gid, mode: sourceStat.mode & 0o777,
    };
  }

  #restoreStore(backup) {
    if (!backup) throw new Error("The candidate has no compatible-data rollback snapshot");
    if (backup.kind === "missing") {
      try {
        const current = fs.lstatSync(this.dataFile);
        if (!current.isFile() || current.isSymbolicLink()) throw new Error("The OS store path changed unsafely during update");
        fs.unlinkSync(this.dataFile);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      return;
    }
    const backupRoot = path.resolve(path.dirname(this.statePath), "store-backups");
    const target = path.resolve(String(backup.target || ""));
    if (backup.kind !== "file" || !target.startsWith(`${backupRoot}${path.sep}`)
      || !/^[a-f0-9]{64}$/.test(String(backup.sha256 || ""))
      || !Number.isSafeInteger(backup.uid) || !Number.isSafeInteger(backup.gid)
      || !Number.isSafeInteger(backup.mode) || !Number.isSafeInteger(backup.size)
      || backup.size < 0 || backup.size > this.limits.storeBytes) {
      throw new Error("The compatible-data rollback snapshot metadata is invalid");
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== backup.size
      || crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== backup.sha256) {
      throw new Error("The compatible-data rollback snapshot failed integrity verification");
    }
    const parent = path.dirname(this.dataFile);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${this.dataFile}.restore-${crypto.randomBytes(8).toString("hex")}`;
    fs.copyFileSync(target, temporary, fs.constants.COPYFILE_EXCL);
    try {
      fs.chownSync(temporary, backup.uid, backup.gid);
      fs.chmodSync(temporary, backup.mode);
      fs.renameSync(temporary, this.dataFile);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  async #health(expectedBuildId) {
    for (let attempt = 0; attempt < this.limits.healthAttempts; attempt += 1) {
      const result = await this.healthCheck(expectedBuildId);
      if (result?.ok === true && result.mode === "native-v2" && result.buildId === expectedBuildId) return true;
      if (attempt + 1 < this.limits.healthAttempts) await this.sleep(this.limits.healthDelayMs);
    }
    return false;
  }

  async #restore(previous, attemptId, expectedPreviousBuildId) {
    await this.stopService();
    if (previous?.kind === "symlink") {
      const temporary = `${this.currentLink}.rollback-${attemptId}`;
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      fs.symlinkSync(previous.target, temporary);
      fs.renameSync(temporary, this.currentLink);
    } else if (previous?.kind === "directory") {
      try { fs.unlinkSync(this.currentLink); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const legacy = this.state.legacyPath;
      if (!legacy || !fs.existsSync(legacy)) throw new Error("The prior directory layout cannot be restored");
      fs.renameSync(legacy, this.currentLink);
    } else {
      throw new Error("There is no verified previous OS release to restore");
    }
    if (["activating", "health_check"].includes(this.state.phase) && !this.state.storeBackup) {
      throw new Error("The activated candidate has no compatible-data rollback snapshot");
    }
    if (this.state.storeBackup) this.#restoreStore(this.state.storeBackup);
    await this.startService();
    if (expectedPreviousBuildId && !await this.#health(expectedPreviousBuildId)) throw new Error("The previous OS release failed its recovery health gate");
  }

  async execute(envelope) {
    if (this.busy || ["downloading", "verifying", "staged", "maintenance", "activating", "health_check"].includes(this.state.phase)) {
      return { ok: false, code: "UPDATE_ALREADY_RUNNING", status: this.status() };
    }
    this.busy = true;
    let stagePath = null;
    let releasePath = null;
    let previous = null;
    let switched = false;
    let activationAttempted = false;
    let serviceStopAttempted = false;
    let restoredStoreBackupPath = null;
    let payload = null;
    let attemptId = null;
    try {
      if (this.policy.enabled !== true) throw Object.assign(new Error("The release trust policy is not provisioned"), { code: "UPDATER_DISABLED" });
      let envelopeBytes;
      try { envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8"); }
      catch { throw Object.assign(new Error("The signed release manifest is malformed"), { code: "MANIFEST_SHAPE_INVALID" }); }
      if (envelopeBytes > this.limits.manifestBytes) throw Object.assign(new Error("The signed release manifest exceeds its size bound"), { code: "MANIFEST_TOO_LARGE" });
      const verified = verifyReleaseManifest(envelope, this.policy, { now: this.now(), activeRelease: this.state.activeRelease, usedAttemptIds: this.state.usedAttemptIds });
      if (!verified.ok) return { ok: false, code: verified.code, status: this.status() };
      if (verified.idempotent) return { ok: true, idempotent: true, status: this.status() };
      payload = verified.payload;
      attemptId = payload.attemptId;
      if (!safeComponent(payload.releaseId)) throw Object.assign(new Error("The release identity is invalid"), { code: "RELEASE_ID_INVALID" });
      previous = this.#activeTarget();
      if (!previous) throw Object.assign(new Error("No current release exists to recover"), { code: "PREVIOUS_RELEASE_UNAVAILABLE" });
      const previousBuildId = path.basename(previous.resolved);
      fs.mkdirSync(this.releaseRoot, { recursive: true, mode: 0o755 });
      releasePath = path.join(this.releaseRoot, payload.releaseId);
      if (fs.existsSync(releasePath)) throw Object.assign(new Error("Release directories are immutable and cannot be replaced"), { code: "RELEASE_ALREADY_EXISTS" });
      const attempt = { attemptId, releaseId: payload.releaseId, phase: "downloading", updatedAt: new Date(this.now()).toISOString() };
      this.#saveState({ phase: "downloading", lastAttempt: attempt, legacyPath: null });
      const bytes = await this.#download(payload);
      if (!verifyArtifactDigest(bytes, payload.artifactSha256)) throw Object.assign(new Error("The downloaded release hash does not match its signed manifest"), { code: "ARTIFACT_HASH_MISMATCH" });
      this.#saveState({ phase: "verifying", lastAttempt: { ...attempt, phase: "verifying", updatedAt: new Date(this.now()).toISOString() } });
      stagePath = fs.mkdtempSync(path.join(this.releaseRoot, `.stage-${payload.releaseId}-`));
      extractSafeUstarGzip(bytes, stagePath, this.limits);
      this.#copyEnvironment(stagePath);
      const candidateBuildId = await this.preflight(stagePath, payload);
      if (candidateBuildId !== payload.releaseId) throw Object.assign(new Error("The staged source fingerprint does not match its signed release identity"), { code: "BUILD_ID_MISMATCH" });
      const buildRecord = { buildId: candidateBuildId, packageVersion: payload.releaseVersion, mode: "native-v2", storeSchemaVersion: payload.storeSchemaVersion };
      fs.writeFileSync(path.join(stagePath, "BUILD.json"), `${JSON.stringify(buildRecord)}\n`, { mode: 0o644, flag: "wx" });
      sealReleaseForRuntime(stagePath);
      await this.storePreflight(stagePath, payload);
      this.#saveState({ phase: "staged", lastAttempt: { ...attempt, phase: "staged", updatedAt: new Date(this.now()).toISOString() } });
      fs.renameSync(stagePath, releasePath);
      stagePath = null;
      const disk = fs.statfsSync(this.releaseRoot);
      const availableBytes = Number(disk.bavail) * Number(disk.bsize);
      let storeBytes = 0;
      try {
        const storeStat = fs.lstatSync(this.dataFile);
        if (!storeStat.isFile() || storeStat.isSymbolicLink() || storeStat.size > this.limits.storeBytes) {
          throw Object.assign(new Error("The durable OS store cannot be snapshotted safely"), { code: "STORE_BACKUP_UNSAFE" });
        }
        storeBytes = storeStat.size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const requiredFreeBytes = Number(this.policy.minimumFreeBytes || 64 * 1024 * 1024) + storeBytes;
      if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(requiredFreeBytes) || availableBytes < requiredFreeBytes) {
        throw Object.assign(new Error("Insufficient free space for a recoverable release activation"), { code: "INSUFFICIENT_UPDATE_SPACE" });
      }
      this.#saveState({ phase: "maintenance", previousTarget: previous, previousBuildId, legacyPath: null,
        storeBackup: null,
        lastAttempt: { ...attempt, phase: "maintenance", updatedAt: new Date(this.now()).toISOString() } });
      serviceStopAttempted = true;
      await this.stopService();
      const storeBackup = this.#backupStore(attemptId);
      this.#saveState({ storeBackup, phase: "maintenance", previousTarget: previous, previousBuildId, legacyPath: null,
        lastAttempt: { ...attempt, phase: "maintenance", updatedAt: new Date(this.now()).toISOString() } });
      this.#saveState({ phase: "activating", previousTarget: previous, previousBuildId,
        lastAttempt: { ...attempt, phase: "activating", updatedAt: new Date(this.now()).toISOString() } });
      activationAttempted = true;
      this.#switchTo(releasePath, previous, attemptId);
      switched = true;
      await this.startService();
      this.#saveState({ phase: "health_check", lastAttempt: { ...attempt, phase: "health_check", updatedAt: new Date(this.now()).toISOString() } });
      if (!await this.#health(payload.releaseId)) throw Object.assign(new Error("The candidate failed its bounded expected-build health checks"), { code: "CANDIDATE_HEALTH_FAILED" });
      const activeRelease = { releaseId: payload.releaseId, releaseVersion: payload.releaseVersion, manifestDigest: verified.manifestDigest };
      const replayLedger = [...this.state.usedAttemptIds.filter((entry) => typeof entry === "string" || Date.parse(entry.expiresAt) > this.now()),
        { attemptId, expiresAt: payload.expiresAt }];
      const previousStoreBackup = this.state.storeBackup;
      this.#saveState({ phase: "active", activeRelease, usedAttemptIds: replayLedger, previousTarget: previous, previousBuildId,
        lastAttempt: { ...attempt, phase: "active", result: "activated", updatedAt: new Date(this.now()).toISOString() } });
      if (previousStoreBackup?.target) {
        // The current update's snapshot is now the rollback data paired with
        // previousTarget. Older snapshots belong to releases beyond the
        // supported one-step rollback window and can be retired.
        const older = this.state.previousStoreBackupTarget;
        if (older && older !== previousStoreBackup.target) {
          try { fs.unlinkSync(older); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        this.#saveState({ previousStoreBackupTarget: previousStoreBackup.target });
      }
      return { ok: true, idempotent: false, status: this.status() };
    } catch (error) {
      let recoveryError = null;
      if (switched && previous) {
        try {
          await this.#restore(previous, attemptId || crypto.randomUUID(), this.state.previousBuildId);
          restoredStoreBackupPath = this.state.storeBackup?.target || null;
        }
        catch (rollbackError) { recoveryError = rollbackError; }
      } else if (serviceStopAttempted) {
        try {
          if (activationAttempted && previous?.kind === "directory" && this.state.legacyPath) {
            await this.#restore(previous, attemptId || crypto.randomUUID(), this.state.previousBuildId);
          } else {
            await this.startService();
            if (previous && !await this.#health(path.basename(previous.resolved))) throw new Error("The existing OS release failed its recovery health gate");
          }
        } catch (rollbackError) { recoveryError = rollbackError; }
      }
      if (attemptId && payload) {
        const existing = this.state.usedAttemptIds.filter((entry) => typeof entry === "string" || Date.parse(entry.expiresAt) > this.now());
        const used = [...existing.filter((entry) => (typeof entry === "string" ? entry : entry.attemptId) !== attemptId), { attemptId, expiresAt: payload.expiresAt }];
        // Persist only a bounded machine code, never an exception message that
        // could contain a URL, filesystem path, or credential-bearing detail.
        const result = recoveryError ? "recovery_failed" : switched ? "rolled_back" : error.code || "failed";
        this.#saveState({ phase: recoveryError ? "failed" : switched ? "rolled_back" : "failed", usedAttemptIds: used,
          ...(restoredStoreBackupPath ? { storeBackup: null } : {}),
          lastAttempt: { attemptId, releaseId: payload.releaseId, phase: recoveryError ? "failed" : switched ? "rolled_back" : "failed", result, updatedAt: new Date(this.now()).toISOString() } });
        if (restoredStoreBackupPath) {
          try { fs.unlinkSync(restoredStoreBackupPath); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
        }
      } else {
        this.#saveState({ phase: "failed", lastAttempt: { attemptId: null, releaseId: null, phase: "failed", result: error.code || "UPDATE_FAILED", updatedAt: new Date(this.now()).toISOString() } });
      }
      return { ok: false, code: recoveryError ? "ROLLBACK_FAILED" : error.code || "UPDATE_FAILED", status: this.status() };
    } finally {
      if (stagePath) fs.rmSync(stagePath, { recursive: true, force: true });
      this.busy = false;
    }
  }

  async recoverInterruptedAttempt() {
    if (["downloading", "verifying", "staged"].includes(this.state.phase)) {
      this.#saveState({ phase: "failed", lastAttempt: { ...this.state.lastAttempt, phase: "failed", result: "interrupted_before_activation", updatedAt: new Date(this.now()).toISOString() } });
      return { ok: true, recovered: true };
    }
    if (!["maintenance", "activating", "health_check"].includes(this.state.phase)) return { ok: true, recovered: false };
    const previous = this.state.previousTarget;
    const attemptId = this.state.lastAttempt?.attemptId || crypto.randomUUID();
    try {
      await this.#restore(previous, attemptId, this.state.previousBuildId);
      this.#saveState({ phase: "rolled_back", lastAttempt: { ...this.state.lastAttempt, phase: "rolled_back", result: "interrupted_attempt_restored", updatedAt: new Date(this.now()).toISOString() } });
      return { ok: true, recovered: true };
    } catch {
      this.#saveState({ phase: "failed", lastAttempt: { ...this.state.lastAttempt, phase: "failed", result: "interrupted_recovery_failed", updatedAt: new Date(this.now()).toISOString() } });
      return { ok: false, recovered: false };
    }
  }
}

module.exports = { NativeReleaseExecutor, extractSafeUstarGzip, safeArchivePath, sealReleaseForRuntime, DEFAULT_LIMITS };
