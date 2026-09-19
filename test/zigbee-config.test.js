const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildZigbee2MqttConfiguration, writeZigbee2MqttConfiguration } = require("../src/zigbeeConfig");

test("Zigbee2MQTT configuration uses the selected stable coordinator path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-z2m-"));
  const stablePath = "/dev/serial/by-id/usb-Home_Assistant_Connect_ZBT-1-if00";
  const output = buildZigbee2MqttConfiguration({ adapterPath: stablePath, adapterType: "ember" });
  assert.match(output, new RegExp(`port: \\"${stablePath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\"`));
  assert.match(output, /adapter: "ember"/);

  const filePath = await writeZigbee2MqttConfiguration({
    dataDir: directory,
    settings: { adapterPath: stablePath, adapterType: "ember" },
    mqttUrl: "mqtt://mosquitto:1883",
    baseTopic: "zigbee2mqtt",
  });
  assert.equal(filePath, path.join(directory, "zigbee2mqtt", "configuration.yaml"));
  assert.match(await fs.readFile(filePath, "utf8"), /usb-Home_Assistant_Connect_ZBT-1-if00/);
});
