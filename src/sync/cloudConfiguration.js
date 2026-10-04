const crypto = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function validText(value, max, allowEmpty = false) {
  return typeof value === "string" && [...value].length <= max && (allowEmpty || value.length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validAutomation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== ["id", "name", "status", "revision", "definitionChecksum", "timezone", "triggers", "actions"].sort().join("\n")
    || !validText(value.id, 80) || !validText(value.name, 120)
    || !["DRAFT", "ACTIVE", "PAUSED", "NEEDS_ATTENTION"].includes(value.status)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.definitionChecksum !== "string" || !/^[a-f0-9]{64}$/i.test(value.definitionChecksum)
    || !validText(value.timezone, 80)
    || !Array.isArray(value.triggers) || value.triggers.length > 16
    || !Array.isArray(value.actions) || value.actions.length > 32) return false;
  if (new Set(value.triggers.map((item) => item?.id)).size !== value.triggers.length
    || value.triggers.some((item) => !item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join("\n") !== ["id", "kind", "configuration", "revision"].sort().join("\n")
      || !validText(item.id, 80) || !validText(item.kind, 40) || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !item.configuration || typeof item.configuration !== "object" || Array.isArray(item.configuration))) return false;
  if (new Set(value.actions.map((item) => item?.id)).size !== value.actions.length
    || value.actions.some((item) => !item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join("\n") !== ["id", "osDeviceId", "osAreaId", "controlId", "descriptorRevision", "actionValue", "needsAttention"].sort().join("\n")
      || !validText(item.id, 80) || !validText(item.osDeviceId, 160) || !validText(item.osAreaId, 160)
      || !validText(item.controlId, 160) || !Number.isSafeInteger(item.descriptorRevision) || item.descriptorRevision < 1
      || !item.actionValue || typeof item.actionValue !== "object" || Array.isArray(item.actionValue)
      || typeof item.needsAttention !== "boolean")) return false;
  return true;
}

function validateCloudConfiguration(value, current = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["revision", "policyRevision", "areas", "memberships", "devicePolicies", "automations", "releasePolicy", "checksum"];
  if (Object.keys(value).sort().join("\n") !== keys.sort().join("\n")
    || !Number.isSafeInteger(value.revision) || value.revision < Number(current.cloudRevision || 0)
    || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < Number(current.policyRevision || 0)
    || !Array.isArray(value.areas) || value.areas.length > 1000
    || !Array.isArray(value.memberships) || value.memberships.length > 100
    || !Array.isArray(value.devicePolicies) || value.devicePolicies.length > 2000
    || !Array.isArray(value.automations) || value.automations.length > 100
    || new Set(value.automations.map((automation) => automation?.id)).size !== value.automations.length
    || value.automations.some((automation) => !validAutomation(automation))
    || !value.releasePolicy || value.releasePolicy.mode !== "MANUAL" || value.releasePolicy.automaticInstallEnabled !== false || value.releasePolicy.desiredRelease !== null
    || typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/i.test(value.checksum)) return false;
  if (new Set(value.areas.map((area) => area?.id)).size !== value.areas.length || value.areas.some((area) => !validText(area?.id, 160) || !validText(area?.osAreaId, 160) || !validText(area?.originalName, 160) || !(area.overrideName === null || validText(area.overrideName, 160)) || !Number.isSafeInteger(area.revision) || area.revision < 1)) return false;
  if (new Set(value.memberships.map((membership) => membership?.id)).size !== value.memberships.length || value.memberships.some((membership) => !validText(membership?.id, 160) || !["OWNER", "PROPERTY_MANAGER", "TENANT"].includes(membership.role) || !Number.isSafeInteger(membership.accessRevision) || !Array.isArray(membership.areaIds) || membership.areaIds.some((id) => !value.areas.some((area) => area.id === id)))) return false;
  if (new Set(value.devicePolicies.map((device) => device?.osDeviceId)).size !== value.devicePolicies.length || value.devicePolicies.some((device) => !validText(device?.osDeviceId, 160) || !["PROPERTY_DEVICE", "TENANT_DEVICE"].includes(device.managementClass) || !(device.ownerMembershipId === null || validText(device.ownerMembershipId, 160)) || !["NONE", "LIGHT", "BOILER", "RADIATOR"].includes(device.analyticsCategory) || !["DISCOVERED", "INSTALLED", "VIEW_ONLY", "RETIRED", "REMOVAL_PENDING", "REMOVED", "RECOMMISSION_REQUIRED"].includes(device.lifecycle) || !(device.customerLabel === null || validText(device.customerLabel, 40)) || !(device.overrideName === null || validText(device.overrideName, 160)) || !Number.isSafeInteger(device.descriptorRevision) || device.descriptorRevision < 1 || !(device.descriptorDigest === null || /^[a-f0-9]{64}$/i.test(device.descriptorDigest)) || !Array.isArray(device.osAreaIds) || device.osAreaIds.some((id) => !value.areas.some((area) => area.osAreaId === id)))) return false;
  const { checksum, ...unsigned } = value;
  if (crypto.createHash("sha256").update(canonical(unsigned), "utf8").digest("hex") !== checksum) return false;
  if (Number(value.revision) === Number(current.cloudRevision || 0) && current.cloudConfigurationChecksum && current.cloudConfigurationChecksum !== checksum) return false;
  return true;
}

async function applyCloudConfiguration(store, value) {
  const current = store.getPlatform?.() || {};
  if (!validateCloudConfiguration(value, current)) throw Object.assign(new Error("Cloud configuration is malformed, stale, or checksum-invalid"), { code: "sync_configuration_invalid" });
  const devicePolicies = Object.fromEntries(value.devicePolicies.map((policy) => [String(policy.osDeviceId), JSON.parse(JSON.stringify(policy))]));
  const platformPatch = {
    cloudRevision: Number(value.revision),
    cloudConfigurationChecksum: String(value.checksum),
    policyRevision: Number(value.policyRevision),
    areaBindings: value.areas.map((area) => ({ areaId: String(area.id), hubAreaId: String(area.osAreaId) })),
    devicePolicies,
    cloudConfiguration: JSON.parse(JSON.stringify(value)),
  };
  const activeDefinitions = value.automations.filter((automation) => automation.status === "ACTIVE");
  const runtimeAutomations = [];
  if (activeDefinitions.length) {
    // Load the current OS control catalogue only after Store has completed
    // initialization; the catalogue module references Store predicates.
    const { buildControlCatalog } = require("../automations/controlCatalog");
    const { normalizeDefinition, validateAgainstCatalogue } = require("../automations/validator");
    const areas = new Map(store.listAreas().map((area) => [String(area.id), area]));
    const labels = new Map(store.listLabels().map((label) => [String(label.id), label]));
    const catalogue = buildControlCatalog({ devices: store.listDevices(), getArea: (id) => areas.get(String(id)), getLabel: (id) => labels.get(String(id)) });
    const localHomeId = String(store.getIdentity?.()?.instanceId || store.getIdentity?.()?.serial || "local-home");
    for (const definition of activeDefinitions) {
      if (definition.triggers.length !== 1 || !["SCHEDULE", "schedule"].includes(definition.triggers[0]?.kind)
        || definition.actions.length === 0 || definition.actions.some((action) => action.needsAttention)) {
        throw Object.assign(new Error("An active Platform automation is not executable by the current native OS schema"), { code: "sync_automation_invalid" });
      }
      for (const action of definition.actions) {
        const device = store.getDevice(action.osDeviceId);
        if (!device || Number(device.presentation?.descriptorRevision || 0) !== Number(action.descriptorRevision)
          || String(device.areaId || "") !== String(action.osAreaId)) {
          throw Object.assign(new Error("An active Platform automation target is stale or outside its current OS area"), { code: "sync_automation_target_stale" });
        }
      }
      const existing = store.getNativeAutomation(definition.id)?.automation || null;
      const normalized = normalizeDefinition({
        input: {
          id: definition.id, name: definition.name, enabled: true,
          trigger: {
            id: definition.triggers[0].id, type: "schedule",
            payload: { ...definition.triggers[0].configuration, timeZoneIdentifier: definition.timezone },
          },
          actions: definition.actions.map((action) => ({ id: action.id, deviceId: action.osDeviceId, controlId: action.controlId, targetValue: action.actionValue })),
        },
        existing, homeId: localHomeId, owner: { type: "platform", subjectId: "cloud-policy" },
      });
      const issues = validateAgainstCatalogue(normalized, catalogue);
      if (issues.length) throw Object.assign(new Error("An active Platform automation no longer matches the current native OS catalogue"), { code: "sync_automation_descriptor_invalid" });
      normalized.automation.revision = Number(definition.revision);
      normalized.automation.source = "platform_sync";
      normalized.automation.platformDefinitionChecksum = String(definition.definitionChecksum);
      normalized.automation.platformStatus = String(definition.status);
      runtimeAutomations.push(normalized);
    }
  }
  if (typeof store.applyCloudConfigurationSnapshot === "function") {
    return store.applyCloudConfigurationSnapshot(platformPatch, runtimeAutomations);
  }
  return store.savePlatform(platformPatch);
}

module.exports = { applyCloudConfiguration, validateCloudConfiguration };
