const { createHash } = require("node:crypto");
const { allProjectedSurfaces } = require("../../capabilities/controlSurfaceProjection");
const { nativeAlexaEndpointId } = require("./endpointId");
const { SCHEMA_VERSION, clone, revisionFor, text } = require("./contracts");
const { mapSurface, publicEndpointParts } = require("./capabilityMapper");

function catalog({ serial, instanceId, devices = [], areas = [] } = {}) {
  const areaMap = new Map(areas.map((area) => [String(area.id), area]));
  const endpoints = [];
  for (const device of devices) {
    if (!device || device.setup?.status !== "ready" || !device.areaId) continue;
    const area = areaMap.get(String(device.areaId));
    for (const surface of allProjectedSurfaces(device)) {
      const mapped = mapSurface(surface);
      if (!mapped.controls.length && !mapped.state.length) continue;
      const endpointId = nativeAlexaEndpointId({ hubInstanceId: instanceId || serial, deviceId: device.id, channelId: surface.id });
      const publicParts = publicEndpointParts(mapped);
      endpoints.push({
        endpointId,
        deviceId: String(device.id),
        channelId: String(surface.id),
        originalDeviceName: text(device.name || surface.name || device.id, "Device"),
        areaId: String(device.areaId),
        originalAreaName: text(area?.name || device.areaId, "Area"),
        manufacturerName: text(device.metadata?.manufacturer || device.definition?.manufacturer || "Dinodia", "Dinodia"),
        modelName: text(device.metadata?.model || device.definition?.model || "") || null,
        description: text(`${device.protocol || "device"} device`, "Dinodia device"),
        displayCategories: [String(surface.domain || "switch").toLowerCase() === "light" ? "LIGHT" : String(surface.domain || "").toLowerCase() === "cover" ? "OTHER" : "OTHER"],
        capabilities: publicParts.capabilities,
        controls: publicParts.controls,
        state: publicParts.state,
        available: device.available !== false && surface.available !== false,
        sourceUpdatedAt: new Date().toISOString(),
        _bindings: publicParts._bindings,
      });
    }
  }
  endpoints.sort((a, b) => a.endpointId.localeCompare(b.endpointId));
  const publicEndpoints = endpoints.map(({ _bindings, ...endpoint }) => endpoint);
  const revision = revisionFor(publicEndpoints);
  return {
    schemaVersion: SCHEMA_VERSION,
    hubSerial: text(serial),
    hubInstanceId: text(instanceId || serial),
    generatedAt: new Date().toISOString(),
    catalogRevision: revision,
    endpoints: publicEndpoints,
    _internalEndpoints: endpoints,
  };
}

function internalEndpoint(catalogue, endpointId) {
  return catalogue?._internalEndpoints?.find((endpoint) => endpoint.endpointId === String(endpointId)) || null;
}

function publicCatalog(catalogue) {
  if (!catalogue) return null;
  const { _internalEndpoints, ...publicValue } = clone(catalogue);
  void _internalEndpoints;
  return publicValue;
}

module.exports = { catalog, internalEndpoint, publicCatalog };
