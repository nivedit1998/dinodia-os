const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Store } = require("../src/store");
const { persistStoreJson } = require("../src/durableStoreFile");
const { createBackup } = require("../src/backup");
const { SecretVault } = require("../src/secretVault");
const { allProjectedSurfaces } = require("../src/capabilities/controlSurfaceProjection");
const { serializeDevice } = require("../src/contracts/dinodiaV1");

test("store refuses corrupt existing JSON instead of silently starting empty and risking overwrite", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-corrupt-"));
  const file = path.join(directory, "dinodia.json");
  const damaged = "{\"version\":10,\"areas\":";
  await fs.writeFile(file, damaged, { mode: 0o600 });

  assert.throws(() => new Store(file), (error) => error.code === "store_data_unavailable");
  assert.equal(await fs.readFile(file, "utf8"), damaged, "failed recovery must preserve the only source file byte-for-byte");
});

test("an initialized Store with a missing file fails closed instead of initializing a blank Home", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-missing-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.saveArea({ name: "Room 1" }, "room-1");
  assert.equal(await fs.readFile(`${file}.initialized`, "utf8"), "dinodia-store-initialized-v1\n");

  await fs.unlink(file);
  assert.throws(() => new Store(file), (error) => error.code === "store_data_unavailable"
    && error.cause?.code === "store_initialized_file_missing");
  assert.equal(await fs.readFile(`${file}.initialized`, "utf8"), "dinodia-store-initialized-v1\n");
});

test("an interrupted Store/vault restore marker blocks Store activation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-restore-pending-"));
  const file = path.join(directory, "dinodia.json");
  new Store(file);
  await fs.writeFile(`${file}.restore-pending`, "dinodia-store-restore-v1\nbackup=prior.backup.json\n", { mode: 0o600 });
  assert.throws(() => new Store(file), { code: "store_restore_pending" });
  assert.equal(await fs.readFile(`${file}.restore-pending`, "utf8"), "dinodia-store-restore-v1\nbackup=prior.backup.json\n");
});

test("a corrupt enrolled Store exits with the systemd no-restart integrity status", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-startup-corrupt-"));
  await fs.writeFile(path.join(directory, "dinodia.json"), "{corrupt", { mode: 0o600 });
  const entrypoint = path.join(__dirname, "../src/server.js");
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DINODIA_DATA_DIR: directory, NODE_ENV: "development" },
  });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /startup failed: Native OS store could not be read safely/);
  const unit = await fs.readFile(path.join(__dirname, "../systemd/dinodia-os.service"), "utf8");
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
});

test("durable Store writes retain one prior valid generation and refuse symlink targets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-generation-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.upsertDevice({ id: "lamp-one", name: "Lamp one", protocol: "virtual", state: { power: "OFF" } });
  await store.upsertDevice({ id: "lamp-two", name: "Lamp two", protocol: "virtual", state: { power: "OFF" } });

  const current = JSON.parse(await fs.readFile(file, "utf8"));
  const previous = JSON.parse(await fs.readFile(`${file}.previous`, "utf8"));
  assert.ok(current.devices["lamp-two"]);
  assert.ok(current.devices["lamp-one"]);
  assert.ok(previous.devices["lamp-one"]);
  assert.equal(previous.devices["lamp-two"], undefined);
  const symlinkFile = path.join(directory, "linked-store.json");
  await fs.symlink(file, symlinkFile);
  await assert.rejects(persistStoreJson(symlinkFile, JSON.stringify({ version: 10 })), (error) => error.code === "store_file_type_invalid");
  assert.ok(JSON.parse(await fs.readFile(file, "utf8")).devices["lamp-two"]);
});

test("directory sync failure after atomic rename is reported as an uncertain committed write", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-fsync-"));
  const file = path.join(directory, "dinodia.json");
  const initial = JSON.stringify({ version: 10, generation: 1 });
  const next = JSON.stringify({ version: 10, generation: 2 });
  await persistStoreJson(file, initial);
  let directorySyncs = 0;

  await assert.rejects(persistStoreJson(file, next, {
    beforeDirectorySync: async () => {
      directorySyncs += 1;
      if (directorySyncs === 2) throw new Error("simulated directory sync failure after store rename");
    },
  }), (error) => error.code === "store_durability_uncertain" && error.committed === true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 10, generation: 2 }, "the renamed document is not misrepresented as the old generation");
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.previous`, "utf8")), { version: 10, generation: 1 }, "the prior committed generation remains available");
});

test("concurrent async Store mutations serialize across a failed commit without rolling back later state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-writer-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  const persist = store.persist.bind(store);
  let persistCalls = 0;
  store.persist = async () => {
    persistCalls += 1;
    if (persistCalls === 1) throw new Error("injected pre-commit failure");
    return persist();
  };

  let enterFirst;
  let releaseFirst;
  const entered = new Promise((resolve) => { enterFirst = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const first = store.commit(async (state) => {
    state.identity.serial = "must-roll-back";
    enterFirst();
    await blocked;
  });
  await entered;
  const second = store.commit((state) => { state.setup.recoveryTest = "committed-after-first-failed"; });
  releaseFirst();
  await assert.rejects(first, /injected pre-commit failure/);
  await second;

  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.notEqual(persisted.identity.serial, "must-roll-back");
  assert.equal(persisted.setup.recoveryTest, "committed-after-first-failed");
  assert.equal(store.snapshot().setup.recoveryTest, "committed-after-first-failed");
});

test("backup rollback recovery archives the exact pending outbox before opening a fresh stream", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-sync-recovery-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  const homeId = "11111111-1111-4111-8111-111111111111";
  const hubInstallId = "22222222-2222-4222-8222-222222222222";
  await store.savePlatform({ paired: true, homeId, hubInstallId });
  const old = store.getSyncOutbox();
  store.state.syncOutbox = {
    ...old,
    streamId: "verified-backup-stream-0001",
    acknowledgedSequence: 7,
    nextSequence: 10,
    events: [
      { id: "pending-8", sequence: 8, type: "usage.bucket", aggregateId: "bucket", occurredAt: new Date(1000).toISOString(), critical: false, payload: { revision: 2 } },
      { id: "pending-9", sequence: 9, type: "device.upsert", aggregateId: "radiator", occurredAt: new Date(2000).toISOString(), critical: true, payload: { osDeviceId: "radiator" } },
    ],
    cloudRevision: 12,
    configurationAppliedRevision: 12,
  };
  store.state.syncOutboxRecovery = {
    version: 1, backupSha256: "a".repeat(64), previousStreamId: "verified-backup-stream-0001",
    backupAcknowledgedSequence: 7, homeId, hubInstallId, preparedAt: new Date().toISOString(),
  };
  await store.persist();

  const result = await store.prepareSyncBackupRecovery({ backupSha256: "a".repeat(64) });
  const next = store.getSyncOutbox();
  const archived = JSON.parse(await fs.readFile(result.archivedOutboxPath, "utf8"));
  assert.equal(result.prepared, true);
  assert.notEqual(next.streamId, "verified-backup-stream-0001");
  assert.equal(next.acknowledgedSequence, 0);
  assert.equal(next.nextSequence, 1);
  assert.equal(next.events.length, 0);
  assert.equal(next.cloudRevision, 12);
  assert.equal(archived.outbox.events.length, 2);
  assert.equal(archived.outbox.acknowledgedSequence, 7);
  assert.equal(store.getSyncOutboxRecovery().backupSha256, "a".repeat(64));
});

test("store persists devices and automations atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-store-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "virtual", state: { power: "OFF" } });
  const automation = await store.saveAutomation({ name: "Turn on lamp", trigger: { deviceId: "sensor", field: "motion", equals: "ON" }, actions: [{ deviceId: "lamp", command: { state: { power: "ON" } } }] });
  assert.equal(automation.name, "Turn on lamp");
  const restored = new Store(file);
  assert.equal(restored.getDevice("lamp").state.power, "OFF");
  assert.equal(restored.listAutomations().length, 1);
  new SecretVault({ dataDir: directory });
  const backup = await createBackup({ dataFile: file, backupDir: path.join(directory, "backups") });
  assert.match(backup, /dinodia-.*\.json$/);
});

test("permanent-device registration commits its property policy before creating inventory sync", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-property-registration-outbox-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const homeId = "11111111-1111-4111-8111-111111111111";
  const hubInstallId = "22222222-2222-4222-8222-222222222222";
  const canonicalAreaId = "33333333-3333-4333-8333-333333333333";
  const area = await store.saveArea({ name: "Living room" }, "living-room");
  await store.savePlatform({ paired: true, homeId, hubInstallId, devicePolicies: {} });
  const device = await store.upsertDevice({ id: "zigbee:existing-radiator", name: "Living room radiator", protocol: "zigbee", areaId: area.id,
    setup: { status: "ready" }, interviewStatus: "successful", protocolIdentity: { ieeeAddress: "0x00124b0000000999" },
    entities: { heat: { id: "heat", name: "Heat", domain: "climate", capability: { category: "control", controlId: "target-temperature", semanticRole: "target_temperature", readable: true, writable: true, kind: "number", bindings: [{ serviceId: "climate.set_temperature" }] } } } },
  { devicePolicy: { managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED", canonicalAreaIds: [canonicalAreaId], platformDeviceId: "44444444-4444-4444-8444-444444444444",
    installationRequestId: "55555555-5555-4555-8555-555555555555", catalogueStatus: "ready", usefulReadings: true, descriptorRevision: 1,
    descriptorDigest: "a".repeat(64), overrideName: "Living room radiator" } });
  const policy = store.getPlatform().devicePolicies[device.id];
  const events = store.getSyncOutbox().events.filter((event) => event.aggregateId === device.id);
  assert.equal(policy.managementClass, "PROPERTY_DEVICE");
  assert.deepEqual(events.map((event) => event.type), ["device.upsert", "control.catalog.upsert"]);
  assert.equal(events[0].payload.osDeviceId, device.id);
  assert.equal(events[0].payload.areaId, area.id);
  assert.equal(events[0].payload.descriptorRevision, policy.descriptorRevision);
  assert.equal(events[0].payload.descriptorDigest, policy.descriptorDigest,
    "the device inventory projection must use the canonical commissioning descriptor digest");
  assert.equal(events[1].payload.catalogRevision, policy.descriptorRevision);
  assert.equal(events[1].payload.descriptorDigest, policy.descriptorDigest,
    "the control catalogue must be bound to the same canonical descriptor digest");
  const restored = new Store(path.join(directory, "dinodia.json"));
  assert.equal(restored.getPlatform().devicePolicies[device.id].managementClass, "PROPERTY_DEVICE");
  assert.deepEqual(restored.getSyncOutbox().events.filter((event) => event.aggregateId === device.id).map((event) => event.type), ["device.upsert", "control.catalog.upsert"]);
});

test("an explicitly rejected descriptor batch is compacted without acknowledging or losing sequence continuity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-rejected-descriptor-sync-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  try {
    const area = await store.saveArea({ name: "Room 1" }, "room-1");
    const policy = {
      managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED",
      canonicalAreaIds: ["33333333-3333-4333-8333-333333333333"], platformDeviceId: "44444444-4444-4444-8444-444444444444",
      installationRequestId: "55555555-5555-4555-8555-555555555555", catalogueStatus: "ready", usefulReadings: true,
      descriptorRevision: 1, descriptorDigest: "a".repeat(64), overrideName: "Room 1 Radiator",
    };
    await store.savePlatform({ paired: true, homeId: "11111111-1111-4111-8111-111111111111", devicePolicies: {} });
    const device = await store.upsertDevice({ id: "zigbee:room-1-radiator", name: "Room 1 Radiator", protocol: "zigbee", areaId: area.id,
      setup: { status: "ready" }, metadata: { model: "TRVZB" },
      entities: { heat: { id: "heat", name: "Heat", domain: "climate", capability: {
        controlId: "target-temperature", kind: "number", readable: true, writable: true,
        bindings: [{ serviceId: "climate.set_temperature" }],
      } } } }, { devicePolicy: policy });
    const registeredState = structuredClone(store.state);

    const canonical = store.getSyncOutbox().events.filter((event) => event.aggregateId === device.id);
    const staleDigest = "b".repeat(64);
    const staleEvent = (sequence, source) => ({ ...JSON.parse(JSON.stringify(source)), id: `event-${sequence}`,
      sequence, occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(),
      payload: { ...source.payload, descriptorDigest: staleDigest } });
    const marker = (sequence) => ({ id: `event-${sequence}`, sequence, type: "sync.compacted", aggregateId: "",
      occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(), critical: false, payload: { supersededBy: 17 } });
    const pendingEvents = [marker(11), marker(12), staleEvent(13, canonical[0]), staleEvent(14, canonical[1]),
      staleEvent(15, canonical[0]), staleEvent(16, canonical[1])];
    const streamId = "descriptor-rejection-stream-1";
    store.state.syncOutbox = {
      ...store.state.syncOutbox, streamId, acknowledgedSequence: 10, nextSequence: 17,
      events: pendingEvents, lastErrorCode: "hub_sync_descriptor_stale",
      inFlight: { schemaVersion: 1, hubInstallationId: "22222222-2222-4222-8222-222222222222",
        streamId, fromSequence: 11, toSequence: 14, events: pendingEvents.slice(0, 4), queueDepth: 6,
        acknowledgedCloudRevision: 1, runtime: { kind: "dinodia_os", version: "test", capabilities: {
          nativeSyncOutbox: { queueDepth: 6, lastErrorCode: "hub_sync_descriptor_stale" },
        } }, sentAt: new Date(1_800_000_000_000).toISOString() },
    };

    const unchanged = JSON.stringify(store.getSyncOutbox());
    const refused = await store.reconcileRejectedDescriptorSync({ streamId, acceptedSequence: 9, errorCode: "hub_sync_descriptor_stale" });
    assert.deepEqual(refused, { reconciled: false, compactedEvents: 0, refreshedDevices: 0 });
    assert.equal(JSON.stringify(store.getSyncOutbox()), unchanged, "a cursor other than the exact local ACK must not rewrite the durable batch");

    await store.queueSyncEvent("update.status", "updater", { revision: 1, phase: "idle" }, { critical: true });
    assert.equal(store.getSyncOutbox().lastErrorCode, "hub_sync_descriptor_stale",
      "new events must not erase the durable reason that the exact in-flight batch was rejected");
    const reconciled = await store.reconcileRejectedDescriptorSync({ streamId, acceptedSequence: 10, errorCode: "hub_sync_descriptor_stale" });
    assert.deepEqual(reconciled, { reconciled: true, compactedEvents: 4, refreshedDevices: 1 });
    const outbox = store.getSyncOutbox();
    assert.equal(outbox.acknowledgedSequence, 10, "reconciliation must never fabricate a cloud acknowledgement");
    assert.deepEqual(outbox.events.map((entry) => entry.sequence), [11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.ok(outbox.events.slice(0, 6).every((entry) => entry.type === "sync.compacted"));
    assert.deepEqual(outbox.events.slice(0, 6).map((entry) => entry.payload.supersededBy), [17, 17, 18, 18, 18, 18]);
    assert.deepEqual(outbox.events.slice(0, 6).map((entry) => entry.critical), [false, false, true, true, true, true],
      "compaction retains the critical classification of rejected snapshots while preserving earlier markers");
    assert.deepEqual(outbox.inFlight.events.map((entry) => entry.type), ["sync.compacted", "sync.compacted", "sync.compacted", "sync.compacted"]);
    assert.deepEqual(outbox.inFlight.events.map((entry) => entry.critical), [false, false, true, true],
      "the exact rejected in-flight snapshots remain marked critical after conversion to no-payload markers");
    assert.equal(outbox.inFlight.fromSequence, 11);
    assert.equal(outbox.inFlight.toSequence, 14);
    assert.equal(outbox.inFlight.queueDepth, 9);
    assert.deepEqual(outbox.events.slice(-2).map((entry) => entry.type), ["device.upsert", "control.catalog.upsert"]);
    assert.ok(outbox.events.slice(-2).every((entry) => entry.payload.descriptorDigest === policy.descriptorDigest));
    assert.equal(outbox.events.at(-1).payload.catalogRevision, policy.descriptorRevision);
    assert.equal(outbox.nextSequence, 20);
    assert.equal(store.getPlatform().devicePolicies[device.id].managementClass, "PROPERTY_DEVICE");

    const tombstoneState = structuredClone(registeredState);
    const tombstoneOutbox = tombstoneState.syncOutbox;
    const currentEvents = tombstoneOutbox.events.filter((event) => event.aggregateId === device.id);
    const staleUpserts = currentEvents.map((event, index) => ({ ...event, id: `tombstone-guard-${index + 11}`,
      sequence: index + 11, payload: { ...event.payload, descriptorDigest: staleDigest } }));
    const pendingTombstone = { id: "tombstone-guard-13", sequence: 13, type: "control.catalog.tombstone", aggregateId: device.id,
      occurredAt: new Date(1_800_000_000_013).toISOString(), critical: true,
      payload: { osDeviceId: device.id, catalogRevision: policy.descriptorRevision, descriptorDigest: staleDigest, controlIds: ["target-temperature"] } };
    tombstoneOutbox.acknowledgedSequence = 10;
    tombstoneOutbox.nextSequence = 14;
    tombstoneOutbox.events = [...staleUpserts, pendingTombstone];
    tombstoneOutbox.lastErrorCode = "hub_sync_descriptor_stale";
    tombstoneOutbox.inFlight = { schemaVersion: 1, hubInstallationId: "22222222-2222-4222-8222-222222222222",
      streamId: tombstoneOutbox.streamId, fromSequence: 11, toSequence: 12, events: staleUpserts,
      queueDepth: 3, acknowledgedCloudRevision: 1, runtime: {}, sentAt: new Date(1_800_000_000_014).toISOString() };
    store.state = tombstoneState;
    const beforeTombstoneGuard = JSON.stringify(store.getSyncOutbox());
    const tombstoneRefused = await store.reconcileRejectedDescriptorSync({ streamId: tombstoneOutbox.streamId,
      acceptedSequence: 10, errorCode: "hub_sync_descriptor_stale" });
    assert.deepEqual(tombstoneRefused, { reconciled: false, compactedEvents: 0, refreshedDevices: 0 },
      "a distinct pending catalogue tombstone must keep the rejected stream unchanged");
    assert.equal(JSON.stringify(store.getSyncOutbox()), beforeTombstoneGuard);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sensitive capability step-up survives store normalization and restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-sensitive-capability-"));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.upsertDevice({
    id: "sensitive-switch", name: "Sensitive switch", protocol: "virtual", areaId: "area:one",
    setup: { status: "ready" }, state: { state: false },
    entities: {
      "sensitive-switch:state": {
        name: "Power", stateKey: "state", domain: "switch", category: "control", writable: true, primary: true,
        capability: { kind: "binary", controlId: "control:sensitive-power", semanticRole: "power", readable: true, writable: true, automatable: true, primary: true, sensitive: true, bindings: [{ serviceId: "switch.turn_on" }] },
      },
    },
  });

  const restartedStore = new Store(file);
  const device = restartedStore.getDevice("sensitive-switch");
  const storedCapability = device.entities["sensitive-switch:state"].capability;
  assert.equal(storedCapability.sensitive, true);
  assert.equal(storedCapability.stepUpPolicy, "required");
  assert.equal(storedCapability.automatable, false);
  const dto = serializeDevice({ device, homeId: "home:one", homeMembershipId: "membership:owner", role: "OWNER", areaIds: ["area:one"], surfaces: allProjectedSurfaces(device) });
  assert.ok(dto);
  assert.equal(dto.controls[0].stepUpPolicy, "required");
  assert.equal(dto.controls[0].confirmationPolicy, "step_up");
  assert.equal(dto.controls[0].automatable, false);
});

test("store supports rooms, labels, named devices and labeled child entities", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-model-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const area = await store.saveArea({ name: "Kitchen" });
  const label = await store.saveLabel({ name: "Lights" });
  await store.upsertDevice({ id: "kitchen-light", name: "Kitchen light", protocol: "zigbee", areaId: area.id, state: { state: "ON", brightness: 80 } });
  const entityId = "kitchen-light:brightness";
  const entity = await store.updateEntity("kitchen-light", entityId, { name: "Kitchen brightness", labelIds: [label.id] });
  assert.equal(store.getDevice("kitchen-light").areaId, area.id);
  assert.equal(entity.name, "Kitchen brightness");
  assert.deepEqual(entity.labelIds, [label.id]);
  const restored = new Store(path.join(directory, "dinodia.json"));
  assert.equal(restored.listAreas()[0].name, "Kitchen");
  assert.equal(restored.getDevice("kitchen-light").entities[entityId].labelIds[0], label.id);
});

test("coordinators and radio infrastructure stay out of the user device inventory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-infrastructure-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "zigbee:coordinator", name: "Coordinator", protocol: "zigbee", metadata: { type: "Coordinator" } });
  await store.upsertDevice({ id: "matter:controller", name: "Matter controller", protocol: "matter", role: "controller" });
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "zigbee", metadata: { type: "EndDevice" } });
  assert.deepEqual(store.listDevices().map((device) => device.id), ["lamp"]);
  assert.equal(store.getDevice("zigbee:coordinator").infrastructure, false);
});

test("clearing Zigbee removes the coordinator selection but keeps the household inventory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-zigbee-clear-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveZigbee({ adapterPath: "/dev/serial/by-id/usb-coordinator", adapterName: "Coordinator", adapterType: "ember" });
  await store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "zigbee", state: { power: "OFF" } });

  const cleared = await store.clearZigbee();
  assert.equal(cleared.adapterPath, "");
  assert.equal(cleared.adapterName, "");
  assert.deepEqual(cleared.removedAdapterPaths, ["/dev/serial/by-id/usb-coordinator"]);
  assert.equal(store.getConfigEntries().ce_zigbee, undefined);
  assert.equal(store.getDevice("lamp").name, "Lamp");
});

test("store persists the dedicated Thread RCP configuration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-thread-store-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const saved = await store.saveThread({ configured: true, rcpDevice: "/dev/serial/by-id/usb-thread", rcpName: "Thread MG21", baudRate: 460800 });
  assert.equal(saved.configured, true);
  assert.equal(saved.baudRate, 460800);
  assert.equal(new Store(path.join(directory, "dinodia.json")).getThread().rcpDevice, "/dev/serial/by-id/usb-thread");
});

test("registry mutations roll back in-memory state when persistence fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-rollback-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "virtual", state: { power: "OFF" } });
  const originalPersist = store.persist.bind(store);
  store.persist = async () => { throw new Error("disk full"); };
  await assert.rejects(() => store.renameEntity("lamp", "lamp:power", "switch.lamp_power"), /disk full/);
  assert.ok(store.getDevice("lamp").entities["lamp:power"]);
  assert.equal(store.getDevice("lamp").entities["switch.lamp_power"], undefined);
  store.persist = originalPersist;
});

test("removing an area clears device and child-entity assignments and is idempotent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-area-removal-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const area = await store.saveArea({ name: "Bedroom" }, "bedroom");
  await store.upsertDevice({ id: "radiator", name: "Radiator", protocol: "zigbee", areaId: area.id, state: { power: "ON" } });
  await store.updateEntity("radiator", "radiator:power", { areaId: area.id, name: "Radiator power" });

  const removed = await store.removeArea(area.id);
  assert.deepEqual(removed, {
    removed: true,
    areaId: "bedroom",
    areaName: "Bedroom",
    deviceAssignmentsCleared: 1,
    entityAssignmentsCleared: 1,
  });
  assert.equal(store.getDevice("radiator").areaId, null);
  assert.equal(store.getDevice("radiator").entities["radiator:power"].areaId, null);
  assert.equal((await store.removeArea(area.id)).removed, false);
});

test("deleting a device purges its aliases, state, events, automations, bindings, and child entity references", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-device-removal-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "zigbee:123", name: "Radiator upstairs", protocol: "zigbee", haDeviceId: "device-radiator", legacyIds: ["0x123"], metadata: { friendly_name: "radiator", ieee_address: "0x123" }, state: { temperature: 20 } });
  const device = store.getDevice("zigbee:123");
  const entity = Object.values(device.entities)[0];
  await store.saveRemoteBinding({ id: "binding-radiator", sourceDeviceId: "zigbee:123", targetEntityId: entity.id });
  await store.saveAutomation({ id: "automation-radiator", name: "Radiator schedule", trigger: { deviceId: "zigbee:123" }, actions: [{ deviceId: "device-radiator", command: { state: { temperature: 20 } } }] });
  await store.addEvent({ type: "device_state", deviceId: "zigbee:123" });
  await store.addEvent({ type: "unrelated", deviceId: "other-device" });
  store.state.states["zigbee:123"] = { value: 20 };
  store.state.states["unrelated"] = { value: true };
  store.state.heatingUsage.entities = {
    "climate.radiator": { deviceId: "zigbee:123", onSeconds: 10 },
    "climate.other": { deviceId: "other-device", onSeconds: 10 },
  };
  await store.persist();

  assert.equal(await store.deleteDevice("radiator"), true);
  assert.equal(store.listDevices().length, 0);
  assert.equal(store.getDevice("0x123"), null);
  assert.equal(store.listRemoteBindings().length, 0);
  assert.equal(store.listAutomations().length, 0);
  assert.equal(store.listEvents().some((event) => event.deviceId === "zigbee:123"), false);
  assert.equal(store.listEvents().some((event) => event.deviceId === "other-device"), true);
  assert.equal(store.snapshot().states["zigbee:123"], undefined);
  assert.deepEqual(store.snapshot().states.unrelated, { value: true });
  assert.equal(store.snapshot().heatingUsage.entities["climate.radiator"], undefined);
  assert.deepEqual(store.snapshot().heatingUsage.entities["climate.other"], { deviceId: "other-device", onSeconds: 10 });
  assert.equal(await store.deleteDevice("zigbee:123"), false);
});
