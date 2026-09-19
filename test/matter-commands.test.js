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
  assert.deepEqual(result, { endpoint_id: 1, cluster_id: 8, attribute_id: 0, command_name: "move_to_level", operation: "set_value", payload: { value: 200 } });
});

test("Matter adapter rejects out-of-range values and unsupported operations", () => {
  assert.throws(() => commandForBinding(entity(), "number.set_value", { value: 255 }), /above its maximum/);
  assert.throws(() => commandForBinding({ ...entity(), capability: { bindings: [{ serviceId: "sensor.read" }] } }, "sensor.read"), /supported/);
});
