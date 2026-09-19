function number(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw Object.assign(new Error(`${name} must be numeric`), { statusCode: 400, code: "invalid_value" });
  return result;
}

function validateParameter(parameter, value) {
  if (!parameter) return value;
  if (parameter.type === "number") {
    const numeric = number(value, parameter.key);
    if (parameter.min !== undefined && numeric < Number(parameter.min)) throw Object.assign(new Error(`${parameter.key} is below its minimum`), { statusCode: 400, code: "invalid_value" });
    if (parameter.max !== undefined && numeric > Number(parameter.max)) throw Object.assign(new Error(`${parameter.key} is above its maximum`), { statusCode: 400, code: "invalid_value" });
    return numeric;
  }
  if (parameter.type === "boolean") {
    if (typeof value !== "boolean") throw Object.assign(new Error(`${parameter.key} must be boolean`), { statusCode: 400, code: "invalid_value" });
    return value;
  }
  const string = String(value || "");
  if (parameter.options?.length && !parameter.options.includes(string)) throw Object.assign(new Error(`${parameter.key} is not an available option`), { statusCode: 400, code: "invalid_value" });
  return string.slice(0, 128);
}

function resolveParameterValue(parameter, data = {}) {
  if (!parameter || !data || typeof data !== "object") return undefined;
  if (data[parameter.key] !== undefined) return data[parameter.key];
  const aliases = ["value", "temperature", "humidity", "brightness", "color_temp", "position", "percentage", "option", "hvac_mode", "preset_mode"];
  for (const key of aliases) if (data[key] !== undefined) return data[key];
  const metadataKeys = new Set(["entity_id", "device_id", "area_id", "label_id", "target"]);
  const candidates = Object.entries(data).filter(([key]) => !metadataKeys.has(key));
  return candidates.length === 1 ? candidates[0][1] : undefined;
}

function commandForBinding(entity, serviceId, data = {}) {
  const capability = entity?.capability || {};
  const binding = (capability.bindings || []).find((item) => item.serviceId === serviceId);
  if (!binding) throw Object.assign(new Error(`${serviceId} is not supported for this entity`), { statusCode: 400, code: "unsupported_service" });
  const operation = binding.operation || serviceId.split(".").pop();
  const property = entity.binding?.property || entity.stateKey || "state";
  if (["turn_on", "turn_off", "toggle"].includes(operation)) {
    const result = { [property]: operation === "turn_on" ? (entity.expose?.value_on ?? "ON") : operation === "turn_off" ? (entity.expose?.value_off ?? "OFF") : (entity.expose?.value_toggle ?? "TOGGLE") };
    if (operation === "turn_on" && data.brightness !== undefined) result.brightness = number(data.brightness, "brightness");
    if (operation === "turn_on" && data.brightness_pct !== undefined) result.brightness = Math.round(Math.max(0, Math.min(100, number(data.brightness_pct, "brightness_pct"))) * 2.54);
    return result;
  }
  if (operation === "press") return { [property]: "PRESS" };
  if (operation === "open_cover") return { [property]: "OPEN" };
  if (operation === "close_cover") return { [property]: "CLOSE" };
  if (operation === "stop_cover") return { [property]: "STOP" };
  if (operation === "set_cover_position") return { [property]: number(data.position, "position") };
  if (binding.parameter) {
    // Public capability surfaces use stable service parameters (for example,
    // climate.set_temperature uses `temperature` and number.set_value uses
    // `value`). Zigbee exposes can use a device-specific property name such
    // as `occupied_heating_setpoint`, so accept the normalized public value
    // as a fallback before validating and publishing the raw Zigbee field.
    const parameterValue = resolveParameterValue(binding.parameter, data);
    return { [property]: validateParameter(binding.parameter, parameterValue) };
  }
  const allowed = {};
  for (const [key, value] of Object.entries(data)) if (/^[a-z][a-z0-9_]*$/i.test(key)) allowed[key] = value;
  return allowed;
}

module.exports = { commandForBinding, validateParameter, resolveParameterValue };
