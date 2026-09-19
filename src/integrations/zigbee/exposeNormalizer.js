const { stableDeviceId, normalizeEndpoint, normalizeLogicalKey } = require("../../capabilities/identity");
const { normalizeCapability } = require("../../capabilities/schema");
const { zigbeeName } = require("../../deviceNaming");

const STANDARD_DOMAINS = new Set(["light", "switch", "cover", "climate", "fan", "lock", "vacuum", "humidifier", "button"]);
const CONTROL_PROPERTIES = new Set(["state", "brightness", "color_temp", "color", "position", "current_position", "temperature", "target_temperature", "hvac_mode", "fan_mode", "preset", "lock"]);
const DIAGNOSTIC_PROPERTIES = new Set(["battery", "voltage", "current", "power", "energy", "linkquality", "last_seen", "device_temperature", "temperature", "humidity", "pressure", "illuminance"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function humanize(value) {
  return String(value || "Entity").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim() || "Entity";
}

function accessFlags(expose, parentDomain) {
  const access = Number(expose.access);
  if (Number.isFinite(access)) return { readable: Boolean(access & 1 || access & 4), writable: Boolean(access & 2), access };
  return { readable: true, writable: STANDARD_DOMAINS.has(parentDomain) || expose.type === "binary" && parentDomain === "switch", access: undefined };
}

function domainFor(expose, parentDomain = "") {
  const type = String(expose.type || "").toLowerCase();
  if (STANDARD_DOMAINS.has(type)) return type;
  const property = String(expose.property || expose.name || "").toLowerCase();
  if (parentDomain && (CONTROL_PROPERTIES.has(property) || property === "state" || property.startsWith("state_") || property === "power")) return parentDomain;
  if (type === "binary") {
    const key = String(expose.property || expose.name || "").toLowerCase();
    if (["state", "power"].includes(key) && parentDomain === "switch") return "switch";
    return "binary_sensor";
  }
  if (type === "enum") return "select";
  if (type === "text") return "text";
  if (type === "numeric") return parentDomain || (Number(expose.access) & 2 ? "number" : "sensor");
  return parentDomain || "sensor";
}

function kindFor(expose, domain, writable) {
  const type = String(expose.type || "").toLowerCase();
  if (type === "numeric") return writable && /(brightness|level|position|temperature|setpoint|percentage|color|colour)/.test(String(expose.property || expose.name || "").toLowerCase()) ? "number" : "sensor";
  if (type === "binary" || ["light", "switch", "cover", "lock", "fan", "humidifier"].includes(domain)) return "binary";
  if (type === "enum") return "enum";
  if (type === "text") return writable ? "text" : "sensor";
  if (type === "button") return "button";
  return "sensor";
}

function categoryFor(expose, domain, writable) {
  if (expose.category === "diagnostic" || DIAGNOSTIC_PROPERTIES.has(String(expose.property || expose.name || "").toLowerCase())) return "diagnostic";
  if (writable && domain !== "sensor" && domain !== "binary_sensor") return "control";
  return "diagnostic";
}

function parameterFor(expose, kind, domain) {
  const property = String(expose.property || expose.name || "state");
  if (!["number", "enum", "text"].includes(kind)) return null;
  const type = kind === "number" ? "number" : "string";
  const parameter = { key: property, type };
  if (expose.value_min !== undefined) parameter.min = Number(expose.value_min);
  if (expose.value_max !== undefined) parameter.max = Number(expose.value_max);
  if (expose.value_step !== undefined) parameter.step = Number(expose.value_step);
  if (Array.isArray(expose.values)) parameter.options = expose.values.map(String);
  if (domain === "light" && property === "brightness") parameter.key = "brightness";
  return parameter;
}

function serviceBindings(expose, domain, kind, writable) {
  if (!writable) return [];
  const property = String(expose.property || expose.name || "state").toLowerCase();
  const bindings = [];
  if (["light", "switch"].includes(domain) && (property === "state" || property.startsWith("state_") || property === "power")) {
    for (const service of ["turn_on", "turn_off", "toggle"]) bindings.push({ serviceId: `${domain}.${service}`, operation: service });
  } else if (domain === "cover") {
    for (const service of ["open_cover", "close_cover", "stop_cover", "set_cover_position"]) bindings.push({ serviceId: `cover.${service}`, operation: service });
  } else if (domain === "button" || kind === "button") {
    bindings.push({ serviceId: "button.press", operation: "press" });
  } else if (kind === "number") {
    const serviceId = domain === "climate" && ["temperature", "target_temperature"].includes(property) ? "climate.set_temperature" : domain === "cover" && ["position", "current_position"].includes(property) ? "cover.set_cover_position" : domain === "fan" && property === "percentage" ? "fan.set_percentage" : "number.set_value";
    const parameter = parameterFor(expose, kind, domain);
    if (parameter && serviceId === "climate.set_temperature") parameter.key = "temperature";
    if (parameter && serviceId === "cover.set_cover_position") parameter.key = "position";
    bindings.push({ serviceId, operation: serviceId.split(".").pop(), parameter });
  } else if (kind === "enum") {
    const serviceId = domain === "climate" ? "climate.set_hvac_mode" : domain === "fan" ? "fan.set_preset_mode" : "select.select_option";
    const parameter = parameterFor(expose, kind, domain) || { key: "option", type: "string", options: expose.values || [] };
    if (domain === "climate") parameter.key = "hvac_mode";
    if (domain === "fan") parameter.key = "preset_mode";
    bindings.push({ serviceId, operation: serviceId.split(".").pop(), parameter });
  } else if (kind === "text") {
    bindings.push({ serviceId: "text.set_value", operation: "set_value", parameter: parameterFor(expose, kind, domain) || { key: "value", type: "string" } });
  } else if (["climate", "fan", "lock", "humidifier"].includes(domain)) {
    bindings.push({ serviceId: `${domain}.turn_on`, operation: "turn_on" }, { serviceId: `${domain}.turn_off`, operation: "turn_off" });
  }
  return bindings;
}

function normalizeExpose(expose, context, output) {
  if (!expose || typeof expose !== "object") return;
  const type = String(expose.type || "").toLowerCase();
  const parentDomain = context.parentDomain || "";
  const domain = domainFor(expose, parentDomain);
  const endpointId = normalizeEndpoint(expose.endpoint || context.endpointId || "0");
  const property = String(expose.property || expose.name || "").trim();
  const exposePath = String(context.exposePath || context.rootPath || `exposes[${context.index || 0}]`);
  const rootType = String(context.rootType || type || "unknown");
  const hasOwnValue = Boolean(property) && !["composite", "feature", "group"].includes(type);
  const flags = accessFlags(expose, domain);
  if (hasOwnValue) {
    const kind = kindFor(expose, domain, flags.writable);
    const category = categoryFor(expose, domain, flags.writable);
    const logicalKey = normalizeLogicalKey(property);
    const bindings = serviceBindings(expose, domain, kind, flags.writable);
    const capability = normalizeCapability({
      runtime: "dinodia_os",
      kind,
      category,
      readable: flags.readable,
      writable: flags.writable,
      observable: flags.readable,
      primary: ["state", "power", "position", "brightness"].includes(property.toLowerCase()) || property.toLowerCase().startsWith("state_"),
      stateKey: property,
      unit: expose.unit,
      deviceClass: expose.device_class,
      constraints: { min: expose.value_min, max: expose.value_max, step: expose.value_step, options: expose.values },
      bindings,
    });
    const id = `${context.deviceId}:${endpointId}:${logicalKey}`;
    output[id] = {
      id,
      sourceId: id,
      deviceId: context.deviceId,
      endpointId,
      logicalKey,
      stateKey: property,
      domain: domain || undefined,
      category,
      name: humanize(expose.label || expose.name || property),
      original_name: humanize(expose.label || expose.name || property),
      expose: {
        type: expose.type,
        access: flags.access,
        unit: expose.unit,
        device_class: expose.device_class,
        values: clone(expose.values),
        value_min: expose.value_min,
        value_max: expose.value_max,
        value_step: expose.value_step,
        value_on: expose.value_on,
        value_off: expose.value_off,
        value_toggle: expose.value_toggle,
        endpoint: expose.endpoint,
      },
      capability,
      binding: {
        adapter: "zigbee",
        property,
        endpoint: expose.endpoint || endpointId,
      },
      converter: {
        path: exposePath,
        rootType,
        parentPath: context.parentPath || null,
        parentType: context.parentType || null,
        endpoint: expose.endpoint || endpointId,
        access: flags.access,
        aliases: [property, property.replace(/_(l|r)(\d+)$/i, "$1$2")].filter(Boolean),
      },
    };
  }
  if (Array.isArray(expose.features)) {
    expose.features.forEach((feature, index) => normalizeExpose(feature, {
      ...context,
      parentDomain: domain || parentDomain,
      parentPath: exposePath,
      parentType: type || null,
      endpointId: expose.endpoint || context.endpointId,
      exposePath: `${exposePath}.features[${index}]`,
    }, output));
  }
}

function normalizeExposes(exposes, deviceId) {
  const output = {};
  (Array.isArray(exposes) ? exposes : []).forEach((expose, index) => normalizeExpose(expose, {
    deviceId,
    endpointId: expose?.endpoint || "0",
    parentDomain: "",
    index,
    rootType: expose?.type || "unknown",
    exposePath: `exposes[${index}]`,
  }, output));
  return output;
}

function normalizeZigbeeDevice(input = {}) {
  const ieeeAddress = input.ieee_address || input.ieee || input.id || input.friendly_name;
  const id = stableDeviceId("zigbee", { ieeeAddress, id: input.friendly_name || input.id });
  const infrastructure = String(input.type || input.role || input.device_type || "").trim().toLowerCase() === "coordinator";
  const definition = input.definition && typeof input.definition === "object" ? input.definition : {};
  const exposes = definition.exposes || input.exposes || [];
  const entities = normalizeExposes(exposes, id);
  return {
    id,
    protocol: "zigbee",
    infrastructure,
    name: zigbeeName(input),
    legacyIds: input.friendly_name ? [String(input.friendly_name)] : [],
    available: input.disabled_by !== "config" && input.supported !== false,
    interviewStatus: input.interview_completed === false ? "pending" : "successful",
    metadata: {
      ieee_address: ieeeAddress,
      friendly_name: input.friendly_name,
      manufacturer: input.definition?.vendor || input.manufacturer,
      model: input.definition?.model || input.model_id,
      description: input.definition?.description,
      definition: clone(definition),
      endpoint: clone(input.endpoint),
      power_source: input.power_source,
      supported: input.supported,
    },
    definition: { source: "zigbee-herdsman-converters", supported: Boolean(input.definition || input.supported !== false), model: input.definition?.model || input.model_id || null },
    entities,
  };
}

module.exports = { normalizeExposes, normalizeZigbeeDevice, normalizeExpose, humanize };
