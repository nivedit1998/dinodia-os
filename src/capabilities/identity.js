const crypto = require("node:crypto");
const { text } = require("./schema");

function normalizedHex(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw.replace(/^0x/, "");
}

function stableDeviceId(protocol, identity) {
  const kind = String(protocol || "unknown").toLowerCase();
  if (kind === "zigbee") {
    const ieee = normalizedHex(identity.ieeeAddress || identity.ieee_address || identity.ieee || identity.id);
    return `zigbee:${ieee || crypto.createHash("sha256").update(String(identity.id || "unknown")).digest("hex").slice(0, 24)}`;
  }
  if (kind === "matter") {
    const fabric = text(identity.fabricId || identity.fabric_id || "default").toLowerCase();
    const node = text(identity.nodeId || identity.node_id || identity.id);
    return `matter:${fabric}:${node}`;
  }
  if (kind === "hive") return stableHiveDeviceId(identity, identity.machineKey);
  return `${kind}:${text(identity.id || "unknown")}`;
}

function stableHiveAccountFingerprint(accountId, username, machineKey = "dinodia-hive") {
  const source = text(accountId || username || "unknown").toLowerCase();
  const key = Buffer.isBuffer(machineKey) ? machineKey : Buffer.from(String(machineKey));
  return `hmac-sha256:${crypto.createHmac("sha256", key).update(source).digest("hex").slice(0, 24)}`;
}

function stableHiveDeviceId(identity = {}, machineKey) {
  const fingerprint = text(identity.accountFingerprint || stableHiveAccountFingerprint(identity.accountId, identity.username, machineKey));
  const cloudId = text(identity.cloudId || identity.deviceId || identity.id || "device")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 64) || "device";
  return `hive:${fingerprint.replace(/^hmac-sha256:/, "")}:${cloudId}`;
}

function stableGoogleNestDeviceId(resourceName, machineKey = "dinodia-google-nest") {
  const key = Buffer.isBuffer(machineKey) ? machineKey : Buffer.from(String(machineKey));
  const resource = String(resourceName || "").trim();
  return `google_nest:${crypto.createHmac("sha256", key).update(resource).digest("hex").slice(0, 24)}`;
}

function normalizeEndpoint(value, fallback = "0") {
  const endpoint = String(value === undefined || value === null ? fallback : value).trim();
  return endpoint || fallback;
}

function normalizeLogicalKey(value, fallback = "state") {
  const key = String(value === undefined || value === null ? fallback : value).trim();
  return key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 96) || fallback;
}

function stableEntityId(deviceId, endpointId, logicalKey) {
  return `${String(deviceId)}:${normalizeEndpoint(endpointId)}:${normalizeLogicalKey(logicalKey)}`;
}

function haObjectId(value) {
  return String(value || "entity")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "entity";
}

module.exports = { normalizedHex, stableDeviceId, stableHiveAccountFingerprint, stableHiveDeviceId, stableGoogleNestDeviceId, normalizeEndpoint, normalizeLogicalKey, stableEntityId, haObjectId };
