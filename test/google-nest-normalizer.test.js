const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeRaw } = require("../src/integrations/googleNest/deviceNormalizer");

async function fixture(name) { return JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "google-nest", name), "utf8")); }

test("Nest normalization is trait-led, stable, friendly, and heating-focused", async () => {
  const source = await fixture("thermostat-heating.json");
  const first = normalizeRaw(source, { machineKey: "test-key", accountFingerprint: "hmac-sha256:acct" });
  const second = normalizeRaw(source, { machineKey: "test-key", accountFingerprint: "hmac-sha256:acct" });
  const device = first.devices[0];
  assert.equal(first.thermostatDeviceCount, 1);
  assert.deepEqual(first.devices.map((item) => item.id), second.devices.map((item) => item.id));
  assert.equal(device.name, "Living Room Nest");
  assert.equal(device.protocol, "google_nest");
  assert.equal(device.state.current_temperature, 20.3);
  assert.equal(device.state.target_temperature, 21);
  assert.equal(device.state.heating_action, "heating");
  assert.equal(device.state.online, true);
  assert.equal(device.definition.suggestedLabelId, "boiler");
  assert.equal(device.entities[`${device.id}:0:target_temperature`].capability.writable, true);
  assert.equal(device.entities[`${device.id}:0:current_temperature`].capability.writable, false);
  assert.equal(JSON.stringify(device).includes("camera"), false);
});

test("Nest normalization filters unsupported products, disambiguates duplicate names, and keeps offline state", async () => {
  const multiple = normalizeRaw(await fixture("multiple-devices.json"), { machineKey: "key" });
  assert.equal(multiple.devices.length, 2);
  assert.equal(multiple.unsupportedDeviceCount, 2);
  assert.deepEqual(multiple.devices.map((item) => item.name), ["Room", "Room 2"]);
  const offline = normalizeRaw(await fixture("offline-thermostat.json"), { machineKey: "key" }).devices[0];
  assert.equal(offline.available, false);
  assert.equal(offline.state.online, false);
});

test("Nest normalization fails closed on unknown modes and honors tombstones", async () => {
  const source = await fixture("missing-and-unknown-traits.json");
  const result = normalizeRaw(source, { machineKey: "key", ignoredDeviceIds: new Set([source.devices[1].name]) });
  assert.equal(result.devices.length, 1);
  assert.equal(Object.values(result.devices[0].entities).some((entity) => entity.domain === "climate"), false);
});

test("Nest normalization preserves long SDM resource names used for commands", () => {
  const resource = `enterprises/project/devices/${"x".repeat(145)}`;
  const device = normalizeRaw({ devices: [{ name: resource, type: "sdm.devices.types.THERMOSTAT", traits: { "sdm.devices.traits.Connectivity": { status: "ONLINE" }, "sdm.devices.traits.ThermostatMode": { mode: "HEAT", availableModes: ["OFF", "HEAT"] } } }] }, { machineKey: "key" }).devices[0];
  assert.equal(device.protocolIdentity.resourceName, resource);
  assert.equal(device.metadata.resource_name, resource);
});
