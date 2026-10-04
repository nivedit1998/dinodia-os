const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { applyCloudConfiguration } = require("../src/sync/cloudConfiguration");
const { buildControlCatalog } = require("../src/automations/controlCatalog");
const crypto = require("node:crypto");

function configChecksum(value) {
  const canonical = (input) => Array.isArray(input) ? `[${input.map(canonical).join(",")}]`
    : input && typeof input === "object" ? `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`
      : JSON.stringify(input);
  return crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-sync-outbox-"));
  return { directory, store: new Store(path.join(directory, "store.json")) };
}

test("inventory mutations enqueue bounded safe events atomically and resume the identical in-flight batch after restart", async () => {
  const { directory, store } = temporaryStore();
  try {
    await store.saveArea({ name: "Kitchen", icon: "room" }, "os-area-1");
    const configuration = {
      revision: 1, policyRevision: 1,
      areas: [{ id: "public-area-1", osAreaId: "os-area-1", originalName: "Kitchen", overrideName: null, revision: 1 }],
      memberships: [],
      devicePolicies: [{ osDeviceId: "os-device-1", managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, analyticsCategory: "LIGHT", lifecycle: "INSTALLED", customerLabel: null, overrideName: null, descriptorRevision: 1, descriptorDigest: null, osAreaIds: ["os-area-1"] }],
      automations: [], releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
    };
    await applyCloudConfiguration(store, { ...configuration, checksum: configChecksum(configuration) });
    await store.savePlatform({ homeId: "home-a" });
    await store.upsertDevice({
      id: "os-device-1", name: "Kitchen Light", protocol: "zigbee", areaId: "os-area-1",
      setup: { status: "ready", assignmentMode: "device_inherited_v1", completedAt: "2026-10-04T10:00:00.000Z" },
      entities: { "internal:light": { id: "internal:light", name: "Power", state: "on", domain: "light", capability: { controlId: "control-power", kind: "binary", readable: true, writable: true, observable: true, primary: true, semanticRole: "power", bindings: [{ serviceId: "light.turn_on" }] } } },
      state: { power: "on", privateRawValue: "must-not-sync" },
      metadata: { ieee_address: "private-radio-id", friendly_name: "Kitchen Light" },
    });

    const before = store.getSyncOutbox();
    assert.equal(before.events.length, 3);
    assert.deepEqual(before.events.map((event) => event.type), ["area.upsert", "device.upsert", "control.catalog.upsert"]);
    assert.equal(before.events[2].payload.controls[0].controlId, "control-power");
    const serializedEvents = JSON.stringify(before.events);
    for (const forbidden of ["privateRawValue", "must-not-sync", "private-radio-id", "internal:light", "light.turn_on", '"state":"on"']) {
      assert.equal(serializedEvents.includes(forbidden), false, `outbox leaked ${forbidden}`);
    }

    const runtime = { kind: "dinodia_os", version: "test", capabilities: { syncV2: true } };
    const first = await store.prepareSyncBatch("00000000-0000-4000-8000-000000000001", runtime, 1_800_000_000_000);
    const restarted = new Store(path.join(directory, "store.json"));
    const resumed = await restarted.prepareSyncBatch("00000000-0000-4000-8000-000000000001", runtime, 1_800_000_100_000);
    assert.deepEqual(resumed, first, "restart must retry the same exact envelope and range");
    assert.equal(first.fromSequence, 1);
    assert.equal(first.toSequence, 3);
    assert.equal(first.events.length, 3);

    await assert.rejects(() => restarted.acknowledgeSyncBatch({ streamId: "wrong", acceptedThroughSequence: 3, cloudRevision: 1 }), /does not match/);
    assert.equal(restarted.getSyncOutbox().acknowledgedSequence, 0);
    await restarted.acknowledgeSyncBatch({ streamId: first.streamId, acceptedThroughSequence: 3, cloudRevision: 1, configurationAppliedRevision: 1 }, 1_800_000_200_000);
    assert.equal(restarted.getSyncOutbox().events.length, 0);
    assert.equal(restarted.getSyncOutbox().acknowledgedSequence, 3);

    await restarted.deleteDevice("os-device-1");
    assert.equal(restarted.getSyncOutbox().events.at(-1).type, "device.tombstone");
    assert.equal(restarted.getSyncOutbox().events.at(-1).critical, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tenant-private devices and their controls never enter the owner/manager sync outbox", async () => {
  const { directory, store } = temporaryStore();
  try {
    await store.saveIdentity({ serial: "hub-private-sync", generation: 1 });
    await store.saveArea({ name: "Private room", icon: "room" }, "private-os-area");
    await store.savePlatform({ homeId: "home-private-sync", devicePolicies: {
      "tenant-device": { osDeviceId: "tenant-device", managementClass: "TENANT_DEVICE", lifecycle: "INSTALLED", ownerMembershipId: "tenant-membership", analyticsCategory: "NONE", descriptorRevision: 1, osAreaIds: ["private-os-area"] },
    } });
    await store.upsertDevice({
      id: "tenant-device", name: "Private bedroom lamp", protocol: "zigbee", areaId: "private-os-area",
      entities: { "private-entity": { id: "private-entity", name: "Power", state: "on", domain: "light", capability: { controlId: "private-control", kind: "binary", readable: true, writable: true, observable: true, bindings: [{ serviceId: "light.turn_on" }] } } },
    });
    await store.ensureSyncSnapshot(Date.parse("2026-10-04T12:00:00.000Z"));
    const events = store.getSyncOutbox().events;
    assert.equal(events.some((event) => event.type === "device.upsert" && event.payload.osDeviceId === "tenant-device"), false);
    assert.equal(events.some((event) => event.type.startsWith("control.catalog") && event.payload.osDeviceId === "tenant-device"), false);
    for (const forbidden of ["Private bedroom lamp", "private-membership", "private-control", "private-entity", "light.turn_on"]) {
      assert.equal(JSON.stringify(events).includes(forbidden), false, `tenant-private sync event leaked ${forbidden}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata compaction keeps a contiguous cursor and telemetry pressure never drops authority tombstones", async () => {
  const { directory, store } = temporaryStore();
  try {
    await store.saveArea({ name: "Kitchen" }, "area-1");
    await store.saveArea({ name: "Kitchen updated" }, "area-1");
    const events = store.getSyncOutbox().events;
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.equal(events[0].type, "sync.compacted");
    assert.equal(events[1].type, "area.upsert");
    await store.queueSyncEvent("device.tombstone", "device-1", { osDeviceId: "device-1", removedAt: new Date().toISOString() }, { critical: true });
    assert.equal(store.getSyncOutbox().events.at(-1).critical, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a contiguous acknowledgement cannot erase a previously reported telemetry gap or critical backlog", async () => {
  const { directory, store } = temporaryStore();
  try {
    await store.queueSyncEvent("area.tombstone", "area-1", { osAreaId: "area-1", removedAt: "2026-10-04T10:00:00.000Z" }, { critical: true });
    await store.mutateAtomically((state) => {
      state.syncOutbox.gapDetected = true;
      state.syncOutbox.criticalBacklog = true;
      state.syncOutbox.telemetryPaused = true;
      state.syncOutbox.droppedTelemetryCount = 2;
    });
    const batch = await store.prepareSyncBatch("00000000-0000-4000-8000-000000000001", { version: "test" }, 1_800_000_000_000);
    await store.acknowledgeSyncBatch({
      streamId: batch.streamId, acceptedThroughSequence: batch.toSequence, cloudRevision: 1,
      configurationAppliedRevision: 1, resnapshotRequired: false,
    }, 1_800_000_100_000);
    const outbox = store.getSyncOutbox();
    assert.equal(outbox.gapDetected, true, "no gap-clear without an explicit reconciliation receipt");
    assert.equal(outbox.droppedTelemetryCount, 2, "loss counter remains monotonic");
    assert.equal(outbox.criticalBacklog, false, "the acknowledged critical batch frees critical queue capacity");
    assert.equal(outbox.telemetryPaused, false, "the successful receipt allows new telemetry when the queue is below its cap");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reportable incident transitions join the durable stream without private detail and clear only after cursor acknowledgement", async () => {
  const { directory, store } = temporaryStore();
  try {
    const incidentId = "private-device-offline:internal-device-77";
    await store.queueIncidentEnvelope({
      id: `${incidentId}:1`, incidentId, revision: 1, kind: "device_offline", state: "open",
      severity: "critical", summary: "Private tenant room device offline", detail: "private narrative that must not be sent",
      occurredAt: "2026-10-04T10:00:00.000Z", firstObservedAt: "2026-10-04T09:00:00.000Z",
      lastObservedAt: "2026-10-04T10:00:00.000Z", device: { id: "internal-device-77", name: "Tenant nursery" },
      area: { id: "private-area-9", name: "Tenant nursery" }, details: { raw: "private" },
    });
    assert.equal(store.getSyncOutbox().events.length, 1, "the reportable incident and its local event must share one durable write");
    assert.equal(await store.ensureSyncIncidentEvents("2026-10-04T10:01:01.000Z"), 0, "recovery migration must not allocate a second sequence for the same incident revision");
    const event = store.getSyncOutbox().events[0];
    assert.equal(event.type, "incident.transition");
    const wire = JSON.stringify(event);
    for (const forbidden of ["private narrative", "Tenant nursery", "private-area-9", '"raw":"private"']) assert.equal(wire.includes(forbidden), false);
    const batch = await store.prepareSyncBatch("00000000-0000-4000-8000-000000000001", { kind: "dinodia_os", version: "test", capabilities: {} }, Date.parse("2026-10-04T10:02:00.000Z"));
    assert.equal(store.listPendingIncidentEnvelopes().length, 1);
    await store.acknowledgeSyncBatch({ streamId: batch.streamId, acceptedThroughSequence: batch.toSequence, cloudRevision: 1 }, Date.parse("2026-10-04T10:03:00.000Z"));
    assert.equal(store.listPendingIncidentEnvelopes().length, 0, "incident source queue only clears after the durable sync cursor ack");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Platform-owned automation outcomes enter the durable stream once and remain deduplicated after restart", async () => {
  const { directory, store } = temporaryStore();
  try {
    const automationId = "55555555-5555-4555-8555-555555555555";
    const occurrenceId = "automation-55555555:3:2026-10-04:12:00";
    await store.mutateNativeAutomation((state) => {
      state.automations[automationId] = { id: automationId, source: "platform_sync", revision: 3, enabled: true };
      state.automationExecutions = [{
        occurrenceId, automationId, revision: 3, status: "partial",
        startedAt: "2026-10-04T11:59:00.000Z", completedAt: "2026-10-04T12:00:00.000Z",
        actionOutcomes: [
          { status: "applied" }, { status: "failed" }, { status: "uncertain" },
        ],
      }];
    });
    assert.equal(await store.ensureAutomationOutcomeEvents("2026-10-04T12:01:00.000Z"), 1);
    assert.equal(await store.ensureAutomationOutcomeEvents("2026-10-04T12:02:00.000Z"), 0);
    const event = store.getSyncOutbox().events[0];
    assert.equal(event.type, "automation.outcome");
    assert.equal(event.critical, true);
    assert.deepEqual(event.payload.actionStatuses, { applied: 1, failed: 1, uncertain: 1, skipped: 0 });
    for (const forbidden of ["targetValue", "controlId", "deviceId", "privateActionValue"]) assert.equal(JSON.stringify(event).includes(forbidden), false);

    const resumed = new Store(path.join(directory, "store.json"));
    const batch = await resumed.prepareSyncBatch("00000000-0000-4000-8000-000000000001", { version: "test" }, 1_800_000_000_000);
    await resumed.acknowledgeSyncBatch({ streamId: batch.streamId, acceptedThroughSequence: batch.toSequence, cloudRevision: 1 }, 1_800_000_100_000);
    assert.equal(await resumed.ensureAutomationOutcomeEvents("2026-10-04T12:03:00.000Z"), 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cloud configuration applies exact active automation revisions and removes stale runtime policy atomically", async () => {
  const { directory, store } = temporaryStore();
  try {
    await store.saveIdentity({ serial: "DINODIA-SYNC-HOME" });
    await store.saveArea({ name: "Kitchen", icon: "room" }, "area-1");
    await store.upsertDevice({
      id: "device-1", name: "Kitchen Light", protocol: "zigbee", areaId: "area-1", available: true,
      setup: { status: "ready", assignmentMode: "device_inherited_v1", completedAt: "2026-10-04T12:00:00.000Z" },
      entities: { "light:power": { id: "light:power", name: "Power", state: "off", domain: "light", stateKey: "power", endpointId: "1", logicalKey: "power", capability: { controlId: "control-power", kind: "binary", readable: true, writable: true, observable: true, automatable: true, semanticRole: "power", bindings: [{ serviceId: "light.turn_on" }, { serviceId: "light.turn_off" }] } } },
    });
    const device = store.getDevice("device-1");
    const controls = buildControlCatalog({ devices: [device], getArea: (id) => store.getArea(id) })[0].controls;
    const control = controls[0];
    const automationId = "55555555-5555-4555-8555-555555555555";
    const triggerId = "66666666-6666-4666-8666-666666666666";
    const actionId = "77777777-7777-4777-8777-777777777777";
    const active = {
      id: automationId, name: "Kitchen evening light", status: "ACTIVE", revision: 4,
      definitionChecksum: "a".repeat(64), timezone: "Europe/London",
      triggers: [{ id: triggerId, kind: "SCHEDULE", configuration: { minuteOfDay: 720, weekdays: [1, 2, 3, 4, 5, 6, 7] }, revision: 4 }],
      actions: [{ id: actionId, osDeviceId: "device-1", osAreaId: "area-1", controlId: control.controlId, descriptorRevision: device.presentation.descriptorRevision, actionValue: { type: "boolean", boolean: true }, needsAttention: false }],
    };
    const makeConfig = (revision, automations) => {
      const unsigned = {
        revision, policyRevision: revision,
        areas: [{ id: "public-area-1", osAreaId: "area-1", originalName: "Kitchen", overrideName: null, revision: 1 }],
        memberships: [],
        devicePolicies: [{ osDeviceId: "device-1", managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, analyticsCategory: "LIGHT", lifecycle: "INSTALLED", customerLabel: null, overrideName: null, descriptorRevision: device.presentation.descriptorRevision, descriptorDigest: crypto.createHash("sha256").update(String(device.presentation.sourceFingerprint || "")).digest("hex"), osAreaIds: ["area-1"] }],
        automations, releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
      };
      return { ...unsigned, checksum: configChecksum(unsigned) };
    };

    await applyCloudConfiguration(store, makeConfig(1, [active]));
    const imported = store.getNativeAutomation(automationId);
    assert.equal(imported.automation.source, "platform_sync");
    assert.equal(imported.automation.revision, 4);
    assert.equal(imported.automation.enabled, true);
    assert.equal(imported.actions[0].controlId, control.controlId);
    assert.equal(store.getPlatform().cloudRevision, 1);

    const paused = { ...active, status: "PAUSED", revision: 5 };
    await applyCloudConfiguration(store, makeConfig(2, [paused]));
    assert.equal(store.getNativeAutomation(automationId), null, "an explicit Platform pause removes the runnable local mirror");
    assert.equal(store.getPlatform().cloudRevision, 2);

    const stale = { ...active, revision: 6, actions: [{ ...active.actions[0], descriptorRevision: device.presentation.descriptorRevision + 1 }] };
    await assert.rejects(() => applyCloudConfiguration(store, makeConfig(3, [stale])), { code: "sync_automation_target_stale" });
    assert.equal(store.getPlatform().cloudRevision, 2, "invalid active policy cannot partially advance the applied config revision");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual updater status is revisioned and never implies automatic installation or untrusted readiness", async () => {
  const { directory, store } = temporaryStore();
  try {
    const status = { phase: "idle", trustState: "unprovisioned", activeReleaseVersion: null, lastAttempt: null, busy: false };
    assert.equal(await store.ensureUpdaterStatusEvent(status, 1_800_000_000_000), true);
    assert.equal(await store.ensureUpdaterStatusEvent(status, 1_800_000_000_100), false);
    const event = store.getSyncOutbox().events[0];
    assert.equal(event.type, "update.status");
    assert.equal(event.critical, true);
    assert.equal(event.payload.trustState, "unprovisioned");
    assert.equal(event.payload.phase, "idle");
    assert.equal(event.payload.activeReleaseVersion, null);
    assert.equal(store.getPlatform().updaterStatusRevision, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("platform-owned activity sync preserves source time, expires to Unknown, and never fabricates observation freshness", async () => {
  const { directory, store } = temporaryStore();
  try {
    await store.saveIdentity({ serial: "hub-a", instanceId: "instance-a", generation: 2 });
    await store.saveArea({ name: "Kitchen" }, "area-a");
    await store.savePlatform({ homeId: "home-a", devicePolicies: {
      "os-light": { osDeviceId: "os-light", managementClass: "PROPERTY_DEVICE", analyticsCategory: "LIGHT", lifecycle: "INSTALLED", ownerMembershipId: null, descriptorRevision: 1, descriptorDigest: "a".repeat(64), osAreaIds: ["area-a"] },
    } });
    const device = await store.upsertDevice({
      id: "os-light", name: "Kitchen Light", protocol: "zigbee", areaId: "area-a",
      setup: { status: "ready", assignmentMode: "device_inherited_v1", completedAt: "2026-10-04T10:00:00.000Z" },
      state: { power: "on" },
      entities: { "entity-power": { id: "entity-power", name: "Power", state: "on", observedAt: "2026-10-04T11:00:00.000Z", domain: "light", capability: { controlId: "control-power", kind: "binary", readable: true, writable: true, observable: true, primary: true, semanticRole: "power", maxStateValiditySeconds: 420, bindings: [{ serviceId: "light.turn_on" }] } } },
    }, { nowMs: Date.parse("2026-10-04T11:01:00.000Z") });

    assert.equal(device.entities["entity-power"].sourceObservedAt, "2026-10-04T11:00:00.000Z");
    const firstBucket = store.getSyncOutbox().events.find((event) => event.type === "usage.bucket");
    assert.ok(firstBucket);
    assert.equal(firstBucket.payload.onSeconds, 60);
    await store.advanceSyncUsage(Date.parse("2026-10-04T11:10:00.000Z"));
    const latest = store.getSyncOutbox().events.filter((event) => event.type === "usage.bucket").at(-1);
    assert.equal(latest.payload.onSeconds, 420);
    assert.equal(latest.payload.unknownSeconds, 180);

    const missing = await store.upsertDevice({ id: "missing-time", name: "No timestamp", protocol: "zigbee", areaId: "area-a", state: { power: "on" }, entities: {
      "entity-no-time": { id: "entity-no-time", name: "Power", state: "on", domain: "light", capability: { controlId: "control-no-time", kind: "binary", readable: true, writable: true, observable: true, semanticRole: "power", bindings: [] } },
    } }, { nowMs: Date.parse("2026-10-04T11:10:00.000Z") });
    assert.equal(missing.entities["entity-no-time"].sourceObservedAt, null);
    assert.equal(store.getSyncOutbox().events.some((event) => event.type === "usage.bucket" && event.payload.osDeviceId === "missing-time"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
