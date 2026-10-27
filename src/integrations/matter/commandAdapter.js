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
  }
  if (!["turn_on", "turn_off", "toggle", "lock", "unlock", "set_value", "select_option", "set_percentage", "set_preset_mode", "open_cover", "close_cover", "stop_cover", "set_cover_position", "press"].includes(operation)) throw Object.assign(new Error("Matter operation is not supported"), { statusCode: 400, code: "unsupported_service" });
  const commandNames = { turn_on: "on", turn_off: "off", toggle: "toggle", lock: "lock", unlock: "unlock", set_value: clusterId === 8 ? "move_to_level" : "write_attribute", select_option: "write_attribute", set_percentage: "write_attribute", set_preset_mode: "write_attribute", open_cover: "open", close_cover: "close", stop_cover: "stop", set_cover_position: "go_to_lift_percentage", press: "press" };
  return { endpoint_id: endpointId, cluster_id: clusterId, attribute_id: attributeId, command_name: commandNames[operation] || operation, operation, ...(Object.keys(bindingData).length ? { payload: bindingData } : {}) };
}

module.exports = { commandForBinding };
