function parseJson(payload) {
  try { return JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload)); } catch { return null; }
}

function parseDiscovery(topic, payload, prefix = "dinodia-ha") {
  const value = typeof payload === "object" && payload !== null ? payload : parseJson(payload);
  if (!value || typeof value !== "object") return null;
  const parts = String(topic || "").split("/");
  if (parts[0] !== prefix || parts.length < 4) return null;
  const component = parts[1];
  const objectId = parts[2];
  return {
    component,
    objectId,
    uniqueId: value.unique_id || value.uniqueId || `${component}:${objectId}`,
    device: value.device && typeof value.device === "object" ? value.device : {},
    semantic: {
      deviceClass: value.device_class,
      stateClass: value.state_class,
      unit: value.unit_of_measurement,
      icon: value.icon,
      entityCategory: value.entity_category,
      options: Array.isArray(value.options) ? value.options.map(String).slice(0, 32) : undefined,
      valueTemplate: typeof value.value_template === "string" ? value.value_template.slice(0, 256) : undefined,
    },
    topics: {
      state: value.state_topic,
      command: value.command_topic,
      availability: value.availability_topic,
      jsonAttributes: value.json_attributes_topic,
    },
    payloads: {
      on: value.payload_on,
      off: value.payload_off,
      toggle: value.payload_toggle,
    },
  };
}

function reconcileDiscovery(existing = {}, discovery) {
  if (!discovery) return existing;
  const key = String(discovery.uniqueId);
  return {
    ...existing,
    [key]: {
      ...(existing[key] || {}),
      ...discovery,
      lastSeen: new Date().toISOString(),
    },
  };
}

module.exports = { parseDiscovery, reconcileDiscovery };
