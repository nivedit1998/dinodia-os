"use strict";

const { validateCloudConfiguration } = require("./sync/cloudConfiguration");

function sortedUniqueStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    && new Set(value).size === value.length ? [...value].sort() : null;
}

function safeLastOutcome(value) {
  if (!value || typeof value !== "object") return null;
  const result = {
    status: String(value.status || "uncertain"),
    startedAt: String(value.startedAt || ""),
    completedAt: value.completedAt == null ? null : String(value.completedAt),
  };
  if (Number.isSafeInteger(value.actionCount) && value.actionCount >= 0 && value.actionCount <= 32
    && value.actionStatuses && typeof value.actionStatuses === "object") {
    const counts = value.actionStatuses;
    if (["applied", "failed", "uncertain", "skipped"].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0 && counts[key] <= value.actionCount)) {
      result.actionCount = value.actionCount;
      result.actionStatuses = { applied: counts.applied, failed: counts.failed, uncertain: counts.uncertain, skipped: counts.skipped };
    }
  }
  return result;
}

function buildTenantAutomationSnapshot({ store, principal }) {
  if (!store || !principal || principal.principalType !== "app" || principal.householdRole !== "TENANT"
    || !principal.scope?.includes("tenant:device-command") || !principal.homeId || !principal.membershipId) return null;

  const platform = store.getPlatform?.() || {};
  const configuration = platform.cloudConfiguration;
  if (String(platform.homeId || "") !== String(principal.homeId || "")
    || !validateCloudConfiguration(configuration, platform)
    || !configuration.tenantAutomationProjection
    || Number(platform.cloudRevision) !== Number(configuration.revision)
    || Number(platform.policyRevision) !== Number(configuration.policyRevision)
    || Number(principal.policyRevision) !== Number(configuration.policyRevision)) return null;

  const outbox = store.getSyncOutbox?.() || {};
  const appliedRevision = Number(outbox.configurationAppliedRevision || 0);
  if (!Number.isSafeInteger(appliedRevision) || appliedRevision < Number(configuration.revision)) return null;

  const membership = configuration.memberships.find((candidate) => candidate.id === String(principal.membershipId) && candidate.role === "TENANT");
  const tokenAreas = sortedUniqueStrings(principal.areaIds);
  const configuredAreas = sortedUniqueStrings(membership?.areaIds);
  if (!membership || !tokenAreas || !configuredAreas
    || tokenAreas.join("\n") !== configuredAreas.join("\n")) return null;

  const tenantProjection = configuration.tenantAutomationProjection;
  const areaByCanonicalId = new Map(configuration.areas.map((area) => [String(area.id), area]));
  const areaByOsId = new Map(configuration.areas.map((area) => [String(area.osAreaId), area]));
  const devicePolicies = new Map(configuration.devicePolicies.map((policy) => [String(policy.osDeviceId), policy]));
  const ownedRows = tenantProjection.automations.filter((automation) => automation.creatorMembershipId === membership.id);
  const deliveryApplied = appliedRevision >= Number(configuration.revision);

  const automations = ownedRows.flatMap((automation) => {
    if (automation.status === "RETIRED" && deliveryApplied) return [];
    let needsAttention = automation.status === "NEEDS_ATTENTION";
    const actions = automation.status === "RETIRED" ? [] : automation.actions.flatMap((action) => {
      const area = areaByCanonicalId.get(String(action.areaId));
      const osArea = areaByOsId.get(String(action.osAreaId));
      const policy = devicePolicies.get(String(action.osDeviceId));
      const localDevice = store.getDevice?.(String(action.osDeviceId));
      const ownershipValid = policy && (policy.managementClass === "PROPERTY_DEVICE"
        ? policy.ownerMembershipId === null && action.deviceManagementClass === "PROPERTY_DEVICE" && action.deviceOwnerMembershipId === null
        : policy.managementClass === "TENANT_DEVICE" && policy.ownerMembershipId === membership.id
          && action.deviceManagementClass === "TENANT_DEVICE" && action.deviceOwnerMembershipId === membership.id);
      const currentAreaGrant = area && tokenAreas.includes(String(area.id)) && osArea?.id === area.id
        && policy?.osAreaIds?.includes(String(action.osAreaId));
      const activePolicy = ["INSTALLED"].includes(String(policy?.lifecycle))
        && action.deviceLifecycle === "INSTALLED";
      const descriptorCurrent = Number(policy?.descriptorRevision) === Number(action.descriptorRevision)
        && Number(localDevice?.presentation?.descriptorRevision || 0) === Number(action.descriptorRevision);
      if (!ownershipValid || !currentAreaGrant || !activePolicy || !localDevice) {
        needsAttention = true;
        return [];
      }
      const actionNeedsAttention = action.needsAttention === true || !descriptorCurrent;
      if (actionNeedsAttention) needsAttention = true;
      return [{
        id: String(action.id), deviceId: String(action.deviceId), areaId: String(action.areaId),
        controlId: String(action.controlId), sortOrder: Number(action.sortOrder),
        descriptorRevision: Number(action.descriptorRevision), targetValue: action.targetValue,
        needsAttention: actionNeedsAttention,
        deviceName: String(action.deviceName), areaName: String(action.areaName),
      }];
    });

    let status;
    if (needsAttention || !automation.trigger || automation.actions.length > 0 && actions.length === 0 && automation.status !== "RETIRED") status = "needs_attention";
    else if (automation.status === "RETIRED") status = "removal_pending";
    else if (automation.status === "PAUSED" || automation.status === "DRAFT") status = deliveryApplied ? "disabled" : "disabled_waiting_for_hub";
    else if (!tenantProjection.executionEnabled) status = "waiting_for_activation";
    else status = deliveryApplied ? "active" : "waiting_for_hub";

    return [{
      id: String(automation.id), name: String(automation.name), status,
      revision: Number(automation.revision), definitionChecksum: String(automation.definitionChecksum),
      timeZone: String(automation.timeZone), trigger: automation.trigger,
      actions, lastOutcome: safeLastOutcome(automation.lastOutcome),
      createdAt: String(automation.createdAt), updatedAt: String(automation.updatedAt),
    }];
  });

  return {
    ok: true,
    homeId: String(principal.homeId), membershipId: String(membership.id),
    membershipRevision: Number(membership.accessRevision),
    managementRevision: Number(configuration.revision),
    propertyTimeZone: tenantProjection.propertyTimeZone || null,
    delivery: {
      state: !tenantProjection.executionEnabled ? "activation_disabled" : deliveryApplied ? "applied" : "pending_delivery",
      cloudRevision: Number(configuration.revision), appliedRevision,
      lastSuccessfulSyncAt: typeof outbox.lastSuccessfulSyncAt === "string" ? outbox.lastSuccessfulSyncAt : null,
    },
    automations,
  };
}

module.exports = { buildTenantAutomationSnapshot };
