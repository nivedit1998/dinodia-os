const test = require("node:test");
const assert = require("node:assert/strict");
const { projectionForEntity, servicesForCapability } = require("../src/capabilities/haProjection");

test("HA projection exposes only the normalized public capability and typed services", () => {
  const entity = {
    id: "zigbee:0x001:1:level",
    name: "Lamp level",
    stateKey: "level",
    capability: {
      runtime: "dinodia_os",
      kind: "number",
      writable: true,
      bindings: [{ serviceId: "number.set_value", parameter: { key: "value", type: "number", min: 0, max: 100, step: 1 } }],
    },
  };
  const result = projectionForEntity(entity);
  assert.deepEqual(result.services, ["number.set_value"]);
  assert.equal(result.attributes.dinodia_capability.runtime, "dinodia_os");
  assert.equal(result.attributes.dinodia_capability.services[0].parameter.max, 100);
  assert.deepEqual(servicesForCapability(entity), ["number.set_value"]);
});

test("legacy entities do not receive the Dinodia-only manifest", () => {
  const result = projectionForEntity({ id: "light:old", stateKey: "state", domain: "light" });
  assert.equal(result.attributes.dinodia_capability, undefined);
  assert.deepEqual(servicesForCapability({ id: "light:old", stateKey: "state", domain: "light" }), []);
});
