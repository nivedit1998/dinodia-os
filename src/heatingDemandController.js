const { allProjectedSurfaces } = require("./capabilities/controlSurfaceProjection");

const DEFAULT_HEATING_DEMAND_CONFIG = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  boilerDeviceId: null,
  radiatorDeviceIds: [],
  deadbandCelsius: 0.3,
  evaluationIntervalSeconds: 60,
  stateFreshnessSeconds: 180,
  unknownGraceSeconds: 300,
  requestTemperatureEnabled: true,
  requestTemperatureCelsius: 30,
  commandCooldownSeconds: 30,
});

const DEFAULT_HEATING_DEMAND_RUNTIME = Object.freeze({
  schemaVersion: 1,
  status: "waiting_for_devices",
  lastEvaluationAt: null,
  lastEvaluationDurationMs: 0,
  lastEvaluationError: null,
  currentDemand: "not_configured",
  callingRadiatorIds: [],
  unknownRadiatorIds: [],
  desiredBoilerMode: null,
  observedBoilerMode: null,
  lastCommand: null,
  commandPending: null,
  lastPhysicalActuationVerifiedAt: null,
  consecutiveFailures: 0,
  retryDelaySeconds: 0,
  nextRetryAt: null,
  unknownSince: null,
  readOnlyVerification: null,
  lastEvaluation: null,
  integrations: {},
});

const STATUS_TEXT = Object.freeze({
  linked: "Linked",
  ready_to_control: "Ready to control",
  heating_active: "Heating active",
  no_demand: "No demand",
  command_pending: "Command pending",
  degraded: "Degraded",
  error: "Error",
  waiting_for_devices: "Waiting for devices",
});

const PROTOCOL_KEYS = Object.freeze({
  google_nest: "googleNest",
  hive: "hive",
  zigbee: "zigbee",
  matter: "matter",
  virtual: "virtual",
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function boundedNumber(value, fallback, min, max, step = 0) {
  const result = finite(value);
  if (result === undefined) return fallback;
  const bounded = Math.max(min, Math.min(max, result));
  return step ? Math.round(bounded / step) * step : bounded;
}

function ids(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function labelsFor(device) {
  return ids(device?.labelIds || device?.labels).map((value) => value.toLowerCase());
}

function hasLabel(device, label) {
  return labelsFor(device).includes(String(label).toLowerCase());
}

function ready(device) {
  return Boolean(device && device.infrastructure !== true && String(device.setup?.status || "") === "ready");
}

function climateSurface(device) {
  return allProjectedSurfaces(device || {}).find((surface) =>
    String(surface?.domain || "").toLowerCase() === "climate" &&
    surface?.visibility === "household" &&
    surface?.capability?.readable !== false
  ) || null;
}

function routeAvailable(surface, serviceId) {
  if (!surface) return false;
  if (surface.serviceRoutes && surface.serviceRoutes[serviceId]) return true;
  return Array.isArray(surface.capability?.bindings) &&
    surface.capability.bindings.some((binding) => String(binding.serviceId || "").toLowerCase() === serviceId.toLowerCase());
}

function dateValue(value) {
  const result = Date.parse(String(value || ""));
  return Number.isFinite(result) ? result : null;
}

function verificationCheckPassed(verification, name) {
  return Boolean(verification?.checks?.some((check) => check?.name === name && check?.result === "pass"));
}

function normalizeMode(value) {
  const lower = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (["off", "heat", "heating", "on", "auto", "cool", "dry", "fan_only", "idle", "standby"].includes(lower)) {
    return lower === "heating" ? "heat" : lower;
  }
  return lower || "unknown";
}

function normalizeAction(value) {
  const lower = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  return lower || "unknown";
}

function boolValue(value) {
  if (value === true || value === false) return value;
  const lower = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (["true", "on", "yes", "1", "heat", "heating", "calling"].includes(lower)) return true;
  if (["false", "off", "no", "0", "idle", "satisfied", "none"].includes(lower)) return false;
  return undefined;
}

function serviceIdsForSurface(surface) {
  const result = new Set(Object.keys(surface?.serviceRoutes || {}));
  for (const binding of surface?.capability?.bindings || []) if (binding?.serviceId) result.add(String(binding.serviceId));
  return [...result];
}

function normalizeClimateSnapshot(device, now = Date.now(), freshnessSeconds = 180) {
  const surface = climateSurface(device);
  const attributes = {
    ...(device?.state && typeof device.state === "object" ? device.state : {}),
    ...(surface?.attributes && typeof surface.attributes === "object" ? surface.attributes : {}),
  };
  const mode = normalizeMode(attributes.hvac_mode ?? attributes.system_mode ?? attributes.mode ?? surface?.state);
  const action = normalizeAction(attributes.hvac_action ?? attributes.heating_action ?? attributes.running_state);
  const targetTemperature = finite(attributes.temperature ?? attributes.target_temperature ?? attributes.target_temp);
  const currentTemperature = finite(attributes.current_temperature ?? attributes.current_temp ?? attributes.local_temperature ?? attributes.measured_temperature);
  const heatDemand = boolValue(attributes.heat_demand ?? attributes.heating_demand ?? attributes.calling_for_heat);
  const observedAt = device?.stateUpdatedAt || device?.lastSeenAt || device?.updatedAt || null;
  const observedMs = dateValue(observedAt);
  const ageSeconds = observedMs === null ? Number.POSITIVE_INFINITY : Math.max(0, (Number(now) - observedMs) / 1000);
  const available = device?.available !== false && surface?.available !== false;
  const fresh = available && ageSeconds <= Number(freshnessSeconds || 180);
  return {
    deviceId: String(device?.id || ""),
    name: String(device?.name || device?.id || "Device"),
    protocol: String(device?.protocol || "unknown"),
    areaId: device?.areaId ? String(device.areaId) : null,
    surfaceId: surface?.id || null,
    entityId: surface?.haEntityId || null,
    mode,
    action,
    targetTemperature,
    currentTemperature,
    heatDemand,
    available,
    fresh,
    observedAt,
    ageSeconds,
    range: {
      min: finite(attributes.min_temp ?? attributes.min_temperature ?? surface?.capability?.constraints?.min),
      max: finite(attributes.max_temp ?? attributes.max_temperature ?? surface?.capability?.constraints?.max),
      step: finite(attributes.target_temp_step ?? surface?.capability?.constraints?.step),
    },
    serviceIds: serviceIdsForSurface(surface),
    modeWritable: routeAvailable(surface, "climate.set_hvac_mode"),
    temperatureWritable: routeAvailable(surface, "climate.set_temperature"),
  };
}

function eligibleDevices(devices, label) {
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => hasLabel(device, label) && ready(device) && Boolean(climateSurface(device)))
    .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));
}

function normalizeHeatingDemandConfig(input = {}, devices = []) {
  const value = input && typeof input === "object" ? input : {};
  const boilers = eligibleDevices(devices, "boiler");
  const radiators = eligibleDevices(devices, "radiator");
  const requestedBoiler = String(value.boilerDeviceId || "").trim();
  const requestedRadiators = ids(value.radiatorDeviceIds);
  const config = {
    ...DEFAULT_HEATING_DEMAND_CONFIG,
    schemaVersion: 1,
    enabled: value.enabled === true,
    boilerDeviceId: requestedBoiler || (boilers.length === 1 ? String(boilers[0].id) : null),
    radiatorDeviceIds: requestedRadiators.length ? requestedRadiators : radiators.map((device) => String(device.id)),
    deadbandCelsius: boundedNumber(value.deadbandCelsius, 0.3, 0.1, 2, 0.1),
    evaluationIntervalSeconds: Math.round(boundedNumber(value.evaluationIntervalSeconds, 60, 15, 300)),
    stateFreshnessSeconds: Math.round(boundedNumber(value.stateFreshnessSeconds, 180, 30, 900)),
    unknownGraceSeconds: Math.round(boundedNumber(value.unknownGraceSeconds, 300, 60, 1800)),
    requestTemperatureEnabled: value.requestTemperatureEnabled !== false,
    requestTemperatureCelsius: boundedNumber(value.requestTemperatureCelsius, 30, 5, 35, 0.5),
    commandCooldownSeconds: Math.round(boundedNumber(value.commandCooldownSeconds, 30, 5, 600)),
  };
  const boilerIds = new Set(boilers.map((device) => String(device.id)));
  const radiatorIds = new Set(radiators.map((device) => String(device.id)));
  if (config.boilerDeviceId && !boilerIds.has(config.boilerDeviceId)) {
    throw Object.assign(new Error("Choose a ready device labelled Boiler"), { code: "invalid_boiler_mapping", statusCode: 400 });
  }
  if (config.radiatorDeviceIds.some((id) => !radiatorIds.has(String(id)))) {
    throw Object.assign(new Error("Choose only ready climate devices labelled Radiator"), { code: "invalid_radiator_mapping", statusCode: 400 });
  }
  if (config.enabled && !config.boilerDeviceId) {
    throw Object.assign(new Error(boilers.length > 1 ? "Choose which Boiler device the controller should use" : "Set up one device labelled Boiler first"), { code: boilers.length > 1 ? "multiple_boilers_require_selection" : "boiler_mapping_required", statusCode: 400 });
  }
  if (config.enabled && !config.radiatorDeviceIds.length) {
    throw Object.assign(new Error("Set up at least one device labelled Radiator first"), { code: "radiator_mapping_required", statusCode: 400 });
  }
  return config;
}

function radiatorDemand(snapshot, config) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (!value.available) return { ...clone(value), demand: "unavailable", reason: "device_unavailable", reasonText: "Device is unavailable." };
  if (!value.fresh) return { ...clone(value), demand: "unknown", reason: "state_stale", reasonText: "The latest device state is stale." };
  if (value.mode === "off") return { ...clone(value), demand: "off", reason: "mode_off", reasonText: "Heating mode is off." };
  if (value.heatDemand === true) return { ...clone(value), demand: "calling", reason: "explicit_heat_demand", reasonText: "The device is explicitly calling for heat." };
  if (["heat", "heating"].includes(value.action)) return { ...clone(value), demand: "calling", reason: "hvac_action_heating", reasonText: "The device reports that it is heating." };
  if (Number.isFinite(value.targetTemperature) && Number.isFinite(value.currentTemperature)) {
    const difference = value.targetTemperature - value.currentTemperature;
    if (difference >= Number(config?.deadbandCelsius || 0.3)) return { ...clone(value), demand: "calling", difference, reason: "target_above_current_by_deadband", reasonText: "Target is " + difference.toFixed(1) + "°C above current temperature." };
    return { ...clone(value), demand: "satisfied", difference, reason: "within_deadband", reasonText: "The target is satisfied within the configured deadband." };
  }
  return { ...clone(value), demand: "unknown", reason: "missing_climate_state", reasonText: "Target temperature or current temperature is unavailable." };
}

function evaluateRadiatorDemand(snapshot, config) {
  return radiatorDemand(snapshot, config || DEFAULT_HEATING_DEMAND_CONFIG);
}

function evaluateHeatingDemand({ boiler, radiators, config = DEFAULT_HEATING_DEMAND_CONFIG, now = Date.now(), runtime = {} } = {}) {
  const radiatorResults = (Array.isArray(radiators) ? radiators : []).map((snapshot) => radiatorDemand(snapshot, config));
  const callingRadiatorIds = radiatorResults.filter((item) => item.demand === "calling").map((item) => item.deviceId);
  const unknownRadiatorIds = radiatorResults.filter((item) => ["unknown", "unavailable"].includes(item.demand)).map((item) => item.deviceId);
  const allUnknown = radiatorResults.length > 0 && unknownRadiatorIds.length === radiatorResults.length;
  let desiredBoilerMode = null;
  let demand = "unknown";
  let reason = "radiator_state_unknown";
  if (callingRadiatorIds.length) {
    desiredBoilerMode = "heat";
    demand = "calling";
    reason = "radiator_calling_for_heat";
  } else if (!unknownRadiatorIds.length && radiatorResults.length) {
    desiredBoilerMode = "off";
    demand = "satisfied";
    reason = "no_radiator_calling";
  } else if (!allUnknown) {
    desiredBoilerMode = "off";
    demand = "satisfied";
    reason = "no_known_radiator_calling";
  } else {
    const unknownSince = dateValue(runtime.unknownSince) || Number(now);
    if (Number(now) - unknownSince >= Number(config.unknownGraceSeconds || 300) * 1000) {
      desiredBoilerMode = "off";
      reason = "unknown_grace_expired_fail_off";
    }
  }
  return {
    demand,
    reason,
    radiatorResults,
    callingRadiatorIds,
    unknownRadiatorIds,
    allUnknown,
    desiredBoilerMode,
    desiredBoilerTemperature: desiredBoilerMode === "heat" && config.requestTemperatureEnabled ? Number(config.requestTemperatureCelsius) : null,
    boilerSnapshot: boiler || null,
  };
}

function integrationFor(device, integrations = {}) {
  const key = PROTOCOL_KEYS[String(device?.protocol || "").toLowerCase()] || String(device?.protocol || "");
  return integrations?.[key] || null;
}

function providerHealthy(device, integrations = {}) {
  if (String(device?.protocol || "").toLowerCase() === "virtual") return true;
  const record = integrationFor(device, integrations);
  if (!record) return device?.available !== false;
  if (record.configured === false || record.connected === false || record.reachable === false || record.service?.running === false) return false;
  if (["degraded", "reauth_required", "error", "failed", "disconnected"].includes(String(record.status || "").toLowerCase())) return false;
  return true;
}

function resolveControllerStatus({ config, evaluation, boiler, radiators, integrations = {}, runtime = {}, loopRunning = false, now = Date.now() } = {}) {
  const effective = config || DEFAULT_HEATING_DEMAND_CONFIG;
  if (!effective.boilerDeviceId || !effective.radiatorDeviceIds.length || !boiler || !radiators.length) return { code: "waiting_for_devices", label: STATUS_TEXT.waiting_for_devices, tone: "amber", reason: "boiler_or_radiator_mapping_required" };
  if (!effective.enabled) return { code: "linked", label: STATUS_TEXT.linked, tone: "green", reason: "controller_disabled" };
  if (!loopRunning) return { code: "degraded", label: STATUS_TEXT.degraded, tone: "amber", reason: "controller_loop_not_running" };
  if (!providerHealthy(boiler, integrations) || radiators.some((device) => !providerHealthy(device, integrations))) return { code: "degraded", label: STATUS_TEXT.degraded, tone: "amber", reason: "provider_or_device_unavailable" };
  if (runtime.lastEvaluationError) return { code: "error", label: STATUS_TEXT.error, tone: "red", reason: "evaluation_failed" };
  if (dateValue(runtime.nextRetryAt) !== null && dateValue(runtime.nextRetryAt) > Number(now)) return { code: "degraded", label: STATUS_TEXT.degraded, tone: "amber", reason: "command_retry_backoff" };
  if (runtime.commandPending) return { code: "command_pending", label: STATUS_TEXT.command_pending, tone: "amber", reason: "waiting_for_observed_state" };
  if (evaluation?.demand === "calling") return { code: "heating_active", label: STATUS_TEXT.heating_active, tone: "green", reason: evaluation.reason };
  if (evaluation?.desiredBoilerMode === "off") return { code: "no_demand", label: STATUS_TEXT.no_demand, tone: "green", reason: evaluation.reason };
  return { code: "degraded", label: STATUS_TEXT.degraded, tone: "amber", reason: evaluation?.reason || "radiator_state_unknown" };
}

function commandValidation(surface, serviceId, data) {
  if (!surface || !routeAvailable(surface, serviceId)) return { ok: false, reason: "The boiler does not expose this climate control." };
  if (serviceId === "climate.set_hvac_mode") {
    const mode = String(data?.hvac_mode || "").trim().toLowerCase();
    const modes = Array.isArray(surface.attributes?.hvac_modes) ? surface.attributes.hvac_modes.map((item) => String(item).toLowerCase()) : [];
    if (!["heat", "off"].includes(mode)) return { ok: false, reason: "Only heat and off are permitted." };
    if (modes.length && !modes.includes(mode)) return { ok: false, reason: "The boiler does not advertise " + mode + " mode." };
  }
  if (serviceId === "climate.set_temperature") {
    const value = finite(data?.temperature);
    const min = finite(surface.attributes?.min_temp ?? surface.capability?.constraints?.min) ?? 5;
    const max = finite(surface.attributes?.max_temp ?? surface.capability?.constraints?.max) ?? 35;
    if (value === undefined || value < min || value > max) return { ok: false, reason: "The request temperature must be between " + min + " and " + max + "°C." };
  }
  return { ok: true, reason: "The normalized climate command is available." };
}

function buildReadOnlyVerification({ controllerConfig = {}, devices = [], integrations = {}, commandResolver, now = Date.now() } = {}) {
  let effective;
  try {
    effective = normalizeHeatingDemandConfig(controllerConfig, devices);
  } catch (error) {
    return {
      schemaVersion: 1,
      checkedAt: new Date(now).toISOString(),
      result: "degraded",
      checks: [{ name: "mapping_complete", result: "fail", detail: error.message }],
      writesAttempted: 0,
      physicalActuationVerified: false,
      note: "Read-only verification does not change temperatures or heating modes.",
      validationResults: [],
    };
  }
  const boiler = devices.find((device) => String(device.id) === String(effective.boilerDeviceId)) || null;
  const radiators = effective.radiatorDeviceIds.map((id) => devices.find((device) => String(device.id) === String(id))).filter(Boolean);
  const boilerSurface = climateSurface(boiler);
  const radiatorSnapshots = radiators.map((device) => normalizeClimateSnapshot(device, now, effective.stateFreshnessSeconds));
  const checks = [];
  const add = (name, ok, detail, result = ok ? "pass" : "fail") => checks.push({ name, result, detail });
  add("mapping_complete", Boolean(boiler && radiators.length), boiler && radiators.length ? "One boiler and mapped radiators are selected." : "Select one boiler and at least one radiator.");
  add("boiler_climate_ready", Boolean(boilerSurface && routeAvailable(boilerSurface, "climate.set_hvac_mode")), boilerSurface && routeAvailable(boilerSurface, "climate.set_hvac_mode") ? "The boiler exposes a writable climate mode route." : "The boiler has no writable climate mode route.");
  const allFresh = radiatorSnapshots.length > 0 && radiatorSnapshots.every((item) => item.available && item.fresh);
  add("radiator_state_readable", allFresh, allFresh ? "Mapped radiator states are available and fresh." : "One or more radiator states are unavailable or stale.", allFresh ? "pass" : "warn");
  add("provider_connectivity", Boolean(boiler && providerHealthy(boiler, integrations) && radiators.every((device) => providerHealthy(device, integrations))), "All mapped device providers report healthy read-side connectivity.");
  const validationResults = [];
  if (boilerSurface) {
    const requests = [
      ["climate.set_hvac_mode", { hvac_mode: "heat" }],
      ["climate.set_hvac_mode", { hvac_mode: "off" }],
    ];
    if (effective.requestTemperatureEnabled) requests.push(["climate.set_temperature", { temperature: effective.requestTemperatureCelsius }]);
    for (const [serviceId, data] of requests) {
      const result = commandResolver ? commandResolver({ device: boiler, serviceId, data: clone(data), validateOnly: true }) : commandValidation(boilerSurface, serviceId, data);
      validationResults.push({ serviceId, result: result?.ok === true, detail: result?.reason || "Validation completed." });
    }
  }
  const adapterOK = validationResults.length > 0 && validationResults.every((item) => item.result);
  add("command_adapter_validation", adapterOK, adapterOK ? "Heat, off, and configured request-temperature commands validate in memory." : "One or more normalized commands failed validation.");
  add("command_route_resolution", Boolean(boilerSurface && routeAvailable(boilerSurface, "climate.set_hvac_mode")), "The common climate mode route resolves.");
  return {
    schemaVersion: 1,
    checkedAt: new Date(now).toISOString(),
    result: checks.every((check) => check.result === "pass") ? "ready" : "degraded",
    checks,
    writesAttempted: 0,
    physicalActuationVerified: false,
    note: "Read-only verification does not change temperatures or heating modes.",
    validationResults,
  };
}

function deviceSummary(device) {
  const surface = climateSurface(device);
  return {
    id: String(device.id),
    name: String(device.name || device.id),
    areaId: device.areaId ? String(device.areaId) : null,
    protocol: String(device.protocol || "unknown"),
    available: device.available !== false,
    setupStatus: String(device.setup?.status || ""),
    surfaceId: surface?.id || null,
    entityId: surface?.haEntityId || null,
  };
}

function radiatorSummary(device, runtime) {
  const current = normalizeClimateSnapshot(device, Date.now());
  const previous = runtime?.lastEvaluation?.radiatorResults?.find((item) => item.deviceId === String(device.id));
  return {
    ...deviceSummary(device),
    mode: previous?.mode || current.mode,
    targetTemperature: previous?.targetTemperature ?? current.targetTemperature,
    currentTemperature: previous?.currentTemperature ?? current.currentTemperature,
    demand: previous?.demand || "unknown",
    reason: previous?.reasonText || "Awaiting evaluation.",
    fresh: previous?.fresh ?? current.fresh,
    observedAt: previous?.observedAt || current.observedAt,
  };
}

function summarizeIntegrations(integrations) {
  if (!integrations || typeof integrations !== "object") return {};
  return Object.fromEntries(Object.entries(integrations).filter(([, value]) => value && typeof value === "object").map(([key, value]) => [key, {
    status: value.status || null,
    connected: value.connected === true,
    configured: value.configured !== false,
    reachable: value.reachable !== false,
    serviceRunning: value.service?.running !== false,
  }]));
}

class HeatingDemandController {
  constructor({ store, eventBus, activity, getDevices, getIntegrations, executeAction, commandResolver, logger = console, now = () => Date.now() } = {}) {
    this.store = store;
    this.eventBus = eventBus;
    this.activity = activity;
    this.getDevices = getDevices || (() => []);
    this.getIntegrations = getIntegrations || (() => ({}));
    this.executeAction = executeAction;
    this.commandResolver = commandResolver;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.evaluationInFlight = null;
    this.commandInFlight = null;
    this.lastCommandSignature = null;
    const stored = store?.getHeatingDemandController?.() || {};
    // A command accepted before a process restart cannot be assumed to have
    // been observed by this process. Clear only the transient pending marker;
    // keep the historical command and physical-actuation evidence.
    this.runtime = { ...DEFAULT_HEATING_DEMAND_RUNTIME, ...(stored.runtime || {}), commandPending: null };
  }

  config() {
    return normalizeHeatingDemandConfig(this.store?.getHeatingDemandController?.().config || {}, this.getDevices());
  }

  async syncMappings() {
    const stored = this.store?.getHeatingDemandController?.() || {};
    const current = stored.config || {};
    const devices = this.getDevices();
    const boilerIds = new Set(eligibleDevices(devices, "boiler").map((device) => String(device.id)));
    const radiatorIds = new Set(eligibleDevices(devices, "radiator").map((device) => String(device.id)));
    const nextBoiler = current.boilerDeviceId && boilerIds.has(String(current.boilerDeviceId)) ? String(current.boilerDeviceId) : null;
    const nextRadiators = ids(current.radiatorDeviceIds).filter((id) => radiatorIds.has(id));
    const mappingChanged = nextBoiler !== (current.boilerDeviceId ? String(current.boilerDeviceId) : null) ||
      JSON.stringify(nextRadiators) !== JSON.stringify(ids(current.radiatorDeviceIds));
    const lostMapping = Boolean(current.boilerDeviceId && !nextBoiler) || nextRadiators.length !== ids(current.radiatorDeviceIds).length;
    if ((!mappingChanged && !lostMapping) || !this.store?.saveHeatingDemandControllerConfig) return false;
    await this.store.saveHeatingDemandControllerConfig({
      ...current,
      boilerDeviceId: nextBoiler,
      radiatorDeviceIds: nextRadiators,
      enabled: lostMapping ? false : current.enabled === true,
    });
    this.runtime.commandPending = null;
    this.runtime.lastEvaluationError = lostMapping ? "mapped_device_unavailable" : null;
    await this._saveRuntime({ commandPending: null, lastEvaluationError: this.runtime.lastEvaluationError });
    await this.record("heating_controller_mapping_changed", lostMapping ? "A mapped heating device is no longer eligible; heating demand control was disabled safely." : "Heating controller mappings were refreshed.", { boilerDeviceId: nextBoiler, radiatorCount: nextRadiators.length, disabledForSafety: lostMapping });
    return true;
  }

  status() {
    const devices = this.getDevices();
    let config;
    try {
      config = this.config();
    } catch (error) {
      return {
        schemaVersion: 1,
        config: { ...DEFAULT_HEATING_DEMAND_CONFIG, enabled: false, boilerDeviceId: null, radiatorDeviceIds: [] },
        runtime: clone(this.runtime),
        status: "error",
        statusLabel: STATUS_TEXT.error,
        statusTone: "red",
        statusReason: error.code || "invalid_configuration",
        boiler: null,
        radiators: [],
        candidates: { boilers: eligibleDevices(devices, "boiler").map(deviceSummary), radiators: eligibleDevices(devices, "radiator").map(deviceSummary) },
        verification: clone(this.runtime.readOnlyVerification),
      };
    }
    const boiler = devices.find((device) => String(device.id) === String(config.boilerDeviceId)) || null;
    const radiators = config.radiatorDeviceIds.map((id) => devices.find((device) => String(device.id) === String(id))).filter(Boolean);
    const status = resolveControllerStatus({ config, evaluation: this.runtime.lastEvaluation, boiler, radiators, integrations: this.runtime.integrations, runtime: this.runtime, loopRunning: Boolean(this.timer), now: this.now() });
    const verification = clone(this.runtime.readOnlyVerification);
    return {
      schemaVersion: 1,
      config: clone(config),
      runtime: clone(this.runtime),
      status: status.code,
      statusLabel: status.label,
      statusTone: status.tone,
      statusReason: status.reason,
      boiler: boiler ? { ...deviceSummary(boiler), mode: normalizeClimateSnapshot(boiler, this.now(), config.stateFreshnessSeconds).mode } : null,
      radiators: radiators.map((device) => radiatorSummary(device, this.runtime)),
      candidates: { boilers: eligibleDevices(devices, "boiler").map(deviceSummary), radiators: eligibleDevices(devices, "radiator").map(deviceSummary) },
      verification,
      readOnlyVerificationReady: verification?.result === "ready",
      commandRouteReady: verificationCheckPassed(verification, "command_route_resolution"),
      physicalActuationVerified: Boolean(this.runtime.lastPhysicalActuationVerifiedAt),
      lastRealCommandAccepted: ["accepted", "observed"].includes(String(this.runtime.lastCommand?.result || "")),
    };
  }

  async evaluate({ reason = "scheduled", execute = true } = {}) {
    if (this.evaluationInFlight) return this.evaluationInFlight;
    this.evaluationInFlight = this._evaluate({ reason, execute });
    this.evaluationInFlight.finally(() => { this.evaluationInFlight = null; }).catch(() => {});
    return this.evaluationInFlight;
  }

  async _evaluate({ reason, execute }) {
    const started = this.now();
    try {
      await this.syncMappings();
    } catch (error) {
      await this._saveRuntime({ status: "error", lastEvaluationAt: new Date(this.now()).toISOString(), lastEvaluationError: error.code || error.message, consecutiveFailures: Number(this.runtime.consecutiveFailures || 0) + 1 }).catch(() => {});
      this._emit();
      return this.status();
    }
    const devices = this.getDevices();
    let config;
    try {
      config = this.config();
    } catch (error) {
      await this._saveRuntime({ status: "error", lastEvaluationAt: new Date(this.now()).toISOString(), lastEvaluationError: error.code || error.message, consecutiveFailures: Number(this.runtime.consecutiveFailures || 0) + 1 });
      this._emit();
      return this.status();
    }
    const boilerDevice = devices.find((device) => String(device.id) === String(config.boilerDeviceId)) || null;
    const radiatorDevices = config.radiatorDeviceIds.map((id) => devices.find((device) => String(id) === String(device.id))).filter(Boolean);
    const integrations = await Promise.resolve(this.getIntegrations());
    const boiler = boilerDevice ? normalizeClimateSnapshot(boilerDevice, started, config.stateFreshnessSeconds) : null;
    const radiators = radiatorDevices.map((device) => normalizeClimateSnapshot(device, started, config.stateFreshnessSeconds));
    const evaluation = evaluateHeatingDemand({ boiler, radiators, config, now: started, runtime: this.runtime });
    const previousDemand = this.runtime.currentDemand;
    const previousReason = this.runtime.lastEvaluation?.reason;
    const previousStatus = this.runtime.status;
    const unknownSince = evaluation.allUnknown ? (this.runtime.unknownSince || new Date(started).toISOString()) : null;
    this.runtime = {
      ...this.runtime,
      status: "evaluating",
      lastEvaluationAt: new Date(started).toISOString(),
      lastEvaluationDurationMs: Math.max(0, this.now() - started),
      lastEvaluationError: null,
      currentDemand: evaluation.demand,
      callingRadiatorIds: evaluation.callingRadiatorIds,
      unknownRadiatorIds: evaluation.unknownRadiatorIds,
      desiredBoilerMode: evaluation.desiredBoilerMode,
      observedBoilerMode: boiler?.mode || null,
      unknownSince,
      integrations: summarizeIntegrations(integrations),
      lastEvaluation: evaluation,
    };
    if (previousDemand !== evaluation.demand) await this.record("heating_controller_evaluated", "Heating demand controller evaluated: " + evaluation.demand + ".", { demand: evaluation.demand, reason: evaluation.reason });
    if (previousDemand !== evaluation.demand && previousDemand !== null) await this.record(evaluation.demand === "calling" ? "heating_controller_heat_requested" : "heating_controller_heat_released", evaluation.demand === "calling" ? "A radiator requested boiler heat." : "Radiator heat demand was released.", { demand: evaluation.demand, callingRadiatorCount: evaluation.callingRadiatorIds.length });
    if (evaluation.reason === "unknown_grace_expired_fail_off" && previousReason !== evaluation.reason) await this.record("heating_controller_unknown_fail_off", "Radiator state stayed unknown beyond the safety grace period; the controller will fail off.", { unknownRadiatorIds: evaluation.unknownRadiatorIds }, true);
    if (execute && config.enabled && boilerDevice && evaluation.desiredBoilerMode && providerHealthy(boilerDevice, integrations) && radiatorDevices.every((device) => providerHealthy(device, integrations))) await this.applyDesiredState({ config, boilerDevice, boiler, evaluation });
    const status = resolveControllerStatus({ config, evaluation, boiler: boilerDevice, radiators: radiatorDevices, integrations, runtime: this.runtime, loopRunning: Boolean(this.timer), now: this.now() });
    if (previousStatus !== status.code) {
      const degraded = ["degraded", "error"].includes(status.code);
      const previouslyDegraded = ["degraded", "error"].includes(previousStatus);
      if (degraded) await this.record("heating_controller_degraded", "Heating demand controller health degraded.", { status: status.code, reason: status.reason }, true);
      else if (previouslyDegraded) await this.record("heating_controller_recovered", "Heating demand controller health recovered.", { status: status.code, reason: status.reason });
    }
    await this._saveRuntime({ status: status.code, lastEvaluationDurationMs: Math.max(0, this.now() - started) });
    this._emit();
    void reason;
    return this.status();
  }

  async applyDesiredState({ config, boilerDevice, boiler, evaluation }) {
    if (this.commandInFlight || !this.executeAction) return;
    const modeNeedsCommand = boiler?.mode !== evaluation.desiredBoilerMode;
    const temperatureNeedsCommand = evaluation.desiredBoilerMode === "heat" && config.requestTemperatureEnabled && boiler?.temperatureWritable && (!Number.isFinite(boiler.targetTemperature) || Math.abs(boiler.targetTemperature - config.requestTemperatureCelsius) >= 0.1);
    const signature = String(evaluation.desiredBoilerMode) + ":" + (temperatureNeedsCommand ? String(config.requestTemperatureCelsius) : "");
    const nextRetryAt = dateValue(this.runtime.nextRetryAt);
    if (nextRetryAt !== null && nextRetryAt > Number(this.now())) return;
    if (this.runtime.commandPending) {
      if (!modeNeedsCommand && !temperatureNeedsCommand && boiler?.mode === this.runtime.commandPending.desiredMode) await this.markObserved(boiler);
      return;
    }
    const lastCommandAt = dateValue(this.runtime.lastCommand?.at);
    const lastCommandAccepted = ["accepted", "observed"].includes(String(this.runtime.lastCommand?.result || ""));
    if (lastCommandAccepted && this.lastCommandSignature === signature && lastCommandAt && this.now() - lastCommandAt < config.commandCooldownSeconds * 1000) return;
    if (!modeNeedsCommand && !temperatureNeedsCommand) {
      this.runtime.consecutiveFailures = 0;
      this.runtime.retryDelaySeconds = 0;
      this.runtime.nextRetryAt = null;
      if (this.runtime.commandPending && boiler?.mode === this.runtime.commandPending.desiredMode) await this.markObserved(boiler);
      return;
    }
    const actions = [];
    if (modeNeedsCommand) actions.push({ serviceId: "climate.set_hvac_mode", data: { hvac_mode: evaluation.desiredBoilerMode }, desired: evaluation.desiredBoilerMode });
    if (temperatureNeedsCommand) actions.push({ serviceId: "climate.set_temperature", data: { temperature: config.requestTemperatureCelsius }, desired: config.requestTemperatureCelsius });
    this.commandInFlight = (async () => {
      for (const action of actions) {
        try {
          await this.executeAction({ deviceId: boilerDevice.id, serviceId: action.serviceId, data: action.data });
          this.lastCommandSignature = signature;
          const at = new Date(this.now()).toISOString();
          this.runtime.lastCommand = { at, serviceId: action.serviceId, desired: action.desired, result: "accepted", observedAt: null };
          this.runtime.commandPending = { at, serviceId: action.serviceId, desiredMode: evaluation.desiredBoilerMode, desiredTemperature: evaluation.desiredBoilerTemperature };
          this.runtime.consecutiveFailures = 0;
          this.runtime.retryDelaySeconds = 0;
          this.runtime.nextRetryAt = null;
          await this.record("heating_controller_command_pending", "Heating controller command accepted; waiting for observed state.", { serviceId: action.serviceId });
        } catch (error) {
          this.runtime.consecutiveFailures = Number(this.runtime.consecutiveFailures || 0) + 1;
          this.runtime.retryDelaySeconds = Math.min(300, Math.max(15, 15 * (2 ** Math.min(this.runtime.consecutiveFailures - 1, 4))));
          this.runtime.nextRetryAt = new Date(Number(this.now()) + this.runtime.retryDelaySeconds * 1000).toISOString();
          this.runtime.lastEvaluationError = error.code || error.message;
          this.runtime.lastCommand = { ...(this.runtime.lastCommand || {}), at: new Date(this.now()).toISOString(), serviceId: action.serviceId, desired: action.desired, result: "failed", observedAt: null };
          this.runtime.commandPending = null;
          await this.record("heating_controller_command_failed", "Heating controller could not apply the boiler command.", { serviceId: action.serviceId, code: error.code || "command_failed" }, true);
          break;
        }
      }
      await this._saveRuntime({ status: "command_pending" });
      this._emit();
    })();
    try { await this.commandInFlight; } finally { this.commandInFlight = null; }
  }

  async reconcileDeviceChange(device, previous) {
    void device;
    void previous;
    await this.syncMappings();
    return this.evaluate({ reason: "device_changed", execute: true });
  }

  async configure(input = {}) {
    const before = this.store?.getHeatingDemandController?.().config || DEFAULT_HEATING_DEMAND_CONFIG;
    const config = normalizeHeatingDemandConfig({ ...before, ...(input && typeof input === "object" ? input : {}) }, this.getDevices());
    await this.store.saveHeatingDemandControllerConfig(config);
    if (before.enabled !== config.enabled || before.boilerDeviceId !== config.boilerDeviceId || JSON.stringify(before.radiatorDeviceIds || []) !== JSON.stringify(config.radiatorDeviceIds || [])) {
      this.runtime.commandPending = null;
      this.runtime.lastEvaluationError = null;
      this.runtime.lastPhysicalActuationVerifiedAt = null;
      this.runtime.retryDelaySeconds = 0;
      this.runtime.nextRetryAt = null;
      await this._saveRuntime({ commandPending: null, lastEvaluationError: null, lastPhysicalActuationVerifiedAt: null, retryDelaySeconds: 0, nextRetryAt: null });
    }
    await this.record(config.enabled ? "heating_controller_enabled" : "heating_controller_disabled", config.enabled ? "Heating demand control was enabled." : "Heating demand control was disabled.", { boilerDeviceId: config.boilerDeviceId, radiatorCount: config.radiatorDeviceIds.length });
    await this.evaluate({ reason: "configuration_changed", execute: false });
    if (config.enabled) await this.evaluate({ reason: "controller_enabled", execute: true });
    return this.status();
  }

  async verifyReadOnly() {
    const devices = this.getDevices();
    const integrations = await Promise.resolve(this.getIntegrations());
    let verification;
    try {
      verification = buildReadOnlyVerification({ controllerConfig: this.store?.getHeatingDemandController?.().config || {}, devices, integrations, commandResolver: this.commandResolver, now: this.now() });
      const loopCheck = { name: "runtime_loop", result: this.timer ? "pass" : "fail", detail: this.timer ? "The controller evaluation loop is running." : "The controller evaluation loop is not running." };
      verification.checks.push(loopCheck);
      verification.result = verification.checks.every((check) => check.result === "pass") ? "ready" : "degraded";
      verification.physicalActuationVerified = Boolean(this.runtime.lastPhysicalActuationVerifiedAt);
      verification.writesAttempted = 0;
      await this._saveRuntime({ readOnlyVerification: verification });
      await this.record("heating_controller_verification_completed", "Read-only heating controller verification completed.", { result: verification.result, writesAttempted: 0 });
    } catch (error) {
      verification = { schemaVersion: 1, checkedAt: new Date(this.now()).toISOString(), result: "error", checks: [{ name: "verification", result: "fail", detail: error.message }], writesAttempted: 0, physicalActuationVerified: Boolean(this.runtime.lastPhysicalActuationVerifiedAt), note: "Read-only verification does not change temperatures or heating modes." };
      await this._saveRuntime({ readOnlyVerification: verification });
    }
    this._emit();
    return verification;
  }

  async start() {
    if (this.timer) return;
    await this._saveRuntime({ commandPending: null });
    let intervalSeconds = DEFAULT_HEATING_DEMAND_CONFIG.evaluationIntervalSeconds;
    try { intervalSeconds = this.config().evaluationIntervalSeconds || intervalSeconds; } catch (error) { this.logger.warn?.("[heating-controller] using default evaluation interval: " + error.message); }
    this.timer = setInterval(() => this.evaluate({ reason: "scheduled", execute: true }).catch((error) => this.logger.error("[heating-controller] " + error.message)), Number(intervalSeconds) * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async markObserved(boiler) {
    if (!this.runtime.commandPending || boiler?.mode !== this.runtime.commandPending.desiredMode) return;
    const wantedTemperature = this.runtime.commandPending.desiredTemperature;
    if (wantedTemperature !== null && wantedTemperature !== undefined && Number.isFinite(boiler.targetTemperature) && Math.abs(boiler.targetTemperature - Number(wantedTemperature)) >= 0.1) return;
    const observedAt = new Date(this.now()).toISOString();
    this.runtime.lastCommand = { ...(this.runtime.lastCommand || {}), observedAt, result: "observed" };
    this.runtime.lastPhysicalActuationVerifiedAt = observedAt;
    this.runtime.commandPending = null;
    await this.record("heating_controller_command_succeeded", "The boiler state matched the requested heating mode.", { observedAt });
    await this._saveRuntime({ status: "ready_to_control" });
  }

  async _saveRuntime(patch) {
    this.runtime = { ...this.runtime, ...clone(patch) };
    if (this.store?.saveHeatingDemandControllerRuntime) await this.store.saveHeatingDemandControllerRuntime(this.runtime);
  }

  async record(type, detail, change = {}, reportable = false) {
    if (!this.activity?.record) return;
    await this.activity.record({
      type,
      detail,
      change,
      reportable,
      incident: reportable ? { incidentId: type + ":" + (this.runtime.lastEvaluationAt || this.now()), kind: type, state: "open", revision: 1, details: change } : undefined,
    }).catch((error) => this.logger.error("[heating-controller] activity: " + error.message));
  }

  _emit() {
    this.eventBus?.emit("dinodia_dashboard_updated", { kind: "heating_demand_controller", at: new Date(this.now()).toISOString() });
  }
}

module.exports = {
  DEFAULT_HEATING_DEMAND_CONFIG,
  DEFAULT_HEATING_DEMAND_RUNTIME,
  HeatingDemandController,
  buildReadOnlyVerification,
  evaluateHeatingDemand,
  evaluateRadiatorDemand,
  normalizeClimateSnapshot,
  normalizeHeatingDemandConfig,
  resolveControllerStatus,
  climateSurface,
  commandValidation,
};
