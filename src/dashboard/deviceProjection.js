const { analyticsReadiness } = require('../analytics/readiness');
const { channelManifest } = require('../capabilities/logicalDevices');
function dashboardDevice(device, platform = null, store = null) {
  if (!device || typeof device !== "object") return device;
  const result = JSON.parse(JSON.stringify(device));
  const policy = platform?.devicePolicies?.[String(result.id || "")];
  result.logicalConversionAvailable = false;
  if (policy?.managementClass === 'PROPERTY_DEVICE' && !policy.ownerMembershipId
    && !device.physicalDeviceId && ['INSTALLED', 'VIEW_ONLY'].includes(policy.lifecycle)) {
    try {
      const manifest = channelManifest(device);
      result.logicalConversionAvailable = manifest.channels.length > 1 && !manifest.unresolvedSourceIds.length;
    } catch { /* Unsupported mappings remain unavailable. */ }
  }
  const managementRevision = Number(platform?.cloudRevision);
  if (policy?.managementClass === "PROPERTY_DEVICE" && policy.ownerMembershipId == null
    && ["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle || ""))
    && ["NONE", "LIGHT", "BOILER", "RADIATOR"].includes(String(policy.analyticsCategory || ""))
    && Number.isSafeInteger(managementRevision) && managementRevision >= 1) {
    result.analyticsCategory = String(policy.analyticsCategory);
    result.analyticsManagementRevision = managementRevision;
    result.analyticsReadiness = analyticsReadiness(store || {}, device, policy);
    if (Number.isSafeInteger(Number(policy.inventoryRevision)) && Number(policy.inventoryRevision) > 0) result.analyticsInventoryRevision = Number(policy.inventoryRevision);
    else delete result.analyticsInventoryRevision;
  } else {
    delete result.analyticsCategory;
    delete result.analyticsManagementRevision;
    delete result.analyticsInventoryRevision;
  }
  if (String(result.protocol || "").toLowerCase() === "google_nest") {
    result.protocolIdentity = {};
    if (result.metadata && typeof result.metadata === "object") {
      delete result.metadata.resource_name;
      delete result.metadata.account_fingerprint;
    }
  }
  return result;
}

module.exports = { dashboardDevice };
