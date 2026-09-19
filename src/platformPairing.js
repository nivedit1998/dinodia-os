const crypto = require("node:crypto");
const os = require("node:os");

function sign(secret, serial, ts, nonce) {
  return crypto.createHmac("sha256", String(secret)).update(`${serial}.${ts}.${nonce}`).digest("hex");
}

function privateLanIp() {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
    }
  }
  return "127.0.0.1";
}

class PlatformPairing {
  constructor({ store, vault, apiUrl = "https://app.dinodiasmartliving.com", serial, haPort = 8123, intervalMs = 120000, runtime, getAreaSnapshot, getHeatingUsage, getHeatingUsageResetAck, getElectricUsage, getElectricUsageResetAck, getActivityIncidents, getAlexaCatalog, onSyncResult, logger = console, fetchImpl = fetch } = {}) {
    this.store = store;
    this.vault = vault;
    const storedPlatform = store?.getPlatform?.() || {};
    const requestedApiUrl = String(apiUrl || "").replace(/\/$/, "");
    const storedApiUrl = String(storedPlatform.apiUrl || "").replace(/\/$/, "");
    const defaultApiUrl = "https://app.dinodiasmartliving.com";
    this.apiUrl = String(requestedApiUrl && requestedApiUrl !== defaultApiUrl ? requestedApiUrl : (storedApiUrl || requestedApiUrl)).replace(/\/$/, "");
    this.serial = String(serial || store?.getIdentity()?.serial || "");
    this.haPort = Number(haPort) || 8123;
    this.intervalMs = Math.max(15000, Number(intervalMs) || 120000);
    this.runtime = {
      kind: String(runtime?.kind || "dinodia_os"),
      version: String(runtime?.version || "0.0.0"),
      capabilities: { managedAreaProvisioningV1: true, managedDevicePresentationV1: true, activityIncidentReportingV1: true, alexaNativeProjectionV1: true, alexaNativeDirectiveV1: true, ...(runtime?.capabilities || {}) },
    };
    this.getAreaSnapshot = getAreaSnapshot || (() => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), areas: [] }));
    this.getHeatingUsage = getHeatingUsage || (() => null);
    this.getHeatingUsageResetAck = getHeatingUsageResetAck || (() => null);
    this.getElectricUsage = getElectricUsage || (() => null);
    this.getElectricUsageResetAck = getElectricUsageResetAck || (() => null);
    this.getActivityIncidents = getActivityIncidents || (() => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), incidents: [] }));
    this.getAlexaCatalog = getAlexaCatalog || null;
    this.onSyncResult = onSyncResult || (() => {});
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.timer = null;
    this.syncing = false;
    this.publishAttempts = 0;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.nextRetryAt = 0;
    this.lastError = null;
    this.lastSuccess = null;
  }

  status() {
    const platform = this.store?.getPlatform?.() || {};
    return {
      configured: Boolean(this.apiUrl && this.serial),
      paired: Boolean(platform.paired),
      serial: this.serial,
      apiUrl: this.apiUrl,
      agentSeenVersion: Number(platform.agentSeenVersion || 0),
      publishedVersion: Number(platform.publishedVersion || 0),
      acceptedTokenCount: Array.isArray(platform.acceptedTokenHashes) ? platform.acceptedTokenHashes.length : 0,
      syncIntervalMinutes: Number(platform.syncIntervalMinutes || 2),
      runtime: { ...this.runtime, capabilities: { ...this.runtime.capabilities } },
      lastSuccess: this.lastSuccess || platform.lastSyncAt || null,
      lastError: this.lastError || platform.lastError || null,
    };
  }

  async configure({ bootstrapSecret, apiUrl } = {}) {
    if (apiUrl) this.apiUrl = String(apiUrl).replace(/\/$/, "");
    if (bootstrapSecret && this.vault) await this.vault.set("platform.bootstrapSecret", String(bootstrapSecret).trim());
    await this.store.savePlatform({ apiUrl: this.apiUrl });
    return this.status();
  }

  async request(path, body, secret) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(18).toString("hex");
    const payload = { serial: this.serial, ts, nonce, sig: sign(secret, this.serial, ts, nonce), ...body };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || `Platform returned HTTP ${response.status}`), { statusCode: response.status });
    return result;
  }

  getSyncSecret() {
    return this.vault && this.vault.get("platform.syncSecret");
  }

  async requestWithSecret(path, body, secret) {
    return this.request(path, body, secret);
  }

  async pair(bootstrapSecret) {
    const secret = String(bootstrapSecret || (this.vault && this.vault.get("platform.bootstrapSecret")) || "").trim();
    if (!secret) throw new Error("Bootstrap secret is required");
    const result = await this.request("/api/hub-agent/pair", {}, secret);
    if (result.syncSecret && this.vault) await this.vault.set("platform.syncSecret", String(result.syncSecret));
    await this.store.savePlatform({
      apiUrl: this.apiUrl,
      paired: true,
      agentSeenVersion: Number(result.latestVersion || result.publishedVersion || 0),
      publishedVersion: Number(result.publishedVersion || 0),
      acceptedTokenHashes: Array.isArray(result.hubTokenHashes) ? result.hubTokenHashes : [],
      syncIntervalMinutes: Number(result.platformSyncIntervalMinutes || 2),
      lastPairAt: new Date().toISOString(),
      lastError: null,
    });
    this.lastError = null;
    this.retryAttempt = 0;
    this.nextRetryAt = 0;
    return result;
  }

  async syncNow() {
    if (this.syncing) return null;
    if (this.nextRetryAt && Date.now() < this.nextRetryAt) return null;
    const secret = this.vault && this.vault.get("platform.syncSecret");
    const platform = this.store.getPlatform();
    if (!secret || !platform.paired) return null;
    this.syncing = true;
    try {
      const heatingUsage = this.getHeatingUsage() || undefined;
      const heatingUsageResetAckAt = this.getHeatingUsageResetAck() || undefined;
      const electricUsage = this.getElectricUsage() || undefined;
      // The legacy reset epoch is intentionally shared by both local usage
      // trackers so platform/home-reset remains one atomic compatibility
      // contract for old and new hubs.
      const electricUsageResetAckAt = this.getElectricUsageResetAck() || undefined;
      const sharedUsageResetAckAt = heatingUsageResetAckAt || electricUsageResetAckAt;
      const activityIncidents = this.getActivityIncidents() || undefined;
      const result = await this.request("/api/hub-agent/token-state", {
        agentSeenVersion: Number(platform.agentSeenVersion || 0),
        lanBaseUrl: `http://${privateLanIp()}:${this.haPort}`,
        hubRuntime: this.runtime,
        haAreas: this.getAreaSnapshot(),
        heatingUsage,
        heatingUsageResetAckAt: sharedUsageResetAckAt,
        electricUsage,
        activityIncidents,
      }, secret);
      const nextVersion = Math.max(Number(platform.agentSeenVersion || 0), Number(result.latestVersion || 0));
      const returnedHashes = Array.isArray(result.hubTokenHashes) && result.hubTokenHashes.length
        ? result.hubTokenHashes
        : (platform.acceptedTokenHashes || []);
      await this.store.savePlatform({
        paired: true,
        agentSeenVersion: nextVersion,
        publishedVersion: Number(result.publishedVersion || platform.publishedVersion || 0),
        acceptedTokenHashes: returnedHashes,
        syncIntervalMinutes: Number(result.platformSyncIntervalMinutes || platform.syncIntervalMinutes || 2),
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      });
      await this.onSyncResult(result, heatingUsage, heatingUsageResetAckAt, electricUsage, electricUsageResetAckAt);
      // Alexa has a dedicated bounded synchroniser. Keeping it outside this
      // heartbeat prevents a catalogue update from delaying token/state sync.
      this.lastSuccess = new Date().toISOString();
      this.lastError = null;
      this.retryAttempt = 0;
      this.nextRetryAt = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (Number(result.publishedVersion || 0) >= nextVersion) this.publishAttempts = 0;
      else if (nextVersion > 0 && this.publishAttempts < 3) {
        this.publishAttempts += 1;
        setImmediate(() => this.syncNow().catch(() => {}));
      }
      return result;
    } catch (error) {
      this.lastError = String(error.message || error);
      this.retryAttempt = Math.min(this.retryAttempt + 1, 8);
      const retryDelay = Math.min(15 * 60 * 1000, 5000 * (2 ** (this.retryAttempt - 1))) + Math.floor(Math.random() * 1000);
      this.nextRetryAt = Date.now() + retryDelay;
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.syncNow().catch(() => {});
        }, retryDelay);
        this.retryTimer.unref?.();
      }
      if (this.store?.listPendingIncidentEnvelopes?.().length && this.store?.markIncidentUploadError) {
        await this.store.markIncidentUploadError(this.lastError).catch(() => {});
      }
      await this.store.savePlatform({ lastError: this.lastError });
      this.logger.error(`[platform] ${this.lastError}`);
      return null;
    } finally {
      this.syncing = false;
    }
  }

  start() {
    if (!this.apiUrl || !this.serial) return;
    this.syncNow().catch(() => {});
    this.timer = setInterval(() => this.syncNow().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }
}

module.exports = { PlatformPairing, sign, privateLanIp };
