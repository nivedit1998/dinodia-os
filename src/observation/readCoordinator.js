'use strict';
const crypto = require('node:crypto');
const { planBoundedReads } = require('./freshness');
const { validateReadObservation } = require('./adapterContract');
const KEY = '__read_budget__';
class BoundedReadCoordinator {
  constructor({ store, adapters = {}, admit, clock = () => Date.now() }) {
    this.store = store; this.adapters = adapters; this.admit = admit; this.clock = clock;
    this.state = store.getObservationPolicyRecords?.()[KEY] || { lastHubReadAtMs: 0, lastReadAtByKey: {}, attempts: {}, pending: null };
    this.busy = false;
  }
  async save(next) { await this.store.putObservationPolicyRecord(KEY, next); this.state = next; }
  async tick(targets) {
    if (this.busy) return;
    const now = this.clock();
    if (this.store.isUsageClockTrusted && !this.store.isUsageClockTrusted(now)) return { refused: true, reason: 'clock_not_trusted' };
    const eligible = targets.filter(target => {
      const policy = this.store.getPlatform?.()?.devicePolicies?.[target.deviceId];
      return policy?.managementClass === 'PROPERTY_DEVICE' && policy.ownerMembershipId == null && ['INSTALLED', 'VIEW_ONLY'].includes(policy.lifecycle)
        && policy.analyticsCategory !== 'NONE' && policy.analyticsInterval?.genericCollectionEnabled === true
        && this.adapters[target.integration]?.supports(target) === true;
    }).slice(0, 500);
    const attempts = Object.fromEntries(Object.entries(this.state.attempts).map(([id, times]) => [id, times.filter(at => now - at < 3600000)]).filter(([, times]) => times.length));
    const plan = planBoundedReads({ nowMs: now, values: eligible, lastReadAtByKey: this.state.lastReadAtByKey,
      readsInLastHourByDevice: Object.fromEntries(Object.entries(attempts).map(([id, times]) => [id, times.length])), lastHubReadAtMs: this.state.lastHubReadAtMs });
    if (plan.refused || !plan.due.length) return plan;
    const target = plan.due[0];
    const authorityStamp = JSON.stringify(this.store.getPlatform?.()?.devicePolicies?.[target.deviceId]);
    if (this.state.pending && now < this.state.pending.sentAt + 30000) return;
    const request = { ...target, requestId: crypto.randomUUID(), sentAt: now };
    this.busy = true; let timeout;
    try {
      // Intent and every attempted network operation count before dispatch.
      // A crash or timeout never refunds budget or silently resends it.
      const next = { ...this.state, lastHubReadAtMs: now, lastReadAtByKey: { ...Object.fromEntries(Object.entries(this.state.lastReadAtByKey).filter(([, at]) => now - at < 3600000)), [target.key]: now },
        attempts: { ...attempts, [target.deviceId]: [...(attempts[target.deviceId] || []), now] }, pending: request };
      await this.save(next);
      const response = await Promise.race([this.adapters[target.integration].read(request), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('read_timeout')), 30000); timeout.unref?.();
      })]);
      const authorityUnchanged = authorityStamp === JSON.stringify(this.store.getPlatform?.()?.devicePolicies?.[target.deviceId]);
      const observation = authorityUnchanged ? validateReadObservation(target, request, response, this.clock()) : null;
      if (observation) await this.admit(observation, target);
      await this.save({ ...this.state, pending: null });
      return { accepted: Boolean(observation) };
    } catch (error) {
      if (this.state.pending?.requestId === request.requestId) await this.save({ ...this.state, pending: null });
      return { accepted: false, reason: String(error.code || 'read_failed') };
    } finally { clearTimeout(timeout); this.busy = false; }
  }
}
module.exports = { BoundedReadCoordinator };

function readTargets(store) {
  const { resolveCategoryBinding } = require('../analytics/resolveBinding');
  return store.listDevices().flatMap(device => {
    const policy = store.getPlatform()?.devicePolicies?.[device.id];
    if (!policy?.analyticsInterval?.genericCollectionEnabled) return [];
    const entities = Object.values(device.entities || {});
    const binding = resolveCategoryBinding({ signedPolicy: policy, controls: entities.map(entity => ({ ...entity.capability,
      controlId: entity.capability?.controlId || entity.id, endpointId: entity.endpointId || entity.binding?.endpoint })) });
    const entity = binding.status === 'resolved' && entities.find(item => (item.capability?.controlId || item.id) === binding.primaryControlId);
    if (!entity) return [];
    return [{ key: `${device.id}|${binding.primaryControlId}|${policy.analyticsInterval.revision}`, deviceId: device.id,
      controlId: binding.primaryControlId, endpointId: String(entity.endpointId || entity.binding?.endpoint), property: entity.stateKey,
      integration: device.protocol, power: /mains|dc source|single.phase|three.phase/i.test(String(device.metadata?.power_source || '')) ? 'mains' : 'battery',
      enabled: true, available: device.available, intervalSeconds: 300 }];
  });
}
module.exports.readTargets = readTargets;
