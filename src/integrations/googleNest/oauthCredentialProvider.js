const crypto = require("node:crypto");

const DEVELOPER_VAULT_KEY = "integration:google-nest:developer:v1";
const ACCOUNT_VAULT_KEY = "integration:google-nest:account:v1";

function parseRecord(value, code = "google_nest_not_configured") {
  if (!String(value || "").trim()) return null;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function accountFingerprint(projectId, refreshToken, machineKey) {
  const key = Buffer.isBuffer(machineKey) ? machineKey : Buffer.from(String(machineKey || "dinodia-google-nest"));
  return `hmac-sha256:${crypto.createHmac("sha256", key).update(`${projectId}:${refreshToken}`).digest("hex").slice(0, 24)}`;
}

class GoogleNestCredentialProvider {
  constructor({ vault, machineKey = "dinodia-google-nest" } = {}) {
    this.vault = vault;
    this.machineKey = machineKey;
  }

  developer() {
    const record = parseRecord(this.vault?.get?.(DEVELOPER_VAULT_KEY), "google_nest_not_configured");
    if (!record || !record.deviceAccessProjectId || !record.oauthClientId || !record.oauthClientSecret || !record.registeredRedirectUri) return null;
    return {
      deviceAccessProjectId: String(record.deviceAccessProjectId).trim(),
      oauthClientId: String(record.oauthClientId).trim(),
      oauthClientSecret: String(record.oauthClientSecret),
      registeredRedirectUri: String(record.registeredRedirectUri).trim(),
      releaseChannel: String(record.releaseChannel || "sandbox_beta").trim().toLowerCase() || "sandbox_beta",
    };
  }

  account() {
    const record = parseRecord(this.vault?.get?.(ACCOUNT_VAULT_KEY), "google_nest_not_configured");
    if (!record || !record.refreshToken) return null;
    return {
      refreshToken: String(record.refreshToken),
      grantedScope: String(record.grantedScope || ""),
      authorizedAt: record.authorizedAt || null,
      lastRefreshAt: record.lastRefreshAt || null,
      accountFingerprint: String(record.accountFingerprint || accountFingerprint("unknown", record.refreshToken, this.machineKey)),
    };
  }

  async saveDeveloper(value) {
    const input = value && typeof value === "object" ? value : {};
    if (!input.deviceAccessProjectId || !input.oauthClientId || !input.oauthClientSecret || !input.registeredRedirectUri) throw Object.assign(new Error("Google Nest developer credentials are incomplete"), { code: "google_nest_not_configured", statusCode: 400 });
    return this.vault.set(DEVELOPER_VAULT_KEY, JSON.stringify({ schemaVersion: 1, ...input, savedAt: new Date().toISOString() }));
  }

  async saveAccount(value, projectId) {
    const input = value && typeof value === "object" ? value : {};
    if (!input.refreshToken) throw Object.assign(new Error("Google Nest did not return a refresh token"), { code: "refresh_token_missing", statusCode: 502 });
    return this.vault.set(ACCOUNT_VAULT_KEY, JSON.stringify({
      schemaVersion: 1,
      refreshToken: String(input.refreshToken),
      grantedScope: String(input.grantedScope || ""),
      authorizedAt: input.authorizedAt || new Date().toISOString(),
      lastRefreshAt: input.lastRefreshAt || null,
      // Keep the account identity stable when Google rotates the OAuth
      // refresh token. The token is a credential, not a durable account ID.
      accountFingerprint: String(input.accountFingerprint || accountFingerprint(projectId, input.refreshToken, this.machineKey)),
    }));
  }

  async updateRefreshToken(refreshToken, patch = {}, projectId = "unknown") {
    const current = this.account();
    if (!current) throw Object.assign(new Error("Google Nest authorization is missing"), { code: "refresh_token_missing", statusCode: 503 });
    return this.saveAccount({ ...current, ...patch, refreshToken: refreshToken || current.refreshToken }, projectId);
  }

  async clearAccount() { return this.vault.clear(ACCOUNT_VAULT_KEY); }
  async clearDeveloper() { return this.vault.clear(DEVELOPER_VAULT_KEY); }
}

module.exports = { GoogleNestCredentialProvider, DEVELOPER_VAULT_KEY, ACCOUNT_VAULT_KEY, accountFingerprint };
