const path = require("node:path");

function stringEnv(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : String(value).trim();
}

function numberEnv(name, fallback) {
  const value = Number(stringEnv(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const nodeEnv = stringEnv("NODE_ENV", "development");
const dataDir = path.resolve(stringEnv("DINODIA_DATA_DIR", path.join(process.cwd(), "data")));
const adminToken = stringEnv("DINODIA_ADMIN_TOKEN", nodeEnv === "production" ? "" : "dev-token");
const nativeAutomationsMode = ["off", "read_only", "enabled"].includes(stringEnv("DINODIA_NATIVE_AUTOMATIONS_MODE", nodeEnv === "production" ? "read_only" : "enabled"))
  ? stringEnv("DINODIA_NATIVE_AUTOMATIONS_MODE", nodeEnv === "production" ? "read_only" : "enabled")
  : "read_only";

module.exports = {
  nodeEnv,
  haPort: numberEnv("DINODIA_HA_PORT", 8123),
  hubAgentPort: numberEnv("DINODIA_HUB_AGENT_PORT", 8099),
  haHost: stringEnv("DINODIA_HA_HOST", "0.0.0.0"),
  dataDir,
  dataFile: path.join(dataDir, "dinodia.json"),
  backupDir: path.join(dataDir, "backups"),
  adminToken,
  mqttUrl: stringEnv("MQTT_URL", ""),
  zigbeeBaseTopic: stringEnv("ZIGBEE2MQTT_BASE_TOPIC", "zigbee2mqtt"),
  zigbeeDiscoveryPrefix: stringEnv("ZIGBEE2MQTT_DISCOVERY_PREFIX", "dinodia-ha"),
  zigbeeAdapterPath: stringEnv("ZIGBEE_ADAPTER_PATH", ""),
  zigbeePairingSeconds: Math.max(30, Math.min(numberEnv("DINODIA_ZIGBEE_PAIRING_SECONDS", 120), 254)),
  zigbeeEventDedupeMs: Math.max(250, Math.min(numberEnv("DINODIA_ZIGBEE_EVENT_DEDUPE_MS", 1500), 10000)),
  zigbeeAutoRestart: stringEnv("DINODIA_ZIGBEE_AUTO_RESTART", "true") === "true",
  composeFile: stringEnv("DINODIA_COMPOSE_FILE", path.join(process.cwd(), "docker-compose.yml")),
  envFile: stringEnv("DINODIA_ENV_FILE", path.join(process.cwd(), ".env")),
  matterServerUrl: stringEnv("MATTER_SERVER_URL", ""),
  matterPairingTtlMs: Math.max(60000, Math.min(numberEnv("DINODIA_MATTER_PAIRING_TTL_MS", 300000), 900000)),
  otbrUrl: stringEnv("OTBR_URL", ""),
  threadRcpDevice: stringEnv("THREAD_RCP_DEVICE", ""),
  threadRcpBaudRate: Math.max(1, numberEnv("THREAD_RCP_BAUDRATE", 460800)),
  otInfraIf: stringEnv("OT_INFRA_IF", "eth0"),
  otThreadIf: stringEnv("OT_THREAD_IF", "wpan0"),
  cloudflareTunnelToken: stringEnv("CLOUDFLARE_TUNNEL_TOKEN", ""),
  cloudflarePublicHostname: stringEnv("CLOUDFLARE_PUBLIC_HOSTNAME", ""),
  cloudflaredBinary: stringEnv("CLOUDFLARED_BIN", "cloudflared"),
  platformHeartbeatUrl: stringEnv("DINODIA_PLATFORM_HEARTBEAT_URL", ""),
  platformToken: stringEnv("DINODIA_PLATFORM_TOKEN", ""),
  platformApiUrl: stringEnv("DINODIA_PLATFORM_API_URL", "https://app.dinodiasmartliving.com"),
  platformBootstrapSecret: stringEnv("DINODIA_PLATFORM_BOOTSTRAP_SECRET", ""),
  platformSyncIntervalMs: numberEnv("DINODIA_PLATFORM_SYNC_INTERVAL_MS", 120000),
  alexaNativeEnabled: stringEnv("ALEXA_NATIVE_DINODIA_OS_ENABLED", "false") === "true",
  alexaConnectIntentsEnabled: stringEnv("ALEXA_CONNECT_INTENTS_ENABLED", "false") === "true",
  alexaNativeMaxStaleMs: Math.max(60000, Math.min(numberEnv("ALEXA_NATIVE_MAX_STALE_MS", 300000), 3600000)),
  stateChangeUrl: stringEnv("DINODIA_STATE_CHANGE_URL", ""),
  stateChangeSecret: stringEnv("DINODIA_STATE_CHANGE_SECRET", ""),
  haToken: stringEnv("DINODIA_HA_TOKEN", ""),
  haUsername: stringEnv("DINODIA_HA_USERNAME", "dinodia"),
  hubId: stringEnv("DINODIA_HUB_ID", ""),
  heartbeatIntervalMs: numberEnv("DINODIA_HEARTBEAT_INTERVAL_MS", 300000),
  hiveEnabled: stringEnv("DINODIA_HIVE_ENABLED", "true") === "true",
  hivePythonPath: stringEnv("DINODIA_HIVE_PYTHON_PATH", path.join(process.cwd(), ".venv-hive", "bin", "python")),
  hiveWorkerPath: stringEnv("DINODIA_HIVE_WORKER_PATH", path.join(__dirname, "integrations", "hive", "python", "hive_worker.py")),
  hivePollIntervalMs: Math.max(30000, Math.min(numberEnv("DINODIA_HIVE_POLL_INTERVAL_MS", 120000), 3600000)),
  hiveOperationTimeoutMs: Math.max(2000, Math.min(numberEnv("DINODIA_HIVE_OPERATION_TIMEOUT_MS", 12000), 60000)),
  hiveSetupTtlMs: Math.max(60000, Math.min(numberEnv("DINODIA_HIVE_SETUP_TTL_MS", 600000), 900000)),
  hiveClientName: stringEnv("DINODIA_HIVE_CLIENT_NAME", "Dinodia OS"),
  hiveAllowInsecureSetup: stringEnv("DINODIA_HIVE_ALLOW_INSECURE_SETUP", "false") === "true",
  googleNestEnabled: stringEnv("DINODIA_GOOGLE_NEST_ENABLED", "true") === "true",
  googleNestReleaseChannel: stringEnv("DINODIA_GOOGLE_NEST_RELEASE_CHANNEL", "sandbox_beta").toLowerCase() || "sandbox_beta",
  googleNestPollIntervalMs: Math.max(30000, Math.min(numberEnv("DINODIA_GOOGLE_NEST_POLL_INTERVAL_MS", 60000), 300000)),
  googleNestOperationTimeoutMs: Math.max(2000, Math.min(numberEnv("DINODIA_GOOGLE_NEST_OPERATION_TIMEOUT_MS", 12000), 60000)),
  googleNestSetupTtlMs: Math.max(60000, Math.min(numberEnv("DINODIA_GOOGLE_NEST_SETUP_TTL_MS", 600000), 900000)),
  googleNestRefreshSkewMs: Math.max(30000, Math.min(numberEnv("DINODIA_GOOGLE_NEST_REFRESH_SKEW_MS", 300000), 900000)),
  googleNestMaxDevices: Math.max(1, Math.min(numberEnv("DINODIA_GOOGLE_NEST_MAX_DEVICES", 100), 100)),
  googleNestCallbackPath: "/_dinodia/oauth/google-nest/callback",
  developerMode: stringEnv("DINODIA_DEVELOPER_MODE", nodeEnv !== "production" ? "true" : "false") === "true",
  nativeAutomationsMode,
  staticDir: path.join(__dirname, "..", "public"),
};
