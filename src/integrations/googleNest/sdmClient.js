const GOOGLE_OAUTH_HOST = "oauth2.googleapis.com";
const GOOGLE_SDM_HOST = "smartdevicemanagement.googleapis.com";
const GOOGLE_PCM_HOST = "nestservices.google.com";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/sdm.service";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function googleError(message, code = "google_nest_api_unavailable", statusCode = 502, cause) {
  return Object.assign(new Error(String(message || "Google Nest request failed")), { code, statusCode, cause });
}

function boundedProjectId(value) {
  const projectId = String(value || "").trim();
  if (!/^[-a-zA-Z0-9_:.]{1,256}$/.test(projectId)) throw googleError("Google Nest project configuration is invalid", "google_nest_not_configured", 503);
  return projectId;
}

function resourcePath(value, projectId) {
  const raw = String(value || "").trim();
  if (!/^enterprises\/[^/]+\/devices\/[^/?#]+$/.test(raw) || !raw.startsWith(`enterprises/${projectId}/devices/`)) throw googleError("Google Nest device identity is invalid", "command_rejected", 400);
  return `/${raw}`;
}

async function readJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw googleError("Google Nest response is too large", "google_nest_api_unavailable", 502);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw googleError("Google Nest response is too large", "google_nest_api_unavailable", 502);
  try { return text ? JSON.parse(text) : {}; } catch { throw googleError("Google Nest returned malformed data", "google_nest_api_unavailable", 502); }
}

function mapFailure(status, payload, fallback = "google_nest_api_unavailable") {
  const message = String(payload?.error?.message || payload?.error_description || "Google Nest request failed").slice(0, 240);
  if (status === 401) return googleError("Google Nest authorization has expired", "reauth_required", 409);
  if (status === 403) return googleError("Google Nest access was denied", "reauth_required", 409);
  if (status === 404) return googleError("Google Nest device was not found", "device_discovery_failed", 404);
  if (status === 429) return googleError("Google Nest rate limit reached; Dinodia OS will retry", "google_nest_rate_limited", 429);
  return googleError(message, fallback, status >= 400 && status < 500 ? status : 502);
}

function retryAfterMs(response, now = () => Date.now()) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60 * 1000, Math.max(30_000, seconds * 1000));
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.min(15 * 60 * 1000, Math.max(30_000, at - now())) : null;
}

class SdmClient {
  constructor({ projectId, clientId, clientSecret, fetchImpl = globalThis.fetch, timeoutMs = 12000, now = () => Date.now() } = {}) {
    this.projectId = boundedProjectId(projectId);
    this.clientId = String(clientId || "").trim();
    this.clientSecret = String(clientSecret || "");
    if (!this.clientId || !this.clientSecret) throw googleError("Google Nest OAuth client is not configured", "google_nest_not_configured", 503);
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(2000, Number(timeoutMs) || 12000);
    this.now = now;
    this.lastListAt = 0;
    this.lastCommandAt = new Map();
  }

  authorizationUrl({ redirectUri, state }) {
    const url = new URL(`https://${GOOGLE_PCM_HOST}/partnerconnections/${encodeURIComponent(this.projectId)}/auth`);
    url.search = new URLSearchParams({ redirect_uri: String(redirectUri), client_id: this.clientId, access_type: "offline", prompt: "consent", response_type: "code", scope: OAUTH_SCOPE, state: String(state) }).toString();
    return url.toString();
  }

  async request(url, { method = "GET", headers = {}, body, accessToken, retry401 = true } = {}) {
    const parsed = new URL(url);
    if (![GOOGLE_OAUTH_HOST, GOOGLE_SDM_HOST, GOOGLE_PCM_HOST].includes(parsed.hostname)) throw googleError("Google Nest endpoint is not allowed", "google_nest_api_unavailable", 502);
    if (parsed.protocol !== "https:") throw googleError("Google Nest requires HTTPS", "google_nest_api_unavailable", 502);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(parsed, { method, headers: { accept: "application/json", ...headers, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body, signal: controller.signal });
      const payload = await readJson(response);
      if (response.status === 401 && retry401) throw mapFailure(response.status, payload, "reauth_required");
      if (!response.ok) {
        const failure = mapFailure(response.status, payload);
        const retry = retryAfterMs(response, this.now);
        if (retry !== null) failure.retryAfterMs = retry;
        throw failure;
      }
      return { payload, response };
    } catch (error) {
      if (error?.name === "AbortError") throw googleError("Google Nest request timed out", "google_nest_api_unavailable", 504);
      if (error?.code) throw error;
      throw googleError("Google Nest network request failed", "google_nest_api_unavailable", 502, error);
    } finally { clearTimeout(timer); }
  }

  async exchangeCode({ code, redirectUri }) {
    if (!String(code || "").trim()) throw googleError("Google authorization code is missing", "oauth_callback_invalid", 400);
    const body = new URLSearchParams({ code: String(code), client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: String(redirectUri), grant_type: "authorization_code" });
    const { payload } = await this.request(`https://${GOOGLE_OAUTH_HOST}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), retry401: false });
    return this.validateTokenPayload(payload, true);
  }

  async refreshToken(refreshToken) {
    if (!String(refreshToken || "").trim()) throw googleError("Google Nest refresh token is missing", "refresh_token_missing", 503);
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: String(refreshToken), grant_type: "refresh_token" });
    const { payload } = await this.request(`https://${GOOGLE_OAUTH_HOST}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), retry401: false });
    return this.validateTokenPayload(payload, false);
  }

  validateTokenPayload(payload, requireRefresh) {
    const accessToken = String(payload?.access_token || "").trim();
    const expiresIn = Number(payload?.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0 || String(payload?.token_type || "Bearer").toLowerCase() !== "bearer") throw googleError("Google Nest returned an invalid token response", "oauth_exchange_failed", 502);
    const scope = String(payload?.scope || OAUTH_SCOPE);
    if (!scope.split(/\s+/).includes(OAUTH_SCOPE)) throw googleError("Google Nest authorization scope is insufficient", "oauth_exchange_failed", 502);
    const refreshToken = String(payload?.refresh_token || "");
    if (requireRefresh && !refreshToken) throw googleError("Google did not return offline access", "refresh_token_missing", 502);
    return { accessToken, refreshToken: refreshToken || null, grantedScope: scope, expiresAt: this.now() + (expiresIn * 1000) };
  }

  async revoke(token) {
    if (!String(token || "").trim()) return { revoked: false, supported: true };
    const body = new URLSearchParams({ token: String(token) });
    const { response } = await this.request(`https://${GOOGLE_OAUTH_HOST}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), retry401: false });
    return { revoked: response.ok, supported: true };
  }

  async listDevices(accessToken, { bypassRateLimit = false } = {}) {
    if (!bypassRateLimit && this.now() - this.lastListAt < 1000) throw googleError("Google Nest discovery is rate limited locally", "google_nest_rate_limited", 429);
    this.lastListAt = this.now();
    const { payload } = await this.request(`https://${GOOGLE_SDM_HOST}/v1/enterprises/${encodeURIComponent(this.projectId)}/devices`, { accessToken });
    if (!Array.isArray(payload?.devices)) throw googleError("Google Nest device list is invalid", "device_discovery_failed", 502);
    return payload;
  }

  async getDevice(resourceName, accessToken) {
    const { payload } = await this.request(`https://${GOOGLE_SDM_HOST}/v1${resourcePath(resourceName, this.projectId)}`, { accessToken });
    if (!payload || typeof payload !== "object") throw googleError("Google Nest device response is invalid", "device_discovery_failed", 502);
    // Google can return a legacy name in the response body while the
    // requested resource URL is the current authoritative identity. Keep the
    // URL identity so a confirmation GET cannot revert a repaired device.
    return { ...payload, name: String(resourceName).trim() };
  }

  async executeCommand(resourceName, command, accessToken, { bypassRateLimit = false } = {}) {
    const key = String(resourceName);
    const last = this.lastCommandAt.get(key) || 0;
    if (!bypassRateLimit && this.now() - last < 1000) throw googleError("Google Nest command rate limited locally", "google_nest_rate_limited", 429);
    this.lastCommandAt.set(key, this.now());
    if (!command || typeof command !== "object" || !command.command || !command.params) throw googleError("Google Nest command is invalid", "command_rejected", 400);
    const { payload } = await this.request(`https://${GOOGLE_SDM_HOST}/v1${resourcePath(resourceName, this.projectId)}:executeCommand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: command.command, params: command.params }), accessToken, retry401: false });
    return payload;
  }
}

module.exports = { SdmClient, OAUTH_SCOPE, GOOGLE_OAUTH_HOST, GOOGLE_SDM_HOST, GOOGLE_PCM_HOST, MAX_RESPONSE_BYTES, googleError, mapFailure };
