const { normalizeCapability, publicCapability } = require("./schema");

const DOMAIN_SERVICES = {
  binary: ["turn_on", "turn_off", "toggle"],
  button: ["press"],
  number: ["set_value"],
  enum: ["select_option"],
  text: ["set_value"],
};

function projectionForEntity(entity = {}) {
  const capability = normalizeCapability(entity.capability || {}, {
    stateKey: entity.stateKey || entity.id,
    kind: entity.domain === "binary_sensor" ? "binary" : "sensor",
    writable: false,
    unit: entity.expose?.unit,
    deviceClass: entity.expose?.device_class,
    constraints: entity.expose,
  });
  const bindings = capability.bindings.map((binding) => String(binding.serviceId));
  const attributes = {
    ...(capability.unit ? { unit_of_measurement: capability.unit } : {}),
    ...(capability.deviceClass ? { device_class: capability.deviceClass } : {}),
    ...(capability.constraints.options ? { options: [...capability.constraints.options] } : {}),
    ...(capability.constraints.min !== undefined ? { min: capability.constraints.min } : {}),
    ...(capability.constraints.max !== undefined ? { max: capability.constraints.max } : {}),
    ...(capability.constraints.step !== undefined ? { step: capability.constraints.step } : {}),
    ...publicCapability(entity.capability, entity),
  };
  return { capability, attributes, services: bindings };
}

function servicesForCapability(entity = {}) {
  const projected = projectionForEntity(entity);
  if (projected.services.length) return projected.services;
  return DOMAIN_SERVICES[projected.capability.kind] || [];
}

module.exports = { projectionForEntity, servicesForCapability };
