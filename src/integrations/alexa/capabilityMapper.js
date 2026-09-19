const { clone, text } = require("./contracts");

function route(surface, serviceId) {
  return surface?.serviceRoutes?.[serviceId] || null;
}

function hasRoute(surface, serviceId) {
  return Boolean(route(surface, serviceId));
}

function alexaInterface(interfaceName, properties, extra = {}) {
  return {
    type: "AlexaInterface",
    interface: interfaceName,
    version: "3",
    ...(properties ? { properties } : {}),
    ...extra,
  };
}

function property(name, value, unitOfMeasure = undefined) {
  return {
    namespace: "Alexa.${name}".replace("${name}", ""),
    name,
    value,
    timeOfSample: new Date().toISOString(),
    uncertaintyInMilliseconds: 0,
    ...(unitOfMeasure ? { unitOfMeasure } : {}),
  };
}

function stateProperty(namespace, name, value, unitOfMeasure = undefined) {
  return {
    namespace,
    name,
    value,
    timeOfSample: new Date().toISOString(),
    uncertaintyInMilliseconds: 0,
    ...(unitOfMeasure ? { unitOfMeasure } : {}),
  };
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function powerValue(surface) {
  const raw = surface?.state ?? surface?.attributes?.power ?? surface?.attributes?.state;
  const normalized = String(raw ?? "").toLowerCase();
  return ["on", "open", "heat", "heating", "playing", "unlocked"].includes(normalized) ? "ON" : "OFF";
}

function modeValue(surface) {
  const raw = surface?.attributes?.hvac_mode ?? surface?.state;
  const normalized = String(raw ?? "off").toLowerCase();
  if (normalized === "heat" || normalized === "heating") return "HEAT";
  if (normalized === "cool") return "COOL";
  if (normalized === "auto") return "AUTO";
  if (normalized === "eco") return "ECO";
  return "OFF";
}

function mapSurface(surface) {
  const domain = String(surface?.domain || "").toLowerCase();
  const capabilities = [alexaInterface("Alexa", null), alexaInterface("Alexa.EndpointHealth", { supported: [{ name: "connectivity" }], proactivelyReported: true, retrievable: true })];
  const controls = [];
  const state = [stateProperty("Alexa.EndpointHealth", "connectivity", { value: surface?.available !== false ? "OK" : "UNREACHABLE" })];
  const addPower = (serviceId, name) => {
    controls.push({ directiveKey: `Alexa.PowerController/${name}`, namespace: "Alexa.PowerController", name, instance: null, controlId: `${surface.id}::power`, surfaceId: String(surface.id), serviceId });
  };

  if (hasRoute(surface, "light.turn_on") && hasRoute(surface, "light.turn_off")) {
    capabilities.push(alexaInterface("Alexa.PowerController", { supported: [{ name: "powerState" }], proactivelyReported: true, retrievable: true }));
    addPower("light.turn_on", "TurnOn");
    addPower("light.turn_off", "TurnOff");
    state.push(stateProperty("Alexa.PowerController", "powerState", powerValue(surface)));
  } else if (hasRoute(surface, "switch.turn_on") && hasRoute(surface, "switch.turn_off")) {
    capabilities.push(alexaInterface("Alexa.PowerController", { supported: [{ name: "powerState" }], proactivelyReported: true, retrievable: true }));
    addPower("switch.turn_on", "TurnOn");
    addPower("switch.turn_off", "TurnOff");
    state.push(stateProperty("Alexa.PowerController", "powerState", powerValue(surface)));
  } else if (hasRoute(surface, "climate.turn_on") && hasRoute(surface, "climate.turn_off")) {
    capabilities.push(alexaInterface("Alexa.PowerController", { supported: [{ name: "powerState" }], proactivelyReported: true, retrievable: true }));
    addPower("climate.turn_on", "TurnOn");
    addPower("climate.turn_off", "TurnOff");
    state.push(stateProperty("Alexa.PowerController", "powerState", powerValue(surface)));
  }

  const brightnessRoute = route(surface, "light.turn_on");
  if (brightnessRoute?.parameters?.brightness || numeric(surface?.attributes?.brightness) !== null) {
    capabilities.push(alexaInterface("Alexa.BrightnessController", { supported: [{ name: "brightness" }], proactivelyReported: true, retrievable: true }));
    controls.push({ directiveKey: "Alexa.BrightnessController/SetBrightness", namespace: "Alexa.BrightnessController", name: "SetBrightness", instance: null, controlId: `${surface.id}::brightness`, surfaceId: String(surface.id), serviceId: "light.turn_on", parameterKey: "brightness" });
    const brightness = numeric(surface?.attributes?.brightness);
    if (brightness !== null) state.push(stateProperty("Alexa.BrightnessController", "brightness", Math.max(0, Math.min(100, brightness)), "Alexa.Unit.Percent"));
  }

  if (domain === "climate" && (route(surface, "climate.set_temperature") || surface?.attributes?.temperature !== undefined)) {
    const modes = Array.isArray(surface?.attributes?.hvac_modes) ? surface.attributes.hvac_modes.map((value) => String(value).toUpperCase()).filter(Boolean) : ["OFF", "HEAT", "AUTO"];
    capabilities.push(alexaInterface("Alexa.ThermostatController", { supported: [{ name: "targetSetpoint" }, { name: "thermostatMode" }], proactivelyReported: true, retrievable: true }, { configuration: { supportedModes: [...new Set(modes)].map((value) => ({ value })) } }));
    if (route(surface, "climate.set_temperature")) controls.push({ directiveKey: "Alexa.ThermostatController/SetTargetTemperature", namespace: "Alexa.ThermostatController", name: "SetTargetTemperature", instance: null, controlId: `${surface.id}::target_temperature`, surfaceId: String(surface.id), serviceId: "climate.set_temperature", parameterKey: "temperature" });
    if (route(surface, "climate.set_hvac_mode")) controls.push({ directiveKey: "Alexa.ThermostatController/SetThermostatMode", namespace: "Alexa.ThermostatController", name: "SetThermostatMode", instance: null, controlId: `${surface.id}::thermostat_mode`, surfaceId: String(surface.id), serviceId: "climate.set_hvac_mode", parameterKey: "hvac_mode" });
    const target = numeric(surface?.attributes?.temperature);
    if (target !== null) state.push(stateProperty("Alexa.ThermostatController", "targetSetpoint", { value: target, scale: "CELSIUS" }));
    state.push(stateProperty("Alexa.ThermostatController", "thermostatMode", { value: modeValue(surface) }));
  }

  if (domain === "climate" && surface?.attributes?.current_temperature !== undefined) {
    capabilities.push(alexaInterface("Alexa.TemperatureSensor", { supported: [{ name: "temperature" }], proactivelyReported: true, retrievable: true }));
    const current = numeric(surface.attributes.current_temperature);
    if (current !== null) state.push(stateProperty("Alexa.TemperatureSensor", "temperature", { value: current, scale: "CELSIUS" }));
  }

  if (domain === "cover" && route(surface, "cover.set_cover_position")) {
    capabilities.push(alexaInterface("Alexa.RangeController", { supported: [{ name: "rangeValue" }], proactivelyReported: true, retrievable: true }, { instance: "Opening", capabilityResources: { friendlyNames: [{ value: { assetId: "Alexa.Setting.Opening" } }] }, configuration: { supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 }, unitOfMeasure: "Alexa.Unit.Percent" } }));
    controls.push({ directiveKey: "Alexa.RangeController/SetRangeValue/Opening", namespace: "Alexa.RangeController", name: "SetRangeValue", instance: "Opening", controlId: `${surface.id}::opening_percent`, surfaceId: String(surface.id), serviceId: "cover.set_cover_position", parameterKey: "position" });
    const position = numeric(surface?.attributes?.current_position ?? surface?.attributes?.position);
    if (position !== null) state.push(stateProperty("Alexa.RangeController", "rangeValue", Math.max(0, Math.min(100, position)), "Alexa.Unit.Percent"));
  }

  return { capabilities, controls, state };
}

function publicEndpointParts(mapped) {
  return {
    capabilities: clone(mapped.capabilities),
    controls: mapped.controls.map(({ serviceId, parameterKey, ...control }) => control),
    state: clone(mapped.state),
    _bindings: clone(mapped.controls),
  };
}

module.exports = { mapSurface, publicEndpointParts, stateProperty, numeric };
