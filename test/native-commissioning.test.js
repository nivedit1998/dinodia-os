const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { QrPairingCodeCodec } = require("@matter/types");
const { NativeCommissioningService, fixedSession, MAX_CANDIDATES } = require("../src/commissioning/nativeCommissioningService");

const uuid = () => crypto.randomUUID();
function fixture({ dropFirstCreateResponse = false, matterCommission = async () => ({}), matterRefresh = async () => [], commissioningCapabilities = {
  nativeZigbeeCommissioningV1: true, nativeMatterCommissioningV1: true, nativeCommissioningCatalogueVersion: "DINODIA-NATIVE-COMMISSIONING-V1",
} } = {}) {
  const areaId = uuid(); const homeId = uuid(); const hubInstallId = uuid(); const accountId = uuid();
  const membershipId = uuid(); const sid = uuid(); const trustedDeviceId = uuid();
  const principal = { principalType: "app", householdRole: "TENANT", scope: ["tenant:device-command"], sub: accountId, sid, jti: uuid(),
    trustedDeviceId, membershipId, homeId, hubInstallId, areaIds: [areaId], accessTokenHash: crypto.randomBytes(32).toString("hex"), identityGeneration: 7 };
  const devices = [];
  let security = {};
  const platformState = { homeId, hubInstallId, areaBindings: [{ areaId, hubAreaId: "os-area-1" }] };
  const store = {
    getSecurity: () => security,
    saveSecurity: async (patch) => { security = { ...security, ...patch }; },
    getPlatform: () => platformState,
    savePlatform: async (patch) => Object.assign(platformState, patch),
    getIdentity: () => ({ generation: 7 }),
    getZigbee: () => ({ adapterPath: "/dev/zigbee-test" }),
    getThread: () => ({ configured: true }),
    listDevices: () => devices.slice(),
    getDevice: (id) => devices.find((row) => row.id === id) || null,
    upsertDevice: async (row) => { const index = devices.findIndex((candidate) => candidate.id === row.id); if (index < 0) devices.push(row); else devices[index] = row; return row; },
    removeDevice: async (id) => { const index = devices.findIndex((row) => row.id === id); if (index >= 0) devices.splice(index, 1); },
    addEvent: async () => {},
  };
  const platformRequests = [];
  const platformSessions = new Map();
  let droppedCreateResponse = false;
  const pairing = { requestWithHubIdentity: async (_path, body) => {
    platformRequests.push(body);
    if (body.action === "create") {
      let record = platformSessions.get(body.idempotencyHash);
      if (!record) {
        record = { sessionId: body.sessionId, revision: 1, expiresAt: body.expiresAt, state: "REQUESTED" };
        platformSessions.set(body.idempotencyHash, record);
      }
      if (dropFirstCreateResponse && !droppedCreateResponse) { droppedCreateResponse = true; throw new Error("simulated response loss after Platform commit"); }
      return { ok: true, ...record };
    }
    if (body.action === "transition") return { ok: true, sessionId: body.sessionId, revision: body.expectedRevision + 1, state: body.status };
    if (body.action === "finalize") return { ok: true, sessionId: body.sessionId, revision: body.expectedRevision + 1, state: "COMPLETED", device: { id: uuid(), managementClass: body.actorType === "STAFF_INSTALLER" ? "PROPERTY_DEVICE" : "TENANT_DEVICE", ownerMembershipId: body.actorType === "STAFF_INSTALLER" ? null : body.membershipId, lifecycle: body.disposition === "view_only" ? "VIEW_ONLY" : "INSTALLED" } };
    throw new Error("unexpected Platform action");
  } };
  let pairingActive = false;
  const mqtt = {
    status: () => ({ connected: true }),
    pairingStatus: () => ({ active: pairingActive, found: [] }),
    startPairing: async () => { pairingActive = true; return { active: true }; },
    stopPairing: async () => { pairingActive = false; return { active: false }; },
    removeCommissioningCandidate: async (id) => { await store.removeDevice(id); return { acknowledged: true }; },
  };
  const matter = { status: () => ({ connected: true }), commission: matterCommission, refresh: matterRefresh, remove: async () => ({ ok: true }) };
  const vaultValues = new Map();
  const vault = { set: async (key, value) => vaultValues.set(key, value), get: (key) => vaultValues.get(key) || null, delete: async (key) => vaultValues.delete(key) };
  const service = new NativeCommissioningService({ store, mqtt, matter, pairing, vault, commissioningCapabilities, clock: () => Date.now(), logger: { warn() {} } });
  return { service, principal, store, devices, platformRequests, areaId, homeId, hubInstallId, vaultValues, matter, close: () => service.close() };
}

test("tenant commissioning starts one bound Zigbee join and exact retry returns its original opaque session", async (t) => {
  const f = fixture(); t.after(f.close);
  const first = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-0001");
  const retry = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-0001");
  assert.equal(first.sessionId, retry.sessionId);
  assert.equal(first.status, "searching");
  assert.equal(f.platformRequests.filter((row) => row.action === "create").length, 1);
  assert.equal(f.platformRequests.filter((row) => row.action === "transition").length, 1);
  const serialized = JSON.stringify(first);
  for (const secret of [f.principal.sub, f.principal.sid, f.principal.jti, f.principal.trustedDeviceId, f.principal.accessTokenHash, f.hubInstallId]) assert.equal(serialized.includes(secret), false);
});

test("a lost Platform create response is retried with one durable session identity and one radio join", async (t) => {
  const f = fixture({ dropFirstCreateResponse: true }); t.after(f.close);
  await assert.rejects(f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-lost-0001"));
  const pending = Object.values(f.service.sessions()).find((row) => row.requestHash);
  assert.equal(pending.status, "creating");
  assert.equal(pending.platformCreatePending, true);
  const recovered = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-lost-0001");
  assert.equal(recovered.sessionId, pending.sessionId);
  assert.equal(recovered.status, "searching");
  assert.equal(f.platformRequests.filter((row) => row.action === "create").length, 2);
  assert.equal(f.platformRequests.filter((row) => row.action === "transition").length, 1);
});

test("Matter setup payload accepts one standards-valid bounded code and never returns it in public status", async (t) => {
  const f = fixture(); t.after(f.close);
  const created = await f.service.start(f.principal, { protocol: "matter" }, "commission-matter-qr-0001");
  const code = QrPairingCodeCodec.encode([{ version: 0, vendorId: 0, productId: 0, flowType: 0,
    discoveryCapabilities: 2, discriminator: 3840, passcode: 20202021 }]);
  f.service.runMatterCommissioning = async () => {};
  const result = await f.service.matterPayload(created.sessionId, f.principal, code);
  assert.equal(result.status, "commissioning");
  assert.equal(JSON.stringify(result).includes(code), false);
  assert.equal(f.vaultValues.get(`commissioning.matter.${created.sessionId}`), code);
  assert.equal(f.platformRequests.filter((row) => row.action === "transition").length, 1);
});

test("malformed and over-limit Matter setup payloads have no vault, session or Platform effects", async (t) => {
  const f = fixture(); t.after(f.close);
  const created = await f.service.start(f.principal, { protocol: "matter" }, "commission-matter-invalid-0001");
  const before = JSON.stringify(f.service.sessions()[created.sessionId]);
  const transitionsBefore = f.platformRequests.filter((row) => row.action === "transition").length;
  for (const code of ["MT:" + "A".repeat(253), "MT:" + "A".repeat(18)]) {
    await assert.rejects(f.service.matterPayload(created.sessionId, f.principal, code), { code: "commissioning_request_invalid" });
  }
  assert.equal(f.vaultValues.size, 0);
  assert.equal(JSON.stringify(f.service.sessions()[created.sessionId]), before);
  assert.equal(f.platformRequests.filter((row) => row.action === "transition").length, transitionsBefore);
});

test("tenant candidate assignment requires a nonempty custom label and stores that label separately from its optional name", async (t) => {
  const f = fixture(); t.after(f.close);
  const session = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-label-0001");
  const device = { id: "zigbee:test-device", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Original lamp", name: "Original lamp", protocolIdentity: { ieeeAddress: "0x00124b0000000001" },
    setup: { status: "ready" }, entities: { light: { id: "light-main", name: "Power", domain: "light", state: false,
      capability: { category: "control", controlId: "power", semanticRole: "power", primary: true, readable: true, writable: true,
        kind: "binary", bindings: [{ serviceId: "light.toggle" }] } } }, metadata: { model: "test-model", deviceType: "light", manufacturer: "Test" } };
  await f.store.upsertDevice(device);
  f.service.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(session.sessionId, f.principal);
  const current = f.service.sessions()[session.sessionId];
  const candidate = current.candidates[0];
  await assert.rejects(f.service.select(session.sessionId, f.principal, { schemaVersion: "dinodia.v1", expectedRevision: current.revision,
    candidateRef: candidate.candidateRef, areaId: f.areaId, name: "", customerLabel: "" }), { code: "commissioning_request_invalid" });
  const selected = await f.service.select(session.sessionId, f.principal, { schemaVersion: "dinodia.v1", expectedRevision: current.revision,
    candidateRef: candidate.candidateRef, areaId: f.areaId, name: "", customerLabel: "Desk lamp" });
  assert.equal(selected.status, "selected");
  assert.equal(f.service.sessions()[session.sessionId].selectedCatalogue.capabilityStatus, "ready");
  const complete = await f.service.complete(session.sessionId, f.principal, "install");
  assert.equal(complete.status, "completed");
  const policy = f.store.getPlatform().devicePolicies[device.id];
  assert.equal(policy.customerLabel, "Desk lamp");
  assert.equal(f.store.getDevice(device.id).name, "Original lamp");
  const finalize = f.platformRequests.find((row) => row.action === "finalize");
  assert.equal(finalize.device.customerLabel, "Desk lamp");
  assert.equal(finalize.device.name, null);
});

test("unsupported newly joined radios cannot be installed or retained without useful current readings", async (t) => {
  const f = fixture(); t.after(f.close);
  const session = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-unsupported-0001");
  const device = { id: "zigbee:unsupported-device", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Unknown accessory", name: "Unknown accessory", protocolIdentity: { ieeeAddress: "0x00124b0000000099" },
    setup: { status: "ready" }, entities: {}, metadata: { deviceType: "unknown", manufacturer: "Unknown" } };
  await f.store.upsertDevice(device);
  f.service.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(session.sessionId, f.principal);
  const current = f.service.sessions()[session.sessionId];
  const candidate = current.candidates[0];
  const selected = await f.service.select(session.sessionId, f.principal, { schemaVersion: "dinodia.v1", expectedRevision: current.revision,
    candidateRef: candidate.candidateRef, areaId: f.areaId, name: "Unknown accessory", customerLabel: "Accessory" });
  assert.equal(selected.catalogueStatus, "unsupported");
  await assert.rejects(f.service.complete(session.sessionId, f.principal, "install"), { code: "commissioning_revision_conflict" });
  await assert.rejects(f.service.complete(session.sessionId, f.principal, "view_only"), { code: "commissioning_revision_conflict" });
  const removed = await f.service.complete(session.sessionId, f.principal, "remove");
  assert.equal(removed.status, "completed");
  assert.equal(removed.finalDisposition, "remove");
  assert.equal(f.store.getDevice(device.id), null);
  assert.equal(f.platformRequests.filter((row) => row.action === "finalize").length, 0);
  assert.equal(f.platformRequests.filter((row) => row.action === "transition" && row.result === "REMOVED").length, 1);
});

test("fresh readable but safely nonwritable devices can be retained view-only without widening controls", async (t) => {
  const f = fixture(); t.after(f.close);
  const session = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-view-only-0001");
  const observedAt = new Date().toISOString();
  const device = { id: "zigbee:read-only-device", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Read-only sensor", name: "Read-only sensor", protocolIdentity: { ieeeAddress: "0x00124b0000000088" },
    setup: { status: "ready" }, entities: { sensor: { id: "sensor-main", name: "Power state", domain: "light", state: false, observedAt,
      capability: { category: "control", controlId: "power-readonly", semanticRole: "power", primary: true, readable: true, writable: false,
        kind: "binary", maxStateValiditySeconds: 420, bindings: [] } } }, metadata: { deviceType: "light", manufacturer: "Test" } };
  await f.store.upsertDevice(device);
  f.service.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(session.sessionId, f.principal);
  const current = f.service.sessions()[session.sessionId];
  const candidate = current.candidates[0];
  const selected = await f.service.select(session.sessionId, f.principal, { schemaVersion: "dinodia.v1", expectedRevision: current.revision,
    candidateRef: candidate.candidateRef, areaId: f.areaId, name: "Read-only sensor", customerLabel: "Sensor" });
  assert.equal(selected.catalogueStatus, "no_safe_controls");
  assert.equal(selected.catalogueUsefulReadings, true);
  const completed = await f.service.complete(session.sessionId, f.principal, "view_only");
  assert.equal(completed.status, "completed");
  assert.equal(completed.finalDisposition, "view_only");
  const policy = f.store.getPlatform().devicePolicies[device.id];
  assert.equal(policy.lifecycle, "VIEW_ONLY");
  assert.equal(f.platformRequests.find((row) => row.action === "finalize").device.capabilitySummary.controls[0].writable, false);
});

test("Matter cancellation during an in-flight join waits, quarantines the late node, and removes it before releasing the radio", async (t) => {
  let settleCommission;
  let f;
  const commission = () => new Promise((resolve) => { settleCommission = resolve; });
  f = fixture({ matterCommission: commission, matterRefresh: async () => {
    const late = { id: "matter:late-join", protocol: "matter", available: true, protocolIdentity: { nodeId: "2001" }, setup: { status: "needs_setup" }, entities: {} };
    await f.store.upsertDevice(late);
    return [late];
  } });
  t.after(f.close);
  f.matter.remove = async (id) => {
    assert.equal(id, "matter:late-join");
    assert.equal(f.service.isQuarantinedDevice(id), true);
    return { ok: true };
  };
  const created = await f.service.start(f.principal, { protocol: "matter" }, "commission-key-matter-0001");
  const session = f.service.sessions()[created.sessionId];
  session.status = "commissioning"; session.matterPayloadSubmittedAt = new Date().toISOString(); session.radioOperationInFlight = true;
  await f.store.saveSecurity({ nativeCommissioningSessions: { ...f.service.sessions(), [session.sessionId]: session } });
  await f.service.vault.set(`commissioning.matter.${session.sessionId}`, "disposable-test-payload");
  const run = f.service.runMatterCommissioning(session.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await f.service.cancel(session.sessionId, f.principal);
  assert.equal(cancelled.status, "cancelled_cleanup_pending");
  assert.equal(cancelled.cleanup.pendingCount, 1);
  assert.equal(f.service.isQuarantinedDevice("matter:late-join"), false);
  settleCommission({ node_id: 2001 });
  await run;
  const final = f.service.sessions()[session.sessionId];
  assert.equal(final.status, "cancelled");
  assert.equal(final.cleanup.pendingIds.length, 0);
  assert.equal(final.radioOperationInFlight, false);
  assert.equal(final.radioOperationUncertain, undefined);
  assert.equal(f.store.getDevice("matter:late-join"), null);
  assert.equal(f.vaultValues.has(`commissioning.matter.${session.sessionId}`), false);
  const next = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-after-clean-01");
  assert.equal(next.status, "searching");
});

test("wrong-home membership is denied before radio effects", async (t) => {
  const f = fixture(); t.after(f.close);
  const wrong = { ...f.principal, homeId: uuid(), membershipId: uuid() };
  await assert.rejects(f.service.start(wrong, { protocol: "zigbee" }, "commission-key-0002"), { code: "commissioning_authority_denied" });
  assert.equal(f.platformRequests.length, 0);
  assert.equal(f.service.sessions ? Object.keys(f.service.sessions()).length : 0, 0);
});

test("assigned permanent-installation scope uses the same radio engine but registers a property-owned device only to the active request", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", hubInstallId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const session = await f.service.start(staff, { protocol: "zigbee" }, "assigned-install-commission-001");
  assert.equal(session.status, "searching");
  const created = f.platformRequests.find((row) => row.action === "create");
  assert.equal(created.actorType, "STAFF_INSTALLER");
  assert.equal(created.requestId, staff.requestId);
  assert.equal(created.membershipId, undefined);
  assert.equal(created.accountId, undefined);
  const device = { id: "zigbee:assigned-install-device", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Permanent lamp", name: "Permanent lamp", protocolIdentity: { ieeeAddress: "0x00124b0000000101" }, setup: { status: "ready" },
    entities: { light: { id: "light-permanent", name: "Power", domain: "light", state: false, capability: { category: "control", controlId: "power", semanticRole: "power", primary: true, readable: true, writable: true, kind: "binary", bindings: [{ serviceId: "light.toggle" }] } } },
    metadata: { model: "test-model", deviceType: "light", manufacturer: "Test" } };
  await f.store.upsertDevice(device);
  f.service.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(session.sessionId, staff);
  const current = f.service.sessions()[session.sessionId];
  const selected = await f.service.select(session.sessionId, staff, { schemaVersion: "dinodia.v1", expectedRevision: current.revision,
    candidateRef: current.candidates[0].candidateRef, areaId: f.areaId, name: "Permanent lamp", customerLabel: "Living room lamp" });
  assert.equal(selected.status, "selected");
  const complete = await f.service.complete(session.sessionId, staff, "install");
  assert.equal(complete.status, "completed");
  const finalize = f.platformRequests.find((row) => row.action === "finalize");
  assert.equal(finalize.actorType, "STAFF_INSTALLER");
  assert.equal(finalize.device.areaId, f.areaId);
  assert.equal(finalize.membershipId, undefined);
  assert.equal(f.store.getPlatform().devicePolicies[device.id].managementClass, "PROPERTY_DEVICE");
  assert.equal(f.store.getPlatform().devicePolicies[device.id].ownerMembershipId, null);
  assert.equal(f.store.getPlatform().devicePolicies[device.id].installationRequestId, staff.requestId);
});

test("installer commissioning rejects missing scoped-work claims before the first Platform or radio call", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", hubInstallId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  await assert.rejects(f.service.start({ ...staff, requestId: undefined }, { protocol: "zigbee" }, "assigned-install-denied-001"), { code: "commissioning_authority_denied" });
  await assert.rejects(f.service.start({ ...staff, areaIds: [uuid()], areaOptions: [{ id: uuid(), name: "Wrong Area" }] }, { protocol: "zigbee" }, "assigned-install-denied-002"), { code: "commissioning_authority_denied" });
  assert.equal(f.platformRequests.length, 0);
  assert.equal(f.service.sessions().length || Object.keys(f.service.sessions()).length, 0);
});

test("the hub permits only one active radio commissioning session across tenant memberships", async (t) => {
  const f = fixture(); t.after(f.close);
  await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-0003");
  const other = { ...f.principal, sid: uuid(), jti: uuid(), membershipId: uuid(), accessTokenHash: crypto.randomBytes(32).toString("hex") };
  await assert.rejects(f.service.start(other, { protocol: "matter" }, "commission-key-0004"), { code: "commissioning_radio_busy" });
  assert.equal(f.platformRequests.filter((row) => row.action === "create").length, 1);
});

test("protocol capability must be explicitly enabled for this hub before any session or radio effect", async (t) => {
  const f = fixture({ commissioningCapabilities: { nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false, nativeCommissioningCatalogueVersion: "" } }); t.after(f.close);
  await assert.rejects(f.service.start(f.principal, { protocol: "zigbee" }, "commission-capability-off-01"), { code: "commissioning_radio_unavailable" });
  assert.equal(f.platformRequests.length, 0);
  assert.equal(Object.keys(f.service.sessions()).length, 0);
});

test("candidate pages are stable and bounded at 32 without dropping the additional session candidates", async (t) => {
  const f = fixture(); t.after(f.close);
  const session = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-0005");
  const ids = Array.from({ length: MAX_CANDIDATES + 3 }, (_, index) => `zigbee:candidate-${index}`);
  for (let index = 0; index < ids.length; index += 1) await f.store.upsertDevice({ id: ids[index], protocol: "zigbee", setup: { status: "needs_setup" } });
  f.service.mqtt.pairingStatus = () => ({ active: true, found: ids });
  const first = await f.service.status(session.sessionId, f.principal);
  assert.equal(first.candidates.length, MAX_CANDIDATES);
  assert.ok(first.nextCandidateCursor);
  assert.equal(f.service.sessions()[session.sessionId].candidates.length, MAX_CANDIDATES + 3);
  const second = await f.service.status(session.sessionId, f.principal, 0, first.nextCandidateCursor);
  assert.equal(second.candidates.length, 3);
  assert.equal(second.nextCandidateCursor, null);
  assert.equal(new Set([...first.candidates, ...second.candidates].map((item) => item.candidateRef)).size, MAX_CANDIDATES + 3);
  await assert.rejects(f.service.status(session.sessionId, f.principal, 0, "not-a-current-cursor"), { code: "commissioning_revision_conflict" });
});

test("public session projection contains no protocol identity, bearer, account, or raw QR material", () => {
  const session = fixedSession({ sessionId: uuid(), protocol: "matter", status: "searching", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(),
    requesterAccountId: "private-account", requesterSessionId: "private-session", requesterTokenHash: "private-token-hash", candidates: [{ candidateRef: "safe-ref", deviceId: "node-private", identityHash: "ieee-private", name: "Lamp", rawQr: "MT:PRIVATE" }],
    events: [{ sequence: 1, type: "device_discovered", at: new Date().toISOString(), rawQr: "MT:PRIVATE", ieee: "private-ieee" }] });
  const text = JSON.stringify(session);
  for (const secret of ["private-account", "private-session", "private-token-hash", "node-private", "ieee-private", "MT:PRIVATE"]) assert.equal(text.includes(secret), false);
  assert.equal(session.candidates[0].name, "Lamp");
});
