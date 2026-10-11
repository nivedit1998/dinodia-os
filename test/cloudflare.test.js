const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
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

test("a paired tunnel child exit is retried once at a time without replacing its identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloudflare-supervisor-"));
  const binary = path.join(directory, "missing-cloudflared-for-injected-spawn");
  const tunnelId = "6ebfa087-6eec-468e-b93b-50b4f938b4b4";
  const tunnelName = "dinodia-din-home-001";
  const hostname = "dinodia-din-home-001.dinodiasmartliving.com";
  const cloudflareHome = path.join(directory, "cloudflared");
  const credentialsDir = path.join(cloudflareHome, ".cloudflared");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const credentialPath = path.join(credentialsDir, `${tunnelId}.json`);
  await fs.writeFile(credentialPath, JSON.stringify({ AccountTag: "account-tag-test", TunnelID: tunnelId, TunnelSecret: "A".repeat(64) }), { mode: 0o600 });
  await fs.writeFile(path.join(cloudflareHome, "config.yml"), [
    `tunnel: ${tunnelId}`, `credentials-file: ${credentialPath}`, "ingress:", `  - hostname: ${hostname}`,
    "    service: http://127.0.0.1:8123", "  - service: http_status:404", "",
  ].join("\n"), { mode: 0o600 });
  const stored = { mode: "local", recoveryIntent: "enabled", tunnelId, tunnelName, hostname, origin: "http://127.0.0.1:8123" };
  let starts = 0;
  const launches = [];
  const spawnImpl = (spawnBinary, args) => {
    starts += 1;
    launches.push({ spawnBinary, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => { child.signalCode = signal; setImmediate(() => child.emit("exit", null, signal)); return true; };
    setImmediate(() => {
      if (starts === 1) { child.exitCode = 1; child.emit("exit", 1, null); }
      else child.stdout.write("Registered tunnel connection connIndex=0\\n");
    });
    return child;
  };
  const tunnel = new CloudflareTunnel({
    binary, dataDir: directory, store: { getCloudflare: () => ({ ...stored }), saveCloudflare: async (value) => Object.assign(stored, value) },
    spawnImpl, retryBaseMs: 25, maxRetryDelayMs: 50, logger: { error() {}, warn() {} },
  });
  try {
    assert.equal(tunnel.settings().mode, "local");
    assert.equal(tunnel.settings().tunnelId, tunnelId);
    await tunnel.start();
    assert.equal(tunnel.status().running, true, "configured exact local identity should start its one managed child");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(starts >= 2, `unexpected child exit must schedule bounded recovery (starts=${starts}; ${tunnel.status().lastError || "no child start observed"})`);
    assert.ok(starts <= 2, "only one supervisor may own a live retry child");
    for (const launch of launches) assert.deepEqual(launch, { spawnBinary: binary, args: ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:20241", "--config", path.join(cloudflareHome, "config.yml"), "run", tunnelName] }, "recovery must run the same existing tunnel/config with loopback-only metrics, never create or route another tunnel");
    assert.equal(tunnel.status().tunnelId, tunnelId, "recovery must keep the exact paired tunnel identity");
    assert.equal(tunnel.status().running, true, "only one replacement child should remain active");
  } finally {
    await tunnel.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an explicit disconnect persists a recovery hold and a verified timestamp is not treated as current forever", async () => {
  const stored = { mode: "local", recoveryIntent: "enabled", tunnelId: "6ebfa087-6eec-468e-b93b-50b4f938b4b4", tunnelName: "dinodia-din-home-001", hostname: "dinodia-din-home-001.dinodiasmartliving.com", platformVerification: { state: "PLATFORM_VERIFIED", verifiedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } };
  const tunnel = new CloudflareTunnel({
    store: { getCloudflare: () => ({ ...stored }), saveCloudflare: async (value) => Object.assign(stored, value) },
    vault: { get: () => null, set: async () => {}, clear: async () => {} },
    logger: { error() {}, warn() {} },
  });
  await tunnel.disconnect();
  assert.equal(stored.recoveryIntent, "held", "disconnect must survive restart as deliberate intent");
  assert.equal(tunnel.status().platformVerification.fresh, false, "old signed verification must not be presented as current");
  assert.equal(tunnel.status().secureAccessVerified, false, "stale verification cannot enable the secure-access badge");
  await assert.rejects(() => tunnel.beginSetup({ tunnelName: stored.tunnelName, hostname: stored.hostname, reservationToken: "R".repeat(48) }), { code: "cloudflare_recovery_held" });
  await assert.rejects(() => tunnel.finishSetup(), { code: "cloudflare_recovery_held" });
  let launches = 0;
  const afterRestart = new CloudflareTunnel({ store: { getCloudflare: () => ({ ...stored }) }, spawnImpl: () => { launches += 1; throw new Error("must not launch held tunnel"); }, logger: { error() {}, warn() {} } });
  await afterRestart.start();
  assert.equal(launches, 0, "restart must not undo an explicit hold");
});

test("starting a new tunnel child invalidates the prior signed verification until a new Platform check", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloudflare-fresh-verification-"));
  const tunnelId = "6ebfa087-6eec-468e-b93b-50b4f938b4b4";
  const tunnelName = "dinodia-din-home-001";
  const hostname = "dinodia-din-home-001.dinodiasmartliving.com";
  const cloudflareHome = path.join(directory, "cloudflared");
  const credentialsDir = path.join(cloudflareHome, ".cloudflared");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const credentialPath = path.join(credentialsDir, `${tunnelId}.json`);
  await fs.writeFile(credentialPath, JSON.stringify({ AccountTag: "account-tag-test", TunnelID: tunnelId, TunnelSecret: "A".repeat(64) }), { mode: 0o600 });
  await fs.writeFile(path.join(cloudflareHome, "config.yml"), [`tunnel: ${tunnelId}`, `credentials-file: ${credentialPath}`, "ingress:", `  - hostname: ${hostname}`, "    service: http://127.0.0.1:8123", "  - service: http_status:404", ""].join("\n"), { mode: 0o600 });
  const stored = { mode: "local", recoveryIntent: "enabled", tunnelId, tunnelName, hostname, platformVerification: { state: "PLATFORM_VERIFIED", verifiedAt: "2026-10-11T12:00:00.000Z" } };
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; setImmediate(() => child.emit("exit", null, signal)); return true; };
  const tunnel = new CloudflareTunnel({ dataDir: directory, clock: () => Date.parse("2026-10-11T12:00:10.000Z"),
    store: { getCloudflare: () => ({ ...stored }), saveCloudflare: async (value) => Object.assign(stored, value) },
    spawnImpl: () => child, fetchImpl: async (url) => String(url).endsWith("/metrics")
      ? { ok: true, text: async () => 'cloudflared_tunnel_ha_connections{connection="0"} 1\n' }
      : { ok: true, json: async () => ({ ok: true, mode: "native-v2" }) },
    logger: { error() {}, warn() {} },
  });
  try {
    tunnel.startLocal({ mode: "local", tunnelId, tunnelName, hostname });
    assert.equal(tunnel.status().platformVerification.fresh, false, "verification from before this child generation is not current");
    assert.equal(tunnel.status().secureAccessVerified, false);
    await tunnel.markPlatformVerification({ state: "PLATFORM_VERIFIED", cloudUrl: `https://${hostname}` });
    assert.equal(tunnel.status().platformVerification.fresh, true, "a fresh signed Platform verification after this child may become current");
  } finally { await tunnel.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Reconnect Existing restores only the exact signed reservation and valid private credential", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloudflare-reconnect-"));
  const tunnelId = "6ebfa087-6eec-468e-b93b-50b4f938b4b4";
  const tunnelName = "dinodia-din-home-001";
  const hostname = "dinodia-din-home-001.dinodiasmartliving.com";
  const cloudflareHome = path.join(directory, "cloudflared");
  const credentialsDir = path.join(cloudflareHome, ".cloudflared");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const credentialPath = path.join(credentialsDir, `${tunnelId}.json`);
  const stored = { mode: "disabled", origin: "http://127.0.0.1:8123", platformVerification: { state: "PLATFORM_VERIFIED", verifiedAt: "2026-10-01T00:00:00.000Z" } };
  await fs.writeFile(path.join(cloudflareHome, "config.yml"), [`tunnel: ${tunnelId}`, `credentials-file: ${credentialPath}`, "ingress:", `  - hostname: ${hostname}`, "    service: http://127.0.0.1:8123", "  - service: http_status:404", ""].join("\n"), { mode: 0o600 });
  await fs.writeFile(credentialPath, JSON.stringify({ AccountTag: "account-tag-test", TunnelID: tunnelId, TunnelSecret: "A".repeat(64) }), { mode: 0o600 });
  const vaultValues = new Map();
  const tunnel = new CloudflareTunnel({
    dataDir: directory, nodeEnv: "production", origin: "http://127.0.0.1:8123",
    store: { getCloudflare: () => ({ ...stored }), saveCloudflare: async (value) => Object.assign(stored, value) },
    vault: { get: (key) => vaultValues.get(key) || null, set: async (key, value) => vaultValues.set(key, value) },
    logger: { error() {}, warn() {} },
  });
  let launched = 0;
  tunnel.startLocal = (settings) => { assert.equal(settings.tunnelId, tunnelId); launched += 1; };
  const reservation = { tunnelId, reservedTunnelName: tunnelName, reservedHostname: hostname, reservationToken: "R".repeat(48) };
  try {
    await tunnel.start();
    assert.equal(tunnel.settings().recoveryIntent, "ambiguous", "legacy disabled mode plus exact local artifacts is ambiguous, not permission to start automatically");
    assert.equal(launched, 0, "legacy ambiguity requires an explicit assigned-staff reconnect confirmation");
    await tunnel.reconnectExisting({ reservation });
    assert.equal(launched, 1);
    assert.equal(stored.mode, "local");
    assert.equal(stored.recoveryIntent, "enabled");
    assert.equal(stored.tunnelId, tunnelId);
    assert.equal(vaultValues.get("cloudflare.reservationToken"), reservation.reservationToken);
    assert.equal(tunnel.status().platformVerification.fresh, false, "restoration requires a new signed verification");

    const mismatched = new CloudflareTunnel({ dataDir: directory, nodeEnv: "production", origin: "http://127.0.0.1:8123", store: { getCloudflare: () => ({ mode: "disabled" }), saveCloudflare: async (value) => Object.assign(stored, value) }, logger: { error() {}, warn() {} } });
    let mismatchLaunches = 0;
    mismatched.startLocal = () => { mismatchLaunches += 1; };
    await assert.rejects(() => mismatched.reconnectExisting({ reservation: { ...reservation, tunnelId: "11111111-1111-4111-8111-111111111111" } }), { code: "cloudflare_reservation_identity_mismatch" });
    assert.equal(mismatchLaunches, 0, "wrong current tunnel identity must have no effect");
  } finally { await tunnel.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("production tunnel setup cannot silently create or route a replacement tunnel", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloudflare-production-setup-"));
  let commands = 0;
  const tunnel = new CloudflareTunnel({
    dataDir: directory, nodeEnv: "production",
    store: { getCloudflare: () => ({ mode: "disabled", recoveryIntent: "ambiguous" }), saveCloudflare: async () => {} },
    vault: { get: () => null, set: async () => {}, clear: async () => {} },
    logger: { error() {}, warn() {} },
  });
  tunnel.runCommand = async () => { commands += 1; throw new Error("replacement tunnel command must never run"); };
  try {
    assert.equal(tunnel.status().setupAllowed, false, "production status must not advertise create/setup when only recovery is authorized");
    await assert.rejects(() => tunnel.beginSetup({ tunnelName: "new-home-tunnel", hostname: "new-home.dinodiasmartliving.com", reservationToken: "R".repeat(48) }), { code: "cloudflare_setup_retired" });
    await assert.rejects(() => tunnel.finishSetup(), { code: "cloudflare_setup_retired" });
    assert.equal(commands, 0, "no login/list/create/route command may run for production recovery");
  } finally { await tunnel.stop(); await fs.rm(directory, { recursive: true, force: true }); }
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
if (args[0] === "tunnel" && args[1] === "list") { process.stdout.write(fs.existsSync(state) ? JSON.stringify([{ id: "6ebfa087-6eec-468e-b93b-50b4f938b4b4", name: fs.readFileSync(state, "utf8") }]) : "[]"); process.exit(0); }
if (args[0] === "tunnel" && args[1] === "create") { fs.writeFileSync(state, args[2]); fs.writeFileSync(path.join(cloudDir, "6ebfa087-6eec-468e-b93b-50b4f938b4b4.json"), JSON.stringify({ AccountTag: "account-tag-test", TunnelID: "6ebfa087-6eec-468e-b93b-50b4f938b4b4", TunnelSecret: "A".repeat(64) }), { mode: 0o600 }); process.exit(0); }
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
  assert.equal(resumedPaired.status().tunnelId, "6ebfa087-6eec-468e-b93b-50b4f938b4b4");

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
  assert.equal(resumed.status().tunnelId, "6ebfa087-6eec-468e-b93b-50b4f938b4b4");
  await resumed.stop();
});
