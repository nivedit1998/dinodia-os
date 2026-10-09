const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("../src/store");
const { SecretVault } = require("../src/secretVault");
const { PlatformPairing, sign, validateLanEndpointObservation } = require("../src/platformPairing");
const { applyCloudConfiguration } = require("../src/sync/cloudConfiguration");
const { AutomationService } = require("../src/automations/service");
const { AutomationExecutor } = require("../src/automations/executor");
const { AutomationScheduler } = require("../src/automations/scheduler");
const { buildControlCatalog } = require("../src/automations/controlCatalog");
const { SetupDiscovery } = require("../src/setupDiscovery");
const { generateManufacturingIdentity, vaultIdentityRecord } = require("../src/auth/manufacturingIdentity");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function signedConfiguration(unsigned) {
  return { ...unsigned, checksum: crypto.createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex") };
}

function encryptedMachineEnvelope(identity, credential, version, purpose = "machine-credential") {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: identity.encryptionPublicKey });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(`dinodia-os-${purpose}`), Buffer.from(String(version)), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return {
    version,
    purpose,
    algorithm: "x25519-hkdf-sha256/aes-256-gcm",
    ephemeralPublicKeyPem: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function nativeSyncAck(request) {
  const configuration = {
    revision: 1,
    policyRevision: 1,
    areas: [],
    memberships: [],
    devicePolicies: [],
    automations: [],
    releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
  };
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : !value || typeof value !== "object" ? JSON.stringify(value)
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  configuration.checksum = crypto.createHash("sha256").update(canonical(configuration)).digest("hex");
  return {
    streamId: request.streamId,
    cloudRevision: configuration.revision,
    configurationAppliedRevision: request.acknowledgedCloudRevision,
    acceptedThroughSequence: request.toSequence,
    resnapshotRequired: false,
    configuration,
  };
}

test("platform pairing signs requests, stores only token hashes, and acknowledges publication", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-pairing-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "hub-test" });
  const vault = new SecretVault({ dataDir: directory });
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    assert.equal(body.serial, "hub-test");
    const secret = url.includes("/pair") ? "bootstrap" : "sync";
    assert.equal(body.sig, sign(secret, body.serial, body.ts, body.nonce));
    if (url.endsWith("/pair")) return { ok: true, async json() { return { syncSecret: "sync", latestVersion: 2, publishedVersion: 0, hubTokenHashes: [crypto.createHash("sha256").update("hub-token").digest("hex")] }; } };
    return { ok: true, async json() { return { latestVersion: 2, publishedVersion: 2, hubTokenHashes: [crypto.createHash("sha256").update("hub-token").digest("hex")] }; } };
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "hub-test", legacyCompatibilityEnabled: true, intervalMs: 60000, fetchImpl });
  await pairing.configure({ bootstrapSecret: "bootstrap" });
  const paired = await pairing.pair();
  assert.equal(paired.latestVersion, 2);
  assert.equal(vault.get("platform.syncSecret"), "sync");
  assert.equal(store.getPlatform().acceptedTokenHashes.length, 1);
  assert.equal(store.getPlatform().publishedVersion, 0);
  assert.equal(calls.every((call) => !Object.keys(call.body).some((key) => /token/i.test(key) && key !== "agentSeenVersion")), true);
});

test("incident transitions use the durable native sync stream and retire only after its receipt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-incident-sync-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-INCIDENT-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-INCIDENT-HUB" });
  const record = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", record.signingPrivateKey);
  await vault.set("platform.identityPublicKey", record.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", record.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", record.encryptionPublicKey);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.machineCredential", "test-machine-credential");
  // Older paired installations may predate the local hub-installation ID
  // pointer. The authenticated token-state response must recover this exact
  // existing Platform identity before the outbox is submitted.
  await store.savePlatform({ paired: true, provisioningCredentialVersion: 1, homeId: "home-a" });
  await store.queueIncidentEnvelope({ id: "offline-1:1", incidentId: "offline-1", revision: 1, kind: "device_offline", state: "open", severity: "critical", summary: "Device offline", firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString() });
  const seen = [];
  let reportedHubInstallId = "11111111-1111-4111-8111-111111111111";
  const pairing = new PlatformPairing({
    store, vault, apiUrl: "https://platform.test", serial: "DINODIA-INCIDENT-HUB", intervalMs: 60000,
    logger: { error() {} },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push({ url, body });
    if (url.endsWith("/token-state")) return { ok: true, async json() { return { hubInstallId: reportedHubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0, hubTokenHashes: [] }; } };
    if (url.endsWith("/v2/sync")) return { ok: true, async json() { return nativeSyncAck(body); } };
      if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
      throw new Error(`Unexpected test route: ${url}`);
    },
  });
  await pairing.syncNow();
  const sync = seen.find((entry) => entry.url.endsWith("/v2/sync"));
  assert.ok(sync);
  assert.equal(sync.body.hubInstallationId, "11111111-1111-4111-8111-111111111111");
  assert.equal(store.getPlatform().hubInstallId, sync.body.hubInstallationId, "the enrolled installation ID is durably recovered before syncing the outbox");
  assert.equal(sync.body.events[0].type, "incident.transition");
  assert.equal(sync.body.events[0].payload.incidentKey, crypto.createHash("sha256").update("offline-1").digest("hex"));
  assert.equal(Object.hasOwn(sync.body.events[0].payload, "summary"), false, "tenant/private incident summary is not exported in the bounded cloud projection");
  assert.equal(store.listPendingIncidentEnvelopes().length, 0, "local incident is retired only after the accepted stream cursor is persisted");
  assert.equal(store.getSyncOutbox().acknowledgedSequence, sync.body.toSequence);

  reportedHubInstallId = "22222222-2222-4222-8222-222222222222";
  await pairing.syncNow();
  assert.equal(seen.filter((entry) => entry.url.endsWith("/v2/sync")).length, 1, "a contradictory authenticated installation binding is rejected before sending another batch");
  assert.equal(store.getPlatform().hubInstallId, "11111111-1111-4111-8111-111111111111", "a paired OS never silently rebinds to another Platform installation");
  pairing.stop();
});

test("an atomically applied Platform automation survives OS restart, executes once on a virtual descriptor, and creates one durable outcome event", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-platform-automation-sync-"));
  const dataFile = path.join(directory, "dinodia.json");
  const serial = "DINODIA-AUTOMATION-SYNC-HUB";
  const hubInstallId = "11111111-1111-4111-8111-111111111111";
  const now = new Date("2026-10-09T09:00:00.000Z"); // 10:00 Europe/London, Friday
  try {
    let store = new Store(dataFile);
    await store.saveIdentity({ serial, instanceId: "automation-home" });
    await store.saveArea({ name: "Kitchen" }, "os-kitchen");
    await store.upsertDevice({
      id: "automation-lamp", name: "Virtual automation lamp", protocol: "virtual", areaId: "os-kitchen",
      labels: ["property_device"], managementClass: "PROPERTY_DEVICE", setup: { status: "ready" },
      entities: { "automation-lamp-state": {
        id: "automation-lamp-state", name: "Virtual automation lamp", stateKey: "state", domain: "light", category: "control",
        capability: { readable: true, writable: true, primary: true, category: "control", semanticRole: "power", automatable: true,
          bindings: [{ serviceId: "light.turn_on" }, { serviceId: "light.turn_off" }] },
      } },
    });
    const areaById = new Map(store.listAreas().map((area) => [String(area.id), area]));
    const lamp = store.getDevice("automation-lamp");
    const catalog = buildControlCatalog({ devices: [lamp], getArea: (id) => areaById.get(String(id)) });
    const power = catalog[0]?.controls.find((control) => control.valueType === "boolean" && control.allowsAutomation);
    assert.ok(power, "the current OS descriptor provides a real permitted typed control");
    const sourceFingerprint = String(lamp.presentation.sourceFingerprint || "");
    const descriptorDigest = crypto.createHash("sha256").update(sourceFingerprint, "utf8").digest("hex");
    const automationId = "platform-automation-breakfast";
    const automation = {
      id: automationId, name: "Morning lamp", status: "ACTIVE", revision: 1,
      definitionChecksum: crypto.createHash("sha256").update("stage11-platform-definition").digest("hex"),
      timezone: "Europe/London",
      triggers: [{ id: "platform-trigger-morning", kind: "SCHEDULE", configuration: { minuteOfDay: 600, weekdays: [5] }, revision: 1 }],
      actions: [{ id: "platform-action-lamp", osDeviceId: "automation-lamp", osAreaId: "os-kitchen", controlId: power.controlId,
        descriptorRevision: lamp.presentation.descriptorRevision, actionValue: { type: "boolean", boolean: true }, needsAttention: false }],
    };
    const configuration = signedConfiguration({
      revision: 1, policyRevision: 1,
      areas: [{ id: "platform-area-kitchen", osAreaId: "os-kitchen", originalName: "Kitchen", overrideName: null, revision: 1 }],
      memberships: [{ id: "platform-tenant", role: "TENANT", accessRevision: 1, areaIds: ["platform-area-kitchen"], grantRevisions: [{ areaId: "platform-area-kitchen", revision: 1 }] }],
      devicePolicies: [{ osDeviceId: "automation-lamp", managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, analyticsCategory: "LIGHT",
        lifecycle: "INSTALLED", customerLabel: null, overrideName: null, descriptorRevision: lamp.presentation.descriptorRevision, descriptorDigest, osAreaIds: ["os-kitchen"] }],
      automations: [automation],
      releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
    });
    await applyCloudConfiguration(store, configuration);
    assert.equal(store.getPlatform().cloudRevision, 1, "the complete configuration revision is persisted");
    assert.equal(store.getNativeAutomation(automationId).automation.source, "platform_sync");
    assert.equal(store.getNativeAutomation(automationId).actions[0].controlId, power.controlId);

    // Reopen the exact persisted Store before execution to cover process restart
    // between atomic policy application and the scheduled occurrence.
    store = new Store(dataFile);
    const service = new AutomationService({ store, homeId: "automation-home", now: () => new Date(now) });
    const effects = [];
    const executor = new AutomationExecutor({ store, now: () => new Date(now), executeControl: async (input) => { effects.push(input.action.id); } });
    const scheduler = new AutomationScheduler({ store, service, executor, now: () => new Date(now), setIntervalFn: () => null, clearIntervalFn() {} });
    assert.deepEqual(await scheduler.tick(now), { claimed: 1 });
    assert.deepEqual(effects, ["platform-action-lamp"]);
    assert.equal(store.state.automationExecutions[0].status, "succeeded");

    const restartedStore = new Store(dataFile);
    const restartedService = new AutomationService({ store: restartedStore, homeId: "automation-home", now: () => new Date(now) });
    const restartedScheduler = new AutomationScheduler({ store: restartedStore, service: restartedService,
      executor: new AutomationExecutor({ store: restartedStore, now: () => new Date(now), executeControl: async () => { effects.push("duplicate"); } }),
      now: () => new Date(now), setIntervalFn: () => null, clearIntervalFn() {} });
    assert.deepEqual(await restartedScheduler.tick(now), { claimed: 0 });
    assert.deepEqual(effects, ["platform-action-lamp"], "restart/retry cannot repeat the stable scheduled occurrence");
    assert.equal(await restartedStore.ensureAutomationOutcomeEvents(now.getTime() + 1000), 1);
    assert.equal(await restartedStore.ensureAutomationOutcomeEvents(now.getTime() + 1000), 0);
    const outcomeEvents = restartedStore.getSyncOutbox().events.filter((event) => event.type === "automation.outcome");
    assert.equal(outcomeEvents.length, 1);
    assert.equal(outcomeEvents[0].payload.occurrenceId, restartedStore.state.automationExecutions[0].occurrenceId);
    assert.equal(outcomeEvents[0].critical, true);
    assert.equal(Object.hasOwn(outcomeEvents[0].payload, "name"), false, "cloud outcome omits routine and device names");
    assert.equal(Object.hasOwn(outcomeEvents[0].payload, "targetValue"), false, "cloud outcome omits private action values");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("tenant removal policy is not acknowledged until the paired hub completes local device cleanup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-tenant-removal-sync-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const vault = new SecretVault({ dataDir: directory });
  const serial = "DINODIA-TENANT-REMOVAL-HUB";
  const identity = generateManufacturingIdentity({ serial });
  const record = vaultIdentityRecord(identity);
  await store.saveIdentity({ serial });
  await vault.set("platform.identityPrivateKey", record.signingPrivateKey);
  await vault.set("platform.identityPublicKey", record.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", record.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", record.encryptionPublicKey);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.machineCredential", "disposable-tenant-removal-credential");
  const hubInstallId = "11111111-1111-4111-8111-111111111111";
  const areaRows = [
    { id: "public-room", osAreaId: "os-room", originalName: "Room", overrideName: null, revision: 1 },
  ];
  const membership = { id: "tenant-membership", role: "TENANT", accessRevision: 1, areaIds: ["public-room"] };
  const checksum = (value) => {
    const canonical = (input) => Array.isArray(input) ? `[${input.map(canonical).join(",")}]`
      : input && typeof input === "object" ? `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`
        : JSON.stringify(input);
    return crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
  };
  const makeConfiguration = (revision, lifecycle, areaIds) => {
    const unsigned = { revision, policyRevision: revision, areas: areaRows, memberships: lifecycle === "INSTALLED" ? [membership] : [{ ...membership, areaIds: [] }],
      devicePolicies: [{ osDeviceId: "tenant-sync-lamp", managementClass: "TENANT_DEVICE", ownerMembershipId: "tenant-membership", analyticsCategory: "NONE", lifecycle, customerLabel: null, overrideName: null, descriptorRevision: 1, descriptorDigest: null, osAreaIds: areaIds }],
      automations: [], releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null } };
    return { ...unsigned, checksum: checksum(unsigned) };
  };
  await store.savePlatform({ paired: true, provisioningCredentialVersion: 1, hubInstallId, homeId: "tenant-sync-home" });
  await store.saveArea({ name: "Room" }, "os-room");
  await applyCloudConfiguration(store, makeConfiguration(1, "INSTALLED", ["os-room"]));
  await store.upsertDevice({ id: "tenant-sync-lamp", name: "Private lamp", protocol: "zigbee", areaId: "os-room", managementClass: "tenant_device", tenantOwnerMembershipId: "tenant-membership", metadata: { managementClass: "tenant_device", tenantOwnerMembershipId: "tenant-membership" } });
  const removalConfiguration = makeConfiguration(2, "REMOVAL_PENDING", []);
  let enforce = false;
  const seenRemovals = [];
  const pairing = new PlatformPairing({
    store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000,
    logger: { error() {}, warn() {} },
    reconcileTenantDeviceRemoval: async (entry) => {
      seenRemovals.push(entry);
      if (!enforce) return false;
      await store.deleteDevice(entry.osDeviceId);
      return true;
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/token-state")) return { ok: true, async json() { return { hubInstallId, homeId: "tenant-sync-home", areaBindings: [{ areaId: "public-room", hubAreaId: "os-room" }], latestVersion: 0, publishedVersion: 0, hubTokenHashes: [], operatorCredentialStates: [], offlineAuthorisations: [], syncAcceptedSequence: 0, syncStreamId: null, installationSyncMode: "ACTIVE", policyRevision: 2 }; } };
      if (url.endsWith("/v2/sync")) return { ok: true, async json() { return { streamId: body.streamId, cloudRevision: 2, configurationAppliedRevision: 2, acceptedThroughSequence: body.toSequence, resnapshotRequired: false, configuration: removalConfiguration }; } };
      if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
      throw new Error(`Unexpected tenant-removal sync route: ${url}`);
    },
  });
  try {
    await pairing.syncNow();
    assert.equal(store.getPlatform().cloudRevision, 2, "the current signed policy may be locally applied before enforcement finishes");
    assert.equal(store.getSyncOutbox().acknowledgedSequence, 0, "the durable outbox receipt is not advanced before physical removal is confirmed");
    assert.equal(store.listPendingTenantDeviceRemovals().length, 1, "failed physical enforcement remains durable for retry");
    assert.ok(store.getDevice("tenant-sync-lamp"));
    assert.equal(seenRemovals.length, 1);

    enforce = true;
    pairing.nextRetryAt = 0;
    await pairing.syncNow();
    assert.equal(store.getDevice("tenant-sync-lamp"), null);
    assert.deepEqual(store.listPendingTenantDeviceRemovals(), []);
    assert.ok(store.getSyncOutbox().acknowledgedSequence > 0, "configuration and outbox receipt are acknowledged only after local removal succeeds");
    assert.equal(store.getSyncOutbox().events.at(-1).type, "device.tombstone", "physical removal leaves a durable cloud reconciliation tombstone");
    assert.equal(seenRemovals.length, 2);
    assert.equal(seenRemovals[0].ownerMembershipId, "tenant-membership");
    const tombstoneSequence = store.getSyncOutbox().events.at(-1).sequence;
    const deadline = Date.now() + 2_000;
    while (store.getSyncOutbox().acknowledgedSequence < tombstoneSequence && Date.now() < deadline) {
      if (!pairing.syncing) {
        pairing.nextRetryAt = 0;
        await pairing.syncNow();
      }
      if (store.getSyncOutbox().acknowledgedSequence < tombstoneSequence) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(store.getSyncOutbox().acknowledgedSequence >= tombstoneSequence, "the generated tombstone is delivered and acknowledged through the actual paired sync path");
  } finally {
    pairing.stop();
    const drainDeadline = Date.now() + 2_000;
    while (pairing.syncing && Date.now() < drainDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await store.writeQueue;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("native provisioning completes the outbound challenge, encrypted credential delivery and acknowledgement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-native-pairing-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-TEST-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-TEST-HUB" });
  const identityRecord = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", identityRecord.signingPrivateKey);
  await vault.set("platform.identityPublicKey", identityRecord.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", identityRecord.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", identityRecord.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", identityRecord.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", identityRecord.encryptionKeyFingerprint);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.manufacturingCertificateSignature", "factory-signature-for-platform-test");
  const credential = "dno_machine_test_credential";
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    if (url.endsWith("/pairing/register")) return { ok: true, async json() { return { ok: true, attemptId: "attempt-1", pairingId: "pairing-1", hubInstallId: "22222222-2222-4222-8222-222222222222" }; } };
    if (url.endsWith("/pairing/challenge")) return { ok: true, async json() { return { ok: true, challenge: "challenge-for-hub", expiresAt: new Date(Date.now() + 60_000).toISOString() }; } };
    if (url.endsWith("/pairing/prove")) return { ok: true, async json() { return { ok: true, attemptId: body.attemptId, version: 1, envelope: encryptedMachineEnvelope(identity, credential, 1) }; } };
    if (url.endsWith("/pairing/acknowledge")) {
      assert.equal(body.credentialFingerprint, crypto.createHash("sha256").update(credential).digest("hex"));
      return { ok: true, async json() { return { ok: true, acknowledged: true }; } };
    }
    if (url.endsWith('/heartbeat')) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
    if (url.endsWith('/token-state')) return { ok: true, async json() { return { latestVersion: 0, publishedVersion: 0, hubTokenHashes: [], acceptedActivityIncidentIds: [] }; } };
    if (url.endsWith('/v2/sync')) return { ok: true, async json() { return nativeSyncAck(body); } };
    throw new Error(`Unexpected test route: ${url}`);
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "DINODIA-TEST-HUB", fetchImpl, intervalMs: 60000 });
  const presentation = { attemptId: "attempt-1", code: "short-lived-presentation", expiresAt: Date.now() + 15 * 60_000 };
  const registered = await pairing.registerProvisioningAttempt({ pairing: presentation, baseUrl: "http://192.168.1.76:8123" });
  assert.equal(registered.attemptId, "attempt-1");
  assert.equal(store.getPlatform().paired, false);
  await pairing.syncNow();
  assert.equal(store.getPlatform().paired, true);
  assert.equal(vault.get("platform.machineCredential"), credential);
  assert.deepEqual(calls.map((call) => call.url.split("platform.test")[1]), [
    "/api/hub-agent/v2/pairing/register",
    "/api/hub-agent/v2/pairing/challenge",
    "/api/hub-agent/v2/pairing/prove",
    "/api/hub-agent/v2/pairing/acknowledge",
    "/api/hub-agent/token-state",
    "/api/hub-agent/v2/sync",
    "/api/hub-agent/v2/heartbeat",
  ]);
});

test("operator credential receipt stays DELIVERED until the hub acknowledgement succeeds", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-operator-delivery-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-OPERATOR-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-OPERATOR-HUB" });
  const identityRecord = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", identityRecord.signingPrivateKey);
  await vault.set("platform.identityPublicKey", identityRecord.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", identityRecord.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", identityRecord.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", identityRecord.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", identityRecord.encryptionKeyFingerprint);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.manufacturingCertificateSignature", "factory-signature-for-operator-test");
  await store.savePlatform({ paired: true, provisioningCredentialVersion: 1, operatorCredentialVersion: 0 });
  const credential = "dno_operator_test_credential";
  const envelope = encryptedMachineEnvelope(identity, credential, 2, "operator-credential");
  let acknowledgementAttempts = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/heartbeat")) {
      const body = JSON.parse(options.body);
      return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
    }
    if (url.endsWith("/credentials/acknowledge")) {
      acknowledgementAttempts += 1;
      if (acknowledgementAttempts === 1) return { ok: false, status: 503, async json() { return { error: "temporarily_unavailable" }; } };
      return { ok: true, async json() { return { ok: true, state: "ACKNOWLEDGED" }; } };
    }
    if (url.endsWith("/credentials/activate")) return { ok: true, async json() { return { ok: true, state: "ACTIVE" }; } };
    if (url.endsWith("/v2/sync")) return { ok: true, async json() { return nativeSyncAck(body); } };
    assert.match(url, /\/token-state$/);
    return { ok: true, async json() { return { hubInstallId: "33333333-3333-4333-8333-333333333333", latestVersion: 2, publishedVersion: 0, operatorCredentialDelivery: { version: 2, envelope }, operatorCredentialStates: [], offlineAuthorisations: [], acceptedActivityIncidentIds: [] }; } };
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "DINODIA-OPERATOR-HUB", fetchImpl, intervalMs: 60000 });
  await pairing.syncNow();
  assert.equal(store.getPlatform().operatorCredentialStates[0].state, "DELIVERED");
  assert.equal(store.getPlatform().operatorCredentialVersion, 0);
  pairing.nextRetryAt = 0;
  await pairing.syncNow();
  assert.equal(store.getPlatform().operatorCredentialStates[0].state, "ACTIVE");
  assert.equal(store.getPlatform().operatorCredentialVersion, 2);
  assert.equal(acknowledgementAttempts, 2);
});

test("operator policy sync is at most 30 seconds while the signed operations heartbeat remains two minutes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-policy-cadence-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-POLICY-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-POLICY-HUB" });
  const record = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", record.signingPrivateKey);
  await vault.set("platform.identityPublicKey", record.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", record.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", record.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", record.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", record.encryptionKeyFingerprint);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.manufacturingCertificateSignature", "test-only-certificate-signature");
  await store.savePlatform({ paired: true, provisioningCredentialVersion: 1, hubInstallId: "33333333-3333-4333-8333-333333333333" });
  let now = 1_000_000;
  const routes = [];
  const pairing = new PlatformPairing({
    store, vault, apiUrl: "https://platform.test", serial: "DINODIA-POLICY-HUB",
    intervalMs: 30_000, heartbeatIntervalMs: 120_000, clock: () => now,
    fetchImpl: async (url, options) => {
      routes.push(new URL(url).pathname);
      const body = JSON.parse(options.body || "{}");
      if (url.endsWith("/v2/sync")) return { ok: true, async json() { return nativeSyncAck(body); } };
      return { ok: true, async json() { return { latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [], acceptedActivityIncidentIds: [], ...(url.endsWith("/heartbeat") && body.lanEndpoint ? { lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } } : {}) }; } };
    },
  });
  await pairing.syncNow();
  now += 30_000;
  await pairing.syncNow();
  now += 89_999;
  await pairing.syncNow();
  assert.equal(routes.filter((route) => route.endsWith("/heartbeat")).length, 1);
  assert.equal(routes.filter((route) => route.endsWith("/token-state")).length, 3);
  now += 1;
  await pairing.syncNow();
  assert.equal(routes.filter((route) => route.endsWith("/heartbeat")).length, 2);
  assert.equal(routes.filter((route) => route.endsWith("/token-state")).length, 4);
});

test("a failed signed inventory sync still reports the durable backlog and bounded error in an independent heartbeat", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-sync-failure-heartbeat-"));
  try {
    const store = new Store(path.join(directory, "dinodia.json"));
    const serial = "DINODIA-SYNC-FAILURE-HUB";
    await store.saveIdentity({ serial });
    const vault = new SecretVault({ dataDir: directory });
    const identity = generateManufacturingIdentity({ serial });
    const record = vaultIdentityRecord(identity);
    for (const [key, value] of Object.entries({
      "platform.identityPrivateKey": record.signingPrivateKey,
      "platform.identityPublicKey": record.signingPublicKey,
      "platform.encryptionPrivateKey": record.encryptionPrivateKey,
      "platform.encryptionPublicKey": record.encryptionPublicKey,
      "platform.identityFingerprint": record.publicKeyFingerprint,
      "platform.encryptionFingerprint": record.encryptionKeyFingerprint,
      "platform.identityGeneration": "1",
      "platform.machineCredential": "disposable-machine-credential",
    })) await vault.set(key, value);
    const hubInstallId = "11111111-1111-4111-8111-111111111111";
    await store.savePlatform({ paired: true, hubInstallId, homeId: "home-sync-failure" });
    const calls = [];
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000,
      getLanEndpoint: async () => ({ state: "UNAVAILABLE", address: "", interfaceName: null }),
      logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body });
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-sync-failure", latestVersion: 0, publishedVersion: 0, hubTokenHashes: [],
          installationSyncMode: "ACTIVE", syncAcceptedSequence: 0, syncStreamId: store.getSyncOutbox().streamId,
          policyRevision: 0, areaBindings: [],
        }; } };
        if (url.endsWith("/v2/sync")) throw Object.assign(new Error("disposable loopback sync unavailable"), { code: "loopback_sync_unavailable" });
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
        throw new Error("Unexpected test route");
      },
    });
    await pairing.syncNow();
    const sync = calls.find((call) => call.url.endsWith("/v2/sync"));
    const heartbeat = calls.find((call) => call.url.endsWith("/heartbeat"));
    assert.ok(sync);
    assert.ok(heartbeat, "sync failure must not prevent the independent authenticated heartbeat");
    assert.equal(heartbeat.body.hubRuntime.capabilities.nativeSyncOutbox.queueDepth, store.getSyncOutbox().events.length);
    assert.equal(heartbeat.body.hubRuntime.capabilities.nativeSyncOutbox.lastErrorCode, "loopback_sync_unavailable");
    assert.equal(store.getSyncOutbox().acknowledgedSequence, 0, "heartbeat does not forge or advance a sync receipt");
    assert.equal(store.getSyncOutbox().lastErrorCode, "loopback_sync_unavailable");
    pairing.stop();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("signed heartbeat persists monotonic LAN endpoint revisions and keeps unavailable addresses out of the report", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-lan-endpoint-heartbeat-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-LAN-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-LAN-HUB" });
  const record = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", record.signingPrivateKey);
  await vault.set("platform.identityPublicKey", record.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", record.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", record.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", record.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", record.encryptionKeyFingerprint);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.manufacturingCertificateSignature", "test-only-certificate-signature");
  await store.savePlatform({ paired: true, provisioningCredentialVersion: 1, hubInstallId: "44444444-4444-4444-8444-444444444444" });
  let address = "192.168.1.76";
  const discovery = new SetupDiscovery({
    serial: "DINODIA-LAN-HUB",
    nodeEnv: "test",
    interfaces: () => address ? { eth0: [{ address, family: "IPv4", internal: false }] } : { eth0: [] },
    physicalCheck: () => true,
  });
  const observations = [];
  let holdHeartbeat = false;
  let heartbeatStarted;
  let releaseHeartbeat;
  const heartbeatStartedPromise = new Promise((resolve) => { heartbeatStarted = resolve; });
  const pairing = new PlatformPairing({
    store, vault, apiUrl: "https://platform.test", serial: "DINODIA-LAN-HUB",
    // Exercise the exact observation object supplied by createHub in
    // src/server.js; do not handcraft a friendlier address-shaped test value.
    getLanEndpoint: () => discovery.observation(),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/heartbeat")) {
        observations.push(body.lanEndpoint);
        if (holdHeartbeat) {
          holdHeartbeat = false;
          heartbeatStarted();
          await new Promise((resolve) => { releaseHeartbeat = resolve; });
        }
        return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
      }
      if (url.endsWith("/v2/sync")) return { ok: true, async json() { return nativeSyncAck(body); } };
      return { ok: true, async json() { return { latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [], acceptedActivityIncidentIds: [] }; } };
    },
  });
  await pairing.syncNow();
  assert.deepEqual(observations[0], { version: 1, revision: 1, state: "CURRENT", baseUrl: "http://192.168.1.76:8123", discoveryHost: "dinodia-dinodia-lan-hub.local" });
  assert.equal(validateLanEndpointObservation(observations[0], "DINODIA-LAN-HUB"), true);
  const canonicalFixture = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures/contracts/dinodia-v1/fixtures/lan-endpoint-current.json"), "utf8"));
  assert.equal(validateLanEndpointObservation(canonicalFixture, "din-home-001"), true);
  for (const invalid of [
    { ...canonicalFixture, baseUrl: "http://203.0.113.42:8123" },
    { ...canonicalFixture, baseUrl: "http://192.168.0.110:8124" },
    { ...canonicalFixture, baseUrl: "http://192.168.000.110:8123" },
    { ...canonicalFixture, discoveryHost: "dinodia-another-hub.local" },
    { ...canonicalFixture, installationId: "caller-selected" },
  ]) assert.equal(validateLanEndpointObservation(invalid, "din-home-001"), false);
  await pairing.requestImmediateHeartbeat();
  assert.equal(observations[1].revision, 1, "same endpoint refreshes its signed receipt without incrementing revision");
  address = "192.168.0.110";
  await pairing.requestImmediateHeartbeat();
  assert.equal(observations[2].revision, 2);
  assert.equal(observations[2].baseUrl, "http://192.168.0.110:8123");
  address = "";
  await pairing.requestImmediateHeartbeat();
  assert.deepEqual(observations[3], { version: 1, revision: 3, state: "UNAVAILABLE", discoveryHost: "dinodia-dinodia-lan-hub.local" });
  assert.equal(store.getPlatform().lanEndpointObservation.revision, 3);
  assert.equal(Object.hasOwn(observations[3], "baseUrl"), false);

  // A second network move while the first signed heartbeat is in flight must
  // survive that request's acknowledgement and be sent immediately afterward.
  address = "192.168.0.111";
  holdHeartbeat = true;
  pairing.lastHeartbeatAt = 0;
  const firstMove = pairing.syncNow();
  await heartbeatStartedPromise;
  address = "192.168.0.112";
  await pairing.requestImmediateHeartbeat();
  releaseHeartbeat();
  await firstMove;
  for (let attempt = 0; attempt < 50 && observations.length < 6; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observations.length, 6);
  assert.equal(observations[4].baseUrl, "http://192.168.0.111:8123");
  assert.equal(observations[5].baseUrl, "http://192.168.0.112:8123");
  assert.equal(observations[5].revision, observations[4].revision + 1);
});

test("production installer heartbeat accepts the URL-normalized default HTTP port 80", async () => {
  const serial = "DINODIA-PRODUCTION-LAN-HUB";
  let platform = {};
  const store = {
    getPlatform() { return platform; },
    async savePlatform(value) { platform = { ...platform, ...value }; },
  };
  const pairing = new PlatformPairing({
    store,
    vault: {},
    apiUrl: "https://platform.test",
    serial,
    haPort: 8123,
    runtime: { nodeEnv: "production" },
    getLanEndpoint: () => ({ state: "CURRENT", address: "192.168.1.76", interfaceName: "eth0" }),
  });

  const observation = await pairing.buildLanEndpointObservation(7);

  assert.deepEqual(observation, {
    version: 1,
    revision: 1,
    state: "CURRENT",
    baseUrl: "http://192.168.1.76:80",
    discoveryHost: "dinodia-dinodia-production-lan-hub.local",
  });
  assert.equal(validateLanEndpointObservation(observation, serial, 80), true);
  assert.equal(platform.lanEndpointObservation.identityGeneration, 7);
});

test("CloudURL re-verification is included inside the machine-signed Platform request body", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-cloud-reverify-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-CLOUD-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-CLOUD-HUB" });
  const record = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", record.signingPrivateKey);
  await vault.set("platform.identityPublicKey", record.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", record.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", record.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", record.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", record.encryptionKeyFingerprint);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.manufacturingCertificateSignature", "test-only-certificate-signature");
  const bodies = [];
  const pairing = new PlatformPairing({
    store, vault, apiUrl: "https://platform.test", serial: "DINODIA-CLOUD-HUB",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, async json() { return { ok: true, verified: true, verificationId: "verification-redacted" }; } };
    },
  });
  const metadata = { tunnelId: "tunnel-test", tunnelName: "dinodia-test-hub", hostname: "dinodia-test-hub.dinodiasmartliving.com", reservationToken: "test-only-reservation" };
  await pairing.reportCloudUrl("https://dinodia-test-hub.dinodiasmartliving.com", { ...metadata, reverifyChallenge: true });
  await pairing.reportCloudUrl("https://dinodia-test-hub.dinodiasmartliving.com", metadata);
  assert.equal(bodies[0].reverifyChallenge, true);
  assert.equal(Object.hasOwn(bodies[1], "reverifyChallenge"), false);
  assert.equal(bodies.every((body) => body.serial === "DINODIA-CLOUD-HUB" && body.identityGeneration === 1), true);
});

test("permanent hub claim challenge is opaque, short-lived, and hub-signed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-claim-resolver-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "DINODIA-CLAIM-HUB" });
  const vault = new SecretVault({ dataDir: directory });
  const identity = generateManufacturingIdentity({ serial: "DINODIA-CLAIM-HUB" });
  const identityRecord = vaultIdentityRecord(identity);
  await vault.set("platform.identityPrivateKey", identityRecord.signingPrivateKey);
  await vault.set("platform.identityPublicKey", identityRecord.signingPublicKey);
  await vault.set("platform.encryptionPrivateKey", identityRecord.encryptionPrivateKey);
  await vault.set("platform.encryptionPublicKey", identityRecord.encryptionPublicKey);
  await vault.set("platform.identityFingerprint", identityRecord.publicKeyFingerprint);
  await vault.set("platform.encryptionFingerprint", identityRecord.encryptionKeyFingerprint);
  await vault.set("platform.identityGeneration", "1");
  await vault.set("platform.manufacturingCertificateSignature", "factory-signature-for-claim-test");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, async json() { return { ok: true, challengeId: "challenge-1", challenge: "nonce-1", resolverGeneration: 1, expiresAt: new Date(Date.now() + 300000).toISOString() }; } };
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "DINODIA-CLAIM-HUB", fetchImpl, intervalMs: 60000 });
  const result = await pairing.requestPermanentClaimChallenge("dno_home_claim_reference");
  assert.equal(result.challengeId, "challenge-1");
  assert.equal(result.hubSignature.length > 20, true);
  assert.equal(result.bodyHash.length, 64);
  assert.equal(calls[0].url.endsWith("/api/hub-agent/v2/claim/resolver/challenge"), true);
  assert.equal(calls[0].body.reference, "dno_home_claim_reference");
  assert.equal(Object.hasOwn(result, "homeId"), false);
});
