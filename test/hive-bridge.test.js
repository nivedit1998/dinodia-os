const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { HiveBridge, VAULT_KEY } = require("../src/integrations/hive/hiveBridge");

async function fixture(name) {
  return JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "hive", name), "utf8"));
}

function fakeWorker(snapshot) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    write(line) {
      const message = JSON.parse(line);
      const payload = message.operation === "devices.poll" ? { ...snapshot, tokens: { token: "refreshed-id", accessToken: "refreshed-access", refreshToken: "refreshed-refresh" } } : message.operation === "auth.login" ? { tokens: { accessToken: "opaque-token" }, deviceData: ["group", "key", "password"], registrationRequired: false } : message.operation === "account.deregister" ? { supported: false, deregistered: false } : {};
      setImmediate(() => child.stdout.emit("data", `${JSON.stringify({ protocolVersion: 1, id: message.id, ok: true, payload })}\n`));
      return true;
    },
  };
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    setImmediate(() => child.emit("exit", 0, null));
  };
  return child;
}

function fakeStore() {
  let integration = {
    enabled: true,
    configured: false,
    status: "disconnected",
    ignoredDeviceIds: [],
    ignoredDeviceSummaries: [],
  };
  return {
    getHive: () => ({ ...integration, ignoredDeviceIds: [...integration.ignoredDeviceIds], ignoredDeviceSummaries: [...integration.ignoredDeviceSummaries] }),
    saveHive: async (patch) => { integration = { ...integration, ...patch }; return { ...integration }; },
    clearHive: async () => { integration = { enabled: true, configured: false, status: "disconnected", ignoredDeviceIds: [], ignoredDeviceSummaries: [] }; },
  };
}

function fakeVault() {
  const records = new Map();
  return {
    key: Buffer.from("hive-test-machine-key"),
    has: (name) => records.has(name),
    get: (name) => records.get(name) || null,
    set: async (name, value) => { if (value) records.set(name, value); else records.delete(name); },
    clear: async (name) => records.delete(name),
  };
}

test("Hive bridge authenticates through the worker, discovers zones, and normalizes commands", async () => {
  const source = await fixture("heating-account.json");
  const snapshots = [];
  const store = fakeStore();
  const vault = fakeVault();
  const bridge = new HiveBridge({
    store,
    vault,
    config: { hiveEnabled: true, hivePollIntervalMs: 30_000, hiveOperationTimeoutMs: 2_000, hiveSetupTtlMs: 60_000 },
    spawnWorker: () => fakeWorker(source),
    onSnapshot: async (snapshot) => snapshots.push(snapshot),
    logger: { warn() {}, error() {} },
  });

  const connected = await bridge.connect({ username: "owner@example.com", password: "password" });
  assert.deepEqual(connected, { status: "connected", discovered: 2, needsSetup: snapshots[0].needsSetup });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].devices[0].protocol, "hive");
  assert.equal(snapshots[0].devices[0].protocolIdentity.cloudId, "zone-downstairs");
  assert.equal((await store.getHive()).status, "connected");
  assert.equal(vault.has(VAULT_KEY), true);

  const commandResult = await bridge.command(snapshots[0].devices[0], "climate.set_temperature", { temperature: 21 });
  assert.equal(commandResult.devices.length, 2);
  assert.equal(snapshots.length, 2);
  assert.equal((await store.getHive()).lastSuccessfulPollAt !== null, true);
  assert.equal(JSON.parse(vault.get(VAULT_KEY)).tokens.accessToken, "refreshed-access");
  await bridge.close();
});

test("Hive bridge keeps the account bound to one owner and records hidden cloud IDs", async () => {
  const store = fakeStore();
  const vault = fakeVault();
  const bridge = new HiveBridge({ store, vault, config: { hiveEnabled: true }, spawnWorker: () => fakeWorker({ accountId: "a", devices: [] }), logger: { warn() {}, error() {} } });
  await vault.set(VAULT_KEY, JSON.stringify({ username: "owner@example.com", password: "password", tokens: {} }));
  await store.saveHive({ configured: true, status: "connected" });
  await assert.rejects(() => bridge.connect({ username: "other@example.com", password: "password" }), { code: "account_already_connected" });
  await bridge.ignoreDevice({ protocolIdentity: { cloudId: "zone-1" }, name: "Downstairs" });
  assert.deepEqual((await store.getHive()).ignoredDeviceIds, ["zone-1"]);
  await bridge.close();
});
