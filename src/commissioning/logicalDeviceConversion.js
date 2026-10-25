'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { buildLogicalCommissioningProposal } = require('./logicalDeviceCatalogue');
const { AreaDeletionService } = require('../lifecycle/areaDeletionService');
const logical = require('../capabilities/logicalDevices');
const { buildPublicCommissioningCatalogue } = require('./publicDeviceCatalogue');
const endpoint = '/api/hub-agent/v2/logical-conversion';
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };

/** Explicit reviewed conversion only. Never triggered by discovery or restart. */
class LogicalDeviceConversion {
  constructor({ store, platform, protocolIdentity }) {
    this.store = store; this.platform = platform; this.protocolIdentity = protocolIdentity;
    this.previews = new Map(); this.queue = Promise.resolve();
  }
  proof(principal) { return AreaDeletionService.prototype.proof.call(this, principal); }
  async assign(principal, id, input) {
    const proof = this.proof(principal), platform = this.store.getPlatform();
    const device = this.store.getManagedDevice(id), policy = platform.devicePolicies?.[id];
    const area = platform.areaBindings?.find(row => row.hubAreaId === input.areaId);
    const label = this.store.getLabel(input.labelId);
    if (!device?.physicalDeviceId || !policy?.logicalBinding || policy.managementClass !== 'PROPERTY_DEVICE'
      || policy.ownerMembershipId || !area || !label || !this.store.getArea(input.areaId))
      fail('logical_assignment_denied', 'Select a current permanent channel, Area and label');
    const operationId = input.operationId;
    if (!/^[0-9a-f-]{36}$/i.test(operationId || '')) fail('logical_assignment_invalid', 'An idempotent assignment is required');
    let pending = this.store.snapshot().logicalAssignments?.[operationId];
    if (pending?.id && pending.id !== id) fail('logical_assignment_conflict', 'The assignment target changed');
    if (!pending) {
      const candidate = this.store.snapshot();
      const child = logical.registry(candidate).children[id];
      child.areaId = input.areaId; child.name = String(input.name || device.name).trim();
      child.labelIds = [label.id]; child.mappingRevision++;
      const projected = logical.projectChild(candidate, id);
      const catalogue = buildPublicCommissioningCatalogue({ device: projected, homeId: platform.homeId,
        managementClass: 'property_device', areaId: area.areaId, name: child.name, customerLabel: label.name });
      const binding = { ...policy.logicalBinding, mappingRevision: child.mappingRevision };
      pending = { id, actor: principal.jti, policy, hubAreaId: area.hubAreaId, areaId: area.areaId,
        assignment: { expectedInventoryRevision: policy.inventoryRevision, areaId: area.areaId, catalogue, binding } };
      await this.store.commit(state => { state.logicalAssignments = { ...(state.logicalAssignments || {}), [operationId]: pending }; });
    }
    if (pending.actor !== principal.jti) fail('logical_assignment_conflict', 'Reopen this assignment in the original session');
    if (pending.hubAreaId !== input.areaId || pending.assignment.catalogue.name !== String(input.name || device.name).trim()
      || pending.assignment.catalogue.customerLabel !== label.name)
      fail('logical_assignment_conflict', 'Retry the original assignment or refresh the current signed configuration');
    const result = await this.platform(endpoint, { action: 'assign', operationId, osDeviceId: id,
      assignment: pending.assignment, ...proof });
    const row = result.device;
    if (result.state !== 'COMPLETE' || !row || row.osDeviceId !== id
      || !isDeepStrictEqual(row.binding, pending.assignment.binding)
      || row.descriptorDigest !== pending.assignment.catalogue.descriptorDigest) fail('logical_assignment_ack_invalid', 'The canonical assignment was not confirmed');
    await this.store.activateLogicalDevicePolicies({ [id]: { ...pending.policy, logicalBinding: row.binding,
      overrideName: row.overrideName, customerLabel: row.customerLabel, inventoryRevision: row.inventoryRevision,
      descriptorRevision: row.descriptorRevision, descriptorDigest: row.descriptorDigest,
      osAreaIds: [pending.hubAreaId], canonicalAreaIds: [pending.areaId] } });
    await this.store.commit(state => { delete state.logicalAssignments[operationId]; });
    return this.store.getManagedDevice(id);
  }
  async preview(principal, selectedId, options = {}) {
    const proof = this.proof(principal), platform = this.store.getPlatform();
    const anchor = this.store.getManagedDevice(selectedId), policy = platform.devicePolicies?.[selectedId];
    const recommission = Boolean(options.channelKey);
    const physicalId = recommission ? anchor?.physicalDeviceId : selectedId;
    const device = recommission ? this.store.getDevice(physicalId) : anchor;
    if (!device || Boolean(anchor?.physicalDeviceId) !== recommission || policy?.managementClass !== 'PROPERTY_DEVICE'
      || policy.ownerMembershipId || !['INSTALLED', 'VIEW_ONLY'].includes(policy.lifecycle))
      fail('logical_conversion_unavailable', 'Select an installed permanent physical device');
    const area = platform.areaBindings?.find(row => row.hubAreaId === anchor.areaId);
    const identity = this.protocolIdentity(device);
    if (!area || !identity) fail('logical_conversion_unproven', 'The current Area or protocol identity cannot be proven');
    let proposal = buildLogicalCommissioningProposal({ device, homeId: platform.homeId,
      membershipId: null, managementClass: 'property_device', areaId: area.areaId, hubAreaId: area.hubAreaId,
      name: device.name, customerLabel: policy.customerLabel || device.customerLabel || 'Device',
      labels: this.store.listLabels(), now: Date.now(),
      ...(recommission ? { retirementEvidence: this.store.snapshot(), allowRecommission: true } : {}) });
    if (!proposal) fail('logical_conversion_unproven', 'Independent functional channels cannot be proven');
    if (recommission) {
      const registry = logical.registry(this.store.snapshot());
      const active = Object.values(registry.children).some(child => child.physicalDeviceId === physicalId
        && child.channelKey === options.channelKey && !child.suppressed && !registry.tombstones[child.id]);
      const channel = proposal.channels.find(row => row.binding.channelKey === options.channelKey);
      if (active || !channel || channel.binding.channelGeneration < 2)
        fail('logical_recommission_unavailable', 'Select a removed channel on this paired permanent device');
      proposal = { ...proposal, channels: [channel], assignments: proposal.assignments.filter(row => row.channelKey === options.channelKey) };
    }
    const operationId = crypto.randomUUID();
    const cloud = await this.platform(endpoint, { action: 'preview', operationId, osDeviceId: selectedId,
      channels: proposal.channels, protocolIdentityHash: identity.hash,
      ...(recommission ? { recommissionChannelKey: options.channelKey } : {}), ...proof });
    const entry = { operationId, physicalId, actor: principal.jti, digest: cloud.digest,
      confirmationName: cloud.confirmationName, proposal, policy, area, identityHash: identity.hash,
      ...(recommission ? { anchorId: selectedId, recommission: true } : {}) };
    this.previews.set(operationId, entry);
    return { operationId, digest: cloud.digest, confirmationName: cloud.confirmationName,
      channelCount: proposal.channels.length, recommission,
      warning: recommission ? 'Restore this removed channel as a new device in the surviving channel’s room. Existing channels and their history stay unchanged. Old data and access do not return. Nothing is paired or switched.'
        : 'This replaces the combined control with independent channels. Existing history stays with the original device; it is not copied. Existing automations need review. Nothing is paired or switched.' };
  }
  confirm(principal, input) {
    const work = this.queue.then(async () => {
      const proof = this.proof(principal);
      let entry = this.store.snapshot().logicalConversions?.[input.operationId] || this.previews.get(input.operationId);
      if (!entry || (!entry.state && entry.actor !== principal.jti) || entry.digest !== input.digest
        || entry.confirmationName !== input.confirmationName) fail('logical_conversion_preview_invalid', 'Review the exact conversion again');
      if (entry.state === 'COMPLETE') return { state: 'COMPLETE', operationId: entry.operationId };
      const current = this.store.getDevice(entry.physicalId);
      if (!current || this.protocolIdentity(current)?.hash !== entry.identityHash
        || this.store.logicalDeviceManifest(entry.physicalId).digest !== entry.proposal.manifest.digest)
        fail('logical_conversion_changed', 'The physical mapping changed; conversion is paused');
      const body = { operationId: entry.operationId, osDeviceId: entry.anchorId || entry.physicalId,
        digest: entry.digest, confirmationName: entry.confirmationName, ...proof };
      if (entry.state !== 'FENCED') {
        await this.store.commit(state => {
          state.logicalConversions = { ...(state.logicalConversions || {}), [entry.operationId]: { ...entry, state: 'RESERVING' } };
        });
        const reserved = await this.platform(endpoint, { ...body, action: 'reserve' });
        if (reserved.state !== 'RESERVED') fail('logical_conversion_reservation_missing', 'The reviewed conversion is not reserved');
        await this.store.commit(state => {
          state.logicalConversions = { ...(state.logicalConversions || {}), [entry.operationId]: { ...entry, state: 'FENCED' } };
          // Existing policy/Area must cease authorizing the broad parent before
          // the canonical cutover. No child becomes authorized until cloud ACK.
          if (!entry.recommission) {
            state.devices[entry.physicalId].areaId = null;
            state.devices[entry.physicalId].metadata = { ...(state.devices[entry.physicalId].metadata || {}), areaId: null };
            state.devices[entry.physicalId].setup = { status: 'needs_setup', reason: 'logical_conversion_pending' };
            state.platform.devicePolicies[entry.physicalId] = { ...entry.policy, lifecycle: 'RETIRED' };
          }
        });
      }
      const result = await this.platform(endpoint, { ...body, action: 'commit' });
      if (result.state !== 'COMPLETE' || !Array.isArray(result.children)
        || result.children.length !== entry.proposal.channels.length) fail('logical_conversion_ack_missing', 'The canonical conversion is not acknowledged');
      const policies = {};
      for (const channel of entry.proposal.channels) {
        const row = result.children.find(child => child.osDeviceId === channel.catalogue.osDeviceId);
        if (!row || row.managementClass !== entry.policy.managementClass || row.ownerMembershipId !== null
          || row.descriptorDigest !== channel.catalogue.descriptorDigest || !isDeepStrictEqual(row.binding, channel.binding))
          fail('logical_conversion_ack_mismatch', 'The canonical channel binding changed');
        const { analyticsInterval: _oldInterval, analyticsStartAt: _oldStart, ...basePolicy } = entry.policy;
        policies[row.osDeviceId] = { ...basePolicy, analyticsCategory: row.analyticsCategory || 'NONE',
          platformDeviceId: row.id, overrideName: channel.catalogue.name,
          inventoryRevision: row.inventoryRevision,
          descriptorRevision: row.descriptorRevision, descriptorDigest: row.descriptorDigest,
          logicalBinding: row.binding, osAreaIds: [entry.area.hubAreaId], canonicalAreaIds: [entry.area.areaId] };
      }
      await this.store.activateLogicalDevicePolicies(policies);
      await this.store.commit(state => { state.logicalConversions[entry.operationId] = {
        operationId: entry.operationId, actor: entry.actor, digest: entry.digest, confirmationName: entry.confirmationName, state: 'COMPLETE' }; });
      this.previews.delete(entry.operationId);
      return { state: 'COMPLETE', operationId: entry.operationId };
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
module.exports = { LogicalDeviceConversion };
