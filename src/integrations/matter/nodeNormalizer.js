const { stableDeviceId, normalizeEndpoint, normalizeLogicalKey } = require("../../capabilities/identity");
const { normalizeCapability } = require("../../capabilities/schema");
const { matterName } = require("../../deviceNaming");
const { cluster, deviceType } = require("./catalog");
const { decodeMatterValue, endpointInventory } = require('./valueCodec');

const CLUSTERS = {
  onoff: "6", levelcontrol: "8", colorcontrol: "768", doorlock: "257", windowcovering: "258", thermostat: "513", fancontrol: "514", booleanstate: "69", occupancysensing: "1030", temperaturemeasurement: "1026", relativehumiditymeasurement: "1029", illuminancemeasurement: "1024",
};

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function idOf(value) { return String(value?.id ?? value?.cluster_id ?? value?.clusterId ?? value); }
function nameOf(value, fallback) { return String(value?.name || value?.label || fallback).trim(); }

function clusterEntries(endpoint) {
  const source = endpoint?.clusters || endpoint?.server_clusters || endpoint?.serverClusters || {};
  if (Array.isArray(source)) return source.map((item) => [idOf(item), item]);
  return Object.entries(source);
}

function attributesFor(clusterId, clusterValue) {
  const source = clusterValue?.attributes || clusterValue?.attribute_values || clusterValue?.attributeValues || {};
  if (Array.isArray(source)) return source.map((item) => [String(item.attribute_id ?? item.attributeId ?? item.id), item.value ?? item]);
  return Object.entries(source);
}

function semanticRoleFor(clusterId, attributeId) {
  const clusterKey = String(clusterId);
  const attributeKey = String(attributeId);
  if (clusterKey === CLUSTERS.onoff && attributeKey === "0") return "power";
  if (clusterKey === CLUSTERS.levelcontrol && attributeKey === "0") return "brightness";
  if (clusterKey === CLUSTERS.thermostat && attributeKey === "0") return "ambient_temperature";
  if (clusterKey === CLUSTERS.thermostat && attributeKey === "18") return "target_temperature";
  if (clusterKey === CLUSTERS.thermostat && attributeKey === "28") return "operating_mode";
  if (clusterKey === CLUSTERS.doorlock) return "security_lock";
  // Matter Window Covering attribute 8 is CurrentPositionLiftPercentage;
  // attribute 10 is OperationalStatus, not a position. Attribute 14 is in
  // hundredths of a percent and must not be exposed as a percentage unscaled.
  if (clusterKey === CLUSTERS.windowcovering && attributeKey === "8") return "opening_percentage";
  if (clusterKey === CLUSTERS.fancontrol && ["0", "2"].includes(attributeKey)) return "operating_mode";
  return "unknown";
}

function serviceFor(clusterId, attributeId, descriptor, endpoint, rawDescriptor = null, acceptedCommandIds = null) {
  const clusterInfo = cluster(clusterId);
  const clusterKey = String(clusterId);
  const attributeKey = String(attributeId);
  const name = String(descriptor?.name || clusterInfo.attributes?.[String(attributeId)]?.name || `attribute_${attributeId}`);
  const lower = name.toLowerCase();
  const hasCommands = Array.isArray(clusterInfo.commands) && clusterInfo.commands.length > 0;
  const explicitWritable = rawDescriptor && (Object.prototype.hasOwnProperty.call(rawDescriptor, "writable") || Object.prototype.hasOwnProperty.call(rawDescriptor, "write") || rawDescriptor.quality && Object.prototype.hasOwnProperty.call(rawDescriptor.quality, "writable"));
  let writable = explicitWritable
    ? descriptor.writable === true || descriptor.write === true || descriptor.quality?.writable === true
    : clusterKey === CLUSTERS.thermostat
      ? clusterInfo.attributes?.[String(attributeId)]?.writable === true
      : clusterKey === CLUSTERS.onoff && attributeKey === "0"
        ? true
        : clusterKey === CLUSTERS.levelcontrol && attributeKey === "0"
          ? true
          : clusterKey === CLUSTERS.windowcovering && attributeKey === "8"
            ? Array.isArray(acceptedCommandIds) && acceptedCommandIds.some(id => [0, 1, 2, 5].includes(id))
            : clusterKey === CLUSTERS.fancontrol && ["0", "2"].includes(attributeKey)
              ? true
              : false;
  // Cover cluster commands are independent of attribute write access. Never
  // infer them from a current-position attribute or static cluster catalog.
  if (clusterKey === CLUSTERS.windowcovering) writable = attributeKey === '8'
    && Array.isArray(acceptedCommandIds) && acceptedCommandIds.some(id => [0, 1, 2, 5].includes(id));
  if (clusterKey === '513' && clusterInfo.attributes?.[attributeKey]?.type === 'temperature') {
    writable = writable && ['17','18','19','20'].includes(attributeKey)
      && Number.isInteger(descriptor.min) && Number.isInteger(descriptor.max) && descriptor.min < descriptor.max;
  }
  const domain = clusterKey === CLUSTERS.onoff ? "switch" : clusterKey === CLUSTERS.levelcontrol ? "number" : clusterKey === CLUSTERS.colorcontrol ? "light" : clusterKey === CLUSTERS.doorlock ? "lock" : clusterKey === CLUSTERS.windowcovering ? "cover" : clusterKey === CLUSTERS.thermostat ? (lower.includes("setpoint") || lower.includes("mode") ? "climate" : "sensor") : clusterKey === CLUSTERS.fancontrol ? "fan" : clusterKey === CLUSTERS.occupancysensing || clusterKey === CLUSTERS.booleanstate ? "binary_sensor" : "sensor";
  const enumType = descriptor?.type === "enum" || descriptor?.options || /enum$/i.test(String(descriptor?.type || ""));
  const kind = clusterInfo.attributes?.[attributeKey]?.type === 'temperature' ? 'number' : domain === "cover" && ['8', '9', '11', '12', '14', '15'].includes(attributeKey) ? 'number' : domain === "fan" ? (enumType || lower.includes("fanmode") ? "enum" : lower.includes("percent") || lower.includes("speed") ? "number" : "binary") : domain === "switch" || domain === "lock" ? "binary" : enumType ? "enum" : descriptor?.type === "boolean" ? "binary" : writable ? "number" : "sensor";
  const category = writable ? "control" : "diagnostic";
  const bindings = [];
  if (writable && domain === "switch") bindings.push({ serviceId: "switch.turn_on", operation: "turn_on" }, { serviceId: "switch.turn_off", operation: "turn_off" }, { serviceId: "switch.toggle", operation: "toggle" });
  if (writable && domain === "number") bindings.push({ serviceId: "number.set_value", operation: "set_value", parameter: { key: "value", type: "number", ...(descriptor?.min !== undefined ? { min: descriptor.min } : {}), ...(descriptor?.max !== undefined ? { max: descriptor.max } : {}) } });
  if (writable && domain === "climate" && kind === "number") bindings.push({ serviceId: "climate.set_temperature", operation: "set_temperature", parameter: { key: "temperature", type: "number", ...(descriptor?.min !== undefined ? { min: descriptor.min / 100 } : {}), ...(descriptor?.max !== undefined ? { max: descriptor.max / 100 } : {}) } });
  if (writable && kind === "enum") bindings.push({ serviceId: "select.select_option", operation: "select_option", parameter: { key: "option", type: "string", options: descriptor.options || clusterInfo.attributes?.[String(attributeId)]?.options || [] } });
  if (writable && domain === "climate" && kind === "enum") bindings.splice(-1, 1, { serviceId: "climate.set_hvac_mode", operation: "set_hvac_mode", parameter: { key: "hvac_mode", type: "string", options: descriptor.options || clusterInfo.attributes?.[String(attributeId)]?.options || [] } });
  if (writable && domain === "lock") bindings.push({ serviceId: "lock.lock", operation: "lock" }, { serviceId: "lock.unlock", operation: "unlock" });
  if (writable && domain === "cover") {
    if (acceptedCommandIds?.includes(0)) bindings.push({ serviceId: "cover.open_cover", operation: "open_cover" });
    if (acceptedCommandIds?.includes(1)) bindings.push({ serviceId: "cover.close_cover", operation: "close_cover" });
    if (acceptedCommandIds?.includes(2)) bindings.push({ serviceId: "cover.stop_cover", operation: "stop_cover" });
    if (acceptedCommandIds?.includes(5) && lower.includes("position")) bindings.push({ serviceId: "cover.set_cover_position", operation: "set_cover_position", parameter: { key: "position", type: "number", min: 0, max: 100 } });
  }
  if (writable && domain === "fan") {
    if (kind === "number") bindings.push({ serviceId: "fan.set_percentage", operation: "set_percentage", parameter: { key: "percentage", type: "number", min: 0, max: 100 } });
    else if (kind === "enum") bindings.push({ serviceId: "fan.set_preset_mode", operation: "set_preset_mode", parameter: { key: "preset_mode", type: "string", options: descriptor.options || [] } });
    else bindings.push({ serviceId: "fan.turn_on", operation: "turn_on" }, { serviceId: "fan.turn_off", operation: "turn_off" }, { serviceId: "fan.toggle", operation: "toggle" });
  }
  if (writable && domain === "light" && clusterKey === CLUSTERS.colorcontrol && kind === "number" && lower.includes("colortemperature")) {
    bindings.push({ serviceId: "light.turn_on", operation: "set_value", parameter: { key: "color_temp", type: "number", ...(descriptor?.min !== undefined ? { min: descriptor.min } : {}), ...(descriptor?.max !== undefined ? { max: descriptor.max } : {}) } });
  }
  const endpointId = normalizeEndpoint(endpoint?.endpoint_id ?? endpoint?.endpointId ?? endpoint?.id ?? "0");
  const logicalKey = normalizeLogicalKey(`${clusterInfo.name}_${name}`);
  const unit = descriptor?.unit || clusterInfo.attributes?.[String(attributeId)]?.unit;
  const constraints = clusterKey === '258' && ['8','9','11','12','14','15'].includes(attributeKey) ? { min: 0, max: 100, step: 0.01 }
    : clusterInfo.attributes?.[attributeKey]?.type === 'temperature' ? { ...descriptor,
      ...(typeof descriptor.min === 'number' ? { min: descriptor.min / 100 } : {}),
      ...(typeof descriptor.max === 'number' ? { max: descriptor.max / 100 } : {}) } : descriptor;
  const capability = normalizeCapability({ runtime: "dinodia_os", kind, category, readable: true, writable, observable: true, primary: clusterId === CLUSTERS.onoff || clusterId === CLUSTERS.levelcontrol || clusterId === CLUSTERS.thermostat && attributeId === "18", semanticRole: semanticRoleFor(clusterId, attributeId), stateKey: logicalKey, unit: clusterInfo.attributes?.[attributeKey]?.type === 'temperature' ? '°C' : unit, deviceClass: descriptor?.device_class, constraints, bindings });
  return {
    id: `${endpointId}:${logicalKey}`,
    sourceId: `${endpointId}:${clusterId}:${attributeId}`,
    endpointId,
    logicalKey,
    stateKey: logicalKey,
    domain,
    category,
    name: nameOf(descriptor, `${clusterInfo.name} ${name}`),
    original_name: nameOf(descriptor, `${clusterInfo.name} ${name}`),
    state: decodeMatterValue(clusterId, attributeId, descriptor?.value),
    attributes: { clusterId, attributeId, cluster: clusterInfo.name, commandIds: clusterInfo.commands.map((item) => String(item.id)).slice(0, 32), endpointDeviceTypes: clone(endpoint?.device_types || endpoint?.deviceTypes || []).slice(0, 16),
      ...(clusterKey === CLUSTERS.windowcovering && acceptedCommandIds ? { acceptedCommandIds, acceptedCommandEndpoint: endpointId, acceptedCommandCluster: clusterKey } : {}) },
    capability,
    binding: { adapter: "matter", endpointId, clusterId: String(clusterId), attributeId: String(attributeId), valueEncoding: 'matter-v1' },
  };
}

function fallbackStateEntities(node, deviceId) {
  const entities = {};
  for (const [key, value] of Object.entries(asObject(node.state))) {
    const lower = key.toLowerCase();
    const domain = ["power", "onoff", "state"].includes(lower) ? "switch" : ["temperature", "humidity", "battery"].some((name) => lower.includes(name)) ? "sensor" : "sensor";
    const kind = domain === "switch" ? "binary" : "sensor";
    const logicalKey = normalizeLogicalKey(key);
    const id = `${deviceId}:0:${logicalKey}`;
    entities[id] = {
      id, sourceId: id, deviceId, endpointId: "0", logicalKey, stateKey: key, domain, category: domain === "switch" ? "control" : "diagnostic", name: nameOf({}, key), original_name: nameOf({}, key), state: value,
      capability: normalizeCapability({ runtime: "dinodia_os", kind, category: domain === "switch" ? "control" : "diagnostic", readable: true, writable: domain === "switch", primary: domain === "switch", stateKey: key, bindings: domain === "switch" ? [{ serviceId: "switch.turn_on", operation: "turn_on" }, { serviceId: "switch.turn_off", operation: "turn_off" }, { serviceId: "switch.toggle", operation: "toggle" }] : [] }),
      binding: { adapter: "matter", endpointId: "0", clusterId: "6", attributeId: "0" },
    };
  }
  return entities;
}

function normalizeMatterNode(node = {}) {
  const nodeId = String(node.node_id ?? node.nodeId ?? node.id ?? "");
  const fabricId = String(node.fabric_id ?? node.fabricId ?? node.fabric?.id ?? "default");
  const infrastructure = node.infrastructure === true || [node.type, node.role].some((value) => ["controller", "coordinator", "border_router", "border-router"].includes(String(value || "").trim().toLowerCase()));
  const id = stableDeviceId("matter", { nodeId, fabricId });
  const inventory = endpointInventory(node);
  const endpointSource = inventory.endpoints;
  const endpointEntries = Array.isArray(endpointSource) ? endpointSource.map((item) => [String(item.endpoint_id ?? item.endpointId ?? item.id ?? "0"), item]) : Object.entries(endpointSource);
  const entities = {};
  for (const [endpointId, endpoint] of endpointEntries) {
    for (const [clusterId, clusterValue] of clusterEntries(endpoint)) {
      const attributes = attributesFor(clusterId, clusterValue);
      const acceptedEntry = attributes.find(([attributeId]) => attributeId === '65529')?.[1];
      const rawAccepted = Array.isArray(acceptedEntry) ? acceptedEntry : acceptedEntry?.value;
      const acceptedCommandIds = Array.isArray(rawAccepted) && rawAccepted.length <= 128
        && rawAccepted.every(id => Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff) ? [...new Set(rawAccepted)] : null;
      for (const [attributeId, value] of attributes) {
        const model = cluster(String(clusterId));
        const rawDescriptor = typeof value === "object" && value !== null && !Array.isArray(value) ? value : { value };
        const descriptor = { ...(model.attributes?.[String(attributeId)] || {}), ...rawDescriptor };
        if (String(clusterId) === '513' && ['17','18','19','20'].includes(String(attributeId))) {
          const read = id => { const entry = attributes.find(([key]) => key === id)?.[1]; return typeof entry === 'number' ? entry : entry?.value; };
          const heat = ['18','20'].includes(String(attributeId));
          const lower = read(heat ? '21' : '23') ?? read(heat ? '3' : '5');
          const upper = read(heat ? '22' : '24') ?? read(heat ? '4' : '6');
          if (Number.isInteger(lower)) descriptor.min = lower;
          if (Number.isInteger(upper)) descriptor.max = upper;
        }
        const entity = serviceFor(String(clusterId), String(attributeId), descriptor, { ...endpoint, endpoint_id: endpointId }, rawDescriptor, acceptedCommandIds);
        entity.deviceId = id;
        entity.id = `${id}:${entity.id}`;
        entities[entity.id] = entity;
      }
    }
  }
  if (!Object.keys(entities).length && !inventory.incomplete) Object.assign(entities, fallbackStateEntities(node, id));
  return {
    id,
    protocol: "matter",
    infrastructure,
    name: matterName(node),
    legacyIds: nodeId ? [`matter-${nodeId}`] : [],
    available: node.available !== false && node.reachable !== false,
    interviewStatus: node.commissioned === false ? "pending" : "successful",
    protocolIdentity: { fabricId, nodeId },
    definition: { source: "matter-self-description", supported: true, deviceTypes: endpointEntries.flatMap(([, endpoint]) => (endpoint.device_types || endpoint.deviceTypes || []).map((item) => deviceType(item.id ?? item))).slice(0, 32) },
    metadata: { node_id: nodeId, fabric_id: fabricId, vendor_name: node.vendor_name || node.vendorName, product_name: node.product_name || node.productName, endpoints: endpointEntries.map(([endpointId, endpoint]) => ({ endpointId, deviceTypes: clone(endpoint.device_types || endpoint.deviceTypes || []), clusters: clusterEntries(endpoint).map(([clusterId, clusterValue]) => ({ id: String(clusterId), name: cluster(String(clusterId)).name, commandIds: cluster(String(clusterId)).commands.map((item) => String(item.id)).slice(0, 32), attributeCount: attributesFor(clusterId, clusterValue).length })) })) },
    state: asObject(node.state),
    entities,
  };
}

module.exports = { normalizeMatterNode, serviceFor, fallbackStateEntities, semanticRoleFor, CLUSTERS };
