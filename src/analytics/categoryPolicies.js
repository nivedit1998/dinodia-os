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
// Collection and recording gates. Lights, radiators and boilers have always been eligible. Owner decision 2 Nov 2026: every on/off
// device records on/off time, so the on/off state categories (socket, TV) are eligible too, but only once the Platform's signed
// state-analytics policy (version 4) is current and its writer is enabled for that device. Blinds, AC and washing machines stay
// closed until they are decided separately.
function analyticsEligible(policy) {
  if (!categoryBindingEligible(policy)) return false;
  if (['LIGHT', 'RADIATOR', 'BOILER'].includes(policy.analyticsCategory)) return true;
  return ['SOCKET', 'TV'].includes(policy.analyticsCategory)
    && policy.analyticsInterval?.analyticsPolicyVersion === 4 && policy.analyticsInterval.writerEnabled === true;
}
// The categories an installer or operator may choose for a permanent property device today.
const PROPERTY_ANALYTICS_CATEGORIES = Object.freeze(['NONE', 'LIGHT', 'BOILER', 'RADIATOR', 'SOCKET']);
module.exports = { PROPERTY_ANALYTICS_CATEGORIES, CATEGORY_POLICIES, analyticsEligible, categoryBindingEligible };
