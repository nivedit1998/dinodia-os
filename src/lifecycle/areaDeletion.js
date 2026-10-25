'use strict';
const crypto = require('node:crypto');
const logical = require('../capabilities/logicalDevices');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
const ref = (kind, id) => hash([kind, id]);

function ledger(state) {
  return state.deletionLedger || { version: 1, revision: 0, areas: {}, devices: {}, sources: {}, jobs: {} };
}
function blocked(state, kind, id) { return Boolean(ledger(state)[kind]?.[ref(kind, String(id))]); }

/** Exact transport/source inventory, with no private values in the operator preview. */
function plan(state, areaId) {
  const area = state.areas[areaId];
  if (!area || blocked(state, 'areas', areaId)) fail('area_delete_missing', 'The Area is unavailable');
  const devices = logical.managedDevices(state);
  const targets = devices.filter(device => device.areaId === areaId);
  if (targets.some(device => Object.values(device.entities || {}).some(entity => entity.areaId && entity.areaId !== areaId)))
    fail('area_delete_legacy_shared_assignment', 'Review the shared channel assignments first');
  const entries = targets.map(device => ({ id: device.id, physicalId: device.physicalDeviceId || device.id,
    protocol: device.protocol, sourceIds: Object.keys(device.entities || {}).sort(),
    mappingRevision: device.mappingRevision || 0 } )).sort((a, b) => a.id.localeCompare(b.id));
  const targetIds = new Set(entries.map(entry => entry.id));
  const parents = [...new Set(entries.map(entry => entry.physicalId))].sort().map(id => ({ id,
    preservedChildren: devices.filter(device => device.physicalDeviceId === id && !targetIds.has(device.id)).map(device => device.id).sort(),
    protocol: state.devices[id]?.protocol }));
  const inventory = { areaId, name: area.name, targets: entries, parents };
  return { ...inventory, digest: hash(inventory) };
}

function fence(state, operationId, input) {
  const existing = ledger(state).jobs[operationId];
  if (existing) {
    if (existing.digest !== input.digest || existing.cloudDigest !== input.cloudDigest)
      fail('area_delete_operation_conflict', 'The deletion operation changed');
    return copy(existing);
  }
  const current = plan(state, input.areaId);
  if (current.digest !== input.digest || input.confirmationName !== current.name)
    fail('area_delete_preview_changed', 'The Area changed; refresh the preview');
  if (!/^[a-f0-9]{64}$/.test(input.cloudDigest)) fail('area_delete_cloud_preview_missing', 'A current cloud preview is required');
  const next = copy(ledger(state));
  next.revision += 1;
  next.areas[ref('areas', current.areaId)] = next.revision;
  for (const target of current.targets) {
    next.devices[ref('devices', target.id)] = next.revision;
    for (const id of target.sourceIds) next.sources[ref('sources', id)] = next.revision;
    const child = logical.registry(state).children[target.id];
    if (child) logical.suppressInState(state, child.id);
  }
  for (const parent of current.parents) if (!parent.preservedChildren.length)
    next.devices[ref('devices', parent.id)] = next.revision;
  const job = { version: 1, operationId, state: 'FENCED', digest: current.digest,
    cloudDigest: input.cloudDigest, inventory: current,
    fenceDigest: hash([operationId, current.digest, input.cloudDigest, next.revision]),
    physical: Object.fromEntries(current.parents.map(parent => [parent.id,
      parent.preservedChildren.length ? 'PRESERVED_SHARED_PARENT' : 'REMOVAL_PENDING'])) };
  next.jobs[operationId] = job;
  state.deletionLedger = next;
  // Fences must affect old customer projections too, not merely the new registry.
  for (const target of current.targets) {
    const parent = state.devices[target.physicalId];
    if (parent && !target.id.startsWith('logical:v1:')) {
      parent.areaId = null;
      parent.setup = { ...(parent.setup || {}), status: 'needs_setup', reason: 'area_deletion_pending' };
    }
    if (state.platform?.devicePolicies?.[target.id]) state.platform.devicePolicies[target.id].lifecycle = 'REMOVAL_PENDING';
  }
  return copy(job);
}

function reconcile(state, authoritativeLedger, { purgeRestored = false } = {}) {
  if (!authoritativeLedger) return;
  if (authoritativeLedger.version !== 1 || !Number.isSafeInteger(authoritativeLedger.revision)
    || !['areas', 'devices', 'sources', 'jobs'].every(key => authoritativeLedger[key] && typeof authoritativeLedger[key] === 'object'))
    fail('area_delete_ledger_invalid', 'The deletion security ledger is invalid');
  const local = ledger(state);
  if (local.revision > authoritativeLedger.revision) fail('area_delete_ledger_regressed', 'The deletion security ledger is older than the Store');
  state.deletionLedger = copy(authoritativeLedger);
  if (purgeRestored) {
    const references = new Set();
    const visit = value => {
      if (typeof value === 'string') {
        if (['areas', 'devices', 'sources'].some(kind => blocked(state, kind, value))) references.add(value);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { visit(key); visit(item); }
    };
    // Never rewrite signed uploads: the cloud owns their erased-target acknowledgement.
    for (const [key, value] of Object.entries(state)) if (!['syncOutbox', 'deletionLedger'].includes(key)) visit(value);
    purgeReferences(state, references);
    const pendingParents = new Set(Object.values(authoritativeLedger.jobs).flatMap(job =>
      Object.entries(job.physical || {}).filter(([, status]) => status === 'REMOVAL_PENDING').map(([id]) => id)));
    for (const id of Object.keys(state.devices || {})) {
      if (!blocked(state, 'devices', id) || pendingParents.has(id)) continue;
      delete state.devices[id];
      delete state.logicalDevices?.parents?.[id];
    }
    for (const id of Object.keys(state.logicalDevices?.children || {})) {
      if (blocked(state, 'devices', id)) delete state.logicalDevices.children[id];
    }
    for (const id of Object.keys(state.areas || {})) if (blocked(state, 'areas', id)) delete state.areas[id];
  }
  for (const child of Object.values(logical.registry(state).children)) {
    if (blocked(state, 'devices', child.id) && !child.suppressed) logical.suppressInState(state, child.id);
  }
  for (const device of Object.values(state.devices || {})) {
    for (const [id, entity] of Object.entries(device.entities || {})) {
      if (!blocked(state, 'sources', id)) continue;
      if (entity.stateKey && device.state) delete device.state[entity.stateKey];
      for (const key of ['state', 'lastReported', 'lastReportedAt', 'sourceObservedAt', 'sourceReceivedAt', 'admittedEvidence', 'pendingValue', 'pendingState']) delete entity[key];
    }
    if (blocked(state, 'devices', device.id) || blocked(state, 'areas', device.areaId)) {
      device.areaId = null;
      device.setup = { ...(device.setup || {}), status: 'needs_setup', reason: 'area_deleted' };
    }
  }
}

function contains(value, references) {
  if (typeof value === 'string') return references.has(value);
  if (Array.isArray(value)) return value.some(item => contains(item, references));
  return value && typeof value === 'object' && Object.entries(value).some(([key, item]) => references.has(key) || contains(item, references));
}
function prune(value, references) {
  if (Array.isArray(value)) return value.filter(item => !contains(item, references));
  return Object.fromEntries(Object.entries(value || {}).filter(([key, item]) => !references.has(key) && !contains(item, references)));
}

function purgeReferences(state, references) {
  for (const field of ['aliases', 'states', 'events', 'remoteBindings', 'legacyAutomations', 'automations',
    'automationTriggers', 'automationActions', 'automationExecutions', 'automationOccurrences', 'automationIdempotency', 'pairingSessions']) {
    if (state[field]) state[field] = prune(state[field], references);
  }
  if (state.security?.nativeCommandResults) state.security.nativeCommandResults = prune(state.security.nativeCommandResults, references);
  if (state.observationPolicy?.records) state.observationPolicy.records = prune(state.observationPolicy.records, references);
  for (const field of ['electricUsage', 'heatingUsage', 'syncUsage', 'activity', 'incidents', 'heatingDemandController']) {
    if (state[field] && typeof state[field] === 'object') {
      for (const [key, value] of Object.entries(state[field])) {
        if (value && typeof value === 'object') state[field][key] = prune(value, references);
      }
    }
  }
}

/** Signed in-flight uploads are deliberately untouched. Cloud suppression must acknowledge them. */
function purge(state, operationId) {
  const job = ledger(state).jobs[operationId];
  if (!job || job.state !== 'CLOUD_COMMITTED') fail('area_delete_not_committed', 'The cloud has not committed this deletion');
  if (Object.values(job.physical).some(status => status === 'REMOVAL_PENDING'))
    fail('area_delete_physical_pending', 'Physical removal is not yet acknowledged');
  const references = new Set([job.inventory.areaId, ...job.inventory.targets.flatMap(target => [target.id, ...target.sourceIds])]);
  for (const parent of job.inventory.parents) {
    if (parent.preservedChildren.length) continue;
    references.add(parent.id);
    delete state.devices[parent.id];
    delete state.logicalDevices?.parents?.[parent.id];
  }
  for (const target of job.inventory.targets) {
    delete state.logicalDevices?.children?.[target.id];
    delete state.logicalDevices?.tombstones?.[target.id];
    delete state.platform?.devicePolicies?.[target.id];
    delete state.platform?.pendingPropertyDevicePolicies?.[target.id];
  }
  delete state.areas[job.inventory.areaId];
  purgeReferences(state, references);
  job.state = 'LOCAL_PURGED';
  return copy(job);
}

module.exports = { ledger, blocked, plan, fence, reconcile, purge, ref };
