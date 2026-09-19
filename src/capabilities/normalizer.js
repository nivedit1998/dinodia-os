const { normalizeCapability, MAX_ENTITIES_PER_DEVICE } = require("./schema");
const { stableEntityId } = require("./identity");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mergeUserMetadata(previous = {}, incoming = {}) {
  const result = { ...clone(incoming) };
  for (const key of ["name", "areaId", "labelIds", "labels", "haEntityId", "entityId", "original_name"]) {
    if (previous[key] !== undefined && previous[key] !== null && previous[key] !== "") result[key] = clone(previous[key]);
  }
  return result;
}

function normalizeEntity(input = {}, context = {}) {
  const endpointId = String(input.endpointId || input.endpoint || context.endpointId || "0");
  const logicalKey = String(input.logicalKey || input.stateKey || input.property || input.name || "state");
  const id = input.id || stableEntityId(context.deviceId, endpointId, logicalKey);
  const capability = normalizeCapability(input.capability || {}, {
    kind: input.kind,
    category: input.category,
    readable: input.readable,
    writable: input.writable,
    observable: input.observable,
    primary: input.primary,
    stateKey: input.stateKey || logicalKey,
    unit: input.unit,
    deviceClass: input.deviceClass,
    constraints: input.constraints,
    bindings: input.bindings,
    services: input.services,
  });
  return {
    ...clone(input),
    id: String(id),
    sourceId: String(input.sourceId || id),
    deviceId: String(input.deviceId || context.deviceId || ""),
    endpointId,
    logicalKey,
    capability,
    stateKey: String(input.stateKey || logicalKey),
  };
}

function normalizeDevice(input = {}) {
  const deviceId = String(input.id || contextId(input));
  const entities = {};
  for (const entity of Object.values(input.entities || {}).slice(0, MAX_ENTITIES_PER_DEVICE)) {
    const normalized = normalizeEntity(entity, { deviceId, endpointId: entity.endpointId || entity.endpoint || "0" });
    entities[normalized.id] = normalized;
  }
  return {
    ...clone(input),
    id: deviceId,
    entities,
    capabilitySchemaVersion: 1,
  };
}

function contextId(input) {
  return `${input.protocol || "device"}:${input.name || "unknown"}`;
}

function mergeEntityMaps(existing = {}, incoming = {}, deviceId) {
  const result = {};
  for (const [key, item] of Object.entries(incoming || {}).slice(0, MAX_ENTITIES_PER_DEVICE)) {
    const normalized = normalizeEntity({ ...(item || {}), id: item?.id || key }, { deviceId, endpointId: item?.endpointId || item?.endpoint || "0" });
    const previous = Object.values(existing || {}).find((candidate) => candidate?.id === normalized.id || candidate?.sourceId === normalized.sourceId || candidate?.logicalKey === normalized.logicalKey && candidate?.endpointId === normalized.endpointId);
    result[normalized.id] = previous ? mergeUserMetadata(previous, normalized) : normalized;
  }
  for (const previous of Object.values(existing || {})) {
    if (!previous || result[previous.id]) continue;
    if (previous.userRemoved !== true) result[previous.id] = clone(previous);
  }
  return result;
}

module.exports = { normalizeEntity, normalizeDevice, mergeEntityMaps, mergeUserMetadata };
