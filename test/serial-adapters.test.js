const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listSerialAdapters, probeSerialAdapter, prettyName, adapterProfile } = require("../src/serialAdapters");

test("SONOFF MG21 firmware is identified as an Ember adapter", () => {
  assert.equal(adapterProfile("usb-Sonoff_Dongle_Lite_MG21_123456").adapterType, "ember");
  assert.equal(adapterProfile("usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_123456").adapterType, "ember");
  assert.equal(adapterProfile("usb-Sonoff_ZBDongle-P_123456").adapterType, "zstack");
});

test("serial adapter discovery prefers stable by-id paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-serial-"));
  await fs.mkdir(path.join(root, "serial", "by-id"), { recursive: true });
  await fs.symlink("../../ttyACM0", path.join(root, "serial", "by-id", "usb-Sonoff_Zigbee_3.0_USB_Dongle-if00"));
  const adapters = await listSerialAdapters(root);
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].source, "stable-id");
  assert.match(adapters[0].name, /Sonoff Zigbee/);
  assert.equal(prettyName("usb-Home_Assistant_Connect_ZBT-1"), "Home Assistant Connect ZBT 1");
  const probe = await probeSerialAdapter(adapters[0].path, root);
  assert.equal(probe.ok, true);
  assert.equal(probe.verified, false);
});
