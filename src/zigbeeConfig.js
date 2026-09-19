const fs = require("node:fs/promises");
const path = require("node:path");

function yamlScalar(value) {
  return JSON.stringify(String(value || ""));
}

function buildZigbee2MqttConfiguration({ adapterPath, adapterType = "", mqttUrl = "mqtt://mosquitto:1883", baseTopic = "zigbee2mqtt", discoveryPrefix = "dinodia-ha" } = {}) {
  const lines = [
    `mqtt:`,
    `  server: ${yamlScalar(mqttUrl)}`,
    `  base_topic: ${yamlScalar(baseTopic)}`,
    `homeassistant:`,
    `  enabled: true`,
    `  discovery_topic: ${yamlScalar(discoveryPrefix || "dinodia-ha")}`,
    `  legacy_entity_attributes: false`,
    `  experimental_event_entities: false`,
    `serial:`,
    `  port: ${yamlScalar(adapterPath || "/dev/ttyUSB0")}`,
  ];
  if (adapterType && adapterType !== "unknown") lines.push(`  adapter: ${yamlScalar(adapterType)}`);
  lines.push("frontend:", "  port: 8080", "advanced:", "  log_level: info", "availability:", "  enabled: true", "");
  return lines.join("\n");
}

async function writeZigbee2MqttConfiguration({ dataDir, settings, mqttUrl, baseTopic, discoveryPrefix } = {}) {
  const directory = path.join(String(dataDir || process.cwd()), "zigbee2mqtt");
  const filePath = path.join(directory, "configuration.yaml");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const selectedPath = String(settings?.adapterPath || "");
  const adapterPath = selectedPath.startsWith("/dev/serial/by-id/") ? selectedPath : "/dev/ttyUSB0";
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const previousPath = `${filePath}.previous`;
  const contents = buildZigbee2MqttConfiguration({ adapterPath, adapterType: settings?.adapterType, mqttUrl, baseTopic, discoveryPrefix: discoveryPrefix || settings?.discoveryPrefix });
  try {
    await fs.copyFile(filePath, previousPath);
  } catch {
    // There is no previous configuration on first setup.
  }
  await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  return filePath;
}

module.exports = { buildZigbee2MqttConfiguration, writeZigbee2MqttConfiguration };
