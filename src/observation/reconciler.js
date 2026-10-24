// Hub-managed observation policy for Zigbee devices (plan revision 3, §5).
//
// For every device control that matches an owner-approved profile, the Hub keeps the device's
// reporting configured and verified, reproducibly across pairing, replacement, reset, firmware
// change and restart, without repeating configuration on ordinary reconnects.
//
// Four kinds of evidence stay separate: the profile's desired settings, Zigbee2MQTT's cached
// configured_reportings, the device's own read-back, and the observed cadence of the value's
// reports. Only read-back plus cadence verify. This module never sends actuator commands
// (no target, power, mode or other writes): only reporting read and reporting configure requests.

const crypto = require("node:crypto");
const { DELIVERY_GRACE_SECONDS, cachedReportingFor, matchObservationProfile, reportingMatches, resolvedEndpoint } = require("./profiles");
const { discoverCollectionStrategy } = require('./strategyResolver');
const { resolveCategoryBinding } = require('../analytics/resolveBinding');
const { analyticsEligible } = require('../analytics/categoryPolicies');
const { scalarFor } = require('./stateEvidence');

const STATES = Object.freeze({
  UNKNOWN: "configuration_unknown",
  READ_PENDING: "read_back_pending",
  READ_BACK: "configuration_read_back",
  DRIFTED: "drifted",
  UNSUPPORTED: "unsupported",
  CONFIGURING: "configuring",
  PENDING_DELIVERY: "pending_delivery", // request unanswered; retried after the device's check-in window
  CADENCE_PENDING: "cadence_pending",
  CADENCE_VERIFIED: "cadence_verified",
  CADENCE_FAILED: "cadence_failed",
  FAILED: "failed",
});

// ZCL status codes in reporting read/configure replies.
const ZCL_SUCCESS = 0;
const ZCL_UNSUPPORTED_ATTRIBUTE = 0x86;
const ZCL_UNREPORTABLE_ATTRIBUTE = 0x8c;
const ZCL_NOT_FOUND = 0x8b;

const DEFAULTS = Object.freeze({
  commandSpacingMs: 30_000, // one reporting request per 30 s, Hub-wide
  replyTimeoutMs: 120_000, // then "pending delivery"
  batteryCheckinMs: 3_600_000, // TRVZB checkinInterval; queued requests can wait this long
  retryAfterCheckinMarginMs: 5 * 60_000,
  backoffBaseMs: 6 * 3_600_000,
  maxConfigureAttemptsPerDay: 3,
  cadenceReportsToVerify: 4, // 3 consecutive on-time gaps
  silenceFactor: 3, // no report for 3 x max interval while reachable -> read back (detects resets)
  maxReportTimes: 12,
});

function recordKey(deviceId, profileId, endpoint) {
  return `${deviceId}|${profileId}|${endpoint}`;
}

function fingerprintOf(raw) {
  return {
    ieee: String(raw?.ieee_address || ""),
    model: String(raw?.model_id || raw?.definition?.model || ""),
    softwareBuildId: String(raw?.software_build_id || ""),
    dateCode: String(raw?.date_code || ""),
  };
}

function sameFingerprint(a, b) {
  return !!a && !!b && a.ieee === b.ieee && a.model === b.model && a.softwareBuildId === b.softwareBuildId && a.dateCode === b.dateCode;
}

class ObservationReconciler {
  constructor({ store, publishBridgeRequest, resolveDeviceId, clock = () => Date.now(), logger = null, options = {} }) {
    this.store = store;
    this.publishBridgeRequest = publishBridgeRequest;
    this.resolveDeviceId = resolveDeviceId;
    this.clock = clock;
    this.logger = logger;
    this.options = { ...DEFAULTS, ...options };
    this.records = new Map(Object.entries(store.getObservationPolicyRecords?.() || {}).filter(([key]) => !key.startsWith('__')));
    this.reportTimes = new Map([...this.records].map(([key, record]) => [key,
      record.runtimeSessionId === store.observationSessionId && Array.isArray(record.cadenceEvidence)
        ? record.cadenceEvidence.map(sample => sample.at).filter(Number.isFinite).slice(-this.options.maxReportTimes) : []]));
    this.availability = new Map(); // deviceId -> boolean
    this.lastCommandAt = Math.max(Number(store.getObservationManagementAt?.() || 0), ...[...this.records.values()].map(record => Number(record.lastCommandAt || 0)));
    this.pending = new Map(); // transaction -> { key, kind, sentAt }
    this.interrupted = new Set([...this.records].filter(([, record]) =>
      [STATES.READ_PENDING, STATES.CONFIGURING].includes(record.state)).map(([key]) => key));
    // MQTT inventory, responses, reports and the timer can arrive concurrently.
    // Serialize policy transitions so an older awaited Store write cannot replace
    // a newer response or publish a duplicate request.
    this.operationQueue = Promise.resolve();
    for (const name of ["onInventory", "onAvailability", "onValueObserved", "onBridgeResponse", "tick"]) {
      const method = this[name];
      this[name] = (...args) => {
        const operation = this.operationQueue.then(() => method.apply(this, args));
        this.operationQueue = operation.catch(() => {});
        return operation;
      };
    }
  }

  status() {
    return [...this.records.values()].map((record) => ({
      deviceId: record.deviceId, profileId: record.profileId, endpoint: record.endpoint, state: record.state,
      readBack: record.readBack || null, cadence: record.cadence || null, attempts: record.attempts || 0,
      nextAttemptAt: record.nextAttemptAt || null, lastError: record.lastError || null,
    }));
  }

  async save(record) {
    const device = this.store.getDevice?.(record.deviceId);
    if (this.store.getDevice && (!device || record.deviceLifecycleId !== device.stateEvidenceLifecycleId)) return false;
    await this.store.putObservationPolicyRecord(record.key, record);
    this.records.set(record.key, record);
    return true;
  }

  async remove(key) {
    await this.store.putObservationPolicyRecord(key, null);
    this.records.delete(key);
    this.reportTimes.delete(key);
    for (const [transaction, pending] of this.pending) if (pending.key === key) this.pending.delete(transaction);
  }

  /// Zigbee2MQTT bridge/devices (retained, complete inventory). Creates, resets or schedules
  /// records; never sends commands itself (tick() does, within budget).
  async onInventory(rawDevices) {
    if (!Array.isArray(rawDevices)) return;
    this.inventory = rawDevices.slice(0, 1000);
    this.policyRevision = this.store.getPlatform?.()?.cloudRevision;
    const now = this.clock();
    const seen = new Set();
    for (const raw of rawDevices) {
      if (!raw || raw.type === "Coordinator") continue;
      const deviceId = this.resolveDeviceId(raw.friendly_name || raw.ieee_address);
      const device = deviceId ? this.store.getDevice(deviceId) : null;
      if (!device) continue;
      // Property profile approval is never consent to read/configure a tenant's private device.
      // Passive reports still update its universal state through the normal adapter/Store path.
      const devicePolicy = this.store.getPlatform?.()?.devicePolicies?.[deviceId];
      if (devicePolicy?.managementClass === 'TENANT_DEVICE') continue;
      const fingerprint = fingerprintOf(raw);
      for (const entity of Object.values(device.entities || {})) {
        let profile = matchObservationProfile(device, entity);
        const policy = this.store.getPlatform?.()?.devicePolicies?.[deviceId];
        // Existing explicitly approved live-state profiles are independent of
        // analytics category. Only generic analytics collectors require it.
        if (!profile && policy && !analyticsEligible(policy)) continue;
        if (!profile && policy?.analyticsInterval) {
          const binding = resolveCategoryBinding({ signedPolicy: policy, controls: Object.values(device.entities || {}).map(item => ({
            ...item.capability, controlId: item.capability?.controlId || item.id, endpointId: item.endpointId || item.binding?.endpoint,
          })) });
          if (binding.status !== 'resolved' || binding.primaryControlId !== (entity.capability?.controlId || entity.id)) continue;
        }
        if (!profile && policy?.analyticsInterval?.genericCollectionEnabled === true) {
          const controls = Object.values(device.entities || {}).map(item => ({ ...item.capability, controlId: item.capability?.controlId || item.id,
            endpointId: item.endpointId || item.binding?.endpoint, entity: item }));
          const binding = resolveCategoryBinding({ signedPolicy: policy, controls });
          const controlId = entity.capability?.controlId || entity.id;
          const strategy = binding.status === 'resolved' && binding.primaryControlId === controlId ? discoverCollectionStrategy(device, entity) : null;
          if (strategy?.strategy === 'verify_existing_reporting') {
            const maximum = /mains|dc source|single.phase|three.phase/i.test(String(device.metadata?.power_source || raw.power_source || '')) ? 300 : 600;
            profile = { id: `generic.${controlId}`, version: 1, ...strategy,
              desired: { minimumReportInterval: 0, maximumReportInterval: maximum, reportableChange: 0 }, approvedForAutomaticConfiguration: false };
          }
        }
        if (!profile?.desired) continue;
        const endpoint = resolvedEndpoint(device, entity, profile.cluster);
        if (!endpoint) continue;
        const key = recordKey(deviceId, profile.id, endpoint);
        seen.add(key);
        const cached = cachedReportingFor(raw, profile, endpoint);
        const existing = this.records.get(key);
        const generation = this.store.syncSourceGeneration;
        if (existing && existing.deviceLifecycleId !== device.stateEvidenceLifecycleId) {
          this.reportTimes.delete(key);
          for (const [transaction, pending] of this.pending) if (pending.key === key) this.pending.delete(transaction);
          await this.save({ ...existing, deviceLifecycleId: device.stateEvidenceLifecycleId,
            state: STATES.UNKNOWN, readBack: null, cadence: null, cadenceEvidence: [], evidenceVerifiedAt: null,
            pendingRequest: null, lastTransaction: null, lastRequestKind: null,
            nextAttemptAt: now, lastError: 'device_lifecycle_changed', updatedAt: now });
          continue;
        }
        if (existing?.readBack && Number.isSafeInteger(generation) && generation > 0
          && (existing.evidenceVersion !== 2 || existing.sourceGeneration !== generation)) {
          // Re-verify the already approved exact configuration; never reinterpret
          // a legacy cadence flag as new evidence or reset its radio/write budget.
          this.reportTimes.delete(key);
          for (const [transaction, pending] of this.pending) if (pending.key === key) this.pending.delete(transaction);
          await this.save({ ...existing, state: STATES.UNKNOWN, readBack: null, cadence: null,
            cadenceEvidence: [], evidenceVerifiedAt: null, pendingRequest: null, lastTransaction: null, lastRequestKind: null,
            nextAttemptAt: now, lastError: 'evidence_generation_changed', updatedAt: now });
          continue;
        }
        if (existing?.suspended && sameFingerprint(existing.fingerprint, fingerprint)) {
          await this.save({ ...existing, suspended: false, state: STATES.UNKNOWN, cadence: null, nextAttemptAt: Math.max(now, existing.nextAttemptAt || 0), updatedAt: now });
          continue;
        }
        if (!existing || !sameFingerprint(existing.fingerprint, fingerprint) || existing.profileVersion !== profile.version) {
          // New device, replacement, firmware/model change or new profile version: start from
          // unknown and read the device's actual configuration first.
          this.interrupted.delete(key);
          this.reportTimes.delete(key);
          for (const [transaction, pending] of this.pending) if (pending.key === key) this.pending.delete(transaction);
          await this.save({ key, deviceId, deviceLifecycleId: device.stateEvidenceLifecycleId, ieee: fingerprint.ieee, friendlyName: String(raw.friendly_name || raw.ieee_address),
            profileId: profile.id, profileVersion: profile.version, endpoint, cluster: profile.cluster, attribute: profile.attribute,
            desired: profile.desired, property: entity.stateKey, controlId: entity.capability?.controlId || entity.id,
            approvedForAutomaticConfiguration: profile.approvedForAutomaticConfiguration === true,
            fingerprint, cached, readBack: null, cadence: null, state: STATES.UNKNOWN,
            attempts: 0, attemptsWindowStartAt: now, nextAttemptAt: now, lastError: null, updatedAt: now });
          continue;
        }
        const cacheChanged = JSON.stringify(existing.cached || null) !== JSON.stringify(cached || null);
        if (cacheChanged) {
          // The cache is evidence that something changed (reset, re-configure by another tool);
          // it never proves the device holds a setting. Read the device back.
          await this.save({ ...existing, cached, state: [STATES.UNSUPPORTED, STATES.FAILED].includes(existing.state) ? existing.state : STATES.UNKNOWN,
            nextAttemptAt: Math.min(existing.nextAttemptAt || now, now), updatedAt: now });
        }
      }
    }
    // Device removed from Zigbee2MQTT (and not merely offline): cancel its policy work.
    for (const [key, record] of this.records) {
      const stillPresent = rawDevices.some((raw) => raw && String(raw.ieee_address || "") === record.ieee);
      const policy = this.store.getPlatform?.()?.devicePolicies?.[record.deviceId];
      if (!seen.has(key) && (!stillPresent || policy && !analyticsEligible(policy))) await this.remove(key);
      else if (!seen.has(key) && !record.suspended) {
        for (const [transaction, pending] of this.pending) if (pending.key === key) this.pending.delete(transaction);
        await this.save({ ...record, suspended: true, pendingRequest: null, lastError: 'capability_temporarily_unavailable', updatedAt: now });
      }
    }
  }

  async onAvailability(deviceId, online) {
    this.availability.set(String(deviceId), online === true);
    if (online === true) return;
    for (const record of this.records.values()) {
      if (record.deviceId !== String(deviceId)) continue;
      this.reportTimes.delete(record.key);
      for (const [transaction, pending] of this.pending) if (pending.key === record.key) this.pending.delete(transaction);
      await this.save({ ...record, state: record.readBack?.status === 0 ? STATES.CADENCE_PENDING : STATES.UNKNOWN,
        evidenceVerifiedAt: null, cadence: null, cadenceEvidence: [], pendingRequest: null, lastTransaction: null, lastRequestKind: null,
        coverageInterruptedAt: new Date(this.clock()).toISOString(), updatedAt: this.clock() });
    }
  }

  isAvailable(deviceId) {
    if (this.availability.has(String(deviceId))) return this.availability.get(String(deviceId));
    return this.store.getDevice?.(String(deviceId))?.available !== false;
  }

  /// A genuine observation of a profiled value (provenance already checked by mqttBridge).
  async onValueObserved(deviceId, property, endpoint, observedAtIso, observedValue) {
    const observedMs = Date.parse(String(observedAtIso || ""));
    if (!Number.isFinite(observedMs)) return;
    for (const record of this.records.values()) {
      if (record.deviceId !== String(deviceId)) continue;
      if (record.suspended) continue;
      if (endpoint && endpoint !== "0" && record.endpoint !== String(endpoint)) continue;
      if ((record.property || record.profileId.split('.').at(-1)) !== property) continue;
      if (observedValue !== undefined) {
        const device = this.store.getDevice?.(String(deviceId));
        const entities = Object.values(device?.entities || {}).filter(item => item.stateKey === property
          && (item.capability?.controlId || item.id) === record.controlId
          && String(resolvedEndpoint(device, item, record.cluster)) === String(record.endpoint));
        if (entities.length !== 1) continue;
        const entity = entities[0];
        const kind = entity?.expose?.type || entity?.capability?.kind;
        const valueType = ['numeric', 'number'].includes(kind) ? 'number' : ['binary', 'boolean'].includes(kind) ? 'boolean'
          : ['enum', 'option'].includes(kind) ? 'option' : null;
        const constraints = entity?.capability?.constraints || {};
        const options = constraints.options || entity?.expose?.values || [];
        const typed = scalarFor({ valueType, constraints: { minimum: constraints.min, maximum: constraints.max,
          options: options.map(option => typeof option === 'object' && option !== null ? option : { value: option }) } }, observedValue);
        if (typed === null) continue;
        observedValue = typed;
      }
      const previousTimes = this.reportTimes.get(record.key) || [];
      if (previousTimes.length && observedMs <= previousTimes.at(-1)) continue;
      if (record.readBack?.at && observedMs < Date.parse(record.readBack.at)) continue;
      const times = [...previousTimes, observedMs].slice(-this.options.maxReportTimes);
      this.reportTimes.set(record.key, times);
      const limitSeconds = record.desired.maximumReportInterval + DELIVERY_GRACE_SECONDS;
      const gaps = times.slice(1).map((time, index) => (time - times[index]) / 1000);
      const lastGap = gaps.at(-1);
      let state = record.state;
      if ([STATES.CADENCE_PENDING, STATES.CADENCE_VERIFIED].includes(state) && Number.isFinite(lastGap) && lastGap > limitSeconds && this.isAvailable(deviceId)) {
        state = STATES.CADENCE_FAILED; // the promise was not kept; read the device back
        this.reportTimes.set(record.key, [observedMs]);
      } else if (state === STATES.CADENCE_PENDING) {
        const recent = gaps.slice(-(this.options.cadenceReportsToVerify - 1));
        if (recent.length >= this.options.cadenceReportsToVerify - 1 && recent.every((gap) => gap <= limitSeconds)) state = STATES.CADENCE_VERIFIED;
      }
      const previousEvidence = record.runtimeSessionId === this.store.observationSessionId && Array.isArray(record.cadenceEvidence) ? record.cadenceEvidence : [];
      const cadenceEvidence = observedValue !== undefined
        ? [...previousEvidence.filter(item => item.at < observedMs), { at: observedMs, value: observedValue }].slice(-this.options.cadenceReportsToVerify)
        : previousEvidence;
      const unchanged = cadenceEvidence.some((sample, index) => index > 0 && Object.is(sample.value, cadenceEvidence[index - 1].value));
      const exactCadenceVerified = record.sourceGeneration === this.store.syncSourceGeneration
        && record.evidenceVersion === 2
        && Number.isSafeInteger(record.sourceGeneration) && record.sourceGeneration > 0
        && cadenceEvidence.length === this.options.cadenceReportsToVerify && unchanged
        && cadenceEvidence.every((sample, index) => !index || sample.at - cadenceEvidence[index - 1].at <= limitSeconds * 1000);
      const cadence = { lastReportAt: new Date(observedMs).toISOString(), lastGapSeconds: Number.isFinite(lastGap) ? Math.round(lastGap) : null,
        verifiedAt: state === STATES.CADENCE_VERIFIED ? (record.cadence?.verifiedAt || new Date(observedMs).toISOString()) : null };
      const evidenceVerifiedAt = state === STATES.CADENCE_VERIFIED && exactCadenceVerified
        ? record.evidenceVerifiedAt || new Date(observedMs).toISOString() : null;
      if (state !== record.state || evidenceVerifiedAt !== (record.evidenceVerifiedAt || null)) {
        await this.save({ ...record, state, cadence, cadenceEvidence, evidenceVerifiedAt, runtimeSessionId: this.store.observationSessionId,
          nextAttemptAt: state === STATES.CADENCE_FAILED ? this.clock() : record.nextAttemptAt, updatedAt: this.clock() });
      } else {
        this.records.set(record.key, { ...record, cadence, cadenceEvidence, runtimeSessionId: this.store.observationSessionId }); // no additional Store flush per report
      }
    }
  }

  /// One bounded step: at most one reporting request, only when due, budgeted and the device is
  /// reachable. Also expires unanswered requests into "pending delivery".
  async tick() {
    if (this.inventory && this.policyRevision !== this.store.getPlatform?.()?.cloudRevision) {
      await ObservationReconciler.prototype.onInventory.call(this, this.inventory);
    }
    const now = this.clock();
    for (const key of this.interrupted) {
      const record = this.records.get(key);
      if (record) {
        const sentAt = Number(record.pendingRequest?.sentAt ?? record.updatedAt ?? now);
        // Delivery is uncertain after process loss. Wait out the bounded delivery
        // window, then READ first: an interrupted configure may already be applied.
        await this.save({ ...record, state: STATES.PENDING_DELIVERY, retryKind: "read", pendingRequest: null,
          nextAttemptAt: Math.max(Number(record.nextAttemptAt) || 0, sentAt + Math.max(this.options.backoffBaseMs,
            this.options.batteryCheckinMs + this.options.retryAfterCheckinMarginMs)),
          lastError: "request_interrupted", updatedAt: now });
      }
      this.interrupted.delete(key);
    }
    for (const [transaction, pending] of this.pending) {
      if (now - pending.sentAt < this.options.replyTimeoutMs) continue;
      this.pending.delete(transaction);
      const record = this.records.get(pending.key);
      if (record) await this.deliveryFailed(record, "reply_timeout");
    }
    // Silence: a profiled value that stops reporting while its device is reachable may have lost
    // its configuration (factory reset the cache missed). Read it back.
    for (const record of this.records.values()) {
      if (![STATES.CADENCE_PENDING, STATES.CADENCE_VERIFIED, STATES.READ_BACK].includes(record.state)) continue;
      const last = Date.parse(String(record.cadence?.lastReportAt || record.readBack?.at || ""));
      const silentMs = record.desired.maximumReportInterval * 1000 * this.options.silenceFactor;
      const overdueMs = (record.desired.maximumReportInterval + DELIVERY_GRACE_SECONDS) * 1000;
      if (record.state === STATES.CADENCE_VERIFIED && Number.isFinite(last) && now - last > overdueMs && this.isAvailable(record.deviceId)) {
        this.reportTimes.delete(record.key);
        await this.save({ ...record, state: STATES.CADENCE_FAILED, cadence: { ...record.cadence, verifiedAt: null },
          nextAttemptAt: Math.max(now, last + silentMs), lastError: "value_overdue", updatedAt: now });
        continue;
      }
      if (Number.isFinite(last) && now - last > silentMs && this.isAvailable(record.deviceId)) {
        await this.save({ ...record, state: STATES.UNKNOWN, nextAttemptAt: now, lastError: "value_silent", updatedAt: now });
      }
    }
    if (now - this.lastCommandAt < this.options.commandSpacingMs) return null;
    if ([...this.pending.values()].length) return null; // one outstanding request at a time
    const due = [...this.records.values()]
      .filter((record) => [STATES.UNKNOWN, STATES.DRIFTED, STATES.CADENCE_FAILED, STATES.PENDING_DELIVERY].includes(record.state))
      .filter((record) => !record.suspended && (record.nextAttemptAt || 0) <= now && this.isAvailable(record.deviceId))
      .sort((a, b) => (a.nextAttemptAt || 0) - (b.nextAttemptAt || 0))[0];
    if (!due) return null;
    const configure = due.state === STATES.DRIFTED || (due.state === STATES.PENDING_DELIVERY && due.retryKind === "configure");
    if (configure && !this.mayConfigure(due, now)) return null;
    return this.send(due, configure ? "configure" : "read", now);
  }

  mayConfigure(record, now) {
    if (record.approvedForAutomaticConfiguration === false) return false;
    const windowStart = Number(record.attemptsWindowStartAt || 0);
    const attempts = now - windowStart > 24 * 3_600_000 ? 0 : Number(record.attempts || 0);
    return attempts < this.options.maxConfigureAttemptsPerDay;
  }

  async send(record, kind, now) {
    const device = this.store.getDevice?.(record.deviceId);
    if (this.store.getDevice && (!device || record.deviceLifecycleId !== device.stateEvidenceLifecycleId)) return null;
    // Recheck ownership at dispatch, not only inventory time: a queued property
    // approval must never survive reassignment to a tenant-private device.
    const policy = this.store.getPlatform?.()?.devicePolicies?.[record.deviceId];
    if (policy?.managementClass === 'TENANT_DEVICE') {
      await this.remove(record.key);
      return null;
    }
    const transaction = `dinodia-obs-${crypto.randomBytes(6).toString("hex")}`;
    const payload = kind === "configure"
      ? { id: record.ieee || record.friendlyName, endpoint: Number(record.endpoint), cluster: record.cluster, attribute: record.attribute,
        minimum_report_interval: record.desired.minimumReportInterval, maximum_report_interval: record.desired.maximumReportInterval,
        reportable_change: record.desired.reportableChange, transaction }
      : { id: record.ieee || record.friendlyName, endpoint: Number(record.endpoint), cluster: record.cluster, configs: [{ attribute: record.attribute }], transaction };
    const windowExpired = now - Number(record.attemptsWindowStartAt || 0) > 24 * 3_600_000;
    const saved = await this.save({ ...record, state: kind === "configure" ? STATES.CONFIGURING : STATES.READ_PENDING, lastTransaction: transaction,
      lastRequestKind: kind, lastCommandAt: now, pendingRequest: { kind, transaction, sentAt: now },
      attempts: kind === "configure" ? (windowExpired ? 1 : Number(record.attempts || 0) + 1) : Number(record.attempts || 0),
      attemptsWindowStartAt: kind === "configure" && windowExpired ? now : record.attemptsWindowStartAt, updatedAt: now });
    if (!saved) return null;
    this.lastCommandAt = now;
    this.pending.set(transaction, { key: record.key, kind, sentAt: now });
    try {
      await this.publishBridgeRequest(kind === "configure" ? "device/reporting/configure" : "device/reporting/read", payload);
    } catch (error) {
      this.pending.delete(transaction);
      await this.deliveryFailed(this.records.get(record.key), "publish_failed");
    }
    return { kind, transaction };
  }

  async deliveryFailed(record, reason) {
    const now = this.clock();
    const wait = Math.max(this.options.batteryCheckinMs + this.options.retryAfterCheckinMarginMs,
      this.options.backoffBaseMs * 2 ** Math.max(0, Number(record.attempts || 1) - 1));
    const wasConfigure = record.state === STATES.CONFIGURING || (record.state === STATES.PENDING_DELIVERY && record.retryKind === "configure");
    const exhausted = wasConfigure && !this.mayConfigure(record, now);
    await this.save({ ...record, state: exhausted ? STATES.FAILED : STATES.PENDING_DELIVERY, retryKind: wasConfigure ? "configure" : "read", pendingRequest: null,
      nextAttemptAt: now + wait, lastError: reason, updatedAt: now });
  }

  lifetimeFor(deviceId, property, endpoint) {
    const records = [...this.records.values()].filter(record => !record.suspended && record.deviceId === String(deviceId)
      && (record.property || record.profileId.split('.').at(-1)) === property
      && (!endpoint || String(endpoint) === '0' || String(record.endpoint) === String(endpoint))
      && [STATES.READ_BACK, STATES.CADENCE_PENDING, STATES.CADENCE_VERIFIED].includes(record.state)
      && record.readBack?.maximumReportInterval > 0);
    return records.length === 1 ? records[0].readBack.maximumReportInterval + DELIVERY_GRACE_SECONDS : null;
  }

  selectedProperties(deviceId) {
    return [...new Set([...this.records.values()].filter(record => !record.suspended && record.deviceId === String(deviceId))
      .map(record => record.property || record.profileId.split('.').at(-1)))];
  }

  /// bridge/response/device/reporting/{read,configure}. Late replies are accepted by transaction.
  async onBridgeResponse(kind, message) {
    const transaction = String(message?.transaction || "");
    if (!transaction.startsWith("dinodia-obs-")) return;
    const pending = this.pending.get(transaction);
    // A late reply (after the request timed out into pending delivery) still counts.
    const key = pending?.key || [...this.records.values()].find((record) => record.lastTransaction === transaction)?.key;
    this.pending.delete(transaction);
    const record = key ? this.records.get(key) : null;
    if (!record) return;
    if (record.lastTransaction !== transaction || record.lastRequestKind && record.lastRequestKind !== kind) return;
    this.interrupted.delete(record.key);
    const now = this.clock();
    if (String(message?.status || "").toLowerCase() !== "ok") {
      return this.deliveryFailed(record, 'bridge_request_rejected');
    }
    if (kind === "configure") {
      // Accepted is not proof: read the device back next.
      return this.save({ ...record, state: STATES.UNKNOWN, pendingRequest: null, nextAttemptAt: now, lastError: null, updatedAt: now });
    }
    const config = Array.isArray(message?.data?.configs) && message.data.configs.length === 1 ? message.data.configs[0] : null;
    const attributeId = { runningState: 41, onOff: 0, currentLevel: 0 }[record.attribute];
    if (!config || !Number.isInteger(config.status)
      || config.attrId !== undefined && Number(config.attrId) !== attributeId
      || config.attribute !== undefined && config.attribute !== record.attribute
      || message.data?.endpoint !== undefined && String(message.data.endpoint) !== String(record.endpoint)
      || message.data?.cluster !== undefined && String(message.data.cluster) !== String(record.cluster)) {
      return this.deliveryFailed(record, "invalid_reporting_reply");
    }
    const status = Number(config?.status);
    if (status === ZCL_UNSUPPORTED_ATTRIBUTE || status === ZCL_UNREPORTABLE_ATTRIBUTE) {
      return this.save({ ...record, state: STATES.UNSUPPORTED, pendingRequest: null, readBack: { status, at: new Date(now).toISOString() }, lastError: null, updatedAt: now });
    }
    const readBack = status === ZCL_SUCCESS
      ? { status, at: new Date(now).toISOString(), minimumReportInterval: Number(config.minRepIntval), maximumReportInterval: Number(config.maxRepIntval),
        reportableChange: config.repChange === undefined ? null : Number(config.repChange) }
      : { status: Number.isFinite(status) ? status : null, at: new Date(now).toISOString() };
    if (status !== ZCL_SUCCESS && status !== ZCL_NOT_FOUND) return this.deliveryFailed(record, "reporting_read_rejected");
    if (status === ZCL_SUCCESS && (!Number.isInteger(readBack.minimumReportInterval)
      || !Number.isInteger(readBack.maximumReportInterval) || readBack.minimumReportInterval < 0
      || readBack.maximumReportInterval < 0 || readBack.minimumReportInterval > 65535 || readBack.maximumReportInterval > 65535)) {
      return this.deliveryFailed(record, "invalid_reporting_reply");
    }
    const genericGuarantee = record.profileId.startsWith('generic.') && status === ZCL_SUCCESS && readBack.maximumReportInterval > 0
      && readBack.maximumReportInterval < 65535 && readBack.minimumReportInterval <= readBack.maximumReportInterval;
    if (status === ZCL_SUCCESS && (reportingMatches(readBack, record.desired) || genericGuarantee)) {
      // Read-back verifies configuration only. Recovery from a failed cadence
      // needs a new sequence of genuine value reports after this verification.
      this.reportTimes.delete(record.key);
      return this.save({ ...record, state: STATES.CADENCE_PENDING, readBack, pendingRequest: null,
        ...(genericGuarantee ? { desired: { ...record.desired, maximumReportInterval: readBack.maximumReportInterval } } : {}),
        sourceGeneration: this.store.syncSourceGeneration ?? null, evidenceVersion: 2,
        proofRevision: Math.max(0, Number(record.proofRevision) || 0) + 1,
        cadence: null, cadenceEvidence: [], evidenceVerifiedAt: null, lastError: null, updatedAt: now });
    }
    // Absent (0x8B) or different: drifted; configure only for approved profiles (all records are).
    return this.save({ ...record, state: record.approvedForAutomaticConfiguration === false ? STATES.UNSUPPORTED : STATES.DRIFTED,
      readBack, pendingRequest: null, nextAttemptAt: now, lastError: status === ZCL_NOT_FOUND ? "not_configured" : "differs", updatedAt: now });
  }
}

module.exports = { DEFAULTS, ObservationReconciler, STATES, recordKey };
