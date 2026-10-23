'use strict';
const crypto = require('node:crypto');
const { CATEGORY_POLICIES, analyticsEligible } = require('./categoryPolicies');
function resolveCategoryBinding({ signedPolicy, controls, selection = null }) {
  if (!analyticsEligible(signedPolicy)) return { status: 'ineligible', reason: 'analytics_policy_ineligible', candidates: [] };
  const category = signedPolicy.analyticsCategory;
  const groups = new Map();
  for (const control of controls || []) {
    if (signedPolicy.analyticsInterval?.authorizedControlIds && !signedPolicy.analyticsInterval.authorizedControlIds.includes(control.controlId)) continue;
    if (control.observable !== true || !CATEGORY_POLICIES[category].roles.includes(control.semanticRole)) continue;
    if (category !== 'LIGHT' && control.writable === true) continue;
    const endpoint = String(control.endpointId ?? '');
    if (!endpoint || !control.controlId) continue;
    const groupId = endpoint;
    if (!groups.has(groupId)) groups.set(groupId, new Map());
    // Aliases deduplicate only when the exact physical address is known.
    const key = control.physicalSourceKey || control.controlId;
    const members = groups.get(groupId);
    if (!members.has(key)) members.set(key, control);
  }
  const candidates = [...groups].map(([groupId, members]) => ({ groupId, controls: [...members.values()] }));
  if (!candidates.length) return { status: 'unsupported', reason: 'required_signal_missing', candidates: [] };
  const selectedControl = signedPolicy.analyticsInterval?.selectedControlId;
  const selected = selectedControl ? candidates.find(group => group.controls.some(control => control.controlId === selectedControl))
    : selection == null ? (candidates.length === 1 ? candidates[0] : null)
    : candidates.find(group => group.groupId === selection);
  if (!selected) return { status: 'ambiguous', reason: selection == null ? 'multiple_activity_groups' : 'selected_group_missing', candidates };
  const powers = selected.controls.filter(control => control.semanticRole === 'power');
  const usable = category === 'LIGHT' && powers.length ? powers : selected.controls;
  if (usable.length !== 1) return { status: 'ambiguous', reason: 'multiple_activity_sources', candidates };
  const primary = usable[0];
  if (selectedControl && primary.controlId !== selectedControl) return { status: 'ambiguous', reason: 'selected_source_not_authoritative', candidates };
  if (category === 'LIGHT' && primary.semanticRole === 'brightness' && primary.brightnessMeaning !== 'actual_output')
    return { status: 'unsupported', reason: 'brightness_output_unverified', candidates };
  const identity = { category, groupId: selected.groupId, primaryControlId: primary.controlId,
    semanticRole: primary.semanticRole, categoryPolicyVersion: 2,
    minimum: primary.constraints?.minimum ?? primary.constraints?.min ?? null,
    maximum: primary.constraints?.maximum ?? primary.constraints?.max ?? null };
  return { ...identity, status: 'resolved', reason: null, candidates,
    memberControlIds: selected.controls.map(control => control.controlId).sort(),
    hasAuthoritativePower: powers.length > 0,
    brightnessMeaning: primary.brightnessMeaning || 'not_applicable',
    bindingFingerprint: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}
module.exports = { resolveCategoryBinding };
