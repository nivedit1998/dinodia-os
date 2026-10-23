'use strict';
const CATEGORY_POLICIES = Object.freeze({
  LIGHT: Object.freeze({ roles: Object.freeze(['power', 'brightness']), version: 2 }),
  RADIATOR: Object.freeze({ roles: Object.freeze(['active_heat_demand']), version: 2 }),
  BOILER: Object.freeze({ roles: Object.freeze(['active_heat_production']), version: 2 }),
});
function analyticsEligible(policy) {
  return policy?.managementClass === 'PROPERTY_DEVICE' && policy.ownerMembershipId == null &&
    ['INSTALLED', 'VIEW_ONLY'].includes(policy.lifecycle) && Boolean(CATEGORY_POLICIES[policy.analyticsCategory]);
}
module.exports = { CATEGORY_POLICIES, analyticsEligible };
