const test = require("node:test");
const assert = require("node:assert/strict");
const { commandForService } = require("../src/integrations/googleNest/commandAdapter");

const device = { state: { available_modes: ["OFF", "HEAT"], min_temperature: 9, max_temperature: 32, eco_mode: "OFF" } };

test("Nest commands map only safe advertised heating operations", () => {
  assert.deepEqual(commandForService("climate.turn_on", {}, device), { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "HEAT" } });
  assert.deepEqual(commandForService("climate.turn_off", {}, device), { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "OFF" } });
  assert.deepEqual(commandForService("climate.set_temperature", { temperature: 21 }, device), { command: "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat", params: { heatCelsius: 21 } });
  assert.deepEqual(commandForService("climate.set_hvac_mode", { hvac_mode: "heat" }, device).params, { mode: "HEAT" });
});

test("Nest commands reject unsupported modes, unsafe setpoints, and Manual Eco", () => {
  assert.throws(() => commandForService("climate.set_hvac_mode", { hvac_mode: "cool" }, device), (error) => error.code === "command_rejected");
  assert.throws(() => commandForService("climate.set_temperature", { temperature: 99 }, device), (error) => error.code === "command_rejected");
  assert.throws(() => commandForService("climate.set_temperature", { temperature: Number.NaN }, device), (error) => error.code === "command_rejected");
  assert.throws(() => commandForService("climate.set_temperature", { temperature: 20 }, { ...device, state: { ...device.state, eco_mode: "MANUAL_ECO" } }), (error) => error.code === "command_rejected");
});
