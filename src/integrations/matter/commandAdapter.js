const { validateParameter, resolveParameterValue } = require("../zigbee/commandAdapter");

function commandForBinding(entity, serviceId, data = {}) {
  const binding = (entity?.capability?.bindings || []).find((item) => item.serviceId === serviceId);
  if (!binding) throw Object.assign(new Error(`${serviceId} is not supported for this entity`), { statusCode: 400, code: "unsupported_service" });
  const operation = binding.operation || serviceId.split(".").pop();
  const bindingData = binding.parameter ? { [binding.parameter.key]: validateParameter(binding.parameter, resolveParameterValue(binding.parameter, data)) } : {};
  const endpointId = Number(entity.binding?.endpointId || entity.endpointId || 0);
  const clusterId = Number(entity.binding?.clusterId || 0);
  const attributeId = Number(entity.binding?.attributeId || 0);
  if (!["turn_on", "turn_off", "toggle", "lock", "unlock", "set_value", "select_option", "set_percentage", "set_preset_mode", "open_cover", "close_cover", "stop_cover", "set_cover_position", "press"].includes(operation)) throw Object.assign(new Error("Matter operation is not supported"), { statusCode: 400, code: "unsupported_service" });
  const commandNames = { turn_on: "on", turn_off: "off", toggle: "toggle", lock: "lock", unlock: "unlock", set_value: clusterId === 8 ? "move_to_level" : "write_attribute", select_option: "write_attribute", set_percentage: "write_attribute", set_preset_mode: "write_attribute", open_cover: "open", close_cover: "close", stop_cover: "stop", set_cover_position: "go_to_lift_percentage", press: "press" };
  return { endpoint_id: endpointId, cluster_id: clusterId, attribute_id: attributeId, command_name: commandNames[operation] || operation, operation, ...(Object.keys(bindingData).length ? { payload: bindingData } : {}) };
}

module.exports = { commandForBinding };
