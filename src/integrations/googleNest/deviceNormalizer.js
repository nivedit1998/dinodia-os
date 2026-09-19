const { stableGoogleNestDeviceId } = require("../../capabilities/identity");

const PROTOCOL = "google_nest";
const DTO_VERSION = 1;
const MAX_DEVICES = 100;

function text(value, fallback = "") { const result = String(value ?? fallback).trim(); return result.slice(0, 128); }
function resourceText(value) { const result = String(value ?? "").trim(); return result.slice(0, 512); }
function finite(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function shortHash(value) { return String(value || "").split("/").pop()?.slice(-8) || "device"; }
function trait(raw, name) { return raw?.traits?.[name] && typeof raw.traits[name] === "object" ? raw.traits[name] : {}; }

function classify(raw) { return text(raw?.type).toUpperCase() === "SDM.DEVICES.TYPES.THERMOSTAT" ? "thermostat" : "unsupported"; }

function availableModes(modeTrait) {
  const raw = Array.isArray(modeTrait.availableModes) ? modeTrait.availableModes : [];
  return [...new Set(raw.map((mode) => text(mode).toUpperCase()).filter((mode) => ["OFF", "HEAT", "COOL", "HEATCOOL", "ON"].includes(mode)))];
}

function normalizeMode(value) {
  const mode = text(value, "UNKNOWN").toUpperCase();
  return mode === "ON" ? "HEAT" : mode;
}

function normalizeRaw(raw, { machineKey = "dinodia-google-nest", ignoredDeviceIds = new Set(), accountFingerprint = "", maxDevices = MAX_DEVICES } = {}) {
  const list = Array.isArray(raw?.devices) ? raw.devices.slice(0, Math.max(1, Number(maxDevices) || MAX_DEVICES)) : [];
  const devices = [];
  let unsupportedDeviceCount = 0;
  const names = new Map();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (classify(item) !== "thermostat") { unsupportedDeviceCount += 1; continue; }
    // SDM device resource names can exceed 128 characters. They are the
    // command identity, so truncating them can collapse a retired resource
    // and its replacement into the same local device ID.
    const resourceName = resourceText(item.name);
    if (!resourceName || ignoredDeviceIds.has(resourceName)) continue;
    const id = stableGoogleNestDeviceId(resourceName, machineKey);
    const info = trait(item, "sdm.devices.traits.Info");
    const relation = Array.isArray(item.parentRelations) ? item.parentRelations.find((entry) => entry && entry.displayName) : null;
    const baseName = text(info.customName || relation?.displayName, `Google Nest Thermostat ${shortHash(resourceName)}`);
    const count = (names.get(baseName) || 0) + 1;
    names.set(baseName, count);
    const name = count > 1 ? `${baseName} ${count}` : baseName;
    const connectivity = trait(item, "sdm.devices.traits.Connectivity");
    const temperature = trait(item, "sdm.devices.traits.Temperature");
    const humidity = trait(item, "sdm.devices.traits.Humidity");
    const modeTrait = trait(item, "sdm.devices.traits.ThermostatMode");
    const setpoint = trait(item, "sdm.devices.traits.ThermostatTemperatureSetpoint");
    const hvac = trait(item, "sdm.devices.traits.ThermostatHvac");
    const eco = trait(item, "sdm.devices.traits.ThermostatEco");
    const modes = availableModes(modeTrait);
    const currentMode = normalizeMode(modeTrait.mode);
    const online = text(connectivity.status, "ONLINE").toUpperCase() !== "OFFLINE";
    const state = {
      state: currentMode.toLowerCase(),
      mode: currentMode.toLowerCase(),
      available_modes: modes,
      current_temperature: finite(temperature.ambientTemperatureCelsius),
      target_temperature: finite(setpoint.heatCelsius),
      heating_action: text(hvac.status).toUpperCase() === "HEATING" ? "heating" : text(hvac.status).toUpperCase() === "OFF" || currentMode === "OFF" ? "off" : text(hvac.status) ? "idle" : "unknown",
      ambient_humidity: finite(humidity.ambientHumidityPercent),
      eco_mode: text(eco.mode) || null,
      min_temperature: 9,
      max_temperature: 32,
      temperature_unit: "°C",
      online,
    };
    const climateBindings = [];
    if (modes.includes("OFF")) climateBindings.push({ serviceId: "climate.turn_off", operation: "SetMode", parameter: { key: "mode", type: "string", options: ["off"] } });
    const heatingModes = modes.filter((mode) => ["HEAT", "ON"].includes(mode));
    if (heatingModes.length) {
      climateBindings.push({ serviceId: "climate.turn_on", operation: "SetMode", parameter: { key: "mode", type: "string", options: ["heat"] } });
      climateBindings.push({ serviceId: "climate.set_hvac_mode", operation: "SetMode", parameter: { key: "hvac_mode", type: "string", options: ["heat", ...(modes.includes("OFF") ? ["off"] : [])] } });
    }
    const entities = {};
    const base = (key) => `${id}:0:${key}`;
    if (climateBindings.length) entities[base("mode")] = { id: base("mode"), sourceId: base("mode"), deviceId: id, endpointId: "0", logicalKey: "mode", stateKey: "mode", domain: "climate", name: "Heating mode", original_name: "Heating mode", state: currentMode.toLowerCase(), primary: true, expose: { modes: modes.map((mode) => mode.toLowerCase()), hvac_modes: modes.map((mode) => mode.toLowerCase()) }, capability: { runtime: "dinodia_os", kind: "composite", category: "control", readable: true, writable: true, observable: true, primary: true, bindings: climateBindings } };
    if (setpoint.heatCelsius !== undefined && setpoint.heatCelsius !== null) entities[base("target_temperature")] = { id: base("target_temperature"), sourceId: base("target_temperature"), deviceId: id, endpointId: "0", logicalKey: "target_temperature", stateKey: "target_temperature", domain: "number", name: "Target temperature", original_name: "Target temperature", state: state.target_temperature, capability: { runtime: "dinodia_os", kind: "number", category: "control", readable: true, writable: true, observable: true, primary: true, bindings: [{ serviceId: "climate.set_temperature", operation: "SetHeat", parameter: { key: "temperature", type: "number", min: 9, max: 32, step: 0.5 } }], constraints: { min: 9, max: 32, step: 0.5 }, unit: "°C" } };
    entities[base("current_temperature")] = { id: base("current_temperature"), sourceId: base("current_temperature"), deviceId: id, endpointId: "0", logicalKey: "current_temperature", stateKey: "current_temperature", domain: "sensor", category: "diagnostic", name: "Current temperature", original_name: "Current temperature", state: state.current_temperature, capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] } };
    entities[base("heating_action")] = { id: base("heating_action"), sourceId: base("heating_action"), deviceId: id, endpointId: "0", logicalKey: "heating_action", stateKey: "heating_action", domain: "sensor", category: "diagnostic", name: "Heating action", original_name: "Heating action", state: state.heating_action, expose: { hvac_action: state.heating_action }, capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] } };
    if (state.ambient_humidity !== null) entities[base("humidity")] = { id: base("humidity"), sourceId: base("humidity"), deviceId: id, endpointId: "0", logicalKey: "humidity", stateKey: "humidity", domain: "sensor", category: "diagnostic", name: "Ambient humidity", original_name: "Ambient humidity", state: state.ambient_humidity, capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] }, unit: "%" };
    entities[base("online")] = { id: base("online"), sourceId: base("online"), deviceId: id, endpointId: "0", logicalKey: "online", stateKey: "online", domain: "binary_sensor", category: "diagnostic", name: "Google Nest online", original_name: "Google Nest online", state: online, capability: { runtime: "dinodia_os", kind: "sensor", category: "diagnostic", readable: true, writable: false, observable: true, bindings: [] } };
    devices.push({ id, name, protocol: PROTOCOL, protocolIdentity: { resourceName, accountFingerprint }, definition: { source: "google_nest_sdm", kind: "heating", suggestedLabelId: "boiler", dtoVersion: DTO_VERSION, model: text(info.deviceModel || "Nest Thermostat") }, metadata: { manufacturer: "Google Nest", model: text(info.deviceModel || "Nest Thermostat"), source: "google_nest_cloud", room_hint: text(relation?.displayName), resource_name: resourceName, account_fingerprint: accountFingerprint, available_modes: modes }, state, available: online, entities, setup: { status: "needs_setup", assignmentMode: "device_inherited_v1", reason: "area_and_label_required" } });
  }
  return { devices, thermostatDeviceCount: devices.length, unsupportedDeviceCount };
}

module.exports = { PROTOCOL, DTO_VERSION, normalizeRaw, availableModes, normalizeMode };
