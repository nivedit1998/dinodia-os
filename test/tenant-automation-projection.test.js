"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { buildTenantAutomationSnapshot } = require("../src/tenantAutomationProjection");
const { validateCloudConfiguration, validTenantAutomationProjection } = require("../src/sync/cloudConfiguration");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function signedConfiguration() {
  const homeId = "a8218a24-8394-4d5b-8f23-06d205887abb";
  const membershipId = "76b31e09-ebdd-4970-959a-6b9a9423cbbd";
  const areaId = "a67b302c-6393-496f-9bf5-855f81397b51";
  const deviceId = "ef957c15-2540-4227-8dcc-523c005fdad8";
  const automationId = "7c8c3697-62e8-4ab9-a392-763e85fa7792";
  const triggerId = "5f621daa-0144-4ed7-8b30-d33feef783c4";
  const actionId = "70378ccd-92a2-480d-930e-0421a7b1a5ac";
  const osAreaId = "Room 1";
  const osDeviceId = "zigbee:test-radiator";
  const configuration = {
    revision: 7, policyRevision: 4,
    areas: [{ id: areaId, osAreaId, originalName: "Room 1", overrideName: null, revision: 2 }],
    memberships: [{ id: membershipId, role: "TENANT", accessRevision: 3, areaIds: [areaId], grantRevisions: [{ areaId, revision: 3 }] }],
    devicePolicies: [{ osDeviceId, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED", customerLabel: "Radiator", overrideName: null, analyticsCategory: "RADIATOR", descriptorRevision: 9, descriptorDigest: "a".repeat(64), osAreaIds: [osAreaId] }],
    automations: [],
    tenantAutomationProjection: {
      version: 1, executionEnabled: false, propertyTimeZone: null,
      automations: [
        { id: automationId, creatorMembershipId: membershipId, name: "Weekday heat", status: "ACTIVE", revision: 2,
          definitionChecksum: "b".repeat(64), timeZone: "Europe/London", retiredAt: null,
          createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
          trigger: { id: triggerId, kind: "SCHEDULE", minuteOfDay: 420, weekdays: [1, 2, 3, 4, 5], revision: 1 },
          actions: [{ id: actionId, deviceId, osDeviceId, areaId, osAreaId, controlId: "heat_demand", sortOrder: 0,
            descriptorRevision: 9, targetValue: { value: "heat" }, needsAttention: false,
            deviceManagementClass: "PROPERTY_DEVICE", deviceOwnerMembershipId: null, deviceLifecycle: "INSTALLED",
            deviceName: "Radiator", areaName: "Room 1" }], lastOutcome: null },
        { id: "904bb452-bc7c-41bf-951f-84925fca90b4", creatorMembershipId: "d31c3f4b-809f-4697-aa75-232090bc1a4f", name: "Private tenant schedule", status: "ACTIVE", revision: 1,
          definitionChecksum: "c".repeat(64), timeZone: "Europe/London", retiredAt: null,
          createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", trigger: null, actions: [], lastOutcome: null },
      ],
    },
    releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
  };
  configuration.checksum = crypto.createHash("sha256").update(canonical(configuration)).digest("hex");
  return { configuration, homeId, membershipId, areaId, deviceId, osDeviceId, automationId };
}

function fixture() {
  const ids = signedConfiguration();
  const platform = { homeId: ids.homeId, cloudRevision: 7, policyRevision: 4, cloudConfigurationChecksum: ids.configuration.checksum, cloudConfiguration: ids.configuration };
  const store = {
    getPlatform: () => platform,
    getSyncOutbox: () => ({ configurationAppliedRevision: 7, lastSuccessfulSyncAt: "2026-10-18T10:00:00.000Z" }),
    getDevice: (id) => id === ids.osDeviceId ? { presentation: { descriptorRevision: 9 } } : null,
  };
  const principal = { principalType: "app", householdRole: "TENANT", scope: ["tenant:device-command"], homeId: ids.homeId,
    membershipId: ids.membershipId, policyRevision: 4, areaIds: [ids.areaId] };
  return { ...ids, store, principal };
}

test("local automation projection uses applied signed config and returns only selected tenant automations", () => {
  const value = fixture();
  const projection = value.configuration.tenantAutomationProjection;
  assert.equal(validTenantAutomationProjection({ ...projection, automations: [] }), true, "empty signed projection is valid");
  assert.equal(validTenantAutomationProjection({ ...projection, automations: [projection.automations[0]] }), true, "tenant automation summary is valid");
  assert.equal(validTenantAutomationProjection(value.configuration.tenantAutomationProjection), true, "tenant projection envelope and record validation");
  assert.equal(validateCloudConfiguration(value.configuration, { cloudRevision: 7, policyRevision: 4, cloudConfigurationChecksum: value.configuration.checksum }), true);
  const result = buildTenantAutomationSnapshot(value);
  assert.equal(result.ok, true);
  assert.equal(result.delivery.state, "activation_disabled");
  assert.equal(result.delivery.appliedRevision, 7);
  assert.deepEqual(result.automations.map((automation) => automation.id), [value.automationId]);
  assert.equal(result.automations[0].status, "waiting_for_activation");
  assert.equal(result.automations[0].actions[0].deviceId, value.deviceId);
  assert.equal(result.automations[0].actions[0].areaId, value.areaId);
});

test("projection refuses stale revisions and never projects an ungranted action target", () => {
  const value = fixture();
  value.principal.policyRevision = 5;
  assert.equal(buildTenantAutomationSnapshot(value), null);
  value.principal.policyRevision = 4;
  value.principal.areaIds = [];
  assert.equal(buildTenantAutomationSnapshot(value), null);
  value.principal.areaIds = [value.areaId];
  value.store.getPlatform().cloudConfiguration.tenantAutomationProjection.automations[0].actions[0].areaId = "27a9183a-1210-4ad8-9d7a-f06b98dd5c68";
  const platform = value.store.getPlatform();
  delete platform.cloudConfiguration.checksum;
  platform.cloudConfiguration.checksum = crypto.createHash("sha256").update(canonical(platform.cloudConfiguration)).digest("hex");
  platform.cloudConfigurationChecksum = platform.cloudConfiguration.checksum;
  const result = buildTenantAutomationSnapshot(value);
  assert.equal(result.automations[0].status, "needs_attention");
  assert.deepEqual(result.automations[0].actions, []);
});

test("owner, offline and wrong-home principals cannot use the tenant projection", () => {
  const value = fixture();
  assert.equal(buildTenantAutomationSnapshot({ ...value, principal: { ...value.principal, householdRole: "OWNER" } }), null);
  assert.equal(buildTenantAutomationSnapshot({ ...value, principal: { ...value.principal, principalType: "offline" } }), null);
  assert.equal(buildTenantAutomationSnapshot({ ...value, principal: { ...value.principal, homeId: "b8218a24-8394-4d5b-8f23-06d205887abb" } }), null);
});
