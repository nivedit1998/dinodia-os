'use strict';
const CATEGORY_POLICIES = Object.freeze({
  LIGHT: Object.freeze({ roles: Object.freeze(['power', 'brightness']), version: 2 }),
  RADIATOR: Object.freeze({ roles: Object.freeze(['active_heat_demand']), version: 2 }),
  BOILER: Object.freeze({ roles: Object.freeze(['active_heat_production']), version: 2 }),
  // Binding support is not authority to write history. The signed policy and
  // versioned writer must be enabled independently before these can be used.
  SOCKET: Object.freeze({ roles: Object.freeze(['power']), version: 4 }),
  TV: Object.freeze({ roles: Object.freeze(['power']), version: 4 }),
  BLIND: Object.freeze({ roles: Object.freeze(['opening_percentage']), version: 4 }),
  AC: Object.freeze({ roles: Object.freeze(['thermal_activity']), version: 4 }),
  WASHING_MACHINE: Object.freeze({ roles: Object.freeze(['cycle_activity']), version: 4 }),
});
function categoryBindingEligible(policy) {
  return policy?.managementClass === 'PROPERTY_DEVICE' && policy.ownerMembershipId == null &&
    ['INSTALLED', 'VIEW_ONLY'].includes(policy.lifecycle) && typeof policy.analyticsCategory === 'string' &&
    Object.hasOwn(CATEGORY_POLICIES, policy.analyticsCategory);
}
// Existing collection/recording gates must not expand just because the
// resolver understands a new category.
function analyticsEligible(policy) {
  return categoryBindingEligible(policy) && ['LIGHT', 'RADIATOR', 'BOILER'].includes(policy.analyticsCategory);
}
module.exports = { CATEGORY_POLICIES, analyticsEligible, categoryBindingEligible };
