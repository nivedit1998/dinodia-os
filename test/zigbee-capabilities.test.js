const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { commandForBinding } = require("../src/integrations/zigbee/commandAdapter");
const { parseDiscovery } = require("../src/integrations/zigbee/discoveryRegistry");

function threeGang() {
  return normalizeZigbeeDevice({
    friendly_name: "three-gang",
    ieee_address: "0x00124b00abcd1234",
    definition: { vendor: "Test", model: "3G", exposes: [
      { type: "switch", endpoint: "l1", features: [{ type: "binary", name: "state", property: "state_l1", access: 7 }] },
      { type: "switch", endpoint: "l2", features: [{ type: "binary", name: "state", property: "state_l2", access: 7 }] },
      { type: "switch", endpoint: "l3", features: [{ type: "binary", name: "state", property: "state_l3", access: 7 }] },
      { type: "numeric", name: "Voltage", property: "voltage", unit: "V", access: 1 },
    ] },
  });
}

test("Zigbee normalizer keeps endpoint-specific child entities and approved commands", () => {
  const device = threeGang();
  assert.equal(device.id, "zigbee:00124b00abcd1234");
  assert.deepEqual(Object.values(device.entities).filter((entity) => entity.domain === "switch").map((entity) => entity.endpointId).sort(), ["l1", "l2", "l3"]);
  const entity = Object.values(device.entities).find((candidate) => candidate.endpointId === "l2");
  assert.deepEqual(entity.capability.services, ["switch.turn_on", "switch.turn_off", "switch.toggle"]);
  assert.deepEqual(commandForBinding(entity, "switch.turn_on"), { state_l2: "ON" });
  assert.equal(Object.values(device.entities).find((candidate) => candidate.stateKey === "voltage").domain, "sensor");
});

test("Zigbee discovery is parsed as metadata and never executes templates", () => {
  const parsed = parseDiscovery("dinodia-ha/sensor/three_voltage/config", JSON.stringify({ unique_id: "three_voltage", state_topic: "zigbee2mqtt/three-gang", value_template: "{{ value_json.voltage }}", device_class: "voltage" }));
  assert.equal(parsed.uniqueId, "three_voltage");
  assert.equal(parsed.topics.state, "zigbee2mqtt/three-gang");
  assert.equal(parsed.semantic.valueTemplate, "{{ value_json.voltage }}");
});

test("Zigbee commands map normalized climate values to device-specific exposed properties", () => {
  const radiator = normalizeZigbeeDevice({
    friendly_name: "radiator-upstairs",
    ieee_address: "0xf044d3fffe1242f6",
    definition: { vendor: "SONOFF", model: "TRVZB", exposes: [{ type: "climate", features: [
      { type: "numeric", property: "occupied_heating_setpoint", access: 7, value_min: 4, value_max: 35, value_step: 0.5 },
      { type: "enum", property: "system_mode", access: 7, values: ["off", "auto", "heat"] },
    ] }] },
  });
  const setpoint = Object.values(radiator.entities).find((entity) => entity.stateKey === "occupied_heating_setpoint");
  const mode = Object.values(radiator.entities).find((entity) => entity.stateKey === "system_mode");
  assert.deepEqual(commandForBinding(setpoint, "number.set_value", { value: 21.5 }), { occupied_heating_setpoint: 21.5 });
  assert.deepEqual(commandForBinding({ ...setpoint, stateKey: "target_level", binding: { property: "target_level" }, capability: { ...setpoint.capability, bindings: [{ serviceId: "number.set_value", parameter: { key: "target_level", type: "number", min: 0, max: 100, step: 1 } }] } }, "number.set_value", { value: 42 }), { target_level: 42 });
  assert.deepEqual(commandForBinding(mode, "select.select_option", { option: "heat" }), { system_mode: "heat" });
});
