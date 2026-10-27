const { validateParameter, resolveParameterValue } = require("../zigbee/commandAdapter");

function commandForBinding(entity, serviceId, data = {}, device = null) {
  const binding = (entity?.capability?.bindings || []).find((item) => item.serviceId === serviceId);
  if (!binding) throw Object.assign(new Error(`${serviceId} is not supported for this entity`), { statusCode: 400, code: "unsupported_service" });
  const operation = binding.operation || serviceId.split(".").pop();
  if (serviceId === 'cover.set_cover_position') {
    const value = resolveParameterValue(binding.parameter, data);
    if (binding.parameter?.key !== 'position' || binding.parameter?.type !== 'number'
      || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw Object.assign(new Error('Cover position must be a number between 0 and 100'), { statusCode: 400, code: 'invalid_value' });
    }
  }
  const bindingData = binding.parameter ? { [binding.parameter.key]: validateParameter(binding.parameter, resolveParameterValue(binding.parameter, data)) } : {};
  const endpointId = Number(entity.binding?.endpointId || entity.endpointId || 0);
  const clusterId = Number(entity.binding?.clusterId || 0);
  const attributeId = Number(entity.binding?.attributeId || 0);
  if (clusterId === 513 && serviceId === 'climate.set_temperature') {
    const value = bindingData.temperature;
    const limits = entity.capability?.constraints;
    if (operation !== 'set_temperature' || ![17,18,19,20].includes(attributeId) || entity.binding?.valueEncoding !== 'matter-v1'
      || typeof data.temperature !== 'number' || !Number.isFinite(value)
      || !Number.isFinite(limits?.min) || !Number.isFinite(limits?.max) || value < limits.min || value > limits.max
      || !Number.isInteger(Math.round(value * 100)) || Math.abs(Math.round(value * 100) / 100 - value) > 1e-8) {
      throw Object.assign(new Error('Matter temperature requires verified bounds and hundredth-degree precision'), {statusCode:400,code:'invalid_value'});
    }
    return { endpoint_id: endpointId, cluster_id: clusterId, attribute_id: attributeId, operation,
      attribute_value: Math.round(value * 100) };
  }
  if (clusterId === 514 && attributeId === 2 && serviceId === 'fan.set_percentage') {
    const value = data.percentage;
    if (operation !== 'set_percentage' || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100)
      throw Object.assign(new Error('Fan percentage must be an integer between 0 and 100'), {statusCode:400,code:'invalid_value'});
    return {endpoint_id:endpointId,cluster_id:clusterId,attribute_id:attributeId,operation,attribute_value:value};
  }
  if (clusterId === 258) {
    const allowed = { open_cover: 0, close_cover: 1, stop_cover: 2, set_cover_position: 5 };
    const commandId = allowed[operation];
    const proofEntity = Object.values(device?.entities || {}).find(item =>
      String(item.binding?.endpointId) === String(entity.binding?.endpointId)
      && String(item.binding?.clusterId) === '258' && String(item.binding?.attributeId) === '65529');
    const proof = proofEntity?.state;
    if (commandId === undefined || serviceId !== `cover.${operation}` || !Array.isArray(proof)
      || proof.length > 128 || !proof.every(id => Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff) || !proof.includes(commandId)
      || !Array.isArray(entity.attributes?.acceptedCommandIds) || !entity.attributes.acceptedCommandIds.includes(commandId)
      || String(entity.attributes?.acceptedCommandEndpoint) !== String(entity.binding?.endpointId)
      || String(entity.attributes?.acceptedCommandCluster) !== String(entity.binding?.clusterId)
      || String(entity.binding?.attributeId) !== '8') {
      throw Object.assign(new Error('Matter cover command is not verified for this endpoint'), { statusCode: 400, code: 'unsupported_service' });
    }
    if (entity.binding?.valueEncoding !== 'matter-v1') throw Object.assign(new Error('Refresh Matter cover inventory before sending'), { statusCode: 409, code: 'matter_cover_inventory_unverified' });
    const commands = { open_cover: 'UpOrOpen', close_cover: 'DownOrClose', stop_cover: 'StopMotion', set_cover_position: 'GoToLiftPercentage' };
    return { endpoint_id: endpointId, cluster_id: clusterId, attribute_id: attributeId,
      command_name: commands[operation], operation,
      payload: operation === 'set_cover_position' ? { liftPercent100thsValue: Math.round((100 - bindingData.position) * 100) } : {} };
  }
  if (!["turn_on", "turn_off", "toggle", "lock", "unlock", "set_value", "select_option", "set_percentage", "set_preset_mode", "open_cover", "close_cover", "stop_cover", "set_cover_position", "press"].includes(operation)) throw Object.assign(new Error("Matter operation is not supported"), { statusCode: 400, code: "unsupported_service" });
  if (clusterId === 6 && attributeId === 0 && ['turn_on','turn_off','toggle'].includes(operation)) {
    if (serviceId !== `switch.${operation}` && serviceId !== `light.${operation}`) throw Object.assign(new Error('Matter power binding mismatch'),{statusCode:400,code:'unsupported_service'});
    return {endpoint_id:endpointId,cluster_id:clusterId,attribute_id:attributeId,command_name:{turn_on:'On',turn_off:'Off',toggle:'Toggle'}[operation],operation,payload:{}};
  }
  if (clusterId === 8 && attributeId === 0 && operation === 'set_value') {
    const value = bindingData.value;
    if (typeof data.value !== 'number' || !Number.isInteger(value) || value < 0 || value > 254)
      throw Object.assign(new Error('Matter level must be an integer between 0 and 254'),{statusCode:400,code:'invalid_value'});
    return {endpoint_id:endpointId,cluster_id:clusterId,attribute_id:attributeId,command_name:'MoveToLevel',operation,payload:{level:value,transitionTime:0}};
  }
  const commandNames = { lock: 'LockDoor', unlock: 'UnlockDoor' };
  if (clusterId !== 257 || !['lock','unlock'].includes(operation)) throw Object.assign(new Error('Matter operation requires a supported attribute or cluster command'),{statusCode:400,code:'unsupported_service'});
  return { endpoint_id: endpointId, cluster_id: clusterId, attribute_id: attributeId, command_name: commandNames[operation] || operation, operation, payload: bindingData };
}

module.exports = { commandForBinding };
