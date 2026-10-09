const crypto = require("node:crypto");

const MAX_ALEXA_COMMAND_TTL_SECONDS = 20;

function decode(value) {
  return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
}

function parsePublicKeys(value) {
  const source = String(value || "").replaceAll("\\n", "\n").trim();
  const entries = source.includes("-----BEGIN")
    ? (source.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) || [])
    : source.split(/\n+|\s*,\s*/);
  return entries.map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    try { return [crypto.createPublicKey(entry)]; } catch { return []; }
  });
}

function verifyAlexaCommandToken(token, { publicKeys = [], hubId, now = Date.now(), policyRevision = 0 } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "dno-alexa-command-1" || !publicKeys.length) return null;
  let header; let claims;
  try { header = decode(parts[1]); claims = decode(parts[2]); } catch { return null; }
  if (header?.alg !== "EdDSA" || header?.typ !== "DNO-ALEXA-CMD-1" || header?.v !== 1) return null;
  const allowed = ["iss", "aud", "sub", "linkId", "endpointId", "homeId", "membershipId", "hubInstallationId", "areaId", "deviceId", "controlId", "descriptorRevision", "commandId", "idempotencyKey", "valueDigest", "policyRevision", "jti", "iat", "exp"];
  if (Object.keys(claims).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(claims, key))) return null;
  const input = `${parts[1]}.${parts[2]}`;
  const signature = Buffer.from(parts[3], "base64url");
  if (!publicKeys.some((key) => { try { return crypto.verify(null, Buffer.from(input), key, signature); } catch { return false; } })) return null;
  const nowSeconds = Math.floor(Number(now) / 1000);
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const expectedHub = String(hubId || "");
  const strings = ["sub", "linkId", "endpointId", "homeId", "membershipId", "hubInstallationId", "areaId", "deviceId", "controlId", "commandId", "idempotencyKey", "valueDigest", "jti"];
  if (claims.iss !== "dinodia-platform-v2" || claims.aud !== `dinodia-hub:${expectedHub}`
    || claims.hubInstallationId !== expectedHub || strings.some((key) => typeof claims[key] !== "string" || !claims[key] || claims[key].length > 180)
    || !/^dos_[A-Za-z0-9_-]{16,80}$/.test(claims.endpointId)
    || !/^[a-f0-9]{64}$/.test(claims.valueDigest)
    || !Number.isSafeInteger(claims.descriptorRevision) || claims.descriptorRevision < 0
    || !Number.isSafeInteger(claims.policyRevision) || claims.policyRevision < Number(policyRevision || 0)
    || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || issuedAt > nowSeconds + 5 || expiresAt <= nowSeconds || expiresAt - issuedAt > MAX_ALEXA_COMMAND_TTL_SECONDS
    || issuedAt >= expiresAt || Number(policyRevision || 0) < 0) return null;
  return Object.freeze({
    principalType: "alexa",
    sub: claims.sub,
    linkId: claims.linkId,
    endpointId: claims.endpointId,
    homeId: claims.homeId,
    membershipId: claims.membershipId,
    homeMembershipId: claims.membershipId,
    hubInstallId: claims.hubInstallationId,
    hubInstallationId: claims.hubInstallationId,
    areaId: claims.areaId,
    areaIds: [claims.areaId],
    deviceId: claims.deviceId,
    controlId: claims.controlId,
    descriptorRevision: claims.descriptorRevision,
    commandId: claims.commandId,
    idempotencyKey: claims.idempotencyKey,
    valueDigest: claims.valueDigest,
    policyRevision: claims.policyRevision,
    jti: claims.jti,
    issuedAt,
    expiresAt,
    householdRole: "TENANT",
    scope: ["tenant:device-command"],
  });
}

function verifyAlexaStateToken(token, { publicKeys = [], hubId, now = Date.now(), policyRevision = 0 } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "dno-alexa-state-1" || !publicKeys.length) return null;
  let header; let claims;
  try { header = decode(parts[1]); claims = decode(parts[2]); } catch { return null; }
  if (header?.alg !== "EdDSA" || header?.typ !== "DNO-ALEXA-STATE-1" || header?.v !== 1) return null;
  const allowed = ["iss", "aud", "sub", "linkId", "endpointId", "homeId", "membershipId", "hubInstallationId", "areaId", "deviceId", "controlIds", "descriptorRevision", "policyRevision", "jti", "iat", "exp"];
  if (Object.keys(claims).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(claims, key))) return null;
  const input = `${parts[1]}.${parts[2]}`;
  const signature = Buffer.from(parts[3], "base64url");
  if (!publicKeys.some((key) => { try { return crypto.verify(null, Buffer.from(input), key, signature); } catch { return false; } })) return null;
  const nowSeconds = Math.floor(Number(now) / 1000);
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const expectedHub = String(hubId || "");
  const strings = ["sub", "linkId", "endpointId", "homeId", "membershipId", "hubInstallationId", "areaId", "deviceId", "jti"];
  if (claims.iss !== "dinodia-platform-v2" || claims.aud !== `dinodia-hub:${expectedHub}`
    || claims.hubInstallationId !== expectedHub || strings.some((key) => typeof claims[key] !== "string" || !claims[key] || claims[key].length > 180)
    || !/^dos_[A-Za-z0-9_-]{16,80}$/.test(claims.endpointId)
    || !Array.isArray(claims.controlIds) || claims.controlIds.length < 1 || claims.controlIds.length > 32
    || claims.controlIds.some((id) => typeof id !== "string" || !id || id.length > 160)
    || new Set(claims.controlIds).size !== claims.controlIds.length
    || !Number.isSafeInteger(claims.descriptorRevision) || claims.descriptorRevision < 0
    || !Number.isSafeInteger(claims.policyRevision) || claims.policyRevision < Number(policyRevision || 0)
    || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || issuedAt > nowSeconds + 5 || expiresAt <= nowSeconds || expiresAt - issuedAt > MAX_ALEXA_COMMAND_TTL_SECONDS || issuedAt >= expiresAt) return null;
  return Object.freeze({
    principalType: "alexa_state", sub: claims.sub, linkId: claims.linkId, endpointId: claims.endpointId,
    homeId: claims.homeId, membershipId: claims.membershipId, homeMembershipId: claims.membershipId,
    hubInstallId: claims.hubInstallationId, hubInstallationId: claims.hubInstallationId,
    areaId: claims.areaId, areaIds: [claims.areaId], deviceId: claims.deviceId,
    controlIds: [...claims.controlIds], descriptorRevision: claims.descriptorRevision,
    policyRevision: claims.policyRevision, jti: claims.jti, issuedAt, expiresAt,
    householdRole: "TENANT", scope: ["alexa:state-read"],
  });
}

module.exports = { MAX_ALEXA_COMMAND_TTL_SECONDS, parsePublicKeys, verifyAlexaCommandToken, verifyAlexaStateToken };
