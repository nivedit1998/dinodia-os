const crypto = require("node:crypto");
const { buildPresentation } = require("../capabilities/devicePresentation");
const { allProjectedSurfaces } = require("../capabilities/controlSurfaceProjection");
const { serializeDevice } = require("../contracts/dinodiaV1");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hasFreshReadableObservation(device, control, nowMs) {
  if (!control.readable || !control.observable || !Number.isInteger(control.maxStateValiditySeconds) || control.maxStateValiditySeconds < 1) return false;
  return Object.values(device.entities || {}).some((entity) => {
    if (String(entity?.capability?.controlId || entity?.controlId || "") !== control.controlId
      || entity.state === undefined || entity.state === null) return false;
    // Only a source-provenance timestamp can demonstrate a current reading.
    // Store timestamps and generic observation-looking fields are not radio evidence.
    const raw = entity.sourceObservedAt;
    const observedAt = Date.parse(String(raw || ""));
    return Number.isFinite(observedAt) && observedAt <= nowMs
      && nowMs - observedAt <= control.maxStateValiditySeconds * 1000;
  });
}

/** Build the same safe public descriptor used by the live tenant API before
 * Platform records a private commissioned device. No adapter bindings, radio
 * identifiers or current values leave the hub. */
function buildPublicCommissioningCatalogue({ device, homeId, membershipId = null, managementClass = "tenant_device", areaId, name, customerLabel, now = Date.now() }) {
  const safeName = String(name || device?.originalName || device?.name || "Device").normalize("NFC").trim().slice(0, 160);
  const safeLabel = String(customerLabel || "").normalize("NFC").trim().slice(0, 40);
  const assigned = {
    ...device,
    name: safeName,
    customerLabel: safeLabel,
    areaId: String(areaId),
    managementClass: managementClass === "property_device" ? "property_device" : "tenant_device",
    ...(managementClass === "property_device" ? { tenantOwnerMembershipId: undefined, metadata: { ...(device.metadata || {}), managementClass: "property_device", tenantOwnerMembershipId: undefined } }
      : { tenantOwnerMembershipId: String(membershipId) }),
    setup: { ...(device.setup || {}), status: "ready" },
  };
  assigned.presentation = buildPresentation(assigned, new Date(now).toISOString());
  const descriptor = serializeDevice({
    device: assigned,
    homeId: String(homeId),
    homeMembershipId: membershipId == null ? "" : String(membershipId),
    role: managementClass === "property_device" ? "INSTALLER" : "TENANT",
    areaIds: [String(areaId)],
    surfaces: allProjectedSurfaces(assigned),
    revision: assigned.presentation.descriptorRevision,
  });
  if (!descriptor) return null;
  const controls = descriptor.controls;
  const hasWritableControls = controls.some((control) => control.readable && control.writable);
  const usefulReadings = controls.some((control) => hasFreshReadableObservation(assigned, control, now));
  const capabilityStatus = hasWritableControls ? "ready" : usefulReadings ? "no_safe_controls" : "unsupported";
  const descriptorDigest = sha256(JSON.stringify({
    homeId: descriptor.homeId,
    managementClass: descriptor.managementClass,
    ownerMembershipId: descriptor.ownerMembershipId,
    technicalLabel: descriptor.technicalLabel,
    customerLabel: safeLabel,
    areaIds: descriptor.areaIds,
    descriptorRevision: descriptor.descriptorRevision,
    controls,
  }));
  return {
    osDeviceId: String(device.id),
    originalName: String(device.originalName || device.name || "Device").slice(0, 160),
    name: safeName,
    technicalLabel: descriptor.technicalLabel,
    deviceType: String(device.metadata?.deviceType || device.metadata?.model || device.protocol || "unknown").slice(0, 120),
    manufacturer: String(device.metadata?.manufacturer || "").slice(0, 160) || null,
    model: String(device.metadata?.model || "").slice(0, 160) || null,
    protocol: String(device.protocol).toLowerCase() === "zigbee" ? "ZIGBEE" : "MATTER_THREAD",
    descriptorRevision: descriptor.descriptorRevision,
    descriptorDigest,
    areaId: String(areaId),
    customerLabel: safeLabel,
    capabilityStatus,
    usefulReadings,
    controls,
  };
}

module.exports = { buildPublicCommissioningCatalogue, hasFreshReadableObservation };
