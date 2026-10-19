const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("../src/store");
const { SYNC_BATCH_MAX_EVENTS } = require("../src/sync/syncOutbox");
const { SecretVault } = require("../src/secretVault");
const { PlatformPairing, validateLanEndpointObservation } = require("../src/platformPairing");
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

test("signed sync uses its longer deadline through response-body parsing while other hub requests stay short", async () => {
  let responseDelayMs = 25;
  let bodyDelayMs = 25;
  const waitForRequest = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const pairing = new PlatformPairing({
    store: { getPlatform: () => ({}) }, vault: null, apiUrl: "https://platform.test", serial: "deadline-test",
    requestTimeoutMs: 15, syncRequestTimeoutMs: 80,
    fetchImpl: async (_url, { signal }) => {
      await waitForRequest(responseDelayMs, signal);
      return { ok: true, status: 200, async json() { await waitForRequest(bodyDelayMs, signal); return { ok: true }; } };
    },
  });
  assert.equal(pairing.syncRequestTimeoutMs, 80, "sync owns a distinct bounded deadline");
  pairing.getPublicIdentity = async () => ({ generation: 1 });
  pairing.signPlatformRequest = async () => "test-signature";

  assert.deepEqual(await pairing.requestWithHubIdentity("/api/hub-agent/v2/sync", { events: [] }), { ok: true });
  responseDelayMs = 1;
  bodyDelayMs = 30;
  pairing.syncRequestTimeoutMs = 15;
  await assert.rejects(
    () => pairing.requestWithHubIdentity("/api/hub-agent/v2/sync", { events: [] }),
    (error) => error.code === "hub_sync_request_timeout",
  );
  responseDelayMs = 25;
  bodyDelayMs = 1;
  await assert.rejects(() => pairing.requestWithHubIdentity("/api/hub-agent/v2/heartbeat", {}),
    (error) => error.code === "hub_request_timeout");
});

test("retired bootstrap credentials cannot pair or synchronize a Native V2 installation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-pairing-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.saveIdentity({ serial: "hub-test" });
  const vault = new SecretVault({ dataDir: directory });
  const calls = [];
  const pairing = new PlatformPairing({ store, vault, apiUrl: "https://platform.test", serial: "hub-test", intervalMs: 60000, fetchImpl: async (...args) => { calls.push(args); throw new Error("unexpected legacy network call"); } });
  await pairing.configure({ bootstrapSecret: "bootstrap" });
  assert.equal(pairing.pair, undefined);
  assert.equal(vault.get("platform.bootstrapSecret"), null);
  assert.equal(await pairing.syncNow(), null, "unpaired installations do not enter the legacy bearer-sync route");
  assert.equal(store.getPlatform().paired, false);
  assert.deepEqual(calls, []);
});

test("an unpaired installed hub publishes only its identity-signed local recovery endpoint", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-unpaired-local-recovery-"));
  try {
    const store = new Store(path.join(directory, "dinodia.json"));
    const serial = "DINODIA-LOCAL-RECOVERY-HUB";
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
      "platform.manufacturingCertificateSignature": "test-only-certificate-signature",
    })) await vault.set(key, value);
    await store.savePlatform({ paired: false, apiUrl: "https://platform.test" });
    const calls = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let currentLanAddress = "192.168.1.76";
    let nextLanAddresses = [];
    let staleRevisionNext = null;
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, nativeApiPort: 8123,
      runtime: { nodeEnv: "test" },
      getLanEndpoint: () => ({ state: "CURRENT", address: nextLanAddresses.shift() || currentLanAddress, interfaceName: "wlan0" }),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const body = JSON.parse(options.body);
          if (staleRevisionNext !== null) {
            const currentRevision = staleRevisionNext;
            staleRevisionNext = null;
            return { ok: false, status: 409, async json() { return { ok: false, errorCode: "lan_endpoint_revision_stale", currentRevision }; } };
          }
          return { ok: true, status: 200, async json() { return { ok: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
        } finally { activeRequests -= 1; }
      },
    });

    pairing.start();
    const publishDeadline = Date.now() + 1_000;
    while ((!calls.length || pairing.recoveryEndpointInFlight) && Date.now() < publishDeadline) await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(calls.length, 1, "recovery performs one bounded Platform request");
    assert.match(calls[0].url, /\/api\/hub-agent\/v2\/lan-endpoint$/);
    assert.equal(calls[0].options.headers["x-dinodia-hub-signature"]?.length > 0, true);
    assert.equal(Object.hasOwn(calls[0].options.headers, "x-dinodia-machine-signature"), false);
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(Object.keys(body).sort(), ["identityGeneration", "lanEndpoint", "serial"].sort());
    assert.deepEqual(body.lanEndpoint, { version: 1, revision: 1, state: "CURRENT", baseUrl: "http://192.168.1.76:8123", discoveryHost: "dinodia-dinodia-local-recovery-hub.local" });
    assert.equal(store.getPlatform().paired, false, "publishing a local endpoint does not claim machine pairing");
    assert.equal(store.getPlatform().provisioningAttemptId, undefined);
    assert.equal(store.getSyncOutbox().acknowledgedSequence, 0, "no household sync receipt is created");
    assert.equal(calls.some(({ url }) => /token-state|\/v2\/sync|\/heartbeat/.test(url)), false);
    nextLanAddresses = ["192.168.1.77", "192.168.1.78"];
    const publicIdentity = await pairing.getPublicIdentity();
    await Promise.all([pairing.publishRecoveryLanEndpoint(), pairing.publishSignedHeartbeat(publicIdentity)]);
    const serializedReports = calls.slice(1).map(({ options }) => JSON.parse(options.body).lanEndpoint);
    assert.deepEqual(serializedReports.map((report) => report.revision), [2, 3], "racing recovery and heartbeat reports receive distinct monotonic revisions");
    assert.deepEqual(serializedReports.map((report) => report.baseUrl), ["http://192.168.1.77:8123", "http://192.168.1.78:8123"]);
    assert.equal(maximumActiveRequests, 1, "endpoint-bearing Platform requests are serialized through the shared report boundary");
    currentLanAddress = "192.168.1.79";
    staleRevisionNext = 7;
    const outboxBeforeReconciliation = store.getSyncOutbox();
    const reconciliationStart = calls.length;
    const reconciled = await pairing.publishRecoveryLanEndpoint();
    const reconciliationReports = calls.slice(reconciliationStart).map(({ options }) => JSON.parse(options.body).lanEndpoint);
    assert.deepEqual(reconciliationReports.map((report) => report.revision), [4, 8], "an authenticated authoritative stale-revision receipt is reconciled once above the server revision");
    assert.equal(reconciled.lanEndpoint.revision, 8);
    assert.equal(store.getPlatform().lanEndpointObservation.revision, 8, "the reconciled revision is durably persisted before a subsequent retry");
    assert.equal(store.getPlatform().paired, false, "revision reconciliation does not manufacture machine pairing");
    assert.deepEqual(store.getSyncOutbox(), outboxBeforeReconciliation, "LAN recovery does not acknowledge or mutate household sync events");
    assert.equal(maximumActiveRequests, 1, "revision reconciliation remains serialized with endpoint reports");
    pairing.stop();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("an existing active machine credential is reconciled before normal sync without repeating pairing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-existing-credential-reconcile-"));
  try {
    const serial = "DINODIA-EXISTING-CREDENTIAL-RECONCILE";
    const store = new Store(path.join(directory, "dinodia.json"));
    await store.saveIdentity({ serial });
    const vault = new SecretVault({ dataDir: directory });
    const identity = generateManufacturingIdentity({ serial });
    const record = vaultIdentityRecord(identity);
    await vault.set("platform.identityPrivateKey", record.signingPrivateKey);
    await vault.set("platform.identityPublicKey", record.signingPublicKey);
    await vault.set("platform.encryptionPrivateKey", record.encryptionPrivateKey);
    await vault.set("platform.encryptionPublicKey", record.encryptionPublicKey);
    await vault.set("platform.identityFingerprint", record.publicKeyFingerprint);
    await vault.set("platform.encryptionFingerprint", record.encryptionKeyFingerprint);
    await vault.set("platform.identityGeneration", "1");
    const machineCredential = "dno-existing-current-machine-credential";
    await vault.set("platform.machineCredential", machineCredential);
    await store.savePlatform({ paired: false, provisioningCredentialVersion: 0, apiUrl: "https://platform.test" });

    const hubInstallId = "33333333-3333-4333-8333-333333333333";
    const homeId = "44444444-4444-4444-8444-444444444444";
    const paths = [];
    let reconcileRequests = 0;
    let signalReconcileStarted;
    let releaseReconcile;
    const reconcileStarted = new Promise((resolve) => { signalReconcileStarted = resolve; });
    const reconcileGate = new Promise((resolve) => { releaseReconcile = resolve; });
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000,
      runtime: { nodeEnv: "test" },
      fetchImpl: async (url, options) => {
        const requestPath = new URL(url).pathname;
        paths.push(requestPath);
        const body = JSON.parse(options.body || "{}");
        if (requestPath.endsWith("/pairing/reconcile")) {
          reconcileRequests += 1;
          if (reconcileRequests === 1) {
            signalReconcileStarted();
            await reconcileGate;
          }
          assert.equal(options.headers["x-dinodia-hub-signature"]?.length > 0, true, "only the registered manufacturing identity asks Platform to validate the retained credential fingerprint");
          assert.equal(Object.hasOwn(options.headers, "x-dinodia-machine-signature"), false);
          assert.deepEqual(Object.keys(body).sort(), ["credentialFingerprint", "identityGeneration", "serial"].sort());
          assert.equal(body.credentialFingerprint, crypto.createHash("sha256").update(machineCredential, "utf8").digest("hex"));
          assert.equal(JSON.stringify(body).includes(machineCredential), false, "the machine credential itself is never sent");
          return { ok: true, status: 200, async json() { return { ok: true, paired: true, version: 1, hubInstallId, homeId }; } };
        }
        if (requestPath.endsWith("/token-state")) return { ok: true, async json() { return { hubInstallId, homeId, latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [], areaBindings: [], policyRevision: 1, syncStreamId: null, syncAcceptedSequence: 0 }; } };
        if (requestPath.endsWith("/v2/sync")) return { ok: true, async json() { return nativeSyncAck(body); } };
        if (requestPath.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: { revision: body.lanEndpoint.revision, state: body.lanEndpoint.state } }; } };
        throw new Error(`Unexpected Platform route during existing-credential recovery: ${requestPath}`);
      },
    });

    const firstSync = pairing.syncNow();
    await reconcileStarted;
    const overlappingSync = await pairing.syncNow();
    releaseReconcile();
    await firstSync;

    assert.equal(overlappingSync, null, "overlapping interval ticks cannot start duplicate reconciliation or parallel sync while the original request is in flight");
    assert.equal(reconcileRequests, 1, "one in-flight reconciliation is serialized");
    assert.equal(store.getPlatform().paired, true, "the active retained credential is adopted only after Platform confirms its exact current fingerprint and installation binding");
    assert.equal(store.getPlatform().provisioningCredentialVersion, 1);
    assert.equal(store.getPlatform().hubInstallId, hubInstallId);
    assert.equal(store.getPlatform().homeId, homeId);
    assert.equal(paths[0], "/api/hub-agent/v2/pairing/reconcile");
    assert.deepEqual(paths.slice(1), ["/api/hub-agent/token-state", "/api/hub-agent/v2/sync", "/api/hub-agent/v2/heartbeat"]);
    assert.equal(paths.some((route) => route.endsWith("/pairing/register") || route.endsWith("/pairing/challenge") || route.endsWith("/pairing/prove") || route.endsWith("/pairing/acknowledge")), false, "reconciliation is not a second provisioning/pairing handshake");
    assert.equal(store.getSyncOutbox().acknowledgedSequence, 0, "credential reconciliation does not fabricate a household sync acknowledgement");
    pairing.stop();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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

function pairingFixture({ serial, hubInstallId, syncStreamId = null, syncAcceptedSequence = 0, configurationRevision = 5, acknowledgedCloudRevision = 5, divergent = false } = {}) {
  const directoryPromise = fs.mkdtemp(path.join(os.tmpdir(), "dinodia-sync-config-recovery-"));
  return directoryPromise.then(async (directory) => {
    const store = new Store(path.join(directory, "dinodia.json"));
    await store.saveIdentity({ serial });
    const vault = new SecretVault({ dataDir: directory });
    const identity = generateManufacturingIdentity({ serial });
    const record = vaultIdentityRecord(identity);
    for (const [key, value] of Object.entries({
      "platform.identityPrivateKey": record.signingPrivateKey,
      "platform.identityPublicKey": record.signingPublicKey,
      "platform.encryptionPrivateKey": record.encryptionPrivateKey,
      "platform.encryptionPublicKey": record.encryptionPublicKey,
      "platform.identityGeneration": "1",
      "platform.machineCredential": "test-machine-credential",
    })) await vault.set(key, value);
    await store.savePlatform({ paired: true, provisioningCredentialVersion: 1, hubInstallId, homeId: "home-a" });
    return { directory, store, vault, syncStreamId, syncAcceptedSequence, configurationRevision, acknowledgedCloudRevision, divergent };
  });
}

function refreshConfiguration(revision) {
  return signedConfiguration({ revision, policyRevision: 1, areas: [], memberships: [], devicePolicies: [], automations: [],
    releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null } });
}

test("an explicit oversized-range rejection is retried as a smaller exact contiguous batch", async () => {
  const serial = "DINODIA-OVERSIZED-SYNC-RECOVERY-HUB";
  const hubInstallId = "11111111-1111-4111-8111-111111111111";
  const fixture = await pairingFixture({ serial, hubInstallId });
  try {
    const { directory, store, vault } = fixture;
    const total = SYNC_BATCH_MAX_EVENTS + 1;
    for (let index = 1; index <= total; index += 1) {
      await store.queueSyncEvent("update.status", "updater", { revision: index, trustState: "unprovisioned" }, { critical: true });
    }
    const streamId = store.getSyncOutbox().streamId;
    const legacyRange = store.state.syncOutbox.events;
    store.state.syncOutbox.inFlight = {
      schemaVersion: 1, hubInstallationId: hubInstallId, streamId, fromSequence: 1, toSequence: total,
      events: structuredClone(legacyRange), queueDepth: total, acknowledgedCloudRevision: 0,
      runtime: { kind: "dinodia_os", version: "pre-cap", capabilities: {} }, sentAt: new Date().toISOString(),
    };
    await store.persist();
    const submitted = [];
    let rejectionSent = false;
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000,
      logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body || "{}");
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0,
          operatorCredentialStates: [], offlineAuthorisations: [], areaBindings: [], policyRevision: 1,
          installationSyncMode: "ACTIVE", syncStreamId: streamId, syncAcceptedSequence: 0,
          cloudConfigurationRevision: 0, acknowledgedCloudRevision: 0,
        }; } };
        if (url.endsWith("/v2/sync")) {
          submitted.push(structuredClone(body));
          if (!rejectionSent) {
            rejectionSent = true;
            return { ok: false, status: 413, async json() { return { ok: false, errorCode: "hub_sync_batch_too_large", error: "Retry this range in smaller contiguous batches" }; } };
          }
          return { ok: true, status: 200, async json() { return nativeSyncAck(body); } };
        }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });

    assert.equal(await pairing.syncNow(), null, "the first authenticated oversized request is safely rejected");
    assert.equal(store.getSyncOutbox().lastErrorCode, "hub_sync_batch_too_large");
    assert.equal(store.getSyncOutbox().acknowledgedSequence, 0);
    assert.equal(store.getSyncOutbox().inFlight.events.length, total, "a rejected request remains durable until the signed cursor is reread");

    pairing.nextRetryAt = 0;
    await pairing.syncNow();
    pairing.stop();
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].events.length, total);
    assert.equal(submitted[1].events.length, SYNC_BATCH_MAX_EVENTS);
    assert.equal(submitted[1].fromSequence, 1);
    assert.equal(submitted[1].toSequence, SYNC_BATCH_MAX_EVENTS);
    assert.deepEqual(submitted[1].events.map((event) => event.id), legacyRange.slice(0, SYNC_BATCH_MAX_EVENTS).map((event) => event.id));
    assert.equal(store.getSyncOutbox().acknowledgedSequence, SYNC_BATCH_MAX_EVENTS);
    assert.deepEqual(store.getSyncOutbox().events.map((event) => event.sequence), [total]);
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
});

test("stale configuration refresh applies policy without consuming the durable event batch", async () => {
  const serial = "DINODIA-CONFIG-REFRESH-HUB";
  const hubInstallId = "11111111-1111-4111-8111-111111111111";
  const fixture = await pairingFixture({ serial, hubInstallId });
  try {
    const { directory, store, vault } = fixture;
    await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
    const originalBatch = await store.prepareSyncBatch(hubInstallId, { kind: "dinodia_os", version: "test", capabilities: {} });
    assert.ok(originalBatch);
    const seen = [];
    let outboxDuringConfigurationRefresh = null;
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000, logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [], policyRevision: 1, installationSyncMode: "ACTIVE", syncStreamId: null, syncAcceptedSequence: 0,
          cloudConfigurationRevision: 5, acknowledgedCloudRevision: 5,
        }; } };
        if (url.endsWith("/v2/sync")) {
          seen.push(structuredClone(body));
          const configuration = refreshConfiguration(5);
          if (body.configurationRefreshOnly === true) {
            outboxDuringConfigurationRefresh = store.getSyncOutbox();
            return { ok: true, async json() { return {
              configurationRefreshOnly: true, streamId: body.streamId, syncStreamId: null, syncAcceptedSequence: 0,
              cloudRevision: 5, configurationAppliedRevision: body.acknowledgedCloudRevision,
              configuration, resnapshotRequired: false,
            }; } };
          }
          return { ok: true, async json() { return {
            streamId: body.streamId, cloudRevision: 5, configurationAppliedRevision: body.acknowledgedCloudRevision,
            acceptedThroughSequence: body.toSequence, resnapshotRequired: false, configuration,
          }; } };
        }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: body.lanEndpoint, lanTlsIdentity: { acknowledgedGeneration: 0 } }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });
    await pairing.syncNow();
    assert.equal(seen[0]?.configurationRefreshOnly, true, "the authenticated configuration-only request precedes event submission");
    assert.equal(seen[0]?.events.length, 0);
    assert.equal(seen[0]?.acknowledgedCloudRevision, 0);
    assert.equal(seen[1]?.configurationRefreshOnly, undefined);
    assert.equal(outboxDuringConfigurationRefresh.acknowledgedSequence, 0);
    assert.deepEqual(outboxDuringConfigurationRefresh.inFlight, originalBatch, "refresh preserves the exact durable in-flight body");
    assert.ok(outboxDuringConfigurationRefresh.events.some((event) => event.sequence === originalBatch.fromSequence));
    assert.equal(store.getSyncOutbox().acknowledgedSequence, originalBatch.toSequence, "the cursor advances only after the subsequent ordinary event acknowledgement");
    pairing.stop();
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
});

test("an explicit stale-descriptor rejection safely replaces only superseded device snapshots before retry", async () => {
  const serial = "DINODIA-DESCRIPTOR-RECONCILE-HUB";
  const hubInstallId = "11111111-1111-4111-8111-111111111111";
  const fixture = await pairingFixture({ serial, hubInstallId, configurationRevision: 5, acknowledgedCloudRevision: 5 });
  let pairing;
  try {
    const { store, vault } = fixture;
    const homeId = "home-a";
    const area = await store.saveArea({ name: "Room 1" }, "os-room-1");
    const canonicalAreaId = "33333333-3333-4333-8333-333333333333";
    const descriptorDigest = "a".repeat(64);
    const devicePolicy = {
      managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED",
      canonicalAreaIds: [canonicalAreaId], platformDeviceId: "44444444-4444-4444-8444-444444444444",
      installationRequestId: "55555555-5555-4555-8555-555555555555", catalogueStatus: "ready", usefulReadings: true,
      descriptorRevision: 1, descriptorDigest, overrideName: "Room 1 Radiator",
    };
    const device = await store.upsertDevice({ id: "zigbee:room-1-radiator", name: "Room 1 Radiator", protocol: "zigbee", areaId: area.id,
      setup: { status: "ready" }, metadata: { model: "TRVZB" },
      entities: { heat: { id: "heat", name: "Heat", domain: "climate", capability: {
        controlId: "target-temperature", kind: "number", readable: true, writable: true,
        bindings: [{ serviceId: "climate.set_temperature" }],
      } } } }, { devicePolicy });

    const canonicalEvents = store.getSyncOutbox().events.filter((event) => event.aggregateId === device.id);
    const staleDigest = "b".repeat(64);
    const makeStale = (sequence, source) => ({ ...structuredClone(source), id: `descriptor-event-${sequence}`,
      sequence, occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(),
      payload: { ...source.payload, descriptorDigest: staleDigest } });
    const pendingEvents = [11, 12].map((sequence) => ({ id: `descriptor-event-${sequence}`, sequence, type: "sync.compacted",
      aggregateId: "", occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(), critical: false, payload: { supersededBy: 37 } }));
    for (let sequence = 13; sequence <= 36; sequence += 1) {
      const source = canonicalEvents[(sequence - 11) % canonicalEvents.length];
      pendingEvents.push(makeStale(sequence, source));
    }
    const outbox = store.state.syncOutbox;
    const streamId = outbox.streamId;
    outbox.acknowledgedSequence = 10;
    outbox.cloudRevision = 5;
    outbox.configurationAppliedRevision = 5;
    outbox.nextSequence = 37;
    outbox.snapshotCreatedAt = new Date(1_800_000_000_000).toISOString();
    outbox.snapshotDeviceIds = [device.id];
    outbox.events = pendingEvents;
    outbox.lastErrorCode = "hub_sync_descriptor_stale";
    outbox.inFlight = {
      schemaVersion: 1, hubInstallationId: hubInstallId, streamId, fromSequence: 11, toSequence: 14,
      events: pendingEvents.slice(0, 4), queueDepth: pendingEvents.length,
      acknowledgedCloudRevision: 5,
      runtime: { kind: "dinodia_os", version: "test", capabilities: { nativeSyncOutbox: {
        queueDepth: pendingEvents.length, lastErrorCode: "hub_sync_descriptor_stale",
      } } },
      sentAt: new Date(1_800_000_000_000).toISOString(),
    };
    await store.persist();

    const configuration = signedConfiguration({ revision: 5, policyRevision: 1,
      areas: [{ id: canonicalAreaId, osAreaId: area.id, originalName: "Room 1", overrideName: null, revision: 1 }],
      memberships: [], devicePolicies: [{ osDeviceId: device.id, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
        analyticsCategory: "RADIATOR", lifecycle: "INSTALLED", customerLabel: "Radiator", overrideName: "Room 1 Radiator",
        descriptorRevision: 1, descriptorDigest, osAreaIds: [area.id] }],
      automations: [], releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null } });
    let remoteAcceptedSequence = 10;
    let remoteStreamId = streamId;
    const sentBatches = [];
    pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000, logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId, latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [{ areaId: canonicalAreaId, hubAreaId: area.id }], policyRevision: 1, installationSyncMode: "ACTIVE",
          syncStreamId: remoteStreamId, syncAcceptedSequence: remoteAcceptedSequence,
          cloudConfigurationRevision: 5, acknowledgedCloudRevision: 5,
        }; } };
        if (url.endsWith("/v2/sync")) {
          sentBatches.push(structuredClone(body));
          assert.equal(body.streamId, remoteStreamId);
          assert.equal(Number(body.fromSequence), remoteAcceptedSequence + 1);
          remoteAcceptedSequence = Number(body.toSequence);
          return { ok: true, async json() { return {
            streamId: body.streamId, cloudRevision: 5, configurationAppliedRevision: 5,
            acceptedThroughSequence: remoteAcceptedSequence, resnapshotRequired: false, configuration,
          }; } };
        }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: body.lanEndpoint, lanTlsIdentity: { acknowledgedGeneration: 0 } }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });

    await pairing.syncNow();
    const deadline = Date.now() + 1000;
    while (store.getSyncOutbox().acknowledgedSequence < 38 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    pairing.stop();
    assert.ok(sentBatches.length >= 2, "the current exact range is retried, then the refreshed canonical snapshot is sent");
    assert.deepEqual(sentBatches[0].events.slice(2).map((event) => event.type), ["sync.compacted", "sync.compacted"]);
    assert.deepEqual(sentBatches[0].events.map((event) => event.critical), [false, false, true, true],
      "the stale critical snapshots keep their classification even when represented by no-payload markers");
    assert.equal(sentBatches[0].fromSequence, 11);
    assert.equal(sentBatches[0].toSequence, 14);
    assert.equal(sentBatches[1].fromSequence, 15);
    assert.equal(sentBatches[1].toSequence, 38);
    assert.ok(sentBatches[1].events.slice(-2).every((event) => event.payload.descriptorDigest === descriptorDigest));
    assert.deepEqual(sentBatches[1].events.slice(-2).map((event) => event.type), ["device.upsert", "control.catalog.upsert"]);
    assert.equal(store.getSyncOutbox().acknowledgedSequence, 38);
    assert.equal(store.getSyncOutbox().lastErrorCode, null);
  } finally {
    pairing?.stop();
    const stopDeadline = Date.now() + 2000;
    while (pairing?.syncing && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a divergent stream reconciles one exact durable batch and retries the same request after a lost response", async () => {
  const serial = "DINODIA-CONFIG-REFRESH-DIVERGED-HUB";
  const hubInstallId = "22222222-2222-4222-8222-222222222222";
  const serverStreamId = "remote-stream-accepted-18";
  const fixture = await pairingFixture({ serial, hubInstallId, syncStreamId: serverStreamId, syncAcceptedSequence: 18, divergent: true });
  try {
    const { directory, store, vault } = fixture;
    await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
    const staleBatch = await store.prepareSyncBatch(hubInstallId, { kind: "dinodia_os", version: "test", capabilities: {} });
    assert.equal(staleBatch.acknowledgedCloudRevision, 0);
    await store.applySyncConfigurationSnapshot(5);
    await store.commit((state) => {
      state.syncOutbox.inFlight = {
        ...staleBatch,
        streamReconciliation: { version: 1, previousStreamId: serverStreamId, previousAcceptedSequence: 18 },
      };
    });
    await store.markSyncFailure("hub_sync_configuration_ack_invalid");
    assert.equal(store.getSyncOutbox().inFlight.acknowledgedCloudRevision, 0, "fixture preserves the stale pre-refresh in-flight revision");
    const seen = [];
    let remoteStreamId = serverStreamId;
    let remoteAcceptedSequence = 18;
    let remoteCommitted = false;
    let committedEnvelope = null;
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000, logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [], policyRevision: 1, installationSyncMode: "ACTIVE", syncStreamId: remoteStreamId, syncAcceptedSequence: remoteAcceptedSequence,
          cloudConfigurationRevision: 5, acknowledgedCloudRevision: 5,
        }; } };
        if (url.endsWith("/v2/sync")) {
          seen.push(structuredClone(body));
          const configuration = refreshConfiguration(5);
          if (!remoteCommitted) {
            if (body.acknowledgedCloudRevision !== 5) return {
              ok: false, status: 409,
              async json() { return { errorCode: "hub_sync_configuration_ack_invalid", error: "The hub configuration acknowledgement is stale" }; },
            };
            assert.deepEqual(body.streamReconciliation, {
              version: 1, previousStreamId: serverStreamId, previousAcceptedSequence: 18,
            });
            assert.equal(body.fromSequence, 1);
            assert.equal(body.events.length, 1);
            committedEnvelope = structuredClone(body);
            remoteStreamId = body.streamId;
            remoteAcceptedSequence = body.toSequence;
            remoteCommitted = true;
            throw new Error("simulated lost reconciliation response");
          }
          assert.deepEqual(body, committedEnvelope, "retry retains the exact signed batch and reconciliation marker");
          return { ok: true, async json() { return {
            streamReconciled: true, reconciledFromStreamId: serverStreamId, reconciledFromSequence: 18,
            streamId: body.streamId, syncStreamId: remoteStreamId, syncAcceptedSequence: remoteAcceptedSequence,
            acceptedThroughSequence: remoteAcceptedSequence, duplicate: true,
            cloudRevision: 5, configurationAppliedRevision: body.acknowledgedCloudRevision,
            configuration, resnapshotRequired: false,
          }; } };
        }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: body.lanEndpoint, lanTlsIdentity: { acknowledgedGeneration: 0 } }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });
    await pairing.syncNow();
    assert.equal(seen[0]?.acknowledgedCloudRevision, 5, "the rejected stale envelope is repaired to the durably applied configuration revision before reconciliation");
    const afterLostResponse = store.getSyncOutbox();
    assert.equal(afterLostResponse.inFlight?.acknowledgedCloudRevision, 5, "the corrected request revision is durable before retry");
    assert.equal(afterLostResponse.acknowledgedSequence, 0, "a lost response does not fabricate a local acknowledgement");
    assert.ok(afterLostResponse.inFlight?.streamReconciliation, "the exact recovery marker is durable before retry");
    assert.equal(afterLostResponse.events.length, 1, "the pending event remains durable until a receipt arrives");
    pairing.nextRetryAt = 0;
    await pairing.syncNow();
    const after = store.getSyncOutbox();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(after.acknowledgedSequence, 1, "the local cursor advances only after the exact authenticated receipt");
    assert.deepEqual(after.events, []);
    assert.equal(after.inFlight, null);
    assert.equal(after.lastErrorCode, null);
    pairing.stop();
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
});

test("request-loss recovery refuses a changed signed remote cursor before sending its replacement stream", async () => {
  const serial="DINODIA-REQUEST-LOSS-CURSOR-GUARD";
  const hubInstallId="22222222-2222-4222-8222-222222222222";
  const fixture=await pairingFixture({serial,hubInstallId});
  let pairing;
  try {
    const {store,vault}=fixture;
    await store.queueSyncEvent("update.status","updater",{revision:1,trustState:"unprovisioned"},{critical:true});
    await store.commit(state=>{
      state.syncOutbox.cloudRevision=5;state.syncOutbox.configurationAppliedRevision=5;
      state.syncOutbox.requestLossRecovery={version:1,previousStreamId:"reviewed-previous-stream",serverAcceptedSequence:17,completedAt:null};
    });
    const before=store.getSyncOutbox();let syncRequests=0;
    pairing=new PlatformPairing({store,vault,apiUrl:"https://platform.test",serial,logger:{error(){},warn(){}},
      fetchImpl:async url=>{
        if(url.endsWith("/token-state"))return {ok:true,async json(){return {
          hubInstallId,homeId:"home-a",latestVersion:0,publishedVersion:0,operatorCredentialStates:[],offlineAuthorisations:[],
          areaBindings:[],policyRevision:1,installationSyncMode:"ACTIVE",syncStreamId:"reviewed-previous-stream",
          syncAcceptedSequence:18,cloudConfigurationRevision:5,acknowledgedCloudRevision:5,
        };}};
        if(url.endsWith("/v2/sync"))syncRequests++;
        throw Error("No sync mutation should be sent for changed recovery authority");
      }});
    await pairing.syncNow();
    const after=store.getSyncOutbox();
    assert.equal(syncRequests,0);
    assert.equal(after.lastErrorCode,"hub_sync_request_loss_remote_changed");
    assert.equal(after.acknowledgedSequence,0);
    assert.deepEqual(after.events,before.events);
    assert.equal(after.inFlight,null);
  } finally {pairing?.stop();await fs.rm(fixture.directory,{recursive:true,force:true});}
});

test("verified Store rollback waits for signed same-Home cursor, archives old outbox and reconciles a fresh inventory snapshot", async () => {
  const serial = "DINODIA-STORE-ROLLBACK-RECOVERY-HUB";
  const hubInstallId = "11111111-1111-4111-8111-111111111111";
  const homeId = "home-store-recovery";
  const previousStreamId = "verified-backup-stream-0001";
  const fixture = await pairingFixture({ serial, hubInstallId, syncStreamId: previousStreamId, syncAcceptedSequence: 18,
    configurationRevision: 5, acknowledgedCloudRevision: 5 });
  let pairing;
  try {
    const { store, vault } = fixture;
    const area = await store.saveArea({ name: "Room 1" }, "room-1");
    const recoveryAreas = [{ id: "canonical-room-1", osAreaId: area.id, originalName: "Room 1", overrideName: null, revision: 1 }];
    for (let index = 2; index <= 46; index += 1) {
      const extraArea = await store.saveArea({ name: `Recovery room ${index}` }, `recovery-room-${index}`);
      recoveryAreas.push({ id: `canonical-room-${index}`, osAreaId: extraArea.id, originalName: extraArea.name, overrideName: null, revision: 1 });
    }
    await store.savePlatform({ paired: true, homeId, hubInstallId, cloudRevision: 0, devicePolicies: {} });
    const device = await store.upsertDevice({ id: "zigbee:room-1-radiator", name: "Room 1 Radiator", protocol: "zigbee", areaId: area.id,
      setup: { status: "ready" }, metadata: { model: "TRVZB" }, entities: {} }, { devicePolicy: {
      managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, lifecycle: "INSTALLED", canonicalAreaIds: ["33333333-3333-4333-8333-333333333333"],
      platformDeviceId: "44444444-4444-4444-8444-444444444444", installationRequestId: "55555555-5555-4555-8555-555555555555",
      catalogueStatus: "ready", usefulReadings: true, descriptorRevision: 1, descriptorDigest: "a".repeat(64), overrideName: "Room 1 Radiator",
    } });
    store.state.syncOutbox = {
      ...store.getSyncOutbox(), streamId: previousStreamId, acknowledgedSequence: 7, nextSequence: 10,
      cloudRevision: 0, configurationAppliedRevision: 0,
      events: [
        { id: "old-usage-8", sequence: 8, type: "usage.bucket", aggregateId: "old-bucket", occurredAt: new Date(8000).toISOString(), critical: false, payload: { revision: 3, osDeviceId: device.id } },
        { id: "old-device-9", sequence: 9, type: "device.upsert", aggregateId: device.id, occurredAt: new Date(9000).toISOString(), critical: true, payload: { osDeviceId: device.id } },
      ],
    };
    store.state.syncOutboxRecovery = { version: 1, backupSha256: "c".repeat(64), previousStreamId,
      backupAcknowledgedSequence: 7, homeId, hubInstallId, preparedAt: new Date().toISOString() };
    await store.persist();

    const configuration = signedConfiguration({ revision: 5, policyRevision: 1,
      areas: recoveryAreas,
      memberships: [], devicePolicies: [{ osDeviceId: device.id, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
        analyticsCategory: "RADIATOR", lifecycle: "INSTALLED", customerLabel: "Radiator", overrideName: "Room 1 Radiator",
        descriptorRevision: 1, descriptorDigest: "a".repeat(64), osAreaIds: [area.id] }],
      automations: [], releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null } });
    const seen = [];
    let runtimeReleaseCalls = 0;
    let remoteStreamId = previousStreamId;
    let remoteAcceptedSequence = 18;
    pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000,
      onBackupRecoveryComplete: async () => { runtimeReleaseCalls += 1; return true; },
      logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body || "{}");
        seen.push({ url, body: structuredClone(body) });
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId, latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [], policyRevision: 1, installationSyncMode: "ACTIVE", syncStreamId: remoteStreamId,
          syncAcceptedSequence: remoteAcceptedSequence, cloudConfigurationRevision: 5, acknowledgedCloudRevision: 5,
        }; } };
        if (url.endsWith("/v2/sync") && body.configurationRefreshOnly === true) return { ok: true, async json() { return {
          configurationRefreshOnly: true, streamId: body.streamId, syncStreamId: remoteStreamId,
          syncAcceptedSequence: remoteAcceptedSequence, cloudRevision: 5, configurationAppliedRevision: body.acknowledgedCloudRevision,
          configuration,
        }; } };
        if (url.endsWith("/v2/sync")) {
          if (body.streamReconciliation) {
            assert.equal(body.streamReconciliation.previousStreamId, previousStreamId);
            assert.equal(body.streamReconciliation.previousAcceptedSequence, 18);
            assert.equal(body.fromSequence, 1);
          }
          assert.equal(body.events.some((event) => event.type === "usage.bucket" && event.id === "old-usage-8"), false,
            "rolled-back pending telemetry is archived and never replayed as if it were a current snapshot");
          remoteStreamId = body.streamId;
          remoteAcceptedSequence = body.toSequence;
          return { ok: true, async json() { return {
            streamId: body.streamId, cloudRevision: 5, configurationAppliedRevision: 5,
            acceptedThroughSequence: body.toSequence,
            ...(body.streamReconciliation ? { streamReconciled: true,
              reconciledFromStreamId: previousStreamId, reconciledFromSequence: 18 } : {}),
            resnapshotRequired: false, configuration,
          }; } };
        }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanTlsIdentity: { acknowledgedGeneration: 0 } }; } };
        throw new Error(`Unexpected recovery sync route: ${url}`);
      },
    });

    await pairing.syncNow();
    const recoveryDeadline = Date.now() + 10000;
    while (store.getSyncOutboxRecovery() && Date.now() < recoveryDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    pairing.stop();
    assert.equal(seen[0].url.endsWith("/token-state"), true, "signed authority is checked before local outbox transition");
    const refreshIndexes = seen.map((entry, index) => entry.body.configurationRefreshOnly === true ? index : -1).filter((index) => index >= 0);
    const firstInventorySyncIndex = seen.findIndex((entry) => entry.url.endsWith("/v2/sync") && entry.body.configurationRefreshOnly !== true);
    assert.ok(refreshIndexes.length >= 1 && refreshIndexes[0] < firstInventorySyncIndex,
      "current signed cloud policy is applied before replacement inventory snapshots are generated");
    assert.equal(store.getSyncOutboxRecovery(), null, "the recovery marker clears only after every batch through the durable snapshot boundary is accepted");
    assert.equal(runtimeReleaseCalls, 1, "runtime release is requested only after the complete current inventory snapshot is accepted");
    assert.equal(store.getSyncOutbox().streamId, remoteStreamId);
    assert.equal(store.getSyncOutbox().acknowledgedSequence, remoteAcceptedSequence);
    assert.ok(seen.filter((entry) => entry.url.endsWith("/v2/sync") && !entry.body.configurationRefreshOnly).length >= 2,
      "the 46-area plus device/catalogue snapshot is accepted over multiple receipt-backed batches before runtime release");
    const sentInventory = seen.flatMap((entry) => entry.body.events || []);
    assert.equal(sentInventory.filter((event) => event.type === "area.upsert").length, recoveryAreas.length);
    assert.ok(sentInventory.some((event) => event.type === "device.upsert" && event.payload.osDeviceId === device.id));
    assert.ok(sentInventory.some((event) => event.type === "control.catalog.upsert" && event.payload.osDeviceId === device.id));
    const archivePath = path.join(fixture.directory, `dinodia.json.sync-recovery-${"c".repeat(16)}.json`);
    const archive = JSON.parse(await fs.readFile(archivePath, "utf8"));
    assert.deepEqual(archive.outbox.events.map((event) => event.id), ["old-usage-8", "old-device-9"]);
    assert.equal(archive.outbox.acknowledgedSequence, 7);
  } finally {
    pairing?.stop();
    const stopDeadline = Date.now() + 10000;
    while (pairing?.syncing && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a divergent stream with a known local retention gap remains held without changing the outbox", async () => {
  const serial = "DINODIA-CONFIG-REFRESH-GAP-HUB";
  const hubInstallId = "33333333-3333-4333-8333-333333333333";
  const serverStreamId = "remote-stream-accepted-18-gap";
  const fixture = await pairingFixture({ serial, hubInstallId, syncStreamId: serverStreamId, syncAcceptedSequence: 18 });
  try {
    const { directory, store, vault } = fixture;
    await store.applySyncConfigurationSnapshot(5);
    await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
    store.state.syncOutbox.gapDetected = true;
    await store.persist();
    const before = store.getSyncOutbox();
    const syncRequests = [];
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000, logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [], policyRevision: 1, installationSyncMode: "ACTIVE", syncStreamId: serverStreamId, syncAcceptedSequence: 18,
          cloudConfigurationRevision: 5, acknowledgedCloudRevision: 5,
        }; } };
        if (url.endsWith("/v2/sync")) { syncRequests.push(structuredClone(body)); throw new Error("gap-held stream must not submit events"); }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true, lanEndpoint: body.lanEndpoint, lanTlsIdentity: { acknowledgedGeneration: 0 } }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });
    await pairing.syncNow();
    const after = store.getSyncOutbox();
    assert.deepEqual(syncRequests, []);
    assert.equal(after.acknowledgedSequence, before.acknowledgedSequence);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.inFlight, before.inFlight);
    assert.equal(after.gapDetected, true);
    assert.equal(after.lastErrorCode, "hub_sync_stream_reconciliation_required");
    pairing.stop();
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
});

test("an ambiguous marked in-flight batch is not rewritten without an explicit stale-ack rejection", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-sync-ambiguous-revision-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new Store(path.join(directory, "dinodia.json"));
  const serverStreamId = "remote-stream-accepted-18";
  await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
  const original = await store.prepareSyncBatch("sync-installation", { kind: "dinodia_os", version: "test", capabilities: {} });
  await store.applySyncConfigurationSnapshot(5);
  await store.commit((state) => {
    state.syncOutbox.inFlight = {
      ...original,
      streamReconciliation: { version: 1, previousStreamId: serverStreamId, previousAcceptedSequence: 18 },
    };
  });
  const before = store.getSyncOutbox();

  await assert.rejects(
    store.prepareSyncStreamReconciliation({ previousStreamId: serverStreamId, previousAcceptedSequence: 18 }),
    { code: "hub_sync_stream_reconciliation_required" },
  );
  assert.deepEqual(store.getSyncOutbox(), before, "an uncertain prior response preserves the exact signed request body");
});

test("a new stream-reconciliation marker acknowledges the durably applied configuration revision", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-sync-new-marker-revision-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new Store(path.join(directory, "dinodia.json"));
  const serverStreamId = "remote-stream-accepted-18";
  await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
  const original = await store.prepareSyncBatch("sync-installation", { kind: "dinodia_os", version: "test", capabilities: {} });
  await store.applySyncConfigurationSnapshot(5);

  const reconciled = await store.prepareSyncStreamReconciliation({ previousStreamId: serverStreamId, previousAcceptedSequence: 18 });
  assert.equal(original.acknowledgedCloudRevision, 0);
  assert.equal(reconciled.acknowledgedCloudRevision, 5);
  assert.deepEqual(reconciled.events, original.events, "the durable event payload remains unchanged");
  assert.deepEqual(
    await store.prepareSyncStreamReconciliation({ previousStreamId: serverStreamId, previousAcceptedSequence: 18 }),
    reconciled,
    "the exact newly prepared reconciliation request remains stable on retry",
  );
});

test("restricted installation bootstrap never requests a full Home configuration refresh", async () => {
  const serial = "DINODIA-CONFIG-REFRESH-BOOTSTRAP-HUB";
  const hubInstallId = "33333333-3333-4333-8333-333333333333";
  const fixture = await pairingFixture({ serial, hubInstallId });
  try {
    const { store, vault } = fixture;
    await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
    const before = store.getSyncOutbox();
    const syncRequests = [];
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000, logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [], policyRevision: 1, installationSyncMode: "INSTALLATION_BOOTSTRAP", syncStreamId: null, syncAcceptedSequence: 0,
          cloudConfigurationRevision: 5, acknowledgedCloudRevision: 5,
        }; } };
        if (url.endsWith("/v2/sync")) { syncRequests.push(structuredClone(body)); throw new Error("restricted installation attempted a configuration refresh"); }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });
    await pairing.syncNow();
    const after = store.getSyncOutbox();
    assert.deepEqual(syncRequests, [], "restricted bootstrap does not request the full Home policy snapshot");
    assert.equal(after.cloudRevision, before.cloudRevision);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.inFlight, before.inFlight);
    assert.equal(after.acknowledgedSequence, before.acknowledgedSequence);
    assert.equal(after.lastErrorCode, "hub_sync_configuration_refresh_unavailable");
    pairing.stop();
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
});

test("a missing remote stream identity cannot silently reset a locally acknowledged cursor", async () => {
  const serial = "DINODIA-CONFIG-REFRESH-MISSING-CURSOR-HUB";
  const hubInstallId = "44444444-4444-4444-8444-444444444444";
  const fixture = await pairingFixture({ serial, hubInstallId });
  try {
    const { store, vault } = fixture;
    await store.queueSyncEvent("update.status", "updater", { revision: 1, trustState: "unprovisioned" }, { critical: true });
    const localBatch = await store.prepareSyncBatch(hubInstallId, { kind: "dinodia_os", version: "test", capabilities: {} });
    await store.acknowledgeSyncBatch({ streamId: localBatch.streamId, acceptedThroughSequence: localBatch.toSequence, cloudRevision: 1, configurationAppliedRevision: 1 });
    const before = store.getSyncOutbox();
    const syncRequests = [];
    const pairing = new PlatformPairing({
      store, vault, apiUrl: "https://platform.test", serial, intervalMs: 60000, logger: { error() {}, warn() {} },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith("/token-state")) return { ok: true, async json() { return {
          hubInstallId, homeId: "home-a", latestVersion: 0, publishedVersion: 0, operatorCredentialStates: [], offlineAuthorisations: [],
          areaBindings: [], policyRevision: 1, installationSyncMode: "ACTIVE", syncStreamId: null, syncAcceptedSequence: 0,
          cloudConfigurationRevision: 1, acknowledgedCloudRevision: 1,
        }; } };
        if (url.endsWith("/v2/sync")) { syncRequests.push(structuredClone(body)); throw new Error("missing remote cursor must not receive a new stream"); }
        if (url.endsWith("/heartbeat")) return { ok: true, async json() { return { ok: true, online: true }; } };
        throw new Error(`Unexpected test route: ${url}`);
      },
    });
    await pairing.syncNow();
    const after = store.getSyncOutbox();
    assert.deepEqual(syncRequests, []);
    assert.equal(after.acknowledgedSequence, before.acknowledgedSequence);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.lastErrorCode, "hub_sync_stream_reconciliation_required");
    pairing.stop();
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
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

test("signed property-device policy resolves hub Area IDs to canonical Platform Area IDs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-property-policy-area-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  try {
    const osArea = await store.saveArea({ name: "Room 1" }, "os-room-1");
    const canonicalAreaId = "33333333-3333-4333-8333-333333333333";
    const unsigned = {
      revision: 1, policyRevision: 1,
      areas: [{ id: canonicalAreaId, osAreaId: osArea.id, originalName: "Room 1", overrideName: null, revision: 1 }],
      memberships: [],
      devicePolicies: [{ osDeviceId: "zigbee:radiator-1", managementClass: "PROPERTY_DEVICE", ownerMembershipId: null,
        analyticsCategory: "NONE", inventoryRevision: 1, lifecycle: "INSTALLED", customerLabel: "Radiator", overrideName: "Room 1 Radiator",
        descriptorRevision: 1, descriptorDigest: "a".repeat(64), osAreaIds: [osArea.id] }],
      automations: [], releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
    };
    await applyCloudConfiguration(store, signedConfiguration(unsigned));
    assert.deepEqual(store.getPlatform().devicePolicies["zigbee:radiator-1"].canonicalAreaIds, [canonicalAreaId]);
    assert.deepEqual(store.getPlatform().devicePolicies["zigbee:radiator-1"].osAreaIds, [osArea.id], "the signed hub Area identity remains available");
    const restored = new Store(path.join(directory, "dinodia.json"));
    assert.deepEqual(restored.getPlatform().devicePolicies["zigbee:radiator-1"].canonicalAreaIds, [canonicalAreaId], "restart reconstruction preserves canonical Platform Areas");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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
  let acceptedSequence = 0;
  let acceptedStreamId = null;
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
      if (url.endsWith("/token-state")) return { ok: true, async json() { return { hubInstallId, homeId: "tenant-sync-home", areaBindings: [{ areaId: "public-room", hubAreaId: "os-room" }], latestVersion: 0, publishedVersion: 0, hubTokenHashes: [], operatorCredentialStates: [], offlineAuthorisations: [], syncAcceptedSequence: acceptedSequence, syncStreamId: acceptedStreamId, cloudConfigurationRevision: 2, acknowledgedCloudRevision: 2, installationSyncMode: "ACTIVE", policyRevision: 2 }; } };
      if (url.endsWith("/v2/sync")) return { ok: true, async json() {
        if (body.configurationRefreshOnly === true) return {
          configurationRefreshOnly: true, streamId: body.streamId, syncStreamId: acceptedStreamId,
          syncAcceptedSequence: acceptedSequence, cloudRevision: 2,
          configurationAppliedRevision: body.acknowledgedCloudRevision,
          resnapshotRequired: false, configuration: removalConfiguration,
        };
        if (acceptedStreamId === null) acceptedStreamId = body.streamId;
        assert.equal(body.streamId, acceptedStreamId, "the durable stream identity remains stable across retry");
        assert.ok(body.fromSequence <= acceptedSequence + 1, "server never receives a sequence gap");
        acceptedSequence = Math.max(acceptedSequence, body.toSequence);
        return { streamId: body.streamId, cloudRevision: 2, configurationAppliedRevision: 2, acceptedThroughSequence: acceptedSequence, resnapshotRequired: false, configuration: removalConfiguration };
      } };
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
    nativeApiPort: 8123,
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
