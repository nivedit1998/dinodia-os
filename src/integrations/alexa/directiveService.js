const { isNativeAlexaEndpointId } = require("./endpointId");

function celsius(value, scale) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error("Temperature value is invalid"), { code: "invalid_value", statusCode: 400 });
  return String(scale || "CELSIUS").toUpperCase() === "FAHRENHEIT" ? (number - 32) * (5 / 9) : number;
}

function findBinding(endpoint, directive) {
  const header = directive?.header || directive || {};
  const key = `${header.namespace}/${header.name}${header.instance ? `/${header.instance}` : ""}`;
  return (endpoint?._bindings || []).find((binding) => binding.directiveKey === key || (binding.namespace === header.namespace && binding.name === header.name && String(binding.instance || "") === String(header.instance || ""))) || null;
}

function compile(binding, directive) {
  if (!binding) throw Object.assign(new Error("Directive is not supported by this endpoint"), { code: "invalid_directive", statusCode: 400 });
  const payload = directive.payload && typeof directive.payload === "object" ? directive.payload : {};
  if (binding.namespace === "Alexa.PowerController") return { serviceId: binding.serviceId, data: {} };
  if (binding.namespace === "Alexa.BrightnessController") {
    const value = Number(payload.brightness);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw Object.assign(new Error("Brightness must be between 0 and 100"), { code: "invalid_value", statusCode: 400 });
    return { serviceId: binding.serviceId, data: { [binding.parameterKey || "brightness"]: value } };
  }
  if (binding.namespace === "Alexa.ThermostatController" && binding.name === "SetTargetTemperature") {
    const target = payload.targetSetpoint;
    const value = celsius(target?.value, target?.scale);
    if (value < 5 || value > 40) throw Object.assign(new Error("Thermostat target is outside the supported range"), { code: "invalid_value", statusCode: 400 });
    return { serviceId: binding.serviceId, data: { [binding.parameterKey || "temperature"]: value } };
  }
  if (binding.namespace === "Alexa.ThermostatController" && binding.name === "SetThermostatMode") {
    const value = String(payload.thermostatMode?.value || "").toLowerCase();
    const mode = { heat: "heat", cool: "cool", auto: "auto", eco: "eco", off: "off" }[value];
    if (!mode) throw Object.assign(new Error("Thermostat mode is not supported"), { code: "invalid_value", statusCode: 400 });
    return { serviceId: binding.serviceId, data: { [binding.parameterKey || "hvac_mode"]: mode } };
  }
  if (binding.namespace === "Alexa.RangeController") {
    const value = Number(payload.rangeValue);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw Object.assign(new Error("Range value must be between 0 and 100"), { code: "invalid_value", statusCode: 400 });
    return { serviceId: binding.serviceId, data: { [binding.parameterKey || "position"]: value } };
  }
  throw Object.assign(new Error("Directive is not implemented"), { code: "invalid_directive", statusCode: 400 });
}

async function executeDirective({ catalogue, directive, executeControl } = {}) {
  const endpointId = directive?.endpoint?.endpointId;
  if (!isNativeAlexaEndpointId(endpointId)) throw Object.assign(new Error("Unknown native Alexa endpoint"), { code: "no_such_endpoint", statusCode: 404 });
  const endpoint = (catalogue?._internalEndpoints || catalogue?.endpoints || []).find((item) => item.endpointId === endpointId);
  if (!endpoint) throw Object.assign(new Error("Endpoint is no longer available"), { code: "no_such_endpoint", statusCode: 404 });
  if (!endpoint.available) throw Object.assign(new Error("Device is unavailable"), { code: "endpoint_unreachable", statusCode: 503 });
  const binding = findBinding(endpoint, directive);
  const compiled = compile(binding, directive);
  await executeControl({ deviceId: endpoint.deviceId, surfaceId: endpoint.channelId, serviceId: compiled.serviceId, data: compiled.data, messageId: directive?.header?.messageId });
  return endpoint;
}

module.exports = { executeDirective, compile, findBinding };
