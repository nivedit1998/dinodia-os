'use strict';
const { resolvedEndpoint } = require('./profiles');
// Capability discovery is not a reporting write approval or a validity guarantee.
function discoverCollectionStrategy(device, entity) {
  const role = entity?.capability?.semanticRole;
  const attributes = { active_heat_demand: ['hvacThermostat', 'runningState'],
    power: ['genOnOff', 'onOff'], brightness: ['genLevelCtrl', 'currentLevel'] };
  const mapping = attributes[role];
  if (!mapping || device?.protocol !== 'zigbee' || entity?.capability?.observable !== true ||
      (role === 'active_heat_demand' && entity.capability.writable === true))
    return { strategy: 'unsupported', reason: 'collection_capability_unverified', approvedForAutomaticConfiguration: false };
  const endpoint = resolvedEndpoint(device, entity, mapping[0]);
  const inputs = device.metadata?.endpoints?.[endpoint]?.clusters?.input;
  if (!endpoint || !Array.isArray(inputs) || !inputs.includes(mapping[0]))
    return { strategy: 'unsupported', reason: 'exact_endpoint_unverified', approvedForAutomaticConfiguration: false };
  return { strategy: 'verify_existing_reporting', endpoint, cluster: mapping[0], attribute: mapping[1],
    property: entity.stateKey, approvedForAutomaticConfiguration: false };
}
module.exports = { discoverCollectionStrategy };
