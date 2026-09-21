const crypto = require("node:crypto");

const MAX_SESSION_MS = 15 * 60 * 1000;
const MAX_RECENT_AUTH_MS = 5 * 60 * 1000;

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
}

function canonicalSigningInput(header, claims) {
  return `${encode(header)}.${encode(claims)}`;
}

function createOperatorSessionToken(claims, privateKey, now = Date.now()) {
  if (!privateKey) throw new Error("Operator signing key is not configured");
  const issuedAt = Math.floor(Number(now) / 1000);
  const requestedExpiry = Number(claims.exp || issuedAt + MAX_SESSION_MS / 1000);
  const exp = Math.min(requestedExpiry, issuedAt + MAX_SESSION_MS / 1000);
  const payload = {
    iss: "dinodia-platform",
    aud: `dinodia-os:${String(claims.hubId || "")}`,
    sub: String(claims.sub || claims.employeeId || ""),
    sid: String(claims.sid || crypto.randomUUID()),
    jti: String(claims.jti || crypto.randomUUID()),
    hubId: String(claims.hubId || ""),
    scope: Array.isArray(claims.scope) ? [...new Set(claims.scope.map(String))] : [],
    iat: issuedAt,
    exp,
    recentAuthAt: Number(claims.recentAuthAt || now),
    ...(claims.workflow ? { workflow: String(claims.workflow) } : {}),
    ...(claims.supportScope ? { supportScope: String(claims.supportScope) } : {}),
    ...(Array.isArray(claims.areaIds) ? { areaIds: [...new Set(claims.areaIds.map(String))] } : {}),
    ...(claims.targetUserId != null ? { targetUserId: String(claims.targetUserId) } : {}),
    ...(claims.includesTenantDevices != null ? { includesTenantDevices: claims.includesTenantDevices === true } : {}),
  };
  if (!payload.sub || !payload.hubId || payload.scope.length === 0) throw new Error("Operator token claims are incomplete");
  const header = { alg: "EdDSA", typ: "DNO-OPS-1" };
  const signingInput = canonicalSigningInput(header, payload);
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url");
  return `dno1.${signingInput}.${signature}`;
}

function verifyOperatorSessionToken(token, { publicKey, hubId, requiredScope = "os:admin", now = Date.now() } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "dno1" || !publicKey) return null;
  const signingInput = `${parts[1]}.${parts[2]}`;
  let header;
  let claims;
  try {
    header = decode(parts[1]);
    claims = decode(parts[2]);
  } catch {
    return null;
  }
  if (header?.alg !== "EdDSA" || header?.typ !== "DNO-OPS-1") return null;
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(signingInput), publicKey, Buffer.from(parts[3], "base64url")); } catch { valid = false; }
  if (!valid) return null;
  const nowSeconds = Math.floor(Number(now) / 1000);
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  const recentAuthAt = Number(claims.recentAuthAt);
  if (claims.iss !== "dinodia-platform" || claims.aud !== `dinodia-os:${String(hubId || "")}` || claims.hubId !== String(hubId || "")) return null;
  if (!claims.sub || !claims.sid || !claims.jti || !Number.isFinite(exp) || !Number.isFinite(iat) || exp <= nowSeconds || exp - iat > MAX_SESSION_MS / 1000) return null;
  if (!Number.isFinite(recentAuthAt) || Number(now) - recentAuthAt > MAX_RECENT_AUTH_MS) return null;
  if (!Array.isArray(claims.scope) || (requiredScope && !claims.scope.includes(requiredScope))) return null;
  return Object.freeze({ ...claims, scope: [...claims.scope] });
}

module.exports = { MAX_SESSION_MS, MAX_RECENT_AUTH_MS, createOperatorSessionToken, verifyOperatorSessionToken };
