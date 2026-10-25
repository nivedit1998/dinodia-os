'use strict';
const { channelManifest, assignInState, projectChild } = require('../capabilities/logicalDevices');
const { buildPublicCommissioningCatalogue } = require('./publicDeviceCatalogue');

/** Prepare a bounded, value-free channel proposal from the actual current adapter inventory. */
function buildLogicalCommissioningProposal({ device, homeId, membershipId, managementClass,
  areaId, hubAreaId, name, customerLabel, labels, now }) {
  const manifest = channelManifest(device);
  if (manifest.channels.length < 2 || manifest.unresolvedSourceIds.length) return null;
  const labelId = device.labelIds?.find(id => labels.some(label => label.id === id)) || labels[0]?.id;
  if (!labelId) return null;
  const baseName = String(name || device.name || 'Device').slice(0, 65);
  const state = { devices: { [device.id]: JSON.parse(JSON.stringify(device)) },
    areas: { [hubAreaId]: { id: hubAreaId } }, labels: Object.fromEntries(labels.map(label => [label.id, label])) };
  const assignments = manifest.channels.map(channel => ({ channelKey: channel.channelKey,
    areaId: hubAreaId, name: `${baseName} ${channel.channelKey}`.slice(0, 80), labelId }));
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
