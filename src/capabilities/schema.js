const CAPABILITY_VERSION = 1;
const MAX_MANIFEST_BYTES = 8 * 1024;
const MAX_OPTIONS = 32;
const MAX_STRING = 128;
const MAX_ENTITIES_PER_DEVICE = 128;
const MAX_MANIFEST_SERVICES = 24;

const KINDS = new Set(["binary", "number", "enum", "button", "text", "sensor", "event", "composite"]);
const CATEGORIES = new Set(["control", "config", "diagnostic", "event"]);
const PARAMETER_TYPES = new Set(["boolean", "number", "string"]);
const SAFE_SERVICE_RE = /^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$/;
const SAFE_SERVICE_DOMAINS = new Set(["homeassistant", "light", "switch", "cover", "climate", "fan", "lock", "vacuum", "humidifier", "button", "number", "select", "text", "media_player"]);
const VOICE_SEMANTICS = new Set(["power", "brightness", "color_rgb", "color_temperature_kelvin", "target_temperature", "ambient_temperature", "opening_percent", "toggle", "volume", "playback", "motion", "contact", "connectivity"]);

function text(value, fallback = "") {
  const result = String(value === undefined || value === null ? fallback : value).trim();
  return result.slice(0, MAX_STRING);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueStrings(value, limit = MAX_OPTIONS) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item)).filter(Boolean))].slice(0, limit);
}

function safeServiceId(value) {
  const serviceId = text(value).toLowerCase();
  if (!SAFE_SERVICE_RE.test(serviceId)) return null;
  if (!SAFE_SERVICE_DOMAINS.has(serviceId.split(".")[0])) return null;
  if (serviceId === "homeassistant.reload_config_entry") return null;
  return serviceId;
}

function normalizeConstraints(input = {}) {
  const constraints = {};
  const min = finiteNumber(input.min ?? input.value_min);
  const max = finiteNumber(input.max ?? input.value_max);
  const step = finiteNumber(input.step ?? input.value_step);
  if (min !== null) constraints.min = min;
  if (max !== null) constraints.max = max;
  if (step !== null && step > 0) constraints.step = step;
  const options = uniqueStrings(input.options ?? input.values);
  if (options.length) constraints.options = options;
  return constraints;
}

function normalizeParameter(input = {}) {
  const type = PARAMETER_TYPES.has(String(input.type || "").toLowerCase()) ? String(input.type).toLowerCase() : null;
  const key = text(input.key);
  if (!type || !key) return null;
  const parameter = { key, type };
  const constraints = normalizeConstraints(input);
  if (constraints.min !== undefined) parameter.min = constraints.min;
  if (constraints.max !== undefined) parameter.max = constraints.max;
  if (constraints.step !== undefined) parameter.step = constraints.step;
  if (constraints.options) parameter.options = constraints.options;
  return parameter;
}

function normalizeBindings(input) {
  const bindings = Array.isArray(input) ? input : [];
  return bindings.map((binding) => {
    if (!binding || typeof binding !== "object") return null;
    const serviceId = safeServiceId(binding.serviceId || binding.id);
    if (!serviceId) return null;
    const parameter = normalizeParameter(binding.parameter);
    return {
      serviceId,
      ...(parameter ? { parameter } : {}),
      ...(binding.operation ? { operation: text(binding.operation) } : {}),
    };
  }).filter(Boolean).slice(0, MAX_MANIFEST_SERVICES);
}

function normalizeCapability(input = {}, fallback = {}) {
  const kind = KINDS.has(String(input.kind || fallback.kind || "sensor")) ? String(input.kind || fallback.kind) : "sensor";
  const category = CATEGORIES.has(String(input.category || fallback.category || "control")) ? String(input.category || fallback.category) : "control";
  const bindings = normalizeBindings(input.bindings || fallback.bindings || input.services?.map((serviceId) => ({ serviceId })) || fallback.services?.map((serviceId) => ({ serviceId })));
  const services = [...new Set(bindings.map((binding) => binding.serviceId))].slice(0, MAX_MANIFEST_SERVICES);
  const constraints = normalizeConstraints(input.constraints || fallback.constraints || {});
  const result = {
    version: CAPABILITY_VERSION,
    kind,
    category,
    readable: input.readable === undefined ? fallback.readable !== false : Boolean(input.readable),
    writable: input.writable === undefined ? Boolean(fallback.writable) : Boolean(input.writable),
    automatable: input.automatable === undefined ? Boolean(fallback.automatable) : Boolean(input.automatable),
    idempotency: input.idempotency === "invoke" || fallback.idempotency === "invoke" ? "invoke" : "set_value",
    observable: input.observable === undefined ? fallback.observable !== false : Boolean(input.observable),
    primary: input.primary === undefined ? Boolean(fallback.primary) : Boolean(input.primary),
    services,
    bindings,
    constraints,
  };
  const voice = input.voice || fallback.voice;
  if (voice && typeof voice === "object" && VOICE_SEMANTICS.has(String(voice.semantic || ""))) {
    result.voice = {
      exposable: voice.exposable === true,
      semantic: String(voice.semantic),
      instance: voice.instance ? text(voice.instance) : null,
      friendlyNames: uniqueStrings(voice.friendlyNames, 8),
      proactivelyReported: voice.proactivelyReported !== false,
      retrievable: voice.retrievable !== false,
    };
  }
  if (input.runtime === "dinodia_os" || fallback.runtime === "dinodia_os") result.runtime = "dinodia_os";
  if (input.stateKey || fallback.stateKey) result.stateKey = text(input.stateKey || fallback.stateKey);
  if (input.unit || fallback.unit) result.unit = text(input.unit || fallback.unit);
  if (input.deviceClass || fallback.deviceClass) result.deviceClass = text(input.deviceClass || fallback.deviceClass);
  if (input.display && typeof input.display === "object") {
    result.display = {
      control: text(input.display.control || "read_only"),
      label: text(input.display.label || ""),
      unit: text(input.display.unit || result.unit || ""),
    };
  }
  return result;
}

function manifestFromCapability(capability, entity = {}) {
  const normalized = normalizeCapability(capability || {}, { stateKey: entity.stateKey });
  const manifest = {
    version: CAPABILITY_VERSION,
    runtime: "dinodia_os",
    kind: normalized.kind,
    category: normalized.category,
    readable: normalized.readable,
    writable: normalized.writable,
    automatable: normalized.automatable,
    idempotency: normalized.idempotency,
    observable: normalized.observable,
    primary: normalized.primary,
    service: normalized.bindings.length === 1 ? {
      id: normalized.bindings[0].serviceId,
      ...(normalized.bindings[0].parameter ? { parameter: clone(normalized.bindings[0].parameter) } : {}),
    } : undefined,
    services: normalized.bindings.map((binding) => ({
      id: binding.serviceId,
      ...(binding.parameter ? { parameter: clone(binding.parameter) } : {}),
    })),
    constraints: clone(normalized.constraints),
    ...(normalized.voice ? { voice: clone(normalized.voice) } : {}),
    display: clone(normalized.display || {
      control: normalized.kind === "number" ? "slider" : normalized.kind === "enum" ? "select" : normalized.kind === "button" ? "button" : normalized.kind === "binary" ? "toggle" : "read_only",
      label: entity.name || "",
      unit: normalized.unit || "",
    }),
  };
  if (manifest.service === undefined) delete manifest.service;
  return enforceManifestSize(manifest);
}

function validateManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "manifest is not an object" };
  if (Number(input.version) !== CAPABILITY_VERSION) return { ok: false, reason: "unsupported capability version" };
  if (input.runtime !== "dinodia_os") return { ok: false, reason: "unknown capability runtime" };
  if (!KINDS.has(String(input.kind || ""))) return { ok: false, reason: "unsupported capability kind" };
  const serviceItems = Array.isArray(input.services) ? input.services : input.service ? [input.service] : [];
  if (serviceItems.length > MAX_MANIFEST_SERVICES) return { ok: false, reason: "too many services" };
  const bindings = serviceItems.map((service) => {
    if (!service || typeof service !== "object") return null;
    const serviceId = safeServiceId(service.id || service.serviceId);
    if (!serviceId) return null;
    const parameter = service.parameter === undefined ? null : normalizeParameter(service.parameter);
    if (service.parameter !== undefined && !parameter) return null;
    return { serviceId, ...(parameter ? { parameter } : {}) };
  });
  if (bindings.some((binding) => !binding)) return { ok: false, reason: "invalid service binding" };
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) return { ok: false, reason: "manifest is too large" };
  const constraints = normalizeConstraints(input.constraints || {});
  if (constraints.min !== undefined && constraints.max !== undefined && constraints.min > constraints.max) return { ok: false, reason: "invalid numeric bounds" };
  if (constraints.options && constraints.options.length > MAX_OPTIONS) return { ok: false, reason: "too many options" };
  return { ok: true, manifest: {
    version: CAPABILITY_VERSION,
    runtime: "dinodia_os",
    kind: String(input.kind),
    category: CATEGORIES.has(String(input.category || "")) ? String(input.category) : "control",
    readable: input.readable !== false,
    writable: Boolean(input.writable),
    automatable: Boolean(input.automatable),
    idempotency: input.idempotency === "invoke" ? "invoke" : "set_value",
    observable: input.observable !== false,
    primary: Boolean(input.primary),
    ...(bindings.length === 1 ? { service: { id: bindings[0].serviceId, ...(bindings[0].parameter ? { parameter: bindings[0].parameter } : {}) } } : {}),
    ...(bindings.length ? { services: bindings.map((binding) => ({ id: binding.serviceId, ...(binding.parameter ? { parameter: binding.parameter } : {}) })) } : {}),
    constraints,
    ...(input.voice && typeof input.voice === "object" && VOICE_SEMANTICS.has(String(input.voice.semantic || "")) ? { voice: { exposable: input.voice.exposable === true, semantic: String(input.voice.semantic), instance: input.voice.instance ? text(input.voice.instance) : null, friendlyNames: uniqueStrings(input.voice.friendlyNames, 8), proactivelyReported: input.voice.proactivelyReported !== false, retrievable: input.voice.retrievable !== false } } : {}),
    display: input.display && typeof input.display === "object" ? {
      control: text(input.display.control || "read_only"),
      label: text(input.display.label || ""),
      unit: text(input.display.unit || ""),
    } : { control: "read_only", label: "", unit: "" },
  } };
}

function enforceManifestSize(manifest) {
  const result = validateManifest(manifest);
  return result.ok ? result.manifest : undefined;
}

function publicCapability(capability, entity) {
  if (!capability || capability.runtime !== "dinodia_os") return {};
  const manifest = manifestFromCapability(capability, entity);
  return manifest ? { dinodia_capability: manifest } : {};
}

module.exports = {
  CAPABILITY_VERSION,
  MAX_MANIFEST_BYTES,
  MAX_OPTIONS,
  MAX_ENTITIES_PER_DEVICE,
  KINDS,
  normalizeCapability,
  normalizeConstraints,
  manifestFromCapability,
  validateManifest,
  publicCapability,
  safeServiceId,
  VOICE_SEMANTICS,
  text,
};
