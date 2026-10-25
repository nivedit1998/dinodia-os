'use strict';

const crypto = require('node:crypto');
const { buildPresentation } = require('./devicePresentation');

const MAX_CHANNELS = 32;
const MAX_SOURCES = 256;
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };

function sourceDefinition(entity) {
  return { id: entity.id, endpoint: String(entity.endpointId || '0'), property: entity.binding?.property || entity.stateKey,
    bindings: entity.capability?.bindings || [], semanticRole: entity.capability?.semanticRole,
    readable: entity.capability?.readable === true, writable: entity.capability?.writable === true };
}

/** A channel is an adapter-declared functional endpoint, never a suffix guessed from its name. */
function channelManifest(device) {
  if (!device || !device.id) fail('logical_parent_missing', 'The physical device is unavailable');
  const entities = Object.values(device.entities || {});
  if (entities.length > MAX_SOURCES) fail('logical_source_limit', 'The device has too many source controls');
  const groups = new Map();
  const unresolvedSourceIds = [];
  for (const entity of entities) {
    const cap = entity?.capability;
    if (!entity?.id || !cap || cap.category === 'diagnostic' || cap.category === 'config'
      || ['battery', 'linkquality', 'voltage'].includes(String(entity.stateKey))) continue;
    if (cap.readable !== true && cap.writable !== true) continue;
    const endpoint = String(entity.endpointId || '0');
    let verified = false;
    if (device.protocol === 'zigbee') {
      verified = entity.converter?.endpoint != null && String(entity.converter.endpoint) === endpoint
        && entity.binding?.adapter === 'zigbee'
        && String(entity.binding.endpoint) === endpoint;
    } else if (device.protocol === 'matter') {
      verified = endpoint !== '0' && /^\d+$/.test(endpoint) && entity.binding?.adapter === 'matter';
    }
    // Endpoint zero/default still describes a single compound device; it is not proof of splitting.
    if (!verified && endpoint !== '0') { unresolvedSourceIds.push(entity.id); continue; }
    const key = verified ? endpoint : '0';
    const group = groups.get(key) || [];
    group.push(entity);
    groups.set(key, group);
  }
  if (groups.size > MAX_CHANNELS) fail('logical_channel_limit', 'The device has too many independent channels');
  const channels = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([channelKey, sources]) => ({
    channelKey,
    sourceEntityIds: sources.map(source => source.id).sort(),
    sourceDigest: hash(sources.map(sourceDefinition).sort((a, b) => a.id.localeCompare(b.id))),
  }));
  const manifest = { version: 1, physicalDeviceId: device.id, protocol: device.protocol,
    channels, unresolvedSourceIds: unresolvedSourceIds.sort() };
  return { ...manifest, digest: hash(manifest) };
}

function logicalId(physicalId, channelKey, generation = 1) {
  return `logical:v1:${hash([physicalId, channelKey, generation])}`;
}

function registry(state) {
  return state.logicalDevices && state.logicalDevices.version === 1 ? state.logicalDevices
    : { version: 1, revision: 0, parents: {}, children: {}, tombstones: {} };
}

function assignInState(state, physicalId, input) {
  const parent = state.devices[physicalId];
  const manifest = channelManifest(parent);
  if (input?.expectedManifestDigest !== manifest.digest) fail('logical_manifest_changed', 'Refresh the channel inventory');
  if (manifest.unresolvedSourceIds.length) fail('logical_mapping_unproven', 'Some controls have no verified endpoint mapping');
  if (!Array.isArray(input.assignments) || input.assignments.length < 1 || input.assignments.length > MAX_CHANNELS)
    fail('logical_assignments_invalid', 'Choose at least one supported channel');
  const current = registry(state);
  const keys = new Set();
  const children = [];
  for (const assignment of input.assignments) {
    if (!assignment || keys.has(assignment.channelKey)) fail('logical_duplicate_channel', 'A channel can be assigned only once');
    keys.add(assignment.channelKey);
    const channel = manifest.channels.find(c => c.channelKey === assignment.channelKey);
    if (!channel || !state.areas[assignment.areaId]) fail('logical_assignment_invalid', 'Select a supported channel and existing Area');
    if (!state.labels[assignment.labelId]) fail('logical_label_invalid', 'Select an existing label');
    const existing = Object.values(current.children).find(c => c.physicalDeviceId === physicalId && c.channelKey === channel.channelKey);
    if (existing?.suppressed === true) fail('logical_channel_retired', 'This channel requires explicit recommissioning');
    const id = existing?.id || logicalId(physicalId, channel.channelKey);
    if (current.tombstones[id]) fail('logical_channel_retired', 'This channel was removed');
    const name = String(assignment.name || `${parent.name} ${channel.channelKey}`).trim();
    if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f]/.test(name)) fail('logical_name_invalid', 'Enter a valid device name');
    children.push({ id, physicalDeviceId: physicalId, channelKey: channel.channelKey,
      channelGeneration: existing?.channelGeneration || 1,
      mappingRevision: existing && existing.areaId === assignment.areaId && existing.name === name
        && existing.labelIds?.[0] === assignment.labelId && existing.sourceDigest === channel.sourceDigest
        ? existing.mappingRevision : (existing?.mappingRevision || 0) + 1,
      manifestDigest: manifest.digest, sourceDigest: channel.sourceDigest,
      sourceEntityIds: channel.sourceEntityIds,
      areaId: assignment.areaId, name, labelIds: [assignment.labelId], suppressed: false });
  }
  const next = copy(current);
  next.revision += 1;
  next.parents[physicalId] = { manifestDigest: manifest.digest, manifest, revision: next.revision };
  for (const child of children) next.children[child.id] = child;
  state.logicalDevices = next;
  return children;
}

/** Fresh projections read raw source evidence rather than copying readings into a second Store. */
function projectChild(state, id) {
  const r = registry(state);
  const child = r.children[id];
  if (!child || child.suppressed || r.tombstones[id]) return null;
  const parent = state.devices[child.physicalDeviceId];
  if (!parent) return null;
  let manifest;
  try { manifest = channelManifest(parent); } catch { return null; }
  const channel = manifest.channels.find(c => c.channelKey === child.channelKey);
  if (!channel || channel.sourceDigest !== child.sourceDigest) return null;
  const entities = {};
  for (const sourceId of child.sourceEntityIds) {
    if (!parent.entities[sourceId]) return null;
    entities[sourceId] = copy(parent.entities[sourceId]);
  }
  const sourceProperties = new Set(Object.values(entities).map(entity => entity.stateKey).filter(Boolean));
  const result = { ...copy(parent), id: child.id, physicalDeviceId: parent.id,
    channelKey: child.channelKey, mappingRevision: child.mappingRevision,
    name: child.name, areaId: child.areaId, labelIds: child.labelIds,
    legacyIds: [], haDeviceId: undefined, entities,
    state: Object.fromEntries(Object.entries(parent.state || {}).filter(([key]) => sourceProperties.has(key))),
    setup: { ...parent.setup, status: 'ready' },
    presentation: undefined };
  result.presentation = buildPresentation(result);
  result.presentation.descriptorRevision = Math.max(result.presentation.descriptorRevision || 1, child.mappingRevision);
  return result;
}

function managedDevices(state) {
  const r = registry(state);
  const raw = Object.values(state.devices || {}).filter(parent => !r.parents[parent.id]);
  return [...raw.map(copy), ...Object.keys(r.children).map(id => projectChild(state, id)).filter(Boolean)];
}

function suppressedSourceIds(state, physicalId) {
  return new Set(Object.values(registry(state).children)
    .filter(child => child.physicalDeviceId === physicalId && child.suppressed)
    .flatMap(child => child.sourceEntityIds));
}

function suppressInState(state, id) {
  const r = registry(state);
  const child = r.children[id];
  if (!child) fail('logical_child_missing', 'The logical device is unavailable');
  if (child.suppressed) return false;
  child.suppressed = true;
  r.revision += 1;
  r.tombstones[id] = { physicalDeviceId: child.physicalDeviceId, channelKey: child.channelKey,
    channelGeneration: child.channelGeneration, revision: r.revision };
  const parent = state.devices[child.physicalDeviceId];
  for (const sourceId of child.sourceEntityIds) {
    const entity = parent?.entities?.[sourceId];
    if (!entity) continue;
    for (const key of ['state', 'lastReported', 'lastReportedAt', 'lastChanged', 'sourceObservedAt',
      'sourceReceivedAt', 'admittedEvidence', 'pendingState', 'pendingValue']) delete entity[key];
  }
  state.logicalDevices = r;
  return true;
}

module.exports = { channelManifest, logicalId, registry, assignInState, projectChild,
  managedDevices, suppressedSourceIds, suppressInState, MAX_CHANNELS, MAX_SOURCES };
