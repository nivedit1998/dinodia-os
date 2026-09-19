const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { HeatingUsageTracker } = require("../src/heatingUsage");

test("heating usage tracks labeled intervals and acknowledges platform resets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-heating-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveLabel({ name: "Boiler" }, "boiler");
  const tracker = new HeatingUsageTracker({ store, entityIdFor: (_entity, _device, rawId) => `climate.example_${rawId}` });
  const first = await store.upsertDevice({ id: "boiler", name: "Boiler", protocol: "virtual", labelIds: ["boiler"], state: { power: "OFF" } });
  await tracker.onDeviceChanged(first, new Date("2026-08-30T10:00:00.000Z"));
  const second = await store.updateDeviceState("boiler", { power: "ON" });
  await tracker.onDeviceChanged(second, new Date("2026-08-30T10:00:10.000Z"));
  const payload = tracker.payload();
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.devices[0].label, "Boiler");
  assert.equal(payload.devices[0].offSeconds, 10);
  tracker.applyPlatformResponse({ heatingUsageResetAt: "2026-08-30T11:00:00.000Z" });
  assert.equal(tracker.resetAcknowledgement(), "2026-08-30T11:00:00.000Z");
  tracker.acknowledgeReset("2026-08-30T11:00:00.000Z");
  assert.equal(tracker.resetAcknowledgement(), null);
});
