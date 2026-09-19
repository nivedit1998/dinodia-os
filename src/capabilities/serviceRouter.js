const { safeServiceId, normalizeCapability } = require("./schema");

function bindingFor(entity, serviceId) {
  const requested = String(serviceId || "").toLowerCase();
  if (!safeServiceId(requested)) return null;
  const capability = normalizeCapability(entity?.capability || {});
  return capability.bindings.find((binding) => binding.serviceId === requested) || null;
}

function assertService(entity, serviceId) {
  const binding = bindingFor(entity, serviceId);
  if (!binding) throw Object.assign(new Error(`${serviceId} is not supported for this entity`), { statusCode: 400, code: "unsupported_service" });
  return binding;
}

function routeService({ entity, serviceId, data = {}, adapters = {} } = {}) {
  const binding = assertService(entity, serviceId);
  const protocol = String(adapters.protocol || "");
  const adapter = adapters[protocol];
  if (typeof adapter !== "function") throw Object.assign(new Error(`No adapter for ${protocol || "unknown"} protocol`), { statusCode: 501, code: "adapter_unavailable" });
  return adapter(entity, serviceId, data, binding);
}

function surfaceRouteFor(surface, serviceId) {
  const requested = String(serviceId || "").toLowerCase();
  const route = surface?.serviceRoutes?.[requested];
  if (!route) return null;
  if (typeof route === "string") return { entityId: route, serviceId: requested, parameters: {} };
  if (!route.entityId) return null;
  return {
    entityId: String(route.entityId),
    serviceId: String(route.serviceId || requested).toLowerCase(),
    parameters: route.parameters && typeof route.parameters === "object" ? route.parameters : {},
  };
}

module.exports = { bindingFor, assertService, routeService, surfaceRouteFor };
