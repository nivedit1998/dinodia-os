const DEFAULT_BAND = "B";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function labelName(store, value) {
  return store.getLabel(String(value || ""))?.name || String(value || "");
}

function labelsFor(store, device, entity) {
  return [...(device.labelIds || device.labels || []), ...(entity.labelIds || entity.labels || [])]
    .map((value) => labelName(store, value).trim().toLowerCase());
}

function classify(entity, device) {
  const state = entity.state !== undefined ? entity.state : device.state?.[entity.stateKey];
  const value = String(state ?? "").trim().toLowerCase();
  if (["unavailable", "unknown", ""].includes(value)) return { known: false, isOn: false };
  if (["off", "closed", "locked", "idle", "docked", "stopped", "standby"].includes(value)) return { known: true, isOn: false };
  if (["on", "open", "opening", "closing", "heat", "heating", "active", "cleaning", "playing"].includes(value)) return { known: true, isOn: true };
  const current = Number(device.state?.current_temperature ?? device.state?.temperature);
  const target = Number(device.state?.target_temperature ?? device.state?.target_temp);
  if (Number.isFinite(current) && Number.isFinite(target)) return { known: true, isOn: target > current };
  return { known: false, isOn: false };
}

class HeatingUsageTracker {
  constructor({ store, entityIdFor, logger = console } = {}) {
    this.store = store;
    this.entityIdFor = entityIdFor || ((entity, device, rawId) => entity.haEntityId || entity.entityId || rawId);
    this.logger = logger;
    this.persistTimer = null;
    this.config = { schemaVersion: 1, efficiencyBandsVersion: 1, defaultBoilerEfficiencyBand: DEFAULT_BAND, boilerBandsByEntityId: {} };
  }

  state() {
    const value = this.store.state.heatingUsage || {};
    if (!value.entities || typeof value.entities !== "object") value.entities = {};
    value.schemaVersion = 2;
    value.config = { ...this.config, ...(value.config || {}) };
    this.config = value.config;
    return value;
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.persist().catch((error) => this.logger.error(`[heating] ${error.message}`));
    }, 500);
    this.persistTimer.unref?.();
  }

  relevantLabel(device, entity) {
    const labels = labelsFor(this.store, device, entity);
    if (labels.includes("boiler")) return "Boiler";
    if (labels.includes("radiator")) return "Radiator";
    return null;
  }

  async onDeviceChanged(device, observedAt = new Date()) {
    const state = this.state();
    const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
    if (!Number.isFinite(observed.getTime())) return;
    for (const [rawId, entity] of Object.entries(device.entities || {})) {
      const label = this.relevantLabel(device, entity);
      if (!label) continue;
      const entityId = this.entityIdFor(entity, device, rawId);
      if (!entityId) continue;
      const classification = classify(entity, device);
      const previous = state.entities[entityId];
      if (!previous) {
        state.entities[entityId] = {
          deviceId: device.id,
          label, onSeconds: 0, offSeconds: 0, unknownSeconds: 0,
          efficiencyWeightedOnSeconds: label === "Boiler" ? 0 : undefined,
          efficiencyOnSeconds: label === "Boiler" ? 0 : undefined,
          efficiencyBand: label === "Boiler" ? (state.config.boilerBandsByEntityId?.[entityId] || state.config.defaultBoilerEfficiencyBand || DEFAULT_BAND) : undefined,
          efficiencyBandVersion: label === "Boiler" ? Number(state.config.efficiencyBandsVersion || 1) : undefined,
          lastSeenAt: observed.toISOString(), lastWasOn: classification.isOn, lastWasKnown: classification.known,
          dirty: true,
        };
        continue;
      }
      const lastMs = new Date(previous.lastSeenAt || observed.toISOString()).getTime();
      const seconds = Number.isFinite(lastMs) ? Math.max(0, Math.min(86400, Math.floor((observed.getTime() - lastMs) / 1000))) : 0;
      if (previous.lastWasKnown === true) {
        if (previous.lastWasOn === true) previous.onSeconds = Math.max(0, Number(previous.onSeconds || 0)) + seconds;
        else previous.offSeconds = Math.max(0, Number(previous.offSeconds || 0)) + seconds;
      } else {
        previous.unknownSeconds = Math.max(0, Number(previous.unknownSeconds || 0)) + seconds;
      }
      if (label === "Boiler") {
        previous.efficiencyBand = state.config.boilerBandsByEntityId?.[entityId] || previous.efficiencyBand || state.config.defaultBoilerEfficiencyBand || DEFAULT_BAND;
        previous.efficiencyBandVersion = Number(state.config.efficiencyBandsVersion || previous.efficiencyBandVersion || 1);
        previous.efficiencyOnSeconds = Math.max(0, Number(previous.efficiencyOnSeconds || 0)) + (previous.lastWasKnown === true && previous.lastWasOn === true ? seconds : 0);
        previous.efficiencyWeightedOnSeconds = Math.max(0, Number(previous.efficiencyWeightedOnSeconds || 0)) + (previous.lastWasKnown === true && previous.lastWasOn === true ? seconds : 0);
      }
      Object.assign(previous, { deviceId: device.id, label, lastSeenAt: observed.toISOString(), lastWasOn: classification.isOn, lastWasKnown: classification.known, dirty: true });
    }
    if (Object.keys(state.entities).length) this.schedulePersist();
  }

  payload() {
    const state = this.state();
    const devices = Object.entries(state.entities).filter(([, entry]) => entry && entry.dirty).map(([entityId, entry]) => ({
      label: entry.label, entityId, onSeconds: Math.max(0, Math.floor(Number(entry.onSeconds || 0))), offSeconds: Math.max(0, Math.floor(Number(entry.offSeconds || 0))), unknownSeconds: Math.max(0, Math.floor(Number(entry.unknownSeconds || 0))),
      lastSeenAt: entry.lastSeenAt, lastWasOn: entry.lastWasOn === true, lastWasKnown: entry.lastWasKnown === true,
      ...(entry.label === "Boiler" ? { efficiencyWeightedOnSeconds: Math.max(0, Number(entry.efficiencyWeightedOnSeconds || 0)), efficiencyOnSeconds: Math.max(0, Math.floor(Number(entry.efficiencyOnSeconds || 0))), efficiencyBand: entry.efficiencyBand || DEFAULT_BAND, efficiencyBandVersion: Number(entry.efficiencyBandVersion || 1) } : {}),
    }));
    return devices.length ? { schemaVersion: 2, capturedAt: new Date().toISOString(), devices } : null;
  }

  acknowledgeUploaded(entityIds = []) {
    const state = this.state();
    let changed = false;
    for (const id of entityIds) if (state.entities[id]?.dirty) { state.entities[id].dirty = false; changed = true; }
    if (changed) this.schedulePersist();
  }

  applyPlatformResponse(response = {}) {
    const config = response.heatingUsageConfig;
    if (config && typeof config === "object") {
      this.config = {
        ...this.config,
        ...config,
        boilerBandsByEntityId: config.boilerBandsByEntityId && typeof config.boilerBandsByEntityId === "object" ? clone(config.boilerBandsByEntityId) : this.config.boilerBandsByEntityId,
      };
      this.state().config = this.config;
    }
    const resetAt = typeof response.heatingUsageResetAt === "string" ? response.heatingUsageResetAt : "";
    if (resetAt && resetAt !== this.state().lastResetAt) {
      this.store.state.heatingUsage = { schemaVersion: 2, entities: {}, totals: {}, intervals: [], config: this.config, lastResetAt: resetAt, resetAckPendingAt: resetAt };
      this.schedulePersist();
    }
  }

  resetAcknowledgement() {
    return this.state().resetAckPendingAt || null;
  }

  acknowledgeReset(resetAt) {
    const state = this.state();
    if (resetAt && state.resetAckPendingAt === resetAt) {
      delete state.resetAckPendingAt;
      this.schedulePersist();
    }
  }

  status() {
    const state = this.state();
    return { enabled: true, trackedEntities: Object.keys(state.entities).length, dirtyEntities: Object.values(state.entities).filter((entry) => entry?.dirty).length, lastResetAt: state.lastResetAt || null };
  }
}

module.exports = { HeatingUsageTracker, classify };
