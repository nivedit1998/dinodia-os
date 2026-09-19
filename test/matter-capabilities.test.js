const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMatterNode } = require("../src/integrations/matter/nodeNormalizer");
const { commandForBinding } = require("../src/integrations/matter/commandAdapter");

test("Matter endpoint and cluster data creates typed controls", () => {
  const device = normalizeMatterNode({ node_id: 17, fabric_id: "fabric-a", name: "Matter lamp", endpoints: {
    1: { device_types: [{ id: 257 }], clusters: { 6: { attributes: { 0: true } }, 8: { attributes: { 0: 128 } } } },
  } });
  assert.equal(device.id, "matter:fabric-a:17");
  const controls = Object.values(device.entities);
  const onoff = controls.find((entity) => entity.binding.clusterId === "6");
  const level = controls.find((entity) => entity.binding.clusterId === "8");
  assert.equal(onoff.domain, "switch");
  assert.ok(onoff.capability.services.includes("switch.toggle"));
  assert.equal(level.domain, "number");
  assert.deepEqual(commandForBinding(onoff, "switch.turn_on"), { endpoint_id: 1, cluster_id: 6, attribute_id: 0, command_name: "on", operation: "turn_on" });
  assert.deepEqual(commandForBinding(level, "number.set_value", { value: 200 }), { endpoint_id: 1, cluster_id: 8, attribute_id: 0, command_name: "move_to_level", operation: "set_value", payload: { value: 200 } });
});

test("Matter nodes without endpoint data still remain compatible and observable", () => {
  const device = normalizeMatterNode({ node_id: 7, state: { power: "OFF", temperature: 21 } });
  assert.equal(device.legacyIds[0], "matter-7");
  assert.ok(Object.values(device.entities).some((entity) => entity.domain === "switch"));
  assert.ok(Object.values(device.entities).some((entity) => entity.domain === "sensor"));
});

test("Matter devices use vendor/product names instead of node IDs by default", () => {
  const device = normalizeMatterNode({ node_id: 17, vendor_name: "Eve", product_name: "Thermo" });
  assert.equal(device.name, "Eve Thermo");
});

test("Matter standard cover and fan clusters expose only typed controls", () => {
  const device = normalizeMatterNode({ node_id: 18, fabric_id: "fabric-a", name: "Matter cover and fan", endpoints: {
    1: { device_types: [{ id: 514 }], clusters: { 258: { attributes: { 8: 50 } } } },
    2: { device_types: [{ id: 19 }], clusters: { 514: { attributes: { 0: "medium", 2: 75 } } } },
  } });
  const cover = Object.values(device.entities).find((entity) => entity.domain === "cover");
  const fan = Object.values(device.entities).find((entity) => entity.domain === "fan" && entity.binding.attributeId === "2");
  assert.ok(cover.capability.services.includes("cover.open_cover"));
  assert.ok(cover.capability.services.includes("cover.set_cover_position"));
  assert.ok(fan.capability.services.includes("fan.set_percentage"));
  assert.deepEqual(commandForBinding(cover, "cover.open_cover"), { endpoint_id: 1, cluster_id: 258, attribute_id: 8, command_name: "open", operation: "open_cover" });
  assert.deepEqual(commandForBinding(fan, "fan.set_percentage", { percentage: 60 }), { endpoint_id: 2, cluster_id: 514, attribute_id: 2, command_name: "write_attribute", operation: "set_percentage", payload: { percentage: 60 } });
});
