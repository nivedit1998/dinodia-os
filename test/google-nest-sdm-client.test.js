const test = require("node:test");
const assert = require("node:assert/strict");
const { SdmClient, OAUTH_SCOPE } = require("../src/integrations/googleNest/sdmClient");

function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (key) => headers[key.toLowerCase()] || null }, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}

test("SDM client builds official authorization URL and validates token responses", async () => {
  const client = new SdmClient({ projectId: "project-1", clientId: "client-1", clientSecret: "secret", fetchImpl: async () => response({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: OAUTH_SCOPE }) });
  const url = new URL(client.authorizationUrl({ redirectUri: "https://hub.example/_dinodia/oauth/google-nest/callback", state: "state" }));
  assert.equal(url.hostname, "nestservices.google.com");
  assert.equal(url.pathname, "/partnerconnections/project-1/auth");
  assert.equal(url.searchParams.get("scope"), OAUTH_SCOPE);
  assert.equal((await client.exchangeCode({ code: "code", redirectUri: "https://hub.example/callback" })).refreshToken, "r");
});

test("SDM client lists devices, rejects invalid hosts, maps 401, and bounds responses", async () => {
  let calls = 0;
  const client = new SdmClient({ projectId: "project-1", clientId: "client-1", clientSecret: "secret", fetchImpl: async (url) => { calls += 1; return response({ devices: [] }); } });
  assert.deepEqual((await client.listDevices("a")).devices, []);
  assert.equal(calls, 1);
  await assert.rejects(() => client.request("https://evil.example/v1/x"), (error) => error.code === "google_nest_api_unavailable");
  const unauthorized = new SdmClient({ projectId: "project-1", clientId: "client-1", clientSecret: "secret", fetchImpl: async () => response({ error: { message: "expired" } }, 401) });
  await assert.rejects(() => unauthorized.listDevices("a"), (error) => error.code === "reauth_required");
  const huge = new SdmClient({ projectId: "project-1", clientId: "client-1", clientSecret: "secret", fetchImpl: async () => response("x".repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(() => huge.listDevices("a"), (error) => error.code === "google_nest_api_unavailable");
});

test("SDM device GET keeps the requested resource as the authoritative identity", async () => {
  const requested = "enterprises/project-1/devices/current-resource";
  const client = new SdmClient({ projectId: "project-1", clientId: "client-1", clientSecret: "secret", fetchImpl: async () => response({ name: "enterprises/project-1/devices/retired-resource", type: "sdm.devices.types.THERMOSTAT", traits: {} }) });
  const device = await client.getDevice(requested, "access-token");
  assert.equal(device.name, requested);
});
