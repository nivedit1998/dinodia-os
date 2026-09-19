const { allProjectedSurfaces, sourceRoute } = require("../capabilities/controlSurfaceProjection");
const { isConfigured, labelId } = require("../capabilities/devicePresentation");
const { isInfrastructureDevice } = require("../store");
const { AUTOMATABLE_SERVICES, FORBIDDEN_AUTOMATION_SERVICES } = require("./constants");
const { checksum, clone } = require("./domain");

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function parameterKeyFor(serviceId, binding = {}) {
  const key = text(binding.parameter?.key).toLowerCase();
  if (key) return key;
  if (serviceId === "climate.set_temperature") return "temperature";
  if (serviceId === "climate.set_hvac_mode") return "hvac_mode";
  if (serviceId === "light.turn_on") return "brightness";
  if (serviceId === "fan.set_percentage") return "percentage";
  if (serviceId === "cover.set_cover_position") return "position";
  if (serviceId === "number.set_value") return "value";
  if (serviceId === "select.select_option") return "option";
  return "value";
}

function logicalKeyFor(serviceId, binding, surface) {
  if (binding?.parameter?.key) return parameterKeyFor(serviceId, binding);
  if (serviceId.endsWith(".turn_on") || serviceId.endsWith(".turn_off")) return "power";
  if (serviceId === "climate.set_temperature") return "target_temperature";
  if (serviceId === "climate.set_hvac_mode") return "mode";
  if (serviceId === "light.turn_on") return parameterKeyFor(serviceId, binding);
  if (serviceId === "fan.set_percentage") return "percentage";
  if (serviceId === "cover.set_cover_position") return "position";
  if (serviceId === "number.set_value") return parameterKeyFor(serviceId, binding);
  if (serviceId === "select.select_option") return "option";
  if (serviceId === "button.press" || ["cover.open_cover", "cover.close_cover", "cover.stop_cover", "lock.lock"].includes(serviceId)) return "invoke";
  return text(binding.parameter?.key, surface.logicalKey || "control");
}

function numberConstraints(binding = {}, surface = {}) {
  const parameter = binding.parameter || {};
  const constraints = surface.capability?.constraints || {};
  const minimum = Number(parameter.min ?? constraints.min);
  const maximum = Number(parameter.max ?? constraints.max);
  const step = Number(parameter.step ?? constraints.step ?? 1);
  return {
    ...(Number.isFinite(minimum) ? { minimum } : {}),
    ...(Number.isFinite(maximum) ? { maximum } : {}),
    ...(Number.isFinite(step) && step > 0 ? { step } : {}),
    ...(parameter.unit || surface.capability?.unit ? { unit: text(parameter.unit || surface.capability.unit) } : {}),
  };
}

function valueTypeFor(serviceId, binding = {}) {
  if (binding.parameter?.type === "number") return "number";
  if (binding.parameter?.type === "boolean") return "boolean";
  if (binding.parameter?.type === "string") return "option";
  if (serviceId.endsWith(".turn_on") || serviceId.endsWith(".turn_off")) return "boolean";
  if (serviceId === "button.press") return "invoke";
  if (serviceId === "climate.set_hvac_mode" || serviceId === "fan.set_preset_mode" || serviceId === "select.select_option") return "option";
  if (binding.parameter?.type === "string") return "option";
  if (binding.parameter?.type === "boolean") return "boolean";
  return "number";
}

function kindFor(logicalKey, valueType) {
  if (valueType === "boolean") return "toggle";
  if (valueType === "option") return "options";
  if (valueType === "invoke") return "momentaryAction";
  if (logicalKey === "target_temperature") return "thermostat";
  return "slider";
}

function routeServiceIds(surface) {
  return new Set(Object.keys(surface.serviceRoutes || {}).map((serviceId) => String(serviceId).toLowerCase()));
}

function createPowerControl(device, surface, services) {
  const domain = String(surface.domain || "").toLowerCase();
  const onServiceId = [...services].find((serviceId) => serviceId === `${domain}.turn_on` || serviceId === "light.turn_on" || serviceId === "switch.turn_on" || serviceId === "climate.turn_on" || serviceId === "fan.turn_on");
  const offServiceId = [...services].find((serviceId) => serviceId === `${domain}.turn_off` || serviceId === "light.turn_off" || serviceId === "switch.turn_off" || serviceId === "climate.turn_off" || serviceId === "fan.turn_off");
  if (!onServiceId || !offServiceId) return null;
  if (!AUTOMATABLE_SERVICES.has(onServiceId) || !AUTOMATABLE_SERVICES.has(offServiceId)) return null;
  if (FORBIDDEN_AUTOMATION_SERVICES.has(onServiceId) || FORBIDDEN_AUTOMATION_SERVICES.has(offServiceId)) return null;
  return {
    controlId: `${surface.id}::power`,
    deviceId: String(device.id),
    surfaceId: String(surface.id),
    label: "Power",
    kind: "toggle",
    valueType: "boolean",
    writable: true,
    allowsAutomation: surface.capability?.automatable === true,
    constraints: {},
    execution: { onServiceId, offServiceId, idempotency: "set_value" },
  };
}

function createBindingControl(device, surface, serviceId, binding) {
  const normalizedServiceId = String(serviceId || "").toLowerCase();
  if (!AUTOMATABLE_SERVICES.has(normalizedServiceId) || FORBIDDEN_AUTOMATION_SERVICES.has(normalizedServiceId)) return null;
  if ((normalizedServiceId.endsWith(".turn_on") || normalizedServiceId.endsWith(".turn_off")) && !binding.parameter) return null;
  const logicalKey = logicalKeyFor(normalizedServiceId, binding, surface);
  const valueType = valueTypeFor(normalizedServiceId, binding);
  const constraints = valueType === "number" ? numberConstraints(binding, surface) : {};
  if (valueType === "number" && (constraints.minimum === undefined || constraints.maximum === undefined)) return null;
  const options = binding.parameter?.options || surface.capability?.constraints?.options || [];
  if (valueType === "option" && (!Array.isArray(options) || options.length === 0)) return null;
  return {
    controlId: `${surface.id}::${logicalKey}`,
    deviceId: String(device.id),
    surfaceId: String(surface.id),
    label: text(binding.parameter?.label || surface.name, logicalKey.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())),
    kind: kindFor(logicalKey, valueType),
    valueType,
    writable: true,
    allowsAutomation: surface.capability?.automatable === true,
    constraints: {
      ...constraints,
      ...(valueType === "option" ? { options: [...new Set(options.map(String))].slice(0, 32) } : {}),
    },
    execution: {
      serviceId: normalizedServiceId,
      parameterKey: parameterKeyFor(normalizedServiceId, binding),
      idempotency: ["button.press", "cover.open_cover", "cover.close_cover", "cover.stop_cover", "lock.lock"].includes(normalizedServiceId) ? "invoke" : "set_value",
    },
  };
}

function controlsForSurface(device, surface) {
  const services = routeServiceIds(surface);
  const controls = [];
  const domain = String(surface.domain || "").toLowerCase();
  if (["light", "switch", "climate", "fan"].includes(domain)) {
    const power = createPowerControl(device, surface, services);
    if (power) controls.push(power);
  }
  for (const binding of surface.capability?.bindings || []) {
    const control = createBindingControl(device, surface, binding.serviceId, binding);
    if (control && !controls.some((candidate) => candidate.controlId === control.controlId)) controls.push(control);
  }
  return controls;
}

function buildControlCatalog({ devices = [], getArea = () => null, getLabel = () => null } = {}) {
  const catalog = [];
  for (const device of devices) {
    if (!device || isInfrastructureDevice(device)) continue;
    const surfaces = allProjectedSurfaces(device);
    const controls = surfaces.flatMap((surface) => controlsForSurface(device, surface));
    const area = device.areaId ? getArea(String(device.areaId)) : null;
    const label = labelId(device);
    catalog.push({
      deviceId: String(device.id),
      displayName: text(device.name || device.id, "Device"),
      areaId: device.areaId ? String(device.areaId) : null,
      areaDisplayName: text(area?.name || device.areaId, "Unassigned area"),
      labelId: label,
      labelDisplayName: text(getLabel(label)?.name || label, label || "Unlabelled"),
      online: device.available !== false,
      configured: isConfigured(device),
      controls: controls.filter((control) => control.allowsAutomation),
      _device: clone(device),
    });
  }
  catalog.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.deviceId.localeCompare(right.deviceId));
  return catalog;
}

function publicControl(control) {
  const { execution, ...publicValue } = control;
  return { ...publicValue, constraints: clone(publicValue.constraints || {}) };
}

function publicCatalog(catalog = []) {
  const devices = catalog.map((device) => {
    const { _device, ...publicDevice } = device;
    return { ...publicDevice, controls: publicDevice.controls.map(publicControl) };
  });
  return {
    schemaVersion: 1,
    catalogRevision: checksum(devices),
    devices,
  };
}

function findControl(catalog = [], deviceId, controlId) {
  const device = catalog.find((candidate) => candidate.deviceId === String(deviceId));
  const control = device?.controls.find((candidate) => candidate.controlId === String(controlId));
  return control ? { device, control } : null;
}

function compileTarget(control, targetValue) {
  if (!control || !targetValue || typeof targetValue !== "object") throw Object.assign(new Error("A valid automation control and target are required"), { code: "invalid_value" });
  const type = String(targetValue.type || "").toLowerCase();
  if (type !== control.valueType) throw Object.assign(new Error(`${control.label} expects a ${control.valueType} value`), { code: "invalid_value" });
  if (type === "boolean") {
    return { serviceId: targetValue.boolean ? control.execution.onServiceId : control.execution.offServiceId, data: {} };
  }
  if (type === "number") {
    const key = control.execution.parameterKey || "value";
    return { serviceId: control.execution.serviceId, data: { [key]: Number(targetValue.number) } };
  }
  if (type === "option") {
    const key = control.execution.parameterKey || "option";
    return { serviceId: control.execution.serviceId, data: { [key]: String(targetValue.option) } };
  }
  if (type === "text") {
    const key = control.execution.parameterKey || "value";
    return { serviceId: control.execution.serviceId, data: { [key]: String(targetValue.text) } };
  }
  if (type === "invoke") return { serviceId: control.execution.serviceId, data: {} };
  throw Object.assign(new Error("Unsupported automation target type"), { code: "invalid_value" });
}

function resolveExecutionRoute(device, control, compiled) {
  const surface = allProjectedSurfaces(device).find((candidate) => String(candidate.id) === String(control.surfaceId));
  if (!surface) throw Object.assign(new Error("The device control is no longer available"), { code: "missing_control" });
  const route = sourceRoute(device, surface, compiled.serviceId);
  if (!route) throw Object.assign(new Error("The device control route is no longer available"), { code: "missing_control" });
  return { ...compiled, entity: route.entity, serviceId: route.serviceId };
}

module.exports = {
  buildControlCatalog,
  compileTarget,
  createBindingControl,
  controlsForSurface,
  findControl,
  publicCatalog,
  publicControl,
  resolveExecutionRoute,
};
