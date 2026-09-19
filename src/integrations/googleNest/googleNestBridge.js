const { GoogleNestOAuthSession } = require("./oauthSession");
const { GoogleNestCredentialProvider, DEVELOPER_VAULT_KEY, ACCOUNT_VAULT_KEY } = require("./oauthCredentialProvider");
const { SdmClient } = require("./sdmClient");
const { normalizeRaw } = require("./deviceNormalizer");
const { commandForService } = require("./commandAdapter");
const { PollingUpdateSource } = require("./updateSource");

const DEFAULT_POLL_MS = 60_000;

function errorWithCode(error, fallback = "google_nest_api_unavailable") {
  if (error?.code) return error;
  return Object.assign(new Error(String(error?.message || "Google Nest request failed").slice(0, 240)), { code: fallback, statusCode: 502, cause: error });
}

function safeStatus(status) {
  const value = status && typeof status === "object" ? status : {};
  return {
    status: String(value.status || "disabled"),
    lastErrorCode: value.lastErrorCode || null,
    reauthRequired: Boolean(value.reauthRequired),
    consecutiveFailures: Number(value.consecutiveFailures || 0),
  };
}

class GoogleNestBridge {
  constructor({ store, vault, config = {}, onSnapshot, onStatus, logger = console, fetchImpl = globalThis.fetch, now = () => Date.now(), updateSource } = {}) {
    this.store = store;
    this.vault = vault;
    this.config = config;
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.logger = logger;
    this.now = now;
    this.credentials = new GoogleNestCredentialProvider({ vault, machineKey: vault?.key || "dinodia-google-nest" });
    this.fetchImpl = fetchImpl;
    this.client = null;
    this.access = null;
    this.refreshPromise = null;
    this.pollInFlight = null;
    this.commandLocks = new Map();
    this.stopping = false;
    this.oauth = new GoogleNestOAuthSession({ now, ttlMs: config.googleNestSetupTtlMs });
    this.statusState = { lastError: null, lastCommandAt: null, lastRefreshAt: null };
    this.updateSource = updateSource || new PollingUpdateSource({ intervalMs: config.googleNestPollIntervalMs || DEFAULT_POLL_MS, jitterMs: Math.min(5000, Number(config.googleNestPollIntervalMs || DEFAULT_POLL_MS) / 10), onPoll: () => this.refresh({ reason: "scheduled" }), now, logger });
  }

  enabled() { return this.config.googleNestEnabled !== false; }

  integration() {
    return this.store?.getGoogleNest?.() || { enabled: this.enabled(), configured: false, status: this.enabled() ? "disconnected" : "disabled", releaseChannel: this.config.googleNestReleaseChannel || "sandbox_beta", ignoredDeviceIds: [], ignoredDeviceSummaries: [] };
  }

  status() {
    const integration = this.integration();
    const developerConfigured = Boolean(this.credentials.developer());
    const developer = this.credentials.developer();
    const configuredHostname = String(this.config.cloudflarePublicHostname || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const callbackUri = developer?.registeredRedirectUri || (configuredHostname ? `https://${configuredHostname}${this.config.googleNestCallbackPath || "/_dinodia/oauth/google-nest/callback"}` : "");
    const current = { ...integration };
    return {
      enabled: this.enabled(),
      operatorConfigured: developerConfigured,
      callbackUri,
      configured: Boolean(current.configured),
      status: this.enabled() ? (developerConfigured ? String(current.status || "disconnected") : "disabled") : "disabled",
      releaseChannel: String(current.releaseChannel || this.config.googleNestReleaseChannel || "sandbox_beta"),
      thermostatDeviceCount: Number(current.thermostatDeviceCount || 0),
      unsupportedDeviceCount: Number(current.unsupportedDeviceCount || 0),
      ignoredDeviceCount: Array.isArray(current.ignoredDeviceIds) ? current.ignoredDeviceIds.length : 0,
      ignoredDevices: Array.isArray(current.ignoredDeviceSummaries) ? current.ignoredDeviceSummaries.map((item) => ({ identityHash: item.identityHash, name: item.name, model: item.model })) : [],
      lastSuccessfulPollAt: current.lastSuccessfulPollAt || null,
      nextPollAt: this.updateSource?.status?.().nextPollAt || current.nextPollAt || null,
      lastAuthorizationAttemptAt: current.lastAuthorizationAttemptAt || null,
      reauthRequired: Boolean(current.reauthRequired || current.status === "reauth_required"),
      runtime: { ...this.statusState, update: this.updateSource?.status?.() || {} },
    };
  }

  async configureDeveloper({ deviceAccessProjectId, oauthClientId, oauthClientSecret, registeredRedirectUri, releaseChannel } = {}) {
    if (!this.enabled()) throw Object.assign(new Error("Google Nest is disabled"), { code: "google_nest_disabled", statusCode: 503 });
    if (this.credentials.account()) throw Object.assign(new Error("Disconnect the existing Google Nest account before changing operator credentials"), { code: "account_already_connected", statusCode: 409 });
    const projectId = String(deviceAccessProjectId || "").trim();
    const clientId = String(oauthClientId || "").trim();
    const clientSecret = String(oauthClientSecret || "");
    const redirectUri = String(registeredRedirectUri || "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(projectId)) throw Object.assign(new Error("Enter the Google Device Access project ID"), { code: "google_nest_config_invalid", statusCode: 400 });
    if (!/^[0-9A-Za-z-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw Object.assign(new Error("Enter the Google OAuth web client ID"), { code: "google_nest_config_invalid", statusCode: 400 });
    if (clientSecret.length < 8 || clientSecret.length > 512 || /[\r\n]/.test(clientSecret)) throw Object.assign(new Error("Enter the Google OAuth client secret"), { code: "google_nest_config_invalid", statusCode: 400 });
    if (!/^https:\/\/[^/]+\/_dinodia\/oauth\/google-nest\/callback$/.test(redirectUri)) throw Object.assign(new Error("The Google Nest callback URL must use the secure Cloudflare hostname"), { code: "google_nest_config_invalid", statusCode: 400 });
    await this.credentials.saveDeveloper({ deviceAccessProjectId: projectId, oauthClientId: clientId, oauthClientSecret: clientSecret, registeredRedirectUri: redirectUri, releaseChannel: String(releaseChannel || this.config.googleNestReleaseChannel || "sandbox_beta").toLowerCase() });
    this.client = null;
    await this.persistStatus({ enabled: true, status: "disconnected", configured: false, releaseChannel: String(releaseChannel || this.config.googleNestReleaseChannel || "sandbox_beta").toLowerCase(), lastErrorCode: null, lastErrorAt: null, reauthRequired: false });
    return this.status();
  }

  getClient() {
    const developer = this.credentials.developer();
    if (!developer) throw Object.assign(new Error("Configure Google Nest Device Access credentials first"), { code: "google_nest_not_configured", statusCode: 503 });
    if (!this.client || this.client.projectId !== developer.deviceAccessProjectId || this.client.clientId !== developer.oauthClientId) this.client = new SdmClient({ projectId: developer.deviceAccessProjectId, clientId: developer.oauthClientId, clientSecret: developer.oauthClientSecret, fetchImpl: this.fetchImpl, timeoutMs: this.config.googleNestOperationTimeoutMs, now: this.now });
    return { client: this.client, developer };
  }

  async persistStatus(patch = {}) {
    try { await this.store?.saveGoogleNest?.(patch); } catch (error) { this.logger.error(`[google-nest] status persistence failed: ${error.message}`); }
    await this.onStatus?.(this.status());
  }

  async start() {
    if (!this.enabled()) return this.status();
    const account = this.credentials.account();
    if (!account) {
      await this.persistStatus({ enabled: true, status: "disconnected", releaseChannel: this.config.googleNestReleaseChannel || "sandbox_beta" });
      return this.status();
    }
    try {
      await this.ensureAccessToken();
      await this.refresh({ reason: "startup" });
    } catch (error) {
      await this.handleFailure(error, error.code === "reauth_required" ? "reauth_required" : "degraded");
    }
    return this.status();
  }

  async beginAuthorization({ redirectUri, origin } = {}) {
    if (!this.enabled()) throw Object.assign(new Error("Google Nest is disabled"), { code: "google_nest_disabled", statusCode: 503 });
    const { client, developer } = this.getClient();
    if (String(developer.registeredRedirectUri) !== String(redirectUri)) throw Object.assign(new Error("Google Nest callback URL does not match the registered OAuth URL"), { code: "google_nest_not_configured", statusCode: 503 });
    const existing = this.integration();
    if (existing.configured && existing.status === "connected") throw Object.assign(new Error("Disconnect the existing Google Nest account before connecting a different account"), { code: "account_already_connected", statusCode: 409 });
    const session = this.oauth.begin({ redirectUri, origin });
    await this.persistStatus({ enabled: true, status: "authorization_pending", releaseChannel: developer.releaseChannel || this.config.googleNestReleaseChannel || "sandbox_beta", lastAuthorizationAttemptAt: new Date(this.now()).toISOString(), lastErrorCode: null, reauthRequired: false });
    return { status: "authorization_pending", sessionId: session.id, authorizationUrl: client.authorizationUrl({ redirectUri, state: session.state }), expiresAt: session.expiresAt };
  }

  cancelAuthorization(sessionId) {
    const current = this.oauth.get(sessionId);
    if (!current) return false;
    this.oauth.clear();
    this.persistStatus({ status: this.integration().configured ? "reauth_required" : "disconnected" }).catch(() => {});
    return true;
  }

  async completeAuthorization({ state, code, error: oauthError } = {}) {
    const session = this.oauth.consume(state);
    if (!session) throw Object.assign(new Error("Google Nest authorization state is invalid or expired"), { code: "oauth_state_invalid", statusCode: 400 });
    if (oauthError) {
      const error = Object.assign(new Error("Google Nest authorization was cancelled"), { code: oauthError === "access_denied" ? "oauth_access_denied" : "oauth_callback_invalid", statusCode: 400, callbackOrigin: session.origin });
      await this.handleFailure(error, this.integration().configured ? "reauth_required" : "disconnected");
      throw error;
    }
    if (!String(code || "").trim() || String(code).length > 4096) {
      const error = Object.assign(new Error("Google Nest authorization callback is invalid"), { code: "oauth_callback_invalid", statusCode: 400, callbackOrigin: session.origin });
      await this.handleFailure(error, this.integration().configured ? "reauth_required" : "disconnected");
      throw error;
    }
    try {
      const { client, developer } = this.getClient();
      await this.persistStatus({ status: "exchanging_code" });
      const token = await client.exchangeCode({ code, redirectUri: session.redirectUri });
      await this.credentials.saveAccount({ refreshToken: token.refreshToken, grantedScope: token.grantedScope, authorizedAt: new Date(this.now()).toISOString() }, developer.deviceAccessProjectId);
      this.access = { accessToken: token.accessToken, expiresAt: token.expiresAt };
      await this.persistStatus({ configured: true, status: "discovering", releaseChannel: developer.releaseChannel || this.config.googleNestReleaseChannel || "sandbox_beta", connectedAt: new Date(this.now()).toISOString(), reauthRequired: false, lastErrorCode: null, lastErrorAt: null, consecutiveFailures: 0 });
      const snapshot = await this.refresh({ reason: "connect" });
      return { status: "connected", discovered: snapshot.thermostatDeviceCount, callbackOrigin: session.origin };
    } catch (error) {
      await this.handleFailure(error, error.code === "reauth_required" ? "reauth_required" : "disconnected");
      error.callbackOrigin = session.origin;
      throw error;
    }
  }

  async ensureAccessToken(force = false) {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && this.access && this.access.expiresAt - (Number(this.config.googleNestRefreshSkewMs) || 300000) > this.now()) return this.access.accessToken;
    this.refreshPromise = (async () => {
      const { client, developer } = this.getClient();
      const account = this.credentials.account();
      if (!account) throw Object.assign(new Error("Connect a Google Nest account before continuing"), { code: "google_nest_not_configured", statusCode: 409 });
      try {
        const token = await client.refreshToken(account.refreshToken);
        this.access = { accessToken: token.accessToken, expiresAt: token.expiresAt };
        if (token.refreshToken) await this.credentials.updateRefreshToken(token.refreshToken, { grantedScope: token.grantedScope, lastRefreshAt: new Date(this.now()).toISOString() }, developer.deviceAccessProjectId);
        else await this.credentials.updateRefreshToken(account.refreshToken, { grantedScope: token.grantedScope, lastRefreshAt: new Date(this.now()).toISOString() }, developer.deviceAccessProjectId);
        this.statusState.lastRefreshAt = new Date(this.now()).toISOString();
        return this.access.accessToken;
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  async refresh({ reason = "manual", forceToken = false, bypassRateLimit = false } = {}) {
    if (!this.enabled()) return this.status();
    if (!this.integration().configured) throw Object.assign(new Error("Connect a Google Nest account before refreshing"), { code: "google_nest_not_configured", statusCode: 409 });
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = (async () => {
      try {
        const { client } = this.getClient();
        let token = await this.ensureAccessToken(forceToken);
        let response;
        let staleResourceError = null;
        let staleResourceName = "";
        let knownResources = new Set();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try { response = await client.listDevices(token, { bypassRateLimit: bypassRateLimit || attempt > 0 }); } catch (error) {
            if (error.code !== "reauth_required") throw error;
            token = await this.ensureAccessToken(true);
            response = await client.listDevices(token, { bypassRateLimit: true });
          }
          knownResources = new Set(this.store.listDevices().filter((device) => String(device.protocol || "").toLowerCase() === "google_nest").map((device) => String(device.protocolIdentity?.resourceName || device.metadata?.resource_name || "")).filter(Boolean));
          const knownListed = (response.devices || []).filter((device) => knownResources.has(String(device?.name || "")));
          staleResourceError = null;
          staleResourceName = "";
          for (const listed of knownListed) {
            try { await client.getDevice(String(listed.name), token); } catch (error) {
              if (error.code !== "device_discovery_failed") throw error;
              staleResourceError = error;
              staleResourceName = String(listed.name || "");
              break;
            }
          }
          if (!staleResourceError || attempt === 2) break;
          token = await this.ensureAccessToken(true);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (staleResourceError) {
          const usable = (response?.devices || []).filter((device) => String(device?.name || "") !== staleResourceName);
          if (!usable.length) throw staleResourceError;
          response = { ...response, devices: usable };
        }
        const integration = this.integration();
        const account = this.credentials.account();
        const accountFingerprint = account?.accountFingerprint || integration.accountFingerprint || "";
        const normalized = normalizeRaw(response, { machineKey: this.vault?.key || "dinodia-google-nest", ignoredDeviceIds: new Set(integration.ignoredDeviceIds || []), accountFingerprint, maxDevices: this.config.googleNestMaxDevices });
        await this.onSnapshot?.(normalized, { allowIdentityMigration: reason === "command_identity_recovery" || reason === "connect" });
        await this.persistStatus({ configured: true, status: "connected", accountFingerprint, thermostatDeviceCount: normalized.thermostatDeviceCount, unsupportedDeviceCount: normalized.unsupportedDeviceCount, lastSuccessfulPollAt: new Date(this.now()).toISOString(), lastErrorCode: null, lastErrorAt: null, reauthRequired: false, consecutiveFailures: 0 });
        this.statusState.lastError = null;
        this.updateSource?.schedule?.();
        return normalized;
      } catch (error) {
        await this.handleFailure(error, error.code === "reauth_required" ? "reauth_required" : "degraded");
        throw error;
      } finally { this.pollInFlight = null; }
    })();
    return this.pollInFlight;
  }

  async recoverCommandResource(device, originalResource, client) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.refresh({ reason: "command_identity_recovery", forceToken: true, bypassRateLimit: true });
      } catch (error) {
        if (error.code === "reauth_required") throw error;
        lastError = error;
      }
      const recovered = this.store.getDevice(device.id);
      const candidate = String(recovered?.protocolIdentity?.resourceName || recovered?.metadata?.resource_name || "");
      if (candidate && candidate !== originalResource) {
        const token = await this.ensureAccessToken();
        try {
          await client.getDevice(candidate, token);
          return { resourceName: candidate, token };
        } catch (error) {
          if (error.code !== "device_discovery_failed") throw error;
          lastError = error;
        }
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  async command(device, serviceId, data = {}) {
    if (!device || String(device.protocol || "").toLowerCase() !== "google_nest") throw Object.assign(new Error("Device is not a Google Nest device"), { code: "command_rejected", statusCode: 400 });
    const run = async () => {
      const integration = this.integration();
      if (!integration.configured) throw Object.assign(new Error("Connect a Google Nest account before sending commands"), { code: "google_nest_not_configured", statusCode: 409 });
      if (integration.status === "reauth_required" || integration.reauthRequired) throw Object.assign(new Error("Google Nest account reauthentication is required"), { code: "reauth_required", statusCode: 409 });
      if (device.available === false) throw Object.assign(new Error("Google Nest thermostat is offline"), { code: "device_offline", statusCode: 409 });
      const mapped = commandForService(serviceId, data, device);
      let resourceName = String(device.protocolIdentity?.resourceName || device.metadata?.resource_name || "");
      if (!resourceName) throw Object.assign(new Error("Google Nest device identity is missing"), { code: "command_rejected", statusCode: 400 });
      const { client } = this.getClient();
      let token = await this.ensureAccessToken();
      try {
        await client.executeCommand(resourceName, mapped, token);
      } catch (error) {
        if (error.code === "device_discovery_failed") {
          // Google can retire an SDM resource while a still-valid access
          // token continues to return the old resource from discovery. Force
          // up to three fresh discovery attempts and validate the candidate
          // before retrying once.
          const recovered = await this.recoverCommandResource(device, resourceName, client);
          if (!recovered) throw error;
          resourceName = recovered.resourceName;
          token = recovered.token;
          await client.executeCommand(resourceName, mapped, token, { bypassRateLimit: true });
        } else {
          if (error.code !== "reauth_required") throw error;
          token = await this.ensureAccessToken(true);
          await client.executeCommand(resourceName, mapped, token, { bypassRateLimit: true });
        }
      }
      this.statusState.lastCommandAt = new Date(this.now()).toISOString();
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const raw = await client.getDevice(resourceName, await this.ensureAccessToken());
        const normalized = normalizeRaw({ devices: [raw] }, { machineKey: this.vault?.key || "dinodia-google-nest", ignoredDeviceIds: new Set(this.integration().ignoredDeviceIds || []), accountFingerprint: this.integration().accountFingerprint, maxDevices: 1 });
        if (normalized.devices.length) await this.onSnapshot?.(normalized, { allowIdentityMigration: true });
        const confirmed = this.store.getDevice(device.id);
        if (confirmed) await this.store.updateDevice(confirmed.id, { metadata: { ...(confirmed.metadata || {}), resource_health: "verified", resource_last_validated_at: new Date(this.now()).toISOString() } });
      } catch (error) {
        if (error.code === "reauth_required") await this.handleFailure(error, "reauth_required");
        else this.logger.warn(`[google-nest] command confirmation unavailable: ${error.message}`);
        throw Object.assign(new Error("Google Nest accepted the command but the new state could not be confirmed yet"), { code: "command_unconfirmed", statusCode: 504, cause: error });
      }
      return this.store.getDevice(device.id);
    };
    const previous = this.commandLocks.get(device.id) || Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    const tracked = current.finally(() => { if (this.commandLocks.get(device.id) === tracked) this.commandLocks.delete(device.id); });
    // A rejected cleanup promise must not become an unhandled rejection and
    // terminate the hub process after a failed cloud command.
    tracked.catch(() => {});
    this.commandLocks.set(device.id, tracked);
    return current;
  }

  async ignoreDevice(device) {
    const resourceName = String(device?.protocolIdentity?.resourceName || device?.metadata?.resource_name || "").trim();
    if (!resourceName) throw Object.assign(new Error("Google Nest device identity is missing"), { code: "device_not_found", statusCode: 404 });
    const current = this.integration();
    const ids = [...new Set([...(current.ignoredDeviceIds || []), resourceName])];
    const identityHash = String(device.id || "").replace(/^google_nest:/, "");
    const summaries = [...(current.ignoredDeviceSummaries || []).filter((item) => item?.identityHash !== identityHash), { identityHash, name: String(device.name || "Google Nest thermostat"), model: String(device.metadata?.model || "") }];
    await this.persistStatus({ ignoredDeviceIds: ids, ignoredDeviceSummaries: summaries });
    return { resourceName, ignoredDeviceIds: ids };
  }

  async restoreDevice(identity) {
    const value = String(identity || "").trim();
    const current = this.integration();
    const { stableGoogleNestDeviceId } = require("../../capabilities/identity");
    const resourceName = (current.ignoredDeviceIds || []).find((id) => id === value || stableGoogleNestDeviceId(id, this.vault?.key || "dinodia-google-nest") === value || stableGoogleNestDeviceId(id, this.vault?.key || "dinodia-google-nest") === `google_nest:${value}`);
    if (!resourceName) return false;
    const identityHash = stableGoogleNestDeviceId(resourceName, this.vault?.key || "dinodia-google-nest").replace(/^google_nest:/, "");
    await this.persistStatus({ ignoredDeviceIds: current.ignoredDeviceIds.filter((id) => id !== resourceName), ignoredDeviceSummaries: (current.ignoredDeviceSummaries || []).filter((item) => item?.identityHash !== identityHash) });
    await this.refresh({ reason: "restore" });
    return true;
  }

  async disconnect({ allowLocalOnly = false } = {}) {
    this.updateSource?.stop?.();
    this.oauth.clear();
    let remote = { supported: true, revoked: false };
    try {
      const account = this.credentials.account();
      if (account) { const { client } = this.getClient(); remote = await client.revoke(account.refreshToken); }
    } catch (error) {
      if (!allowLocalOnly) throw Object.assign(new Error("Google Nest access could not be revoked; confirm local removal to continue"), { code: "disconnect_failed", statusCode: 409, cause: error });
      remote = { supported: true, revoked: false, errorCode: "remote_revocation_unavailable" };
    }
    this.access = null;
    await this.credentials.clearAccount();
    await this.store?.clearGoogleNest?.();
    this.statusState = { lastError: null, lastCommandAt: null, lastRefreshAt: null };
    await this.onStatus?.(this.status());
    return { ok: true, remote };
  }

  async close() { this.stopping = true; this.updateSource?.stop?.(); this.oauth.clear(); this.access = null; this.commandLocks.clear(); }

  async handleFailure(error, status) {
    const safe = errorWithCode(error);
    this.statusState.lastError = { code: safe.code, message: safe.message };
    const current = this.integration();
    await this.persistStatus({ status, lastErrorCode: safe.code, lastErrorAt: new Date(this.now()).toISOString(), consecutiveFailures: Number(current.consecutiveFailures || 0) + 1, reauthRequired: status === "reauth_required" });
    if (status === "reauth_required") this.updateSource?.stop?.();
    else if (Number.isFinite(Number(safe.retryAfterMs))) this.updateSource?.schedule?.(Number(safe.retryAfterMs));
  }
}

module.exports = { GoogleNestBridge, DEVELOPER_VAULT_KEY, ACCOUNT_VAULT_KEY };
