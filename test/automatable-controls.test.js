const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { effectiveAutomatable } = require("../src/capabilities/schema");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { buildPresentation, getSurfaces } = require("../src/capabilities/devicePresentation");
const { serializeDevice } = require("../src/contracts/dinodiaV1");

// P4 — the allowlist is the safety boundary. Only the roles the owner approved for schedules
// (target_temperature, operating_mode, power, brightness) become automatable, and only when the
// control is safely writable. Everything else keeps the existing explicit flag behaviour.

const SETPOINT = { kind: "number", semanticRole: "target_temperature", writable: true, readable: true, idempotency: "set_value", stepUpPolicy: "none", sensitive: false };
const MODE = { kind: "enum", semanticRole: "operating_mode", writable: true, readable: true, idempotency: "set_value", stepUpPolicy: "none", sensitive: false };

test("the owner-approved roles are automatable when safely writable", () => {
  assert.equal(effectiveAutomatable(SETPOINT), true, "target temperature");
  assert.equal(effectiveAutomatable(MODE), true, "operating mode");
  assert.equal(effectiveAutomatable({ ...MODE, kind: "binary", semanticRole: "power" }), true, "power");
  assert.equal(effectiveAutomatable({ ...SETPOINT, kind: "number", semanticRole: "brightness" }), true, "brightness");
});

test("an explicit false on an approved role is overridden by the allowlist (persisted capabilities always carry false)", () => {
  assert.equal(effectiveAutomatable({ ...SETPOINT, automatable: false }), true);
});

test("TRV calibration, valve, schedules, child lock and other unknown roles stay non-automatable", () => {
  for (const role of ["unknown", "child_lock", "weekly_schedule_monday", "temperature_sensor_select", "valve_opening_degree"]) {
    assert.equal(effectiveAutomatable({ ...SETPOINT, semanticRole: role }), false, role);
  }
});

test("locks, step-up, sensitive, read-only and invoke controls are never automatable", () => {
  assert.equal(effectiveAutomatable({ ...SETPOINT, semanticRole: "security_lock", automatable: true }), false, "security lock");
  assert.equal(effectiveAutomatable({ ...SETPOINT, semanticRole: "lock_state", automatable: true }), false, "lock state");
  assert.equal(effectiveAutomatable({ ...SETPOINT, stepUpPolicy: "required" }), false, "step-up");
  assert.equal(effectiveAutomatable({ ...SETPOINT, sensitive: true }), false, "sensitive");
  assert.equal(effectiveAutomatable({ ...SETPOINT, writable: false }), false, "read-only");
  assert.equal(effectiveAutomatable({ ...SETPOINT, idempotency: "invoke" }), false, "invoke");
});

test("existing non-allowlisted controls keep their explicit automatable flag", () => {
  assert.equal(effectiveAutomatable({ kind: "binary", semanticRole: "unknown", writable: true, readable: true, idempotency: "set_value", stepUpPolicy: "none", sensitive: false, automatable: true }), true);
  assert.equal(effectiveAutomatable({ kind: "binary", semanticRole: "unknown", writable: true, readable: true, idempotency: "set_value", stepUpPolicy: "none", sensitive: false }), false);
});

test("the real SONOFF TRVZB descriptor exposes setpoint and system mode as automatable and nothing else writable", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
  const device = normalizeZigbeeDevice(fixture);
  device.areaId = "os-area-room-1";
  device.setup = { status: "ready", assignmentMode: "device_inherited_v1" };
  device.state = { occupied_heating_setpoint: 20, local_temperature: 19.5, system_mode: "heat", running_state: "heat", battery: 80 };
  device.presentation = buildPresentation(device);
  const descriptor = serializeDevice({ device, homeId: "home-fixture", homeMembershipId: "membership-fixture", role: "OWNER",
    areaIds: ["os-area-room-1"], surfaces: getSurfaces(device) });
  const automatable = descriptor.controls.filter((control) => control.automatable).map((control) => control.semanticRole).sort();
  assert.deepEqual(automatable, ["operating_mode", "target_temperature"]);
  for (const control of descriptor.controls.filter((item) => item.writable && !item.automatable)) {
    assert.ok(!["target_temperature", "operating_mode"].includes(control.semanticRole), `${control.label} is not schedulable`);
  }
});

const { Store } = require("../src/store");
const os = require("node:os");
const crypto = require("node:crypto");

test("after the update the Hub re-publishes each property device catalogue once so the Platform learns automatable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-catalog-publication-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-CATALOG-HUB", instanceId: "catalog-home" });
  await store.saveArea({ name: "Room 1" }, "os-room-1");
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
  const normalized = normalizeZigbeeDevice(fixture);
  await store.upsertDevice({ ...normalized, areaId: "os-room-1", managementClass: "PROPERTY_DEVICE",
    setup: { status: "ready", assignmentMode: "device_inherited_v1" },
    state: { occupied_heating_setpoint: 20, local_temperature: 19.5, system_mode: "heat", running_state: "heat", battery: 80 } });
  await store.savePlatform({ homeId: "catalog-home", devicePolicies: { [normalized.id]: { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
    lifecycle: "INSTALLED", descriptorRevision: store.getDevice(normalized.id).presentation.descriptorRevision,
    descriptorDigest: crypto.createHash("sha256").update(String(store.getDevice(normalized.id).presentation.sourceFingerprint), "utf8").digest("hex"),
    osAreaIds: ["os-room-1"], analyticsCategory: "RADIATOR", customerLabel: null, overrideName: null } } });

  const queued = () => store.getSyncOutbox().events.filter((event) => event.type === "control.catalog.upsert");
  assert.equal(typeof store.ensureControlCatalogPublications, "function", "the publication sweep exists");
  assert.equal(await store.ensureControlCatalogPublications(Date.now()), 1, "first sweep publishes the device catalogue once");
  const first = queued()[0];
  assert.ok(first, "a control.catalog.upsert event is queued");
  const setpoint = first.payload.controls.find((control) => control.semanticRole === "target_temperature");
  assert.equal(setpoint.automatable, true, "the published setpoint is automatable");
  assert.equal(await store.ensureControlCatalogPublications(Date.now()), 0, "a second sweep does not republish");
  assert.equal(queued().length, 1);
});

async function publishedRadiatorStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-catalog-order-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-CATALOG-ORDER", instanceId: "catalog-order-home" });
  await store.saveArea({ name: "Room 1" }, "os-room-1");
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
  const normalized = normalizeZigbeeDevice(fixture);
  await store.upsertDevice({ ...normalized, areaId: "os-room-1", managementClass: "PROPERTY_DEVICE",
    setup: { status: "ready", assignmentMode: "device_inherited_v1" }, state: { running_state: "heat" } });
  const device = store.getDevice(normalized.id);
  await store.savePlatform({ homeId: "catalog-order-home", devicePolicies: { [normalized.id]: { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
    lifecycle: "INSTALLED", descriptorRevision: device.presentation.descriptorRevision,
    descriptorDigest: crypto.createHash("sha256").update(String(device.presentation.sourceFingerprint), "utf8").digest("hex"),
    osAreaIds: ["os-room-1"], analyticsCategory: "RADIATOR", customerLabel: null, overrideName: null } } });
  await store.ensureControlCatalogPublications(Date.now());
  // Everything so far was accepted by the Platform.
  const outbox = store.getSyncOutbox();
  await store.commit((state) => { state.syncOutbox.acknowledgedSequence = outbox.nextSequence - 1; state.syncOutbox.events = []; });
  // A start-up rebuild advances the descriptor (e.g. a changed fingerprint formula) without any
  // inventory update, exactly as on the live Hub after build 27129d82 was installed.
  await store.commit((state) => {
    const live = state.devices[normalized.id];
    live.presentation = { ...live.presentation, descriptorRevision: live.presentation.descriptorRevision + 1, sourceFingerprint: `${live.presentation.sourceFingerprint}-rebuilt` };
  });
  return { directory, store, id: normalized.id };
}

test("a catalogue for a new descriptor revision is always preceded by that revision's device update", async () => {
  const { directory, store, id } = await publishedRadiatorStore();
  try {
    assert.equal(await store.ensureControlCatalogPublications(Date.now()), 1);
    const events = store.getSyncOutbox().events.filter((event) => event.payload?.osDeviceId === id || event.aggregateId === id);
    const catalog = events.find((event) => event.type === "control.catalog.upsert");
    const deviceUpdate = events.find((event) => event.type === "device.upsert" && event.payload.descriptorRevision === catalog.payload.catalogRevision);
    assert.ok(deviceUpdate, "the device update for the new revision is queued");
    assert.ok(deviceUpdate.sequence < catalog.sequence, "and it precedes the catalogue, so the Platform accepts the catalogue");
    assert.equal(deviceUpdate.payload.descriptorDigest, catalog.payload.descriptorDigest);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a rejected batch whose catalogue has no device update anywhere is repaired without changing sequence numbers", async () => {
  const { directory, store, id } = await publishedRadiatorStore();
  try {
    // The previous (unfixed) build queued only the catalogue: queue both, then remove the device
    // update's content the way a superseded event is represented, so the batch carries no device update.
    await store.ensureControlCatalogPublications(Date.now());
    await store.commit((state) => {
      for (const event of state.syncOutbox.events) {
        if (event.type === "device.upsert") { event.type = "sync.compacted"; event.aggregateId = ""; event.payload = { supersededBy: event.sequence + 1 }; }
      }
    });
    const batch = await store.prepareSyncBatch("00000000-0000-4000-8000-000000000021", { kind: "dinodia_os", version: "test", capabilities: {} }, Date.now());
    assert.deepEqual(batch.events.map((event) => event.type), ["sync.compacted", "control.catalog.upsert"]);
    await store.markSyncFailure("hub_sync_catalog_revision_mismatch");
    const before = store.getSyncOutbox();
    const result = await store.reconcileRejectedCatalogOrder({ streamId: before.streamId, acceptedSequence: before.acknowledgedSequence, errorCode: "hub_sync_catalog_revision_mismatch" });
    assert.equal(result.reconciled, true);
    const after = store.getSyncOutbox();
    assert.equal(after.inFlight.fromSequence, batch.fromSequence);
    assert.equal(after.inFlight.toSequence, batch.toSequence);
    assert.deepEqual(after.inFlight.events.map((event) => event.type), ["sync.compacted", "sync.compacted"], "only the superseded catalogue changes");
    const queued = after.events.filter((event) => event.sequence > batch.toSequence).map((event) => event.type);
    assert.deepEqual(queued, ["device.upsert", "control.catalog.upsert"], "device update then catalogue are queued after the batch");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
