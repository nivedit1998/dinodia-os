const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fixedLabelState } = require("./labelCatalog");
const { normalizeCapability, text } = require("./capabilities/schema");
const { APPROVED_LABELS, buildPresentation, isConfigured, labelId } = require("./capabilities/devicePresentation");
const { DEFAULT_HEATING_DEMAND_CONFIG, DEFAULT_HEATING_DEMAND_RUNTIME } = require("./heatingDemandController");
const { NATIVE_AUTOMATION_STORE_VERSION, LIMITS } = require("./automations/constants");
const { migrateLegacyAutomations } = require("./automations/legacyAdapter");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const ACTIVITY_MAX_RECORDS = 2000;
const ACTIVITY_RETENTION_MONTHS = 4;

function activityRetentionCutoff(now = new Date()) {
  const current = now instanceof Date ? new Date(now) : new Date(now);
  if (!Number.isFinite(current.getTime())) return activityRetentionCutoff(new Date());
  const day = current.getUTCDate();
  // Move from the first day of the month so dates such as 31 August do not
  // overflow into the wrong target month when subtracting four months.
  current.setUTCDate(1);
  current.setUTCMonth(current.getUTCMonth() - ACTIVITY_RETENTION_MONTHS);
  const lastDay = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate();
  current.setUTCDate(Math.min(day, lastDay));
  return current;
}

function isRetainedActivityRecord(record, now = new Date()) {
  const timestamp = Date.parse(record?.occurredAt || "");
  return Number.isFinite(timestamp) && timestamp >= activityRetentionCutoff(now).getTime();
}

function initialActivityState() {
  return {
    nextSequence: 1,
    records: [],
    activeIncidents: {},
    retentionMonths: ACTIVITY_RETENTION_MONTHS,
    maxRecords: ACTIVITY_MAX_RECORDS,
    legacyEventsMigrated: false,
    lastShutdownClean: true,
    lastStartedAt: null,
    lastStoppedAt: null,
  };
}

function normalizeActivityState(value) {
  const base = initialActivityState();
  const input = value && typeof value === "object" ? value : {};
  const records = Array.isArray(input.records)
    ? input.records.filter((record) => record && typeof record === "object").map((record) => ({
      ...clone(record),
      schemaVersion: 1,
      id: String(record.id || crypto.randomUUID()),
      sequence: Math.max(0, Number(record.sequence) || 0),
    })).slice(0, ACTIVITY_MAX_RECORDS)
    : [];
  const maxSequence = records.reduce((max, record) => Math.max(max, record.sequence), 0);
  const activeIncidents = input.activeIncidents && typeof input.activeIncidents === "object" ? clone(input.activeIncidents) : {};
  return {
    ...base,
    nextSequence: Math.max(Number(input.nextSequence) || 1, maxSequence + 1),
    records,
    activeIncidents,
    retentionMonths: ACTIVITY_RETENTION_MONTHS,
    maxRecords: Math.max(100, Math.min(ACTIVITY_MAX_RECORDS, Number(input.maxRecords) || ACTIVITY_MAX_RECORDS)),
    legacyEventsMigrated: input.legacyEventsMigrated === true,
    lastShutdownClean: input.lastShutdownClean !== false,
    lastStartedAt: input.lastStartedAt || null,
    lastStoppedAt: input.lastStoppedAt || null,
  };
}

function migrateLegacyActivityEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(0, 200).reverse().map((event, index) => {
    const type = String(event?.type || "legacy_event");
    const deviceId = String(event?.deviceId || "").trim();
    const areaId = String(event?.areaId || "").trim();
    const occurredAt = String(event?.timestamp || new Date().toISOString());
    return {
      schemaVersion: 1,
      id: `legacy:${String(event?.id || index)}`,
      sequence: index + 1,
      occurredAt,
      updatedAt: occurredAt,
      type,
      category: "system",
      severity: "system",
      statusLabel: "system",
      summary: humanize(type),
      detail: deviceId ? `Legacy event for ${deviceId}.` : "Imported from the legacy hub event history.",
      source: "legacy_events",
      actor: "system",
      device: deviceId ? { id: deviceId, name: String(event?.deviceName || deviceId), protocol: String(event?.protocol || "unknown") } : null,
      deviceId: deviceId || null,
      area: areaId ? { id: areaId, name: String(event?.areaName || areaId) } : null,
      change: null,
      occurrences: 1,
      dedupeKey: `legacy:${String(event?.id || index)}`,
      reportable: false,
      incident: null,
    };
  });
}

function normalizeIncidentOutbox(value) {
  const input = value && typeof value === "object" ? value : {};
  const pending = Array.isArray(input.pending)
    ? input.pending.filter((entry) => entry && typeof entry === "object" && entry.envelope && typeof entry.envelope === "object").map((entry) => ({
      ...clone(entry),
      id: String(entry.id || entry.envelope.id || crypto.randomUUID()),
      attempts: Math.max(0, Number(entry.attempts) || 0),
      createdAt: String(entry.createdAt || new Date().toISOString()),
    })).slice(0, 100)
    : [];
  return {
    pending,
    acknowledged: input.acknowledged && typeof input.acknowledged === "object" ? clone(input.acknowledged) : {},
    lastUploadAt: input.lastUploadAt || null,
    lastError: input.lastError || null,
  };
}

function normalizeElectricUsageState(value) {
  const input = value && typeof value === "object" ? value : {};
  const normalizeEntry = (entry, entityId = "") => {
    if (!entry || typeof entry !== "object") return null;
    return {
      ...clone(entry),
      entityId: String(entry.entityId || entityId),
      onSeconds: Math.max(0, Math.floor(Number(entry.onSeconds) || 0)),
      offSeconds: Math.max(0, Math.floor(Number(entry.offSeconds) || 0)),
      unknownSeconds: Math.max(0, Math.floor(Number(entry.unknownSeconds) || 0)),
      trackingEpoch: String(entry.trackingEpoch || crypto.randomUUID()),
      assignmentEpoch: String(entry.assignmentEpoch || crypto.randomUUID()),
      dirty: entry.dirty !== false,
    };
  };
  return {
    schemaVersion: 1,
    entities: Object.fromEntries(Object.entries(input.entities && typeof input.entities === "object" ? input.entities : {}).map(([id, entry]) => [id, normalizeEntry(entry, id)]).filter(([, entry]) => entry)),
    pending: Array.isArray(input.pending) ? input.pending.map((entry) => normalizeEntry(entry)).filter(Boolean).slice(0, 200) : [],
    lastResetAt: input.lastResetAt || null,
    ...(input.resetAckPendingAt ? { resetAckPendingAt: String(input.resetAckPendingAt) } : {}),
  };
}

function initialState() {
  return {
    version: NATIVE_AUTOMATION_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    identity: { serial: "", instanceId: "", hostname: "dinodia" },
    setup: { state: "UNINITIALIZED", completed: [], updatedAt: null, pairing: null },
    auth: { haTokenHash: "", dashboardTokenHash: "", issuedAt: null, displayedAt: null, policyRevision: 0 },
    security: { offlineAuthorisations: {}, usedLanNonces: {}, usedStepUpProofs: {}, revokedOperatorJtis: {} },
    areas: {},
    labels: fixedLabelState(),
    devices: {},
    aliases: {},
    states: {},
    configEntries: {},
    automations: {},
    automationTriggers: {},
    automationActions: {},
    automationOccurrences: {},
    automationExecutions: [],
    automationIdempotency: {},
    automationRuntime: { schedulerRunning: false, lastTickAt: null, lastError: null, recoveredAt: null },
    legacyAutomations: {},
    nativeAutomationMigration: { fromVersion: NATIVE_AUTOMATION_STORE_VERSION, native: 0, legacy: 0, rejected: 0, completedAt: null },
    remoteBindings: {},
    platform: {
      apiUrl: "https://app.dinodiasmartliving.com",
      paired: false,
      agentSeenVersion: 0,
      publishedVersion: 0,
      acceptedTokenHashes: [],
      syncIntervalMinutes: 2,
      lastPairAt: null,
      lastSyncAt: null,
      lastError: null,
      operatorCredentialVersion: 0,
      operatorCredentialReceivedAt: null,
    },
    heatingUsage: { intervals: [], totals: {}, lastResetAt: null },
    electricUsage: { schemaVersion: 1, entities: {}, pending: [], lastResetAt: null },
    heatingDemandController: normalizeHeatingDemandControllerState(),
    events: [],
    activity: initialActivityState(),
    incidentOutbox: normalizeIncidentOutbox(),
    cloudflare: { mode: "disabled", hostname: "", token: "", origin: "http://127.0.0.1:8123" },
    zigbee: { adapterPath: "", adapterName: "", adapterType: "", recommended: false, discoveryPrefix: "dinodia-ha", removedAdapterPaths: [] },
    thread: { configured: false, rcpDevice: "", rcpName: "", baudRate: 460800, infraIf: "eth0", threadIf: "wpan0", updatedAt: null },
    integrations: {
      zigbee: { discoveryPrefix: "dinodia-ha", converterVersion: "", image: "", lastSeenAt: null },
      matter: { modelVersion: "", image: "", lastSeenAt: null },
      thread: { configured: false, borderRouter: "external", lastSeenAt: null },
      hive: {
        enabled: true,
        configured: false,
        status: "disconnected",
        accountFingerprint: "",
        maskedUsername: "",
        adapterVersion: "1.0.9",
        connectedAt: null,
        lastAttemptAt: null,
        lastSuccessfulPollAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        reauthRequired: false,
        consecutiveFailures: 0,
        ignoredDeviceIds: [],
        ignoredDeviceSummaries: [],
        heatingDeviceCount: 0,
        hotWaterDeviceCount: 0,
        unsupportedProductCount: 0,
      },
      googleNest: {
        enabled: true,
        configured: false,
        status: "disabled",
        releaseChannel: "sandbox_beta",
        accountFingerprint: "",
        connectedAt: null,
        lastAuthorizationAttemptAt: null,
        lastSuccessfulPollAt: null,
        nextPollAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        reauthRequired: false,
        consecutiveFailures: 0,
        thermostatDeviceCount: 0,
        unsupportedDeviceCount: 0,
        ignoredDeviceIds: [],
        ignoredDeviceSummaries: [],
      },
      alexa: {
        enabled: true,
        linked: false,
        status: "disconnected",
        endpointCount: 0,
        catalogRevision: null,
        lastSuccessfulSyncAt: null,
        lastStatusCheckAt: null,
        errorCode: null,
        lastErrorAt: null,
        directiveReceipts: [],
      },
    },
    pairingSessions: {},
  };
}

function normalizeState(value) {
  const base = initialState();
  if (!value || typeof value !== "object") return base;
  const sourceVersion = Number(value.version || 0);
  const rawDevices = value.devices && typeof value.devices === "object" ? Object.fromEntries(Object.entries(value.devices).map(([id, device]) => [id, migrateLegacySetup({
    ...(device && typeof device === "object" ? device : {}),
    id: String((device && device.id) || id),
    capabilitySchemaVersion: 1,
    protocolIdentity: device && device.protocolIdentity && typeof device.protocolIdentity === "object" ? device.protocolIdentity : inferProtocolIdentity(device, id),
    definition: device && device.definition && typeof device.definition === "object" ? device.definition : { source: device?.protocol === "zigbee" ? "legacy-zigbee" : "legacy" },
    areaId: device && device.areaId ? String(device.areaId) : null,
    setup: {
      status: String(device?.setup?.status || "needs_setup"),
      assignmentMode: String(device?.setup?.assignmentMode || "device_inherited_v1"),
      completedAt: device?.setup?.completedAt || null,
      updatedAt: device?.setup?.updatedAt || null,
      reason: device?.setup?.reason || "area_and_label_required",
    },
    entities: device && device.entities && typeof device.entities === "object" ? device.entities : {},
  }, value.areas && typeof value.areas === "object" ? value.areas : {}, Number(value.version || 0))])) : {};
  const devices = Object.fromEntries(Object.entries(rawDevices).map(([id, device]) => [id, {
    ...device,
    presentation: device.presentation && typeof device.presentation === "object" ? device.presentation : buildPresentation(device, "1970-01-01T00:00:00.000Z"),
  }]));
  const aliases = value.aliases && typeof value.aliases === "object" ? { ...value.aliases } : {};
  for (const [id, device] of Object.entries(devices)) {
    for (const legacy of Array.isArray(device.legacyIds) ? device.legacyIds : []) aliases[String(legacy)] = String(id);
    if (device.metadata?.friendly_name && String(id) !== String(device.metadata.friendly_name)) aliases[String(device.metadata.friendly_name)] = String(id);
  }
  const activity = normalizeActivityState(value.activity);
  if (Array.isArray(value.events) && value.events.length && activity.records.length === 0 && activity.legacyEventsMigrated !== true) {
    activity.records = migrateLegacyActivityEvents(value.events);
    activity.nextSequence = activity.records.length + 1;
    activity.legacyEventsMigrated = true;
  }
  const localHomeId = String(value.identity?.instanceId || value.identity?.serial || "local-home");
  const oldAutomationMap = sourceVersion >= NATIVE_AUTOMATION_STORE_VERSION
    ? (value.legacyAutomations && typeof value.legacyAutomations === "object" ? value.legacyAutomations : {})
    : (value.automations && typeof value.automations === "object" ? value.automations : {});
  const migration = sourceVersion >= NATIVE_AUTOMATION_STORE_VERSION
    ? { automations: value.automations && typeof value.automations === "object" ? value.automations : {}, automationTriggers: value.automationTriggers && typeof value.automationTriggers === "object" ? value.automationTriggers : {}, automationActions: value.automationActions && typeof value.automationActions === "object" ? value.automationActions : {}, legacyAutomations: oldAutomationMap, report: value.nativeAutomationMigration || { fromVersion: sourceVersion, native: 0, legacy: Object.keys(oldAutomationMap).length, rejected: 0, completedAt: null } }
    : migrateLegacyAutomations(oldAutomationMap, localHomeId);
  return {
    ...base,
    ...value,
    version: NATIVE_AUTOMATION_STORE_VERSION,
    identity: { ...base.identity, ...(value.identity && typeof value.identity === "object" ? value.identity : {}) },
    setup: { ...base.setup, ...(value.setup && typeof value.setup === "object" ? value.setup : {}) },
    auth: { ...base.auth, ...(value.auth && typeof value.auth === "object" ? value.auth : {}) },
    security: {
      ...base.security,
      ...(value.security && typeof value.security === "object" ? value.security : {}),
      offlineAuthorisations: value.security?.offlineAuthorisations && typeof value.security.offlineAuthorisations === "object" ? value.security.offlineAuthorisations : {},
      usedLanNonces: value.security?.usedLanNonces && typeof value.security.usedLanNonces === "object" ? value.security.usedLanNonces : {},
      usedStepUpProofs: value.security?.usedStepUpProofs && typeof value.security.usedStepUpProofs === "object" ? value.security.usedStepUpProofs : {},
      revokedOperatorJtis: value.security?.revokedOperatorJtis && typeof value.security.revokedOperatorJtis === "object" ? value.security.revokedOperatorJtis : {},
    },
    areas: value.areas && typeof value.areas === "object" ? value.areas : {},
    // Keep the four Dinodia labels available on every hub, including hubs
    // upgraded from an older data file. Any legacy/custom records are kept
    // for compatibility, but the OS UI only presents the fixed catalog.
    labels: { ...(value.labels && typeof value.labels === "object" ? value.labels : {}), ...fixedLabelState() },
    devices,
    aliases,
    states: value.states && typeof value.states === "object" ? value.states : {},
    configEntries: value.configEntries && typeof value.configEntries === "object" ? value.configEntries : {},
    automations: migration.automations || {},
    automationTriggers: migration.automationTriggers || {},
    automationActions: migration.automationActions || {},
    automationOccurrences: sourceVersion >= NATIVE_AUTOMATION_STORE_VERSION && value.automationOccurrences && typeof value.automationOccurrences === "object" ? value.automationOccurrences : {},
    automationExecutions: sourceVersion >= NATIVE_AUTOMATION_STORE_VERSION && Array.isArray(value.automationExecutions) ? value.automationExecutions.slice(0, LIMITS.maxExecutionHistory) : [],
    automationIdempotency: sourceVersion >= NATIVE_AUTOMATION_STORE_VERSION && value.automationIdempotency && typeof value.automationIdempotency === "object" ? value.automationIdempotency : {},
    automationRuntime: { ...base.automationRuntime, ...(value.automationRuntime && typeof value.automationRuntime === "object" ? value.automationRuntime : {}) },
    legacyAutomations: migration.legacyAutomations || {},
    // Use the source snapshot timestamp when available so loading an old file
    // is deterministic and does not appear to migrate again on every restart.
    nativeAutomationMigration: { fromVersion: sourceVersion || NATIVE_AUTOMATION_STORE_VERSION, ...(migration.report || {}), completedAt: value.nativeAutomationMigration?.completedAt || (sourceVersion < NATIVE_AUTOMATION_STORE_VERSION ? (value.updatedAt || null) : null) },
    remoteBindings: value.remoteBindings && typeof value.remoteBindings === "object" ? value.remoteBindings : {},
    platform: { ...base.platform, ...(value.platform && typeof value.platform === "object" ? value.platform : {}) },
    heatingUsage: { ...base.heatingUsage, ...(value.heatingUsage && typeof value.heatingUsage === "object" ? value.heatingUsage : {}) },
    electricUsage: normalizeElectricUsageState(value.electricUsage),
    heatingDemandController: normalizeHeatingDemandControllerState(value.heatingDemandController),
    events: Array.isArray(value.events) ? value.events.slice(0, 500) : [],
    activity,
    incidentOutbox: normalizeIncidentOutbox(value.incidentOutbox),
    cloudflare: value.cloudflare && typeof value.cloudflare === "object" ? { ...base.cloudflare, ...value.cloudflare } : base.cloudflare,
    zigbee: value.zigbee && typeof value.zigbee === "object" ? { ...base.zigbee, ...value.zigbee, removedAdapterPaths: normalizeIds(value.zigbee.removedAdapterPaths) } : base.zigbee,
    thread: value.thread && typeof value.thread === "object" ? { ...base.thread, ...value.thread, configured: Boolean(value.thread.configured), rcpDevice: String(value.thread.rcpDevice || ""), rcpName: String(value.thread.rcpName || ""), baudRate: Number(value.thread.baudRate) || 460800, infraIf: String(value.thread.infraIf || "eth0"), threadIf: String(value.thread.threadIf || "wpan0") } : base.thread,
    integrations: normalizeObjectMap(value.integrations, base.integrations),
    pairingSessions: value.pairingSessions && typeof value.pairingSessions === "object" ? value.pairingSessions : {},
  };
}

function defaultHiveIntegration() {
  return clone(initialState().integrations.hive);
}

function defaultGoogleNestIntegration() {
  return clone(initialState().integrations.googleNest);
}

function normalizeObjectMap(value, fallback) {
  const result = { ...fallback };
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) result[key] = item && typeof item === "object" ? { ...(result[key] || {}), ...item } : item;
  return result;
}

function normalizeHeatingDemandControllerState(value) {
  const input = value && typeof value === "object" ? value : {};
  const config = input.config && typeof input.config === "object" ? input.config : {};
  const runtime = input.runtime && typeof input.runtime === "object" ? input.runtime : {};
  return {
    schemaVersion: 1,
    config: {
      ...DEFAULT_HEATING_DEMAND_CONFIG,
      ...clone(config),
      schemaVersion: 1,
      enabled: config.enabled === true,
      boilerDeviceId: config.boilerDeviceId ? String(config.boilerDeviceId) : null,
      radiatorDeviceIds: normalizeIds(config.radiatorDeviceIds),
    },
    runtime: {
      ...DEFAULT_HEATING_DEMAND_RUNTIME,
      ...clone(runtime),
      schemaVersion: 1,
      callingRadiatorIds: normalizeIds(runtime.callingRadiatorIds),
      unknownRadiatorIds: normalizeIds(runtime.unknownRadiatorIds),
      lastEvaluation: runtime.lastEvaluation && typeof runtime.lastEvaluation === "object" ? clone(runtime.lastEvaluation) : null,
      integrations: runtime.integrations && typeof runtime.integrations === "object" ? clone(runtime.integrations) : {},
      readOnlyVerification: runtime.readOnlyVerification && typeof runtime.readOnlyVerification === "object" ? clone(runtime.readOnlyVerification) : null,
    },
  };
}

function inferProtocolIdentity(device, id) {
  if (device?.protocol === "zigbee") return { ieeeAddress: String(device.metadata?.ieee_address || device.metadata?.ieee || id) };
  if (device?.protocol === "matter") return { nodeId: String(device.metadata?.node_id || device.metadata?.id || String(id).replace(/^matter-/, "")), fabricId: String(device.metadata?.fabric_id || "default") };
  if (device?.protocol === "google_nest") return { resourceName: String(device.metadata?.resource_name || id) };
  return { legacyId: String(id) };
}

function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || "Entity";
}

function normalizeIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function normalizeSetup(value, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const pairing = input.pairing && typeof input.pairing === "object" ? {
    id: String(input.pairing.id || ""),
    attemptId: String(input.pairing.attemptId || ""),
    serial: String(input.pairing.serial || ""),
    publicKeyFingerprint: String(input.pairing.publicKeyFingerprint || ""),
    baseUrl: String(input.pairing.baseUrl || ""),
    codeVaultKey: String(input.pairing.codeVaultKey || ""),
    browserNonceHash: String(input.pairing.browserNonceHash || ""),
    issuedAt: Number(input.pairing.issuedAt) || 0,
    expiresAt: Number(input.pairing.expiresAt) || 0,
    consumedAt: input.pairing.consumedAt ? Number(input.pairing.consumedAt) : null,
    revokedAt: input.pairing.revokedAt ? Number(input.pairing.revokedAt) : null,
    failures: Math.max(0, Math.floor(Number(input.pairing.failures) || 0)),
  } : (fallback.pairing || null);
  return {
    status: String(input.status || fallback.status || "needs_setup"),
    assignmentMode: String(input.assignmentMode || fallback.assignmentMode || "device_inherited_v1"),
    completedAt: input.completedAt || fallback.completedAt || null,
    updatedAt: input.updatedAt || fallback.updatedAt || null,
    reason: Object.prototype.hasOwnProperty.call(input, "reason") ? input.reason : (fallback.reason || "area_and_label_required"),
    pairing,
  };
}

function normalizeLegacyAssignments(device) {
  const assignments = {};
  for (const entity of Object.values(device?.entities || {})) {
    if (!entity || typeof entity !== "object") continue;
    const areaId = entity.areaId ? String(entity.areaId) : null;
    const labelIds = normalizeIds(entity.labelIds || entity.labels);
    if (areaId || labelIds.length) {
      const id = String(entity.id || entity.sourceId || entity.stateKey || `${device.id}:legacy:${Object.keys(assignments).length}`);
      assignments[id] = { areaId, labelIds };
    }
  }
  return assignments;
}

function migrateLegacySetup(device, areas, legacyVersion) {
  const existingSetup = device.setup && typeof device.setup === "object" ? device.setup : {};
  const existingAssignments = device.legacyEntityAssignments && typeof device.legacyEntityAssignments === "object"
    ? device.legacyEntityAssignments
    : legacyVersion < 5 ? normalizeLegacyAssignments(device) : null;
  const validArea = (value) => Boolean(value && areas && areas[String(value)]);
  const deviceArea = device.areaId ? String(device.areaId) : null;
  const deviceLabels = normalizeIds(device.labelIds || device.labels).filter((label) => APPROVED_LABELS.has(String(label).toLowerCase()));
  const childAreas = Object.values(existingAssignments || {}).map((item) => item?.areaId).filter(Boolean).map(String);
  const childLabels = Object.values(existingAssignments || {}).flatMap((item) => normalizeIds(item?.labelIds)).filter((label) => APPROVED_LABELS.has(String(label).toLowerCase())).map((label) => String(label).toLowerCase());
  const uniqueAreas = [...new Set(childAreas)];
  const uniqueLabels = [...new Set(childLabels)];
  const promotedArea = deviceArea || (uniqueAreas.length === 1 ? uniqueAreas[0] : null);
  const promotedLabel = deviceLabels.length === 1 ? String(deviceLabels[0]).toLowerCase() : uniqueLabels.length === 1 ? uniqueLabels[0] : null;
  const childConflict = uniqueAreas.length > 1 || uniqueLabels.length > 1;
  const canBeReady = !childConflict && validArea(promotedArea) && Boolean(promotedLabel);
  const status = existingSetup.status && existingSetup.status !== "needs_setup"
    ? existingSetup.status
    : canBeReady ? "ready" : "needs_setup";
  const setup = normalizeSetup(existingSetup, {
    status,
    completedAt: canBeReady ? (existingSetup.completedAt || new Date(0).toISOString()) : null,
    reason: canBeReady ? null : childConflict ? "conflicting_legacy_assignments" : "area_and_label_required",
  });
  if (legacyVersion < 5) {
    setup.status = status;
    setup.reason = canBeReady ? null : childConflict ? "conflicting_legacy_assignments" : "area_and_label_required";
    if (!canBeReady) setup.completedAt = null;
  }
  return {
    ...device,
    areaId: canBeReady ? promotedArea : deviceArea,
    labelIds: deviceLabels.length === 1 ? [deviceLabels[0]] : canBeReady ? [promotedLabel] : normalizeIds(device.labelIds || device.labels),
    labels: deviceLabels.length === 1 ? [deviceLabels[0]] : canBeReady ? [promotedLabel] : normalizeIds(device.labels || device.labelIds),
    setup,
    ...(existingAssignments && Object.keys(existingAssignments).length ? { legacyEntityAssignments: existingAssignments } : {}),
  };
}

function isInfrastructureDevice(device) {
  if (!device || typeof device !== "object") return false;
  if (device.infrastructure === true) return true;
  const protocol = String(device.protocol || "").toLowerCase();
  if (!["zigbee", "matter"].includes(protocol)) return false;
  const roles = [device.type, device.role, device.metadata?.type, device.metadata?.role, device.metadata?.device_type]
    .map((value) => String(value || "").trim().toLowerCase());
  if (roles.some((value) => ["coordinator", "controller", "border_router", "border-router"].includes(value))) return true;
  return protocol === "zigbee" && String(device.name || "").trim().toLowerCase() === "coordinator" && Object.keys(device.entities || {}).length === 0;
}

function replaceReference(value, from, to) {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((item) => replaceReference(item, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceReference(child, from, to)]));
}

function containsReference(value, references) {
  if (typeof value === "string") return references.has(value);
  if (Array.isArray(value)) return value.some((item) => containsReference(item, references));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsReference(child, references));
}

function mergeEntities(existing, incoming, deviceId, state) {
  const entities = existing && typeof existing === "object" ? clone(existing) : {};
  const definitions = incoming && typeof incoming === "object" ? incoming : {};
  const stateObject = state && typeof state === "object" ? state : {};
  for (const [entityId, input] of Object.entries(definitions)) {
    const matchingKey = Object.keys(entities).find((key) => key === entityId || entities[key]?.sourceId === entityId || entities[key]?.entityId === entityId);
    const previous = (matchingKey && entities[matchingKey]) || {};
    if (matchingKey && matchingKey !== entityId) delete entities[matchingKey];
    const entity = input && typeof input === "object" ? input : { stateKey: input };
    const stateKey = String(entity.stateKey || previous.stateKey || entityId.split(":").pop() || entityId);
    const hasReportedState = Object.prototype.hasOwnProperty.call(stateObject, stateKey);
    const nextState = hasReportedState ? clone(stateObject[stateKey]) : (entity.state !== undefined ? clone(entity.state) : previous.state);
    const stateChanged = JSON.stringify(previous.state) !== JSON.stringify(nextState);
    entities[entityId] = {
      ...previous,
      ...clone(entity),
      id: entityId,
      sourceId: String(entity.sourceId || previous.sourceId || entityId),
      deviceId: String(entity.deviceId || previous.deviceId || deviceId),
      stateKey,
      endpointId: String(entity.endpointId || previous.endpointId || "0"),
      logicalKey: String(entity.logicalKey || previous.logicalKey || stateKey),
      capability: normalizeCapability(entity.capability || previous.capability || {}, {
        kind: ["state", "power"].includes(stateKey.toLowerCase()) ? "binary" : (entity.expose?.type === "numeric" ? "sensor" : undefined),
        category: entity.category || previous.category || "control",
        readable: entity.readable,
        writable: entity.writable,
        observable: entity.observable,
        stateKey,
        unit: entity.expose?.unit,
        deviceClass: entity.expose?.device_class,
        constraints: entity.expose,
      }),
      name: String(entity.name || previous.name || humanize(stateKey)),
      original_name: String(entity.original_name || previous.original_name || entity.name || previous.name || humanize(stateKey)),
      labels: normalizeIds(entity.labels || previous.labels),
      labelIds: normalizeIds(entity.labelIds || previous.labelIds || entity.labels || previous.labels),
      state: nextState,
      lastChanged: stateChanged ? new Date().toISOString() : (previous.lastChanged || previous.updatedAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }
  for (const stateKey of Object.keys(stateObject)) {
    const entityId = `${deviceId}:${stateKey}`;
    const matchingKey = Object.keys(entities).find((key) => key === entityId || entities[key]?.sourceId === entityId);
    const previous = (matchingKey && entities[matchingKey]) || {};
    if (matchingKey && matchingKey !== entityId) delete entities[matchingKey];
    entities[entityId] = {
      ...previous,
      id: entityId,
      sourceId: String(previous.sourceId || entityId),
      deviceId: String(deviceId),
      stateKey,
      endpointId: String(previous.endpointId || "0"),
      logicalKey: String(previous.logicalKey || stateKey),
      capability: normalizeCapability(previous.capability || {}, { kind: ["state", "power"].includes(stateKey.toLowerCase()) ? "binary" : "sensor", stateKey, writable: false }),
      name: String(previous.name || humanize(stateKey)),
      original_name: String(previous.original_name || previous.name || humanize(stateKey)),
      labels: normalizeIds(previous.labels),
      labelIds: normalizeIds(previous.labelIds || previous.labels),
      state: clone(stateObject[stateKey]),
      lastChanged: JSON.stringify(previous.state) !== JSON.stringify(stateObject[stateKey]) ? new Date().toISOString() : (previous.lastChanged || previous.updatedAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }
  return entities;
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
    this.writeQueue = Promise.resolve();
  }

  load() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      return initialState();
    }
  }

  snapshot() {
    return clone(this.state);
  }

  async commit(mutator) {
    const before = this.snapshot();
    try {
      const result = await mutator(this.state);
      await this.persist();
      return result === undefined ? undefined : clone(result);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async mutateAtomically(mutator) { return this.commit(mutator); }

  async persist() {
    const operation = this.writeQueue.then(async () => {
      this.state.updatedAt = new Date().toISOString();
      const serialized = JSON.stringify(this.state, null, 2);
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tempPath, serialized, { mode: 0o600 });
      await fs.promises.rename(tempPath, this.filePath);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  listDevices() {
    return Object.values(this.state.devices).filter((device) => !isInfrastructureDevice(device)).map(clone).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }

  getDevice(id) {
    const requested = String(id || "");
    const resolved = this.state.aliases?.[requested] || requested;
    const device = this.state.devices[resolved] || Object.values(this.state.devices).find((candidate) => String(candidate.metadata?.friendly_name || "") === requested || String(candidate.protocolIdentity?.ieeeAddress || "") === requested);
    if (!device) return null;
    const result = clone(device);
    // Keep pre-capability friendly-name entity lookups working for existing
    // clients without persisting duplicate entity records.
    if (result.entities && Array.isArray(result.legacyIds)) {
      for (const legacyId of result.legacyIds) {
        for (const entity of Object.values(result.entities)) {
          if (!entity || !String(entity.id || "").startsWith(`${result.id}:`)) continue;
          const suffix = String(entity.id).slice(`${result.id}:`.length);
          const legacySuffix = suffix.startsWith("0:") ? suffix.slice(2) : suffix;
          Object.defineProperty(result.entities, `${legacyId}:${legacySuffix}`, { value: entity, enumerable: false, configurable: true });
        }
      }
    }
    return result;
  }

  async upsertDevice(device) {
    if (!device || !device.id) throw new Error("device.id is required");
    const id = String(device.id);
    const before = this.snapshot();
    const existing = this.state.devices[id] || {};
    const next = {
      ...existing,
      ...clone(device),
      id,
      haDeviceId: String(device.haDeviceId || existing.haDeviceId || `device_${crypto.createHash("sha256").update(`${device.protocol || existing.protocol || "device"}:${id}`).digest("hex").slice(0, 20)}`),
      name: String(device.name || existing.name || id),
      protocol: String(device.protocol || existing.protocol || "unknown"),
      capabilitySchemaVersion: 1,
      protocolIdentity: clone(device.protocolIdentity || existing.protocolIdentity || inferProtocolIdentity(device, id)),
      infrastructure: device.infrastructure === undefined ? Boolean(existing.infrastructure) : Boolean(device.infrastructure),
      legacyIds: [...new Set([...(existing.legacyIds || []), ...(device.legacyIds || [])].map(String))],
      definition: { ...(existing.definition || {}), ...(device.definition || {}) },
      state: { ...(existing.state || {}), ...(device.state || {}) },
      metadata: { ...(existing.metadata || {}), ...(device.metadata || {}) },
      labels: normalizeIds(device.labels === undefined ? existing.labels : device.labels),
      labelIds: normalizeIds(device.labelIds === undefined ? (existing.labelIds || existing.labels) : device.labelIds),
      areaId: device.areaId === undefined ? (existing.areaId || null) : (device.areaId ? String(device.areaId) : null),
      entities: mergeEntities(existing.entities, device.entities, id, { ...(existing.state || {}), ...(device.state || {}) }),
      available: device.available === undefined ? existing.available !== false : Boolean(device.available),
      updatedAt: new Date().toISOString(),
    };
    next.setup = normalizeSetup(device.setup || existing.setup, { status: "needs_setup", reason: "area_and_label_required" });
    next.presentation = buildPresentation(next);
    this.state.devices[id] = next;
    for (const legacyId of this.state.devices[id].legacyIds) this.state.aliases[String(legacyId)] = id;
    if (device.metadata?.friendly_name && String(device.metadata.friendly_name) !== id) this.state.aliases[String(device.metadata.friendly_name)] = id;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getDevice(id);
  }

  async migrateDeviceIdentity(fromId, toId, patch = {}) {
    const sourceId = this.state.aliases?.[String(fromId)] || String(fromId);
    const targetId = String(toId || "").trim();
    if (!targetId) throw new Error("target device ID is required");
    if (sourceId === targetId) return this.upsertDevice({ ...patch, id: targetId });
    const source = this.state.devices[sourceId];
    if (!source) return this.upsertDevice({ ...patch, id: targetId });
    const before = this.snapshot();
    const target = this.state.devices[targetId] || {};
    const aliases = { ...(this.state.aliases || {}), [sourceId]: targetId };
    const migratedEntities = {};
    for (const [oldKey, oldEntity] of Object.entries(source.entities || {})) {
      const endpointId = String(oldEntity?.endpointId || "0");
      const logicalKey = String(oldEntity?.logicalKey || oldEntity?.stateKey || oldKey.split(":").pop());
      const nextKey = `${targetId}:${endpointId}:${logicalKey}`;
      migratedEntities[nextKey] = { ...clone(oldEntity), id: nextKey, sourceId: nextKey, deviceId: targetId, endpointId, logicalKey };
      aliases[oldKey] = nextKey;
      if (oldEntity?.id) aliases[String(oldEntity.id)] = nextKey;
    }
    const incomingEntities = { ...migratedEntities, ...(patch.entities || {}) };
    delete this.state.devices[sourceId];
    this.state.devices[targetId] = {
      ...source,
      ...target,
      ...clone(patch),
      id: targetId,
      legacyIds: [...new Set([...(source.legacyIds || []), ...(target.legacyIds || []), sourceId, ...(patch.legacyIds || [])].map(String))],
      protocolIdentity: clone(patch.protocolIdentity || target.protocolIdentity || source.protocolIdentity || inferProtocolIdentity(patch, targetId)),
      entities: mergeEntities(target.entities, incomingEntities, targetId, { ...(source.state || {}), ...(target.state || {}), ...(patch.state || {}) }),
      state: { ...(source.state || {}), ...(target.state || {}), ...(patch.state || {}) },
      metadata: { ...(source.metadata || {}), ...(target.metadata || {}), ...(patch.metadata || {}) },
      updatedAt: new Date().toISOString(),
    };
    this.state.devices[targetId].setup = normalizeSetup(this.state.devices[targetId].setup, { status: "needs_setup", reason: "area_and_label_required" });
    this.state.devices[targetId].presentation = buildPresentation(this.state.devices[targetId]);
    this.state.aliases = aliases;
    this.updateHeatingDemandControllerDeviceReferences(sourceId, targetId);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getDevice(targetId);
  }

  async updateDeviceState(id, state, extra = {}) {
    const existing = this.state.devices[id] || {
      id,
      name: id,
      protocol: extra.protocol || "unknown",
      state: {},
      metadata: {},
      available: true,
    };
    return this.upsertDevice({
      ...existing,
      ...extra,
      id,
      state: { ...(existing.state || {}), ...(state || {}) },
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteDevice(id) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const device = this.state.devices[resolvedId];
    const existed = Boolean(device);
    if (!existed) return false;
    const before = this.snapshot();
    this.removeDeviceFromState(id);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return existed;
  }

  removeDeviceFromState(id) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const device = this.state.devices[resolvedId];
    if (!device) return false;
    const references = new Set([String(id), resolvedId, device.haDeviceId, device.metadata?.friendly_name, device.metadata?.friendlyName, device.metadata?.ieee_address, device.metadata?.ieee, device.metadata?.resource_name, device.protocolIdentity?.ieeeAddress, device.protocolIdentity?.nodeId, device.protocolIdentity?.resourceName, ...(device.legacyIds || [])].filter(Boolean).map(String));
    for (const [entityId, entity] of Object.entries(device.entities || {})) {
      references.add(String(entityId));
      if (entity?.id) references.add(String(entity.id));
      if (entity?.entityId) references.add(String(entity.entityId));
      if (entity?.haEntityId) references.add(String(entity.haEntityId));
    }
    const before = this.snapshot();
    delete this.state.devices[resolvedId];
    for (const [alias, target] of Object.entries(this.state.aliases || {})) {
      if (references.has(String(alias)) || references.has(String(target))) delete this.state.aliases[alias];
    }
    this.state.states = Object.fromEntries(Object.entries(this.state.states || {}).filter(([key, value]) => !references.has(String(key)) && !containsReference(value, references)));
    this.state.events = (this.state.events || []).filter((event) => !containsReference(event, references));
    this.state.remoteBindings = Object.fromEntries(Object.entries(this.state.remoteBindings || {}).filter(([, binding]) => !containsReference(binding, references)));
    this.state.legacyAutomations = Object.fromEntries(Object.entries(this.state.legacyAutomations || {}).filter(([, automation]) => !containsReference(automation, references)));
    this.updateHeatingDemandControllerDeviceReferences(resolvedId, null);
    if (this.state.heatingUsage && typeof this.state.heatingUsage === "object") {
      this.state.heatingUsage.entities = Object.fromEntries(Object.entries(this.state.heatingUsage.entities || {}).filter(([, entry]) => !containsReference(entry, references)));
      if (this.state.heatingUsage.config?.boilerBandsByEntityId) this.state.heatingUsage.config.boilerBandsByEntityId = Object.fromEntries(Object.entries(this.state.heatingUsage.config.boilerBandsByEntityId).filter(([key, value]) => !references.has(String(key)) && !containsReference(value, references)));
      this.state.heatingUsage.intervals = (this.state.heatingUsage.intervals || []).filter((entry) => !containsReference(entry, references));
      this.state.heatingUsage.totals = Object.fromEntries(Object.entries(this.state.heatingUsage.totals || {}).filter(([key, value]) => !references.has(String(key)) && !containsReference(value, references)));
    }
    // Keep electric tombstones until the platform acknowledges the final
    // segment. Removing them here would lose the last interval whenever a
    // device is unpaired before the next signed heartbeat.
    this.state.pairingSessions = Object.fromEntries(Object.entries(this.state.pairingSessions || {}).filter(([, session]) => !containsReference(session, references)));
    return true;
  }

  async deleteDevicesByProtocol(protocol) {
    const requested = String(protocol || "").trim().toLowerCase();
    if (!requested) return [];
    const ids = Object.values(this.state.devices || {})
      .filter((device) => String(device.protocol || "").toLowerCase() === requested)
      .map((device) => String(device.id));
    if (!ids.length) return [];
    const before = this.snapshot();
    try {
      ids.forEach((id) => this.removeDeviceFromState(id));
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return ids;
  }

  listAreas() {
    return Object.values(this.state.areas).map(clone).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  getArea(id) {
    const area = this.state.areas[id];
    return area ? clone(area) : null;
  }

  async saveArea(input, id = crypto.randomUUID()) {
    if (!input || !String(input.name || "").trim()) throw new Error("area name is required");
    const before = this.snapshot();
    const existing = this.state.areas[id] || {};
    const area = {
      ...existing,
      id,
      name: String(input.name).trim(),
      icon: String(input.icon || existing.icon || "room").trim(),
      updatedAt: new Date().toISOString(),
    };
    this.state.areas[id] = area;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(area);
  }

  findAreaByName(name) {
    const needle = String(name || "").trim().toLocaleLowerCase();
    if (!needle) return null;
    return this.listAreas().find((area) => String(area.name || "").trim().toLocaleLowerCase() === needle) || null;
  }

  async ensureAreaByName(name, options = {}) {
    const requestedName = String(name || "").trim();
    if (!requestedName) throw new Error("area name is required");
    const existing = this.findAreaByName(requestedName);
    if (existing) return { area: existing, created: false };
    const area = await this.saveArea({ name: requestedName, icon: options.icon }, options.id || crypto.randomUUID());
    return { area, created: true };
  }

  async removeArea(id) {
    const areaId = String(id || "");
    const area = this.state.areas[areaId];
    if (!area) return { removed: false, areaId, deviceAssignmentsCleared: 0, entityAssignmentsCleared: 0 };
    const before = this.snapshot();
    let deviceAssignmentsCleared = 0;
    let entityAssignmentsCleared = 0;
    delete this.state.areas[areaId];
    for (const device of Object.values(this.state.devices)) {
      const inheritedAreaAssignment = device.areaId === areaId;
      if (device.areaId === areaId) {
        device.areaId = null;
        deviceAssignmentsCleared += 1;
      }
      for (const entity of Object.values(device.entities || {})) {
        if (entity && (entity.areaId === areaId || (inheritedAreaAssignment && entity.areaId === undefined))) {
          entity.areaId = null;
          entityAssignmentsCleared += 1;
        }
      }
      if (device.setup?.status === "ready" && device.areaId === null) {
        device.setup = normalizeSetup(device.setup, { status: "needs_setup", reason: "area_and_label_required" });
        device.setup.status = "needs_setup";
        device.setup.completedAt = null;
        device.setup.updatedAt = new Date().toISOString();
        device.setup.reason = "area_and_label_required";
        device.presentation = buildPresentation(device);
      }
    }
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return { removed: true, areaId, areaName: area.name, deviceAssignmentsCleared, entityAssignmentsCleared };
  }

  async deleteArea(id) {
    return (await this.removeArea(id)).removed;
  }

  listLabels() {
    return Object.values(this.state.labels).map(clone).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  getLabel(id) {
    const label = this.state.labels[id];
    return label ? clone(label) : null;
  }

  async saveLabel(input, id = crypto.randomUUID()) {
    if (!input || !String(input.name || "").trim()) throw new Error("label name is required");
    if (!input.id && !Object.prototype.hasOwnProperty.call(this.state.labels, id)) {
      const normalized = String(input.name).trim().replace(/\s+/g, " ").toLowerCase();
      const duplicate = Object.values(this.state.labels).find((label) => String(label.name || "").trim().replace(/\s+/g, " ").toLowerCase() === normalized);
      if (duplicate) return clone(duplicate);
    }
    const before = this.snapshot();
    const existing = this.state.labels[id] || {};
    const label = {
      ...existing,
      id,
      name: String(input.name).trim(),
      color: String(input.color || existing.color || "teal").trim(),
      updatedAt: new Date().toISOString(),
    };
    this.state.labels[id] = label;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(label);
  }

  async deleteLabel(id) {
    if (APPROVED_LABELS.has(String(id || "").trim().toLowerCase())) return false;
    const existed = Boolean(this.state.labels[id]);
    if (!existed) return false;
    const before = this.snapshot();
    delete this.state.labels[id];
    for (const device of Object.values(this.state.devices)) {
      device.labels = normalizeIds(device.labels).filter((labelId) => labelId !== id);
      device.labelIds = normalizeIds(device.labelIds || device.labels).filter((labelId) => labelId !== id);
      for (const entity of Object.values(device.entities || {})) {
        entity.labels = normalizeIds(entity.labels).filter((labelId) => labelId !== id);
        entity.labelIds = normalizeIds(entity.labelIds).filter((labelId) => labelId !== id);
      }
      if (device.setup?.status === "ready" && !labelId(device)) {
        device.setup = normalizeSetup(device.setup, { status: "needs_setup", reason: "area_and_label_required" });
        device.setup.status = "needs_setup";
        device.setup.completedAt = null;
        device.setup.updatedAt = new Date().toISOString();
        device.setup.reason = "area_and_label_required";
      }
      device.presentation = buildPresentation(device);
    }
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return true;
  }

  getZigbee() {
    return clone(this.state.zigbee || { adapterPath: "", adapterName: "", adapterType: "", recommended: false });
  }

  async saveZigbee(input = {}) {
    const existing = this.state.zigbee || {};
    const before = this.snapshot();
    const adapterPath = String(input.adapterPath === undefined ? (existing.adapterPath || "") : input.adapterPath).trim();
    this.state.zigbee = {
      ...existing,
      adapterPath,
      adapterName: String(input.adapterName === undefined ? (existing.adapterName || "") : input.adapterName).trim(),
      adapterType: String(input.adapterType === undefined ? (existing.adapterType || "") : input.adapterType).trim(),
      recommended: input.recommended === undefined ? Boolean(existing.recommended) : Boolean(input.recommended),
      discoveryPrefix: String(input.discoveryPrefix === undefined ? (existing.discoveryPrefix || "dinodia-ha") : input.discoveryPrefix).trim() || "dinodia-ha",
      removedAdapterPaths: normalizeIds(input.removedAdapterPaths === undefined ? existing.removedAdapterPaths : input.removedAdapterPaths).filter((removedPath) => removedPath !== adapterPath),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getZigbee();
  }

  async clearZigbee(adapterPath = "") {
    const before = this.snapshot();
    const existing = this.state.zigbee || {};
    const removedPath = String(adapterPath || existing.adapterPath || "").trim();
    const removedAdapterPaths = normalizeIds(existing.removedAdapterPaths);
    if (removedPath && !removedAdapterPaths.includes(removedPath)) removedAdapterPaths.push(removedPath);
    this.state.zigbee = {
      ...existing,
      adapterPath: "",
      adapterName: "",
      adapterType: "",
      recommended: false,
      removedAdapterPaths,
      updatedAt: new Date().toISOString(),
    };
    if (this.state.configEntries?.ce_zigbee) delete this.state.configEntries.ce_zigbee;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getZigbee();
  }

  async markZigbeeAdapterRemoved(adapterPath) {
    const pathValue = String(adapterPath || "").trim();
    if (!pathValue) throw new Error("adapterPath is required");
    const before = this.snapshot();
    const existing = this.state.zigbee || {};
    const removedAdapterPaths = normalizeIds(existing.removedAdapterPaths);
    if (!removedAdapterPaths.includes(pathValue)) removedAdapterPaths.push(pathValue);
    this.state.zigbee = { ...existing, removedAdapterPaths, updatedAt: new Date().toISOString() };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getZigbee();
  }

  getThread() {
    return clone(this.state.thread || { configured: false, rcpDevice: "", rcpName: "", baudRate: 460800, infraIf: "eth0", threadIf: "wpan0" });
  }

  async saveThread(input = {}) {
    const before = this.snapshot();
    const existing = this.state.thread || {};
    this.state.thread = {
      ...existing,
      configured: input.configured === undefined ? Boolean(existing.configured) : Boolean(input.configured),
      rcpDevice: String(input.rcpDevice === undefined ? (existing.rcpDevice || "") : input.rcpDevice).trim(),
      rcpName: String(input.rcpName === undefined ? (existing.rcpName || "") : input.rcpName).trim(),
      baudRate: Number(input.baudRate === undefined ? (existing.baudRate || 460800) : input.baudRate) || 460800,
      infraIf: String(input.infraIf === undefined ? (existing.infraIf || "eth0") : input.infraIf).trim() || "eth0",
      threadIf: String(input.threadIf === undefined ? (existing.threadIf || "wpan0") : input.threadIf).trim() || "wpan0",
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getThread();
  }

  async clearThread() {
    return this.saveThread({ configured: false, rcpDevice: "", rcpName: "" });
  }

  async updateDevice(id, patch = {}) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const existing = this.state.devices[resolvedId];
    if (!existing) return null;
    return this.upsertDevice({
      ...existing,
      ...patch,
      id: resolvedId,
      name: patch.name === undefined ? existing.name : String(patch.name).trim(),
      areaId: patch.areaId === undefined ? existing.areaId : (patch.areaId ? String(patch.areaId) : null),
    });
  }

  previewDeviceSetup(id, input = {}) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const existing = this.state.devices[resolvedId];
    if (!existing) return null;
    const label = String(input.labelId || input.label_id || "").trim().toLowerCase();
    const areaId = String(input.areaId || input.area_id || "").trim();
    const preview = {
      ...existing,
      name: input.name === undefined ? existing.name : String(input.name || existing.name).trim(),
      areaId: areaId || null,
      labelIds: label ? [label] : [],
      labels: label ? [label] : [],
      setup: { ...(existing.setup || {}), status: "preview" },
    };
    return buildPresentation(preview);
  }

  async completeDeviceSetup(id, input = {}) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const existing = this.state.devices[resolvedId];
    if (!existing) return null;
    if (["zigbee", "matter"].includes(existing.protocol) && (existing.interviewStatus === "pending" || !Object.keys(existing.entities || {}).length)) throw Object.assign(new Error("The device has not finished discovery yet"), { statusCode: 409, code: "interview_incomplete" });
    const areaId = String(input.areaId || input.area_id || "").trim();
    if (!areaId || !this.state.areas[areaId]) throw Object.assign(new Error("Choose a provisioned area"), { statusCode: 400, code: "invalid_area" });
    const selectedLabel = String(input.labelId || input.label_id || "").trim().toLowerCase();
    if (!APPROVED_LABELS.has(selectedLabel)) throw Object.assign(new Error("Choose one of the approved device labels"), { statusCode: 400, code: "invalid_label" });
    const name = input.name === undefined ? existing.name : String(input.name || "").trim();
    if (name.length > 128) throw Object.assign(new Error("Device name is too long"), { statusCode: 400, code: "invalid_name" });
    const setup = {
      ...(existing.setup || {}),
      status: "ready",
      assignmentMode: "device_inherited_v1",
      completedAt: existing.setup?.completedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reason: null,
    };
    const updated = await this.upsertDevice({
      ...existing,
      id: resolvedId,
      name: name || existing.name || resolvedId,
      areaId,
      labelIds: [selectedLabel],
      labels: [selectedLabel],
      setup,
      presentation: null,
    });
    return updated;
  }

  async clearDeviceSetup(id) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const existing = this.state.devices[resolvedId];
    if (!existing) return null;
    return this.upsertDevice({
      ...existing,
      id: resolvedId,
      areaId: null,
      labelIds: [],
      labels: [],
      setup: { ...(existing.setup || {}), status: "needs_setup", completedAt: null, updatedAt: new Date().toISOString(), reason: "area_and_label_required" },
      presentation: null,
    });
  }

  async rebuildPresentation(id) {
    const resolvedId = this.state.aliases?.[String(id)] || String(id);
    const existing = this.state.devices[resolvedId];
    if (!existing) return null;
    const before = this.snapshot();
    existing.presentation = buildPresentation(existing);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getDevice(resolvedId);
  }

  async updateEntity(deviceId, entityId, patch = {}) {
    const resolvedDeviceId = this.state.aliases?.[String(deviceId)] || String(deviceId);
    const device = this.state.devices[resolvedDeviceId];
    if (!device) return null;
    const existing = device.entities && device.entities[entityId];
    if (!existing) return null;
    const before = this.snapshot();
    const labels = normalizeIds(patch.labelIds === undefined ? (patch.labels === undefined ? existing.labelIds : patch.labels) : patch.labelIds);
    device.entities[entityId] = {
      ...existing,
      ...clone(patch),
      id: entityId,
      deviceId: resolvedDeviceId,
      name: patch.name === undefined ? existing.name : String(patch.name).trim() || existing.name,
      labels,
      labelIds: labels,
      updatedAt: new Date().toISOString(),
    };
    device.presentation = buildPresentation(device);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(device.entities[entityId]);
  }

  async removeEntity(deviceId, entityId) {
    const resolvedDeviceId = this.state.aliases?.[String(deviceId)] || String(deviceId);
    const device = this.state.devices[resolvedDeviceId];
    if (!device || !device.entities || !device.entities[entityId]) return false;
    const before = this.snapshot();
    const removed = device.entities[entityId];
    delete device.entities[entityId];
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async renameEntity(deviceId, entityId, newEntityId, patch = {}) {
    const resolvedDeviceId = this.state.aliases?.[String(deviceId)] || String(deviceId);
    const device = this.state.devices[resolvedDeviceId];
    if (!device || !device.entities || !device.entities[entityId]) return null;
    const nextId = String(newEntityId || "").trim();
    if (!nextId) throw new Error("new entity ID is required");
    if (nextId !== entityId && device.entities[nextId]) throw new Error("entity ID already exists");
    const before = this.snapshot();
    const existing = device.entities[entityId];
    const previousHaEntityId = String(patch.previousHaEntityId || existing.haEntityId || existing.entityId || entityId);
    const entityPatch = { ...patch };
    delete entityPatch.previousHaEntityId;
    const next = {
      ...existing,
      ...clone(entityPatch),
      id: nextId,
      entityId: nextId,
      sourceId: existing.sourceId || existing.id || entityId,
      deviceId: String(resolvedDeviceId),
      updatedAt: new Date().toISOString(),
    };
    delete device.entities[entityId];
    device.entities[nextId] = next;
    this.state.aliases = { ...(this.state.aliases || {}), [entityId]: nextId, [previousHaEntityId]: nextId };
    for (const [id, automation] of Object.entries(this.state.automations || {})) this.state.automations[id] = replaceReference(automation, previousHaEntityId, nextId);
    for (const [id, binding] of Object.entries(this.state.remoteBindings || {})) this.state.remoteBindings[id] = replaceReference(binding, previousHaEntityId, nextId);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(next);
  }

  getIdentity() {
    return clone(this.state.identity || initialState().identity);
  }

  async saveIdentity(patch = {}) {
    this.state.identity = { ...(this.state.identity || {}), ...clone(patch) };
    await this.persist();
    return this.getIdentity();
  }

  getSetup() {
    return clone(this.state.setup || initialState().setup);
  }

  async saveSetup(patch = {}) {
    this.state.setup = { ...(this.state.setup || {}), ...clone(patch), updatedAt: new Date().toISOString() };
    await this.persist();
    return this.getSetup();
  }

  getAuth() {
    return clone(this.state.auth || initialState().auth);
  }

  async saveAuth(patch = {}) {
    this.state.auth = { ...(this.state.auth || {}), ...clone(patch) };
    await this.persist();
    return this.getAuth();
  }

  getSecurity() {
    return clone(this.state.security || initialState().security);
  }

  async saveSecurity(patch = {}) {
    this.state.security = {
      ...(this.state.security || initialState().security),
      ...clone(patch),
    };
    await this.persist();
    return this.getSecurity();
  }

  getPlatform() {
    return clone(this.state.platform || initialState().platform);
  }

  async savePlatform(patch = {}) {
    this.state.platform = { ...(this.state.platform || {}), ...clone(patch), lastError: patch.lastError === undefined ? (this.state.platform || {}).lastError || null : patch.lastError };
    await this.persist();
    return this.getPlatform();
  }

  getHive() {
    return clone(this.state.integrations?.hive || defaultHiveIntegration());
  }

  async saveHive(patch = {}) {
    const before = this.snapshot();
    const existing = this.state.integrations?.hive || defaultHiveIntegration();
    const ignoredDeviceIds = patch.ignoredDeviceIds === undefined ? existing.ignoredDeviceIds : normalizeIds(patch.ignoredDeviceIds);
    const allowed = new Set(["enabled", "configured", "status", "accountFingerprint", "maskedUsername", "adapterVersion", "connectedAt", "lastAttemptAt", "lastSuccessfulPollAt", "lastErrorCode", "lastErrorAt", "reauthRequired", "consecutiveFailures", "ignoredDeviceIds", "ignoredDeviceSummaries", "heatingDeviceCount", "hotWaterDeviceCount", "unsupportedProductCount"]);
    const safePatch = Object.fromEntries(Object.entries(clone(patch)).filter(([key]) => allowed.has(key)));
    if (safePatch.ignoredDeviceSummaries !== undefined) {
      safePatch.ignoredDeviceSummaries = Array.isArray(safePatch.ignoredDeviceSummaries)
        ? safePatch.ignoredDeviceSummaries.slice(0, 100).map((item) => ({ cloudId: String(item?.cloudId || "").slice(0, 256), name: String(item?.name || "Hive device").slice(0, 128), model: String(item?.model || "").slice(0, 128) })).filter((item) => item.cloudId)
        : [];
    }
    this.state.integrations = this.state.integrations || {};
    this.state.integrations.hive = {
      ...defaultHiveIntegration(),
      ...existing,
      ...safePatch,
      ignoredDeviceIds,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getHive();
  }

  async clearHive() {
    const before = this.snapshot();
    try {
      this.removeDeviceFromStateForProtocol("hive");
      if (this.state.configEntries?.ce_hive) delete this.state.configEntries.ce_hive;
      return await this.saveHive({
        configured: false,
        status: "disconnected",
        accountFingerprint: "",
        maskedUsername: "",
        connectedAt: null,
        lastAttemptAt: null,
        lastSuccessfulPollAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        reauthRequired: false,
        consecutiveFailures: 0,
        ignoredDeviceIds: [],
        ignoredDeviceSummaries: [],
        heatingDeviceCount: 0,
        hotWaterDeviceCount: 0,
        unsupportedProductCount: 0,
      });
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  getGoogleNest() {
    return clone(this.state.integrations?.googleNest || defaultGoogleNestIntegration());
  }

  getAlexa() {
    const value = this.state.integrations?.alexa || {};
    return clone({ enabled: true, linked: false, status: "disconnected", endpointCount: 0, catalogRevision: null, lastSuccessfulSyncAt: null, lastStatusCheckAt: null, errorCode: null, lastErrorAt: null, directiveReceipts: [], ...value });
  }

  async saveAlexa(patch = {}) {
    const before = this.snapshot();
    const existing = this.state.integrations?.alexa || this.getAlexa();
    const allowed = new Set(["enabled", "linked", "status", "endpointCount", "catalogRevision", "lastSuccessfulSyncAt", "lastStatusCheckAt", "errorCode", "lastErrorAt", "directiveReceipts"]);
    const safePatch = Object.fromEntries(Object.entries(clone(patch)).filter(([key]) => allowed.has(key)));
    if (safePatch.directiveReceipts !== undefined) {
      safePatch.directiveReceipts = Array.isArray(safePatch.directiveReceipts)
        ? safePatch.directiveReceipts.slice(0, 100).map((receipt) => ({
          messageId: String(receipt?.messageId || "").slice(0, 180),
          status: String(receipt?.status || "completed").slice(0, 32),
          response: receipt?.response && typeof receipt.response === "object" ? clone(receipt.response) : null,
          completedAt: receipt?.completedAt || null,
          expiresAt: receipt?.expiresAt || null,
        })).filter((receipt) => receipt.messageId)
        : [];
    }
    this.state.integrations = this.state.integrations || {};
    const currentReceipts = Array.isArray(existing.directiveReceipts) ? existing.directiveReceipts : [];
    const nextReceipts = safePatch.directiveReceipts === undefined ? currentReceipts : safePatch.directiveReceipts;
    this.state.integrations.alexa = { enabled: true, linked: false, status: "disconnected", endpointCount: 0, catalogRevision: null, lastSuccessfulSyncAt: null, lastStatusCheckAt: null, errorCode: null, lastErrorAt: null, directiveReceipts: [], ...existing, ...safePatch, directiveReceipts: nextReceipts, updatedAt: new Date().toISOString() };
    try { await this.persist(); } catch (error) { this.state = before; throw error; }
    return this.getAlexa();
  }

  async saveGoogleNest(patch = {}) {
    const before = this.snapshot();
    const existing = this.state.integrations?.googleNest || defaultGoogleNestIntegration();
    const allowed = new Set(["enabled", "configured", "status", "releaseChannel", "accountFingerprint", "connectedAt", "lastAuthorizationAttemptAt", "lastSuccessfulPollAt", "nextPollAt", "lastErrorCode", "lastErrorAt", "reauthRequired", "consecutiveFailures", "thermostatDeviceCount", "unsupportedDeviceCount", "ignoredDeviceIds", "ignoredDeviceSummaries"]);
    const safePatch = Object.fromEntries(Object.entries(clone(patch)).filter(([key]) => allowed.has(key)));
    if (safePatch.ignoredDeviceIds !== undefined) safePatch.ignoredDeviceIds = normalizeIds(safePatch.ignoredDeviceIds);
    if (safePatch.ignoredDeviceSummaries !== undefined) {
      safePatch.ignoredDeviceSummaries = Array.isArray(safePatch.ignoredDeviceSummaries)
        ? safePatch.ignoredDeviceSummaries.slice(0, 100).map((item) => ({ identityHash: String(item?.identityHash || "").slice(0, 64), name: String(item?.name || "Google Nest thermostat").slice(0, 128), model: String(item?.model || "").slice(0, 128) })).filter((item) => item.identityHash)
        : [];
    }
    this.state.integrations = this.state.integrations || {};
    this.state.integrations.googleNest = { ...defaultGoogleNestIntegration(), ...existing, ...safePatch, ignoredDeviceIds: safePatch.ignoredDeviceIds === undefined ? normalizeIds(existing.ignoredDeviceIds) : safePatch.ignoredDeviceIds, updatedAt: new Date().toISOString() };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getGoogleNest();
  }

  async clearGoogleNest() {
    const before = this.snapshot();
    try {
      this.removeDeviceFromStateForProtocol("google_nest");
      if (this.state.configEntries?.ce_google_nest) delete this.state.configEntries.ce_google_nest;
      return await this.saveGoogleNest({ configured: false, status: "disconnected", releaseChannel: "sandbox_beta", accountFingerprint: "", connectedAt: null, lastAuthorizationAttemptAt: null, lastSuccessfulPollAt: null, nextPollAt: null, lastErrorCode: null, lastErrorAt: null, reauthRequired: false, consecutiveFailures: 0, thermostatDeviceCount: 0, unsupportedDeviceCount: 0, ignoredDeviceIds: [], ignoredDeviceSummaries: [] });
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  getHeatingDemandController() {
    return clone(normalizeHeatingDemandControllerState(this.state.heatingDemandController));
  }

  async saveHeatingDemandControllerConfig(config = {}) {
    const before = this.snapshot();
    const current = normalizeHeatingDemandControllerState(this.state.heatingDemandController);
    const next = normalizeHeatingDemandControllerState({ ...current, config: { ...current.config, ...clone(config) } });
    this.state.heatingDemandController = next;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getHeatingDemandController();
  }

  async saveHeatingDemandControllerRuntime(runtime = {}) {
    const before = this.snapshot();
    const current = normalizeHeatingDemandControllerState(this.state.heatingDemandController);
    this.state.heatingDemandController = normalizeHeatingDemandControllerState({
      ...current,
      runtime: { ...current.runtime, ...clone(runtime) },
    });
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getHeatingDemandController();
  }

  async resetHeatingDemandControllerRuntime() {
    return this.saveHeatingDemandControllerRuntime({
      ...DEFAULT_HEATING_DEMAND_RUNTIME,
      status: "waiting_for_devices",
      lastEvaluationError: null,
      lastCommand: null,
      commandPending: null,
      lastPhysicalActuationVerifiedAt: null,
    });
  }

  updateHeatingDemandControllerDeviceReferences(fromId, toId = null) {
    const controller = normalizeHeatingDemandControllerState(this.state.heatingDemandController);
    const source = String(fromId || "");
    const target = toId ? String(toId) : null;
    if (!source) return false;
    let changed = false;
    if (controller.config.boilerDeviceId === source) {
      controller.config.boilerDeviceId = target;
      changed = true;
    }
    const nextRadiators = controller.config.radiatorDeviceIds
      .map((id) => id === source ? target : id)
      .filter(Boolean);
    if (JSON.stringify(nextRadiators) !== JSON.stringify(controller.config.radiatorDeviceIds)) {
      controller.config.radiatorDeviceIds = [...new Set(nextRadiators)];
      changed = true;
    }
    if (changed) {
      controller.runtime = {
        ...controller.runtime,
        status: "degraded",
        lastEvaluationError: target ? null : "mapped_device_removed",
        commandPending: null,
      };
      this.state.heatingDemandController = controller;
    }
    return changed;
  }

  removeDeviceFromStateForProtocol(protocol) {
    const requested = String(protocol || "").trim().toLowerCase();
    const ids = Object.values(this.state.devices || {})
      .filter((device) => String(device.protocol || "").toLowerCase() === requested)
      .map((device) => String(device.id));
    ids.forEach((id) => this.removeDeviceFromState(id));
    return ids;
  }

  getConfigEntries() {
    return clone(this.state.configEntries || {});
  }

  async saveConfigEntry(entry) {
    if (!entry || !entry.entry_id || !entry.domain) throw new Error("config entry requires entry_id and domain");
    const key = String(entry.entry_id);
    const next = clone(entry);
    if (JSON.stringify(this.state.configEntries[key]) === JSON.stringify(next)) return clone(this.state.configEntries[key]);
    this.state.configEntries[key] = next;
    await this.persist();
    return clone(this.state.configEntries[key]);
  }

  async deleteConfigEntry(entryId) {
    const key = String(entryId || "").trim();
    if (!key || !this.state.configEntries?.[key]) return false;
    const before = this.snapshot();
    delete this.state.configEntries[key];
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  listRemoteBindings() {
    return Object.values(this.state.remoteBindings || {}).map(clone);
  }

  async saveRemoteBinding(binding) {
    if (!binding || !binding.id) throw new Error("binding.id is required");
    this.state.remoteBindings[String(binding.id)] = clone(binding);
    await this.persist();
    return clone(this.state.remoteBindings[String(binding.id)]);
  }

  async deleteRemoteBinding(id) {
    const existed = Boolean((this.state.remoteBindings || {})[id]);
    if (existed) {
      delete this.state.remoteBindings[id];
      await this.persist();
    }
    return existed;
  }

  async factoryReset() {
    this.state = initialState();
    await this.persist();
    return this.snapshot();
  }

  getCloudflare() {
    return clone(this.state.cloudflare || { mode: "disabled", hostname: "", token: "" });
  }

  async saveCloudflare(input = {}) {
    const existing = this.state.cloudflare || {};
    this.state.cloudflare = {
      ...existing,
      ...clone(input),
      mode: String(input.mode || existing.mode || "disabled"),
      hostname: String(input.hostname === undefined ? (existing.hostname || "") : input.hostname).trim(),
      token: String(input.token === undefined ? (existing.token || "") : input.token).trim(),
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    return this.getCloudflare();
  }

  listAutomations() {
    return Object.values(this.state.legacyAutomations || {}).map(clone).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  getAutomation(id) {
    const automation = (this.state.legacyAutomations || {})[id];
    return automation ? clone(automation) : null;
  }

  async saveAutomation(input, id = crypto.randomUUID()) {
    if (!input || !input.name || !input.trigger || !Array.isArray(input.actions)) {
      throw new Error("automation requires name, trigger and actions");
    }
    const automation = {
      id,
      name: String(input.name).trim(),
      enabled: input.enabled !== false,
      trigger: clone(input.trigger),
      triggers: clone(input.triggers || (Array.isArray(input.trigger) ? input.trigger : [input.trigger])),
      conditions: clone(input.conditions || []),
      actions: clone(input.actions),
      mode: String(input.mode || "single"),
      cooldownMs: Number.isFinite(Number(input.cooldownMs)) ? Math.max(0, Number(input.cooldownMs)) : 2000,
      updatedAt: new Date().toISOString(),
    };
    this.state.legacyAutomations[id] = automation;
    await this.persist();
    return clone(automation);
  }

  async deleteAutomation(id) {
    const existed = Boolean((this.state.legacyAutomations || {})[id]);
    delete this.state.legacyAutomations[id];
    if (existed) await this.persist();
    return existed;
  }

  nativeAutomationState() {
    return {
      automations: clone(this.state.automations || {}),
      automationTriggers: clone(this.state.automationTriggers || {}),
      automationActions: clone(this.state.automationActions || {}),
      automationOccurrences: clone(this.state.automationOccurrences || {}),
      automationExecutions: clone(this.state.automationExecutions || []),
      automationIdempotency: clone(this.state.automationIdempotency || {}),
      automationRuntime: clone(this.state.automationRuntime || {}),
    };
  }

  async mutateNativeAutomation(mutator) {
    return this.mutateAtomically((state) => mutator(state));
  }

  listNativeAutomations() {
    return Object.values(this.state.automations || {}).filter((item) => item && typeof item === "object" && item.id).map(clone).sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  }

  getNativeAutomation(id) {
    const value = (this.state.automations || {})[String(id || "")];
    if (!value) return null;
    const trigger = Object.values(this.state.automationTriggers || {}).find((candidate) => candidate.automationId === value.id) || null;
    const actions = Object.values(this.state.automationActions || {}).filter((candidate) => candidate.automationId === value.id).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
    return { automation: clone(value), trigger: clone(trigger), actions: clone(actions) };
  }

  listNativeTriggers(automationId = null) {
    return Object.values(this.state.automationTriggers || {}).filter((item) => automationId === null || item.automationId === String(automationId)).map(clone);
  }

  listNativeActions(automationId = null) {
    return Object.values(this.state.automationActions || {}).filter((item) => automationId === null || item.automationId === String(automationId)).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder)).map(clone);
  }

  listNativeActionsForDevice(deviceId) {
    return this.listNativeActions().filter((item) => item.deviceId === String(deviceId));
  }

  automationIdsForDevice(deviceId) {
    return [...new Set(this.listNativeActionsForDevice(deviceId).map((item) => String(item.automationId || "")).filter(Boolean))];
  }

  getAutomationOccurrence(id) {
    const value = this.state.automationOccurrences?.[String(id || "")];
    return value ? clone(value) : null;
  }

  listAutomationOccurrences(automationId = null) {
    return Object.values(this.state.automationOccurrences || {}).filter((item) => automationId === null || item.automationId === String(automationId)).map(clone);
  }

  async addEvent(event) {
    this.state.events.unshift({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...clone(event),
    });
    this.state.events = this.state.events.slice(0, 500);
    await this.persist();
  }

  listEvents(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return clone(this.state.events.slice(0, safeLimit));
  }

  getActivityState() {
    return clone(this.state.activity || initialActivityState());
  }

  async setActivityRuntime(patch = {}) {
    const before = this.snapshot();
    this.state.activity = { ...initialActivityState(), ...(this.state.activity || {}), ...clone(patch) };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getActivityState();
  }

  async appendActivity(record = {}, incidentEnvelope = null) {
    const before = this.snapshot();
    const activity = this.state.activity || initialActivityState();
    const occurredAt = String(record.occurredAt || new Date().toISOString());
    const next = {
      ...clone(record),
      schemaVersion: 1,
      id: String(record.id || crypto.randomUUID()),
      sequence: Number(activity.nextSequence || 1),
      occurredAt,
      updatedAt: String(record.updatedAt || occurredAt),
    };
    activity.nextSequence = next.sequence + 1;
    activity.records = [next, ...(activity.records || [])]
      .filter((entry) => isRetainedActivityRecord(entry))
      .slice(0, Number(activity.maxRecords || ACTIVITY_MAX_RECORDS));
    this.state.activity = activity;
    if (incidentEnvelope) this.queueIncidentEnvelopeInState(incidentEnvelope);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(next);
  }

  async updateActivity(id, patch = {}) {
    await this.pruneActivity();
    const before = this.snapshot();
    const index = (this.state.activity?.records || []).findIndex((record) => String(record.id) === String(id));
    if (index < 0) return null;
    const existing = this.state.activity.records[index];
    this.state.activity.records[index] = {
      ...existing,
      ...clone(patch),
      id: existing.id,
      sequence: existing.sequence,
      schemaVersion: 1,
      updatedAt: String(patch.updatedAt || new Date().toISOString()),
    };
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(this.state.activity.records[index]);
  }

  listActivity({ limit = 50, before = "", cursor = "", deviceId = "", severity = "", category = "" } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const beforeSequence = before || cursor ? Number(before || cursor) : Number.POSITIVE_INFINITY;
    const normalizedDeviceId = String(deviceId || "");
    const normalizedSeverity = String(severity || "").toLowerCase();
    const normalizedCategory = String(category || "").toLowerCase();
    const records = (this.state.activity?.records || [])
      .filter((record) => isRetainedActivityRecord(record))
      .filter((record) => Number(record.sequence || 0) < beforeSequence)
      .filter((record) => {
        if (!normalizedDeviceId) return true;
        const recordDeviceId = String(record.device?.id || record.deviceId || "");
        return normalizedDeviceId === "hub" ? !recordDeviceId : recordDeviceId === normalizedDeviceId;
      })
      .filter((record) => !normalizedSeverity || String(record.severity || "").toLowerCase() === normalizedSeverity)
      .filter((record) => !normalizedCategory || String(record.category || "").toLowerCase() === normalizedCategory)
      .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0));
    const page = records.slice(0, safeLimit);
    return {
      records: clone(page),
      nextCursor: page.length === safeLimit ? String(page[page.length - 1].sequence) : null,
      hasMore: records.length > page.length,
    };
  }

  listActivityDevices() {
    const devices = new Map();
    let hubSeen = false;
    for (const record of this.state.activity?.records || []) {
      const device = record.device && typeof record.device === "object" ? record.device : null;
      const id = String(device?.id || record.deviceId || "");
      if (!id) {
        hubSeen = true;
        continue;
      }
      if (!devices.has(id)) devices.set(id, { id, name: String(device?.name || id) });
    }
    const result = [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (hubSeen) result.unshift({ id: "hub", name: "Hub" });
    return result;
  }

  activityDeviceFilters() {
    return this.listActivityDevices();
  }

  async pruneActivity(now = new Date()) {
    const before = this.snapshot();
    const activity = this.state.activity || initialActivityState();
    const retained = (activity.records || []).filter((entry) => isRetainedActivityRecord(entry, now)).slice(0, Number(activity.maxRecords || ACTIVITY_MAX_RECORDS));
    const changed = retained.length !== (activity.records || []).length || retained.some((entry, index) => entry.id !== activity.records[index]?.id);
    if (!changed) return this.getActivityState();
    activity.records = retained;
    this.state.activity = activity;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getActivityState();
  }

  getActiveIncident(incidentId) {
    const value = this.state.activity?.activeIncidents?.[String(incidentId || "")];
    return value ? clone(value) : null;
  }

  async saveActiveIncident(incidentId, value) {
    const key = String(incidentId || "").trim();
    if (!key) throw new Error("incidentId is required");
    const before = this.snapshot();
    if (!this.state.activity) this.state.activity = initialActivityState();
    if (!this.state.activity.activeIncidents) this.state.activity.activeIncidents = {};
    if (value === null || value === undefined) delete this.state.activity.activeIncidents[key];
    else this.state.activity.activeIncidents[key] = clone(value);
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.getActiveIncident(key);
  }

  async resolveActiveIncident(incidentId, resolvedAt = new Date().toISOString()) {
    const existing = this.getActiveIncident(incidentId);
    if (!existing) return null;
    return this.saveActiveIncident(incidentId, { ...existing, state: "resolved", resolvedAt: String(resolvedAt) });
  }

  listPendingIncidentEnvelopes(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    return clone((this.state.incidentOutbox?.pending || []).slice(0, safeLimit));
  }

  pendingIncidentEnvelopes(limit = 50) {
    return this.listPendingIncidentEnvelopes(limit);
  }

  async queueIncidentEnvelope(envelope) {
    if (!envelope || !envelope.incidentId) throw new Error("incident envelope requires incidentId");
    const before = this.snapshot();
    const entry = this.queueIncidentEnvelopeInState(envelope);
    if (!entry) return null;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return clone(entry);
  }

  queueIncidentEnvelopeInState(envelope) {
    if (!envelope || !envelope.incidentId) throw new Error("incident envelope requires incidentId");
    if (!this.state.incidentOutbox) this.state.incidentOutbox = normalizeIncidentOutbox();
    const incidentId = String(envelope.incidentId);
    const revision = Number(envelope.revision || 1);
    const pending = this.state.incidentOutbox.pending || [];
    const existing = pending.find((entry) => String(entry.envelope?.id || entry.id || "") === String(envelope.id || "") || (String(entry.envelope?.incidentId || "") === incidentId && Number(entry.envelope?.revision || 0) === revision));
    if (existing) return clone(existing);
    const entry = {
      id: String(envelope.id || crypto.randomUUID()),
      envelope: clone(envelope),
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.state.incidentOutbox.pending = [...pending, entry].slice(-100);
    this.state.incidentOutbox.lastError = null;
    return entry;
  }

  async acknowledgeIncidentEnvelopes(ids = []) {
    const requested = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean));
    if (!requested.size) return { acknowledged: 0, pending: this.listPendingIncidentEnvelopes() };
    const before = this.snapshot();
    if (!this.state.incidentOutbox) this.state.incidentOutbox = normalizeIncidentOutbox();
    const now = new Date().toISOString();
    const remaining = [];
    let acknowledged = 0;
    for (const entry of this.state.incidentOutbox.pending || []) {
      if (requested.has(String(entry.id)) || requested.has(String(entry.envelope?.id || "")) || requested.has(String(entry.envelope?.incidentId || ""))) {
        this.state.incidentOutbox.acknowledged[String(entry.id)] = { acknowledgedAt: now, incidentId: entry.envelope?.incidentId || null, revision: entry.envelope?.revision || 0 };
        acknowledged += 1;
      } else remaining.push(entry);
    }
    this.state.incidentOutbox.pending = remaining;
    this.state.incidentOutbox.lastUploadAt = now;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return { acknowledged, pending: this.listPendingIncidentEnvelopes() };
  }

  async markIncidentUploadError(message) {
    const before = this.snapshot();
    if (!this.state.incidentOutbox) this.state.incidentOutbox = normalizeIncidentOutbox();
    this.state.incidentOutbox.lastError = String(message || "Incident upload failed");
    for (const entry of this.state.incidentOutbox.pending || []) entry.attempts = Number(entry.attempts || 0) + 1;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
}

module.exports = { Store, initialState, initialActivityState, isInfrastructureDevice, normalizeHeatingDemandControllerState };
