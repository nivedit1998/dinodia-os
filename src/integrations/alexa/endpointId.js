const crypto = require("node:crypto");

function base64url(value) {
  return Buffer.from(value).toString("base64url").replace(/=+$/g, "");
}

function nativeAlexaEndpointId({ hubInstanceId, deviceId, channelId = "root" } = {}) {
  const source = `${String(hubInstanceId || "")}\0${String(deviceId || "")}\0${String(channelId || "root")}`;
  const digest = crypto.createHash("sha256").update(source).digest();
  return `dos_${base64url(digest).slice(0, 43)}`;
}

function isNativeAlexaEndpointId(value) {
  return typeof value === "string" && /^dos_[A-Za-z0-9_-]{16,80}$/.test(value);
}

module.exports = { nativeAlexaEndpointId, isNativeAlexaEndpointId };
