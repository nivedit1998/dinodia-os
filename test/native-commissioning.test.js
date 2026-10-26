const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const { QrPairingCodeCodec } = require("@matter/types");
const { NativeCommissioningService, fixedSession, MAX_CANDIDATES } = require("../src/commissioning/nativeCommissioningService");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");

const uuid = () => crypto.randomUUID();

test("protocol operational flags are independent of any removed catalogue marker and remain explicit holds", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DINODIA_NATIVE_")));
  const readFlags = (overrides = {}) => JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./src/config').nativeCommissioningCapabilities))"], {
    cwd: process.cwd(), env: { ...env, ...overrides }, encoding: "utf8",
  }));
  assert.deepEqual(readFlags(), { nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false,
    nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: true });
  assert.deepEqual(readFlags({ DINODIA_NATIVE_ZIGBEE_COMMISSIONING_ENABLED: "false", DINODIA_NATIVE_MATTER_COMMISSIONING_ENABLED: "false" }), {
    nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false,
    nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: true,
  });
  assert.deepEqual(readFlags({ DINODIA_NATIVE_ZIGBEE_COMMISSIONING_ENABLED: "true", DINODIA_NATIVE_MATTER_COMMISSIONING_ENABLED: "true" }), {
    nativeZigbeeCommissioningV1: true, nativeMatterCommissioningV1: true,
    nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: true,
  });
  assert.deepEqual(readFlags({ DINODIA_NATIVE_ZIGBEE_COMMISSIONING_ENABLED: "yes", DINODIA_NATIVE_MATTER_COMMISSIONING_ENABLED: "1" }), {
    nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false,
    nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: true,
  });
  assert.deepEqual(readFlags({ DINODIA_NATIVE_STAFF_ZIGBEE_COMMISSIONING_ENABLED: "false", DINODIA_NATIVE_STAFF_MATTER_COMMISSIONING_ENABLED: "false" }), {
    nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false,
    nativeStaffZigbeeCommissioningV1: false, nativeStaffMatterCommissioningV1: false, nativeStaffDeviceRegistrationV1: true,
  });
  assert.deepEqual(readFlags({ DINODIA_NATIVE_STAFF_DEVICE_REGISTRATION_ENABLED: "false" }), {
    nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false,
    nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: false,
  });
});
function fixture({ dropFirstCreateResponse = false, matterCommission = async () => ({}), matterRefresh = async () => [], commissioningCapabilities = {
  nativeZigbeeCommissioningV1: true, nativeMatterCommissioningV1: true,
  nativeStaffZigbeeCommissioningV1: true, nativeStaffMatterCommissioningV1: true, nativeStaffDeviceRegistrationV1: true,
} } = {}) {
  const areaId = uuid(); const homeId = uuid(); const hubInstallId = uuid(); const accountId = uuid();
  const membershipId = uuid(); const sid = uuid(); const trustedDeviceId = uuid();
  const principal = { principalType: "app", householdRole: "TENANT", scope: ["tenant:device-command"], sub: accountId, sid, jti: uuid(),
    trustedDeviceId, membershipId, homeId, hubInstallId, areaIds: [areaId], accessTokenHash: crypto.randomBytes(32).toString("hex"), identityGeneration: 7 };
  const devices = [];
  const events = [];
  const syncOutbox = { acknowledgedSequence: 0, events: [], inFlight: null };
  let security = {};
  const platformState = { homeId, hubInstallId, areaBindings: [{ areaId, hubAreaId: "os-area-1" }] };
  const store = {
    getSecurity: () => security,
    saveSecurity: async (patch) => { security = { ...security, ...patch }; },
    getPlatform: () => platformState,
    savePlatform: async (patch) => Object.assign(platformState, patch),
    getSyncOutbox: () => syncOutbox,
    getIdentity: () => ({ generation: 7, serial: "DIN-HUB-1" }),
    getZigbee: () => ({ adapterPath: "/dev/zigbee-test" }),
    getThread: () => ({ configured: true }),
    listDevices: () => devices.slice(),
    listAreas: () => [{ id: "os-area-1", name: "Living Room" }],
    listLabels: () => [{ id: "light", name: "Light" }, { id: "boiler", name: "Boiler" }, { id: "radiator", name: "Radiator" }, { id: "tenant_device", name: "Tenant Device" }],
    getDevice: (id) => devices.find((row) => row.id === id) || null,
    upsertDevice: async (row, options = {}) => { if (options.devicePolicy) {
      platformState.devicePolicies = { ...(platformState.devicePolicies || {}), [row.id]: options.devicePolicy };
      if (options.devicePolicy.managementClass === "PROPERTY_DEVICE") platformState.pendingPropertyDevicePolicies = { ...(platformState.pendingPropertyDevicePolicies || {}), [row.id]: options.devicePolicy };
    } const index = devices.findIndex((candidate) => candidate.id === row.id); if (index < 0) devices.push(row); else devices[index] = row; return row; },
    removeDevice: async (id) => { const index = devices.findIndex((row) => row.id === id); if (index >= 0) devices.splice(index, 1); },
    addEvent: async (event) => { events.unshift(event); },
    listEvents: () => events.slice(),
  };
  const platformRequests = [];
  const radioEffects = { zigbeeStart: 0, zigbeeStop: 0, zigbeeRemove: 0, matterCommission: 0, matterRemove: 0 };
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
    if (body.action === "finalize") return { ok: true, sessionId: body.sessionId, revision: body.expectedRevision + 1, state: "COMPLETED", device: { id: uuid(), managementClass: body.actorType === "STAFF_INSTALLER" ? "PROPERTY_DEVICE" : "TENANT_DEVICE", ownerMembershipId: body.actorType === "STAFF_INSTALLER" ? null : body.membershipId, lifecycle: body.disposition === "view_only" ? "VIEW_ONLY" : "INSTALLED", analyticsCategory: body.device?.analyticsCategory || "NONE", inventoryRevision: 2 } };
    throw new Error("unexpected Platform action");
  } };
  let pairingActive = false;
  const mqtt = {
    status: () => ({ connected: true }),
    pairingStatus: () => ({ active: pairingActive, found: [] }),
    startPairing: async () => { radioEffects.zigbeeStart += 1; pairingActive = true; return { active: true }; },
    stopPairing: async () => { radioEffects.zigbeeStop += 1; pairingActive = false; return { active: false }; },
    removeCommissioningCandidate: async (id) => { radioEffects.zigbeeRemove += 1; if (!store.getDevice(id)) throw new Error("Zigbee candidate is missing from the local registry"); await store.removeDevice(id); return { acknowledged: true }; },
  };
  const matter = { status: () => ({ connected: true }), commission: async (...args) => { radioEffects.matterCommission += 1; return matterCommission(...args); }, refresh: matterRefresh,
    remove: async () => { radioEffects.matterRemove += 1; return { ok: true }; } };
  const vaultValues = new Map();
  const vault = { set: async (key, value) => vaultValues.set(key, value), get: (key) => vaultValues.get(key) || null, delete: async (key) => vaultValues.delete(key) };
  const service = new NativeCommissioningService({ store, mqtt, matter, pairing, vault, commissioningCapabilities, clock: () => Date.now(), logger: { warn() {} } });
  return { service, principal, store, devices, events, platformRequests, radioEffects, areaId, homeId, hubInstallId, vaultValues, mqtt, matter, close: () => service.close() };
}

test('detached Store snapshots retain the acknowledged cloud revision before review and completion', async t => {
  const f = fixture(); t.after(f.close);
  const originalGet = f.store.getSecurity, originalSave = f.store.saveSecurity;
  f.store.getSecurity = () => structuredClone(originalGet());
  f.store.saveSecurity = patch => originalSave(structuredClone(patch));
  const originalRequest = f.service.pairing.requestWithHubIdentity;
  let cloudRevision = 1;
  f.service.pairing.requestWithHubIdentity = async (route, body) => {
    if (body.action !== 'create') {
      assert.equal(body.expectedRevision, cloudRevision, 'request must use the last durable cloud acknowledgement');
      cloudRevision += 1;
    }
    return originalRequest(route, body);
  };
  const started = await f.service.start(f.principal, { protocol: 'zigbee' }, uuid());
  assert.equal(f.service.sessions()[started.sessionId].expectedPlatformRevision, 2);
  const device = normalizeZigbeeDevice(require('./fixtures/zigbee/radiator-device.json'));
  await f.store.upsertDevice(device); f.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(started.sessionId, f.principal);
  const current = f.service.sessions()[started.sessionId];
  await f.service.select(started.sessionId, f.principal, { schemaVersion:'dinodia.v1', expectedRevision:current.revision,
    candidateRef:current.candidates[0].candidateRef, areaId:f.areaId, name:'New radiator', customerLabel:'Radiator' });
  const completed = await f.service.complete(started.sessionId, f.principal);
  assert.equal(completed.status, 'completed');
  assert.equal(cloudRevision, 4);
  assert.equal(f.radioEffects.zigbeeStart, 1);
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});

for (const legacyRevision of [1, 3]) {
test(`legacy selected review at revision ${legacyRevision} is quarantined without guessing cloud state or unpairing`, async t => {
  const f = fixture(); t.after(f.close);
  const started = await f.service.start(f.principal, { protocol:'zigbee' }, uuid());
  const device = normalizeZigbeeDevice(require('./fixtures/zigbee/radiator-device.json'));
  await f.store.upsertDevice(device); f.mqtt.pairingStatus = () => ({ active:true, found:[device.id] });
  await f.service.status(started.sessionId, f.principal);
  const current = f.service.sessions()[started.sessionId];
  await f.service.select(started.sessionId, f.principal, { schemaVersion:'dinodia.v1', expectedRevision:current.revision,
    candidateRef:current.candidates[0].candidateRef, areaId:f.areaId, name:'New radiator', customerLabel:'Radiator' });
  const legacy = f.service.sessions()[started.sessionId];
  delete legacy.selectedPlatformReady;
  legacy.expectedPlatformRevision = legacyRevision;
  await f.service.save(legacy);
  const requestsBefore = f.platformRequests.length;
  await assert.rejects(f.service.complete(started.sessionId, f.principal), { reason:'legacy_review_recovery_required' });
  assert.equal(f.platformRequests.length, requestsBefore, 'no READY/finalize with guessed state');
  assert.ok(f.store.getDevice(device.id), 'candidate pairing is preserved');
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});
}

for (const outcome of ['reject', 'wrong_session', 'wrong_revision', 'lost_response']) {
test(`cloud READY ${outcome} cannot claim review or finalize; exact response-loss retry is safe`, async t => {
  const f = fixture(); t.after(f.close);
  const originalGet = f.store.getSecurity, originalSave = f.store.saveSecurity;
  f.store.getSecurity = () => structuredClone(originalGet());
  f.store.saveSecurity = patch => originalSave(structuredClone(patch));
  const started = await f.service.start(f.principal, { protocol: 'zigbee' }, uuid());
  const device = normalizeZigbeeDevice(require('./fixtures/zigbee/radiator-device.json'));
  await f.store.upsertDevice(device); f.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(started.sessionId, f.principal);
  const current = f.service.sessions()[started.sessionId];
  const input = { schemaVersion:'dinodia.v1', expectedRevision:current.revision,
    candidateRef:current.candidates[0].candidateRef, areaId:f.areaId, name:'New radiator', customerLabel:'Radiator' };
  const originalRequest = f.service.pairing.requestWithHubIdentity;
  let committedReview = null;
  f.service.pairing.requestWithHubIdentity = async (route, body) => {
    if (body.action !== 'transition' || body.status !== 'READY') return originalRequest(route, body);
    if (outcome === 'reject') throw new Error('cloud rejected review');
    const result = await originalRequest(route, body);
    if (outcome === 'wrong_session') return { ...result, sessionId: uuid() };
    if (outcome === 'wrong_revision') return { ...result, revision: 900 };
    if (!committedReview) { committedReview = structuredClone(body); throw new Error('response lost'); }
    assert.deepEqual(body, committedReview, 'lost acknowledgement replays the exact review, not a new registration');
    return result;
  };
  await assert.rejects(f.service.select(started.sessionId, f.principal, input));
  assert.notEqual(f.service.sessions()[started.sessionId].status, 'selected');
  assert.equal(f.service.sessions()[started.sessionId].expectedPlatformRevision, 2);
  await assert.rejects(f.service.complete(started.sessionId, f.principal), /Select a discovered device/);
  if (outcome === 'lost_response') {
    await f.service.select(started.sessionId, f.principal, input);
    assert.equal((await f.service.complete(started.sessionId, f.principal)).status, 'completed');
    assert.equal(f.platformRequests.filter(row => row.action === 'finalize').length, 1);
  }
  assert.equal(f.radioEffects.zigbeeStart, 1);
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});
}

test('a rejected cloud READY never persists a locally completed review or allows finalization', async t => {
  const f = fixture(); t.after(f.close);
  const originalGet = f.store.getSecurity;
  f.store.getSecurity = () => JSON.parse(JSON.stringify(originalGet()));
  const started = await f.service.start(f.principal, { protocol: 'zigbee' }, uuid());
  const device = normalizeZigbeeDevice(require('./fixtures/zigbee/radiator-device.json'));
  await f.store.upsertDevice(device); f.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(started.sessionId, f.principal);
  const current = f.service.sessions()[started.sessionId];
  const originalRequest = f.service.pairing.requestWithHubIdentity;
  f.service.pairing.requestWithHubIdentity = async (route, body) => {
    if (body.action === 'transition' && body.status === 'READY') throw Object.assign(new Error('READY rejected'), { code: 'commissioning_transition_invalid' });
    return originalRequest(route, body);
  };
  await assert.rejects(f.service.select(started.sessionId, f.principal, { schemaVersion:'dinodia.v1', expectedRevision:current.revision,
    candidateRef:current.candidates[0].candidateRef, areaId:f.areaId, name:'New radiator', customerLabel:'Radiator' }), /READY rejected/);
  assert.notEqual(f.service.sessions()[started.sessionId].status, 'selected');
  await assert.rejects(f.service.complete(started.sessionId, f.principal), /Select a discovered device/);
});

test('real commissioning completion activates two private channel records under one physical pairing', async (t) => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { Store } = require('../src/store');
  const f = fixture();
  t.after(f.close);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-logical-commissioning-'));
  const store = new Store(path.join(directory, 'store.json'));
  t.after(async () => { await store.persist(); await fs.rm(directory, { recursive: true, force: true }); });
  await store.saveArea({ name: 'Living Room' }, 'os-area-1');
  await store.saveIdentity({ generation: 7, serial: 'DIN-HUB-1' });
  await store.savePlatform({ homeId: f.homeId, hubInstallId: f.hubInstallId,
    areaBindings: [{ areaId: f.areaId, hubAreaId: 'os-area-1' }] });
  await store.saveZigbee({ adapterPath: '/dev/zigbee-test' });
  f.service.store = store;
  f.service.logicalDevicesEnabled = true;
  const previous = f.service.pairing.requestWithHubIdentity;
  f.service.pairing.requestWithHubIdentity = async (route, body) => {
    if (body.action !== 'finalize' || !body.device.channels) return previous(route, body);
    const logicalDevices = body.device.channels.map(channel => ({ id: uuid(), osDeviceId: channel.catalogue.osDeviceId,
      managementClass: 'TENANT_DEVICE', ownerMembershipId: f.principal.membershipId, lifecycle: 'INSTALLED',
      analyticsCategory: 'NONE', descriptorRevision: channel.catalogue.descriptorRevision,
      descriptorDigest: channel.catalogue.descriptorDigest, inventoryRevision: 1, binding: channel.binding }));
    return { ok: true, revision: body.expectedRevision + 1, state: 'COMPLETED', device: logicalDevices[0], logicalDevices };
  };
  const session = await f.service.start(f.principal, { protocol: 'zigbee' }, uuid());
  const parent = normalizeZigbeeDevice(require('./fixtures/zigbee/two-gang-light.json'));
  await store.upsertDevice(parent);
  f.mqtt.pairingStatus = () => ({ active: true, found: [parent.id] });
  await f.service.status(session.sessionId, f.principal);
  const current = f.service.sessions()[session.sessionId];
  await f.service.select(session.sessionId, f.principal, { schemaVersion: 'dinodia.v1', expectedRevision: current.revision,
    candidateRef: current.candidates[0].candidateRef, areaId: f.areaId, name: 'My switches', customerLabel: 'Lights' });
  const completed = await f.service.complete(session.sessionId, f.principal, 'install');
  assert.equal(completed.status, 'completed');
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listManagedDevices().length, 2);
  assert.ok(store.listManagedDevices().every(child => store.getPlatform().devicePolicies[child.id].ownerMembershipId === f.principal.membershipId));
  assert.equal(store.getDevice(parent.id).areaId, null, 'an older binary cannot expose broad parent authority');
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});

function interruptedZigbeeCleanup(f, { ieee = "0xf044d3fffe1242f6" } = {}) {
  const sessionId = uuid();
  const candidate = normalizeZigbeeDevice({ friendly_name: ieee, ieee_address: ieee, interview_completed: true,
    definition: { vendor: "SONOFF", model: "TRVZB", exposes: [{ type: "numeric", name: "occupied_heating_setpoint", access: 7 }] } });
  const session = {
    sessionId, protocol: "zigbee", operationKind: "PAIR_NEW", actorType: "TENANT", requesterAccountId: f.principal.sub,
    requesterSessionId: f.principal.sid, ownerMembershipId: f.principal.membershipId, homeId: f.homeId, hubInstallationId: f.hubInstallId,
    identityGeneration: 7, status: "cancelled_cleanup_pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: 2, candidates: [{ candidateRef: uuid(), deviceId: candidate.id,
      identityHash: crypto.createHash("sha256").update(ieee).digest("hex"), name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB" }],
    baselineDeviceIds: [], baselineIdentityHashes: [], cleanup: { state: "PENDING", pendingIds: [candidate.id], attempts: 1 }, events: [],
  };
  return { session, candidate };
}

test("fresh exact Zigbee inventory recovers an interrupted candidate for review and releases the stale radio lock", async (t) => {
  const f = fixture(); t.after(f.close);
  const { session, candidate } = interruptedZigbeeCleanup(f);
  await f.store.saveSecurity({ nativeCommissioningSessions: { [session.sessionId]: session } });
  f.mqtt.pairingStatus = () => ({ active: false, found: [] });
  f.mqtt.deviceInventorySnapshot = () => ({ complete: true, current: true, observedAt: new Date().toISOString(), devices: [candidate,
    { ...candidate, id: "zigbee:unrelated", protocolIdentity: { ieeeAddress: "0x00124b0000009999" }, metadata: { ieee_address: "0x00124b0000009999" } }] });

  await f.service.reconcileExpired();

  const preserved = f.store.getDevice(candidate.id);
  assert.ok(preserved, "the physically present device must be restored to the local review registry");
  assert.equal(preserved.protocol, "zigbee");
  assert.equal(preserved.setup.status, "needs_setup");
  assert.equal(preserved.metadata.model, "TRVZB");
  assert.ok(Object.keys(preserved.entities).length > 0, "dynamic Zigbee exposes must survive recovery");
  assert.equal(f.store.getDevice("zigbee:unrelated"), null, "inventory recovery must be exact-candidate only");
  assert.equal(f.radioEffects.zigbeeRemove, 0, "recovery must never remove or reset the paired device");
  assert.equal(f.service.sessions()[session.sessionId].cleanup.state, "PRESERVED_FOR_REVIEW");
  assert.deepEqual(f.service.sessions()[session.sessionId].cleanup.pendingIds, []);
  assert.equal(f.service.sessions()[session.sessionId].status, "cancelled");
  assert.equal(f.service.isQuarantinedDevice(candidate.id), true, "unregistered device stays private until canonical property registration");
  await f.store.savePlatform({ devicePolicies: { [candidate.id]: { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED" } } });
  assert.equal(f.service.isQuarantinedDevice(candidate.id), false, "the preserved candidate becomes visible only after current canonical property ownership exists");

  const next = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-after-recovered-cleanup-01");
  assert.equal(next.status, "searching");
});

test("stale Zigbee inventory cannot clear an interrupted cleanup lock", async (t) => {
  const f = fixture(); t.after(f.close);
  const { session, candidate } = interruptedZigbeeCleanup(f);
  await f.store.saveSecurity({ nativeCommissioningSessions: { [session.sessionId]: session } });
  f.mqtt.pairingStatus = () => ({ active: false, found: [] });
  f.mqtt.deviceInventorySnapshot = () => ({ complete: true, current: false, observedAt: new Date().toISOString(), devices: [] });

  await f.service.reconcileExpired();

  assert.equal(f.store.getDevice(candidate.id), null);
  assert.equal(f.service.sessions()[session.sessionId].cleanup.pendingIds.includes(candidate.id), true);
  assert.equal(f.radioEffects.zigbeeRemove, 0, "stale inventory must not trigger a destructive cleanup attempt");
  await assert.rejects(f.service.start(f.principal, { protocol: "zigbee" }, "commission-stale-inventory-block-01"),
    { code: "commissioning_radio_busy", reason: "radio_cleanup_pending" });
});

test("a fresh complete inventory confirms an exact pending Zigbee candidate is absent without radio removal", async (t) => {
  const f = fixture(); t.after(f.close);
  const { session, candidate } = interruptedZigbeeCleanup(f);
  await f.store.saveSecurity({ nativeCommissioningSessions: { [session.sessionId]: session } });
  f.mqtt.pairingStatus = () => ({ active: false, found: [] });
  f.mqtt.deviceInventorySnapshot = () => ({ complete: true, current: true, observedAt: new Date().toISOString(), devices: [] });

  await f.service.reconcileExpired();

  assert.equal(f.store.getDevice(candidate.id), null);
  assert.equal(f.service.sessions()[session.sessionId].cleanup.state, "COMPLETE");
  assert.deepEqual(f.service.sessions()[session.sessionId].cleanup.pendingIds, []);
  assert.equal(f.radioEffects.zigbeeRemove, 0, "authoritative absence needs no removal command");
  const next = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-after-confirmed-absence-01");
  assert.equal(next.status, "searching");
});

test("natural expiry preserves an interviewed assigned Zigbee candidate for explicit permanent registration", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const pairing = await f.service.start(staff, { protocol: "zigbee" }, "assigned-expiry-review-0001");
  const device = { id: "zigbee:expired-sonoff-trvzb", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "SONOFF TRVZB", name: "SONOFF TRVZB", areaId: "os-area-1",
    protocolIdentity: { ieeeAddress: "0x00124b000000e001" }, setup: { status: "needs_setup" },
    entities: { climate: { id: "climate-expired-trvzb", name: "Heating", domain: "climate", state: "heat",
      capability: { category: "control", semanticRole: "target_temperature", readable: true, writable: true, kind: "number", bindings: [{ serviceId: "climate.set_temperature" }] } } },
    metadata: { manufacturer: "SONOFF", model: "TRVZB", deviceType: "radiator" } };
  await f.store.upsertDevice(device);
  f.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(pairing.sessionId, staff);
  const expired = f.service.sessions()[pairing.sessionId];
  expired.expiresAt = new Date(Date.now() - 1).toISOString();
  await f.service.save(expired);
  f.mqtt.pairingStatus = () => ({ active: false, found: [] });

  await f.service.reconcileExpired();

  assert.ok(f.store.getDevice(device.id), "natural timeout must retain the exact interviewed local candidate");
  assert.equal(f.service.sessions()[pairing.sessionId].cleanup.state, "PRESERVED_FOR_REVIEW");
  assert.equal(f.radioEffects.zigbeeRemove, 0, "expiry is not permission to remove a device that already joined");
  const previousService = f.service;
  await previousService.close();
  const restartedService = new NativeCommissioningService({ store: f.store, mqtt: f.mqtt, matter: f.matter, pairing: previousService.pairing,
    vault: previousService.vault, commissioningCapabilities: previousService.commissioningCapabilities, clock: () => Date.now(), logger: { warn() {} } });
  t.after(() => restartedService.close());
  await restartedService.recover();
  f.service = restartedService;
  const listed = await f.service.listAdoptableDevices(staff);
  assert.equal(listed.devices.length, 1, "a fresh current assigned handoff can recover the expired candidate");
  assert.equal(listed.devices[0].model, "TRVZB");
  await f.store.upsertDevice({ ...device, protocolIdentity: { ieeeAddress: "0x00124b000000ffff" } });
  await assert.rejects(f.service.start(staff, { protocol: "zigbee", operationKind: "REGISTER_EXISTING", candidateRef: listed.devices[0].candidateRef }, "assigned-expiry-register-0001"),
    { code: "commissioning_revision_conflict" }, "a changed protocol identity cannot consume stale recovery provenance");
  await f.store.upsertDevice(device);
  const refreshed = await f.service.listAdoptableDevices(staff);
  const registration = await f.service.start(staff, { protocol: "zigbee", operationKind: "REGISTER_EXISTING", candidateRef: refreshed.devices[0].candidateRef }, "assigned-expiry-register-0002");
  assert.equal(registration.status, "reviewing_existing");
  const selected = await f.service.select(registration.sessionId, staff, { schemaVersion: "dinodia.v1", expectedRevision: registration.revision,
    candidateRef: refreshed.devices[0].candidateRef, areaId: f.areaId, name: "Room 1 Radiator", customerLabel: "Radiator" });
  assert.equal(selected.status, "selected");
  const completed = await f.service.complete(registration.sessionId, staff, "install");
  assert.equal(completed.status, "completed");
  assert.equal(f.store.getDevice(device.id).protocolIdentity.ieeeAddress, "0x00124b000000e001");
  assert.equal(f.store.getPlatform().devicePolicies[device.id].managementClass, "PROPERTY_DEVICE");
  assert.equal(f.store.getPlatform().devicePolicies[device.id].installationRequestId, staff.requestId);
  assert.equal(f.radioEffects.zigbeeStart, 1, "recovery uses registration only and never opens a second join");
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});

test("assigned Zigbee status expires the exact empty session when its radio join window has ended", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const started = await f.service.start(staff, { protocol: "zigbee" }, "assigned-closed-window-empty-01");
  let radio = { active: true, permitJoinOpen: false, permitJoinExpiresAt: new Date(Date.now() - 1).toISOString(), found: [] };
  f.mqtt.pairingStatus = () => radio;
  f.mqtt.stopPairing = async () => { f.radioEffects.zigbeeStop += 1; radio = { ...radio, active: false }; return radio; };

  const result = await f.service.status(started.sessionId, staff);
  assert.equal(result.status, "expired", "an empty exact assigned attempt must not keep blocking a later user-initiated scan");
  assert.equal(result.cleanup.pendingCount, 0);
  assert.equal(f.radioEffects.zigbeeStop, 1, "the OS confirms the join window is closed before freeing this session");
  const next = await f.service.start(staff, { protocol: "zigbee" }, "assigned-closed-window-retry-02");
  assert.equal(next.status, "searching");
  assert.equal(f.radioEffects.zigbeeStart, 2);
});

test("a fresh assigned search reconciles only the same work item's closed empty Zigbee session", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const old = await f.service.start(staff, { protocol: "zigbee" }, "assigned-old-empty-search-0001");
  let radio = { active: true, permitJoinOpen: false, permitJoinExpiresAt: new Date(Date.now() - 1).toISOString(), found: [] };
  f.mqtt.pairingStatus = () => radio;
  f.mqtt.stopPairing = async () => { f.radioEffects.zigbeeStop += 1; radio = { ...radio, active: false }; return radio; };

  const next = await f.service.start(staff, { protocol: "zigbee" }, "assigned-new-empty-search-0002");
  assert.equal(f.service.sessions()[old.sessionId].status, "expired");
  assert.equal(next.status, "searching");
  assert.equal(f.radioEffects.zigbeeStart, 2);
  assert.equal(f.radioEffects.zigbeeStop, 1);
});

test("assigned Zigbee status keeps a discovered candidate reviewable after the radio join window closes", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const started = await f.service.start(staff, { protocol: "zigbee" }, "assigned-closed-window-candidate-01");
  const device = normalizeZigbeeDevice({ friendly_name: "0x00124b000000e111", ieee_address: "0x00124b000000e111", interview_completed: true,
    definition: { vendor: "SONOFF", model: "TRVZB", exposes: [{ type: "numeric", name: "occupied_heating_setpoint", access: 7 }] } });
  await f.store.upsertDevice(device);
  f.mqtt.pairingStatus = () => ({ active: true, permitJoinOpen: false, permitJoinExpiresAt: new Date(Date.now() - 1).toISOString(), found: [device.id] });

  const result = await f.service.status(started.sessionId, staff);
  assert.equal(result.status, "searching", "a discovered device stays attached to its original session for review");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].model, "TRVZB");
  assert.equal(f.radioEffects.zigbeeStop, 0, "a candidate-bearing session is not silently expired or cleaned up");
});

test("explicit cancellation of a new Zigbee pairing still removes its exact unregistered candidate", async (t) => {
  const f = fixture(); t.after(f.close);
  const pairing = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-explicit-cancel-01");
  const device = { id: "zigbee:explicit-cancel-candidate", protocol: "zigbee", available: true, interviewStatus: "successful",
    protocolIdentity: { ieeeAddress: "0x00124b000000e002" }, setup: { status: "needs_setup" }, entities: {}, metadata: { model: "TRVZB" } };
  await f.store.upsertDevice(device);
  f.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(pairing.sessionId, f.principal);

  await f.service.cancel(pairing.sessionId, f.principal);

  assert.equal(f.store.getDevice(device.id), null, "explicit cancellation retains the established cleanup behavior");
  assert.equal(f.radioEffects.zigbeeRemove, 1);
});

test("natural expiry keeps the radio lock and does not offer registration until the Zigbee join is confirmed closed", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const pairing = await f.service.start(staff, { protocol: "zigbee" }, "assigned-expiry-radio-hold-01");
  const device = { id: "zigbee:expiry-radio-hold", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "SONOFF TRVZB", protocolIdentity: { ieeeAddress: "0x00124b000000e003" }, setup: { status: "needs_setup" },
    entities: { climate: { capability: { category: "control", readable: true, writable: true } } }, metadata: { manufacturer: "SONOFF", model: "TRVZB" } };
  await f.store.upsertDevice(device);
  f.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(pairing.sessionId, staff);
  const expired = f.service.sessions()[pairing.sessionId];
  expired.expiresAt = new Date(Date.now() - 1).toISOString();
  await f.service.save(expired);
  f.mqtt.stopPairing = async () => { f.radioEffects.zigbeeStop += 1; return { active: true }; };

  await f.service.reconcileExpired();

  assert.equal(f.service.sessions()[pairing.sessionId].expiryReviewPending, true);
  assert.equal(f.service.sessions()[pairing.sessionId].cleanup.state, "AWAITING_RADIO_SETTLEMENT");
  assert.equal(f.store.getDevice(device.id)?.protocol, "zigbee");
  assert.equal(f.radioEffects.zigbeeRemove, 0);
  assert.equal((await f.service.listAdoptableDevices(staff)).devices.length, 0, "do not expose it as registerable while the join window may still be open");
  await assert.rejects(f.service.start(staff, { protocol: "matter" }, "assigned-expiry-radio-lock-02"), { code: "commissioning_radio_busy" });

  f.mqtt.pairingStatus = () => ({ active: false, found: [] });
  await f.service.reconcileExpired();

  assert.equal(f.service.sessions()[pairing.sessionId].expiryReviewPending, false);
  assert.equal(f.service.sessions()[pairing.sessionId].cleanup.state, "PRESERVED_FOR_REVIEW");
  assert.equal(f.store.getDevice(device.id)?.protocol, "zigbee");
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});

test("a restart-interrupted empty Zigbee session does not block a new assigned Matter setup", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 2,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const interrupted = { sessionId: uuid(), protocol: "zigbee", operationKind: "PAIR_NEW", actorType: "STAFF_INSTALLER",
    employeeId: uuid(), employeeSessionId: uuid(), operatorHandoffId: uuid(), operatorJti: uuid(), workItemId: uuid(),
    requestId: uuid(), homeId: f.homeId, hubInstallationId: f.hubInstallId, status: "interrupted",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), radioOperationInFlight: false, radioOperationUncertain: false,
    candidates: [], cleanup: { state: "NONE", pendingIds: [], attempts: 0 }, events: [] };
  await f.store.saveSecurity({ nativeCommissioningSessions: { [interrupted.sessionId]: interrupted } });

  const next = await f.service.start(staff, { protocol: "matter" }, "commission-after-empty-restart-01");

  assert.equal(next.protocol, "matter");
  assert.equal(next.status, "awaiting_payload");
  assert.equal(f.radioEffects.matterCommission, 0, "starting Matter setup must not commission before setup code is submitted");
  assert.equal(f.radioEffects.zigbeeRemove, 0, "recovery must not remove the previously paired Zigbee device");
});

test("a restart-interrupted uncertain radio write continues to block another operation", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 2,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const interrupted = { sessionId: uuid(), protocol: "matter", operationKind: "PAIR_NEW", actorType: "STAFF_INSTALLER",
    employeeId: uuid(), employeeSessionId: uuid(), operatorHandoffId: uuid(), operatorJti: uuid(), workItemId: uuid(),
    requestId: uuid(), homeId: f.homeId, hubInstallationId: f.hubInstallId, status: "interrupted",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), radioOperationInFlight: false, radioOperationUncertain: true,
    candidates: [], cleanup: { state: "REQUIRES_RADIO_RECONCILIATION", pendingIds: [], attempts: 0 }, events: [] };
  await f.store.saveSecurity({ nativeCommissioningSessions: { [interrupted.sessionId]: interrupted } });

  await assert.rejects(f.service.start(staff, { protocol: "zigbee" }, "commission-after-uncertain-restart-01"),
    { code: "commissioning_radio_busy", reason: "radio_operation_active" });
  assert.equal(f.radioEffects.zigbeeStart, 0, "uncertain radio work must block a second physical join");
  assert.equal(f.platformRequests.length, 0, "do not create a competing Platform session");
});

test("an adapter-reported live Zigbee join blocks Matter even after the saved session was interrupted", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 2,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  f.mqtt.pairingStatus = () => ({ active: true, found: [] });

  await assert.rejects(f.service.start(staff, { protocol: "matter" }, "commission-live-zigbee-blocks-matter-01"),
    { code: "commissioning_radio_busy", reason: "zigbee_join_window_active" });
  assert.equal(f.radioEffects.matterCommission, 0);
  assert.equal(f.platformRequests.length, 0, "do not create a competing Platform session");
});

test("a lost Zigbee removal acknowledgement is reconciled from current inventory without repeating a radio removal", async (t) => {
  const f = fixture(); t.after(f.close);
  const { session, candidate } = interruptedZigbeeCleanup(f);
  await f.store.upsertDevice({ ...candidate, protocolIdentity: { ieeeAddress: candidate.metadata.ieee_address }, setup: { status: "needs_setup" } });
  await f.store.saveSecurity({ nativeCommissioningSessions: { [session.sessionId]: session } });
  f.mqtt.pairingStatus = () => ({ active: false, found: [] });
  f.mqtt.deviceInventorySnapshot = () => ({ complete: true, current: true, observedAt: new Date().toISOString(), devices: [] });

  await f.service.reconcileExpired();

  assert.equal(f.store.getDevice(candidate.id), null, "the stale local candidate is retired only after current inventory confirms absence");
  assert.equal(f.service.sessions()[session.sessionId].cleanup.state, "COMPLETE");
  assert.equal(f.radioEffects.zigbeeRemove, 0, "do not retry a physical remove after the live adapter already reports absence");
});

test("a mismatched Zigbee identity in inventory is not adopted and cannot release the pending cleanup lock", async (t) => {
  const f = fixture(); t.after(f.close);
  const { session, candidate } = interruptedZigbeeCleanup(f);
  await f.store.saveSecurity({ nativeCommissioningSessions: { [session.sessionId]: session } });
  f.mqtt.pairingStatus = () => ({ active: false, found: [] });
  f.mqtt.deviceInventorySnapshot = () => ({ complete: true, current: true, observedAt: new Date().toISOString(), devices: [{
    ...candidate, protocolIdentity: { ieeeAddress: "0x00124b0000009999" }, metadata: { ...candidate.metadata, ieee_address: "0x00124b0000009999" },
  }] });

  await f.service.reconcileExpired();

  assert.equal(f.store.getDevice(candidate.id), null);
  assert.equal(f.service.sessions()[session.sessionId].cleanup.pendingIds.includes(candidate.id), true);
  assert.equal(f.radioEffects.zigbeeRemove, 0);
  await assert.rejects(f.service.start(f.principal, { protocol: "zigbee" }, "commission-mismatched-inventory-block-01"), { code: "commissioning_radio_busy" });
});

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
  assert.deepEqual(f.store.getDevice(device.id).labelIds, [], "free-form customer labels do not invent a fixed OS category");
  assert.deepEqual(f.store.getDevice(device.id).labels, []);
  const finalize = f.platformRequests.find((row) => row.action === "finalize");
  assert.equal(finalize.device.customerLabel, "Desk lamp");
  assert.equal(finalize.device.name, null);
});

test("a changed radio descriptor blocks registration until staff explicitly re-reviews the same candidate", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const session = await f.service.start(staff, { protocol: "zigbee" }, "assigned-descriptor-review-0001");
  const device = { id: "zigbee:descriptor-race-trv", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "SONOFF TRVZB", name: "SONOFF TRVZB", protocolIdentity: { ieeeAddress: "0x00124b0000000301" },
    setup: { status: "ready" }, entities: { climate: { id: "climate-trv", name: "Target temperature", domain: "climate", state: "heat",
      capability: { category: "control", controlId: "target-temperature", semanticRole: "target_temperature", primary: true, readable: true, writable: true,
        kind: "number", bindings: [{ serviceId: "climate.set_temperature" }] } } },
    metadata: { manufacturer: "SONOFF", model: "TRVZB", deviceType: "radiator" } };
  await f.store.upsertDevice(device);
  f.service.mqtt.pairingStatus = () => ({ active: true, found: [device.id] });
  await f.service.status(session.sessionId, staff);
  const candidateRef = f.service.sessions()[session.sessionId].candidates[0].candidateRef;
  const selected = await f.service.select(session.sessionId, staff, { schemaVersion: "dinodia.v1", expectedRevision: f.service.sessions()[session.sessionId].revision,
    candidateRef, areaId: f.areaId, name: "Room 1 Radiator", customerLabel: "Radiator" });
  assert.equal(selected.status, "selected");

  await f.store.upsertDevice({ ...device, entities: { ...device.entities, mode: { id: "mode-trv", name: "Operating mode", domain: "select", state: "heat",
    capability: { category: "control", controlId: "operating-mode", semanticRole: "operating_mode", primary: false, readable: true, writable: true,
      kind: "option", bindings: [{ serviceId: "climate.set_hvac_mode" }] } } } });
  await assert.rejects(f.service.complete(session.sessionId, staff, "install"), (error) => {
    assert.equal(error.code, "commissioning_revision_conflict");
    assert.equal(error.reason, "device_descriptor_changed_after_review");
    return true;
  });
  assert.equal(f.platformRequests.some((row) => row.action === "finalize"), false, "no canonical record is created from an unreviewed changed descriptor");
  assert.equal(f.store.getPlatform().devicePolicies?.[device.id], undefined);
  assert.equal(f.store.getDevice(device.id).protocolIdentity.ieeeAddress, "0x00124b0000000301");
  assert.equal(f.radioEffects.zigbeeRemove, 0, "descriptor drift never removes the already-joined device");

  const refreshed = await f.service.status(session.sessionId, staff);
  const reviewedAgain = await f.service.select(session.sessionId, staff, { schemaVersion: "dinodia.v1", expectedRevision: refreshed.revision,
    candidateRef, areaId: f.areaId, name: "Room 1 Radiator", customerLabel: "Radiator" });
  assert.equal(reviewedAgain.status, "selected");
  const completed = await f.service.complete(session.sessionId, staff, "install");
  assert.equal(completed.status, "completed");
  assert.equal(f.store.getPlatform().devicePolicies[device.id].managementClass, "PROPERTY_DEVICE");
  assert.equal(f.store.getPlatform().devicePolicies[device.id].installationRequestId, staff.requestId);
  assert.equal(f.radioEffects.zigbeeRemove, 0);
});

test("unsupported newly joined radios remain visible and can be retained without invented readings or controls", async (t) => {
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
  await assert.rejects(f.service.complete(session.sessionId, f.principal, "install"), (error) => {
    assert.equal(error.code, "commissioning_revision_conflict");
    assert.equal(error.reason, "disposition_not_compatible_with_device");
    return true;
  });
  const retained = await f.service.complete(session.sessionId, f.principal, "retain_unsupported");
  assert.equal(retained.status, "completed");
  assert.equal(retained.finalDisposition, "retain_unsupported");
  assert.equal(f.store.getDevice(device.id).setup.unsupported, true);
  assert.equal(f.store.getPlatform().devicePolicies[device.id].lifecycle, "VIEW_ONLY");
  const finalize = f.platformRequests.find((row) => row.action === "finalize");
  assert.equal(finalize.device.catalogueStatus, "unsupported");
  assert.equal(finalize.device.usefulReadings, false);
  assert.equal(finalize.device.capabilitySummary.controls.length, 0);
});

test("a model approval marker is not required when the protocol is enabled and the enrolled controller is ready", async (t) => {
  const f = fixture({ commissioningCapabilities: {
    nativeZigbeeCommissioningV1: true,
    nativeMatterCommissioningV1: true,
  } }); t.after(f.close);
  const started = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-no-model-gate-0001");
  assert.equal(started.status, "searching");
  assert.equal(f.platformRequests.filter((row) => row.action === "create").length, 1);
  assert.equal(f.platformRequests.filter((row) => row.action === "transition").length, 1);
});

test("fresh readable but safely nonwritable devices can be retained view-only without widening controls", async (t) => {
  const f = fixture(); t.after(f.close);
  const session = await f.service.start(f.principal, { protocol: "zigbee" }, "commission-view-only-0001");
  const observedAt = new Date().toISOString();
  const device = { id: "zigbee:read-only-device", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Read-only sensor", name: "Read-only sensor", protocolIdentity: { ieeeAddress: "0x00124b0000000088" },
    setup: { status: "ready" }, entities: { sensor: { id: "sensor-main", name: "Power state", domain: "light", state: false, sourceObservedAt: observedAt,
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
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
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

test("assigned staff can review and register one already-paired unregistered property device without radio or removal effects", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const existing = { id: "zigbee:existing-radiator", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Radiator", name: "Radiator", areaId: "os-area-1", protocolIdentity: { ieeeAddress: "0x00124b0000000201" },
    setup: { status: "ready" }, entities: { climate: { id: "climate-radiator", name: "Heating", domain: "climate", state: "heat",
      capability: { category: "control", controlId: "target-temperature", semanticRole: "target_temperature", primary: true, readable: true, writable: true,
        kind: "number", bindings: [{ serviceId: "climate.set_temperature" }] } } }, metadata: { model: "TRV", deviceType: "radiator", manufacturer: "Test" } };
  const privateDevice = { ...existing, id: "zigbee:tenant-radiator", tenantOwnerMembershipId: uuid(), metadata: { ...existing.metadata, managementClass: "tenant_device" },
    protocolIdentity: { ieeeAddress: "0x00124b0000000202" } };
  await f.store.upsertDevice(existing);
  await f.store.upsertDevice(privateDevice);
  await f.store.addEvent({ type: "device_setup_completed", deviceId: existing.id, protocol: "zigbee", areaId: "os-area-1" });
  await f.store.addEvent({ type: "device_setup_completed", deviceId: privateDevice.id, protocol: "zigbee", areaId: "os-area-1" });
  const formerlyTenant = { ...existing, id: "zigbee:former-tenant-radiator", protocolIdentity: { ieeeAddress: "0x00124b0000000203" } };
  await f.store.upsertDevice(formerlyTenant);
  await f.store.addEvent({ type: "device_setup_completed", deviceId: formerlyTenant.id, protocol: "zigbee", areaId: "os-area-1" });
  await f.store.addEvent({ type: "tenant_device_commissioned", deviceId: formerlyTenant.id, areaId: "os-area-1" });

  const listed = await f.service.listAdoptableDevices(staff);
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].protocol, "zigbee");
  assert.equal(listed.devices[0].name, "Radiator");
  assert.equal(JSON.stringify(listed).includes(existing.id), false);
  assert.equal(JSON.stringify(listed).includes("0x00124b0000000201"), false);
  assert.equal(JSON.stringify(listed).includes(privateDevice.id), false);
  assert.equal(JSON.stringify(listed).includes(formerlyTenant.id), false, "a retained tenant commissioning receipt is a hard exclusion if a later projection loses its local tenant marker");
  await assert.rejects(f.service.listAdoptableDevices(f.principal), { code: "commissioning_authority_denied" });
  const alternateCandidateRef = (await f.service.listAdoptableDevices(staff)).devices[0].candidateRef;
  f.service.commissioningCapabilities.nativeStaffZigbeeCommissioningV1 = false;

  const beforeCreate = f.platformRequests.length;
  const session = await f.service.start(staff, { protocol: "zigbee", operationKind: "REGISTER_EXISTING", candidateRef: listed.devices[0].candidateRef }, "adopt-radiator-existing-0001");
  const exactRetry = await f.service.start(staff, { protocol: "zigbee", operationKind: "REGISTER_EXISTING", candidateRef: listed.devices[0].candidateRef }, "adopt-radiator-existing-0001");
  assert.equal(exactRetry.sessionId, session.sessionId, "an exact retry reconciles the original existing-device operation");
  await assert.rejects(f.service.start(staff, { protocol: "zigbee", operationKind: "REGISTER_EXISTING", candidateRef: alternateCandidateRef }, "adopt-radiator-existing-0001"),
    { code: "commissioning_revision_conflict" }, "reusing an operation key for a different candidate is rejected");
  assert.equal(session.operationKind, "REGISTER_EXISTING");
  assert.equal(session.status, "reviewing_existing");
  assert.equal(f.platformRequests.slice(beforeCreate).filter((row) => row.action === "create").length, 1);
  assert.equal(f.service.mqtt.pairingStatus().active, false);
  assert.deepEqual(f.radioEffects, { zigbeeStart: 0, zigbeeStop: 0, zigbeeRemove: 0, matterCommission: 0, matterRemove: 0 });
  await f.service.markInterrupted(f.service.sessions()[session.sessionId], "test_restart");
  const resumed = await f.service.resume(session.sessionId, staff);
  assert.equal(resumed.status, "reviewing_existing", "an interrupted adoption resumes its review without opening radio pairing");
  assert.deepEqual(f.radioEffects, { zigbeeStart: 0, zigbeeStop: 0, zigbeeRemove: 0, matterCommission: 0, matterRemove: 0 });

  const current = f.service.sessions()[session.sessionId];
  const selected = await f.service.select(session.sessionId, staff, { schemaVersion: "dinodia.v1", expectedRevision: current.revision,
    candidateRef: current.candidates[0].candidateRef, areaId: f.areaId, name: "Room 1 Radiator", customerLabel: "Radiator", analyticsCategory: "RADIATOR" });
  assert.equal(selected.status, "selected");
  const result = await f.service.complete(session.sessionId, staff, "install");
  assert.equal(result.status, "completed");
  assert.match(result.finalDeviceId, /^[0-9a-f-]{36}$/i);
  assert.equal(f.store.getDevice(existing.id).protocolIdentity.ieeeAddress, "0x00124b0000000201");
  assert.equal(f.store.getDevice(existing.id).setup.status, "ready");
  assert.deepEqual(f.store.getDevice(existing.id).labelIds, ["radiator"], "a selected fixed device label is persisted to the canonical local device");
  assert.deepEqual(f.store.getDevice(existing.id).labels, ["radiator"], "dashboard and integrations receive the canonical label projection");
  assert.equal(f.store.getPlatform().devicePolicies[existing.id].managementClass, "PROPERTY_DEVICE");
  assert.equal(f.store.getPlatform().devicePolicies[existing.id].customerLabel, "Radiator");
  assert.equal(f.store.getPlatform().devicePolicies[existing.id].analyticsCategory, "RADIATOR");
  assert.equal(f.store.getPlatform().devicePolicies[existing.id].installationRequestId, staff.requestId);
  assert.equal(f.store.getDevice(privateDevice.id).metadata.managementClass, "tenant_device");
  assert.equal(f.platformRequests.filter((row) => row.action === "finalize").at(-1).operationKind, "REGISTER_EXISTING");
  assert.equal(f.platformRequests.filter((row) => row.action === "finalize").at(-1).device.osDeviceId, existing.id);
  assert.equal(f.platformRequests.filter((row) => row.action === "finalize").at(-1).device.analyticsCategory, "RADIATOR");
  assert.deepEqual(f.radioEffects, { zigbeeStart: 0, zigbeeStop: 0, zigbeeRemove: 0, matterCommission: 0, matterRemove: 0 });
  const afterRegistration = await f.service.listAdoptableDevices(staff);
  assert.equal(afterRegistration.devices.length, 0, "a canonical device is no longer shown as awaiting registration");
  assert.equal(afterRegistration.completedDevices.length, 1, "completed results are reconstructed from the current request's canonical policy after refresh");
  assert.equal(afterRegistration.completedDevices[0].areaName, "Living Room");
  assert.equal(afterRegistration.completedDevices[0].sync, "pending", "locally persisted canonical policy is not mislabeled as synced before cloud configuration confirms it");
});

test("analytics category updates require current full-Home authority bound to this signed hub and permanent policy", async (t) => {
  const f = fixture(); t.after(f.close);
  const platform = f.store.getPlatform();
  // Production Store exposes the signed configuration revision as
  // cloudRevision (not `revision`). Keep this fixture shaped like that owner.
  platform.cloudRevision = 12;
  platform.devicePolicies = { "permanent-radiator": { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED",
    analyticsCategory: "NONE", inventoryRevision: 3, canonicalAreaIds: [f.areaId] } };
  const requests = [];
  f.service.pairing.requestWithHubIdentity = async (path, body) => {
    requests.push({ path, body });
    return { ok: true, osDeviceId: body.osDeviceId, analyticsCategory: body.analyticsCategory, managementRevision: 13, inventoryRevision: 4, configurationSync: "PENDING" };
  };
  const staff = { principalType: "operator", scope: ["os:admin"], sub: uuid(), sid: uuid(), jti: "J".repeat(32), handoffId: uuid(),
    workflow: uuid(), employeeSessionId: uuid(), workRevision: 5, homeId: f.homeId, hubId: "DIN-HUB-1", identityGeneration: 7,
    verifiedHubInstallationId: f.hubInstallId };
  const input = { osDeviceId: "permanent-radiator", analyticsCategory: "RADIATOR", expectedAnalyticsCategory: "NONE",
    expectedManagementRevision: 12, expectedInventoryRevision: 3, operationId: uuid() };
  await assert.rejects(f.service.updateAnalyticsCategory({ ...staff, verifiedHubInstallationId: uuid() }, input), { code: "commissioning_authority_denied" });
  assert.equal(requests.length, 0, "a different or stale Hub installation must not reach the Platform owner");
  const result = await f.service.updateAnalyticsCategory(staff, input);
  assert.deepEqual({ analyticsCategory: result.analyticsCategory, managementRevision: result.managementRevision, configurationPending: result.signedConfigurationPending },
    { analyticsCategory: "RADIATOR", managementRevision: 13, configurationPending: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/hub-agent/v2/permanent-device-analytics-category");
  assert.equal(requests[0].body.accessScope, "os:admin");
  assert.equal(requests[0].body.expectedInventoryRevision, 3);
  assert.equal(platform.devicePolicies["permanent-radiator"].analyticsCategory, "NONE", "the dashboard waits for a newly signed cloud configuration instead of locally pretending the change is synced");
  platform.cloudRevision = 13;
  platform.devicePolicies["permanent-radiator"].analyticsCategory = "RADIATOR";
  platform.devicePolicies["permanent-radiator"].inventoryRevision = 4;
  const exactAfterConfigRefresh = await f.service.updateAnalyticsCategory(staff, input);
  assert.equal(exactAfterConfigRefresh.analyticsCategory, "RADIATOR", "an uncertain response can be exactly reconciled even after the new signed configuration reaches the hub");
  assert.equal(exactAfterConfigRefresh.signedConfigurationPending, false, "the UI clears pending only after the exact category is confirmed in the refreshed signed policy");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.expectedAnalyticsCategory, "NONE", "retry preserves its original baseline rather than reinterpreting the operation against the refreshed configuration");
  assert.equal(requests[1].body.expectedInventoryRevision, 3);
  assert.equal(requests[1].body.operationId, input.operationId);
  platform.devicePolicies["tenant-device"] = { managementClass: "TENANT_DEVICE", ownerMembershipId: uuid(), lifecycle: "INSTALLED", analyticsCategory: "NONE", canonicalAreaIds: [f.areaId] };
  await assert.rejects(f.service.updateAnalyticsCategory(staff, { ...input, osDeviceId: "tenant-device", operationId: uuid() }), { code: "commissioning_authority_denied" });
  assert.equal(requests.length, 2, "tenant-device analytics policy is never sent to the property-device update route");
});

test("an analytics-category revision conflict refreshes signed Home configuration before the dashboard rereads it", async (t) => {
  const f = fixture(); t.after(f.close);
  const platform = f.store.getPlatform();
  platform.cloudRevision = 12;
  platform.devicePolicies = { "permanent-radiator": { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED",
    analyticsCategory: "NONE", inventoryRevision: 3, canonicalAreaIds: [f.areaId] } };
  const staff = { principalType: "operator", scope: ["os:admin"], sub: uuid(), sid: uuid(), jti: "J".repeat(32), handoffId: uuid(),
    workflow: uuid(), employeeSessionId: uuid(), workRevision: 5, homeId: f.homeId, hubId: "DIN-HUB-1", identityGeneration: 7,
    verifiedHubInstallationId: f.hubInstallId };
  let refreshes = 0;
  f.service.pairing.requestWithHubIdentity = async () => {
    throw Object.assign(new Error("The Home configuration changed; refresh the dashboard before changing this category"), {
      statusCode: 409, code: "analytics_category_revision_conflict",
    });
  };
  f.service.pairing.syncNow = async () => { refreshes += 1; platform.cloudRevision = 14; };
  await assert.rejects(f.service.updateAnalyticsCategory(staff, {
    osDeviceId: "permanent-radiator", analyticsCategory: "RADIATOR", expectedAnalyticsCategory: "NONE",
    expectedManagementRevision: 12, expectedInventoryRevision: 3, operationId: uuid(),
  }), { code: "analytics_category_revision_conflict" });
  assert.equal(refreshes, 1, "the stale signed snapshot is refreshed before the HTTP handler returns the conflict for a dashboard reload");
  assert.equal(platform.cloudRevision, 14);
});


test("assigned adoption validates against the live identity broker generation, not a legacy Store generation", async (t) => {
  const f = fixture(); t.after(f.close);
  // Production keeps signing identity in dinodia-identityd. The legacy
  // application Store identity is intentionally not the authority for its
  // generation and can remain zero after a healthy installation.
  f.store.getIdentity = () => ({ generation: 0, serial: "DIN-HUB-1" });
  f.service.pairing.getPublicIdentity = async () => ({ generation: 7, serial: "DIN-HUB-1" });
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  const existing = { id: "zigbee:broker-generation-radiator", protocol: "zigbee", available: true, interviewStatus: "successful",
    originalName: "Living room radiator", areaId: "os-area-1", protocolIdentity: { ieeeAddress: "0x00124b0000000201" },
    setup: { status: "ready" }, entities: { climate: { name: "Heating", capability: { category: "control", readable: true, writable: true } } },
    metadata: { manufacturer: "SONOFF", model: "TRVZB" } };
  await f.store.upsertDevice(existing);
  await f.store.addEvent({ type: "device_setup_completed", deviceId: existing.id, protocol: "zigbee", areaId: "os-area-1" });

  const result = await f.service.listAdoptableDevices(staff);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].name, "Living room radiator");

  const dashboardStaff = { ...staff, scope: ["os:admin"] };
  const dashboard = await f.service.listDashboardUnregisteredDevices(dashboardStaff);
  assert.equal(dashboard.devices.length, 1, "the full-dashboard inventory also uses the live broker identity");
  assert.equal(dashboard.devices[0].name, "Living room radiator");

  f.service.identityBrokerRequired = true;
  f.service.pairing.getPublicIdentity = async () => null;
  await assert.rejects(f.service.listAdoptableDevices(staff), { code: "commissioning_authority_denied" },
    "production fails closed instead of falling back to a stale Store identity when the broker is unavailable");
});

test("assigned full dashboard can see eligible local devices read-only without exposing identities or tenant inventory", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:admin"], sub: uuid(), sid: uuid(), jti: uuid(), handoffId: uuid(),
    homeId: f.homeId, workflow: uuid(), employeeSessionId: uuid(), workRevision: 4, hubId: "DIN-HUB-1", identityGeneration: 7 };
  const eligible = { id: "zigbee:dashboard-radiator", protocol: "zigbee", available: true, interviewStatus: "successful", originalName: "Living room radiator",
    areaId: "os-area-1", protocolIdentity: { ieeeAddress: "0x00124b0000000abc" }, setup: { status: "ready" },
    entities: { climate: { name: "Heating", capability: { category: "control", semanticRole: "target_temperature", readable: true, writable: true } } },
    metadata: { manufacturer: "SONOFF", model: "TRVZB" } };
  const privateDevice = { ...eligible, id: "zigbee:dashboard-private", tenantOwnerMembershipId: uuid(), metadata: { managementClass: "tenant_device" }, protocolIdentity: { ieeeAddress: "0x00124b0000000def" } };
  f.devices.push(eligible, privateDevice);
  f.events.push({ type: "device_setup_completed", deviceId: eligible.id, areaId: "os-area-1" }, { type: "device_setup_completed", deviceId: privateDevice.id, areaId: "os-area-1" });

  const listed = await f.service.listDashboardUnregisteredDevices(staff);
  assert.equal(listed.devices.length, 1);
  assert.deepEqual(listed.devices[0], { protocol: "zigbee", name: "Living room radiator", manufacturer: "SONOFF", model: "TRVZB", status: "not_registered",
    areaName: "Living Room", available: true, controls: [{ name: "target_temperature", readable: true, writable: true }] });
  assert.equal(JSON.stringify(listed).includes(eligible.id), false);
  assert.equal(JSON.stringify(listed).includes("0x00124b0000000abc"), false);
  assert.equal(JSON.stringify(listed).includes(privateDevice.id), false);
  await assert.rejects(f.service.listDashboardUnregisteredDevices({ ...staff, scope: ["os:permanent-installation"] }), { code: "commissioning_authority_denied" });
  await assert.rejects(f.service.listDashboardUnregisteredDevices({ ...staff, identityGeneration: 8 }), { code: "commissioning_authority_denied" });
  await assert.rejects(f.service.listDashboardUnregisteredDevices({ ...f.principal, scope: ["tenant:device-command"] }), { code: "commissioning_authority_denied" });
});

test("Matter registration identity includes both fabric and node identifiers", (t) => {
  const f = fixture(); t.after(f.close);
  const firstFabric = f.service.protocolIdentity({ protocol: "matter", protocolIdentity: { fabricId: "Fabric-A", nodeId: "42" } });
  const secondFabric = f.service.protocolIdentity({ protocol: "matter", protocolIdentity: { fabricId: "Fabric-B", nodeId: "42" } });
  assert.ok(firstFabric?.hash);
  assert.ok(secondFabric?.hash);
  assert.notEqual(firstFabric.hash, secondFabric.hash);
  assert.equal(firstFabric.identity, "fabric-a\n42");
});

test("installer commissioning rejects missing scoped-work claims before the first Platform or radio call", async (t) => {
  const f = fixture(); t.after(f.close);
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  await assert.rejects(f.service.start({ ...staff, requestId: undefined }, { protocol: "zigbee" }, "assigned-install-denied-001"), { code: "commissioning_authority_denied" });
  await assert.rejects(f.service.start({ ...staff, areaIds: [uuid()], areaOptions: [{ id: uuid(), name: "Wrong Area" }] }, { protocol: "zigbee" }, "assigned-install-denied-002"), { code: "commissioning_authority_denied" });
  assert.equal(f.platformRequests.length, 0);
  assert.equal(f.service.sessions().length || Object.keys(f.service.sessions()).length, 0);
});

test("assigned staff Area choices exclude duplicate cloud Areas with no current matching hub Area", async (t) => {
  const f = fixture(); t.after(f.close);
  const staleAreaId = uuid();
  f.store.getPlatform().areaBindings.push({ areaId: staleAreaId, hubAreaId: "removed-hub-area" });
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 1,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId, staleAreaId],
    areaOptions: [{ id: f.areaId, name: "Living Room" }, { id: staleAreaId, name: "Living Room" }], identityGeneration: 7 };

  const actor = await f.service.principal(staff);

  assert.deepEqual(actor.areaOptions, [{ id: f.areaId, name: "Living Room" }]);
  assert.deepEqual(actor.areaIds, [f.areaId]);
  assert.equal(f.service.canonicalArea(actor, f.areaId).hubAreaId, "os-area-1");
  assert.throws(() => f.service.canonicalArea({ ...actor, areaIds: [f.areaId, staleAreaId],
    areaOptions: [...actor.areaOptions, { id: staleAreaId, name: "Living Room" }] }, staleAreaId),
  { code: "commissioning_authority_denied" });
});

test("a new Zigbee candidate refreshes its model and completed interview after the initial join event", async (t) => {
  const f = fixture(); t.after(f.close);
  const deviceId = "zigbee:new-sonoff-trvzb";
  await f.store.upsertDevice({ id: deviceId, protocol: "zigbee", available: true, name: "SONOFF TRVZB",
    interviewStatus: "successful", setup: { status: "needs_setup" }, protocolIdentity: { ieeeAddress: "0x00124b0000000abc" },
    metadata: { manufacturer: "SONOFF", model: "TRVZB" }, entities: { climate: { capability: { category: "control" } } } });
  f.mqtt.pairingStatus = () => ({ active: true, found: [deviceId] });
  const session = { sessionId: uuid(), protocol: "zigbee", operationKind: "PAIR_NEW", status: "searching", revision: 1,
    candidates: [{ candidateRef: uuid(), deviceId, name: "Zigbee device", manufacturer: "", model: "", stage: "needs_setup" }],
    baselineDeviceIds: [], baselineIdentityHashes: [], events: [] };

  await f.service.refreshCandidates(session);

  const candidate = fixedSession(session).candidates[0];
  assert.equal(candidate.name, "SONOFF TRVZB");
  assert.equal(candidate.manufacturer, "SONOFF");
  assert.equal(candidate.model, "TRVZB");
  assert.equal(candidate.stage, "needs_setup", "Area/name setup remains distinct from the radio interview state");
  assert.equal(candidate.interviewStatus, "successful");
  assert.equal(JSON.stringify(candidate).includes("0x00124b0000000abc"), false, "radio identity remains private");
});

test("assigned-authority mismatch diagnostics are reason-coded and never log identifiers", async (t) => {
  const f = fixture(); t.after(f.close);
  const entries = [];
  f.service.logger = { warn: (message) => entries.push(String(message)) };
  f.service.pairing.getPublicIdentity = async () => ({ serial: "DIN-HUB-1", generation: 8 });
  const staff = { principalType: "operator", scope: ["os:permanent-installation"], sub: uuid(), sid: uuid(), jti: uuid(),
    handoffId: uuid(), homeId: f.homeId, workflow: uuid(), requestId: uuid(), employeeSessionId: uuid(), workRevision: 4,
    hubId: "DIN-HUB-1", verifiedHubInstallationId: f.hubInstallId, areaIds: [f.areaId], areaOptions: [{ id: f.areaId, name: "Living Room" }], identityGeneration: 7 };
  await assert.rejects(f.service.principal(staff), { code: "commissioning_authority_denied" });
  assert.equal(entries.length, 1);
  assert.match(entries[0], /identity_generation_mismatch/);
  for (const secret of [staff.sub, staff.sid, staff.jti, staff.handoffId, staff.homeId, staff.hubInstallId, f.areaId]) {
    assert.equal(entries[0].includes(secret), false, "diagnostic log must not reveal protected identifiers");
  }
  assert.equal(f.platformRequests.length, 0);
  assert.equal(f.radioEffects.zigbeeStart, 0);
});

test("the hub permits only one active radio commissioning session across tenant memberships", async (t) => {
  const f = fixture(); t.after(f.close);
  await f.service.start(f.principal, { protocol: "zigbee" }, "commission-key-0003");
  const other = { ...f.principal, sid: uuid(), jti: uuid(), membershipId: uuid(), accessTokenHash: crypto.randomBytes(32).toString("hex") };
  await assert.rejects(f.service.start(other, { protocol: "matter" }, "commission-key-0004"),
    { code: "commissioning_radio_busy", reason: "radio_operation_active" });
  assert.equal(f.platformRequests.filter((row) => row.action === "create").length, 1);
});

test("protocol capability must be explicitly enabled for this hub before any session or radio effect", async (t) => {
  const f = fixture({ commissioningCapabilities: { nativeZigbeeCommissioningV1: false, nativeMatterCommissioningV1: false } }); t.after(f.close);
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
