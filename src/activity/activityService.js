const crypto = require("node:crypto");

const OFFLINE_INCIDENT_THRESHOLD_MS = 60 * 60 * 1000;
// A short outage is normal operational noise. Keep recording it locally, but
// do not promote it to a critical incident or send it to the company portal
// until it has lasted for at least one hour.
const OFFLINE_THRESHOLDS_MS = {
  mains: OFFLINE_INCIDENT_THRESHOLD_MS,
  battery: OFFLINE_INCIDENT_THRESHOLD_MS,
  integration: OFFLINE_INCIDENT_THRESHOLD_MS,
};
const STARTUP_WARMUP_MS = 90 * 1000;
const RECOVERY_STABLE_MS = 2 * 60 * 1000;

const INTEGRATION_NAMES = Object.freeze({
  zigbee2mqtt: "Zigbee services",
  zigbee: "Zigbee services",
  matter: "Matter services",
  thread: "Thread services",
  otbr: "Thread Border Router services",
  cloudflare: "Secure access services",
  hive: "Hive services",
  google_nest: "Google Nest services",
  platform: "Dinodia platform services",
  ethernet: "Ethernet services",
});

const TYPE_META = {
  hub_started: { category: "system", severity: "system", statusLabel: "system", summary: "Dinodia OS started" },
  device_discovered: { category: "device", severity: "info", statusLabel: "info", summary: "Device discovered" },
  device_state_changed: { category: "state", severity: "info", statusLabel: "info", summary: "Device state changed" },
  device_available: { category: "availability", severity: "info", statusLabel: "success", summary: "Device back online" },
  device_unavailable: { category: "availability", severity: "warning", statusLabel: "warning", summary: "Device became unavailable" },
  device_offline_incident: { category: "availability", severity: "critical", statusLabel: "critical", summary: "Device has stayed offline" },
  device_unpair_requested: { category: "device", severity: "warning", statusLabel: "warning", summary: "Removing device" },
  device_recovered: { category: "availability", severity: "info", statusLabel: "success", summary: "Device recovered" },
  device_unpaired: { category: "device", severity: "critical", statusLabel: "critical", summary: "Device removed from the hub" },
  device_remove_failed: { category: "device", severity: "critical", statusLabel: "critical", summary: "Device removal failed" },
  device_renamed: { category: "configuration", severity: "info", statusLabel: "info", summary: "Device renamed" },
  device_configuration_changed: { category: "configuration", severity: "info", statusLabel: "info", summary: "Device configuration changed" },
  device_area_assigned: { category: "configuration", severity: "info", statusLabel: "info", summary: "Device area changed" },
  device_label_assigned: { category: "configuration", severity: "info", statusLabel: "info", summary: "Device label changed" },
  device_label_removed: { category: "configuration", severity: "info", statusLabel: "info", summary: "Device label removed" },
  device_setup_completed: { category: "configuration", severity: "info", statusLabel: "success", summary: "Device setup completed" },
  command_failed: { category: "state", severity: "warning", statusLabel: "warning", summary: "Device command failed" },
  automation_succeeded: { category: "automation", severity: "info", statusLabel: "success", summary: "Automation completed" },
  automation_partial: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation partially completed" },
  automation_failed: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation failed" },
  automation_interrupted: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation interrupted" },
  automation_created: { category: "automation", severity: "info", statusLabel: "success", summary: "Automation created" },
  automation_updated: { category: "automation", severity: "info", statusLabel: "info", summary: "Automation updated" },
  automation_enabled: { category: "automation", severity: "info", statusLabel: "success", summary: "Automation enabled" },
  automation_disabled: { category: "automation", severity: "info", statusLabel: "info", summary: "Automation disabled" },
  automation_deleted: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation deleted" },
  automation_suspended: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation needs attention" },
  automation_recovered: { category: "automation", severity: "info", statusLabel: "success", summary: "Automation recovered" },
  automation_execution_started: { category: "automation", severity: "info", statusLabel: "info", summary: "Automation started" },
  automation_execution_succeeded: { category: "automation", severity: "info", statusLabel: "success", summary: "Automation completed" },
  automation_execution_partial: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation partially completed" },
  automation_execution_failed: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation failed" },
  automation_execution_interrupted: { category: "automation", severity: "warning", statusLabel: "warning", summary: "Automation interrupted" },
  battery_low: { category: "availability", severity: "warning", statusLabel: "warning", summary: "Device battery is low" },
  battery_critical: { category: "availability", severity: "critical", statusLabel: "critical", summary: "Device battery is critical" },
  battery_recovered: { category: "availability", severity: "info", statusLabel: "success", summary: "Device battery recovered" },
  entity_configuration_changed: { category: "configuration", severity: "info", statusLabel: "info", summary: "Entity configuration changed" },
  entity_removed: { category: "configuration", severity: "warning", statusLabel: "warning", summary: "Entity removed" },
  area_created: { category: "configuration", severity: "info", statusLabel: "success", summary: "Area created" },
  area_renamed: { category: "configuration", severity: "info", statusLabel: "info", summary: "Area renamed" },
  area_removed: { category: "configuration", severity: "warning", statusLabel: "warning", summary: "Area removed" },
  radio_connected: { category: "network", severity: "info", statusLabel: "success", summary: "Radio connected" },
  radio_disconnected: { category: "network", severity: "warning", statusLabel: "warning", summary: "Radio disconnected" },
  pairing_started: { category: "pairing", severity: "info", statusLabel: "info", summary: "Pairing started" },
  pairing_completed: { category: "pairing", severity: "info", statusLabel: "success", summary: "Pairing completed" },
  pairing_failed: { category: "pairing", severity: "critical", statusLabel: "critical", summary: "Pairing failed" },
  backup_created: { category: "system", severity: "info", statusLabel: "system", summary: "Backup created" },
  backup_failed: { category: "system", severity: "critical", statusLabel: "critical", summary: "Backup failed" },
  integration_offline: { category: "network", severity: "critical", statusLabel: "critical", summary: "Integration has stayed offline" },
  integration_unavailable: { category: "network", severity: "warning", statusLabel: "warning", summary: "Integration became unavailable" },
  integration_recovered: { category: "network", severity: "info", statusLabel: "success", summary: "Integration recovered" },
  offline_incident_reclassified: { category: "availability", severity: "info", statusLabel: "info", summary: "Short outage not escalated" },
  hive_account_connect_started: { category: "pairing", severity: "info", statusLabel: "info", summary: "Hive account connection started" },
  hive_mfa_required: { category: "pairing", severity: "info", statusLabel: "info", summary: "Hive verification required" },
  hive_account_connect_failed: { category: "pairing", severity: "warning", statusLabel: "warning", summary: "Hive account connection failed" },
  hive_account_mfa_failed: { category: "pairing", severity: "warning", statusLabel: "warning", summary: "Hive verification failed" },
  hive_account_reauth_required: { category: "pairing", severity: "warning", statusLabel: "warning", summary: "Hive reauthentication required" },
  hive_account_connected: { category: "pairing", severity: "success", statusLabel: "success", summary: "Hive account connected" },
  hive_account_reauthenticated: { category: "pairing", severity: "success", statusLabel: "success", summary: "Hive account reauthenticated" },
  hive_account_disconnected: { category: "pairing", severity: "info", statusLabel: "info", summary: "Hive account disconnected" },
  hive_discovery_completed: { category: "pairing", severity: "success", statusLabel: "success", summary: "Hive devices refreshed" },
  hive_device_discovered: { category: "device", severity: "info", statusLabel: "info", summary: "Hive device discovered" },
  hive_device_ignored: { category: "device", severity: "warning", statusLabel: "warning", summary: "Hive device removed" },
  hive_command_succeeded: { category: "state", severity: "success", statusLabel: "success", summary: "Hive command completed" },
  hive_command_failed: { category: "state", severity: "warning", statusLabel: "warning", summary: "Hive command failed" },
  hive_integration_unavailable: { category: "network", severity: "warning", statusLabel: "warning", summary: "Hive cloud unavailable" },
  hive_integration_recovered: { category: "network", severity: "info", statusLabel: "success", summary: "Hive cloud recovered" },
  google_nest_authorization_started: { category: "pairing", severity: "info", statusLabel: "info", summary: "Google Nest authorization started" },
  google_nest_authorization_cancelled: { category: "pairing", severity: "info", statusLabel: "info", summary: "Google Nest authorization cancelled" },
  google_nest_authorization_failed: { category: "pairing", severity: "warning", statusLabel: "warning", summary: "Google Nest authorization failed" },
  google_nest_account_connected: { category: "pairing", severity: "success", statusLabel: "success", summary: "Google Nest account connected" },
  google_nest_account_reauth_required: { category: "pairing", severity: "warning", statusLabel: "warning", summary: "Google Nest reauthentication required" },
  google_nest_account_reauthenticated: { category: "pairing", severity: "success", statusLabel: "success", summary: "Google Nest account reauthenticated" },
  google_nest_account_disconnected: { category: "pairing", severity: "info", statusLabel: "info", summary: "Google Nest account disconnected" },
  google_nest_discovery_completed: { category: "pairing", severity: "success", statusLabel: "success", summary: "Google Nest thermostats refreshed" },
  google_nest_device_discovered: { category: "device", severity: "info", statusLabel: "info", summary: "Google Nest thermostat discovered" },
  google_nest_device_ignored: { category: "device", severity: "warning", statusLabel: "warning", summary: "Google Nest thermostat removed" },
  google_nest_command_succeeded: { category: "state", severity: "success", statusLabel: "success", summary: "Google Nest command completed" },
  google_nest_command_failed: { category: "state", severity: "warning", statusLabel: "warning", summary: "Google Nest command failed" },
  google_nest_integration_unavailable: { category: "network", severity: "warning", statusLabel: "warning", summary: "Google Nest cloud unavailable" },
  google_nest_integration_recovered: { category: "network", severity: "info", statusLabel: "success", summary: "Google Nest cloud recovered" },
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function normalizedKey(value) {
  return text(value, "integration").toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function integrationName(value) {
  const key = normalizedKey(value);
  if (INTEGRATION_NAMES[key]) return INTEGRATION_NAMES[key];
  const words = key.split("_").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return `${words.join(" ") || "Integration"} services`;
}

function protocolName(value) {
  const key = normalizedKey(value);
  if (key === "zigbee2mqtt" || key === "zigbee") return "Zigbee";
  if (key === "matter") return "Matter";
  if (key === "thread" || key === "otbr") return "Thread";
  if (key === "google_nest") return "Google Nest";
  if (key === "hive") return "Hive";
  return text(value, "smart home");
}

function elapsedDuration(firstObservedAt, lastObservedAt) {
  const first = Date.parse(firstObservedAt || "");
  const last = Date.parse(lastObservedAt || "");
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return "an extended period";
  const minutes = Math.max(1, Math.floor((last - first) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}${remainingMinutes ? ` ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days} day${days === 1 ? "" : "s"}${remainingHours ? ` ${remainingHours} hour${remainingHours === 1 ? "" : "s"}` : ""}`;
}

function incidentIntegration(input = {}) {
  return text(input.integration || input.change?.integration || input.incident?.details?.integration || "integration");
}

function friendlyEventCopy(type, input = {}, device = null, occurredAt = new Date().toISOString()) {
  const name = text(device?.name, "This device");
  const integration = incidentIntegration(input);
  const service = integrationName(integration);
  const firstObservedAt = input.incident?.firstObservedAt || input.firstObservedAt || occurredAt;
  const lastObservedAt = input.incident?.lastObservedAt || input.lastObservedAt || occurredAt;
  const duration = elapsedDuration(firstObservedAt, lastObservedAt);
  if (type === "integration_offline") return {
    summary: `${service} have been offline for over ${duration}`,
    detail: `${service} have been offline for over ${duration}. Dinodia OS is reporting this because the service has not recovered.`,
  };
  if (type === "integration_unavailable") return {
    summary: `${service} are currently unavailable`,
    detail: `${service} are currently unavailable. Dinodia OS will keep checking and will report when they recover.`,
  };
  if (type === "integration_recovered") return {
    summary: `${service} are back online`,
    detail: `${service} are back online and Dinodia OS can communicate with them again.`,
  };
  if (type === "offline_incident_reclassified") {
    const subject = input.integration ? service : name;
    return {
      summary: `${subject} outage was shorter than the one-hour alert threshold`,
      detail: `${subject} was unavailable, but the outage did not last one hour, so Dinodia OS did not keep it as a critical incident.`,
    };
  }
  if (type === "device_offline_incident") return {
    summary: `${name} has been offline for over ${duration}`,
    detail: `${name} has been offline for over ${duration}. Check that it has power and can reach the ${protocolName(device?.protocol)} network.`,
  };
  if (type === "device_unpaired") return {
    summary: "Device removed from Dinodia OS",
    detail: `${name} was removed from Dinodia OS and will no longer be available for control.`,
  };
  if (type === "device_remove_failed") return {
    summary: "Could not remove device",
    detail: `Dinodia OS could not completely remove ${name}. Try removing it again from Devices & entities.`,
  };
  if (type === "battery_critical") {
    const battery = Number(device?.battery);
    return {
      summary: "Battery needs replacing",
      detail: `${name} has a critically low battery${Number.isFinite(battery) ? ` (${battery}%)` : ""}. Replace the battery soon.`,
    };
  }
  if (type === "pairing_failed") {
    const protocol = protocolName(input.change?.protocol || input.protocol);
    return {
      summary: `Could not add ${protocol} device`,
      detail: `Dinodia OS could not add this ${protocol} device. Check that it is powered on and try pairing again.`,
    };
  }
  return null;
}

function safeScalar(value) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  return text(value).slice(0, 256);
}

function sanitize(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return undefined;
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    if (/token|secret|password|credential|dataset|fabric|private.?key|access.?key/i.test(key)) continue;
    const safe = sanitize(child, depth + 1);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function listChangedValues(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  return keys.filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).slice(0, 12).map((key) => ({
    field: key,
    before: sanitize(before?.[key]),
    after: sanitize(after?.[key]),
  }));
}

function isMaterialStateKey(value) {
  const key = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!key || ["temperature", "humidity", "voltage", "current", "energy", "power_consumption", "linkquality", "link_quality", "rssi", "illuminance", "pressure", "battery"].includes(key)) return false;
  return ["state", "power", "switch", "mode", "hvac", "hvac_mode", "target_temperature", "target_temp", "setpoint", "position", "brightness", "level", "lock", "locked", "unlock", "contact", "open", "closed", "fan_mode", "preset", "volume", "speed"].some((name) => key === name || key.endsWith(`_${name}`));
}

function hasBattery(device) {
  const metadata = device?.metadata || {};
  const powerSource = text(metadata.power_source || metadata.powerSource || device?.powerSource).toLowerCase();
  const batteryValue = metadata.battery ?? device?.battery;
  return powerSource.includes("battery") || (batteryValue !== null && batteryValue !== undefined && Number.isFinite(Number(batteryValue)));
}

class ActivityService {
  constructor({ store, eventBus, logger = console, now = () => new Date(), incidentThresholds = {}, startupWarmupMs = STARTUP_WARMUP_MS, recoveryStableMs = RECOVERY_STABLE_MS } = {}) {
    this.store = store;
    this.eventBus = eventBus;
    this.logger = logger;
    this.now = now;
    this.thresholds = { ...OFFLINE_THRESHOLDS_MS, ...incidentThresholds };
    const configuredRecoveryStableMs = Number(recoveryStableMs);
    this.recoveryStableMs = Number.isFinite(configuredRecoveryStableMs) ? Math.max(0, configuredRecoveryStableMs) : RECOVERY_STABLE_MS;
    this.startupWarmupMs = Math.max(0, Number(startupWarmupMs) || 0);
    this.startedAt = this.now().getTime();
    this.timer = null;
  }

  start(intervalMs = 30000) {
    if (this.timer) return;
    this.startedAt = this.now().getTime();
    this.timer = setInterval(() => this.sweep().catch((error) => this.logger.error(`[activity] ${error.message}`)), Math.max(5000, Number(intervalMs) || 30000));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  metadata(type, input = {}) {
    const known = TYPE_META[type] || { category: "system", severity: "info", statusLabel: "system", summary: text(type, "Hub activity") };
    const severity = ["success", "info", "warning", "critical", "system"].includes(text(input.severity).toLowerCase()) ? text(input.severity).toLowerCase() : known.severity;
    const statusLabel = ["success", "info", "warning", "critical", "system"].includes(text(input.statusLabel).toLowerCase()) ? text(input.statusLabel).toLowerCase() : (severity === "critical" ? "critical" : severity === "warning" ? "warning" : known.statusLabel);
    return { ...known, ...input, type, category: text(input.category, known.category), severity, statusLabel, summary: text(input.summary, known.summary) };
  }

  deviceSnapshot(device, fallback = {}) {
    const source = device && typeof device === "object" ? device : fallback;
    const id = text(source.id || source.deviceId || fallback.id);
    if (!id) return null;
    const areaId = source.areaId || source.area_id || fallback.areaId || null;
    const area = areaId && this.store?.getArea ? this.store.getArea(String(areaId)) : null;
    const labelIds = Array.isArray(source.labelIds) ? source.labelIds : Array.isArray(source.labels) ? source.labels : (fallback.labelIds || []);
    const labels = labelIds.map((labelId) => this.store?.getLabel ? (this.store.getLabel(String(labelId))?.name || String(labelId)) : String(labelId)).filter(Boolean);
    const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
    return {
      id,
      name: text(source.name, text(metadata.friendly_name || metadata.friendlyName, id)),
      protocol: text(source.protocol, text(fallback.protocol, "unknown")),
      model: text(source.definition?.model || metadata.model || metadata.model_id || metadata.product, "") || null,
      manufacturer: text(metadata.manufacturer || metadata.manufacturer_name || metadata.vendor, "") || null,
      areaId: areaId ? String(areaId) : null,
      areaName: area?.name || fallback.areaName || null,
      labels: [...new Set(labels)],
      battery: Number.isFinite(Number(source.state?.battery ?? source.battery ?? metadata.battery)) ? Math.max(0, Math.min(100, Number(source.state?.battery ?? source.battery ?? metadata.battery))) : null,
      available: source.available !== false,
    };
  }

  async record(input = {}) {
    const type = text(input.type, "hub_event");
    const meta = this.metadata(type, input);
    const device = input.device || (input.deviceId ? this.deviceSnapshot({ id: input.deviceId, protocol: input.protocol }) : null);
    const occurredAt = input.occurredAt || this.now().toISOString();
    const friendly = friendlyEventCopy(type, input, device, occurredAt);
    const summary = friendly?.summary || meta.summary;
    const detail = friendly?.detail || text(input.detail, "");
    const dedupeKey = text(input.dedupeKey, `${type}:${device?.id || "hub"}:${summary}`);
    const recent = this.store?.getActivityState?.().records?.find((record) => record.dedupeKey === dedupeKey && Date.parse(record.occurredAt) >= Date.parse(occurredAt) - 2000);
    const record = {
      schemaVersion: 1,
      id: String(input.id || crypto.randomUUID()),
      occurredAt,
      updatedAt: occurredAt,
      type,
      category: meta.category,
      severity: meta.severity,
      statusLabel: meta.statusLabel,
      summary,
      detail,
      source: text(input.source, "dinodia_os"),
      actor: text(input.actor, "system"),
      device: device ? sanitize(device) : null,
      deviceId: device?.id || text(input.deviceId, "") || null,
      area: input.area ? sanitize(input.area) : device?.areaName ? { name: device.areaName, id: device.areaId } : null,
      change: input.change ? sanitize(input.change) : null,
      occurrences: Math.max(1, Number(input.occurrences) || 1),
      dedupeKey,
      reportable: Boolean(input.reportable),
      incident: input.incident ? sanitize(input.incident) : null,
    };
    if (recent) {
      if (!input.coalesceKey || !this.store?.updateActivity) return recent;
      const saved = await this.store.updateActivity(recent.id, { ...record, occurrences: Number(recent.occurrences || 1) + 1 });
      this.eventBus?.emit("dinodia_activity_created", saved);
      return saved;
    }
    const incidentEnvelope = input.reportable && input.incident && (record.severity === "critical" || text(input.incident.state).toLowerCase() === "resolved") ? this.incidentEnvelope(record, input.incident) : null;
    const saved = await this.store.appendActivity(record, incidentEnvelope);
    this.eventBus?.emit("dinodia_activity_created", saved);
    return saved;
  }

  incidentEnvelope(record, incident) {
    const incidentId = text(incident.incidentId, `${text(incident.kind, record.type)}:${record.device?.id || "hub"}`);
    const revision = Math.max(1, Number(incident.revision) || 1);
    return {
      schemaVersion: 1,
      id: `${incidentId}:${revision}`,
      incidentId,
      revision,
      kind: text(incident.kind, record.type),
      state: text(incident.state, "open"),
      // The platform contract keeps resolved incidents at critical severity
      // so a previously-open portal incident can be closed safely.
      severity: text(incident.state).toLowerCase() === "resolved" ? "critical" : record.severity,
      summary: record.summary,
      detail: record.detail || null,
      occurredAt: record.occurredAt,
      firstObservedAt: incident.firstObservedAt || record.occurredAt,
      lastObservedAt: incident.lastObservedAt || record.occurredAt,
      resolvedAt: incident.resolvedAt || null,
      source: "dinodia_os",
      device: record.device || null,
      area: record.area || null,
      change: record.change || null,
      details: sanitize(incident.details || {}),
    };
  }

  async recordDeviceChanged(device, previous = null) {
    const current = this.deviceSnapshot(device);
    if (!current) return null;
    const before = previous ? this.deviceSnapshot(previous) : null;
    if (!before) await this.record({ type: "device_discovered", device: current, detail: `${current.protocol} device is ready for assignment.` });
    const configurationChanges = [];
    if (before && before.name !== current.name) configurationChanges.push({ field: "name", before: before.name, after: current.name });
    if (before && before.areaId !== current.areaId) configurationChanges.push({ field: "area", before: before.areaName, after: current.areaName });
    if (before && JSON.stringify(before.labels) !== JSON.stringify(current.labels)) {
      configurationChanges.push({ field: "labels", before: before.labels, after: current.labels });
    }
    if (configurationChanges.length) await this.record({ type: "device_configuration_changed", device: current, change: { fields: configurationChanges }, detail: configurationChanges.map((change) => `${change.field}: ${change.before ?? "—"} → ${change.after ?? "—"}`).join(" · ") });
    if (before && before.battery !== current.battery && current.battery !== null) await this.observeBattery(current, before.battery);
    const offlineIncident = this.store.getActiveIncident(`device_offline:${current.id}`);
    if (current.available && offlineIncident) {
      await this.incidentMonitorRecovery(current);
    } else if (!current.available) {
      await this.observeUnavailable(current);
    }
    const stateChanges = listChangedValues(previous?.state || {}, device?.state || {}).filter((change) => isMaterialStateKey(change.field));
    const entityChanges = [];
    for (const [entityId, entity] of Object.entries(device?.entities || {})) {
      const previousEntity = previous?.entities?.[entityId];
      if (previousEntity && JSON.stringify(previousEntity.state) !== JSON.stringify(entity?.state) && (entity?.capability?.writable === true || isMaterialStateKey(entity?.stateKey || entity?.name || entityId))) entityChanges.push({ entityId, before: sanitize(previousEntity.state), after: sanitize(entity?.state) });
    }
    if (stateChanges.length || entityChanges.length) {
      await this.record({ type: "device_state_changed", device: current, detail: "A device or entity state changed.", change: { device: stateChanges, entities: entityChanges.slice(0, 12) }, dedupeKey: `state:${current.id}`, coalesceKey: `state:${current.id}` });
    }
    return current;
  }

  async observeUnavailable(device, now = this.now()) {
    const deviceId = text(device?.id);
    if (!deviceId) return;
    const incidentId = `device_offline:${deviceId}`;
    const existing = this.store.getActiveIncident(incidentId);
    if (!existing) {
      const firstObservedAt = now.toISOString();
      const powerClass = hasBattery(device) ? "battery" : "mains";
      await this.store.saveActiveIncident(incidentId, { incidentId, kind: "device_offline", state: "watching", revision: 0, firstObservedAt, lastObservedAt: firstObservedAt, criticalAt: this.offlineCriticalAt(firstObservedAt, { kind: "device_offline", powerClass }), device: this.deviceSnapshot(device), powerClass });
      await this.record({ type: "device_unavailable", device: this.deviceSnapshot(device), detail: "The hub has noticed that this device is unavailable. It will be reported if it remains offline.", dedupeKey: `unavailable:${deviceId}` });
      return;
    }
    if (await this.reclassifyPrematureOfflineIncident(incidentId, existing, now)) return;
    const criticalAt = this.offlineCriticalAt(existing.firstObservedAt, existing);
    await this.store.saveActiveIncident(incidentId, { ...existing, state: existing.state === "recovering" ? "open" : existing.state, recoveredAt: null, lastObservedAt: now.toISOString(), criticalAt: criticalAt || existing.criticalAt, device: this.deviceSnapshot(device) });
  }

  async observeBattery(device, previousBattery, now = this.now()) {
    const deviceId = text(device?.id);
    const battery = Number(device?.battery);
    if (!deviceId || !Number.isFinite(battery)) return;
    const incidentId = `battery_critical:${deviceId}`;
    const warningId = `battery_level:${deviceId}`;
    const existing = this.store.getActiveIncident(warningId);
    if (battery <= 10) {
      if (existing?.state === "critical") return;
      const firstObservedAt = existing?.firstObservedAt || now.toISOString();
      const next = { incidentId, kind: "battery_critical", state: "critical", revision: Number(existing?.revision || 0) + 1, firstObservedAt, lastObservedAt: now.toISOString(), device: this.deviceSnapshot(device) };
      await this.store.saveActiveIncident(warningId, next);
      await this.record({ type: "battery_critical", device: this.deviceSnapshot(device), detail: `Battery level is ${battery}%.`, reportable: true, incident: { incidentId, kind: "battery_critical", state: "open", revision: next.revision, firstObservedAt, lastObservedAt: now.toISOString(), details: { battery, previousBattery } } });
      return;
    }
    if (battery <= 20) {
      if (existing) return;
      await this.store.saveActiveIncident(warningId, { incidentId: warningId, kind: "battery_level", state: "warning", revision: 0, firstObservedAt: now.toISOString(), lastObservedAt: now.toISOString(), device: this.deviceSnapshot(device) });
      await this.record({ type: "battery_low", device: this.deviceSnapshot(device), detail: `Battery level is ${battery}%.`, change: { field: "battery", before: previousBattery, after: battery } });
      return;
    }
    if (battery > 25 && existing) {
      const wasCritical = existing.state === "critical";
      if (wasCritical) {
        await this.record({ type: "battery_recovered", device: this.deviceSnapshot(device), detail: `Battery level recovered to ${battery}%.`, reportable: true, incident: { incidentId: existing.incidentId, kind: "battery_critical", state: "resolved", revision: Number(existing.revision || 1) + 1, firstObservedAt: existing.firstObservedAt, lastObservedAt: now.toISOString(), resolvedAt: now.toISOString(), details: { battery } } });
      } else {
        await this.record({ type: "battery_recovered", device: this.deviceSnapshot(device), detail: `Battery level recovered to ${battery}%.` });
      }
      await this.store.saveActiveIncident(warningId, null);
    }
  }

  async incidentMonitorRecovery(device, now = this.now()) {
    const incidentId = `device_offline:${text(device?.id)}`;
    const existing = this.store.getActiveIncident(incidentId);
    if (!existing) return this.record({ type: "device_available", device: this.deviceSnapshot(device), detail: "The device is available again." });
    if (existing.state === "open") {
      await this.store.saveActiveIncident(incidentId, { ...existing, state: "recovering", stateBeforeRecovery: "open", recoveredAt: now.toISOString(), lastObservedAt: now.toISOString(), device: this.deviceSnapshot(device) });
    } else if (existing.state === "recovering") {
      await this.store.saveActiveIncident(incidentId, { ...existing, recoveredAt: existing.recoveredAt || now.toISOString(), lastObservedAt: now.toISOString(), device: this.deviceSnapshot(device) });
    } else {
      await this.record({ type: "device_available", device: this.deviceSnapshot(device), detail: "The device is available again.", dedupeKey: `available:${text(device?.id)}` });
      await this.store.saveActiveIncident(incidentId, null);
    }
  }

  async sweep(now = this.now()) {
    await this.store.pruneActivity(now);
    if (now.getTime() - this.startedAt < this.startupWarmupMs) return { escalated: 0 };
    let escalated = 0;
    const state = this.store.getActivityState();
    for (const [incidentId, active] of Object.entries(state.activeIncidents || {})) {
      if (active.state === "open" && await this.reclassifyPrematureOfflineIncident(incidentId, active, now)) continue;
      if (active.state === "recovering") {
        const recoveredAt = Date.parse(active.recoveredAt || "");
        if (!Number.isFinite(recoveredAt) || now.getTime() - recoveredAt < this.recoveryStableMs) continue;
        const resolvedAt = now.toISOString();
        const isDevice = active.kind === "device_offline";
        await this.record({
          type: isDevice ? "device_recovered" : "integration_recovered",
          device: isDevice ? this.deviceSnapshot(active.device) : null,
          integration: isDevice ? undefined : active.integration,
          detail: isDevice ? "The device came back online after a reported outage." : undefined,
          reportable: active.stateBeforeRecovery === "open" || Number(active.revision || 0) > 0,
          incident: active.stateBeforeRecovery === "open" || Number(active.revision || 0) > 0 ? { incidentId, kind: active.kind, state: "resolved", revision: Number(active.revision || 1) + 1, firstObservedAt: active.firstObservedAt, lastObservedAt: resolvedAt, resolvedAt, details: { previousSeverity: "critical" } } : null,
        });
        await this.store.saveActiveIncident(incidentId, null);
        continue;
      }
      if (active.state !== "watching") continue;
      const criticalAtIso = this.offlineCriticalAt(active.firstObservedAt, active);
      if (criticalAtIso && active.criticalAt !== criticalAtIso) {
        await this.store.saveActiveIncident(incidentId, { ...active, criticalAt: criticalAtIso });
      }
      const criticalAt = Date.parse(criticalAtIso || active.criticalAt || "");
      if (!Number.isFinite(criticalAt) || now.getTime() < criticalAt) continue;
      if (active.kind === "integration_offline") {
        const next = { ...active, state: "open", revision: Number(active.revision || 0) + 1, openedAt: now.toISOString(), lastObservedAt: now.toISOString() };
        await this.store.saveActiveIncident(incidentId, next);
        await this.record({ type: "integration_offline", integration: active.integration, reportable: true, incident: { incidentId, kind: "integration_offline", state: "open", revision: next.revision, firstObservedAt: active.firstObservedAt, lastObservedAt: now.toISOString(), details: { integration: active.integration || "unknown" } } });
        escalated += 1;
        continue;
      }
      if (active.device && this.parentIntegrationIsOffline(active.device)) continue;
      const device = active.device || null;
      const next = { ...active, state: "open", revision: Number(active.revision || 0) + 1, openedAt: now.toISOString(), lastObservedAt: now.toISOString() };
      await this.store.saveActiveIncident(incidentId, next);
      await this.record({ type: "device_offline_incident", device, detail: `The device has been offline since ${active.firstObservedAt}.`, reportable: true, incident: { incidentId, kind: "device_offline", state: "open", revision: next.revision, firstObservedAt: active.firstObservedAt, lastObservedAt: now.toISOString(), details: { powerClass: active.powerClass } } });
      escalated += 1;
    }
    return { escalated };
  }

  async observeIntegration(name, healthy, now = this.now()) {
    const integration = text(name, "integration");
    const incidentId = `integration_offline:${integration}`;
    const existing = this.store.getActiveIncident(incidentId);
    if (healthy) {
      if (!existing) return null;
      if (existing.state === "open") {
        await this.store.saveActiveIncident(incidentId, { ...existing, state: "recovering", stateBeforeRecovery: "open", recoveredAt: now.toISOString(), lastObservedAt: now.toISOString() });
        return null;
      }
      if (existing.state === "recovering") return null;
      await this.record({ type: "integration_recovered", integration, change: { integration, state: "online" }, dedupeKey: `integration-recovered:${integration}` });
      await this.store.saveActiveIncident(incidentId, null);
      return null;
    }
    if (!existing) {
      const firstObservedAt = now.toISOString();
      await this.store.saveActiveIncident(incidentId, { incidentId, kind: "integration_offline", state: "watching", revision: 0, firstObservedAt, lastObservedAt: firstObservedAt, criticalAt: this.offlineCriticalAt(firstObservedAt, { kind: "integration_offline" }), integration });
      const isRadio = ["zigbee2mqtt", "matter", "thread"].includes(integration);
      await this.record({ type: isRadio ? "radio_disconnected" : "integration_unavailable", detail: `${integration} is offline. The hub will report a persistent outage.`, change: { integration, state: "offline" }, dedupeKey: `integration-unavailable:${integration}` });
      return null;
    }
    if (await this.reclassifyPrematureOfflineIncident(incidentId, existing, now)) return null;
    const criticalAt = this.offlineCriticalAt(existing.firstObservedAt, existing);
    if (existing.state === "watching" && criticalAt && existing.criticalAt !== criticalAt) {
      await this.store.saveActiveIncident(incidentId, { ...existing, criticalAt, lastObservedAt: now.toISOString() });
    }
    if (existing.state === "watching" && criticalAt && now.getTime() >= Date.parse(criticalAt)) {
      const next = { ...existing, state: "open", revision: Number(existing.revision || 0) + 1, openedAt: now.toISOString(), lastObservedAt: now.toISOString() };
      await this.store.saveActiveIncident(incidentId, next);
      return this.record({ type: "integration_offline", integration, reportable: true, incident: { incidentId, kind: "integration_offline", state: "open", revision: next.revision, firstObservedAt: existing.firstObservedAt, lastObservedAt: now.toISOString(), details: { integration } } });
    }
    return null;
  }

  offlineThresholdMs(active) {
    if (active?.kind === "integration_offline") return Number(this.thresholds.integration) || OFFLINE_INCIDENT_THRESHOLD_MS;
    return active?.powerClass === "battery"
      ? Number(this.thresholds.battery) || OFFLINE_INCIDENT_THRESHOLD_MS
      : Number(this.thresholds.mains) || OFFLINE_INCIDENT_THRESHOLD_MS;
  }

  offlineCriticalAt(firstObservedAt, active) {
    const first = Date.parse(firstObservedAt || "");
    if (!Number.isFinite(first)) return null;
    return new Date(first + this.offlineThresholdMs(active)).toISOString();
  }

  async reclassifyPrematureOfflineIncident(incidentId, active, now = this.now()) {
    if (active?.state !== "open") return false;
    const criticalAt = this.offlineCriticalAt(active.firstObservedAt, active);
    if (!criticalAt || now.getTime() >= Date.parse(criticalAt)) return false;
    const wasReported = Number(active.revision || 0) > 0;
    const revision = Math.max(1, Number(active.revision || 0) + 1);
    const isIntegration = active.kind === "integration_offline";
    const device = isIntegration ? null : this.deviceSnapshot(active.device);
    await this.record({
      type: "offline_incident_reclassified",
      integration: isIntegration ? active.integration : undefined,
      device,
      detail: "The outage was shorter than the one-hour alert threshold.",
      reportable: wasReported,
      incident: wasReported ? {
        incidentId,
        kind: active.kind,
        state: "resolved",
        revision,
        firstObservedAt: active.firstObservedAt,
        lastObservedAt: now.toISOString(),
        resolvedAt: now.toISOString(),
        details: { reason: "below_one_hour_threshold", thresholdMs: this.offlineThresholdMs(active) },
      } : null,
    });
    await this.store.saveActiveIncident(incidentId, {
      ...active,
      state: "watching",
      revision: 0,
      openedAt: null,
      recoveredAt: null,
      lastObservedAt: now.toISOString(),
      criticalAt,
    });
    return true;
  }

  parentIntegrationIsOffline(device) {
    const protocol = text(device?.protocol).toLowerCase();
    const names = protocol === "zigbee" ? ["zigbee2mqtt"] : protocol === "matter" ? ["matter"] : protocol === "thread" ? ["thread"] : [];
    return names.some((name) => {
      const incident = this.store.getActiveIncident(`integration_offline:${name}`);
      return Boolean(incident && ["watching", "open", "recovering"].includes(incident.state));
    });
  }
}

module.exports = { ActivityService, TYPE_META, OFFLINE_THRESHOLDS_MS, STARTUP_WARMUP_MS, RECOVERY_STABLE_MS, sanitize, elapsedDuration, integrationName, friendlyEventCopy };
