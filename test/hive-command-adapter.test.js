const test = require("node:test");
const assert = require("node:assert/strict");
const { commandForService } = require("../src/integrations/hive/commandAdapter");

const device = { state: { min_temperature: 5, max_temperature: 32 } };

test("Hive heating command mapping uses the documented cloud operations", () => {
  assert.deepEqual(commandForService("climate.turn_on", {}, device), { operation: "heating.set_mode", mode: "SCHEDULE" });
  assert.deepEqual(commandForService("climate.turn_off", {}, device), { operation: "heating.set_mode", mode: "OFF" });
  assert.deepEqual(commandForService("climate.set_hvac_mode", { hvac_mode: "heat" }, device), { operation: "heating.set_mode", mode: "MANUAL" });
  assert.deepEqual(commandForService("climate.set_temperature", { temperature: 21.5 }, device), { operation: "heating.set_target_temperature", temperature: 21.5 });
});

test("Hive command validation rejects unsafe, unsupported or out-of-range controls", () => {
  assert.throws(() => commandForService("climate.set_hvac_mode", { hvac_mode: "cool" }, device), { code: "command_rejected" });
  assert.throws(() => commandForService("climate.set_temperature", { temperature: 0 }, device), { code: "command_rejected" });
  assert.throws(() => commandForService("light.turn_on", {}, device), { code: "unsupported_service" });
});
