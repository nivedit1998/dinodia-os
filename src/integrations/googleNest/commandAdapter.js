function finite(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function deviceModes(device) { return Array.isArray(device?.state?.available_modes) ? device.state.available_modes.map((mode) => String(mode).toUpperCase()) : []; }
function requireMode(device, mode) { if (!deviceModes(device).includes(mode)) throw Object.assign(new Error(`Google Nest does not advertise ${mode.toLowerCase()} mode`), { code: "command_rejected", statusCode: 400 }); }

function commandForService(serviceId, data = {}, device = {}) {
  const service = String(serviceId || "").toLowerCase();
  const modes = deviceModes(device);
  if (["climate.turn_off", "homeassistant.turn_off"].includes(service)) { requireMode(device, "OFF"); return { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: "OFF" } }; }
  if (["climate.turn_on", "homeassistant.turn_on"].includes(service)) { const selected = modes.includes("HEAT") ? "HEAT" : modes.includes("ON") ? "ON" : null; if (!selected) throw Object.assign(new Error("Google Nest has no advertised heating mode"), { code: "command_rejected", statusCode: 400 }); return { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: selected } }; }
  if (service === "climate.set_hvac_mode") {
    const wanted = String(data.hvac_mode || data.mode || "").trim().toLowerCase();
    const mapped = wanted === "heat" ? "HEAT" : wanted === "off" ? "OFF" : wanted === "on" ? "ON" : "";
    if (!mapped) throw Object.assign(new Error("Only the advertised Nest heat and off modes are supported"), { code: "command_rejected", statusCode: 400 });
    requireMode(device, mapped);
    return { command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: mapped } };
  }
  if (service === "climate.set_temperature") {
    const value = finite(data.temperature ?? data.value);
    const min = finite(device.state?.min_temperature) ?? 9;
    const max = finite(device.state?.max_temperature) ?? 32;
    if (value === null || value < min || value > max) throw Object.assign(new Error(`Temperature must be between ${min} and ${max}°C`), { code: "command_rejected", statusCode: 400 });
    if (String(device.state?.eco_mode || "").toUpperCase() === "MANUAL_ECO") throw Object.assign(new Error("Google Nest is in Manual Eco; change Eco mode in Google Home before setting a target temperature"), { code: "command_rejected", statusCode: 409 });
    return { command: "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat", params: { heatCelsius: value } };
  }
  throw Object.assign(new Error("Service is not supported for Google Nest heating"), { code: "unsupported_service", statusCode: 400 });
}

module.exports = { commandForService, deviceModes };
