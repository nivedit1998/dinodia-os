const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CloudflareTunnel, safeHostname, connectedLocalTunnelIdentity, verifyLocalTunnelCredential } = require("../src/cloudflareTunnel");

test("CloudURL challenge identity comes from the connected local connector, not caller claims", () => {
  const local = {
    mode: "local",
    running: true,
    connected: true,
    connectorIdentityVerified: true,
    tunnelId: "6ebfa087-6eec-468e-b93b-50b4f938b4b4",
    tunnelName: "dinodia-din-home-001",
    hostname: "dinodia-din-home-001.dinodiasmartliving.com",
    publicUrl: "https://dinodia-din-home-001.dinodiasmartliving.com",
  };
  assert.deepEqual(connectedLocalTunnelIdentity(local, local.hostname, local.tunnelId, local.tunnelName), {
    ok: true,
    tunnelId: local.tunnelId,
    tunnelName: local.tunnelName,
    hostname: local.hostname,
    cloudUrl: local.publicUrl,
  });
  assert.equal(connectedLocalTunnelIdentity(local, local.hostname, "wrong-tunnel", local.tunnelName).reason, "connector_identity_mismatch");
  assert.equal(connectedLocalTunnelIdentity(local, local.hostname, local.tunnelId, "wrong-name").reason, "connector_identity_mismatch");
  assert.equal(connectedLocalTunnelIdentity(local, "other.dinodiasmartliving.com", local.tunnelId, local.tunnelName).reason, "connector_identity_invalid");
  assert.equal(connectedLocalTunnelIdentity({ ...local, connected: false }, local.hostname, local.tunnelId, local.tunnelName).reason, "connector_unavailable");
  assert.equal(connectedLocalTunnelIdentity({ ...local, mode: "named" }, local.hostname, local.tunnelId, local.tunnelName).reason, "connector_unavailable");
  assert.equal(connectedLocalTunnelIdentity({ ...local, publicUrl: "https://attacker.example.invalid" }, local.hostname, local.tunnelId, local.tunnelName).reason, "connector_identity_invalid");
  assert.equal(connectedLocalTunnelIdentity({ ...local, connectorIdentityVerified: false }, local.hostname, local.tunnelId, local.tunnelName).reason, "connector_unavailable");
});

test("local connector identity is verified against the active config and private tunnel credential", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloudflare-identity-"));
  const tunnelId = "6ebfa087-6eec-468e-b93b-50b4f938b4b4";
  const tunnelName = "dinodia-din-home-001";
  const hostname = "dinodia-din-home-001.dinodiasmartliving.com";
  const origin = "http://127.0.0.1:8123";
  const cloudflareHome = path.join(dataDir, "cloudflared");
  const credentialsDir = path.join(cloudflareHome, ".cloudflared");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(cloudflareHome, "config.yml");
  const credentialPath = path.join(credentialsDir, `${tunnelId}.json`);
  const config = [`tunnel: ${tunnelId}`, `credentials-file: ${credentialPath}`, "ingress:", `  - hostname: ${hostname}`, `    service: ${origin}`, "  - service: http_status:404", ""].join("\n");
  const credential = JSON.stringify({ AccountTag: "account-tag-test", TunnelID: tunnelId, TunnelSecret: "A".repeat(64) });
  try {
    await fs.writeFile(configPath, config, { mode: 0o600 });
    await fs.writeFile(credentialPath, credential, { mode: 0o600 });
    assert.equal(verifyLocalTunnelCredential({ dataDir, tunnelId, tunnelName, hostname, origin }), true);
    await fs.writeFile(credentialPath, JSON.stringify({ AccountTag: "account-tag-test", TunnelID: "11111111-1111-4111-8111-111111111111", TunnelSecret: "A".repeat(64) }), { mode: 0o600 });
    assert.equal(verifyLocalTunnelCredential({ dataDir, tunnelId, tunnelName, hostname, origin }), false, "a credential for a different actual tunnel must fail");
    await fs.writeFile(credentialPath, credential, { mode: 0o600 });
    await fs.chmod(credentialPath, 0o644);
    assert.equal(verifyLocalTunnelCredential({ dataDir, tunnelId, tunnelName, hostname, origin }), false, "group/world-readable connector credentials must fail verification");
    await fs.chmod(credentialPath, 0o600);
    await fs.unlink(credentialPath);
    await fs.symlink(configPath, credentialPath);
    assert.equal(verifyLocalTunnelCredential({ dataDir, tunnelId, tunnelName, hostname, origin }), false, "a symlinked connector credential must fail verification");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("Cloudflare configuration targets the HA compatibility origin and enforces the platform hostname", async () => {
  assert.equal(safeHostname("https://hub.dinodiasmartliving.com/"), "hub.dinodiasmartliving.com");
  assert.throws(() => safeHostname("hub..dinodiasmartliving.com"));
  const tunnel = new CloudflareTunnel({
    origin: "http://127.0.0.1:8123",
    binary: "/path/that/does/not/exist",
    store: { getCloudflare: () => ({ mode: "disabled", hostname: "", token: "" }), saveCloudflare: async () => {} },
    vault: { get: () => null, set: async () => {}, clear: async () => {} },
    logger: { error() {} },
  });
  await assert.rejects(() => tunnel.configure({ token: "tunnel-token", hostname: "hub.example.com" }), /dinodiasmartliving.com/);
  assert.equal(tunnel.status().origin, "http://127.0.0.1:8123");
});

test("Cloudflare reservation recovery persists only a valid installation proof", async () => {
  const stored = {};
  const vaultValues = new Map();
  const tunnel = new CloudflareTunnel({
    store: { getCloudflare: () => stored, saveCloudflare: async (value) => Object.assign(stored, value) },
    vault: { get: (key) => vaultValues.get(key) || null, set: async (key, value) => vaultValues.set(key, value) },
    logger: { error() {} },
  });
  const token = "A".repeat(48);
  await tunnel.setReservationToken(token);
  assert.equal(tunnel.reservationToken(), token);
  await assert.rejects(() => tunnel.setReservationToken("not-a-reservation"), /reservation is required/);
});

test("local Cloudflare setup authorizes, creates, routes, and starts a tunnel", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloudflare-local-"));
  const binary = path.join(directory, "fake-cloudflared");
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = process.env.HOME;
const cloudDir = path.join(home, ".cloudflared");
const state = path.join(cloudDir, "created.json");
fs.mkdirSync(cloudDir, { recursive: true });
if (args[0] === "tunnel" && args[1] === "login") { fs.writeFileSync(path.join(cloudDir, "cert.pem"), "test-cert"); console.error("https://dash.cloudflare.com/test-authorize"); process.exit(0); }
if (args[0] === "tunnel" && args[1] === "list") { process.stdout.write(fs.existsSync(state) ? JSON.stringify([{ id: "test-tunnel-id", name: fs.readFileSync(state, "utf8") }]) : "[]"); process.exit(0); }
if (args[0] === "tunnel" && args[1] === "create") { fs.writeFileSync(state, args[2]); fs.writeFileSync(path.join(cloudDir, "test-tunnel-id.json"), "{}"); process.exit(0); }
if (args[0] === "tunnel" && args[1] === "route") process.exit(0);
if (args[0] === "tunnel" && args[1] === "--no-autoupdate") setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const stored = { mode: "disabled", hostname: "", token: "" };
  const store = { getCloudflare: () => ({ ...stored }), saveCloudflare: async (value) => Object.assign(stored, value) };
  const tunnel = new CloudflareTunnel({ binary, dataDir: directory, origin: "http://127.0.0.1:8123", store, vault: { get: () => null, set: async () => {}, clear: async () => {} }, logger: { error() {} } });
  await tunnel.beginSetup({ tunnelName: "DIN-HOME-001", hostname: "hub.dinodiasmartliving.com" });
  for (let attempt = 0; attempt < 100 && tunnel.status().setup.state === "authorizing"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tunnel.status().setup.state, "authorized");
  assert.equal(tunnel.status().setup.authUrl, "https://dash.cloudflare.com/test-authorize");
  await tunnel.finishSetup();
  assert.equal(stored.mode, "local");
  assert.equal(tunnel.status().hostname, "hub.dinodiasmartliving.com");
  assert.match(await fs.readFile(path.join(directory, "cloudflared", "config.yml"), "utf8"), /http:\/\/127\.0\.0\.1:8123/);
  await tunnel.stop();

  const restarted = new CloudflareTunnel({ binary, dataDir: directory, origin: "http://127.0.0.1:8123", store, vault: { get: () => null, set: async () => {}, clear: async () => {} }, logger: { error() {} } });
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(restarted.status().running, true);
  await restarted.stop();

  // Once paired, the account-wide cert.pem is intentionally removed. A
  // resumed setup must reuse the durable tunnel ID/config/credential and must
  // not call account-level list/create/DNS-route commands.
  await fs.rm(path.join(directory, "cloudflared", ".cloudflared", "cert.pem"), { force: true });
  const resumedPaired = new CloudflareTunnel({ binary, dataDir: directory, origin: "http://127.0.0.1:8123", store, vault: { get: () => null, set: async () => {}, clear: async () => {} }, logger: { error() {} } });
  const resumedCommands = [];
  resumedPaired.runCommand = async (args) => { resumedCommands.push(args); throw new Error(`unexpected resumed command: ${args.join(" ")}`); };
  resumedPaired.startLocal = () => {};
  await resumedPaired.finishSetup();
  assert.deepEqual(resumedCommands, []);
  assert.equal(resumedPaired.status().tunnelId, "test-tunnel-id");

  // A create/route interruption can leave the exact tunnel and local
  // credential/configuration present while the durable store is still
  // disabled. A retry must resume only that exact staged tunnel.
  stored.mode = "disabled";
  stored.hostname = "";
  stored.tunnelName = "";
  stored.tunnelId = "";
  await fs.writeFile(path.join(directory, "cloudflared", "config.yml"), [
    "tunnel: stale-tunnel-id",
    "credentials-file: /tmp/stale-tunnel-id.json",
    "ingress:",
    "  - hostname: old.dinodiasmartliving.com",
    "    service: http://127.0.0.1:8123",
    "  - service: http_status:404",
    "",
  ].join("\n"));
  const resumed = new CloudflareTunnel({ binary, dataDir: directory, origin: "http://127.0.0.1:8123", store, vault: { get: () => null, set: async () => {}, clear: async () => {} }, logger: { error() {} } });
  await resumed.beginSetup({ tunnelName: "DIN-HOME-001", hostname: "hub.dinodiasmartliving.com" });
  for (let attempt = 0; attempt < 100 && resumed.status().setup.state === "authorizing"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  await resumed.finishSetup();
  assert.equal(stored.mode, "local");
  assert.equal(resumed.status().tunnelId, "test-tunnel-id");
  await resumed.stop();
});
