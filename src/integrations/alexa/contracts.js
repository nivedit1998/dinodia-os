const crypto = require("node:crypto");

const SCHEMA_VERSION = 1;
const MAX_ENDPOINTS = 256;
const MAX_CAPABILITIES_PER_ENDPOINT = 24;
const MAX_CONTROLS_PER_ENDPOINT = 32;
const MAX_PROPERTIES_PER_ENDPOINT = 32;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_STRING = 160;

function text(value, fallback = "") {
  const clean = String(value === undefined || value === null ? fallback : value).trim();
  return clean.slice(0, MAX_STRING);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function revisionFor(endpoints) {
  const canonical = JSON.stringify(canonicalize(endpoints));
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function safeArray(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return { ok: false, reason: "catalog_not_object" };
  if (Number(catalog.schemaVersion) !== SCHEMA_VERSION) return { ok: false, reason: "unsupported_schema" };
  if (!text(catalog.hubSerial) || !text(catalog.hubInstanceId)) return { ok: false, reason: "missing_hub_identity" };
  const endpoints = safeArray(catalog.endpoints, MAX_ENDPOINTS);
  if (!Array.isArray(catalog.endpoints) || catalog.endpoints.length > MAX_ENDPOINTS) return { ok: false, reason: "too_many_endpoints" };
  if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_PAYLOAD_BYTES) return { ok: false, reason: "catalog_too_large" };
  const seen = new Set();
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint !== "object") return { ok: false, reason: "invalid_endpoint" };
    const endpointId = text(endpoint.endpointId);
    if (!/^dos_[A-Za-z0-9_-]{16,80}$/.test(endpointId) || seen.has(endpointId)) return { ok: false, reason: "invalid_endpoint_id" };
    seen.add(endpointId);
    if (!text(endpoint.deviceId) || !text(endpoint.channelId)) return { ok: false, reason: "missing_endpoint_source" };
    if (!Array.isArray(endpoint.capabilities) || endpoint.capabilities.length > MAX_CAPABILITIES_PER_ENDPOINT) return { ok: false, reason: "invalid_capabilities" };
    if (!Array.isArray(endpoint.controls) || endpoint.controls.length > MAX_CONTROLS_PER_ENDPOINT) return { ok: false, reason: "invalid_controls" };
    if (!Array.isArray(endpoint.state) || endpoint.state.length > MAX_PROPERTIES_PER_ENDPOINT) return { ok: false, reason: "invalid_state" };
  }
  return { ok: true, catalog: clone(catalog), revision: revisionFor(endpoints) };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_ENDPOINTS,
  MAX_CAPABILITIES_PER_ENDPOINT,
  MAX_CONTROLS_PER_ENDPOINT,
  MAX_PROPERTIES_PER_ENDPOINT,
  MAX_PAYLOAD_BYTES,
  text,
  clone,
  canonicalize,
  revisionFor,
  validateCatalog,
};
