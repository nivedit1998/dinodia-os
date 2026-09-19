const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { HomeAssistantModel } = require("../src/haModel");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");

test("capability-derived services route to the protocol adapter and reject unadvertised services", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-routing-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const calls = [];
  const device = normalizeZigbeeDevice({ friendly_name: "lamp", ieee_address: "0xabc", definition: { exposes: [{ type: "switch", features: [{ type: "binary", property: "state", access: 7 }] }] } });
  const area = await store.saveArea({ name: "Living room" }, "living-room");
  await store.upsertDevice(device);
  await store.completeDeviceSetup(device.id, { areaId: area.id, labelId: "light" });
  const model = new HomeAssistantModel({ store, commandDevice: async () => { throw new Error("fallback should not be used"); }, commandEntity: async (physical, entity, serviceId, data) => calls.push({ physical, entity, serviceId, data }) });
  const item = model.entities().find((candidate) => candidate.device.id === device.id);
  assert.ok(item);
  assert.ok(model.servicesForTarget({ entity_id: item.haId }).includes("light.toggle"));
  await model.callService("light", "turn_on", { entity_id: item.haId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serviceId, "switch.turn_on");
  await assert.rejects(() => model.callService("light", "set_temperature", { entity_id: item.haId }), /not supported/);
});
