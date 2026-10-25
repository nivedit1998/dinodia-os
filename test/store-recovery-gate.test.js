const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { createHub } = require("../src/server");

function runtimeMock() {
  return { starts: 0, start() { this.starts += 1; }, close() {}, status() { return { configured: false, connected: false }; } };
}

test("an ordinary offline restart does not require guarded-restore cloud reconciliation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-offline-reboot-"));
  const file = path.join(directory, "dinodia.json");
  const original = new Store(file);
  await original.saveArea({ name: "Synthetic room" }, "offline-room");
  await original.flushPersist();
  const store = new Store(file);
  const mqtt = runtimeMock(), matter = runtimeMock();
  const hub = createHub({
    store,
    config: { nodeEnv: "development", nativeApiHost: "127.0.0.1", nativeApiPort: 0,
      dataDir: directory, dataFile: file, backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "", v2Environment: "test" },
    mqttBridge: mqtt, matterBridge: matter,
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false }; } },
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await hub.start();
    const response = await fetch(`http://127.0.0.1:${hub.server.address().port}/api/health`);
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.notEqual(health.storeRecovery?.pending, true);
    assert.equal(mqtt.starts, 1, "ordinary restart starts the local Zigbee runtime without cloud reconciliation");
    assert.equal(matter.starts, 1, "ordinary restart starts the local Matter runtime without cloud reconciliation");
    assert.ok(store.getArea("offline-room"));
  } finally {
    await hub.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a restored Store is readable for health but all HTTP mutations and radio runtime stay held", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-recovery-gate-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const mqtt = runtimeMock();
  const matter = runtimeMock();
  const hub = createHub({
    store,
    config: {
      nodeEnv: "development",
      nativeApiHost: "127.0.0.1",
      nativeApiPort: 0,
      dataDir: directory,
      dataFile: path.join(directory, "dinodia.json"),
      backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"),
      otbrUrl: "",
      v2Environment: "test",
    },
    mqttBridge: mqtt,
    matterBridge: matter,
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false }; } },
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    store.state.syncOutboxRecovery = {
      version: 1,
      backupSha256: "a".repeat(64),
      previousStreamId: "verified-backup-stream-0001",
      backupAcknowledgedSequence: 7,
      homeId: "11111111-1111-4111-8111-111111111111",
      hubInstallId: "22222222-2222-4222-8222-222222222222",
      preparedAt: new Date().toISOString(),
    };
    await store.persist();
    await hub.start();
    const port = hub.server.address().port;
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(health.storeRecovery, { pending: true, phase: "awaiting_current_policy_snapshot_receipt" });

    const mutationResponse = await fetch(`http://127.0.0.1:${port}/api/integrations/zigbee/pairing`, { method: "POST" });
    const mutation = await mutationResponse.json();
    assert.equal(mutationResponse.status, 503);
    assert.equal(mutation.errorCode, "store_backup_recovery_pending");
    assert.equal(mutation.retryable, true);
    assert.equal(mqtt.starts, 0, "Zigbee/MQTT ingestion remains deferred until cloud reconciliation is durably accepted");
    assert.equal(matter.starts, 0, "Matter runtime remains deferred until cloud reconciliation is durably accepted");
  } finally {
    await hub.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
