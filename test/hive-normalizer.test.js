const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeHiveDevices, classification, heatingState, suggestedLabelId } = require("../src/integrations/hive/deviceNormalizer");

async function fixture(name) {
  return JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "hive", name), "utf8"));
}

test("Hive normalization produces stable, friendly, heating-only household DTOs", async () => {
  const source = await fixture("heating-account.json");
  const options = { machineKey: Buffer.from("test-machine-key"), username: "owner@example.com" };
  const first = normalizeHiveDevices(source, options);
  const second = normalizeHiveDevices(source, options);

  assert.equal(first.devices.length, 2);
  assert.equal(first.heatingDeviceCount, 2);
  assert.equal(first.unsupportedProductCount, 1);
  assert.equal(first.accountFingerprint, second.accountFingerprint);
  assert.deepEqual(first.devices.map((device) => device.id), second.devices.map((device) => device.id));
  assert.deepEqual(first.devices.map((device) => device.name), ["Downstairs", "Upstairs"]);
  assert.equal(first.devices[0].protocol, "hive");
  assert.equal(first.devices[0].protocolIdentity.cloudId, "zone-downstairs");
  assert.equal(first.devices[0].metadata.cloud_id, "zone-downstairs");
  assert.equal(first.devices[0].entities[`${first.devices[0].id}:0:target_temperature`].capability.writable, true);
  assert.equal(first.devices[0].entities[`${first.devices[0].id}:0:current_temperature`].capability.writable, false);
  assert.equal(first.devices[0].entities[`${first.devices[0].id}:0:target_temperature`].capability.constraints.max, 32);
  assert.equal(first.devices[0].state.mode, "auto");
  assert.equal(first.devices[0].state.target_temperature, 21);
  assert.equal(first.devices[0].state.heating_action, "idle");
  assert.equal(first.devices[0].definition.suggestedLabelId, "boiler");
  assert.equal(JSON.stringify(first).includes("owner@example.com"), false);
  assert.equal(JSON.stringify(first).includes("receiver-home-3"), false);
  assert.equal(JSON.stringify(first).includes("hot-water-home-3"), false);
});

test("Hive TRV products receive a Radiator setup suggestion without changing their stable identity", () => {
  assert.equal(suggestedLabelId({ kind: "heating", role: "trvcontrol", model: "TRV" }), "radiator");
});

test("duplicate Hive zone names are disambiguated without changing cloud identity", async () => {
  const result = normalizeHiveDevices(await fixture("duplicate-zone-names.json"), { machineKey: "key" });
  assert.deepEqual(result.devices.map((device) => device.name), ["Room", "Room 2"]);
  assert.deepEqual(result.devices.map((device) => device.protocolIdentity.cloudId), ["zone-1", "zone-2"]);
});

test("malformed, infrastructure, hot-water, duplicate and offline records are handled safely", async () => {
  const result = normalizeHiveDevices(await fixture("malformed-products.json"), { machineKey: "key" });
  assert.equal(result.devices.length, 1);
  assert.equal(result.unsupportedProductCount, 1);
  assert.equal(result.devices[0].available, false);
  assert.equal(result.devices[0].state.online, false);
  assert.equal(classification({ kind: "receiver" }), "infrastructure");
  assert.equal(classification({ kind: "hot-water" }), "hot_water");
  assert.equal(heatingState({ state: { mode: "OFF", action: "heating" } }).heating_action, "off");
});
