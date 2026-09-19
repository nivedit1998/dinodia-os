const { stableHiveAccountFingerprint, stableHiveDeviceId } = require("../../capabilities/identity");

const HIVE_PROTOCOL = "hive";
const HIVE_DTO_VERSION = 1;
const MAX_NAME = 128;

function text(value, fallback = "") {
  const valueText = String(value === undefined || value === null ? fallback : value).trim();
  return valueText.slice(0, MAX_NAME);
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "on", "online", "yes", "1"].includes(value.toLowerCase())) return true;
    if (["false", "off", "offline", "no", "0"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function booleanState(value) {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["true", "on", "online", "yes", "1", "heating", "enabled"].includes(normalized)) return true;
  if (["false", "off", "offline", "no", "0", "idle", "disabled"].includes(normalized)) return false;
  return null;
}

function accountFingerprint(accountId, username, machineKey = "dinodia-hive") {
  return stableHiveAccountFingerprint(accountId, username, machineKey);
}

function cloudIdFor(input) {
  return text(input.cloudId || input.deviceId || input.id || input.zoneId || input.zone_id);
}

function classification(input) {
  const values = [input.kind, input.role, input.type, input.product, input.productType, input.deviceType, input.category]
    .map((item) => text(item).toLowerCase())
    .filter(Boolean);
  const joined = values.join(" ");
  if (input.infrastructure === true || /^(hub|bridge|receiver|gateway|account|service)$/.test(joined.trim())) return "infrastructure";
  if (/hot.?water|water.?heater/.test(joined)) return "hot_water";
  if (/radiator|trv|thermostat|heating|boiler|climate/.test(joined)) return "heating";
  if (/light/.test(joined)) return "light";
  if (/plug|switch/.test(joined)) return "switch";
  if (/sensor|motion|contact/.test(joined)) return "sensor";
  return "unknown";
}

function suggestedLabelId(input) {
  const values = [input.kind, input.role, input.type, input.product, input.productType, input.deviceType, input.model]
    .map((item) => text(item).toLowerCase())
    .filter(Boolean)
    .join(" ");
  return /radiator|trv/.test(values) ? "radiator" : "boiler";
}

function heatingState(input) {
  const source = input.state && typeof input.state === "object" ? input.state : {};
  const mode = text(source.mode || source.hvacMode || source.hvac_mode || source.systemMode, "UNKNOWN").toUpperCase();
  const normalizedMode = mode === "SCHEDULE" || mode === "AUTO" ? "auto" : mode === "MANUAL" || mode === "HEAT" ? "heat" : mode === "OFF" ? "off" : "unknown";
  const currentTemperature = finite(source.currentTemperature ?? source.current_temperature ?? source.currentTemp ?? source.temperatureCurrent);
  const targetTemperature = finite(source.targetTemperature ?? source.target_temperature ?? source.targetTemp ?? source.temperature);
  const minTemperature = finite(source.minimumTemperature ?? source.minTemperature ?? source.min_temp);
  const maxTemperature = finite(source.maximumTemperature ?? source.maxTemperature ?? source.max_temp);
  const action = booleanState(source.action ?? source.heating ?? source.isHeating ?? source.working);
  const available = bool(input.online ?? input.available ?? source.online, true);
  return {
    state: normalizedMode,
    mode: normalizedMode,
    current_temperature: currentTemperature,
    target_temperature: targetTemperature,
    heating_action: normalizedMode === "off" ? "off" : action === true ? "heating" : action === false ? "idle" : "unknown",
    min_temperature: minTemperature,
    max_temperature: maxTemperature,
    temperature_unit: text(source.temperatureUnit || source.temperature_unit, "C").toUpperCase() === "F" ? "°F" : "°C",
    boost: bool(source.boost, false),
    online: available,
  };
}

function heatingEntities(deviceId, state) {
  const endpointId = "0";
  const base = (logicalKey) => `${deviceId}:${endpointId}:${logicalKey}`;
  const climateBindings = [
    { serviceId: "climate.turn_on" },
    { serviceId: "climate.turn_off" },
    { serviceId: "climate.set_hvac_mode", parameter: { key: "hvac_mode", type: "string", options: ["auto", "heat", "off"] } },
  ];
  const entities = {
    [base("mode")]: {
      id: base("mode"), sourceId: base("mode"), deviceId, endpointId, logicalKey: "mode", stateKey: "mode",
      domain: "climate", name: "Heating mode", original_name: "Heating mode", state: state.mode, primary: true,
      capability: { runtime: "dinodia_os", kind: "composite", category: "control", readable: true, writable: true, observable: true, primary: true, bindings: climateBindings },
    },
    [base("target_temperature")]: {
      id: base("target_temperature"), sourceId: base("target_temperature"), deviceId, endpointId, logicalKey: "target_temperature", stateKey: "target_temperature",
      domain: "number", name: "Target temperature", original_name: "Target temperature", state: state.target_temperature,
      capability: { runtime: "dinodia_os", kind: "number", category: "control", readable: true, writable: true, observable: true, primary: true, bindings: [{ serviceId: "climate.set_temperature", parameter: { key: "temperature", type: "number", min: state.min_temperature ?? 5, max: state.max_temperature ?? 35, step: 0.5 } }], constraints: { min: state.min_temperature ?? 5, max: state.max_temperature ?? 35, step: 0.5 }, unit: state.temperature_unit },
    },
    [base("current_temperature")]: {
      id: base("current_temperature"), sourceId: base("current_temperature"), deviceId, endpointId, logicalKey: "current_temperature", stateKey: "current_temperature",
      domain: "sensor", category: "diagnostic", name: "Current temperature", original_name: "Current temperature", state: state.current_temperature,
      capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] },
    },
    [base("heating_action")]: {
      id: base("heating_action"), sourceId: base("heating_action"), deviceId, endpointId, logicalKey: "heating_action", stateKey: "heating_action",
      domain: "sensor", category: "diagnostic", name: "Heating action", original_name: "Heating action", state: state.heating_action,
      capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] },
    },
    [base("online")]: {
      id: base("online"), sourceId: base("online"), deviceId, endpointId, logicalKey: "online", stateKey: "online",
      domain: "binary_sensor", category: "diagnostic", name: "Hive online", original_name: "Hive online", state: state.online,
      capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] },
    },
  };
  return entities;
}

function friendlyName(input, index = 0) {
  const name = text(input.name || input.displayName || input.hiveName || input.haName || input.label || input.zoneName);
  if (name) return name;
  const kind = classification(input);
  if (kind === "heating") return index ? `Hive Heating ${index + 1}` : "Hive Heating";
  return `Hive ${kind === "hot_water" ? "Hot Water" : "Device"}`;
}

function normalizeHiveDevices(snapshot = {}, options = {}) {
  const input = snapshot && typeof snapshot === "object" ? snapshot : {};
  const accountId = text(input.accountId || input.account_id || options.accountId, "unknown");
  const fingerprint = text(options.accountFingerprint) || accountFingerprint(accountId, options.username, options.machineKey);
  const list = Array.isArray(input.devices) ? input.devices : [];
  const seen = new Set();
  const heatingNames = new Map();
  const devices = [];
  let unsupportedProductCount = 0;
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const kind = classification(raw);
    const cloudId = cloudIdFor(raw);
    if (!cloudId || seen.has(cloudId)) return;
    seen.add(cloudId);
    if (kind === "infrastructure" || kind === "hot_water") return;
    if (kind !== "heating") {
      unsupportedProductCount += 1;
      return;
    }
    const baseName = friendlyName(raw, index);
    const count = (heatingNames.get(baseName) || 0) + 1;
    heatingNames.set(baseName, count);
    const name = count > 1 ? `${baseName} ${count}` : baseName;
    const id = stableHiveDeviceId({ accountFingerprint: fingerprint, cloudId });
    const state = heatingState(raw);
    const metadata = {
      manufacturer: "Hive",
      model: text(raw.model || raw.product || raw.productType || raw.deviceType) || null,
      cloud_id: cloudId,
      parent_id: text(raw.parentId || raw.parent_id) || null,
      source: "hive_cloud",
      account_fingerprint: fingerprint,
    };
    devices.push({
      id,
      name,
      protocol: HIVE_PROTOCOL,
      protocolIdentity: { accountFingerprint: fingerprint, cloudId },
      definition: { source: "hive_cloud", kind: "heating", suggestedLabelId: suggestedLabelId(raw), dtoVersion: HIVE_DTO_VERSION, model: metadata.model },
      metadata,
      state,
      available: state.online,
      entities: heatingEntities(id, state),
      setup: { status: "needs_setup", assignmentMode: "device_inherited_v1", reason: "area_and_label_required" },
    });
  });
  return { accountFingerprint: fingerprint, devices, heatingDeviceCount: devices.length, unsupportedProductCount };
}

module.exports = { HIVE_DTO_VERSION, accountFingerprint, classification, heatingState, normalizeHiveDevices, suggestedLabelId };
