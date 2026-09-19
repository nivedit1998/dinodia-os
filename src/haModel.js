const crypto = require("node:crypto");
const { normalizeCapability } = require("./capabilities/schema");
const { projectionForEntity, servicesForCapability } = require("./capabilities/haProjection");
const { bindingFor } = require("./capabilities/serviceRouter");
const { allProjectedSurfaces, sourceRoute } = require("./capabilities/controlSurfaceProjection");
const { isSurface, rawEntityById } = require("./capabilities/devicePresentation");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function slug(value, fallback = "entity") {
  const result = String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return result || fallback;
}

function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || "Entity";
}

function normalizeIdList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function normalizeHaState(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["on", "off", "open", "closed", "opening", "closing", "locked", "unlocked", "home", "away", "detected", "clear"].includes(lower)) return lower;
  }
  if (value === undefined || value === null) return "unknown";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inferDomain(device, entity) {
  if (entity && entity.domain) return String(entity.domain);
  const exposeType = entity && entity.expose && entity.expose.type;
  if (["light", "switch", "cover", "climate", "fan", "lock", "vacuum", "humidifier", "camera", "button", "binary_sensor", "sensor", "media_player"].includes(String(exposeType))) return String(exposeType);
  const key = String((entity && (entity.stateKey || entity.name)) || "").toLowerCase();
  const metadata = device && device.metadata && device.metadata.definition;
  const exposes = device && device.metadata && (device.metadata.exposes || (metadata && metadata.exposes));
  const rootTypes = Array.isArray(exposes) ? exposes.map((item) => String(item && item.type || "").toLowerCase()) : [];
  if (rootTypes.includes("light") && ["state", "power", "brightness", "color_temp", "color", "color_mode"].includes(key)) return "light";
  if (rootTypes.includes("cover") && ["position", "current_position", "state"].includes(key)) return "cover";
  if (rootTypes.includes("climate") && ["temperature", "target_temperature", "current_temperature", "hvac_mode"].includes(key)) return "climate";
  if (["motion", "occupancy", "presence", "contact", "opening"].some((name) => key.includes(name))) return "binary_sensor";
  if (["state", "power", "switch"].includes(key)) return "switch";
  if (["brightness", "temperature", "humidity", "battery", "voltage", "power", "energy", "linkquality"].some((name) => key.includes(name))) return "sensor";
  return "sensor";
}

function deviceHaId(device) {
  if (device.haDeviceId) return String(device.haDeviceId);
  const identifier = device.protocol === "zigbee"
    ? String(device.metadata && (device.metadata.ieee_address || device.metadata.ieee || device.id) || device.id)
    : String(device.protocol || "device") + ":" + String(device.id);
  return `device_${crypto.createHash("sha256").update(identifier).digest("hex").slice(0, 20)}`;
}

function entityHaId(device, rawId, entity) {
  if (entity && entity.haEntityId) return String(entity.haEntityId);
  const domain = inferDomain(device, entity);
  const physicalId = device.protocol === "zigbee"
    ? String(device.metadata && (device.metadata.ieee_address || device.metadata.ieee) || device.id)
    : String(device.id);
  const key = String(entity && (entity.stateKey || entity.id) || rawId).replace(/^.*:/, "");
  return `${domain}.${slug(physicalId)}_${slug(key)}`;
}

function stateAttributeName(key) {
  const normalized = String(key || "").toLowerCase();
  return normalized === "power" ? "state" : String(key || "state");
}

function parseTargetIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(parseTargetIds);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function sourceCommandData(publicService, sourceService, data = {}) {
  const result = { ...(data || {}) };
  delete result.entity_id;
  delete result.device_id;
  delete result.area_id;
  delete result.label_id;
  delete result.target;
  const source = String(sourceService || "").toLowerCase();
  const requested = String(publicService || "").toLowerCase();
    if (source === "number.set_value" && result.value === undefined) {
      if (result.temperature !== undefined) result.value = result.temperature;
      else if (result.brightness !== undefined) result.value = result.brightness;
      else if (result.color_temp !== undefined) result.value = result.color_temp;
      else if (result.brightness_pct !== undefined) result.value = Math.round(Math.max(0, Math.min(100, Number(result.brightness_pct))) * 2.54);
  }
  if (source === "select.select_option" && result.option === undefined) {
    if (result.hvac_mode !== undefined) result.option = result.hvac_mode;
    else if (result.preset_mode !== undefined) result.option = result.preset_mode;
  }
  if (source === "text.set_value" && result.value === undefined && result.text !== undefined) result.value = result.text;
  void requested;
  return result;
}

function entityQuality(item) {
  const entity = item?.entity || {};
  let score = 0;
  if (entity.capability && typeof entity.capability === "object") score += 4;
  if (entity.expose && typeof entity.expose === "object") score += 2;
  if (entity.name || entity.original_name) score += 1;
  if (entity.state !== undefined) score += 1;
  if (entity.available !== undefined) score += 1;
  return score;
}

class HomeAssistantModel {
  constructor({ store, commandDevice, commandEntity, removeProtocolDevice, onDeviceChanged, onEntityChanged, onDeviceRemoved, eventBus, logger = console } = {}) {
    this.store = store;
    this.commandDevice = commandDevice;
    this.commandEntity = commandEntity;
    this.removeProtocolDevice = removeProtocolDevice;
    this.onDeviceChanged = onDeviceChanged;
    this.onEntityChanged = onEntityChanged;
    this.onDeviceRemoved = onDeviceRemoved;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  areas() {
    return this.store.listAreas().map((area) => ({ area_id: String(area.id), name: String(area.name), icon: area.icon || undefined }));
  }

  labels() {
    return this.store.listLabels().map((label) => ({ label_id: String(label.id), name: String(label.name), color: label.color || undefined, description: label.description || undefined }));
  }

  devices() {
    return this.store.listDevices().map((device) => ({ device, haId: deviceHaId(device) }));
  }

  entities() {
    const list = [];
    for (const device of this.store.listDevices()) {
      const surfaces = allProjectedSurfaces(device);
      const managedProtocolDevice = ["zigbee", "matter", "hive", "google_nest"].includes(String(device.protocol || "").toLowerCase()) && device.setup && typeof device.setup === "object";
      const source = surfaces.length ? surfaces.map((surface) => [surface.id, surface]) : managedProtocolDevice ? [] : Object.entries(device.entities || {});
      for (const [rawId, entity] of source) {
        const safeEntity = entity && typeof entity === "object" ? entity : { state: entity, stateKey: rawId };
        const haId = entityHaId(device, rawId, safeEntity);
        list.push({ device, rawId, entity: safeEntity, haId, domain: safeEntity.domain || inferDomain(device, safeEntity), surface: surfaces.length ? safeEntity : null });
      }
    }
    // HA entity IDs are globally unique. Legacy imports can briefly contain
    // two records that resolve to the same ID, so expose one deterministic
    // canonical record instead of returning an invalid HA state list.
    const byHaId = new Map();
    for (const item of list) {
      const existing = byHaId.get(item.haId);
      if (!existing || entityQuality(item) > entityQuality(existing)) byHaId.set(item.haId, item);
    }
    return [...byHaId.values()];
  }

  findDevice(value) {
    const needle = String(value || "");
    return this.store.listDevices().find((device) => device.id === needle || deviceHaId(device) === needle || String(device.metadata && device.metadata.ieee_address || "") === needle) || null;
  }

  findEntity(value) {
    const needle = String(value || "");
    const direct = this.entities().find((item) => item.rawId === needle || item.haId === needle || item.entity.id === needle || item.entity.entityId === needle);
    if (direct) return direct;
    const alias = this.store.state.aliases && this.store.state.aliases[needle];
    return alias ? this.entities().find((item) => item.haId === alias || item.rawId === alias || item.entity.id === alias) || null : null;
  }

  deviceRegistry() {
    return this.devices().map(({ device, haId }) => ({
      id: haId,
      name: device.name || device.id,
      name_by_user: device.name || null,
      manufacturer: device.metadata && (device.metadata.manufacturer || device.metadata.manufacturer_name) || null,
      model: device.metadata && (device.metadata.model || device.metadata.model_id) || null,
      labels: normalizeIdList(device.labelIds || device.labels),
      area_id: device.areaId ? String(device.areaId) : null,
      identifiers: [[String(device.protocol || "dinodia"), String(device.metadata && (device.metadata.ieee_address || device.metadata.node_id) || device.id)]],
      config_entries: [String(device.configEntryId || (device.protocol === "zigbee" ? "ce_zigbee" : device.protocol === "matter" ? "ce_matter" : device.protocol === "hive" ? "ce_hive" : device.protocol === "google_nest" ? "ce_google_nest" : "ce_virtual"))],
      entry_type: null,
      via_device_id: null,
    }));
  }

  entityRegistry() {
    return this.entities().map(({ device, entity, haId, surface }) => ({
      entity_id: haId,
      device_id: deviceHaId(device),
      name: entity.name || entity.original_name || humanize(entity.stateKey || haId),
      original_name: entity.original_name || entity.name || humanize(entity.stateKey || haId),
      area_id: device.areaId ? String(device.areaId) : null,
      labels: surface ? [] : normalizeIdList(entity.labelIds || entity.labels),
      platform: device.protocol || "dinodia",
      disabled_by: null,
    }));
  }

  stateFor(item) {
    const { device, entity, haId, domain } = item;
    if (isSurface(entity)) {
      return {
        entity_id: haId,
        state: device.available === false || entity.available === false ? "unavailable" : normalizeHaState(entity.state),
        attributes: clone(entity.attributes || {}),
        last_changed: device.updatedAt || new Date(0).toISOString(),
        last_updated: device.updatedAt || new Date(0).toISOString(),
        context: { id: "", parent_id: null, user_id: null },
      };
    }
    const key = String(entity.stateKey || entity.id || "state");
    const raw = entity.state !== undefined ? entity.state : (device.state || {})[key];
    const projection = projectionForEntity(entity);
    const attributes = {
      friendly_name: entity.name || humanize(key),
      device_id: deviceHaId(device),
      area_id: device.areaId || null,
      labels: normalizeIdList(entity.labelIds || entity.labels),
      ...projection.attributes,
    };
    if (entity.expose && typeof entity.expose === "object") {
      if (entity.expose.unit) attributes.unit_of_measurement = entity.expose.unit;
      if (entity.expose.device_class) attributes.device_class = entity.expose.device_class;
      if (entity.expose.values) attributes.options = clone(entity.expose.values);
      if (entity.expose.value_min !== undefined) attributes.min = Number(entity.expose.value_min);
      if (entity.expose.value_max !== undefined) attributes.max = Number(entity.expose.value_max);
      if (entity.expose.value_step !== undefined) attributes.step = Number(entity.expose.value_step);
    }
    const capability = projection.capability;
    if (capability.constraints?.options && !attributes.options) attributes.options = clone(capability.constraints.options);
    if (capability.unit && !attributes.unit_of_measurement) attributes.unit_of_measurement = capability.unit;
    if (capability.deviceClass && !attributes.device_class) attributes.device_class = capability.deviceClass;
    if (domain === "light") {
      const state = device.state || {};
      if (state.brightness !== undefined) attributes.brightness = Number(state.brightness);
      if (state.color_temp !== undefined) attributes.color_temp = Number(state.color_temp);
      if (state.color_mode !== undefined) attributes.color_mode = state.color_mode;
      if (state.hs_color !== undefined) attributes.hs_color = clone(state.hs_color);
      if (entity.expose && entity.expose.access !== undefined) attributes.supported_color_modes = entity.expose.values || ["brightness"];
    }
    if (domain === "cover" && device.state) {
      if (device.state.position !== undefined) attributes.current_position = Number(device.state.position);
      if (device.state.current_position !== undefined) attributes.current_position = Number(device.state.current_position);
    }
    if (domain === "climate" && device.state) {
      for (const keyName of ["temperature", "target_temperature", "current_temperature", "hvac_modes", "min_temp", "max_temp", "target_temp_step", "hvac_mode"]) {
        if (device.state[keyName] !== undefined) attributes[keyName] = clone(device.state[keyName]);
      }
    }
    return {
      entity_id: haId,
      state: device.available === false || entity.available === false ? "unavailable" : normalizeHaState(raw),
      attributes,
      last_changed: entity.lastChanged || entity.updatedAt || device.updatedAt || new Date(0).toISOString(),
      last_updated: entity.updatedAt || device.updatedAt || new Date(0).toISOString(),
      context: { id: entity.contextId || "", parent_id: null, user_id: null },
    };
  }

  states() {
    return this.entities().map((item) => this.stateFor(item));
  }

  state(value) {
    const item = this.findEntity(value);
    return item ? this.stateFor(item) : null;
  }

  resolveTargets(target = {}, fallbackDomain = "") {
    const entities = [];
    const addEntity = (item) => {
      if (item && !entities.some((entry) => entry.haId === item.haId)) entities.push(item);
    };
    for (const id of parseTargetIds(target.entity_id || target.entityId)) addEntity(this.findEntity(id));
    for (const id of parseTargetIds(target.device_id || target.deviceId)) {
      const device = this.findDevice(id);
      if (device) this.entities().filter((item) => item.device.id === device.id).forEach(addEntity);
    }
    for (const id of parseTargetIds(target.area_id || target.areaId)) this.entities().filter((item) => String(item.device.areaId || "") === id).forEach(addEntity);
    for (const id of parseTargetIds(target.label_id || target.labelId)) this.entities().filter((item) => normalizeIdList(item.device.labelIds || item.device.labels).includes(id) || normalizeIdList(item.entity.labelIds || item.entity.labels).includes(id)).forEach(addEntity);
    if (!entities.length && fallbackDomain) this.entities().filter((item) => item.domain === fallbackDomain).forEach(addEntity);
    return entities;
  }

  commandFor(domain, service, data, item) {
    const value = { ...(data || {}) };
    delete value.entity_id;
    delete value.device_id;
    delete value.area_id;
    delete value.label_id;
    delete value.target;
    const lower = String(service || "").toLowerCase();
    const command = {};
    if (["turn_on", "turn_off", "toggle"].includes(lower)) {
      command.state = lower === "turn_on" ? "ON" : lower === "turn_off" ? "OFF" : "TOGGLE";
      const stateKey = String(item && item.entity && item.entity.stateKey || "state");
      if (stateKey !== "state") command[stateKey] = command.state;
    } else if (domain === "cover") {
      if (lower === "open_cover") command.state = "OPEN";
      else if (lower === "close_cover") command.state = "CLOSE";
      else if (lower === "stop_cover") command.state = "STOP";
      else if (lower === "set_cover_position") command.position = Number(value.position ?? value.current_position);
    } else if (domain === "climate") {
      if (["turn_on", "turn_off"].includes(lower)) command.state = lower === "turn_on" ? "ON" : "OFF";
      else if (lower === "set_temperature") command.temperature = Number(value.temperature ?? value.target_temperature);
      else if (lower === "set_hvac_mode") command.hvac_mode = String(value.hvac_mode || "");
    } else if (domain === "media_player") {
      const mediaMap = { turn_on: "ON", turn_off: "OFF", toggle: "TOGGLE", media_play: "PLAY", media_pause: "PAUSE", media_play_pause: "PLAY_PAUSE", media_next_track: "NEXT", media_previous_track: "PREVIOUS", volume_up: "VOLUME_UP", volume_down: "VOLUME_DOWN" };
      command.action = mediaMap[lower] || lower;
      if (lower === "volume_set") command.volume_level = Number(value.volume_level);
    } else if (domain === "fan") {
      if (lower === "set_percentage") command.percentage = Number(value.percentage);
      else if (lower === "set_preset_mode") command.preset_mode = String(value.preset_mode || "");
    } else if (domain === "lock") {
      command.state = lower === "unlock" ? "UNLOCK" : "LOCK";
    } else if (domain === "vacuum") {
      const vacuumMap = { start: "START", pause: "PAUSE", stop: "STOP", return_to_base: "RETURN_TO_BASE" };
      command.action = vacuumMap[lower] || lower;
    } else if (domain === "humidifier") {
      if (lower === "set_humidity") command.humidity = Number(value.humidity);
    } else if (domain === "button") {
      command.action = "PRESS";
    } else {
      Object.assign(command, value);
    }
    if (value.brightness !== undefined) command.brightness = Number(value.brightness);
    if (value.brightness_pct !== undefined) command.brightness = Math.round(Math.max(0, Math.min(100, Number(value.brightness_pct))) * 2.55);
    if (value.color_temp !== undefined) command.color_temp = Number(value.color_temp);
    if (value.hs_color !== undefined) command.hs_color = clone(value.hs_color);
    if (value.rgb_color !== undefined) command.rgb_color = clone(value.rgb_color);
    if (value.transition !== undefined) command.transition = Number(value.transition);
    return command;
  }

  async callService(domain, service, data = {}) {
    const actualDomain = String(domain || "");
    const actualService = String(service || "");
    const nestedTarget = data && data.target && typeof data.target === "object" ? data.target : {};
    const normalizedData = { ...(data || {}), ...nestedTarget };
    delete normalizedData.target;
    if (actualDomain === "automation") return this.callAutomationService(actualService, normalizedData);
    const isGlobalBlindController = actualDomain === "script" && actualService === "global_blind_controller";
    const dispatchDomain = isGlobalBlindController ? "cover" : actualDomain;
    const dispatchService = isGlobalBlindController ? "set_cover_position" : actualService;
    if (isGlobalBlindController) {
      normalizedData.entity_id = normalizedData.entity_id || normalizedData.target_cover || this.entities().filter((item) => item.domain === "cover").map((item) => item.haId);
      if (normalizedData.target_position !== undefined && normalizedData.position === undefined) normalizedData.position = normalizedData.target_position;
    }
    if (actualDomain === "cloud" && actualService === "logout") return { changed_states: [], service_response: {} };
    const targets = this.resolveTargets(normalizedData, actualDomain === "homeassistant" || actualDomain === "script" ? "" : actualDomain);
    if (!targets.length) throw Object.assign(new Error("No target entities found"), { statusCode: 404, code: "not_found" });
    const changed = [];
    for (const item of targets) {
      const device = item.device;
      const domain = actualDomain === "homeassistant" ? item.domain : dispatchDomain;
      if (!this.supportsService(domain, dispatchService, item)) {
        throw Object.assign(new Error(`${domain}.${dispatchService} is not supported for ${item.haId}`), { statusCode: 400, code: "unsupported_service" });
      }
      const command = this.commandFor(domain, dispatchService, normalizedData, item);
      const requestedService = actualDomain === "homeassistant" ? `${item.domain}.${dispatchService}` : `${domain}.${dispatchService}`;
      const route = item.surface ? sourceRoute(device, item.entity, requestedService) : null;
      const commandEntity = route?.entity || item.entity;
      const commandService = route?.serviceId || requestedService;
      const commandData = route ? sourceCommandData(requestedService, commandService, normalizedData) : normalizedData;
      if (this.commandEntity && bindingFor(commandEntity, commandService)) {
        await this.commandEntity(device, commandEntity, commandService, commandData, command);
      } else {
        await this.commandDevice(device.id, device.protocol, command);
      }
      // A composite surface can combine a primary on/off source with one or
      // more feature sources (for example a Matter level cluster or a
      // thermostat setpoint). Dispatch those feature writes through their
      // exact raw bindings as well; this keeps one public tile independent of
      // protocol-specific entity counts and command shapes.
      if (route?.parameters && this.commandEntity) {
        for (const [parameterKey, parameterRoute] of Object.entries(route.parameters)) {
          const parameterValue = normalizedData[parameterKey];
          if (parameterValue === undefined || !parameterRoute?.entityId) continue;
          if (parameterRoute.entityId === route.entity.id && String(parameterRoute.serviceId).toLowerCase() === String(route.serviceId).toLowerCase()) continue;
          const parameterEntity = rawEntityById(device, parameterRoute.entityId);
          const parameterService = String(parameterRoute.serviceId || "").toLowerCase();
          if (!parameterEntity || !bindingFor(parameterEntity, parameterService)) continue;
          const parameterData = { ...normalizedData };
          if (parameterService === "number.set_value") parameterData.value = parameterValue;
          if (parameterService === "select.select_option") parameterData.option = parameterValue;
          const parameterDomain = parameterService.split(".", 1)[0];
          const parameterCommand = this.commandFor(parameterDomain, parameterService.split(".", 2)[1], parameterData, { entity: parameterEntity, domain: parameterDomain });
          await this.commandEntity(device, parameterEntity, parameterService, sourceCommandData(requestedService, parameterService, parameterData), parameterCommand);
        }
      }
      const next = this.state(item.haId);
      if (next) changed.push(next);
    }
    return { changed_states: changed, service_response: {} };
  }

  supportsService(domain, service, item = null) {
    if (item?.entity?.capability?.bindings?.length) {
      const requested = `${String(domain).toLowerCase()}.${String(service).toLowerCase()}`;
      if (bindingFor(item.entity, requested)) return true;
      if (domain === "homeassistant" && ["turn_on", "turn_off", "toggle"].includes(String(service).toLowerCase())) {
        return Boolean(bindingFor(item.entity, `${item.domain}.${String(service).toLowerCase()}`));
      }
      return false;
    }
    const controllable = {
      light: ["turn_on", "turn_off", "toggle"],
      switch: ["turn_on", "turn_off", "toggle"],
      cover: ["open_cover", "close_cover", "stop_cover", "set_cover_position"],
      climate: ["turn_on", "turn_off", "set_temperature", "set_hvac_mode"],
      media_player: ["turn_on", "turn_off", "toggle", "media_play", "media_pause", "media_play_pause", "media_next_track", "media_previous_track", "volume_up", "volume_down", "volume_set"],
      fan: ["turn_on", "turn_off", "toggle", "set_percentage", "set_preset_mode"],
      lock: ["lock", "unlock", "turn_on", "turn_off", "toggle"],
      vacuum: ["start", "pause", "stop", "return_to_base"],
      humidifier: ["turn_on", "turn_off", "toggle", "set_humidity"],
      button: ["press"],
      number: ["set_value"],
      select: ["select_option"],
      text: ["set_value"],
      script: ["turn_on"],
    };
    return Boolean(controllable[domain]?.includes(String(service).toLowerCase()));
  }

  async callAutomationService(service, data) {
    const ids = parseTargetIds(data.entity_id || data.entityId);
    const automations = this.store.listAutomations().filter((automation) => !ids.length || ids.includes(automation.id) || ids.includes(`automation.${slug(automation.id)}`) || ids.includes(`automation.${slug(automation.name)}`));
    if (service === "delete") {
      for (const automation of automations) await this.store.deleteAutomation(automation.id);
    } else {
      for (const automation of automations) await this.store.saveAutomation({ ...automation, enabled: service !== "turn_off" }, automation.id);
    }
    return { changed_states: [], service_response: {} };
  }

  servicesForTarget(target) {
    const items = this.resolveTargets(target);
    const services = new Set();
    for (const item of items) {
      const { domain, entity } = item;
      if (entity.capability?.bindings?.length) {
        for (const service of servicesForCapability(entity)) services.add(String(service));
        if (entity.capability.bindings.some((binding) => ["turn_on", "turn_off", "toggle"].includes(String(binding.serviceId).split(".").pop()))) {
          services.add("homeassistant.turn_on");
          services.add("homeassistant.turn_off");
          services.add("homeassistant.toggle");
        }
        continue;
      }
      const supported = {
        light: ["turn_on", "turn_off", "toggle"],
        switch: ["turn_on", "turn_off", "toggle"],
        cover: ["open_cover", "close_cover", "stop_cover", "set_cover_position"],
        climate: ["turn_on", "turn_off", "set_temperature", "set_hvac_mode"],
        media_player: ["turn_on", "turn_off", "toggle", "media_play", "media_pause", "media_play_pause", "media_next_track", "media_previous_track", "volume_up", "volume_down", "volume_set"],
        fan: ["turn_on", "turn_off", "toggle", "set_percentage", "set_preset_mode"],
        lock: ["lock", "unlock"],
        vacuum: ["start", "pause", "stop", "return_to_base"],
        humidifier: ["turn_on", "turn_off", "toggle", "set_humidity"],
        button: ["press"],
        number: ["set_value"],
        select: ["select_option"],
        text: ["set_value"],
        script: ["turn_on"],
      }[domain] || [];
      for (const service of supported) services.add(`${domain}.${service}`);
      if (supported.some((service) => ["turn_on", "turn_off", "toggle"].includes(service))) {
        services.add("homeassistant.turn_on");
        services.add("homeassistant.turn_off");
        services.add("homeassistant.toggle");
      }
    }
    return [...services].sort();
  }

  async updateDeviceRegistry(input = {}) {
    const device = this.findDevice(input.device_id || input.id);
    if (!device) return null;
    const patch = {};
    if (input.name_by_user !== undefined) patch.name = String(input.name_by_user || device.name).trim() || device.name;
    if (input.name !== undefined) patch.name = String(input.name || device.name).trim() || device.name;
    if (input.area_id !== undefined) {
      if (input.area_id && !this.store.getArea(String(input.area_id))) throw Object.assign(new Error("Area not found"), { statusCode: 400, code: "invalid_area" });
      patch.areaId = input.area_id || null;
    }
    if (input.labels !== undefined) {
      patch.labelIds = normalizeIdList(input.labels);
      if (patch.labelIds.some((id) => !this.store.getLabel(id))) throw Object.assign(new Error("Label not found"), { statusCode: 400, code: "invalid_label" });
    }
    const updated = await this.store.updateDevice(device.id, patch);
    await this.onDeviceChanged?.(updated, device);
    this.eventBus?.emit("registry_updated", { registry: "device", id: deviceHaId(updated) });
    return this.deviceRegistry().find((entry) => entry.id === deviceHaId(updated)) || null;
  }

  async updateEntityRegistry(input = {}) {
    const found = this.findEntity(input.entity_id);
    if (!found) return null;
    const previousDevice = clone(found.device);
    const previousEntity = clone(found.entity);
    const patch = {};
    if (input.name !== undefined) patch.name = String(input.name || found.entity.name).trim() || found.entity.name;
    if (input.area_id !== undefined) {
      if (input.area_id && !this.store.getArea(String(input.area_id))) throw Object.assign(new Error("Area not found"), { statusCode: 400, code: "invalid_area" });
      patch.areaId = input.area_id || null;
    }
    if (input.labels !== undefined) {
      patch.labelIds = normalizeIdList(input.labels);
      if (patch.labelIds.some((id) => !this.store.getLabel(id))) throw Object.assign(new Error("Label not found"), { statusCode: 400, code: "invalid_label" });
    }
    let updated;
    if (input.new_entity_id && input.new_entity_id !== found.haId) {
      const requestedId = String(input.new_entity_id).trim();
      if (!/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(requestedId)) throw Object.assign(new Error("Entity ID must look like domain.object_id"), { statusCode: 400, code: "invalid_entity_id" });
      if (this.findEntity(requestedId)) throw Object.assign(new Error("Entity ID already exists"), { statusCode: 409, code: "entity_id_exists" });
      updated = await this.store.renameEntity(found.device.id, found.rawId, requestedId, { ...patch, haEntityId: requestedId, previousHaEntityId: found.haId });
    } else {
      updated = await this.store.updateEntity(found.device.id, found.rawId, { ...patch, ...(input.new_entity_id ? { haEntityId: String(input.new_entity_id) } : {}) });
    }
    if (!updated) return null;
    await this.onEntityChanged?.(this.store.getDevice(found.device.id), previousDevice, updated, previousEntity);
    this.eventBus?.emit("registry_updated", { registry: "entity", id: input.new_entity_id || found.haId });
    const next = this.findEntity(input.new_entity_id || input.entity_id);
    return next ? this.entityRegistry().find((entry) => entry.entity_id === next.haId) : null;
  }

  async createLabel(input = {}) {
    const labelId = input.label_id || input.id || undefined;
    const label = await this.store.saveLabel({ name: input.name, color: input.color }, labelId);
    this.eventBus?.emit("registry_created", { registry: "label", id: label.id });
    return { label_id: label.id, name: label.name, color: label.color };
  }

  async removeEntity(input = {}) {
    const found = this.findEntity(input.entity_id);
    if (!found) return false;
    const previousDevice = clone(found.device);
    const previousEntity = clone(found.entity);
    const removed = await this.store.removeEntity(found.device.id, found.rawId);
    if (removed) await this.onEntityChanged?.(this.store.getDevice(found.device.id), previousDevice, null, previousEntity);
    if (removed) this.eventBus?.emit("registry_removed", { registry: "entity", id: found.haId });
    return removed;
  }

  async removeDevice(input = {}) {
    const device = this.findDevice(input.device_id || input.id);
    if (device && this.removeProtocolDevice && ["zigbee", "matter", "hive", "google_nest"].includes(String(device.protocol || "").toLowerCase())) await this.removeProtocolDevice(device, Boolean(input.force));
    const removed = device ? await this.store.deleteDevice(device.id) : false;
    if (removed) {
      await this.onDeviceRemoved?.(device);
      this.eventBus?.emit("registry_removed", { registry: "device", id: deviceHaId(device) });
    }
    return removed;
  }

  renderTemplate(source) {
    const template = String(source || "").trim();
    if (!template) return "";
    const all = this.states();
    const devices = this.deviceRegistry();
    const entities = this.entityRegistry();
    const simple = template.match(/states\s*\[\s*["']([^"']+)["']\s*\]\s*\.state/i) || template.match(/states\.([a-zA-Z0-9_]+)\.state/i);
    if (simple) return String(this.state(simple[1])?.state || "unknown");
    const labelNameMatch = template.match(/label_devices\s*\(\s*["']([^"']+)["']\s*\)/i);
    const labelName = labelNameMatch ? labelNameMatch[1].trim() : "";
    const labelById = (id) => this.store.getLabel(id)?.name || id;
    if (/label_devices/i.test(template) && labelName) {
      const selected = this.devices().filter(({ device }) => {
        const names = normalizeIdList(device.labels || device.labelIds).map(labelById);
        return names.some((name) => name.toLowerCase() === labelName.toLowerCase()) || normalizeIdList(device.labels || device.labelIds).includes(labelName);
      });
      if (/device_entities/i.test(template)) {
        return JSON.stringify(selected.map(({ device, haId }) => {
          const deviceEntities = entities.filter((entity) => entity.device_id === haId);
          return { device_id: haId, entity_id: deviceEntities[0]?.entity_id || null, name: device.name || haId, area_name: this.store.getArea(device.areaId)?.name || null, labels: normalizeIdList(device.labels || device.labelIds).map(labelById) };
        }));
      }
      return JSON.stringify(selected.map(({ haId }) => haId));
    }
    if (/entity_labels|device_labels|labels_list/.test(template)) {
      const metadata = all.map((state) => {
        const entity = entities.find((item) => item.entity_id === state.entity_id);
        const device = devices.find((item) => item.id === entity?.device_id);
        const entityLabels = entity ? normalizeIdList(entity.labels).map(labelById) : [];
        const deviceLabels = device ? normalizeIdList(device.labels).map(labelById) : [];
        return { entity_id: state.entity_id, state: state.state, attributes: state.attributes, area_name: this.store.getArea(entity?.area_id || device?.area_id)?.name || null, device_id: entity?.device_id || null, entity_labels: entityLabels, device_labels: deviceLabels, labels: [...new Set([...entityLabels, ...deviceLabels])] };
      });
      if (/labels_list\s*\|\s*length\s*>\s*0/.test(template)) return JSON.stringify(metadata.filter((item) => item.labels.length > 0));
      return JSON.stringify(metadata.map((item) => { const { state, attributes, ...rest } = item; return rest; }));
    }
    const labelMatch = template.match(/label_devices\s*\(?\s*["']([^"']+)["']/i) || template.match(/label_id\s*==\s*["']([^"']+)["']/i);
    const labelId = labelMatch ? labelMatch[1] : "";
    const selectedDevices = labelId
      ? devices.filter((device) => device.labels.includes(labelId) || this.store.getLabel(labelId)?.name === labelId)
      : devices;
    if (/label_devices/i.test(template) && !/states/i.test(template)) return JSON.stringify(selectedDevices.map((device) => device.id));
    if (/device_entities/i.test(template)) {
      const ids = new Set(selectedDevices.map((device) => device.id));
      return JSON.stringify(entities.filter((entity) => ids.has(entity.device_id)).map((entity) => entity.entity_id));
    }
    if (/device_name/i.test(template)) return JSON.stringify(selectedDevices.map((device) => device.name));
    if (/area_name/i.test(template)) return JSON.stringify(selectedDevices.map((device) => this.store.getArea(device.area_id)?.name || ""));
    if (/states/i.test(template) || /state_attr/i.test(template) || /device_id/i.test(template) || /entity_id/i.test(template)) {
      const filtered = labelId ? all.filter((state) => {
        const entity = entities.find((item) => item.entity_id === state.entity_id);
        return entity && (entity.labels.includes(labelId) || this.store.getLabel(labelId)?.name === labelId);
      }) : all;
      return JSON.stringify(filtered.map((state) => ({ ...state, device_id: state.attributes.device_id, area_name: this.store.getArea(state.attributes.area_id)?.name || "" })));
    }
    throw Object.assign(new Error("Template is not supported by Dinodia OS"), { statusCode: 400, code: "unsupported_template" });
  }
}

module.exports = { HomeAssistantModel, slug, inferDomain, deviceHaId, entityHaId, normalizeHaState };
