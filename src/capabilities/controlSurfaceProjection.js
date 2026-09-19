const { normalizeCapability, publicCapability } = require("./schema");
const { getSurfaces, rawEntityById, publicPresentation } = require("./devicePresentation");
const { surfaceRouteFor } = require("./serviceRouter");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function token(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sourceEntities(device, surface) {
  const ids = Array.isArray(surface?.sourceEntityIds) ? surface.sourceEntityIds : [];
  return ids.map((id) => rawEntityById(device, id)).filter(Boolean);
}

function valueFor(entities, patterns) {
  for (const entity of entities) {
    for (const pattern of patterns) {
      if (entity.expose?.[pattern] !== undefined) return clone(entity.expose[pattern]);
    }
    const text = [entity.stateKey, entity.logicalKey, entity.name, entity.expose?.property, entity.binding?.property].map(token).join("_");
    if (patterns.some((pattern) => { const wanted = token(pattern); return text === wanted || text.includes(wanted) || text.includes(wanted.replaceAll("_", "")); })) {
      if (entity.state !== undefined) return clone(entity.state);
    }
  }
  return undefined;
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function normalizeState(value, domain) {
  if (value === true) return "on";
  if (value === false) return "off";
  const raw = String(value === undefined || value === null ? "unknown" : value).trim();
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (domain === "climate") {
    if (["off", "idle", "standby"].includes(lower)) return lower === "off" ? "off" : "idle";
    if (["heat", "heating", "on", "auto", "cool", "dry", "fan_only"].includes(lower)) return lower === "heating" ? "heat" : lower;
  }
  return lower;
}

function liveAttributes(device, surface, sources) {
  const attributes = clone(surface.attributes || {});
  const domain = String(surface.domain || "");
  if (domain === "light") {
    const brightness = numeric(valueFor(sources, ["brightness", "level", "current_level"]));
    if (brightness !== undefined) attributes.brightness = brightness;
    const colorTemp = numeric(valueFor(sources, ["color_temp", "color_temperature"]));
    if (colorTemp !== undefined) attributes.color_temp = colorTemp;
    const color = valueFor(sources, ["color", "colour", "hs_color", "rgb_color"]);
    if (color !== undefined) attributes.hs_color = clone(color);
  }
  if (domain === "climate") {
    const target = numeric(valueFor(sources, ["temperature", "target_temperature", "target_temp", "occupied_heating_setpoint", "current_heating_setpoint"]));
    const current = numeric(valueFor(sources, ["current_temperature", "current_temp", "local_temperature", "measured_temperature"]));
    if (target !== undefined) attributes.temperature = target;
    if (current !== undefined) attributes.current_temperature = current;
    const mode = valueFor(sources, ["hvac_mode", "system_mode", "mode", "running_state"]);
    if (mode !== undefined) attributes.hvac_mode = String(mode).toLowerCase();
    const modes = valueFor(sources, ["hvac_modes", "system_modes", "modes"]);
    if (Array.isArray(modes)) attributes.hvac_modes = clone(modes);
    const action = valueFor(sources, ["hvac_action", "heating_action", "running_state"]);
    if (action !== undefined) attributes.hvac_action = String(action).toLowerCase();
  }
  void device;
  return attributes;
}

function liveState(device, surface, sources) {
  const domain = String(surface.domain || "");
  if (domain === "climate") {
    const mode = valueFor(sources, ["hvac_mode", "system_mode", "mode", "running_state"]);
    if (mode !== undefined) return normalizeState(mode, domain);
  }
  const primary = rawEntityById(device, surface.stateSourceEntityId);
  return normalizeState(primary?.state ?? surface.state, domain);
}

function projectSurface(device, surface) {
  const sources = sourceEntities(device, surface);
  const capability = normalizeCapability(surface.capability || {}, { stateKey: surface.stateKey, kind: "composite", writable: false });
  const attributes = {
    friendly_name: surface.name,
    device_id: String(device.haDeviceId || device.id),
    area_id: device.areaId ? String(device.areaId) : null,
    labels: [],
    ...liveAttributes(device, surface, sources),
    ...publicCapability(capability, surface),
    dinodia_presentation: publicPresentation(surface),
  };
  if (capability.constraints?.options && !attributes.options) attributes.options = clone(capability.constraints.options);
  if (capability.constraints?.min !== undefined && attributes.min === undefined) attributes.min = capability.constraints.min;
  if (capability.constraints?.max !== undefined && attributes.max === undefined) attributes.max = capability.constraints.max;
  if (capability.constraints?.step !== undefined && attributes.step === undefined) attributes.step = capability.constraints.step;
  return {
    ...clone(surface),
    state: liveState(device, surface, sources),
    available: device.available !== false,
    capability,
    attributes,
  };
}

function sourceRoute(device, surface, serviceId) {
  const route = surfaceRouteFor(surface, serviceId);
  if (!route) return null;
  const entity = rawEntityById(device, route.entityId);
  return entity ? { entity, serviceId: route.serviceId, parameters: route.parameters } : null;
}

function allProjectedSurfaces(device) {
  return getSurfaces(device).map((surface) => projectSurface(device, surface));
}

module.exports = { allProjectedSurfaces, liveAttributes, liveState, projectSurface, sourceEntities, sourceRoute };
