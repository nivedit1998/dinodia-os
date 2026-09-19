const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");

function apiResponse(body, status = 200) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }; }
function mockIntegration() { return { start() {}, close() {}, status() { return { configured: false, connected: false }; }, async command() {}, async refresh() {} }; }
function mockGoogleNest() { return { status() { return { enabled: true, configured: false, status: "disconnected", releaseChannel: "sandbox_beta", thermostatDeviceCount: 0, unsupportedDeviceCount: 0, ignoredDeviceCount: 0 }; }, start() {}, async close() {}, async beginAuthorization() { throw Object.assign(new Error("Configure Google Nest Device Access credentials first"), { code: "google_nest_not_configured", statusCode: 503 }); }, cancelAuthorization() { return false; }, async refresh() {}, async disconnect() {} }; }

async function request(base, route, options = {}) { const response = await fetch(`${base}${route}`, { ...options, headers: { connection: "close", authorization: "Bearer test-token", ...(options.headers || {}) } }); return { response, body: await response.json().catch(() => ({})) }; }

test("Google Nest API remains optional, authenticated, and callback is narrow", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-google-nest-api-"));
  const hub = createHub({ config: { nodeEnv: "production", adminToken: "test-token", cloudflarePublicHostname: "hub.example.com", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" }, mqttBridge: mockIntegration(), matterBridge: mockIntegration(), googleNestBridge: mockGoogleNest(), cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: true, connected: true, hostname: "hub.example.com" }; } }, platformSync: { start() {}, stop() {}, status() { return { configured: false }; } } });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const status = await request(base, "/_dinodia/admin/api/integrations/google-nest");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.callbackUri, "https://hub.example.com/_dinodia/oauth/google-nest/callback");
  const unauthenticated = await fetch(`${base}/_dinodia/oauth/google-nest/callback?state=x&code=y`, { headers: { host: "wrong.example.com", connection: "close" } });
  assert.equal(unauthenticated.status, 400);
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
  assert.equal(unauthenticated.headers.get("x-frame-options"), "DENY");
  const missing = await request(base, "/_dinodia/admin/api/integrations/google-nest/connect", { method: "POST", headers: { host: "hub.example.com", origin: "https://hub.example.com", "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(missing.response.status, 503);
  assert.equal(JSON.stringify(missing.body).includes("client-secret"), false);
  await hub.stop();
});

test("Google Nest operator credentials can be saved from the secure dashboard without exposing the secret", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-google-nest-config-api-"));
  const hub = createHub({ config: { nodeEnv: "production", adminToken: "test-token", cloudflarePublicHostname: "hub.example.com", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" }, mqttBridge: mockIntegration(), matterBridge: mockIntegration(), cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: true, connected: true, hostname: "hub.example.com" }; } }, platformSync: { start() {}, stop() {}, status() { return { configured: false }; } } });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + hub.server.address().port;
  const secret = "google-client-secret-value";
  const insecure = await request(base, "/_dinodia/admin/api/integrations/google-nest/configure", { method: "POST", headers: { host: "wrong.example.com", "x-forwarded-proto": "https" }, body: JSON.stringify({ deviceAccessProjectId: "123e4567-e89b-12d3-a456-426614174000", oauthClientId: "1234567890-abc.apps.googleusercontent.com", oauthClientSecret: secret }) });
  assert.equal(insecure.response.status, 400);
  assert.equal(insecure.body.errorCode, "secure_cloudflare_required");
  const configured = await request(base, "/_dinodia/admin/api/integrations/google-nest/configure", { method: "POST", headers: { host: "hub.example.com", origin: "https://hub.example.com", "x-forwarded-proto": "https" }, body: JSON.stringify({ deviceAccessProjectId: "123e4567-e89b-12d3-a456-426614174000", oauthClientId: "1234567890-abc.apps.googleusercontent.com", oauthClientSecret: secret }) });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.operatorConfigured, true);
  assert.equal(configured.body.configured, false);
  assert.equal(configured.body.callbackUri, "https://hub.example.com/_dinodia/oauth/google-nest/callback");
  assert.equal(JSON.stringify(configured.body).includes(secret), false);
  const vaultContents = await fs.readFile(path.join(directory, "vault.json"), "utf8");
  assert.equal(vaultContents.includes(secret), false);
  const developer = JSON.parse(hub.vault.get("integration:google-nest:developer:v1"));
  assert.equal(developer.oauthClientSecret, secret);
  await hub.stop();
});

test("Google Nest secure connect and callback discover a thermostat without returning secrets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-google-nest-api-flow-"));
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "google-nest", "thermostat-heating.json"), "utf8"));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/token")) return apiResponse({ access_token: "access-token-secret", refresh_token: "refresh-token-secret", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" });
    return apiResponse(fixture);
  };
  const hub = createHub({ config: { nodeEnv: "production", adminToken: "test-token", cloudflarePublicHostname: "hub.example.com", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" }, googleNestFetchImpl: fetchImpl, mqttBridge: mockIntegration(), matterBridge: mockIntegration(), cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: true, connected: true, hostname: "hub.example.com" }; } }, platformSync: { start() {}, stop() {}, status() { return { configured: false }; } } });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + hub.server.address().port;
  const callbackHost = "hub.example.com";
  await hub.vault.set("integration:google-nest:developer:v1", JSON.stringify({ deviceAccessProjectId: "project-1", oauthClientId: "client-1", oauthClientSecret: "client-secret", registeredRedirectUri: "https://" + callbackHost + "/_dinodia/oauth/google-nest/callback", releaseChannel: "sandbox_beta" }));
  const connect = await request(base, "/_dinodia/admin/api/integrations/google-nest/connect", { method: "POST", headers: { host: callbackHost, origin: "https://" + callbackHost, "x-forwarded-proto": "https" }, body: "{}" });
  assert.equal(connect.response.status, 200);
  assert.equal(connect.body.status, "authorization_pending");
  const authorization = new URL(connect.body.authorizationUrl);
  const invalidIssuer = await fetch(base + "/_dinodia/oauth/google-nest/callback?state=unused&code=test-code&iss=https%3A%2F%2Fevil.example", { headers: { host: callbackHost, origin: "https://" + callbackHost, "x-forwarded-proto": "https", connection: "close" } });
  assert.equal(invalidIssuer.status, 400);
  const callbackUrl = base + "/_dinodia/oauth/google-nest/callback?state=" + encodeURIComponent(authorization.searchParams.get("state")) + "&iss=https%3A%2F%2Faccounts.google.com&code=test-code&scope=" + encodeURIComponent("https://www.googleapis.com/auth/sdm.service");
  const callback = await fetch(callbackUrl, { headers: { host: callbackHost, origin: "https://" + callbackHost, "x-forwarded-proto": "https", connection: "close" } });
  const callbackBody = await callback.text();
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.equal(callback.headers.get("content-security-policy").includes("frame-ancestors 'none'"), true);
  assert.equal(callbackBody.includes("access-token-secret"), false);
  assert.equal(callbackBody.includes("refresh-token-secret"), false);
  const status = await request(base, "/_dinodia/admin/api/integrations/google-nest");
  assert.equal(status.body.status, "connected");
  assert.equal(status.body.thermostatDeviceCount, 1);
  assert.equal(hub.store.listDevices()[0].protocol, "google_nest");
  const devices = await request(base, "/_dinodia/admin/api/devices");
  assert.equal(JSON.stringify(devices.body).includes("enterprises/project-1/devices"), false);
  assert.deepEqual(devices.body.devices[0].protocolIdentity, {});
  assert.equal(calls.filter((call) => call.url.endsWith("/token")).length, 1);
  await hub.stop();
});
