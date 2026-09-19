const crypto = require("node:crypto");
const { allProjectedSurfaces } = require("./capabilities/controlSurfaceProjection");

const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
const UNKNOWN_GAP_SECONDS = 10 * 60;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function labelNames(store, values) {
  return (Array.isArray(values) ? values : []).map((value) => store.getLabel(String(value || ""))?.name || String(value || ""));
}

function resolvedLabels(store, device, surface, sourceEntities) {
  return [
    ...labelNames(store, device.labelIds || device.labels),
    ...labelNames(store, surface?.labelIds || surface?.labels),
    ...sourceEntities.flatMap((entity) => labelNames(store, entity?.labelIds || entity?.labels)),
  ].map((value) => value.trim().toLowerCase());
}

function classify(surface, device) {
  if (device.available === false || surface.available === false) return { known: false, isOn: false };
  const value = String(surface.state ?? "").trim().toLowerCase();
  if (value === "on") return { known: true, isOn: true };
  if (value === "off") return { known: true, isOn: false };
  return { known: false, isOn: false };
}

function sourceEntities(device, surface) {
  const ids = Array.isArray(surface?.sourceEntityIds) ? surface.sourceEntityIds : [];
  return ids.map((id) => Object.values(device.entities || {}).find((entity) => entity && (entity.id === id || entity.sourceId === id))).filter(Boolean);
}

function friendlyArea(store, areaId) {
  const area = areaId ? store.getArea(String(areaId)) : null;
  return { areaId: areaId ? String(areaId) : null, areaName: area?.name || null };
}

class ElectricUsageTracker {
  constructor({ store, logger = console, now = () => new Date(), maxTrackedEntities = 200 } = {}) {
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.maxTrackedEntities = Math.max(1, Number(maxTrackedEntities) || 200);
    this.persistTimer = null;
  }

  state() {
    if (!this.store.state.electricUsage || typeof this.store.state.electricUsage !== "object") this.store.state.electricUsage = { schemaVersion: 1, entities: {}, pending: [], lastResetAt: null };
    const state = this.store.state.electricUsage;
    if (!state.entities || typeof state.entities !== "object") state.entities = {};
    if (!Array.isArray(state.pending)) state.pending = [];
    state.schemaVersion = 1;
    return state;
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.persist().catch((error) => this.logger.error(`[electric] ${error.message}`));
    }, 500);
    this.persistTimer.unref?.();
  }

  descriptor(device, surface) {
    const sources = sourceEntities(device, surface);
    const labels = resolvedLabels(this.store, device, surface, sources);
    const domain = String(surface.domain || "").toLowerCase();
    if (!(["light", "switch"].includes(domain) && labels.includes("light"))) return null;
    const sourceArea = sources.find((entity) => entity?.areaId)?.areaId;
    const area = friendlyArea(this.store, surface.areaId || sourceArea || device.areaId);
    const entityId = String(surface.haEntityId || surface.id || "").trim();
    if (!entityId || !/^(light|switch)\./i.test(entityId)) return null;
    return { entityId, deviceId: device.id, entityName: String(surface.name || device.name || entityId).trim().slice(0, 200), areaId: area.areaId, areaName: area.areaName, classification: classify(surface, device) };
  }

  createEntry(descriptor, observed) {
    const epoch = crypto.randomUUID();
    return {
      entityId: descriptor.entityId,
      deviceId: descriptor.deviceId,
      entityName: descriptor.entityName,
      trackingStartedAt: observed.toISOString(),
      trackingEpoch: epoch,
      assignmentStartedAt: observed.toISOString(),
      assignmentEpoch: crypto.randomUUID(),
      areaId: descriptor.areaId,
      areaName: descriptor.areaName,
      onSeconds: 0,
      offSeconds: 0,
      unknownSeconds: 0,
      lastSeenAt: observed.toISOString(),
      lastWasOn: descriptor.classification.isOn,
      lastWasKnown: descriptor.classification.known,
      retired: false,
      dirty: true,
    };
  }

  accrue(entry, observed) {
    const previousAt = new Date(entry.lastSeenAt || observed.toISOString());
    const elapsed = Number.isFinite(previousAt.getTime()) ? Math.max(0, Math.min(MAX_INTERVAL_SECONDS, Math.floor((observed.getTime() - previousAt.getTime()) / 1000))) : 0;
    const gapUnknown = elapsed > UNKNOWN_GAP_SECONDS;
    const seconds = gapUnknown ? elapsed : elapsed;
    if (entry.lastWasKnown === true && !gapUnknown) {
      if (entry.lastWasOn === true) entry.onSeconds += seconds;
      else entry.offSeconds += seconds;
    } else {
      entry.unknownSeconds += seconds;
    }
    return entry;
  }

  rollAssignment(entityId, entry, descriptor, observed) {
    this.accrue(entry, observed);
    const state = this.state();
    state.pending.push({ ...clone(entry), retired: true, dirty: true, retiredAt: observed.toISOString() });
    const next = this.createEntry(descriptor, observed);
    state.entities[entityId] = next;
    return next;
  }

  // Small normalized-input hook used by deterministic tests and by future
  // adapters. The live hub path uses onDeviceChanged(), which derives these
  // descriptors from the public capability projection.
  observe(descriptor, observedAt = this.now()) {
    const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
    const entityId = String(descriptor?.entityId || descriptor?.id || "").trim();
    if (!descriptor || !Number.isFinite(observed.getTime()) || !entityId) return;
    const state = this.state();
    const normalized = { ...descriptor, entityId };
    let entry = state.entities[entityId];
    if (!entry) {
      state.entities[entityId] = this.createEntry(normalized, observed);
      this.schedulePersist();
      return;
    }
    if (String(entry.areaId || "") !== String(normalized.areaId || "") && !entry.retired) {
      entry = this.rollAssignment(entityId, entry, normalized, observed);
    } else {
      this.accrue(entry, observed);
    }
    Object.assign(entry, {
      entityName: normalized.entityName || entry.entityName,
      areaId: normalized.areaId || null,
      areaName: normalized.areaName || null,
      lastSeenAt: observed.toISOString(),
      lastWasOn: normalized.classification?.isOn === true,
      lastWasKnown: normalized.classification?.known === true,
      retired: false,
      dirty: true,
    });
    this.schedulePersist();
  }

  async onDeviceChanged(device, observedAt = this.now()) {
    const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
    if (!Number.isFinite(observed.getTime()) || !device) return;
    const state = this.state();
    const surfaces = allProjectedSurfaces(device);
    const seen = new Set();
    for (const surface of surfaces) {
      const descriptor = this.descriptor(device, surface);
      if (!descriptor) continue;
      if (!state.entities[descriptor.entityId] && Object.keys(state.entities).length >= this.maxTrackedEntities) continue;
      seen.add(descriptor.entityId);
      let entry = state.entities[descriptor.entityId];
      if (!entry) {
        state.entities[descriptor.entityId] = this.createEntry(descriptor, observed);
        continue;
      }
      const areaChanged = String(entry.areaId || "") !== String(descriptor.areaId || "");
      if (areaChanged && !entry.retired) entry = this.rollAssignment(descriptor.entityId, entry, descriptor, observed);
      else this.accrue(entry, observed);
      Object.assign(entry, {
        deviceId: descriptor.deviceId,
        entityName: descriptor.entityName,
        areaId: descriptor.areaId,
        areaName: descriptor.areaName,
        lastSeenAt: observed.toISOString(),
        lastWasOn: descriptor.classification.isOn,
        lastWasKnown: descriptor.classification.known,
        retired: false,
        dirty: true,
      });
    }
    for (const [entityId, entry] of Object.entries(state.entities)) {
      if (entry.deviceId !== device.id || seen.has(entityId) || entry.retired) continue;
      this.accrue(entry, observed);
      entry.retired = true;
      entry.retiredAt = observed.toISOString();
      entry.dirty = true;
    }
    if (Object.keys(state.entities).length || state.pending.length) this.schedulePersist();
  }

  async tick(devices = this.store.listDevices(), observedAt = this.now()) {
    for (const device of devices || []) await this.onDeviceChanged(device, observedAt);
  }

  async retireDevice(device, observedAt = this.now()) {
    const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
    if (!device || !Number.isFinite(observed.getTime())) return;
    const state = this.state();
    for (const entry of Object.values(state.entities)) {
      if (!entry || entry.deviceId !== device.id || entry.retired) continue;
      this.accrue(entry, observed);
      entry.retired = true;
      entry.retiredAt = observed.toISOString();
      entry.dirty = true;
    }
    for (const entry of state.pending) {
      if (entry && entry.deviceId === device.id && !entry.retired) {
        entry.retired = true;
        entry.retiredAt = observed.toISOString();
        entry.dirty = true;
      }
    }
    this.schedulePersist();
  }

  payload() {
    const state = this.state();
    const devices = [
      ...state.pending.filter((entry) => entry?.dirty).map((entry) => ({ ...clone(entry), entityId: entry.entityId || entry.haEntityId })),
      ...Object.entries(state.entities).filter(([, entry]) => entry?.dirty).map(([entityId, entry]) => ({ ...clone(entry), entityId })),
    ].map((entry) => ({
      label: "Light",
      entityId: entry.entityId,
      entityName: entry.entityName || null,
      trackingStartedAt: entry.trackingStartedAt || null,
      trackingEpoch: entry.trackingEpoch,
      assignmentStartedAt: entry.assignmentStartedAt || entry.trackingStartedAt || null,
      assignmentEpoch: entry.assignmentEpoch,
      areaId: entry.areaId || null,
      areaName: entry.areaName || null,
      onSeconds: Math.max(0, Math.floor(Number(entry.onSeconds) || 0)),
      offSeconds: Math.max(0, Math.floor(Number(entry.offSeconds) || 0)),
      unknownSeconds: Math.max(0, Math.floor(Number(entry.unknownSeconds) || 0)),
      lastSeenAt: entry.lastSeenAt,
      lastWasOn: entry.lastWasOn === true,
      lastWasKnown: entry.lastWasKnown === true,
      retired: entry.retired === true,
    }));
    return devices.length ? { schemaVersion: 1, capturedAt: this.now().toISOString(), devices } : null;
  }

  acknowledgeUploaded(rows = []) {
    const state = this.state();
    const acknowledged = new Set((rows || []).map((row) => `${row.entityId || ""}|${row.trackingEpoch || ""}|${row.assignmentEpoch || ""}`));
    state.pending = state.pending.filter((entry) => {
      const key = `${entry.entityId || ""}|${entry.trackingEpoch || ""}|${entry.assignmentEpoch || ""}`;
      return !(entry.dirty && acknowledged.has(key));
    });
    for (const [entityId, entry] of Object.entries(state.entities)) {
      const key = `${entityId}|${entry.trackingEpoch || ""}|${entry.assignmentEpoch || ""}`;
      if (entry.dirty && acknowledged.has(key)) {
        if (entry.retired) delete state.entities[entityId];
        else entry.dirty = false;
      }
    }
    this.schedulePersist();
  }

  applyPlatformResponse(response = {}) {
    const resetAt = typeof response.heatingUsageResetAt === "string" ? response.heatingUsageResetAt : "";
    if (resetAt && resetAt !== this.state().lastResetAt) {
      this.store.state.electricUsage = { schemaVersion: 1, entities: {}, pending: [], lastResetAt: resetAt, resetAckPendingAt: resetAt };
      this.schedulePersist();
    }
  }

  applyReset(resetAt) {
    this.applyPlatformResponse({ heatingUsageResetAt: resetAt });
  }

  resetAcknowledgement() { return this.state().resetAckPendingAt || null; }

  acknowledgeReset(resetAt) {
    const state = this.state();
    if (resetAt && state.resetAckPendingAt === resetAt) { delete state.resetAckPendingAt; this.schedulePersist(); }
  }

  status() {
    const state = this.state();
    return { enabled: true, trackedEntities: Object.keys(state.entities).length, pendingSegments: state.pending.length, dirtyEntities: Object.values(state.entities).filter((entry) => entry?.dirty).length + state.pending.filter((entry) => entry?.dirty).length, lastResetAt: state.lastResetAt || null };
  }
}

module.exports = { ElectricUsageTracker, classify };
