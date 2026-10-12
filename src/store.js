const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fixedLabelState } = require("./labelCatalog");
const { normalizeCapability, text } = require("./capabilities/schema");
const { buildPresentation, isConfigured, labelId, sourceFingerprint } = require("./capabilities/devicePresentation");
const { DEFAULT_HEATING_DEMAND_CONFIG, DEFAULT_HEATING_DEMAND_RUNTIME } = require("./heatingDemandController");
const { NATIVE_AUTOMATION_STORE_VERSION, LIMITS } = require("./automations/constants");
const { migrateLegacyAutomations } = require("./automations/legacyAdapter");
const { getSurfaces } = require("./capabilities/devicePresentation");
const { serializeDevice } = require("./contracts/dinodiaV1");
const { compactUnregisteredPropertyDeviceEvents, enqueueSyncEventInState, initialSyncOutbox, nextSyncBatch, normalizeSyncOutbox } = require("./sync/syncOutbox");
const { validateCloudConfiguration } = require("./sync/cloudConfiguration");
const { activityFor, advanceUsage, endUsageAssignment, initialUsageState, observeUsage } = require("./sync/usageBuckets");

function sourceTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .every((component, index) => component === Number(match[index + 1])) ? date.toISOString() : null;
}

function currentEntityValue(entity) {
  const value = entity?.state;
  return value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "state") ? value.state : value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePendingPropertyDevicePolicies(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [osDeviceId, policy] of Object.entries(source).slice(-5000)) {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(osDeviceId) || !policy || typeof policy !== "object" || Array.isArray(policy)
      || policy.managementClass !== "PROPERTY_DEVICE" || policy.ownerMembershipId != null
      || !["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle || ""))
      || !/^[0-9a-f-]{36}$/i.test(String(policy.platformDeviceId || ""))
      || !/^[0-9a-f-]{36}$/i.test(String(policy.installationRequestId || ""))
      || !Array.isArray(policy.canonicalAreaIds) || policy.canonicalAreaIds.length < 1 || policy.canonicalAreaIds.length > 64
      || policy.canonicalAreaIds.some((id) => !/^[0-9a-f-]{36}$/i.test(String(id)))
      || !["ready", "no_safe_controls", "unsupported"].includes(String(policy.catalogueStatus || ""))
      || typeof policy.usefulReadings !== "boolean"
      || !Number.isSafeInteger(Number(policy.descriptorRevision)) || Number(policy.descriptorRevision) < 1
      || !/^[a-f0-9]{64}$/i.test(String(policy.descriptorDigest || ""))) continue;
    result[osDeviceId] = {
      managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: String(policy.lifecycle),
      platformDeviceId: String(policy.platformDeviceId), installationRequestId: String(policy.installationRequestId),
      canonicalAreaIds: policy.canonicalAreaIds.map(String), catalogueStatus: String(policy.catalogueStatus), usefulReadings: policy.usefulReadings,
      descriptorRevision: Number(policy.descriptorRevision), descriptorDigest: String(policy.descriptorDigest),
      overrideName: typeof policy.overrideName === "string" ? policy.overrideName.slice(0, 80) : null,
    };
  }
  return result;
}

function nativeSyncDeviceProjection(device, policy = null) {
  const protocol = String(device?.protocol || "unknown").toLowerCase();
  const presentationRevision = Math.max(1, Number(device?.presentation?.descriptorRevision) || 1);
  const policyRevision = Number(policy?.descriptorRevision);
  const policyDigest = String(policy?.descriptorDigest || "");
  const descriptorIsCanonical = policy?.managementClass === "PROPERTY_DEVICE"
    && Number.isSafeInteger(policyRevision) && policyRevision > 0
    && /^[a-f0-9]{64}$/i.test(policyDigest)
    && presentationRevision === policyRevision;
  return {
    osDeviceId: String(device?.id || "").slice(0, 160),
    name: String(device?.name || device?.id || "Device").slice(0, 160),
    areaId: device?.areaId ? String(device.areaId).slice(0, 160) : null,
    protocol: ["zigbee", "matter", "thread", "hive", "google_nest"].includes(protocol) ? protocol : "unknown",
    deviceType: String(device?.deviceType || device?.metadata?.device_type || device?.protocol || "unknown").slice(0, 120),
    technicalLabel: String(device?.technicalLabel || device?.deviceType || device?.protocol || "device").slice(0, 80),
    descriptorRevision: presentationRevision,
    // The commissioning service records a public, reviewed descriptor digest
    // in Platform. Reusing the internal source-fingerprint digest at the same
    // revision creates a permanent same-revision conflict on the sync stream.
    // A genuinely newer OS descriptor still carries its new source digest.
    descriptorDigest: descriptorIsCanonical ? policyDigest
      : crypto.createHash("sha256").update(String(device?.presentation?.sourceFingerprint || ""), "utf8").digest("hex"),
    available: device?.available !== false,
    observedAt: device?.lastSeenAt ? String(device.lastSeenAt) : null,
  };
}

function nativeSyncControlCatalogProjection(state, device) {
  const policy = state.platform?.devicePolicies?.[String(device?.id || "")];
  const homeId = String(state.platform?.homeId || "");
  const areaId = String(device?.areaId || "");
  if (policy?.managementClass !== "PROPERTY_DEVICE" || !homeId || !areaId || device?.retired === true) return null;
  const dto = serializeDevice({
    device,
    homeId,
    homeMembershipId: "native-sync-projection",
    role: "OWNER",
    areaIds: [areaId],
    surfaces: getSurfaces(device),
    revision: Number(device?.presentation?.descriptorRevision || 0),
  });
  if (!dto) return null;
  // serializeDevice is the existing Native V1 public descriptor projection;
  // it strips live values and executable integration bindings.
  return {
    osDeviceId: dto.id,
    catalogRevision: dto.descriptorRevision,
    descriptorDigest: String(nativeSyncDeviceProjection(device, policy).descriptorDigest),
    controls: dto.controls,
  };
}

function nativeControlId(deviceId, endpointId, logicalKey, declared = "") {
  const candidate = String(declared || "");
  if (/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(candidate)
    && !/^(?:internal|ha|hass|homeassistant):/i.test(candidate)) return candidate;
  const digest = crypto.createHash("sha256").update(`${String(deviceId)}\n${String(endpointId)}\n${String(logicalKey)}`, "utf8").digest("hex").slice(0, 40);
  return `ctrl_${digest}`;
}

function enqueueNativeDeviceSync(state, previous, current, options = {}) {
  const id = String(current?.id || previous?.id || "");
  const policy = state.platform?.devicePolicies?.[id];
  // Tenant-owned devices remain local/private. Platform policy may be delivered
  // to the hub so the tenant can control them, but their device identity and
  // activity are never projected back into owner/manager cloud sync.
  if (!id || policy?.managementClass !== "PROPERTY_DEVICE") return;
  const currentProjection = nativeSyncDeviceProjection(current, policy);
  enqueueSyncEventInState(state, "device.upsert", id, currentProjection, options);
  const currentCatalog = nativeSyncControlCatalogProjection(state, current);
  if (!currentCatalog) return;
  const previousCatalog = previous ? nativeSyncControlCatalogProjection(state, previous) : null;
  if (previousCatalog && previousCatalog.catalogRevision === currentCatalog.catalogRevision
    && JSON.stringify(previousCatalog.controls) === JSON.stringify(currentCatalog.controls)) return;
  enqueueSyncEventInState(state, "control.catalog.upsert", id, currentCatalog, { critical: true });
  if (previousCatalog) {
    const retained = new Set(currentCatalog.controls.map((control) => String(control.controlId)));
    const removedControlIds = previousCatalog.controls.map((control) => String(control.controlId)).filter((controlId) => !retained.has(controlId));
    if (removedControlIds.length) enqueueSyncEventInState(state, "control.catalog.tombstone", id, {
      osDeviceId: id.slice(0, 160), catalogRevision: currentCatalog.catalogRevision,
      descriptorDigest: currentCatalog.descriptorDigest, controlIds: removedControlIds,
    }, { critical: true });
  }
}

function bucketEventProjection(bucket) {
  return {
    osDeviceId: bucket.osDeviceId, osAreaId: bucket.osAreaId, analyticsCategory: bucket.category,
    controlId: bucket.controlId, sourceGeneration: bucket.sourceGeneration, bucketStart: bucket.bucketStart,
    coverageStartAt: bucket.coverageStartAt, coverageEndAt: bucket.coverageEndAt,
    revision: bucket.revision, onSeconds: bucket.onSeconds, offSeconds: bucket.offSeconds,
    unknownSeconds: bucket.unknownSeconds, closedAt: bucket.closedAt, purgeAt: bucket.purgeAt,
  };
}

function queueUsageBucket(state, bucketKey, now) {
  const usage = state.syncUsage = initialUsageState(state.syncUsage);
  const bucket = usage.buckets[bucketKey];
  if (!bucket) return false;
  usage.queuedRevisions = usage.queuedRevisions || {};
  if (Number(usage.queuedRevisions[bucketKey] || 0) >= bucket.revision) return false;
  const aggregateId = crypto.createHash("sha256").update(bucketKey, "utf8").digest("hex");
  const event = enqueueSyncEventInState(state, "usage.bucket", aggregateId, bucketEventProjection(bucket), { now });
  if (!event) return false;
  usage.queuedRevisions[bucketKey] = bucket.revision;
  return true;
}

function recordDeviceSyncObservations(state, device, nowMs, options = {}) {
  const deviceId = String(device?.id || "");
  const policy = state.platform?.devicePolicies?.[deviceId];
  const generation = Number(state.identity?.generation || 0);
  if (!policy || policy.managementClass !== "PROPERTY_DEVICE" || policy.lifecycle === "RETIRED"
    || policy.lifecycle === "REMOVED" || policy.lifecycle === "REMOVAL_PENDING"
    || !["LIGHT", "BOILER", "RADIATOR"].includes(policy.analyticsCategory)
    || !Number.isSafeInteger(generation) || generation < 1) return;
  const catalog = nativeSyncControlCatalogProjection(state, device);
  if (!catalog) return;
  const entities = Object.values(device.entities || {});
  const usage = state.syncUsage = initialUsageState(state.syncUsage);
  const usageControls = catalog.controls.filter((control) => control.observable
    && Number.isSafeInteger(control.maxStateValiditySeconds) && control.maxStateValiditySeconds > 0
    && (policy.analyticsCategory === "LIGHT" && ["power", "brightness"].includes(String(control.semanticRole || "") )
      || policy.analyticsCategory === "RADIATOR" && control.semanticRole === "active_heat_demand"
      || policy.analyticsCategory === "BOILER" && control.semanticRole === "active_heat_production"));
  // One physical Light produces one activity series even when its descriptor
  // exposes both power and brightness. The frozen rule is logical OR for On;
  // independent per-control counters would double-count the same device.
  const selectedUsageControls = policy.analyticsCategory === "LIGHT"
    ? usageControls.filter((control) => control.semanticRole === "power").slice(0, 1).length
      ? usageControls.filter((control) => control.semanticRole === "power").slice(0, 1)
      : usageControls.filter((control) => control.semanticRole === "brightness").slice(0, 1)
    : usageControls.slice(0, 1);
  for (const control of selectedUsageControls) {
    const role = String(control.semanticRole || "");
    const entityFor = (item) => entities.find((entity) => String(entity.capability?.controlId || entity.controlId || entity.id || entity.sourceId || "") === item.controlId);
    let entity = entityFor(control);
    // Only adapter/source observation times establish telemetry freshness.
    // Entity update/snapshot read time is not evidence that the physical value
    // was observed now and must never renew analytics validity.
    let observedAt = sourceTimestamp(entity?.sourceObservedAt || "");
    let validUntil = null;
    let activity;
    if (policy.analyticsCategory === "LIGHT") {
      const signals = usageControls.filter((item) => ["power", "brightness"].includes(item.semanticRole)).map((item) => {
        const source = entityFor(item);
        const timestamp = sourceTimestamp(source?.sourceObservedAt || "");
        const observedMs = timestamp ? Date.parse(timestamp) : NaN;
        const validityMs = Math.min(item.maxStateValiditySeconds * 1000, 30 * 60 * 1000);
        if (!source || !Number.isFinite(observedMs) || observedMs > nowMs || nowMs - observedMs > 30 * 60 * 1000 || observedMs + validityMs <= nowMs) return null;
        return { role: item.semanticRole, value: currentEntityValue(source), observedAt: timestamp, validUntilMs: observedMs + validityMs };
      }).filter(Boolean);
      if (!signals.length) continue;
      const active = signals.some((signal) => signal.role === "power"
        ? signal.value === true || String(signal.value || "").trim().toLowerCase() === "on"
        : typeof signal.value === "number" && Number.isFinite(signal.value) && signal.value > 0);
      const inactive = signals.every((signal) => signal.role === "power"
        ? signal.value === false || String(signal.value || "").trim().toLowerCase() === "off"
        : typeof signal.value === "number" && Number.isFinite(signal.value) && signal.value === 0);
      activity = device.available === false ? "unknown" : active ? "on" : inactive ? "off" : "unknown";
      observedAt = signals.map((signal) => signal.observedAt).sort().at(-1);
      validUntil = new Date(Math.min(...signals.map((signal) => signal.validUntilMs))).toISOString();
      entity = entityFor(control);
    } else {
      if (!entity || !observedAt) continue;
      const observedMs = Date.parse(observedAt);
      if (observedMs > nowMs || nowMs - observedMs > 30 * 60 * 1000) continue;
      const validityMs = Math.min(control.maxStateValiditySeconds * 1000, policy.analyticsCategory === "RADIATOR" ? 30 * 60 * 1000 : Number.MAX_SAFE_INTEGER);
      validUntil = new Date(observedMs + validityMs).toISOString();
      activity = activityFor({ category: policy.analyticsCategory, role, value: currentEntityValue(entity), available: device.available !== false });
    }
    if (!observedAt || !validUntil || !activity) continue;
    if (Number.isSafeInteger(options.ignoreThroughMs) && Date.parse(observedAt) <= options.ignoreThroughMs) continue;
    const result = observeUsage(usage, {
      osDeviceId: deviceId,
      osAreaId: String(device.areaId || ""),
      category: policy.analyticsCategory,
      controlId: String(control.controlId),
      sourceGeneration: generation,
      activity,
      observedAt,
      validUntil,
      nowMs,
    });
    state.syncUsage = result.state;
    for (const key of result.changedBuckets) queueUsageBucket(state, key, nowMs);
  }

  // A temperature sample is accepted only from an explicitly observable
  // ambient-temperature descriptor and its source timestamp. Read time and
  // target temperature are never substituted for the sensor observation.
  if (policy.analyticsCategory === "RADIATOR") {
    for (const control of catalog.controls) {
      if (control.semanticRole !== "ambient_temperature" || !control.observable || !Number.isSafeInteger(control.maxStateValiditySeconds)) continue;
      const entity = entities.find((item) => String(item.capability?.controlId || item.controlId || item.id || item.sourceId || "") === control.controlId);
      const observedAt = sourceTimestamp(entity?.sourceObservedAt || "");
      const value = currentEntityValue(entity);
      if (!observedAt || typeof value !== "number" || !Number.isFinite(value) || value < -50 || value > 80) continue;
      const observedMs = Date.parse(observedAt);
      const validUntil = observedMs + Math.min(30 * 60 * 1000, control.maxStateValiditySeconds * 1000);
      // Current freshness expires at validUntil, but a delayed signed sync may
      // still carry legitimate historical evidence for the bounded retention
      // period. Do not replace source time with queue/delivery time.
      if (observedMs > nowMs || nowMs - observedMs > 366 * 24 * 60 * 60 * 1000) continue;
      if (Number.isSafeInteger(options.ignoreThroughMs) && observedMs <= options.ignoreThroughMs) continue;
      const sourceEventKey = crypto.createHash("sha256").update([deviceId, control.controlId, generation, observedAt].join("\n"), "utf8").digest("hex");
      usage.temperatureQueuedKeys = usage.temperatureQueuedKeys || [];
      if (usage.temperatureQueuedKeys.includes(sourceEventKey)) continue;
      const sample = enqueueSyncEventInState(state, "temperature.sample", sourceEventKey, {
        osDeviceId: deviceId, osAreaId: String(device.areaId || ""), controlId: String(control.controlId),
        sourceGeneration: generation, sourceEventKey, temperature: Math.round(value * 100) / 100,
        sourceObservedAt: observedAt, validUntil: new Date(validUntil).toISOString(), quality: "fresh",
      }, { now: nowMs });
      if (sample) usage.temperatureQueuedKeys = [...usage.temperatureQueuedKeys, sourceEventKey].slice(-1024);
    }
  }
}

function nativeIncidentSyncProjection(envelope = {}, state = null) {
  const incidentId = String(envelope.incidentId || "");
  const revision = Number(envelope.revision || 1);
  if (!incidentId || !Number.isSafeInteger(revision) || revision < 1) return null;
  const sourceDeviceId = String(envelope.device?.id || envelope.osDeviceId || envelope.deviceId || "").trim();
  if (sourceDeviceId) {
    const policy = state?.platform?.devicePolicies?.[sourceDeviceId];
    if (policy?.managementClass !== "PROPERTY_DEVICE" || policy.ownerMembershipId != null
      || !["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle || ""))) return null;
  }
  const incidentKey = crypto.createHash("sha256").update(incidentId, "utf8").digest("hex");
  const occurredAt = new Date(envelope.occurredAt || Date.now());
  const firstObservedAt = new Date(envelope.firstObservedAt || occurredAt);
  const lastObservedAt = new Date(envelope.lastObservedAt || occurredAt);
  const resolved = String(envelope.state || "open").toLowerCase() === "resolved";
  const resolvedAt = resolved && envelope.resolvedAt ? new Date(envelope.resolvedAt) : null;
  if (![occurredAt, firstObservedAt, lastObservedAt, ...(resolvedAt ? [resolvedAt] : [])].every((date) => Number.isFinite(date.getTime()))) return null;
  return {
    incidentKey,
    revision,
    kind: String(envelope.kind || "device_offline").toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80),
    state: resolved ? "resolved" : "open",
    severity: "critical",
    occurredAt: occurredAt.toISOString(),
    firstObservedAt: firstObservedAt.toISOString(),
    lastObservedAt: lastObservedAt.toISOString(),
    resolvedAt: resolvedAt?.toISOString() || null,
    osDeviceId: sourceDeviceId ? sourceDeviceId.slice(0, 160) : null,
  };
}

const ACTIVITY_MAX_RECORDS = 2000;
const ACTIVITY_RETENTION_MONTHS = 4;
const CANONICAL_PLATFORM_ORIGIN = "https://dinodia-platform-v2.vercel.app";

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
    })).slice(0, 10_000)
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
      apiUrl: "",
      paired: false,
      agentSeenVersion: 0,
      publishedVersion: 0,
      acceptedTokenHashes: [],
      areaBindings: [],
      homeId: null,
      cloudRevision: 0,
      cloudConfigurationChecksum: null,
      cloudConfiguration: null,
      devicePolicies: {},
      pendingPropertyDevicePolicies: {},
      pendingTenantDeviceRemovals: [],
      updaterStatus: null,
      updaterStatusRevision: 0,
      operatorCredentialStates: [],
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
    syncOutbox: initialSyncOutbox(),
    syncUsage: initialUsageState(),
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
  const devices = Object.fromEntries(Object.entries(rawDevices).map(([id, device]) => {
    const presentation = device.presentation && typeof device.presentation === "object" ? device.presentation : null;
    const revision = Number(presentation?.descriptorRevision);
    const hasCurrentRevision = Number.isSafeInteger(revision) && revision >= 1 && presentation?.sourceFingerprint === sourceFingerprint(device);
    return [id, {
      ...device,
      // Backfill a trustworthy monotonic catalog revision for older hub data
      // and reconcile any cached surface whose source entities changed while
      // the OS was stopped. The source fingerprint is computed from current
      // stored authority, never from a client-supplied revision.
      presentation: hasCurrentRevision ? presentation : buildPresentation({ ...device, presentation }, "1970-01-01T00:00:00.000Z"),
    }];
  }));
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
  const persistedPlatform = value.platform && typeof value.platform === "object" ? value.platform : {};
  const persistedCloudConfigurationValid = validateCloudConfiguration(persistedPlatform.cloudConfiguration, persistedPlatform);
  const persistedCloudDevicePolicies = persistedCloudConfigurationValid
    ? Object.fromEntries(persistedPlatform.cloudConfiguration.devicePolicies.map((policy) => [String(policy.osDeviceId), clone(policy)])) : {};
  const pendingPropertyDevicePolicies = normalizePendingPropertyDevicePolicies(persistedPlatform.pendingPropertyDevicePolicies);
  for (const osDeviceId of Object.keys(persistedCloudDevicePolicies)) delete pendingPropertyDevicePolicies[osDeviceId];
  const persistedApiUrl = String(persistedPlatform.apiUrl || "").replace(/\/$/, "");
  const productionPlatformUrl = String(process.env.NODE_ENV || "development") === "production"
    ? (persistedApiUrl === CANONICAL_PLATFORM_ORIGIN ? persistedApiUrl : "")
    : persistedApiUrl;
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
    // A persisted retired/foreign origin is discarded during state
    // normalisation. The runtime pairing configuration must explicitly supply
    // the canonical V2 origin before any production request can be made.
    platform: {
      ...base.platform,
      ...persistedPlatform,
      areaBindings: Array.isArray(persistedPlatform.areaBindings)
        ? persistedPlatform.areaBindings.filter((binding) => binding && typeof binding.areaId === "string" && binding.areaId.length > 0 && binding.areaId.length <= 160 && typeof binding.hubAreaId === "string" && binding.hubAreaId.length > 0 && binding.hubAreaId.length <= 160)
        : [],
      homeId: typeof persistedPlatform.homeId === "string" && persistedPlatform.homeId.length > 0 && persistedPlatform.homeId.length <= 160 ? persistedPlatform.homeId : null,
      cloudRevision: Math.max(0, Number(persistedPlatform.cloudRevision) || 0),
      policyRevision: Math.max(0, Number(persistedPlatform.policyRevision) || 0),
      cloudConfigurationChecksum: typeof persistedPlatform.cloudConfigurationChecksum === "string" && /^[a-f0-9]{64}$/i.test(persistedPlatform.cloudConfigurationChecksum) ? persistedPlatform.cloudConfigurationChecksum : null,
      cloudConfiguration: persistedCloudConfigurationValid ? persistedPlatform.cloudConfiguration : null,
      pendingPropertyDevicePolicies,
      devicePolicies: {
        ...pendingPropertyDevicePolicies,
        ...persistedCloudDevicePolicies,
      },
      pendingTenantDeviceRemovals: Array.isArray(persistedPlatform.pendingTenantDeviceRemovals)
        ? persistedPlatform.pendingTenantDeviceRemovals.filter((entry) => entry && typeof entry.osDeviceId === "string" && entry.osDeviceId.length > 0 && entry.osDeviceId.length <= 160 && typeof entry.ownerMembershipId === "string" && entry.ownerMembershipId.length > 0 && entry.ownerMembershipId.length <= 160 && Number.isSafeInteger(entry.cloudRevision) && entry.cloudRevision >= 0).slice(-500).map((entry) => ({ osDeviceId: entry.osDeviceId, ownerMembershipId: entry.ownerMembershipId, cloudRevision: entry.cloudRevision }))
        : [],
      updaterStatus: persistedPlatform.updaterStatus && typeof persistedPlatform.updaterStatus === "object" ? clone(persistedPlatform.updaterStatus) : null,
      updaterStatusRevision: Math.max(0, Number(persistedPlatform.updaterStatusRevision) || 0),
      operatorCredentialStates: Array.isArray(persistedPlatform.operatorCredentialStates)
        ? persistedPlatform.operatorCredentialStates.filter((entry) => entry && Number.isInteger(Number(entry.version))).map((entry) => ({ version: Number(entry.version), state: String(entry.state || ''), graceUntil: entry.graceUntil ? String(entry.graceUntil) : null }))
        : [],
      apiUrl: productionPlatformUrl,
    },
    heatingUsage: { ...base.heatingUsage, ...(value.heatingUsage && typeof value.heatingUsage === "object" ? value.heatingUsage : {}) },
    electricUsage: normalizeElectricUsageState(value.electricUsage),
    heatingDemandController: normalizeHeatingDemandControllerState(value.heatingDemandController),
    events: Array.isArray(value.events) ? value.events.slice(0, 500) : [],
    activity,
    incidentOutbox: normalizeIncidentOutbox(value.incidentOutbox),
    syncOutbox: normalizeSyncOutbox(value.syncOutbox),
    syncUsage: initialUsageState(value.syncUsage),
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
  const deviceLabels = normalizeIds(device.labelIds || device.labels);
  const childAreas = Object.values(existingAssignments || {}).map((item) => item?.areaId).filter(Boolean).map(String);
  const childLabels = Object.values(existingAssignments || {}).flatMap((item) => normalizeIds(item?.labelIds));
  const uniqueAreas = [...new Set(childAreas)];
  const uniqueLabels = [...new Set(childLabels)];
  const promotedArea = deviceArea || (uniqueAreas.length === 1 ? uniqueAreas[0] : null);
  const promotedLabel = deviceLabels.length === 1 ? String(deviceLabels[0]).toLowerCase() : uniqueLabels.length === 1 ? uniqueLabels[0] : null;
  const childConflict = uniqueAreas.length > 1;
  const canBeReady = !childConflict && validArea(promotedArea);
  const status = existingSetup.status && existingSetup.status !== "needs_setup"
    ? existingSetup.status
    : canBeReady ? "ready" : "needs_setup";
  const setup = normalizeSetup(existingSetup, {
    status,
    completedAt: canBeReady ? (existingSetup.completedAt || new Date(0).toISOString()) : null,
    reason: canBeReady ? null : childConflict ? "conflicting_legacy_assignments" : "area_required",
  });
  if (legacyVersion < 5) {
    setup.status = status;
    setup.reason = canBeReady ? null : childConflict ? "conflicting_legacy_assignments" : "area_required";
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
    const endpointId = String(entity.endpointId || previous.endpointId || "0");
    const logicalKey = String(entity.logicalKey || previous.logicalKey || stateKey);
    const capability = normalizeCapability(entity.capability || previous.capability || {}, {
      kind: ["state", "power"].includes(stateKey.toLowerCase()) ? "binary" : (entity.expose?.type === "numeric" ? "sensor" : undefined),
      category: entity.category || previous.category || "control",
      readable: entity.readable,
      writable: entity.writable,
      observable: entity.observable,
      stateKey,
      unit: entity.expose?.unit,
      deviceClass: entity.expose?.device_class,
      constraints: entity.expose,
    });
    capability.controlId = nativeControlId(deviceId, endpointId, logicalKey, capability.controlId || entity.controlId || previous.controlId);
    entities[entityId] = {
      ...previous,
      ...clone(entity),
      id: entityId,
      sourceId: String(entity.sourceId || previous.sourceId || entityId),
      deviceId: String(entity.deviceId || previous.deviceId || deviceId),
      stateKey,
      endpointId,
      logicalKey,
      capability,
      name: String(entity.name || previous.name || humanize(stateKey)),
      original_name: String(entity.original_name || previous.original_name || entity.name || previous.name || humanize(stateKey)),
      labels: normalizeIds(entity.labels || previous.labels),
      labelIds: normalizeIds(entity.labelIds || previous.labelIds || entity.labels || previous.labels),
      state: nextState,
      sourceObservedAt: sourceTimestamp(entity.sourceObservedAt || entity.observedAt || entity.last_changed || entity.lastChanged) || previous.sourceObservedAt || null,
      lastChanged: stateChanged ? new Date().toISOString() : (previous.lastChanged || previous.updatedAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }
  for (const stateKey of Object.keys(stateObject)) {
    const entityId = `${deviceId}:${stateKey}`;
    const matchingKey = Object.keys(entities).find((key) => key === entityId || entities[key]?.sourceId === entityId);
    const previous = (matchingKey && entities[matchingKey]) || {};
    if (matchingKey && matchingKey !== entityId) delete entities[matchingKey];
    const endpointId = String(previous.endpointId || "0");
    const logicalKey = String(previous.logicalKey || stateKey);
    const capability = normalizeCapability(previous.capability || {}, { kind: ["state", "power"].includes(stateKey.toLowerCase()) ? "binary" : "sensor", stateKey, writable: false });
    capability.controlId = nativeControlId(deviceId, endpointId, logicalKey, capability.controlId || previous.controlId);
    entities[entityId] = {
      ...previous,
      id: entityId,
      sourceId: String(previous.sourceId || entityId),
      deviceId: String(deviceId),
      stateKey,
      endpointId,
      logicalKey,
      capability,
      name: String(previous.name || humanize(stateKey)),
      original_name: String(previous.original_name || previous.name || humanize(stateKey)),
      labels: normalizeIds(previous.labels),
      labelIds: normalizeIds(previous.labelIds || previous.labels),
      state: clone(stateObject[stateKey]),
      sourceObservedAt: previous.sourceObservedAt || null,
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
    this.automationPolicyQueue = Promise.resolve();
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

  async withAutomationPolicyLock(work) {
    const previous = this.automationPolicyQueue;
    let release;
    this.automationPolicyQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  async applyCloudConfigurationSnapshot(platformPatch, runtimeAutomations = []) {
    return this.withAutomationPolicyLock(() => this.mutateAtomically((state) => {
      const previousPolicies = state.platform?.devicePolicies || {};
      const incomingPolicies = platformPatch.devicePolicies || {};
      const pendingRemovals = new Map((state.platform?.pendingTenantDeviceRemovals || []).map((entry) => [String(entry.osDeviceId), clone(entry)]));
      for (const [osDeviceId, previous] of Object.entries(previousPolicies)) {
        const next = incomingPolicies[osDeviceId];
        const previousOwner = String(previous?.ownerMembershipId || "");
        if (previous?.managementClass === "TENANT_DEVICE" && previousOwner
          && (!next || next.managementClass !== "TENANT_DEVICE" || String(next.ownerMembershipId || "") !== previousOwner
            || ["REMOVAL_PENDING", "REMOVED", "RETIRED", "RECOMMISSION_REQUIRED"].includes(String(next.lifecycle)))) {
          const local = state.devices?.[osDeviceId];
          const localOwner = String(local?.tenantOwnerMembershipId || local?.metadata?.tenantOwnerMembershipId || "");
          if (local && localOwner === previousOwner) pendingRemovals.set(osDeviceId, {
            osDeviceId, ownerMembershipId: previousOwner, cloudRevision: Number(platformPatch.cloudRevision || 0),
          });
        }
      }
      for (const [osDeviceId, policy] of Object.entries(incomingPolicies)) {
        if (policy?.managementClass !== "TENANT_DEVICE") continue;
        const local = state.devices?.[osDeviceId];
        if (!local) continue;
        const localOwner = String(local.tenantOwnerMembershipId || local.metadata?.tenantOwnerMembershipId || "");
        if (localOwner && localOwner !== String(policy.ownerMembershipId || "")) {
          pendingRemovals.set(osDeviceId, {
            osDeviceId, ownerMembershipId: localOwner, cloudRevision: Number(platformPatch.cloudRevision || 0),
          });
        }
        if (["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle)) && localOwner === String(policy.ownerMembershipId || "")
          && Array.isArray(policy.osAreaIds) && policy.osAreaIds.length === 1) {
          const nextAreaId = String(policy.osAreaIds[0]);
          if (String(local.areaId || local.metadata?.areaId || "") !== nextAreaId) {
            local.areaId = nextAreaId;
            local.metadata = { ...(local.metadata || {}), areaId: nextAreaId };
          }
        }
        if (["REMOVAL_PENDING", "REMOVED", "RETIRED", "RECOMMISSION_REQUIRED"].includes(String(policy.lifecycle)) && localOwner) {
          pendingRemovals.set(osDeviceId, {
            osDeviceId, ownerMembershipId: localOwner, cloudRevision: Number(platformPatch.cloudRevision || 0),
          });
        }
      }
      const pendingPropertyDevicePolicies = { ...(state.platform?.pendingPropertyDevicePolicies || {}) };
      for (const osDeviceId of Object.keys(incomingPolicies)) delete pendingPropertyDevicePolicies[osDeviceId];
      state.platform = { ...(state.platform || {}), ...clone(platformPatch), pendingPropertyDevicePolicies };
      state.platform.devicePolicies = { ...pendingPropertyDevicePolicies, ...incomingPolicies };
      const currentPropertyDeviceIds = new Set(Object.entries(incomingPolicies)
        .filter(([, policy]) => policy?.managementClass === "PROPERTY_DEVICE"
          && !["REMOVAL_PENDING", "REMOVED", "RETIRED", "RECOMMISSION_REQUIRED"].includes(String(policy.lifecycle)))
        .map(([osDeviceId]) => String(osDeviceId)));
      const syncOutbox = state.syncOutbox = normalizeSyncOutbox(state.syncOutbox);
      compactUnregisteredPropertyDeviceEvents(syncOutbox, currentPropertyDeviceIds);
      state.platform.pendingTenantDeviceRemovals = [...pendingRemovals.values()].slice(-500);
      state.automations = state.automations || {};
      state.automationTriggers = state.automationTriggers || {};
      state.automationActions = state.automationActions || {};
      const incoming = new Map(runtimeAutomations.map((record) => [String(record.automation.id), record]));
      for (const [id, automation] of Object.entries(state.automations)) {
        if (automation?.source !== "platform_sync" || incoming.has(String(id))) continue;
        for (const execution of state.automationExecutions || []) {
          if (execution.automationId === id && !execution.definitionSnapshot) {
            execution.definitionSnapshot = { id, name: automation.name, revision: automation.revision };
          }
        }
        delete state.automations[id];
        for (const [triggerId, trigger] of Object.entries(state.automationTriggers)) if (trigger.automationId === id) delete state.automationTriggers[triggerId];
        for (const [actionId, action] of Object.entries(state.automationActions)) if (action.automationId === id) delete state.automationActions[actionId];
      }
      for (const [id, record] of incoming) {
        const previous = state.automations[id];
        const definition = clone(record.automation);
        if (previous?.createdAt) definition.createdAt = previous.createdAt;
        state.automations[id] = definition;
        for (const [triggerId, trigger] of Object.entries(state.automationTriggers)) if (trigger.automationId === id) delete state.automationTriggers[triggerId];
        for (const [actionId, action] of Object.entries(state.automationActions)) if (action.automationId === id) delete state.automationActions[actionId];
        const trigger = clone(record.trigger);
        trigger.automationId = id;
        state.automationTriggers[trigger.id] = trigger;
        for (const action of record.actions) state.automationActions[action.id] = clone(action);
      }
      return { revision: Number(platformPatch.cloudRevision), activeAutomationCount: incoming.size };
    }));
  }

  listPendingTenantDeviceRemovals() {
    return clone(this.state.platform?.pendingTenantDeviceRemovals || []);
  }

  async acknowledgeTenantDeviceRemoval(osDeviceId) {
    const id = String(osDeviceId || "");
    if (!id) return false;
    return this.mutateAtomically((state) => {
      const current = state.platform?.pendingTenantDeviceRemovals || [];
      const next = current.filter((entry) => String(entry.osDeviceId) !== id);
      if (next.length === current.length) return false;
      state.platform.pendingTenantDeviceRemovals = next;
      return true;
    });
  }

  async persist() {
    const operation = this.writeQueue.then(async () => {
      this.state.updatedAt = new Date().toISOString();
      const serialized = JSON.stringify(this.state, null, 2);
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      // A PID-only temporary name collides when a controlled restart briefly
      // has two Store instances for the same durable path (for example, a
      // late completion from the stopped server racing the replacement). Each
      // atomic writer needs its own same-directory name before rename.
      const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(tempPath, serialized, { mode: 0o600, flag: "wx" });
        await fs.promises.rename(tempPath, this.filePath);
      } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
      }
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

  async upsertDevice(device, options = {}) {
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
    next.presentation = buildPresentation({ ...next, presentation: existing.presentation || null });
    const observationNow = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
    if (options.devicePolicy && typeof options.devicePolicy === "object" && !Array.isArray(options.devicePolicy)) {
      this.state.platform = this.state.platform || initialState().platform;
      this.state.platform.devicePolicies = { ...(this.state.platform.devicePolicies || {}), [id]: clone(options.devicePolicy) };
      if (options.devicePolicy.managementClass === "PROPERTY_DEVICE") {
        this.state.platform.pendingPropertyDevicePolicies = { ...(this.state.platform.pendingPropertyDevicePolicies || {}), [id]: clone(options.devicePolicy) };
      }
    }
    const areaChanged = Boolean(existing.id) && String(existing.areaId || "") !== String(next.areaId || "");
    if (areaChanged && existing.areaId) {
      const usage = this.state.syncUsage = initialUsageState(this.state.syncUsage);
      // Usage is recorded in integer seconds. Floor the assignment boundary
      // to that same precision so the serialized interval can never extend
      // past a millisecond-precision Area move.
      const assignmentEndMs = Math.floor(observationNow / 1000) * 1000;
      const ended = endUsageAssignment(usage, { osDeviceId: id, osAreaId: String(existing.areaId), endedAtMs: assignmentEndMs });
      this.state.syncUsage = ended.state;
      for (const key of ended.changedBuckets) queueUsageBucket(this.state, key, assignmentEndMs);
    }
    this.state.devices[id] = next;
    const devicePolicy = this.state.platform?.devicePolicies?.[id];
    const previousProjection = existing.id ? nativeSyncDeviceProjection(existing, devicePolicy) : null;
    const syncProjection = nativeSyncDeviceProjection(next, devicePolicy);
    if (this.state.platform?.devicePolicies?.[id] && (!previousProjection || JSON.stringify(previousProjection) !== JSON.stringify(syncProjection)
      || JSON.stringify(nativeSyncControlCatalogProjection(this.state, existing)?.controls || []) !== JSON.stringify(nativeSyncControlCatalogProjection(this.state, next)?.controls || []))) {
      enqueueNativeDeviceSync(this.state, existing.id ? existing : null, next, { critical: !previousProjection });
    }
    recordDeviceSyncObservations(this.state, next, observationNow, areaChanged ? { ignoreThroughMs: observationNow } : {});
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
    if (this.state.platform?.devicePolicies?.[sourceId]) enqueueSyncEventInState(this.state, "device.tombstone", sourceId, { osDeviceId: sourceId.slice(0, 160), removedAt: new Date().toISOString(), replacementOsDeviceId: targetId.slice(0, 160) }, { critical: true });
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
    if (this.state.platform?.devicePolicies?.[targetId]) enqueueNativeDeviceSync(this.state, target, this.state.devices[targetId], { critical: true });
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
    if (this.state.platform?.devicePolicies?.[resolvedId]) enqueueSyncEventInState(this.state, "device.tombstone", resolvedId, { osDeviceId: String(resolvedId).slice(0, 160), removedAt: new Date().toISOString() }, { critical: true });
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
    if (!existing.id || String(existing.name || "") !== area.name || String(existing.icon || "") !== area.icon) {
      enqueueSyncEventInState(this.state, "area.upsert", String(id), { osAreaId: String(id).slice(0, 160), name: area.name.slice(0, 160), icon: area.icon.slice(0, 40) }, { critical: !existing.id });
    }
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
    enqueueSyncEventInState(this.state, "area.tombstone", areaId, { osAreaId: areaId.slice(0, 160), removedAt: new Date().toISOString() }, { critical: true });
    let deviceAssignmentsCleared = 0;
    let entityAssignmentsCleared = 0;
    delete this.state.areas[areaId];
    for (const device of Object.values(this.state.devices)) {
      const previousDevice = clone(device);
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
      if (inheritedAreaAssignment) enqueueNativeDeviceSync(this.state, previousDevice, device);
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
    const selectedLabel = String(input.labelId || input.label_id || "").trim();
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
      labelIds: selectedLabel ? [selectedLabel] : normalizeIds(existing.labelIds || existing.labels),
      labels: selectedLabel ? [selectedLabel] : normalizeIds(existing.labels || existing.labelIds),
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
      setup: { ...(existing.setup || {}), status: "needs_setup", completedAt: null, updatedAt: new Date().toISOString(), reason: "area_required" },
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
    const previousDevice = clone(device);
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
    if (this.state.platform?.devicePolicies?.[resolvedDeviceId]) enqueueNativeDeviceSync(this.state, previousDevice, device);
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
    const previousDevice = clone(device);
    const removed = device.entities[entityId];
    delete device.entities[entityId];
    // Refresh the presentation immediately. Keeping a cached surface after
    // its source entity disappears can leave stale routes visible to readers
    // and command consumers until the next full device snapshot.
    device.presentation = buildPresentation(device);
    if (this.state.platform?.devicePolicies?.[resolvedDeviceId]) enqueueNativeDeviceSync(this.state, previousDevice, device, { critical: true });
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

  getSyncOutbox() {
    return clone(this.state.syncOutbox || initialSyncOutbox());
  }

  async reconcileRejectedDescriptorSync({ streamId, acceptedSequence, errorCode } = {}) {
    const before = this.snapshot();
    const noChange = () => {
      this.state = before;
      return { reconciled: false, compactedEvents: 0, refreshedDevices: 0 };
    };
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const accepted = Number(acceptedSequence);
      const batch = outbox.inFlight;
      if (errorCode !== "hub_sync_descriptor_stale" || outbox.lastErrorCode !== errorCode
        || String(streamId || "") !== outbox.streamId || !Number.isSafeInteger(accepted)
        || accepted !== outbox.acknowledgedSequence || !batch || batch.streamId !== outbox.streamId
        || outbox.gapDetected || outbox.criticalBacklog || outbox.telemetryPaused || outbox.droppedTelemetryCount !== 0
        || Number(batch.fromSequence) !== accepted + 1 || !Number.isSafeInteger(Number(batch.toSequence))
        || Number(batch.toSequence) < Number(batch.fromSequence) || !Array.isArray(batch.events)) {
        return noChange();
      }

      const batchFrom = Number(batch.fromSequence);
      const batchTo = Number(batch.toSequence);
      const range = outbox.events.filter((event) => event.sequence >= batchFrom && event.sequence <= batchTo);
      if (range.length !== batchTo - batchFrom + 1 || batch.events.length !== range.length
        || range.some((event, index) => event.sequence !== batchFrom + index
          || Number(batch.events[index]?.sequence) !== event.sequence
          || String(batch.events[index]?.id) !== event.id)) {
        return noChange();
      }

      const pending = outbox.events.filter((event) => event.sequence > accepted);
      const staleDeviceIds = new Set();
      const snapshotEventTypes = new Set(["device.upsert", "control.catalog.upsert", "control.catalog.tombstone"]);
      for (const event of range) {
        if (!snapshotEventTypes.has(event.type)) continue;
        const id = String(event.payload?.osDeviceId || "");
        const policy = this.state.platform?.devicePolicies?.[id];
        const device = this.state.devices?.[id];
        if (!id || event.aggregateId !== id || policy?.managementClass !== "PROPERTY_DEVICE"
          || !device || ["REMOVAL_PENDING", "REMOVED", "RETIRED", "RECOMMISSION_REQUIRED"].includes(String(policy.lifecycle))) continue;
        const current = nativeSyncDeviceProjection(device, policy);
        const expectedRevision = event.type === "device.upsert" ? current.descriptorRevision : Number(device.presentation?.descriptorRevision || 1);
        const eventRevision = Number(event.type === "device.upsert" ? event.payload?.descriptorRevision : event.payload?.catalogRevision);
        const expectedDigest = current.descriptorDigest;
        const eventDigest = String(event.payload?.descriptorDigest || "");
        if (!Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(eventRevision) || eventRevision < 1
          || !/^[a-f0-9]{64}$/i.test(expectedDigest) || !/^[a-f0-9]{64}$/i.test(eventDigest)) continue;
        if (eventRevision > expectedRevision) {
          return noChange();
        }
        if (eventRevision < expectedRevision || eventDigest !== expectedDigest) staleDeviceIds.add(id);
      }
      if (!staleDeviceIds.size) return noChange();

      const targetEvents = new Map();
      for (const id of staleDeviceIds) {
        const device = this.state.devices?.[id];
        const policy = this.state.platform?.devicePolicies?.[id];
        const current = device && policy ? nativeSyncDeviceProjection(device, policy) : null;
        if (!current || Number(device.presentation?.descriptorRevision || 1) !== current.descriptorRevision) {
          return noChange();
        }
        const hasPendingCatalog = pending.some((event) => ["control.catalog.upsert", "control.catalog.tombstone"].includes(event.type)
          && String(event.payload?.osDeviceId || "") === id);
        if (hasPendingCatalog && !nativeSyncControlCatalogProjection(this.state, device)) {
          return noChange();
        }
        for (const event of pending) {
          if (!snapshotEventTypes.has(event.type)
            || String(event.payload?.osDeviceId || "") !== id) continue;
          if (event.aggregateId !== id) return noChange();
          const eventRevision = Number(event.type === "device.upsert" ? event.payload?.descriptorRevision : event.payload?.catalogRevision);
          if (!Number.isSafeInteger(eventRevision) || eventRevision < 1 || eventRevision > current.descriptorRevision) {
            return noChange();
          }
          targetEvents.set(event.sequence, event);
        }
      }
      if (![...targetEvents.values()].some((event) => event.sequence >= batchFrom && event.sequence <= batchTo)) {
        return noChange();
      }

      const replacementSequence = outbox.nextSequence;
      for (const event of targetEvents.values()) {
        event.type = "sync.compacted";
        event.aggregateId = "";
        event.payload = { supersededBy: replacementSequence };
        event.critical = false;
      }
      for (const id of staleDeviceIds) {
        enqueueNativeDeviceSync(this.state, null, this.state.devices[id], { critical: true });
      }

      const reconciledOutbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const refreshedRange = reconciledOutbox.events.filter((event) => event.sequence >= batchFrom && event.sequence <= batchTo);
      const queueDepth = reconciledOutbox.events.filter((event) => event.sequence > accepted).length;
      reconciledOutbox.inFlight = {
        ...batch,
        events: refreshedRange.map(clone),
        queueDepth,
        runtime: batch.runtime && typeof batch.runtime === "object"
          ? { ...batch.runtime, capabilities: { ...(batch.runtime.capabilities || {}), nativeSyncOutbox: {
            ...(batch.runtime.capabilities?.nativeSyncOutbox || {}), queueDepth,
          } } }
          : batch.runtime,
      };
      await this.persist();
      return { reconciled: true, compactedEvents: targetEvents.size, refreshedDevices: staleDeviceIds.size };
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  getSyncRuntime(base = {}) {
    const outbox = normalizeSyncOutbox(this.state.syncOutbox);
    const remaining = outbox.events.filter((event) => event.sequence > outbox.acknowledgedSequence);
    const capabilities = base.capabilities && typeof base.capabilities === "object" && !Array.isArray(base.capabilities) ? clone(base.capabilities) : {};
    return {
      kind: "dinodia_os",
      version: String(base.version || "0.0.0"),
      capabilities: {
        ...capabilities,
        nativeSyncOutbox: {
          queueDepth: remaining.length,
          gapDetected: outbox.gapDetected,
          criticalBacklog: outbox.criticalBacklog,
          telemetryPaused: outbox.telemetryPaused,
          droppedTelemetryCount: outbox.droppedTelemetryCount,
          lastErrorCode: outbox.lastErrorCode,
        },
      },
    };
  }

  async queueSyncEvent(type, aggregateId, payload, options = {}) {
    const before = this.snapshot();
    try {
      const event = enqueueSyncEventInState(this.state, type, String(aggregateId || ""), payload, options);
      await this.persist();
      return event;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async prepareSyncBatch(hubInstallationId, runtime, now = Date.now(), options = {}) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const allowedTypesPrefix = Array.isArray(options.allowedTypesPrefix) ? options.allowedTypesPrefix.map(String) : null;
      if (outbox.inFlight && allowedTypesPrefix) {
        const serverAcceptedSequence = Number(options.serverAcceptedSequence);
        const serverStreamId = options.serverStreamId == null ? null : String(options.serverStreamId);
        const inFlight = outbox.inFlight;
        if (serverStreamId && serverStreamId !== outbox.streamId) throw new Error("Platform sync stream identity changed while an event batch was in flight");
        if (serverAcceptedSequence >= Number(inFlight.toSequence)) return clone(inFlight);
        if (serverAcceptedSequence !== Number(outbox.acknowledgedSequence)) {
          throw new Error("Platform sync cursor changed inside an unacknowledged range; refusing to rewrite the durable request");
        }
        // The authenticated Platform cursor proves that no event in this
        // range committed. It is now safe to narrow the request to the
        // contiguous Area-only prefix required by installation bootstrap.
        outbox.inFlight = null;
      }
      if (!outbox.inFlight) {
        outbox.inFlight = nextSyncBatch(outbox, {
          hubInstallationId, runtime: this.getSyncRuntime(runtime), now,
          ...(allowedTypesPrefix ? { allowedTypesPrefix } : {}),
          ...(typeof options.allowedEventPrefix === "function" ? { allowedEventPrefix: options.allowedEventPrefix } : {}),
        });
        outbox.lastAttemptAt = new Date(now).toISOString();
        await this.persist();
      }
      return clone(outbox.inFlight);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async prepareSyncStreamReconciliation({ previousStreamId, previousAcceptedSequence } = {}) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const previousId = String(previousStreamId || "");
      const previousSequence = Number(previousAcceptedSequence);
      if (!/^[a-zA-Z0-9._:-]{16,80}$/.test(previousId) || !Number.isSafeInteger(previousSequence) || previousSequence < 1
        || previousId === outbox.streamId) throw new Error("A current authoritative remote stream and cursor are required for reconciliation");
      if (outbox.acknowledgedSequence !== 0 || outbox.gapDetected || outbox.criticalBacklog
        || outbox.telemetryPaused || outbox.droppedTelemetryCount !== 0) {
        throw Object.assign(new Error("A local cursor or known retention gap requires explicit recovery before stream reconciliation"), { code: "hub_sync_stream_reconciliation_required" });
      }
      const batch = outbox.inFlight;
      if (!batch || batch.streamId !== outbox.streamId || Number(batch.fromSequence) !== 1
        || !Array.isArray(batch.events) || batch.events.length < 1 || Number(batch.events[0]?.sequence) !== 1
        || Number(batch.toSequence) !== Number(batch.events.at(-1)?.sequence)) {
        throw Object.assign(new Error("The complete durable first batch is not available for stream reconciliation"), { code: "hub_sync_stream_reconciliation_required" });
      }
      const appliedRevision = Number(outbox.configurationAppliedRevision);
      const batchRevision = Number(batch.acknowledgedCloudRevision ?? 0);
      if (!Number.isSafeInteger(appliedRevision) || appliedRevision < 0 || appliedRevision !== Number(outbox.cloudRevision)
        || !Number.isSafeInteger(batchRevision) || batchRevision < 0 || batchRevision > appliedRevision) {
        throw Object.assign(new Error("The durable batch configuration revision cannot be reconciled with the applied snapshot"), { code: "hub_sync_configuration_ack_invalid" });
      }
      const existing = batch.streamReconciliation;
      if (existing) {
        if (existing.version !== 1 || String(existing.previousStreamId) !== previousId
          || Number(existing.previousAcceptedSequence) !== previousSequence) {
          throw Object.assign(new Error("The exact in-flight reconciliation is bound to a different authoritative server cursor"), { code: "hub_sync_stream_reconciliation_required" });
        }
        if (batchRevision < appliedRevision) {
          // Only rewrite the acknowledgement metadata after the Platform
          // explicitly rejected the prior envelope for its stale revision.
          // A timeout/lost response must retry byte-for-byte because the
          // remote transition may already have committed.
          if (outbox.lastErrorCode !== "hub_sync_configuration_ack_invalid") {
            throw Object.assign(new Error("The marked in-flight batch has an uncertain prior result; preserving its exact request"), { code: "hub_sync_stream_reconciliation_required" });
          }
          batch.acknowledgedCloudRevision = appliedRevision;
          await this.persist();
        }
        return clone(batch);
      }
      batch.streamReconciliation = {
        version: 1,
        previousStreamId: previousId,
        previousAcceptedSequence: previousSequence,
      };
      // This is the first request carrying the stream-transition marker. The
      // authenticated, durably applied configuration snapshot is the revision
      // that this new envelope must acknowledge, even if its event batch was
      // prepared before that snapshot arrived.
      batch.acknowledgedCloudRevision = appliedRevision;
      await this.persist();
      return clone(batch);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async ensureSyncSnapshot(now = Date.now()) {
    const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
    const before = this.snapshot();
    try {
      let changed = false;
      if (!outbox.snapshotCreatedAt) {
        for (const area of Object.values(this.state.areas || {})) {
          enqueueSyncEventInState(this.state, "area.upsert", String(area.id), { osAreaId: String(area.id).slice(0, 160), name: String(area.name || area.id).slice(0, 160), icon: String(area.icon || "room").slice(0, 40) }, { now, critical: true });
        }
        outbox.snapshotCreatedAt = new Date(now).toISOString();
        changed = true;
      }
      for (const device of Object.values(this.state.devices || {})) {
        const deviceId = String(device.id);
        if (this.state.platform?.devicePolicies?.[deviceId]?.managementClass === "PROPERTY_DEVICE" && !outbox.snapshotDeviceIds.includes(deviceId)) {
          enqueueNativeDeviceSync(this.state, null, device, { now, critical: true });
          outbox.snapshotDeviceIds.push(deviceId);
          changed = true;
        }
      }
      if (changed) await this.persist();
      return changed;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async advanceSyncUsage(now = Date.now()) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isSafeInteger(nowMs)) throw new Error("Invalid native usage advance time");
    const before = this.snapshot();
    try {
      const usage = this.state.syncUsage = initialUsageState(this.state.syncUsage);
      const advanced = advanceUsage(usage, nowMs);
      this.state.syncUsage = advanced.state;
      let queued = 0;
      for (const key of advanced.changedBuckets) if (queueUsageBucket(this.state, key, nowMs)) queued += 1;
      // A prior telemetry-pressure condition is retried from the locally
      // durable absolute bucket revision, never by incrementing cloud totals.
      for (const [key, bucket] of Object.entries(this.state.syncUsage.buckets)) {
        if (Number(this.state.syncUsage.queuedRevisions[key] || 0) < Number(bucket.revision)) {
          if (queueUsageBucket(this.state, key, nowMs)) queued += 1;
        }
      }
      const cutoff = nowMs - 366 * 24 * 60 * 60 * 1000;
      for (const [key, bucket] of Object.entries(this.state.syncUsage.buckets)) {
        if (Date.parse(bucket.purgeAt) > nowMs) continue;
        const queuedRevision = Number(this.state.syncUsage.queuedRevisions[key] || 0);
        const pending = this.state.syncOutbox.events.some((event) => event.type === "usage.bucket" && event.aggregateId === crypto.createHash("sha256").update(key, "utf8").digest("hex"));
        if (!pending && queuedRevision >= bucket.revision) {
          delete this.state.syncUsage.buckets[key];
          delete this.state.syncUsage.queuedRevisions[key];
        } else if (Date.parse(bucket.bucketStart) < cutoff) {
          this.state.syncOutbox.gapDetected = true;
        }
      }
      if (advanced.changedBuckets.length || queued || JSON.stringify(before.syncUsage) !== JSON.stringify(this.state.syncUsage)) await this.persist();
      return { changedBuckets: advanced.changedBuckets.length, queued };
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async ensureSyncIncidentEvents(now = Date.now()) {
    const before = this.snapshot();
    try {
      const pending = this.listPendingIncidentEnvelopes(100);
      let queued = 0;
      for (const entry of pending) {
        const incident = entry.envelope || {};
        const projection = nativeIncidentSyncProjection(incident, this.state);
        if (!projection) continue;
        const revision = projection.revision;
        const sequenceBefore = Number(this.state.syncOutbox?.nextSequence || 1);
        enqueueSyncEventInState(this.state, "incident.transition", projection.incidentKey, projection, { now, critical: true, dedupeRevision: revision });
        if (Number(this.state.syncOutbox?.nextSequence || 1) > sequenceBefore) queued += 1;
      }
      if (queued) await this.persist();
      return queued;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async ensureUpdaterStatusEvent(status, now = Date.now()) {
    if (!status || typeof status !== "object" || Array.isArray(status)) return false;
    const platform = this.state.platform || initialState().platform;
    const normalized = {
      trustState: ["ready", "unprovisioned"].includes(status.trustState) ? status.trustState : "unavailable",
      phase: ["idle", "downloading", "verifying", "staged", "maintenance", "activating", "health_check", "active", "failed", "rolled_back"].includes(status.phase) ? status.phase : "unavailable",
      activeReleaseVersion: typeof status.activeReleaseVersion === "string" ? status.activeReleaseVersion.slice(0, 96) : null,
      attemptId: typeof status.lastAttempt?.attemptId === "string" ? status.lastAttempt.attemptId.slice(0, 96) : null,
      releaseId: typeof status.lastAttempt?.releaseId === "string" ? status.lastAttempt.releaseId.slice(0, 96) : null,
      attemptPhase: ["downloading", "verifying", "staged", "maintenance", "activating", "health_check", "active", "failed", "rolled_back"].includes(status.lastAttempt?.phase) ? status.lastAttempt.phase : null,
      resultCode: typeof status.lastAttempt?.result === "string" ? status.lastAttempt.result.toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 96) || null : null,
      updatedAt: typeof status.lastAttempt?.updatedAt === "string" && Number.isFinite(Date.parse(status.lastAttempt.updatedAt)) ? new Date(status.lastAttempt.updatedAt).toISOString() : null,
      busy: status.busy === true,
    };
    if (JSON.stringify(platform.updaterStatus || null) === JSON.stringify(normalized)) return false;
    const before = this.snapshot();
    try {
      const revision = Number(platform.updaterStatusRevision || 0) + 1;
      enqueueSyncEventInState(this.state, "update.status", "hub-updater", { ...normalized, revision }, { now, critical: true, dedupeRevision: revision });
      this.state.platform = { ...platform, updaterStatus: normalized, updaterStatusRevision: revision };
      await this.persist();
      return true;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async ensureAutomationOutcomeEvents(now = Date.now()) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const acknowledged = new Set(outbox.acknowledgedAutomationOccurrences);
      const existing = new Set([...outbox.events, ...(outbox.inFlight?.events || [])]
        .filter((event) => event.type === "automation.outcome").map((event) => String(event.payload?.occurrenceId || event.aggregateId)));
      let queued = 0;
      for (const execution of this.state.automationExecutions || []) {
        const occurrenceId = String(execution.occurrenceId || "");
        const automation = this.state.automations?.[String(execution.automationId || "")];
        if (!occurrenceId || (execution.source !== "platform_sync" && automation?.source !== "platform_sync")
          || acknowledged.has(occurrenceId) || existing.has(occurrenceId)) continue;
        const outcomes = Array.isArray(execution.actionOutcomes) ? execution.actionOutcomes.slice(0, 32) : [];
        if (!outcomes.length || !execution.startedAt || !execution.completedAt) continue;
        const actionStatuses = { applied: 0, failed: 0, uncertain: 0, skipped: 0 };
        for (const outcome of outcomes) {
          if (["applied", "succeeded"].includes(String(outcome.status))) actionStatuses.applied += 1;
          else if (String(outcome.status) === "failed") actionStatuses.failed += 1;
          else if (["uncertain", "running"].includes(String(outcome.status))) actionStatuses.uncertain += 1;
          else actionStatuses.skipped += 1;
        }
        const status = ["succeeded", "partial", "failed", "interrupted", "skipped"].includes(String(execution.status))
          ? String(execution.status) : actionStatuses.failed || actionStatuses.uncertain ? "partial" : "succeeded";
        const sequenceBefore = Number(this.state.syncOutbox.nextSequence);
        enqueueSyncEventInState(this.state, "automation.outcome", occurrenceId, {
          occurrenceId: occurrenceId.slice(0, 160), automationId: String(execution.automationId),
          automationRevision: Number(execution.revision || automation.revision || 1), status,
          startedAt: String(execution.startedAt), completedAt: String(execution.completedAt),
          actionCount: outcomes.length, actionStatuses,
        }, { now, critical: true });
        if (Number(this.state.syncOutbox.nextSequence) > sequenceBefore) {
          queued += 1;
          existing.add(occurrenceId);
        }
      }
      if (queued) await this.persist();
      return queued;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async acknowledgeSyncBatch(receipt, now = Date.now()) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const batch = outbox.inFlight;
      if (!batch || !receipt || receipt.streamId !== outbox.streamId || Number(receipt.acceptedThroughSequence) !== batch.toSequence) {
        throw new Error("Platform sync acknowledgement does not match the durable in-flight range");
      }
      outbox.acknowledgedSequence = Math.max(outbox.acknowledgedSequence, batch.toSequence);
      const acceptedIncidentEvents = new Map((batch.events || []).filter((event) => event.type === "incident.transition")
        .map((event) => [`${event.payload.incidentKey}|${Number(event.payload.revision)}`, event]));
      if (acceptedIncidentEvents.size) {
        const remaining = [];
        for (const entry of this.state.incidentOutbox?.pending || []) {
          const incidentId = String(entry.envelope?.incidentId || "");
          const key = crypto.createHash("sha256").update(incidentId, "utf8").digest("hex");
          const eventKey = `${key}|${Number(entry.envelope?.revision || 1)}`;
          if (acceptedIncidentEvents.has(eventKey)) {
            this.state.incidentOutbox.acknowledged[String(entry.id)] = { acknowledgedAt: new Date(now).toISOString(), incidentKey: key, revision: Number(entry.envelope?.revision || 1) };
          } else remaining.push(entry);
        }
        this.state.incidentOutbox.pending = remaining;
        this.state.incidentOutbox.lastUploadAt = new Date(now).toISOString();
      }
      const acceptedAutomationOccurrences = (batch.events || [])
        .filter((event) => event.type === "automation.outcome")
        .map((event) => String(event.payload?.occurrenceId || event.aggregateId));
      if (acceptedAutomationOccurrences.length) {
        outbox.acknowledgedAutomationOccurrences = [...new Set([
          ...outbox.acknowledgedAutomationOccurrences, ...acceptedAutomationOccurrences,
        ])].slice(-500);
      }
      outbox.events = outbox.events.filter((event) => event.sequence > outbox.acknowledgedSequence);
      outbox.inFlight = null;
      const propertyDeviceIds = new Set(Object.entries(this.state.platform?.devicePolicies || {})
        .filter(([, policy]) => policy?.managementClass === "PROPERTY_DEVICE"
          && !["REMOVAL_PENDING", "REMOVED", "RETIRED", "RECOMMISSION_REQUIRED"].includes(String(policy.lifecycle)))
        .map(([osDeviceId]) => String(osDeviceId)));
      compactUnregisteredPropertyDeviceEvents(outbox, propertyDeviceIds);
      outbox.cloudRevision = Math.max(outbox.cloudRevision, Number(receipt.cloudRevision) || 0);
      // The caller has already validated and durably applied the returned
      // configuration before acknowledging this batch.
      outbox.configurationAppliedRevision = Math.max(outbox.configurationAppliedRevision, Number(receipt.cloudRevision) || 0);
      outbox.lastSuccessfulSyncAt = new Date(now).toISOString();
      outbox.lastErrorCode = null;
      // A successful contiguous batch does not repair events which were
      // previously compacted/dropped or a known retention gap. Only an
      // explicit future full-reconciliation receipt may clear this flag.
      outbox.gapDetected = outbox.gapDetected || receipt.resnapshotRequired === true;
      outbox.criticalBacklog = false;
      outbox.telemetryPaused = false;
      await this.persist();
      return this.getSyncOutbox();
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async acknowledgeSyncConfiguration(revision, now = Date.now()) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const next = Number(revision);
      if (!Number.isSafeInteger(next) || next < outbox.cloudRevision) throw new Error("Cloud configuration revision moved backwards");
      outbox.cloudRevision = next;
      outbox.configurationAppliedRevision = next;
      outbox.lastSuccessfulSyncAt = new Date(now).toISOString();
      outbox.lastErrorCode = null;
      await this.persist();
      return this.getSyncOutbox();
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async applySyncConfigurationSnapshot(revision) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      const next = Number(revision);
      if (!Number.isSafeInteger(next) || next < outbox.cloudRevision) throw new Error("Cloud configuration snapshot revision is invalid or moved backwards");
      // This records only that the signed configuration snapshot was durably
      // applied. It deliberately preserves the event cursor, in-flight batch,
      // last successful event-sync timestamp, and error until a separate
      // ordinary sync receives its own valid acknowledgement.
      outbox.cloudRevision = next;
      outbox.configurationAppliedRevision = Math.max(outbox.configurationAppliedRevision, next);
      await this.persist();
      return this.getSyncOutbox();
    } catch (error) { this.state = before; throw error; }
  }

  async markSyncFailure(code) {
    const before = this.snapshot();
    try {
      const outbox = this.state.syncOutbox = normalizeSyncOutbox(this.state.syncOutbox);
      outbox.lastErrorCode = String(code || "sync_failed").slice(0, 80);
      await this.persist();
    } catch (error) { this.state = before; throw error; }
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
    if (pending.length >= 10_000) throw Object.assign(new Error("The durable incident backlog has reached its safety bound"), { code: "sync_critical_backlog_full" });
    const projection = nativeIncidentSyncProjection(envelope, this.state);
    if (projection) enqueueSyncEventInState(this.state, "incident.transition", projection.incidentKey, projection, { critical: true, dedupeRevision: projection.revision });
    this.state.incidentOutbox.pending = [...pending, entry];
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
