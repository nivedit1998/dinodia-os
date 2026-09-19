const crypto = require("node:crypto");

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const OPERATIONS = new Set([
  "initialize", "auth.login", "auth.submit_mfa", "auth.register_device", "session.start",
  "devices.discover", "devices.poll", "device.command", "account.deregister", "session.stop", "health",
]);

function request(operation, payload = {}) {
  if (!OPERATIONS.has(String(operation))) throw new Error("Unsupported Hive worker operation");
  return { protocolVersion: PROTOCOL_VERSION, id: crypto.randomUUID(), operation: String(operation), payload };
}

function parseLine(line) {
  if (Buffer.byteLength(String(line || ""), "utf8") > MAX_MESSAGE_BYTES) throw new Error("Hive worker message is too large");
  const value = JSON.parse(String(line || ""));
  if (!value || typeof value !== "object" || Number(value.protocolVersion) !== PROTOCOL_VERSION || !value.id) throw new Error("Invalid Hive worker message");
  return value;
}

function validateResponse(value) {
  if (!value || typeof value !== "object" || Number(value.protocolVersion) !== PROTOCOL_VERSION || !value.id) throw new Error("Invalid Hive worker response");
  if (value.ok === false && !value.errorCode) throw new Error("Hive worker response has no error code");
  return value;
}

function safeError(error, fallback = "hive_api_unavailable") {
  const code = String(error?.errorCode || error?.code || fallback).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return { errorCode: code.slice(0, 64), message: String(error?.message || "Hive integration is unavailable.").replace(/token|password|secret|credential|code/gi, "sensitive value").slice(0, 240) };
}

module.exports = { PROTOCOL_VERSION, MAX_MESSAGE_BYTES, OPERATIONS, request, parseLine, validateResponse, safeError };
