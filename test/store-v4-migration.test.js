const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");

test("legacy store data gains identity/capability metadata without losing user assignments", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-v4-migration-"));
  const file = path.join(directory, "dinodia.json");
  await fs.writeFile(file, JSON.stringify({ version: 3, areas: { kitchen: { id: "kitchen", name: "Kitchen" } }, devices: {
    lamp: { id: "lamp", protocol: "zigbee", name: "My lamp", areaId: "kitchen", metadata: { ieee_address: "0x123", friendly_name: "lamp" }, state: { state: "ON" }, entities: { "lamp:state": { id: "lamp:state", stateKey: "state", name: "My light", labelIds: ["light"] } } },
  } }));
  const store = new Store(file);
  assert.equal(store.snapshot().version, 10);
  assert.equal(store.getDevice("lamp").name, "My lamp");
  assert.equal(store.getDevice("lamp").protocolIdentity.ieeeAddress, "0x123");
  assert.equal(store.getDevice("lamp").entities["lamp:state"].name, "My light");
  assert.equal(store.getDevice("lamp").areaId, "kitchen");
  const before = store.snapshot();
  const reloaded = new Store(file);
  assert.deepEqual({ ...reloaded.snapshot(), updatedAt: null }, { ...before, updatedAt: null });
});

test("legacy event history is conservatively migrated into the activity ledger", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-activity-migration-"));
  const file = path.join(directory, "dinodia.json");
  await fs.writeFile(file, JSON.stringify({ version: 5, events: [{ id: "legacy-1", timestamp: new Date().toISOString(), type: "device_command", deviceId: "radiator-1", protocol: "zigbee" }] }));
  const store = new Store(file);
  const migrated = store.listActivity({ limit: 10 }).records;
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].id, "legacy:legacy-1");
  assert.equal(migrated[0].severity, "system");
  assert.equal(migrated[0].device.name, "radiator-1");
  assert.equal(store.getActivityState().legacyEventsMigrated, true);
});
