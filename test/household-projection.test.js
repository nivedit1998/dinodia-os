const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../src/store");
const { HomeAssistantModel } = require("../src/haModel");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { normalizeMatterNode } = require("../src/integrations/matter/nodeNormalizer");

function load(relative) { return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", relative), "utf8")); }

async function modelWith(device, label = "light") {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dinodia-household-projection-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveArea({ name: "Projection room" }, "projection-room");
  await store.upsertDevice(device);
  await store.completeDeviceSetup(device.id, { areaId: "projection-room", labelId: label });
  const calls = [];
  const model = new HomeAssistantModel({ store, commandDevice: async (...args) => calls.push(["device", ...args]), commandEntity: async (...args) => calls.push(["entity", ...args]) });
  return { store, model, calls };
}

test("household projection excludes raw voltage and exposes the merged light contract", async () => {
  const { store, model, calls } = await modelWith(normalizeZigbeeDevice(load("zigbee/dimmable-light.json")));
  assert.equal(model.entities().length, 1);
  const entity = model.entities()[0];
  assert.equal(entity.domain, "light");
  assert.equal(model.states()[0].attributes.area_id, "projection-room");
  assert.equal(model.entityRegistry()[0].labels.length, 0);
  assert.equal(model.entities().some((item) => item.entity.stateKey === "voltage"), false);
  assert.equal(Object.keys(store.getDevice(entity.device.id).entities).some((id) => id.includes("voltage")), true);
  await model.callService("light", "turn_on", { entity_id: entity.haId, brightness: 100 });
  assert.deepEqual(calls.map((entry) => entry[3]), ["light.turn_on", "number.set_value"]);
  assert.equal(calls[1][4].value, 100);
});

test("Matter multi-endpoint switches use the same surface contract as Zigbee", async () => {
  const { model } = await modelWith(normalizeMatterNode(load("matter/two-endpoint-switch-node.json")));
  const entities = model.entities();
  assert.equal(entities.length, 2);
  assert.ok(entities.every((item) => item.domain === "light"));
  assert.equal(new Set(entities.map((item) => item.haId)).size, 2);
  assert.ok(entities.every((item) => item.entity.attributes.dinodia_presentation.semantic_type === "light"));
});
