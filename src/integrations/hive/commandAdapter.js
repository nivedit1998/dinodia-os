const MODES = new Set(["auto", "heat", "off"]);

function finite(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function commandForService(serviceId, data = {}, device = {}) {
  const service = String(serviceId || "").toLowerCase();
  const attrs = device.state && typeof device.state === "object" ? device.state : {};
  const min = finite(attrs.min_temperature) ?? 5;
  const max = finite(attrs.max_temperature) ?? 35;
  if (["climate.turn_on", "homeassistant.turn_on"].includes(service)) return { operation: "heating.set_mode", mode: "SCHEDULE" };
  if (["climate.turn_off", "homeassistant.turn_off"].includes(service)) return { operation: "heating.set_mode", mode: "OFF" };
  if (service === "climate.set_hvac_mode") {
    const mode = String(data.hvac_mode || data.mode || "").toLowerCase();
    if (!MODES.has(mode)) throw Object.assign(new Error("Unsupported Hive heating mode"), { code: "command_rejected", statusCode: 400 });
    return { operation: "heating.set_mode", mode: mode === "auto" ? "SCHEDULE" : mode === "heat" ? "MANUAL" : "OFF" };
  }
  if (service === "climate.set_temperature") {
    const temperature = finite(data.temperature ?? data.value);
    if (temperature === null || temperature < min || temperature > max) throw Object.assign(new Error(`Temperature must be between ${min} and ${max}`), { code: "command_rejected", statusCode: 400 });
    return { operation: "heating.set_target_temperature", temperature };
  }
  throw Object.assign(new Error("Service is not supported for Hive heating"), { code: "unsupported_service", statusCode: 400 });
}

module.exports = { commandForService, MODES };
