const test = require("node:test");
const assert = require("node:assert/strict");
const { commandForBinding } = require("../src/integrations/matter/commandAdapter");

function entity() {
  return {
    endpointId: "1",
    binding: { endpointId: "1", clusterId: 8, attributeId: 0 },
    capability: { bindings: [{ serviceId: "number.set_value", parameter: { key: "value", type: "number", min: 0, max: 254 } }] },
  };
}

test("Matter adapter emits a typed endpoint command without accepting a raw target", () => {
  const result = commandForBinding(entity(), "number.set_value", { value: 200 });
  assert.deepEqual(result, { endpoint_id: 1, cluster_id: 8, attribute_id: 0, command_name: "MoveToLevel", operation: "set_value", payload: { level: 200, transitionTime: 0 } });
});

test("Matter adapter rejects out-of-range values and unsupported operations", () => {
  assert.throws(() => commandForBinding(entity(), "number.set_value", { value: 255 }), /above its maximum/);
  assert.throws(() => commandForBinding({ ...entity(), capability: { bindings: [{ serviceId: "sensor.read" }] } }, "sensor.read"), /supported/);
});

test('Matter no-argument cluster commands include the required payload dictionary', () => {
  const { normalizeMatterNode } = require('../src/integrations/matter/nodeNormalizer');
  const device = normalizeMatterNode({node_id:52,fabric_id:'f',attributes:{'1/6/0':true,'2/258/8':50,'2/258/65529':[0,1,2]}});
  for (const item of Object.values(device.entities)) for (const service of item.capability?.services || []) {
    if (!['switch.turn_on','switch.turn_off','switch.toggle','cover.open_cover','cover.close_cover','cover.stop_cover'].includes(service)) continue;
    assert.deepEqual(commandForBinding(item, service, {}, device).payload, {}, service);
  }
});
