const crypto = require("node:crypto");
const { normalizeCapability } = require("./schema");
const { haObjectId } = require("./identity");

const PRESENTATION_VERSION = 1;
const POLICY_REVISION = "device-presentation-v1";
const APPROVED_LABELS = new Set(["light", "boiler", "radiator", "tenant_device"]);
const CONTROL_DOMAINS = new Set(["light", "switch", "cover", "climate", "fan", "lock", "humidifier", "number", "select", "button"]);
const DIAGNOSTIC_DOMAINS = new Set(["sensor", "binary_sensor", "event"]);
const DIAGNOSTIC_TOKENS = new Set([
  "battery", "voltage", "current", "power", "energy", "linkquality", "lqi", "rssi", "last_seen",
  "temperature_calibration", "local_temperature_calibration", "calibration", "child_lock", "window_detection",
  "window_open", "schedule", "program", "motor_state", "running_state", "pi_heating_demand", "identify",
  "firmware", "update", "signal_strength", "occupancy", "motion", "humidity", "pressure", "illuminance",
]);
const CONFIG_TOKENS = new Set(["calibration", "child_lock", "window_detection", "schedule", "program", "reporting", "led"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalize(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function token(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function labelId(device) {
  const values = Array.isArray(device?.labelIds) ? device.labelIds : Array.isArray(device?.labels) ? device.labels : [];
  const value = values.map(token).find((candidate) => APPROVED_LABELS.has(candidate));
  return value || null;
}

function isConfigured(device) {
  return Boolean(device?.areaId && labelId(device));
}

function rawEntities(device) {
  return Object.values(device?.entities || {}).filter((entity) => entity && typeof entity === "object");
}

function sourceKey(entity) {
  return normalize(entity.id || entity.sourceId || entity.stateKey || entity.name);
}

function entityText(entity) {
  return [entity.id, entity.sourceId, entity.stateKey, entity.logicalKey, entity.name, entity.original_name, entity.domain, entity.expose?.property, entity.binding?.property]
    .map(token)
    .filter(Boolean)
    .join("_");
}

function isDiagnostic(entity) {
  const capability = entity.capability || {};
  const category = token(entity.category || capability.category);
  const domain = token(entity.domain);
  const text = entityText(entity);
  if (category === "diagnostic" || category === "config") return true;
  if (DIAGNOSTIC_DOMAINS.has(domain)) return true;
  return [...DIAGNOSTIC_TOKENS].some((item) => text === item || text.startsWith(`${item}_`) || text.includes(`_${item}_`) || text.endsWith(`_${item}`));
}

function isConfig(entity) {
  const text = entityText(entity);
  return [...CONFIG_TOKENS].some((item) => text === item || text.includes(`_${item}`) || text.includes(`${item}_`));
}

function isWritable(entity) {
  const capability = entity.capability || {};
  return Boolean(capability.writable && Array.isArray(capability.bindings) && capability.bindings.length > 0);
}

function services(entity) {
  return (entity?.capability?.bindings || [])
    .map((binding) => String(binding.serviceId || "").trim().toLowerCase())
    .filter(Boolean);
}

function endpointOf(entity) {
  const explicit = normalize(entity.endpointId || entity.binding?.endpointId || entity.expose?.endpoint);
  if (explicit && explicit !== "0") return explicit;
  const textValue = normalize(entity.stateKey || entity.logicalKey || entity.name);
  const channel = textValue.match(/(?:state|switch|channel|gang|outlet|relay|brightness|level|color_temp|color_temperature|temperature|setpoint|target_temperature)[_ -]?(?:l)?(\d+)$/i);
  return channel ? `channel-${channel[1]}` : explicit || "0";
}

function endpointLabel(entity, endpoint) {
  const value = normalize(entity.endpointName || entity.expose?.endpoint_name || entity.expose?.endpointLabel);
  if (value) return value;
  const channel = String(endpoint).match(/(?:channel|endpoint|ep)[-_]?(\d+)/i);
  return channel ? channel[1] : "";
}

function semanticDomain(entity, selectedLabel) {
  const domain = token(entity.domain);
  const textValue = entityText(entity);
  if (selectedLabel === "radiator" || selectedLabel === "boiler") {
    if (domain === "climate" || /(hvac|setpoint|target_temperature|current_temperature|heating|thermostat)/.test(textValue)) return "climate";
    if (domain === "select" && /(mode|hvac|preset)/.test(textValue)) return "climate";
    if (domain === "switch" || domain === "light" || domain === "number") return "climate";
  }
  if (selectedLabel === "light" && (domain === "switch" || domain === "light" || (domain === "number" && /(brightness|level|color|colour)/.test(textValue)))) return "light";
  if (domain === "switch" || domain === "light" || domain === "cover" || domain === "climate" || domain === "fan" || domain === "lock" || domain === "humidifier") return domain;
  if (domain === "number" || domain === "select" || domain === "button") return domain;
  if (/brightness|color|colour|onoff|on_off/.test(textValue)) return "light";
  if (/temperature|hvac|thermostat|heating|setpoint/.test(textValue)) return "climate";
  return domain || "sensor";
}

function primaryCandidate(entity, selectedLabel) {
  if (!isWritable(entity) || isDiagnostic(entity) || isConfig(entity)) return false;
  const domain = semanticDomain(entity, selectedLabel);
  const textValue = entityText(entity);
  const capability = entity.capability || {};
  if (!CONTROL_DOMAINS.has(domain)) return false;
  if (domain === "number" || domain === "select" || domain === "button") return Boolean(capability.primary || /(setpoint|target|level|brightness|mode|preset)/.test(textValue));
  if (domain === "climate") return true;
  if (domain === "light" || domain === "switch") return Boolean(capability.primary || /(state|power|onoff|on_off|switch|relay|outlet)/.test(textValue));
  return Boolean(capability.primary || services(entity).length);
}

function featureCandidate(entity, selectedLabel, groupDomain) {
  if (!isWritable(entity) || isDiagnostic(entity) || isConfig(entity)) return false;
  const domain = semanticDomain(entity, selectedLabel);
  const textValue = entityText(entity);
  if (domain !== groupDomain) {
    if (groupDomain === "light" && /(brightness|color|colour|temperature)/.test(textValue)) return true;
    if (groupDomain === "climate" && /(temperature|hvac|heating|setpoint|preset|mode|running)/.test(textValue)) return true;
    return false;
  }
  return !primaryCandidate(entity, selectedLabel) && Boolean(services(entity).length);
}

function relatedStatus(entity, selectedLabel, groupDomain) {
  if (isConfig(entity) || isDiagnostic(entity)) {
    const textValue = entityText(entity);
    if (groupDomain === "climate" && /(current_temperature|local_temperature|temperature|heating_action|hvac_action|running_state)/.test(textValue)) return true;
    if (groupDomain === "light" && /(brightness|color|colour)/.test(textValue)) return true;
    return false;
  }
  const domain = semanticDomain(entity, selectedLabel);
  return domain === groupDomain && !isWritable(entity);
}

function choosePrimary(group, selectedLabel, groupDomain) {
  const candidates = group.filter((entity) => primaryCandidate(entity, selectedLabel) && semanticDomain(entity, selectedLabel) === groupDomain);
  return candidates.sort((left, right) => {
    const leftText = entityText(left);
    const rightText = entityText(right);
    const score = (entity) => {
      const textValue = entityText(entity);
      let value = entity.capability?.primary ? 100 : 0;
      if (/^(state|power|onoff|on_off)$/.test(token(entity.stateKey || entity.logicalKey))) value += 50;
      if (/(state|power|onoff|on_off)/.test(textValue)) value += 20;
      if (groupDomain === "climate" && /(hvac|system_mode|heating)/.test(textValue)) value += 30;
      return value;
    };
    return score(right) - score(left) || leftText.localeCompare(rightText);
  })[0] || null;
}

function groupKey(entity, selectedLabel) {
  const endpoint = endpointOf(entity);
  const domain = semanticDomain(entity, selectedLabel);
  return `${endpoint}::${domain}`;
}

function groupEntities(device, selectedLabel) {
  const groups = new Map();
  for (const entity of rawEntities(device)) {
    if (!isWritable(entity) && !relatedStatus(entity, selectedLabel, semanticDomain(entity, selectedLabel))) continue;
    const key = groupKey(entity, selectedLabel);
    const existing = groups.get(key) || [];
    existing.push(entity);
    groups.set(key, existing);
  }
  return groups;
}

function safeSurfaceId(device, endpoint, domain) {
  return `${normalize(device.id)}:surface:${haObjectId(endpoint || "0")}:${haObjectId(domain || "control")}`;
}

function physicalSlug(device) {
  const identity = device.protocol === "zigbee"
    ? device.metadata?.ieee_address || device.metadata?.ieee || device.id
    : `${device.protocol || "device"}-${device.id}`;
  return haObjectId(identity, "device");
}

function surfaceName(device, endpoint, domain, index, total, primary) {
  const base = normalize(device.name || device.metadata?.friendly_name || device.id) || "Device";
  const label = endpointLabel(primary || {}, endpoint);
  if (total <= 1) return base;
  if (label && !/^\d+$/.test(label)) return `${base} ${label}`;
  const numeric = String(endpoint).match(/(\d+)$/)?.[1];
  return `${base} ${numeric || index + 1}`;
}

function addBinding(bindings, routes, serviceId, entity, sourceServiceId = serviceId) {
  const normalized = normalize(serviceId).toLowerCase();
  if (!normalized || !entity) return;
  const sourceNormalized = normalize(sourceServiceId).toLowerCase();
  const binding = (entity.capability?.bindings || []).find((candidate) => String(candidate.serviceId || "").toLowerCase() === sourceNormalized);
  if (!binding) return;
  const route = routes[normalized];
  const parameter = binding.parameter ? { ...clone(binding.parameter) } : null;
  if (parameter) {
    if (normalized === "light.turn_on") parameter.key = /(color_temp|color_temperature)/.test(entityText(entity)) ? "color_temp" : "brightness";
    if (normalized === "climate.set_temperature") parameter.key = "temperature";
    if (normalized === "climate.set_hvac_mode") parameter.key = "hvac_mode";
  }
  if (route) {
    if (parameter && !route.parameters?.[parameter.key]) {
      route.parameters = { ...(route.parameters || {}), [parameter.key]: { entityId: sourceKey(entity), serviceId: sourceNormalized } };
      bindings.push({ ...clone(binding), serviceId: normalized, parameter });
    }
    return;
  }
  routes[normalized] = { entityId: sourceKey(entity), serviceId: sourceNormalized, ...(parameter ? { parameters: { [parameter.key]: { entityId: sourceKey(entity), serviceId: sourceNormalized } } } : {}) };
  bindings.push({ ...clone(binding), serviceId: normalized, ...(parameter ? { parameter } : {}) });
}

function serviceAliases(domain, entity) {
  const available = services(entity);
  const result = [];
  const add = (value) => { if (available.includes(value) && !result.includes(value)) result.push(value); };
  if (domain === "light") ["light.turn_on", "light.turn_off", "light.toggle"].forEach(add);
  if (domain === "switch") ["switch.turn_on", "switch.turn_off", "switch.toggle"].forEach(add);
  if (domain === "climate") ["climate.turn_on", "climate.turn_off", "climate.set_temperature", "climate.set_hvac_mode"].forEach(add);
  if (domain === "cover") ["cover.open_cover", "cover.close_cover", "cover.stop_cover", "cover.set_cover_position"].forEach(add);
  if (domain === "fan") ["fan.turn_on", "fan.turn_off", "fan.toggle", "fan.set_percentage", "fan.set_preset_mode"].forEach(add);
  if (domain === "lock") ["lock.lock", "lock.unlock"].forEach(add);
  if (domain === "number") add("number.set_value");
  if (domain === "select") add("select.select_option");
  if (domain === "button") add("button.press");
  return result;
}

function publicServiceFor(domain, rawServiceId, entity) {
  const serviceId = normalize(rawServiceId).toLowerCase();
  if (!serviceId) return null;
  const [rawDomain, rawService] = serviceId.split(".", 2);
  if (!rawDomain || !rawService) return null;
  if (domain === "light" && rawDomain === "switch" && ["turn_on", "turn_off", "toggle"].includes(rawService)) return `light.${rawService}`;
  if (domain === "climate" && rawDomain === "switch" && ["turn_on", "turn_off"].includes(rawService)) return `climate.${rawService}`;
  if (domain === "climate" && rawDomain === "number" && rawService === "set_value" && /(temperature|setpoint|target|heat)/.test(entityText(entity))) return "climate.set_temperature";
  if (domain === "climate" && rawDomain === "select" && rawService === "select_option" && /(mode|hvac|preset)/.test(entityText(entity))) return "climate.set_hvac_mode";
  if (domain === "light" && rawDomain === "number" && rawService === "set_value" && /(brightness|level|color_temp|color_temperature)/.test(entityText(entity))) return "light.turn_on";
  if (rawDomain === domain) return serviceId;
  return null;
}

function constraintsFor(entities) {
  const result = {};
  for (const entity of entities) {
    const constraints = entity.capability?.constraints || entity.expose || {};
    for (const key of ["min", "max", "step"]) {
      if (result[key] === undefined && constraints[key] !== undefined && Number.isFinite(Number(constraints[key]))) result[key] = Number(constraints[key]);
    }
    if (!result.options && Array.isArray(constraints.options || constraints.values)) result.options = [...new Set((constraints.options || constraints.values).map(String))].slice(0, 32);
  }
  return result;
}

function aggregateAttributes(group, domain) {
  const attributes = {};
  const all = group.flatMap((entity) => [entity, entity.capability || {}, entity.expose || {}]);
  const first = (keys) => {
    for (const entity of group) {
      for (const key of keys) {
        const entityToken = token(entity.stateKey || entity.logicalKey);
        const keyToken = token(key);
        const compactKey = keyToken.replaceAll("_", "");
        const matches = entityToken === keyToken || entityToken.endsWith(`_${keyToken}`) || keyToken.includes("_") && keyToken.length >= 8 && entityToken.endsWith(compactKey);
        if (entity.state !== undefined && matches) return clone(entity.state);
        if (entity.expose?.[key] !== undefined) return clone(entity.expose[key]);
        if (entity.capability?.constraints?.[key] !== undefined) return clone(entity.capability.constraints[key]);
      }
    }
    return undefined;
  };
  if (domain === "light") {
    const brightness = first(["brightness", "level", "current_level"]);
    if (brightness !== undefined) attributes.brightness = Number(brightness);
    const colorTemp = first(["color_temp", "color_temperature"]);
    if (colorTemp !== undefined) attributes.color_temp = Number(colorTemp);
    const colorMode = first(["color_mode", "color"]);
    if (colorMode !== undefined) attributes.color_mode = clone(colorMode);
    const modes = first(["supported_color_modes"]);
    if (Array.isArray(modes)) attributes.supported_color_modes = clone(modes);
  }
  if (domain === "climate") {
    const target = first(["temperature", "target_temperature", "target_temp", "occupied_heating_setpoint", "current_heating_setpoint"]);
    const current = first(["current_temperature", "current_temp", "local_temperature", "measured_temperature"]);
    const hvacMode = first(["hvac_mode", "system_mode", "mode"]);
    const hvacModes = first(["hvac_modes", "system_modes", "modes"]);
    if (target !== undefined && Number.isFinite(Number(target))) attributes.temperature = Number(target);
    if (current !== undefined && Number.isFinite(Number(current))) attributes.current_temperature = Number(current);
    if (hvacMode !== undefined) attributes.hvac_mode = String(hvacMode).toLowerCase();
    if (Array.isArray(hvacModes)) attributes.hvac_modes = clone(hvacModes);
    const hvacAction = first(["hvac_action", "heating_action", "running_state"]);
    if (hvacAction !== undefined) attributes.hvac_action = String(hvacAction).toLowerCase();
    const constraints = constraintsFor(group);
    if (constraints.min !== undefined) attributes.min_temp = constraints.min;
    if (constraints.max !== undefined) attributes.max_temp = constraints.max;
    if (constraints.step !== undefined) attributes.target_temp_step = constraints.step;
  }
  // Keep the helper deliberately small. The source entities are retained in the store;
  // only standard app-facing attributes are copied into a surface.
  void all;
  return attributes;
}

function initialStateFor(group, primary, domain) {
  const stateEntity = group.find((entity) => entity === primary) || primary || group.find((entity) => entity.state !== undefined);
  let state = stateEntity?.state;
  if (domain === "climate") {
    const modeEntity = group.find((entity) => /(hvac_mode|system_mode|mode|running_state)/.test(entityText(entity)) && entity.state !== undefined);
    state = modeEntity?.state ?? state;
    if (String(state || "").toLowerCase() === "off") state = "off";
    else if (state !== undefined && state !== null && String(state).toLowerCase() !== "unknown") state = String(state).toLowerCase();
  }
  return state === undefined ? "unknown" : clone(state);
}

function buildSurface(device, group, endpoint, domain, index, total, selectedLabel) {
  const primary = choosePrimary(group, selectedLabel, domain);
  if (!primary) return null;
  const surfaceId = safeSurfaceId(device, endpoint, domain);
  const sourceEntityIds = [...new Set(group.map(sourceKey).filter(Boolean))];
  const routeBindings = [];
  const serviceRoutes = {};
  const candidates = group.filter((entity) => isWritable(entity));
  for (const entity of candidates) {
    for (const rawServiceId of services(entity)) {
      const serviceId = publicServiceFor(domain, rawServiceId, entity);
      if (serviceId) addBinding(routeBindings, serviceRoutes, serviceId, entity, rawServiceId);
    }
    for (const serviceId of serviceAliases(domain, entity)) addBinding(routeBindings, serviceRoutes, serviceId, entity, serviceId);
  }
  const state = initialStateFor(group, primary, domain);
  const attributes = aggregateAttributes(group, domain);
  const inferredType = domain === "switch" ? "switch" : domain;
  const capability = normalizeCapability({
    runtime: "dinodia_os",
    kind: "composite",
    category: "control",
    readable: true,
    writable: routeBindings.length > 0,
    // The presentation layer has already reduced raw protocol entities to
    // bounded household routes. The automation catalogue still applies its
    // stricter service allow-list before exposing any of these controls.
    automatable: routeBindings.some((binding) => !String(binding.serviceId || "").endsWith(".toggle")),
    idempotency: routeBindings.some((binding) => String(binding.serviceId || "").endsWith(".toggle")) ? "set_value" : "set_value",
    observable: true,
    primary: true,
    stateKey: primary.stateKey || primary.logicalKey || "state",
    constraints: constraintsFor(group),
    bindings: routeBindings,
    display: { control: inferredType, label: surfaceName(device, endpoint, domain, index, total, primary), unit: "" },
  });
  const generatedName = surfaceName(device, endpoint, domain, index, total, primary);
  return {
    id: surfaceId,
    sourceId: surfaceId,
    haEntityId: `${domain}.${physicalSlug(device)}_${haObjectId(endpoint || "0")}`,
    deviceId: device.id,
    endpointId: endpoint,
    logicalKey: domain,
    stateKey: primary.stateKey || primary.logicalKey || "state",
    name: generatedName,
    original_name: generatedName,
    domain,
    category: "control",
    state,
    available: device.available !== false,
    sourceEntityIds,
    stateSourceEntityId: sourceKey(primary),
    attributeSources: Object.fromEntries(group.filter((entity) => entity !== primary && (entity.capability?.writable || relatedStatus(entity, selectedLabel, domain))).map((entity) => [token(entity.stateKey || entity.logicalKey || entity.name), sourceKey(entity)])),
    serviceRoutes,
    visibility: "household",
    priority: domain === "climate" ? 10 : 20,
    inferredType,
    attributes,
    labels: [],
    labelIds: [],
    capability,
  };
}

function rawRoleSummary(device, selectedLabel) {
  const entities = rawEntities(device);
  const roles = { primary_control: 0, control_feature: 0, status_attribute: 0, diagnostic: 0, installer_configuration: 0, unsafe_or_unsupported: 0 };
  for (const entity of entities) {
    if (isDiagnostic(entity)) roles[isConfig(entity) ? "installer_configuration" : "diagnostic"] += 1;
    else if (primaryCandidate(entity, selectedLabel)) roles.primary_control += 1;
    else if (featureCandidate(entity, selectedLabel, semanticDomain(entity, selectedLabel))) roles.control_feature += 1;
    else if (relatedStatus(entity, selectedLabel, semanticDomain(entity, selectedLabel))) roles.status_attribute += 1;
    else roles.unsafe_or_unsupported += 1;
  }
  return roles;
}

function sourceFingerprint(device) {
  const relevant = {
    id: device.id,
    protocol: device.protocol,
    identity: device.protocolIdentity,
    definition: device.definition,
    metadata: device.metadata,
    entities: rawEntities(device).map((entity) => ({ id: entity.id, endpointId: entity.endpointId, logicalKey: entity.logicalKey, stateKey: entity.stateKey, domain: entity.domain, category: entity.category, capability: entity.capability, expose: entity.expose, binding: entity.binding })),
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex")}`;
}

function buildPresentation(device, now = new Date().toISOString()) {
  const selectedLabel = labelId(device);
  const configured = isConfigured(device) && ["ready", "preview"].includes(String(device.setup?.status || ""));
  const groups = configured ? groupEntities(device, selectedLabel) : new Map();
  const values = [];
  const renderableGroups = [...groups.entries()].filter(([key, group]) => {
    const [endpoint, domain] = key.split("::");
    return Boolean(choosePrimary(group, selectedLabel, domain || "switch"));
  });
  for (const [[key, group], index] of renderableGroups.map((entry, position) => [entry, position])) {
    const [endpoint, domain] = key.split("::");
    const surface = buildSurface(device, group, endpoint || "0", domain || "switch", index, renderableGroups.length, selectedLabel);
    if (surface) values.push(surface);
  }
  values.sort((left, right) => left.id.localeCompare(right.id));
  const surfaces = Object.fromEntries(values.map((surface) => [surface.id, surface]));
  const status = !configured ? "pending_assignment" : values.length ? "ready" : rawEntities(device).length ? "no_safe_controls" : "unsupported";
  const inferredType = values.length === 1 ? values[0].inferredType : values.length > 1 ? "multi_control" : null;
  return {
    version: PRESENTATION_VERSION,
    policyRevision: POLICY_REVISION,
    sourceFingerprint: sourceFingerprint(device),
    generatedAt: now,
    status,
    inferredType,
    selectedLabel,
    roleCounts: rawRoleSummary(device, selectedLabel),
    surfaces,
  };
}

function isSurface(entity) {
  return Boolean(entity && entity.visibility === "household" && entity.sourceEntityIds && entity.serviceRoutes);
}

function getSurfaces(device) {
  if (!device?.presentation?.surfaces || device.presentation.status !== "ready") return [];
  return Object.values(device.presentation.surfaces).filter(isSurface).map(clone);
}

function rawEntityById(device, id) {
  const needle = normalize(id);
  return rawEntities(device).find((entity) => sourceKey(entity) === needle || normalize(entity.id) === needle || normalize(entity.sourceId) === needle) || null;
}

function publicPresentation(surface) {
  return {
    version: PRESENTATION_VERSION,
    runtime: "dinodia_os",
    visibility: "household",
    semantic_type: surface.inferredType || surface.domain,
    surface_id: surface.id,
    source_count: Array.isArray(surface.sourceEntityIds) ? surface.sourceEntityIds.length : 0,
    policy_revision: POLICY_REVISION,
  };
}

module.exports = {
  APPROVED_LABELS,
  PRESENTATION_VERSION,
  POLICY_REVISION,
  buildPresentation,
  getSurfaces,
  isConfigured,
  isSurface,
  labelId,
  publicPresentation,
  rawEntityById,
  rawEntities,
  sourceKey,
};
