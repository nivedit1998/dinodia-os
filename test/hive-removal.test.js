const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { normalizeHiveDevices } = require("../src/integrations/hive/deviceNormalizer");

test("Hive tombstones block a removed zone until an explicit restore", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-hive-removal-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const device = normalizeHiveDevices({ accountId: "account", devices: [{ cloudId: "zone-1", kind: "heating", name: "Downstairs", state: { mode: "SCHEDULE" } }] }, { machineKey: "test-key" }).devices[0];
  await store.upsertDevice(device);
  await store.saveHive({ configured: true, status: "connected" });
  const cloudId = device.protocolIdentity.cloudId;
  await store.saveHive({ ignoredDeviceIds: [cloudId], ignoredDeviceSummaries: [{ cloudId, name: device.name, model: "V4" }] });
  assert.deepEqual(store.getHive().ignoredDeviceIds, [cloudId]);
  assert.equal(normalizeHiveDevices({ accountId: "account", devices: [{ cloudId: "zone-1", kind: "heating", name: "Downstairs" }] }, { accountFingerprint: device.protocolIdentity.accountFingerprint, machineKey: "test-key" }).devices.filter((item) => !store.getHive().ignoredDeviceIds.includes(item.protocolIdentity.cloudId)).length, 0);
  await store.clearHive();
  assert.equal(store.getDevice(device.id), null);
  assert.equal(store.getHive().configured, false);
});
