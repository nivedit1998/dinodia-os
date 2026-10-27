'use strict';
const { resolveCategoryBinding } = require('./resolveBinding');
const { analyticsEligible } = require('./categoryPolicies');
function analyticsReadiness(store, device, policy) {
  const binding = resolveCategoryBinding({ signedPolicy: policy, controls: Object.values(device.entities || {}).map(entity => ({ ...entity.capability,
    controlId: entity.capability?.controlId || entity.id, endpointId: entity.endpointId || entity.binding?.endpoint })) });
  const candidates = binding.candidates.map(group => ({ groupId: group.groupId, controls: (group.controls.some(control => control.semanticRole === 'power')
    ? group.controls.filter(control => control.semanticRole === 'power') : group.controls).map(control => ({ controlId: control.controlId, label: String(control.name || control.semanticRole).slice(0, 80) })) }));
  const base = { selectedControlId: policy?.analyticsInterval?.selectedControlId ?? null, candidates,
    signal: binding.semanticRole || null, collection: null, state: binding.status, reason: binding.reason };
  if (binding.status !== 'resolved') return base;
  if (!analyticsEligible(policy)) return { ...base, state: 'limited', reason: 'compatible_analytics_writer_unavailable' };
  if (device.available === false) return { ...base, state: 'paused', reason: 'device_unreachable' };
  if (device.protocol !== 'zigbee') return { ...base, state: 'limited', reason: device.protocol === 'matter' ? 'matter_report_provenance_unavailable' : 'provider_observation_unverified' };
  const records = Object.values(store.getObservationPolicyRecords?.() || {}).filter(record => record.deviceId === device.id && record.controlId === binding.primaryControlId);
  const record = records.length === 1 ? records[0] : null;
  const verified = record?.state === 'cadence_verified' && record.evidenceVersion === 2
    && record.deviceLifecycleId === device.stateEvidenceLifecycleId
    && record.sourceGeneration === store.syncSourceGeneration && Number.isSafeInteger(record.sourceGeneration)
    && record.sourceGeneration > 0 && record.runtimeSessionId === store.observationSessionId
    && Boolean(record.evidenceVerifiedAt) && record.readBack?.status === 0;
  return { ...base, collection: record ? 'periodic_reporting' : 'report_on_change',
    state: verified ? 'ready' : record && !['unsupported', 'failed', 'cadence_failed'].includes(record.state) ? 'verifying' : 'limited',
    reason: record?.lastError || (record ? verified ? null : 'state_evidence_verification_pending' : 'periodic_collection_not_verified'), maximumReportInterval: record?.readBack?.maximumReportInterval ?? null };
}
module.exports = { analyticsReadiness };
