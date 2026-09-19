const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");
const { normalizeRaw } = require("../src/integrations/googleNest/deviceNormalizer");
const { DEVELOPER_VAULT_KEY, ACCOUNT_VAULT_KEY } = require("../src/integrations/googleNest/oauthCredentialProvider");
const { selectLegacyGoogleNestDevice } = require("../src/integrations/googleNest/deviceReconciliation");

function device(id, { model = "Display-3.1", room = "Entryway", accountFingerprint = "" } = {}) {
  return {
    id,
    protocol: "google_nest",
    protocolIdentity: { resourceName: `enterprises/project/devices/${id}`, accountFingerprint },
    metadata: { model, room_hint: room },
  };
}

test("Nest resource changes reconcile by account, model, and room without losing the existing record", () => {
  const existing = device("old-resource", { accountFingerprint: "hmac-sha256:account" });
  const incoming = device("new-resource", { accountFingerprint: "hmac-sha256:account" });
  assert.equal(selectLegacyGoogleNestDevice({ incoming, incomingDevices: [incoming], existingDevices: [existing] }), existing);
});

test("a single thermostat can reconcile when Google omits a room hint", () => {
  const existing = device("old-resource", { room: "" });
  const incoming = device("new-resource", { room: "" });
  assert.equal(selectLegacyGoogleNestDevice({ incoming, incomingDevices: [incoming], existingDevices: [existing] }), existing);
});

test("ambiguous legacy thermostats are not guessed", () => {
  const first = device("old-one");
  const second = device("old-two");
  const incoming = device("new-resource");
  assert.equal(selectLegacyGoogleNestDevice({ incoming, incomingDevices: [incoming], existingDevices: [first, second] }), null);
});

test("a device from a different Nest account is never reconciled", () => {
  const existing = device("old-resource", { accountFingerprint: "hmac-sha256:account-a" });
  const incoming = device("new-resource", { accountFingerprint: "hmac-sha256:account-b" });
  assert.equal(selectLegacyGoogleNestDevice({ incoming, incomingDevices: [incoming], existingDevices: [existing] }), null);
});

test("used legacy records cannot be selected twice during one snapshot", () => {
  const existing = device("old-resource");
  const first = device("new-one");
  const second = device("new-two");
  const usedIds = new Set([existing.id]);
  assert.equal(selectLegacyGoogleNestDevice({ incoming: first, incomingDevices: [first, second], existingDevices: [existing], usedIds }), null);
});

function apiResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false }; }, async command() {}, async refresh() {} };
}

test("server refresh migrates a changed Nest resource and preserves operator setup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-google-nest-reconcile-"));
  const oldResource = "enterprises/project-1/devices/old-resource";
  const newResource = "enterprises/project-1/devices/new-resource";
  const oldRaw = {
    name: oldResource,
    type: "sdm.devices.types.THERMOSTAT",
    parentRelations: [{ displayName: "Entryway" }],
    traits: {
      "sdm.devices.traits.Info": { customName: "Entryway Nest", deviceModel: "Display-3.1" },
      "sdm.devices.traits.Connectivity": { status: "ONLINE" },
      "sdm.devices.traits.Temperature": { ambientTemperatureCelsius: 20 },
      "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] },
      "sdm.devices.traits.ThermostatTemperatureSetpoint": { heatCelsius: 21 },
      "sdm.devices.traits.ThermostatHvac": { status: "OFF" },
    },
  };
  const newRaw = { ...oldRaw, name: newResource, traits: { ...oldRaw.traits, "sdm.devices.traits.Info": { ...oldRaw.traits["sdm.devices.traits.Info"], customName: "Entryway Nest (current)" } } };
  const fetchImpl = async (url) => String(url).endsWith("/token")
    ? apiResponse({ access_token: "access-1", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/sdm.service" })
    : apiResponse({ devices: [newRaw] });
  const hub = createHub({
    config: { nodeEnv: "development", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), cloudflarePublicHostname: "hub.example.com", otbrUrl: "", googleNestEnabled: true },
    googleNestFetchImpl: fetchImpl,
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    hiveBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: true, connected: true, hostname: "hub.example.com" }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  try {
    await hub.vault.set(DEVELOPER_VAULT_KEY, JSON.stringify({ deviceAccessProjectId: "project-1", oauthClientId: "client-1", oauthClientSecret: "client-secret", registeredRedirectUri: "https://hub.example.com/_dinodia/oauth/google-nest/callback", releaseChannel: "sandbox_beta" }));
    await hub.vault.set(ACCOUNT_VAULT_KEY, JSON.stringify({ refreshToken: "refresh-1", grantedScope: "https://www.googleapis.com/auth/sdm.service", accountFingerprint: "hmac-sha256:account" }));
    await hub.store.saveGoogleNest({ configured: true, status: "connected" });
    await hub.store.saveArea({ name: "Entryway" }, "entryway");
    const oldDevice = normalizeRaw({ devices: [oldRaw] }, { machineKey: hub.vault.key, accountFingerprint: "hmac-sha256:account" }).devices[0];
    await hub.store.upsertDevice(oldDevice);
    await hub.store.completeDeviceSetup(oldDevice.id, { name: "Nest Boiler", areaId: "entryway", labelId: "boiler" });

    await hub.googleNest.refresh({ reason: "test-resource-reconciliation" });

    const devices = hub.store.listDevices().filter((device) => device.protocol === "google_nest");
    assert.equal(devices.length, 1);
    const migrated = devices[0];
    assert.notEqual(migrated.id, oldDevice.id);
    assert.equal(migrated.name, "Nest Boiler");
    assert.equal(migrated.areaId, "entryway");
    assert.deepEqual(migrated.labels, ["boiler"]);
    assert.equal(migrated.setup.status, "ready");
    assert.equal(migrated.protocolIdentity.resourceName, newResource);
    assert.equal(hub.store.getDevice(oldDevice.id).id, migrated.id);
    assert.equal(hub.store.getGoogleNest().lastSuccessfulPollAt !== null, true);
  } finally {
    await hub.stop();
  }
});
