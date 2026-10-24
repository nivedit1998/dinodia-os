'use strict';
const crypto = require('node:crypto');
const { resolvedEndpoint } = require('./profiles');

const POLICY_VERSION = 3;
const GRACE_SECONDS = 60;
const SOURCES = Object.freeze({
  power: ['genOnOff', 'onOff'], brightness: ['genLevelCtrl', 'currentLevel'],
  target_temperature: ['hvacThermostat', 'occupiedHeatingSetpoint'],
  ambient_temperature: ['hvacThermostat', 'localTemp'], active_heat_demand: ['hvacThermostat', 'runningState'],
  operating_mode: ['hvacThermostat', 'systemMode'],
});
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
}
function scalarFor(control, raw) {
  if (control.valueType === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string' && /^(on|off|true|false)$/i.test(raw)) return /^(on|true)$/i.test(raw);
    return null;
  }
  if (control.valueType === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    const bounds = control.constraints || {};
    return (Number.isFinite(bounds.minimum) && raw < bounds.minimum) || (Number.isFinite(bounds.maximum) && raw > bounds.maximum) ? null : raw;
  }
  if (control.valueType === 'option') return control.constraints?.options?.some(option => Object.is(option.value, raw)) ? raw : null;
  if (control.valueType === 'text') return typeof raw === 'string' && Array.from(raw).length <= 128 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : null;
  return null;
}
function exactSource(device, entity, control, generation) {
  const mapping = SOURCES[control.semanticRole];
  const cluster = entity.binding?.cluster || mapping?.[0];
  const attribute = entity.binding?.attribute || mapping?.[1];
  const endpoint = cluster ? resolvedEndpoint(device, entity, cluster) : String(entity.endpointId ?? entity.binding?.endpoint ?? '');
  const property = String(entity.stateKey || entity.binding?.property || '');
  const sourceKey = crypto.createHash('sha256').update(JSON.stringify([
    generation, device.stateEvidenceLifecycleId || null, device.protocol, device.id, control.controlId, endpoint, property, cluster || null, attribute || null,
  ])).digest('hex');
  return { endpoint, property, cluster, attribute, sourceKey };
}

// Authority is deliberately explicit. This pure function grants no permission and performs no I/O.
// Last-report display, point confirmation and duration/current admission remain separate concepts.
function resolveStateEvidence({ device, control, entity, records = [], sourceGeneration,
  authorityValid = false, clockTrusted = false, runtimeSessionId, now = Date.now() }) {
  const output = { value: null, quality: 'unknown', observedAt: null, receivedAt: null,
    validUntil: null, lastReported: null, evidence: { status: 'no_observation', guaranteeId: null, policyRevision: POLICY_VERSION } };
  if (!authorityValid || !device || !control || !entity) return output;
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 1) return output;
  const source = exactSource(device, entity, control, sourceGeneration);
  const saved = entity.lastReported || entity.integrationSnapshot;
  if (saved && !saved.sourceKey) return output; // legacy unbound data cannot be rebound to today's source
  const observation = saved && (saved.sourceGeneration == null || saved.sourceGeneration === sourceGeneration)
    ? saved : { value: entity.state, observedAt: entity.sourceObservedAt, receivedAt: entity.sourceReceivedAt,
      sourceGeneration: entity.sourceGeneration, revision: entity.stateRevision, sourceKey: entity.sourceKey };
  if (observation.sourceGeneration != null && observation.sourceGeneration !== sourceGeneration) return output;
  if (!observation.sourceKey || observation.sourceKey !== source.sourceKey) return output;
  const value = scalarFor(control, observation.value);
  const observed = instant(observation.observedAt), received = instant(observation.receivedAt);
  if (value !== null && !Number.isFinite(observed) && ['matter', 'hive', 'google_nest'].includes(device.protocol)) {
    output.lastReported = { value, observedAt: null, receivedAt: null,
      observationId: crypto.createHash('sha256').update(JSON.stringify([source.sourceKey, value, entity.stateRevision])).digest('hex'),
      sourceKey: source.sourceKey, sourceGeneration, provenance: 'integration_snapshot' };
    output.evidence.status = 'timestamp_unavailable';
    return output;
  }
  if (value === null || !Number.isFinite(observed) || !Number.isFinite(received) || received < observed) return output;
  output.lastReported = { value, observedAt: new Date(observed).toISOString(), receivedAt: new Date(received).toISOString(),
    observationId: crypto.createHash('sha256').update(JSON.stringify([source.sourceKey, observed, observation.revision ?? entity.stateRevision, value])).digest('hex'),
    sourceKey: source.sourceKey, sourceGeneration, provenance: observation.provenance || 'device_report' };
  function limited(status) { output.evidence.status = status; return output; }
  if (!clockTrusted || observed > now || received > now) return limited('clock_untrusted');
  if (device.available === false || device.online === false || device.availability === 'offline') {
    output.quality = 'unavailable'; return limited('device_offline');
  }
  // No tenant-consent-managed reporting adapter exists in this release. Passive
  // values remain visible, but an old property proof is never inherited.
  if (String(device.managementClass || '').toUpperCase() === 'TENANT_DEVICE'
    || device.ownerMembershipId || device.tenantOwnerMembershipId) return limited('no_verified_guarantee');
  if (entity.admittedEvidence && (entity.admittedEvidence.observedAt !== output.lastReported.observedAt
    || entity.admittedEvidence.quality !== 'fresh')) return limited('no_verified_guarantee');
  if (device.protocol !== 'zigbee') return limited('unsupported_guarantee');
  const candidates = (Array.isArray(records) ? records : Object.values(records)).filter(record =>
    record && !record.suspended && !record.invalidatedAt && record.deviceId === device.id
    && record.controlId === control.controlId && String(record.endpoint) === String(source.endpoint)
    && record.property === source.property && record.cluster === source.cluster && record.attribute === source.attribute
    && record.sourceGeneration === sourceGeneration && record.state === 'cadence_verified'
    && record.deviceLifecycleId === device.stateEvidenceLifecycleId
    && typeof runtimeSessionId === 'string' && record.runtimeSessionId === runtimeSessionId
    && record.evidenceVersion === 2 && Number.isFinite(instant(record.evidenceVerifiedAt)) && instant(record.evidenceVerifiedAt) <= observed
    && record.readBack?.status === 0 && Number.isFinite(instant(record.readBack.at))
    && instant(record.readBack.at) <= observed && Number.isFinite(instant(record.cadence?.verifiedAt))
    && instant(record.cadence.verifiedAt) <= observed);
  if (candidates.length !== 1) return limited('no_verified_guarantee');
  const proof = candidates[0], interval = proof.readBack.maximumReportInterval;
  if (!Number.isSafeInteger(interval) || interval <= 0 || interval >= 65535) return limited('unsupported_guarantee');
  let deadline = observed + (interval + GRACE_SECONDS) * 1000;
  const admitted = instant(observation.validUntil || entity.sourceValidUntil);
  // No immutable admission deadline means a saved value cannot borrow today's longer policy.
  if (!Number.isFinite(admitted) || admitted <= observed) return limited('no_verified_guarantee');
  deadline = Math.min(deadline, admitted);
  for (const cutoff of [proof.proofValidUntil, proof.invalidatedAt, device.coverageValidUntil]) {
    if (cutoff != null) {
      const boundary = instant(cutoff);
      if (!Number.isFinite(boundary)) return limited('unsupported_guarantee');
      deadline = Math.min(deadline, boundary);
    }
  }
  const guaranteeId = crypto.createHash('sha256').update(JSON.stringify([
    proof.key, proof.sourceGeneration, proof.proofRevision, proof.readBack.at, proof.evidenceVerifiedAt,
  ])).digest('hex');
  output.evidence.guaranteeId = guaranteeId;
  if (deadline <= now) return limited('expired');
  const ceiling = control.maxStateValiditySeconds;
  if (!Number.isSafeInteger(ceiling) || deadline - observed > ceiling * 1000) return limited('descriptor_limit');
  return { ...output, value, quality: 'fresh', observedAt: output.lastReported.observedAt,
    receivedAt: output.lastReported.receivedAt, validUntil: new Date(deadline).toISOString(),
    evidence: { status: 'verified', guaranteeId, policyRevision: POLICY_VERSION } };
}
module.exports = { POLICY_VERSION, GRACE_SECONDS, resolveStateEvidence, exactSource, scalarFor };
