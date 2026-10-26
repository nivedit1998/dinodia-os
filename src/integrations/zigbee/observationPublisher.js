// Publisher-only options: no device reporting writes, polls, commands or restarts.
// Zigbee2MQTT 2.13 supports these through bridge/request[/device]/options.
const crypto = require('node:crypto');
const RESERVED = new Set(['last_seen', 'elapsed', 'endpoint', 'endpoint_id', 'action']);
function observationPropertiesForDevice(device) {
  if (!device || device.protocol !== 'zigbee' || device.retired === true
    || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING', 'RECOMMISSION_REQUIRED'].includes(String(device.lifecycle || '').toUpperCase())) return [];
  return [...new Set(Object.values(device.entities || {}).filter(entity => entity.capability?.readable === true
    && entity.capability?.observable === true && !['event', 'button'].includes(entity.capability?.kind))
    .map(entity => String(entity.stateKey || entity.binding?.property || ''))
    .filter(property => /^[A-Za-z0-9_]{1,100}$/.test(property) && !RESERVED.has(property)))].sort().slice(0, 128);
}
class PublisherObservationSetup {
  constructor({ devices, publish, clock = Date.now, logger = console }) {
    this.devices = devices; this.publish = publish; this.clock = clock; this.logger = logger;
    this.queue = Promise.resolve(); this.reset();
  }
  reset() { this.hasInfo = false; this.info = null; this.pending = null; this.ready = new Map(); this.attempts = new Map(); }
  status() {
    return { state: !this.hasInfo ? 'awaiting_bridge_info' : this.info?.restartRequired ? 'publisher_restart_required'
      : this.pending ? 'applying_publisher_options' : 'ready', readyDevices: this.ready.size,
      warmingDevices: [...this.ready.values()].filter(value => value.flushedAt === null).length };
  }
  candidates() {
    return (this.devices() || []).slice(0, 2000).flatMap(device => {
      const properties = observationPropertiesForDevice(device);
      const ieee = String(device.protocolIdentity?.ieeeAddress || device.metadata?.ieee_address || '').toLowerCase();
      return properties.length && /^0x[0-9a-f]{16}$/.test(ieee) ? [{ device, ieee, properties }] : [];
    });
  }
  matches(candidate) {
    const options = this.info?.devices?.[candidate.ieee];
    return this.info?.active === true && options?.optimistic === false
      && candidate.properties.every(property => options.filtered_cache.includes(property));
  }
  onInfo(value) {
    this.hasInfo = true;
    this.info = { active: value?.restart_required === false && value.config?.advanced?.last_seen === 'ISO_8601',
      restartRequired: value?.restart_required !== false, lastSeen: value?.config?.advanced?.last_seen,
      devices: Object.fromEntries(Object.entries(value?.config?.devices || {}).slice(0, 2000).map(([key, options]) => [key.toLowerCase(), {
        optimistic: options?.optimistic === false ? false : true,
        // Preserve unrelated user cache filters (including regex) when merging.
        filtered_cache: Array.isArray(options?.filtered_cache) ? options.filtered_cache.filter(p => typeof p === 'string' && p.length <= 200).slice(0, 256) : [],
      }])) };
    this.refresh();
  }
  refresh() {
    if (!this.hasInfo) return;
    const current = new Set();
    for (const candidate of this.candidates()) {
      current.add(candidate.device.id);
      const options = this.info.devices[candidate.ieee];
      const protectedProperties = candidate.properties.filter(property => options?.filtered_cache.includes(property));
      if (!this.info.active || options?.optimistic !== false || !protectedProperties.length) { this.ready.delete(candidate.device.id); continue; }
      const signature = JSON.stringify([candidate.ieee, candidate.device.stateEvidenceLifecycleId, protectedProperties]);
      if (this.ready.get(candidate.device.id)?.signature !== signature) {
        this.ready.set(candidate.device.id, { signature, properties: protectedProperties, since: this.clock(), flushedAt: null });
      }
    }
    for (const id of this.ready.keys()) if (!current.has(id)) this.ready.delete(id);
    for (const id of this.attempts.keys()) if (id !== '__global' && !current.has(id)) this.attempts.delete(id);
    if (this.pending && (this.pending.id === '__global' ? this.info.lastSeen === 'ISO_8601'
      : this.candidates().some(c => c.device.id === this.pending.id && this.matches(c)))) this.pending = null;
  }
  onResponse(requestPath, response) {
    if (!this.pending || this.pending.path !== requestPath || response?.transaction !== this.pending.transaction) return;
    if (response.status !== 'ok') {
      this.pending = null;
      this.logger?.warn?.('[observation-publisher] local options deferred; retry is bounded');
    }
    // A response alone is not proof. bridge/info must confirm effective options.
  }
  admit(deviceId, observedAt) {
    const ready = this.ready.get(deviceId), time = Date.parse(observedAt);
    if (!ready || !Number.isFinite(time) || time < ready.since) return false;
    // Z2M state.set returns the old merged cache once while removing filtered
    // properties from its next cache. Discard that first post-setup live packet,
    // including its replays, rather than promote those old values to observations.
    if (ready.flushedAt === null) { ready.flushedAt = time; return false; }
    return time > ready.flushedAt;
  }
  protectedProperties(deviceId) { return this.ready.get(deviceId)?.properties || []; }
  reconcile() {
    const work = this.queue.then(() => this.reconcileOnce());
    this.queue = work.catch(() => {
      this.logger?.warn?.('[observation-publisher] local options unavailable; retry is bounded');
    }); return this.queue;
  }
  async reconcileOnce() {
    if (!this.hasInfo || this.info.restartRequired) return;
    const now = this.clock();
    if (this.pending && now - this.pending.sentAt < 30000) return;
    this.pending = null;
    const candidates = this.candidates();
    if (!candidates.length) return;
    let id, path, payload;
    if (this.info.lastSeen !== 'ISO_8601') {
      id = '__global'; path = 'options'; payload = { options: { advanced: { last_seen: 'ISO_8601' } } };
    } else {
      const candidate = candidates.find(c => !this.matches(c) && now - (this.attempts.get(c.device.id) ?? -Infinity) >= 60000);
      if (!candidate) return;
      id = candidate.device.id; path = 'device/options';
      const existing = this.info.devices[candidate.ieee]?.filtered_cache || [];
      payload = { id: candidate.ieee, options: { optimistic: false, filtered_cache: [...new Set([...existing, ...candidate.properties])] } };
    }
    if (now - (this.attempts.get(id) ?? -Infinity) < 60000) return;
    const transaction = crypto.randomUUID();
    this.pending = { id, path, transaction, sentAt: now }; this.attempts.set(id, now);
    try { await this.publish(path, { ...payload, transaction }); }
    catch (error) { this.pending = null; throw error; }
  }
}
module.exports = { PublisherObservationSetup, observationPropertiesForDevice };
