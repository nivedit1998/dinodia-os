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
const { DELIVERY_GRACE_SECONDS, cachedReportingFor, entityEndpoint, matchObservationProfile, reportingMatches } = require("./profiles");

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
    this.records = new Map(Object.entries(store.getObservationPolicyRecords?.() || {}));
    this.reportTimes = new Map(); // key -> recent report times (memory only; cadence restarts after a Hub restart)
    this.availability = new Map(); // deviceId -> boolean
    this.lastCommandAt = 0;
    this.pending = new Map(); // transaction -> { key, kind, sentAt }
  }

  status() {
    return [...this.records.values()].map((record) => ({
      deviceId: record.deviceId, profileId: record.profileId, endpoint: record.endpoint, state: record.state,
      readBack: record.readBack || null, cadence: record.cadence || null, attempts: record.attempts || 0,
      nextAttemptAt: record.nextAttemptAt || null, lastError: record.lastError || null,
    }));
  }

  async save(record) {
    this.records.set(record.key, record);
    await this.store.putObservationPolicyRecord(record.key, record);
  }

  async remove(key) {
    this.records.delete(key);
    this.reportTimes.delete(key);
    for (const [transaction, pending] of this.pending) if (pending.key === key) this.pending.delete(transaction);
    await this.store.putObservationPolicyRecord(key, null);
  }

  /// Zigbee2MQTT bridge/devices (retained, complete inventory). Creates, resets or schedules
  /// records; never sends commands itself (tick() does, within budget).
  async onInventory(rawDevices) {
    if (!Array.isArray(rawDevices)) return;
    const now = this.clock();
    const seen = new Set();
    for (const raw of rawDevices) {
      if (!raw || raw.type === "Coordinator") continue;
      const deviceId = this.resolveDeviceId(raw.friendly_name || raw.ieee_address);
      const device = deviceId ? this.store.getDevice(deviceId) : null;
      if (!device) continue;
      const fingerprint = fingerprintOf(raw);
      for (const entity of Object.values(device.entities || {})) {
        const profile = matchObservationProfile(device, entity);
        if (!profile || !profile.approvedForAutomaticConfiguration || !profile.desired) continue;
        const endpoint = entityEndpoint(entity);
        const key = recordKey(deviceId, profile.id, endpoint);
        seen.add(key);
        const cached = cachedReportingFor(raw, profile, endpoint);
        const existing = this.records.get(key);
        if (!existing || !sameFingerprint(existing.fingerprint, fingerprint) || existing.profileVersion !== profile.version) {
          // New device, replacement, firmware/model change or new profile version: start from
          // unknown and read the device's actual configuration first.
          await this.save({ key, deviceId, ieee: fingerprint.ieee, friendlyName: String(raw.friendly_name || raw.ieee_address),
            profileId: profile.id, profileVersion: profile.version, endpoint, cluster: profile.cluster, attribute: profile.attribute,
            desired: profile.desired, fingerprint, cached, readBack: null, cadence: null, state: STATES.UNKNOWN,
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
      if (!seen.has(key) && !stillPresent) await this.remove(key);
    }
  }

  onAvailability(deviceId, online) {
    this.availability.set(String(deviceId), online === true);
  }

  isAvailable(deviceId) {
    if (this.availability.has(String(deviceId))) return this.availability.get(String(deviceId));
    return this.store.getDevice?.(String(deviceId))?.available !== false;
  }

  /// A genuine observation of a profiled value (provenance already checked by mqttBridge).
  async onValueObserved(deviceId, property, endpoint, observedAtIso) {
    const observedMs = Date.parse(String(observedAtIso || ""));
    if (!Number.isFinite(observedMs)) return;
    for (const record of this.records.values()) {
      if (record.deviceId !== String(deviceId) || record.endpoint !== String(endpoint ?? record.endpoint)) continue;
      if (!record.profileId.endsWith(`.${property}`)) continue;
      const times = [...(this.reportTimes.get(record.key) || []), observedMs].slice(-this.options.maxReportTimes);
      this.reportTimes.set(record.key, times);
      const limitSeconds = record.desired.maximumReportInterval + DELIVERY_GRACE_SECONDS;
      const gaps = times.slice(1).map((time, index) => (time - times[index]) / 1000);
      const lastGap = gaps.at(-1);
      let state = record.state;
      if ([STATES.CADENCE_PENDING, STATES.CADENCE_VERIFIED].includes(state) && Number.isFinite(lastGap) && lastGap > limitSeconds && this.isAvailable(deviceId)) {
        state = STATES.CADENCE_FAILED; // the promise was not kept; read the device back
      } else if ([STATES.CADENCE_PENDING, STATES.CADENCE_FAILED].includes(state)) {
        const recent = gaps.slice(-(this.options.cadenceReportsToVerify - 1));
        if (recent.length >= this.options.cadenceReportsToVerify - 1 && recent.every((gap) => gap <= limitSeconds)) state = STATES.CADENCE_VERIFIED;
      }
      const cadence = { lastReportAt: new Date(observedMs).toISOString(), lastGapSeconds: Number.isFinite(lastGap) ? Math.round(lastGap) : null,
        verifiedAt: state === STATES.CADENCE_VERIFIED ? (record.cadence?.verifiedAt || new Date(observedMs).toISOString()) : null };
      if (state !== record.state) {
        await this.save({ ...record, state, cadence, nextAttemptAt: state === STATES.CADENCE_FAILED ? this.clock() : record.nextAttemptAt, updatedAt: this.clock() });
      } else {
        this.records.set(record.key, { ...record, cadence }); // memory only: no Store write per report
      }
    }
  }

  /// One bounded step: at most one reporting request, only when due, budgeted and the device is
  /// reachable. Also expires unanswered requests into "pending delivery".
  async tick() {
    const now = this.clock();
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
      if (Number.isFinite(last) && now - last > silentMs && this.isAvailable(record.deviceId)) {
        await this.save({ ...record, state: STATES.UNKNOWN, nextAttemptAt: now, lastError: "value_silent", updatedAt: now });
      }
    }
    if (now - this.lastCommandAt < this.options.commandSpacingMs) return null;
    if ([...this.pending.values()].length) return null; // one outstanding request at a time
    const due = [...this.records.values()]
      .filter((record) => [STATES.UNKNOWN, STATES.DRIFTED, STATES.CADENCE_FAILED, STATES.PENDING_DELIVERY].includes(record.state))
      .filter((record) => (record.nextAttemptAt || 0) <= now && this.isAvailable(record.deviceId))
      .sort((a, b) => (a.nextAttemptAt || 0) - (b.nextAttemptAt || 0))[0];
    if (!due) return null;
    const configure = due.state === STATES.DRIFTED || (due.state === STATES.PENDING_DELIVERY && due.retryKind === "configure");
    if (configure && !this.mayConfigure(due, now)) return null;
    return this.send(due, configure ? "configure" : "read", now);
  }

  mayConfigure(record, now) {
    const windowStart = Number(record.attemptsWindowStartAt || 0);
    const attempts = now - windowStart > 24 * 3_600_000 ? 0 : Number(record.attempts || 0);
    return attempts < this.options.maxConfigureAttemptsPerDay;
  }

  async send(record, kind, now) {
    const transaction = `dinodia-obs-${crypto.randomBytes(6).toString("hex")}`;
    const payload = kind === "configure"
      ? { id: record.ieee || record.friendlyName, endpoint: Number(record.endpoint), cluster: record.cluster, attribute: record.attribute,
        minimum_report_interval: record.desired.minimumReportInterval, maximum_report_interval: record.desired.maximumReportInterval,
        reportable_change: record.desired.reportableChange, transaction }
      : { id: record.ieee || record.friendlyName, endpoint: Number(record.endpoint), cluster: record.cluster, configs: [{ attribute: record.attribute }], transaction };
    this.lastCommandAt = now;
    this.pending.set(transaction, { key: record.key, kind, sentAt: now });
    const windowExpired = now - Number(record.attemptsWindowStartAt || 0) > 24 * 3_600_000;
    await this.save({ ...record, state: kind === "configure" ? STATES.CONFIGURING : STATES.READ_PENDING, lastTransaction: transaction,
      attempts: kind === "configure" ? (windowExpired ? 1 : Number(record.attempts || 0) + 1) : Number(record.attempts || 0),
      attemptsWindowStartAt: kind === "configure" && windowExpired ? now : record.attemptsWindowStartAt, updatedAt: now });
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
    await this.save({ ...record, state: exhausted ? STATES.FAILED : STATES.PENDING_DELIVERY, retryKind: wasConfigure ? "configure" : "read",
      nextAttemptAt: now + wait, lastError: reason, updatedAt: now });
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
    const now = this.clock();
    if (String(message?.status || "").toLowerCase() !== "ok") {
      return this.deliveryFailed(record, `bridge_${String(message?.error || "error").slice(0, 60)}`);
    }
    if (kind === "configure") {
      // Accepted is not proof: read the device back next.
      return this.save({ ...record, state: STATES.UNKNOWN, nextAttemptAt: now, lastError: null, updatedAt: now });
    }
    const config = Array.isArray(message?.data?.configs) ? message.data.configs[0] : null;
    const status = Number(config?.status);
    if (status === ZCL_UNSUPPORTED_ATTRIBUTE || status === ZCL_UNREPORTABLE_ATTRIBUTE) {
      return this.save({ ...record, state: STATES.UNSUPPORTED, readBack: { status, at: new Date(now).toISOString() }, lastError: null, updatedAt: now });
    }
    const readBack = status === ZCL_SUCCESS
      ? { status, at: new Date(now).toISOString(), minimumReportInterval: Number(config.minRepIntval), maximumReportInterval: Number(config.maxRepIntval),
        reportableChange: config.repChange === undefined ? null : Number(config.repChange) }
      : { status: Number.isFinite(status) ? status : null, at: new Date(now).toISOString() };
    if (status === ZCL_SUCCESS && reportingMatches(readBack, record.desired)) {
      const state = record.state === STATES.CADENCE_VERIFIED || record.cadence?.verifiedAt ? STATES.CADENCE_VERIFIED : STATES.CADENCE_PENDING;
      return this.save({ ...record, state, readBack, lastError: null, updatedAt: now });
    }
    // Absent (0x8B) or different: drifted; configure only for approved profiles (all records are).
    return this.save({ ...record, state: STATES.DRIFTED, readBack, nextAttemptAt: now, lastError: status === ZCL_NOT_FOUND ? "not_configured" : "differs", updatedAt: now });
  }
}

module.exports = { DEFAULTS, ObservationReconciler, STATES, recordKey };
