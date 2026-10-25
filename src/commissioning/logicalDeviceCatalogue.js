'use strict';
const crypto = require('node:crypto');
const { channelManifest, assignInState, projectChild, logicalId, registry } = require('../capabilities/logicalDevices');
const { buildPublicCommissioningCatalogue } = require('./publicDeviceCatalogue');

/** Prepare a bounded, value-free channel proposal from the actual current adapter inventory. */
function buildLogicalCommissioningProposal({ device, homeId, membershipId, managementClass,
  areaId, hubAreaId, name, customerLabel, labels, now, retirementEvidence = null, allowRecommission = false }) {
  const manifest = channelManifest(device);
  if (manifest.channels.length < 2 || manifest.unresolvedSourceIds.length) return null;
  const labelId = device.labelIds?.find(id => labels.some(label => label.id === id)) || labels[0]?.id;
  if (!labelId) return null;
  const baseName = String(name || device.name || 'Device').slice(0, 65);
  const state = { devices: { [device.id]: JSON.parse(JSON.stringify(device)) },
    areas: { [hubAreaId]: { id: hubAreaId } }, labels: Object.fromEntries(labels.map(label => [label.id, label])) };
  if (retirementEvidence) {
    const retained = registry(retirementEvidence);
    state.logicalDevices = { version: 1, revision: retained.revision, parents: {
      [device.id]: JSON.parse(JSON.stringify(retained.parents[device.id] || {})) }, children: {},
      tombstones: {} };
    const hubId = retirementEvidence.platform?.hubInstallId;
    const cloud = new Set(retirementEvidence.platform?.cloudConfiguration?.logicalSecurity?.deletedReferences || []);
    const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const prefix = hubId ? `ld:${crypto.createHash('sha256').update(hubId).digest('hex').slice(0, 10)}:d:` : '';
    for (const channel of manifest.channels) {
      const generations = Object.values(retained.children).filter(row => row.physicalDeviceId === device.id
        && row.channelKey === channel.channelKey && (row.suppressed || retained.tombstones[row.id]))
        .map(row => row.channelGeneration || 1);
      let retired = Math.max(0, Number(retained.parents[device.id]?.retiredGenerations?.[channel.channelKey] || 0), ...generations);
      let generation = retired + 1;
      for (; generation <= 256; generation++) {
        const id = logicalId(device.id, channel.channelKey, generation);
        if (!retirementEvidence.deletionLedger?.devices?.[digest(['devices', id])]
          && !retained.tombstones[id] && !cloud.has(`${prefix}${digest([hubId, 'device', id])}`)) break;
        retired = generation;
      }
      if (generation > 256) throw new Error('Channel generation history requires supervised recovery');
      if (retired) {
        state.logicalDevices.parents[device.id].retiredGenerations ||= {};
        state.logicalDevices.parents[device.id].retiredGenerations[channel.channelKey] = retired;
      }
    }
  }
  const assignments = manifest.channels.map(channel => ({ channelKey: channel.channelKey,
    areaId: hubAreaId, name: `${baseName} ${channel.channelKey}`.slice(0, 80), labelId,
    ...(allowRecommission ? { recommission: true } : {}) }));
  const children = assignInState(state, device.id, { expectedManifestDigest: manifest.digest, assignments });
  const channels = children.map(child => {
    const projected = projectChild(state, child.id);
    const catalogue = buildPublicCommissioningCatalogue({ device: projected, homeId, membershipId,
      managementClass, areaId, name: child.name, customerLabel, now });
    if (!catalogue || catalogue.capabilityStatus !== 'ready') return null;
    const binding = { physicalDeviceId: device.id, channelKey: child.channelKey,
      channelGeneration: child.channelGeneration, mappingRevision: child.mappingRevision,
      manifestDigest: child.manifestDigest, sourceDigest: child.sourceDigest, sourceEntityIds: child.sourceEntityIds };
    return { binding, catalogue };
  });
  return channels.some(channel => !channel) ? null : { manifest, assignments, channels };
}

module.exports = { buildLogicalCommissioningProposal };
