const crypto = require("node:crypto");

const MAX_TOKEN_TTL_SECONDS = 5 * 60;

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

function verifyAppAccessToken(token, { publicKeys = [], hubId, now = Date.now(), policyRevision = 0 } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "dno-app-1" || !publicKeys.length) return null;
  let header; let claims;
  try {
    header = decode(parts[1]);
    claims = decode(parts[2]);
  } catch { return null; }
  if (header?.alg !== "EdDSA" || header?.typ !== "DNO-APP-1") return null;
  const input = `${parts[1]}.${parts[2]}`;
  const signature = Buffer.from(parts[3], "base64url");
  if (!publicKeys.some((key) => { try { return crypto.verify(null, Buffer.from(input), key, signature); } catch { return false; } })) return null;
  const nowSeconds = Math.floor(Number(now) / 1000);
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const expectedAudience = `dinodia-hub:${String(hubId || "")}`;
  if (claims.iss !== "dinodia-platform-v2" || claims.aud !== expectedAudience || typeof claims.sub !== "string" || !claims.sub) return null;
  if (!claims.sid || !claims.jti || !claims.membershipId || !claims.trustedDeviceId || !claims.hubInstallationId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > nowSeconds + 5 || expiresAt <= nowSeconds || expiresAt - issuedAt > MAX_TOKEN_TTL_SECONDS) return null;
  if (!["OWNER", "PROPERTY_MANAGER", "TENANT"].includes(claims.householdRole)) return null;
  if (typeof claims.homeId !== "string" || !claims.homeId || !Number.isInteger(claims.policyRevision) || claims.policyRevision < Number(policyRevision || 0)) return null;
  if (!Array.isArray(claims.areaIds) || !Array.isArray(claims.scope)) return null;
  return Object.freeze({ ...claims, hubInstallId: claims.hubInstallationId, role: claims.householdRole, areaIds: [...new Set(claims.areaIds.map(String))], scope: [...new Set(claims.scope.map(String))], principalType: "app" });
}

function appTokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex").slice(0, 32);
}

module.exports = { MAX_TOKEN_TTL_SECONDS, parsePublicKeys, verifyAppAccessToken, appTokenFingerprint };
