const { spawn } = require("node:child_process");
const path = require("node:path");

const { HiveAuthSession } = require("./authSession");
const { commandForService } = require("./commandAdapter");
const { normalizeHiveDevices } = require("./deviceNormalizer");
const { request, parseLine, validateResponse, safeError } = require("./workerProtocol");

const VAULT_KEY = "integration:hive:account:v1";
const DEFAULT_POLL_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 12_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskUsername(value) {
  const raw = String(value || "").trim();
  const at = raw.indexOf("@");
  if (at <= 0) return raw ? "***" : "";
  return `${raw[0]}***${raw.slice(at)}`;
}

function errorWithCode(error, fallback = "hive_api_unavailable") {
  const safe = safeError(error, fallback);
  return Object.assign(new Error(safe.message), { code: safe.errorCode, statusCode: safe.errorCode === "authentication_rate_limited" ? 429 : 502 });
}

class HiveBridge {
  constructor({ store, vault, config = {}, onSnapshot, onStatus, logger = console, spawnWorker } = {}) {
    this.store = store;
    this.vault = vault;
    this.config = config;
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.logger = logger;
    this.workerPath = config.hiveWorkerPath || path.join(__dirname, "python", "hive_worker.py");
    this.pythonPath = config.hivePythonPath || "python3";
    this.spawnWorker = spawnWorker || ((pythonPath, workerPath) => spawn(pythonPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] }));
    this.worker = null;
    this.buffer = "";
    this.pending = new Map();
    this.pollTimer = null;
    this.pollInFlight = null;
    this.stopping = false;
    this.restartCount = 0;
    this.circuitOpenUntil = 0;
    this.auth = new HiveAuthSession({ ttlMs: config.hiveSetupTtlMs, logger });
    this.statusState = { worker: "stopped", lastError: null, lastCommandAt: null, nextPollAt: null };
  }

  enabled() {
    return this.config.hiveEnabled !== false;
  }

  integration() {
    return this.store?.getHive?.() || { enabled: this.enabled(), configured: false, status: "disconnected", ignoredDeviceIds: [] };
  }

  status() {
    const integration = this.integration();
    return {
      enabled: this.enabled() && integration.enabled !== false,
      ...integration,
      runtime: { ...this.statusState, worker: this.worker ? "running" : this.statusState.worker, circuitOpen: Date.now() < this.circuitOpenUntil },
    };
  }

  async persistStatus(patch = {}) {
    const next = { ...patch };
    try { await this.store?.saveHive?.(next); } catch (error) { this.logger.error(`[hive] status persistence failed: ${error.message}`); }
    await this.onStatus?.(this.status());
  }

  async start() {
    if (!this.enabled()) return this.status();
    const integration = this.integration();
    if (!integration.configured || !this.vault?.has(VAULT_KEY)) return this.status();
    try {
      const secret = JSON.parse(this.vault.get(VAULT_KEY) || "{}");
      await this.ensureWorker();
      await this.request("session.start", { username: secret.username, password: secret.password, tokens: secret.tokens || {}, deviceData: secret.deviceData || [] });
      await this.refresh({ reason: "startup" });
    } catch (error) {
      await this.handleFailure(error, ["invalid_password", "reauth_required"].includes(error.code) ? "reauth_required" : "degraded");
    }
    return this.status();
  }

  schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const interval = Math.max(30_000, Number(this.config.hivePollIntervalMs) || DEFAULT_POLL_MS);
    const jitter = Math.floor(Math.random() * Math.min(10_000, interval / 10));
    this.statusState.nextPollAt = new Date(Date.now() + interval + jitter).toISOString();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.refresh({ reason: "scheduled" }).catch((error) => this.logger.error(`[hive] scheduled refresh failed: ${error.message}`));
    }, interval + jitter);
    this.pollTimer.unref?.();
  }

  async ensureWorker() {
    if (this.worker && !this.worker.killed) return;
    if (Date.now() < this.circuitOpenUntil) throw Object.assign(new Error("Hive worker circuit breaker is open"), { code: "hive_api_unavailable" });
    this.stopping = false;
    const child = this.spawnWorker(this.pythonPath, this.workerPath);
    this.worker = child;
    this.statusState.worker = "running";
    this.buffer = "";
    child.stdout?.on("data", (chunk) => this.consumeOutput(chunk));
    child.stderr?.on("data", (chunk) => this.logWorkerError(chunk));
    child.on("error", (error) => this.failPending(error));
    child.on("exit", (code, signal) => {
      this.worker = null;
      this.statusState.worker = this.stopping ? "stopped" : "crashed";
      this.failPending(Object.assign(new Error(`Hive worker exited (${code ?? "signal"})`), { code: "hive_api_unavailable" }));
      if (!this.stopping) {
        this.restartCount += 1;
        if (this.restartCount >= 5) this.circuitOpenUntil = Date.now() + 15 * 60_000;
      }
    });
    await this.request("initialize");
    this.restartCount = 0;
    return child;
  }

  logWorkerError(chunk) {
    const safe = String(chunk || "").replace(/(token|password|secret|credential|code)[^\n]*/gi, "sensitive worker diagnostic").trim();
    if (safe) this.logger.warn(`[hive-worker] ${safe.slice(0, 500)}`);
  }

  consumeOutput(chunk) {
    this.buffer += String(chunk || "");
    if (Buffer.byteLength(this.buffer, "utf8") > 2 * 1024 * 1024) {
      this.buffer = "";
      this.failPending(Object.assign(new Error("Hive worker output is too large"), { code: "hive_api_unavailable" }));
      this.worker?.kill();
      return;
    }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const response = validateResponse(parseLine(line));
        const pending = this.pending.get(String(response.id));
        if (!pending) continue;
        this.pending.delete(String(response.id));
        clearTimeout(pending.timer);
        if (response.ok === false) pending.reject(errorWithCode(response, response.errorCode));
        else pending.resolve(response.payload || {});
      } catch (error) {
        this.logger.warn(`[hive] invalid worker response: ${error.message}`);
      }
    }
  }

  failPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(operation, payload = {}) {
    if (!this.worker || this.worker.killed || !this.worker.stdin?.writable) return Promise.reject(Object.assign(new Error("Hive worker is not running"), { code: "hive_api_unavailable" }));
    const message = request(operation, payload);
    const timeoutMs = Math.max(2_000, Number(this.config.hiveOperationTimeoutMs) || DEFAULT_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(Object.assign(new Error("Hive operation timed out"), { code: "hive_api_unavailable" }));
      }, timeoutMs);
      this.pending.set(message.id, { resolve, reject, timer });
      try { this.worker.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { clearTimeout(timer); this.pending.delete(message.id); reject(error); }
    });
  }

  async authenticate(result) {
    let response = result;
    let deviceData = Array.isArray(response?.deviceData) ? response.deviceData : [];
    if (response?.challenge === "SMS_MFA") return response;
    if (response?.registrationRequired) {
      await this.persistStatus({ status: "registering_client" });
      response = await this.request("auth.register_device", { deviceName: this.config.hiveClientName || "Dinodia OS" });
      deviceData = Array.isArray(response?.deviceData) ? response.deviceData : deviceData;
    }
    return this.finishAuthenticated(response?.tokens || {}, deviceData);
  }

  async finishAuthenticated(tokens, deviceData = []) {
    const session = this.auth.current;
    if (!session) throw Object.assign(new Error("Hive setup session expired"), { code: "setup_session_expired", statusCode: 409 });
    await this.request("session.start", { username: session.username, password: session.password, tokens, deviceData });
    await this.vault.set(VAULT_KEY, JSON.stringify({ schemaVersion: 1, username: session.username, password: session.password, tokens, deviceData, savedAt: new Date().toISOString() }));
    await this.persistStatus({ configured: true, status: "discovering", maskedUsername: maskUsername(session.username), lastAttemptAt: new Date().toISOString(), connectedAt: new Date().toISOString(), reauthRequired: false, lastErrorCode: null, lastErrorAt: null, consecutiveFailures: 0 });
    try {
      const snapshot = await this.refresh({ reason: "connect", username: session.username });
      this.auth.resetFailures();
      return { status: "connected", discovered: snapshot.heatingDeviceCount, needsSetup: snapshot.needsSetup || [] };
    } finally {
      this.auth.clear();
    }
  }

  async connect({ username, password } = {}) {
    if (!this.enabled()) throw Object.assign(new Error("Hive is disabled"), { code: "hive_disabled", statusCode: 503 });
    if (this.auth.current) throw Object.assign(new Error("A Hive setup is already in progress"), { code: "setup_in_progress", statusCode: 409 });
    const integration = this.integration();
    if (integration.configured && this.vault?.has(VAULT_KEY)) {
      try {
        const stored = JSON.parse(this.vault.get(VAULT_KEY) || "{}");
        if (stored.username && String(stored.username).trim() !== String(username || "").trim()) {
          throw Object.assign(new Error("Disconnect the existing Hive account before connecting a different account"), { code: "account_already_connected", statusCode: 409 });
        }
      } catch (error) {
        if (error.code === "account_already_connected") throw error;
      }
    }
    const session = this.auth.begin(username, password);
    try {
      await this.ensureWorker();
      await this.persistStatus({ lastAttemptAt: new Date().toISOString(), status: "authenticating", lastErrorCode: null, reauthRequired: false });
      const result = await this.request("auth.login", { username: session.username, password: session.password });
      if (result.challenge === "SMS_MFA") {
        await this.persistStatus({ status: "mfa_required", maskedUsername: maskUsername(session.username) });
        return { status: "mfa_required", ...this.auth.sanitized(session.id) };
      }
      return this.authenticate(result);
    } catch (error) {
      this.auth.recordFailure(session.id);
      await this.handleFailure(error, "disconnected");
      throw error;
    }
  }

  async submitMfa(sessionId, code) {
    const session = this.auth.get(sessionId);
    if (!session) throw Object.assign(new Error("Hive setup session expired"), { code: "setup_session_expired", statusCode: 409 });
    if (!/^\d{4,8}$/.test(String(code || "").trim())) throw Object.assign(new Error("Enter the SMS verification code"), { code: "invalid_mfa_code", statusCode: 400 });
    try {
      const result = await this.request("auth.submit_mfa", { code: String(code).trim() });
      return this.authenticate(result);
    } catch (error) {
      this.auth.recordFailure(sessionId);
      await this.handleFailure(error, "mfa_required");
      throw error;
    }
  }

  cancelSetup(sessionId) {
    if (!this.auth.get(sessionId)) return false;
    this.auth.clear();
    return true;
  }

  async refresh({ reason = "manual", username = "" } = {}) {
    if (!this.enabled()) return this.status();
    if (!this.integration().configured) throw Object.assign(new Error("Connect a Hive account before refreshing"), { code: "account_not_connected", statusCode: 409 });
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = (async () => {
      try {
        await this.ensureWorker();
        const payload = await this.request("devices.poll", { reason });
        await this.persistRefreshedTokens(payload.tokens);
        const current = this.integration();
        const normalized = normalizeHiveDevices(payload, { accountFingerprint: current.accountFingerprint, username: username || current.maskedUsername, machineKey: this.vault?.key });
        const ignored = new Set(current.ignoredDeviceIds || []);
        const filtered = normalized.devices.filter((device) => !ignored.has(device.protocolIdentity.cloudId));
        await this.onSnapshot?.({ ...normalized, devices: filtered, needsSetup: filtered.filter((device) => device.setup?.status === "needs_setup").map((device) => ({ deviceId: device.id, name: device.name, protocol: device.protocol, manufacturer: "Hive", model: device.metadata?.model || "" })) });
        await this.persistStatus({ configured: true, status: "connected", accountFingerprint: normalized.accountFingerprint, lastSuccessfulPollAt: new Date().toISOString(), lastErrorCode: null, lastErrorAt: null, reauthRequired: false, consecutiveFailures: 0, heatingDeviceCount: normalized.heatingDeviceCount, hotWaterDeviceCount: Number(payload.hotWaterDeviceCount || 0), unsupportedProductCount: normalized.unsupportedProductCount });
        this.statusState.lastError = null;
        this.schedulePoll();
        return { ...normalized, devices: filtered, needsSetup: filtered.filter((device) => device.setup?.status === "needs_setup").map((device) => ({ deviceId: device.id, name: device.name, protocol: device.protocol, manufacturer: "Hive", model: device.metadata?.model || "" })) };
      } catch (error) {
        await this.handleFailure(error, ["invalid_password", "reauth_required"].includes(error.code) ? "reauth_required" : "degraded");
        throw error;
      } finally {
        this.pollInFlight = null;
      }
    })();
    return this.pollInFlight;
  }

  async persistRefreshedTokens(tokens) {
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || !Object.keys(tokens).length || !this.vault?.get) return;
    try {
      const stored = JSON.parse(this.vault.get(VAULT_KEY) || "{}");
      if (!stored || typeof stored !== "object" || !stored.username) return;
      await this.vault.set(VAULT_KEY, JSON.stringify({ ...stored, tokens, savedAt: new Date().toISOString() }));
    } catch (error) {
      this.logger.warn(`[hive] refreshed token persistence failed: ${error.message}`);
    }
  }

  async command(device, serviceId, data = {}) {
    if (!device || String(device.protocol || "").toLowerCase() !== "hive") throw Object.assign(new Error("Device is not a Hive device"), { code: "command_rejected", statusCode: 400 });
    const integration = this.integration();
    if (!integration.configured) throw Object.assign(new Error("Connect a Hive account before sending commands"), { code: "account_not_connected", statusCode: 409 });
    if (integration.status === "reauth_required" || integration.reauthRequired) throw Object.assign(new Error("Hive account reauthentication is required"), { code: "reauth_required", statusCode: 409 });
    if (integration.configured && integration.status !== "connected") throw Object.assign(new Error("Hive is not connected"), { code: "hive_api_unavailable", statusCode: 503 });
    if (device.available === false) throw Object.assign(new Error("Hive device is offline"), { code: "device_offline", statusCode: 409 });
    const mapped = commandForService(serviceId, data, device);
    const identity = device.protocolIdentity || {};
    try {
      await this.ensureWorker();
      await this.request("device.command", { cloudId: identity.cloudId, ...mapped });
      this.statusState.lastCommandAt = new Date().toISOString();
      await sleep(300);
      return this.refresh({ reason: "command" });
    } catch (error) {
      await this.handleFailure(error, ["invalid_password", "reauth_required"].includes(error.code) ? "reauth_required" : "degraded");
      throw error;
    }
  }

  async ignoreDevice(device) {
    const cloudId = String(device?.protocolIdentity?.cloudId || "").trim();
    if (!cloudId) throw Object.assign(new Error("Hive device identity is missing"), { code: "device_not_found", statusCode: 404 });
    const current = this.integration();
    const ignoredDeviceIds = [...new Set([...(current.ignoredDeviceIds || []), cloudId])];
    const summaries = [...(current.ignoredDeviceSummaries || []).filter((item) => item?.cloudId !== cloudId), { cloudId, name: String(device.name || "Hive heating"), model: String(device.metadata?.model || "") }];
    await this.persistStatus({ ignoredDeviceIds, ignoredDeviceSummaries: summaries });
    return { cloudId, ignoredDeviceIds };
  }

  async restoreDevice(cloudId) {
    const value = String(cloudId || "").trim();
    if (!value) throw Object.assign(new Error("Hive device identity is missing"), { code: "device_not_found", statusCode: 404 });
    const current = this.integration();
    if (!(current.ignoredDeviceIds || []).includes(value)) return false;
    await this.persistStatus({
      ignoredDeviceIds: (current.ignoredDeviceIds || []).filter((id) => id !== value),
      ignoredDeviceSummaries: (current.ignoredDeviceSummaries || []).filter((item) => item?.cloudId !== value),
    });
    await this.refresh({ reason: "restore" });
    return true;
  }

  async disconnect({ allowLocalOnly = false } = {}) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.auth.clear();
    let remote = { supported: false, deregistered: false };
    try {
      if (this.worker) remote = await this.request("account.deregister");
    } catch (error) {
      this.logger.warn(`[hive] remote deregistration unavailable: ${error.message}`);
      if (!allowLocalOnly) throw Object.assign(new Error("Hive remote deregistration could not be confirmed; confirm local removal to continue"), { code: "disconnect_failed", statusCode: 409, cause: error });
      remote = { supported: true, deregistered: false, errorCode: "remote_deregistration_unavailable" };
    }
    try { if (this.worker) await this.request("session.stop"); } catch {}
    this.stopping = true;
    try { this.worker?.kill(); } catch {}
    this.worker = null;
    await this.vault?.clear(VAULT_KEY);
    await this.store?.clearHive?.();
    this.statusState = { worker: "stopped", lastError: null, lastCommandAt: null, nextPollAt: null };
    await this.onStatus?.(this.status());
    return { ok: true, remote };
  }

  async close() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.stopping = true;
    this.auth.clear();
    try { if (this.worker) await this.request("session.stop"); } catch {}
    try { this.worker?.kill(); } catch {}
    this.worker = null;
    this.failPending(Object.assign(new Error("Hive worker stopped"), { code: "hive_api_unavailable" }));
    this.statusState.worker = "stopped";
  }

  async handleFailure(error, status) {
    const safe = safeError(error);
    this.statusState.lastError = safe;
    await this.persistStatus({ status, lastErrorCode: safe.errorCode, lastErrorAt: new Date().toISOString(), consecutiveFailures: Number(this.integration().consecutiveFailures || 0) + 1, reauthRequired: status === "reauth_required" });
    if (status === "reauth_required" && this.pollTimer) clearTimeout(this.pollTimer);
  }
}

module.exports = { HiveBridge, VAULT_KEY, maskUsername };
