const http = require("node:http");
const https = require("node:https");
const WebSocket = require("ws");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { URL } = require("node:url");
const QRCode = require("qrcode");

const baseConfig = require("./config");
const { Store } = require("./store");
const { AutomationEngine } = require("./automation");
const { MqttBridge } = require("./mqttBridge");
const { MatterBridge } = require("./matterBridge");
const { PlatformSync } = require("./platformSync");
const { createBackup } = require("./backup");
const { CloudflareTunnel, connectedLocalTunnelIdentity } = require("./cloudflareTunnel");
const { listSerialAdapters, probeSerialAdapter } = require("./serialAdapters");
const { HomeAssistantModel, normalizeHaState } = require("./haModel");
const { createCompatInterface, createCompatServer } = require("./haCompat");
const { SecretVault } = require("./secretVault");
const { PlatformPairing } = require("./platformPairing");
const { StateChangeNotifier } = require("./stateChangeNotifier");
const { writeZigbee2MqttConfiguration } = require("./zigbeeConfig");
const { HeatingUsageTracker } = require("./heatingUsage");
const { ElectricUsageTracker } = require("./electricUsage");
const { commandForBinding: commandForZigbeeBinding } = require("./integrations/zigbee/commandAdapter");
const { commandForBinding: commandForMatterBinding } = require("./integrations/matter/commandAdapter");
const { MatterPairingSession } = require("./integrations/matter/pairingSession");
const { NativeCommissioningService } = require("./commissioning/nativeCommissioningService");
const { publicCapability } = require("./capabilities/schema");
const { allProjectedSurfaces } = require("./capabilities/controlSurfaceProjection");
const { rawEntityById } = require("./capabilities/devicePresentation");
const { ZigbeeService } = require("./zigbeeService");
const { ThreadService } = require("./threadService");
const { ActivityService } = require("./activity/activityService");
const { HiveBridge, VAULT_KEY } = require("./integrations/hive/hiveBridge");
const { GoogleNestBridge } = require("./integrations/googleNest/googleNestBridge");
const { AlexaIntegration } = require("./integrations/alexa/integration");
const { selectLegacyGoogleNestDevice } = require("./integrations/googleNest/deviceReconciliation");
const { HeatingDemandController, climateSurface, commandValidation } = require("./heatingDemandController");
const { AutomationService } = require("./automations/service");
const { AutomationExecutor } = require("./automations/executor");
const { AutomationScheduler } = require("./automations/scheduler");
const { compileTarget, findControl, resolveExecutionRoute } = require("./automations/controlCatalog");
const { verifyOperatorSessionToken } = require("./auth/operatorSession");
const { parsePublicKeys, verifyAppAccessToken } = require("./auth/appTokenVerifier");
const { ProvisioningPairingService } = require("./auth/provisioningPairing");
const { SetupDiscovery, privateInterface } = require("./setupDiscovery");
const { RevocationCoordinator } = require("./auth/revocationCoordinator");
const { OfflineLanAuthorisationStore, createNativeLanChallenge, digestOfflineCommand, digestNativeOfflineCommand } = require("./auth/offlineLanAuthorizer");
const { LanTlsIdentity } = require("./transport/lanTlsIdentity");
const { StepUpProofVerifier, descriptorBoundValue, digestOperation } = require("./auth/stepUpProofVerifier");
const { stepUpDescriptorDigest } = require("./auth/stepUpDescriptorDigest");
const { IdentityBrokerClient, canonicalCloudChallengeUnsigned } = require("./auth/identityBroker");
const { createSupportProofOfPossession } = require("./auth/supportProofOfPossession");
const { validateMembership: validateNativeMembership, validateArea: validateNativeArea, validateControlState: validateNativeControlState, serializeDevice: serializeNativeDevice, validateCommand: validateNativeCommand, makeEnvelope: makeNativeEnvelope } = require("./contracts/dinodiaV1");

const VERSION = require("../package.json").version;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function hashTokenValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : String(req.headers["x-dinodia-token"] || "").trim();
}

function isHiveCredentialTransportAllowed(req, { nodeEnv = "development", allowInsecure = false, configuredHostname = "", allowLoopback = true } = {}) {
  if (allowInsecure || nodeEnv !== "production") return true;
  const origin = String(req?.headers?.origin || "").trim();
  const host = String(req?.headers?.host || "").split(":")[0].toLowerCase();
  const configuredHost = String(configuredHostname || "").split(":")[0].toLowerCase();
  const remote = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const localProxyPeer = ["127.0.0.1", "::1"].includes(remote);
  const directSecure = req?.socket?.encrypted === true;
  // X-Forwarded-* is trustworthy only when the TCP peer is the local
  // Cloudflared process that terminates the public tunnel. A LAN client can
  // choose Host, Origin and forwarded headers, so those headers alone must
  // never turn a direct HTTP request into an authenticated CloudURL request.
  const forwardedSecure = localProxyPeer && String(req?.headers?.["x-forwarded-proto"] || "").toLowerCase() === "https";
  let secureOrigin = false;
  try { secureOrigin = /^https:\/\//i.test(origin) && Boolean(configuredHost) && new URL(origin).hostname.toLowerCase() === configuredHost && (directSecure || forwardedSecure); } catch { secureOrigin = false; }
  const proxySecure = forwardedSecure && Boolean(configuredHost) && host === configuredHost;
  const loopback = ["127.0.0.1", "::1"].includes(remote) && ["localhost", "127.0.0.1", "::1"].includes(host);
  return secureOrigin || proxySecure || (allowLoopback && loopback);
}

function json(res, status, body, extraHeaders = {}) {
  if (status === 204) {
    res.writeHead(status, extraHeaders);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req, maximumBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maximumBytes) {
        tooLarge = true;
        body = "";
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Request body too large"));
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requestUpdaterControl(input, socketPath = "/run/dinodia-os-updater/control.sock") {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = Buffer.alloc(0);
    let sent = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("updater control timeout")); }, 8_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once("connect", () => {
      if (sent) return;
      sent = true;
      socket.write(`${JSON.stringify(input)}\n`);
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 64 * 1024) return finish(new Error("updater response exceeds its bound"));
      const newline = response.indexOf(10);
      if (newline < 0) return;
      try { finish(null, JSON.parse(response.subarray(0, newline).toString("utf8"))); }
      catch { finish(new Error("updater response is invalid")); }
    });
    socket.once("error", () => finish(new Error("updater service unavailable")));
    socket.once("end", () => { if (!response.includes(10)) finish(new Error("updater response is incomplete")); });
  });
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  }[extension] || "application/octet-stream";
}

async function fetchOtbr(url) {
  if (!url) return { configured: false, reachable: false, url: "", error: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    let payload = null;
    try { payload = await response.json(); } catch { /* endpoint may not return JSON */ }
    const state = typeof payload?.state === "string" ? payload.state : "";
    return { configured: true, reachable: response.ok, url, status: response.status, state, networkName: payload?.networkName || "", error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { configured: true, reachable: false, url, error: String(error && error.message ? error.message : error) };
  } finally {
    clearTimeout(timeout);
  }
}

function privateAddress(req) {
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return host;
  for (const values of Object.values(os.networkInterfaces())) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
    }
  }
  return "127.0.0.1";
}

function isPrivateLanRequest(req) {
  const remote = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  // Forwarded headers identify a proxy/tunnel path. Offline authority must
  // never be accepted through Cloudflare or another public reverse proxy.
  if (req?.headers?.["x-forwarded-for"] || req?.headers?.["cf-connecting-ip"] || req?.headers?.["x-forwarded-host"]) return false;
  if (remote === "127.0.0.1" || remote === "::1") return true;
  if (net.isIP(remote) !== 4) return false;
  const octets = remote.split(".").map(Number);
  return octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function isTrustedOfflineLanTransport(req) {
  const hostname = String(req?.headers?.host || "").replace(/:\d+$/, "").toLowerCase();
  const servername = String(req?.socket?.servername || "").toLowerCase();
  return req?.socket?.encrypted === true
    && /^dinodia-[a-f0-9]{20}\.local$/.test(hostname)
    && hostname === servername
    && isPrivateLanRequest(req);
}

function ethernetIsAvailable(interfaceName = "") {
  const requested = String(interfaceName || "").trim();
  return Object.entries(os.networkInterfaces()).some(([name, values]) => {
    if (requested && name !== requested) return false;
    if (!requested && !/^(eth|en)/i.test(name)) return false;
    return (values || []).some((item) => item && !item.internal && item.family === "IPv4" && Boolean(item.address));
  });
}

function maskHiveEmail(value) {
  const raw = String(value || "").trim();
  const at = raw.indexOf("@");
  return at > 0 ? `${raw[0]}***${raw.slice(at)}` : raw ? "***" : "";
}

function dashboardDevice(device) {
  if (!device || typeof device !== "object") return device;
  const result = JSON.parse(JSON.stringify(device));
  if (String(result.protocol || "").toLowerCase() === "google_nest") {
    result.protocolIdentity = {};
    if (result.metadata && typeof result.metadata === "object") {
      delete result.metadata.resource_name;
      delete result.metadata.account_fingerprint;
    }
  }
  return result;
}

function createHub({ config = {}, store, mqttBridge, matterBridge, hiveBridge, googleNestBridge, googleNestFetchImpl, googleNestNow, googleNestUpdateSource, platformSync, cloudflareTunnel, zigbeeService, threadService, identityBroker: providedIdentityBroker = null, lanTlsIdentityForTest = null, setupDiscoveryForTest = null, serialAdapterLister = listSerialAdapters, serialAdapterProbe = probeSerialAdapter, logger = console, clock = Date.now } = {}) {
  const runtimeConfig = { ...baseConfig, ...config };
  if ((lanTlsIdentityForTest || setupDiscoveryForTest || config.loopbackLanListenerForTest === true)
    && config.v2Environment !== "test") throw new Error("Loopback LAN listener injection is test-only");
  const loopbackLanListenerForTest = config.v2Environment === "test" && config.loopbackLanListenerForTest === true;
  const lanListenerPort = loopbackLanListenerForTest ? Number(config.customerLanPortForTest) : Number(runtimeConfig.haPort);
  if (loopbackLanListenerForTest && (!Number.isInteger(lanListenerPort) || lanListenerPort < 1024 || lanListenerPort > 65535
    || lanListenerPort === Number(runtimeConfig.haPort))) throw new Error("The loopback LAN integration listener requires a distinct approved test port");
  const updaterSocketPath = config.v2Environment === "test" && typeof config.updaterControlSocketPath === "string"
    ? config.updaterControlSocketPath : "/run/dinodia-os-updater/control.sock";
  const operatorNow = () => Number(clock());
  let operatorSessionRevalidationTimer = null;
  // Native production is permanently fail-closed. In particular, do not let
  // a caller-supplied test/config object, an environment variable, or an old
  // token field turn the legacy dashboard/HA verifier back on. The explicit
  // compatibility harness is available only to non-production fixtures.
  const legacyCompatibilityEnabled = runtimeConfig.nodeEnv === "production"
    ? false
    : config.legacyCompatibilityEnabled === undefined
      ? (Object.prototype.hasOwnProperty.call(config, "adminToken") || Object.prototype.hasOwnProperty.call(config, "haToken") || Object.prototype.hasOwnProperty.call(config, "hubAgentToken")
        ? Boolean(config.adminToken || config.haToken || config.hubAgentToken)
        : runtimeConfig.legacyCompatibilityEnabled)
      : Boolean(config.legacyCompatibilityEnabled);
  const hubStore = store || new Store(runtimeConfig.dataFile);
  const offlineLanAuthorisations = new OfflineLanAuthorisationStore({ store: hubStore, platformPublicKeys: parsePublicKeys(runtimeConfig.appPublicKeys) });
  const lanTlsIdentity = runtimeConfig.nodeEnv === "production"
    ? config.v2Environment === "test" && lanTlsIdentityForTest
      ? lanTlsIdentityForTest
      : new LanTlsIdentity({ dataDir: config.dataDir || runtimeConfig.dataDir || path.dirname(runtimeConfig.dataFile), now: () => Number(clock()) })
    : null;
  const physicalLanListenersEnabled = runtimeConfig.nodeEnv === "production" && Number(runtimeConfig.haPort) > 0 && config.disablePhysicalLanListenersForTest !== true;
  const eventBus = new EventEmitter();
  const vault = new SecretVault({ dataDir: config.dataDir || path.dirname(runtimeConfig.dataFile), logger });
  // The integration harness may inject a disposable broker only when it
  // explicitly selects its test-only runtime marker. Production always uses
  // the restricted dinodia-identityd Unix-socket boundary.
  const identityBroker = config.v2Environment === "test" && providedIdentityBroker
    ? providedIdentityBroker
    : runtimeConfig.nodeEnv === "production" ? new IdentityBrokerClient({ socketPath: runtimeConfig.identitySocketPath }) : null;
  const existingIdentity = hubStore.getIdentity ? hubStore.getIdentity() : {};
  const serial = existingIdentity.serial || runtimeConfig.hubId || `dinodia-${crypto.randomBytes(6).toString("hex")}`;
  if (!existingIdentity.serial && hubStore.saveIdentity) hubStore.saveIdentity({ serial, instanceId: existingIdentity.instanceId || crypto.randomUUID(), hostname: existingIdentity.hostname || "dinodia" }).catch((error) => logger.error(`[identity] ${error.message}`));
  const revocationCoordinator = new RevocationCoordinator();
  const provisioningPairing = new ProvisioningPairingService({ serial, ttlMs: runtimeConfig.pairingTtlMs, store: hubStore, vault, logger });
  let refreshPhysicalLanListeners = async () => {};
  const setupDiscovery = config.v2Environment === "test" && setupDiscoveryForTest
    ? setupDiscoveryForTest
    : new SetupDiscovery({ serial, interfaceName: runtimeConfig.setupInterfaceName, nodeEnv: runtimeConfig.nodeEnv, logger, onEndpointChange: (observation) => {
    pairing?.requestImmediateHeartbeat?.();
    refreshPhysicalLanListeners(observation).catch(() => {});
  } });
  let operatorPublicKey = null;
  if (runtimeConfig.operatorPublicKey) {
    try { operatorPublicKey = crypto.createPublicKey(runtimeConfig.operatorPublicKey); } catch (error) { logger.error(`[auth] operator public key rejected: ${error.message}`); }
  }

  const appPublicKeys = parsePublicKeys(runtimeConfig.appPublicKeys);
  const stepUpVerifier = new StepUpProofVerifier({ publicKeys: [...appPublicKeys, ...(operatorPublicKey ? [operatorPublicKey] : [])], store: hubStore });
  const revokedOperatorJtis = new Set();
  // The browser must receive only an opaque session handle. The signed OS
  // bearer is retained in this process and is never placed in HTML, JSON or a
  // browser cookie. The absolute deadline is never renewed; a service restart
  // deliberately drops the map and requires a fresh Portal handoff.
  const operatorBrowserSessions = new Map();
  // Handoff work may outlive a Cloudflare proxy request. Keep its state only
  // in memory, keyed to the hub-created attempt and browser binding. A service
  // restart intentionally drops pending handoffs; the employee must relaunch.
  const operatorHandoffJobs = new Map();
  const supportBrowserSessions = new Map();
  function issueBrowserOperatorSession(token, expiresAt, authority = {}) {
    const handle = `osb_${crypto.randomBytes(32).toString("base64url")}`;
    operatorBrowserSessions.set(handle, { token: String(token), expiresAt: Number(new Date(expiresAt).getTime()), jti: String(authority.jti || ""), handoffId: String(authority.handoffId || ""), credentialVersion: Number(authority.credentialVersion || 0), lastAuthorizationCheckAt: operatorNow() });
    return handle;
  }
  function browserSessionToken(handle) {
    const value = operatorBrowserSessions.get(String(handle || ""));
    if (!value) return null;
    if (!Number.isFinite(value.expiresAt) || operatorNow() >= value.expiresAt) {
      operatorBrowserSessions.delete(String(handle));
      return null;
    }
    return value.token;
  }
  function issueSupportBrowserSession(lease, secure = false) {
    const handle = `oss_${crypto.randomBytes(32).toString("base64url")}`;
    supportBrowserSessions.set(handle, { ...lease, expiresAt: Number(new Date(lease.expiresAt).getTime()) });
    return { handle, secure };
  }
  function supportBrowserPrincipal(req) {
    const prefix = "dinodia_os_support_session=";
    const entry = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
    const handle = entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
    const lease = supportBrowserSessions.get(handle);
    if (!lease) return null;
    if (!Number.isFinite(lease.expiresAt) || Date.now() >= lease.expiresAt) {
      supportBrowserSessions.delete(handle);
      return null;
    }
    return {
      principalType: "operator",
      sub: `support:${lease.sessionId}`,
      sid: `support:${lease.sessionId}`,
      jti: `support:${lease.sessionId}`,
      scope: ["os:support"],
      supportScope: lease.scope,
      areaIds: Array.isArray(lease.areaIds) ? lease.areaIds.map(String) : [],
      targetMembershipId: lease.targetMembershipId == null ? null : String(lease.targetMembershipId),
      targetUserId: lease.targetUserId == null ? null : String(lease.targetUserId),
      includesTenantDevices: lease.includesTenantDevices === true,
      expiresAt: Math.floor(lease.expiresAt / 1000),
      credentialFingerprint: hashTokenValue(handle).slice(0, 32),
    };
  }
  function supportBrowserLease(req) {
    const prefix = "dinodia_os_support_session=";
    const entry = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
    const handle = entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
    return { handle, lease: supportBrowserSessions.get(handle) || null };
  }
  async function refreshedSupportBrowserPrincipal(req) {
    const current = supportBrowserLease(req);
    if (!current.lease) return null;
    const now = Date.now();
    if (now >= current.lease.expiresAt) {
      await revokeSupportLease(current.lease);
      supportBrowserSessions.delete(current.handle);
      return null;
    }
    if (now - Number(current.lease.lastCheckedAt || 0) < 5000) return supportBrowserPrincipal(req);
    current.lease.lastCheckedAt = now;
    try {
      const status = await pairing.requestWithHubIdentity("/api/hub-agent/support/v2/status", { serial, sessionId: current.lease.sessionId, lease: current.lease.lease });
      if (!status?.active) {
        await revokeSupportLease(current.lease);
        supportBrowserSessions.delete(current.handle);
        return null;
      }
      return supportBrowserPrincipal(req);
    } catch {
      // A failed revalidation is not proof that a customer-approved lease is
      // still valid. Drop the local browser principal and require a fresh,
      // machine-authenticated redemption after the platform is reachable.
      supportBrowserSessions.delete(current.handle);
      return null;
    }
  }
  function clearOperatorBrowserSessions() {
    for (const [handle, value] of operatorBrowserSessions) {
      try {
        const principal = verifyOperatorSessionToken(value.token, { publicKey: operatorPublicKey, hubId: serial, requiredScope: null, requireRecentAuth: false, now: operatorNow(), internalOperatorDaySession: runtimeConfig.stage1InternalOperatorDaySession === true });
        if (!principal || revokedOperatorJtis.has(String(principal.jti))) operatorBrowserSessions.delete(handle);
      } catch { operatorBrowserSessions.delete(handle); }
    }
  }
  for (const jti of Object.keys(hubStore.getSecurity?.().revokedOperatorJtis || {})) revokedOperatorJtis.add(jti);
  async function revokeLocalOperatorSession(session, reason) {
    if (!session?.jti) return 0;
    revokedOperatorJtis.add(String(session.jti));
    const security = hubStore.getSecurity?.() || {};
    await hubStore.saveSecurity?.({ revokedOperatorJtis: { ...(security.revokedOperatorJtis || {}), [session.jti]: new Date(operatorNow()).toISOString() } });
    for (const [handle, entry] of operatorBrowserSessions) if (entry.jti === session.jti) operatorBrowserSessions.delete(handle);
    return revocationCoordinator.revoke({ jti: session.jti, reason });
  }
  async function syncOperatorBrowserSessions() {
    for (const session of operatorBrowserSessions.values()) {
      if (!session.handoffId || !session.jti || operatorNow() >= session.expiresAt || revokedOperatorJtis.has(session.jti)) continue;
      try {
        const result = await pairing.requestWithHubIdentity("/api/hub-agent/operator-session/revalidate", { handoffId: session.handoffId, jti: session.jti, credentialVersion: session.credentialVersion });
        if (result?.active !== true) await revokeLocalOperatorSession(session, "operator_authority_changed");
        else session.lastAuthorizationCheckAt = operatorNow();
      } catch {
        // Never extend the last successful decision. operatorSessionAuth and
        // the socket deadline fail closed once its 60-second freshness ends.
      }
    }
  }
  function armOperatorSessionFreshnessDeadline(socket, session) {
    const checkAt = Number(session?.lastAuthorizationCheckAt || 0) + 60_000;
    const delay = Math.max(1, checkAt - operatorNow());
    const timer = setTimeout(() => {
      if (operatorNow() >= Number(session?.lastAuthorizationCheckAt || 0) + 60_000) socket.close?.(4401, "Authorization revalidation expired");
    }, delay);
    timer.unref?.();
    return timer;
  }
  const operatorSessionAuth = (token) => {
    clearOperatorBrowserSessions();
    const principal = verifyOperatorSessionToken(token, { publicKey: operatorPublicKey, hubId: serial, requiredScope: null, requireRecentAuth: false, now: operatorNow(), internalOperatorDaySession: runtimeConfig.stage1InternalOperatorDaySession === true });
    if (!principal || !principal.scope.some((scope) => ["os:admin", "os:support", "os:permanent-installation"].includes(String(scope))) || revokedOperatorJtis.has(String(principal.jti))) return null;
    const activeHandle = [...operatorBrowserSessions.values()].find((entry) => entry.token === String(token));
    if ((principal.scope.includes("os:admin") || principal.scope.includes("os:permanent-installation")) && runtimeConfig.nodeEnv === "production") {
      if (activeHandle && operatorNow() - Number(activeHandle.lastAuthorizationCheckAt || 0) >= 60_000) return null;
    }
    return { ...principal, principalType: "operator", authToken: String(token), credentialFingerprint: hashTokenValue(token).slice(0, 32) };
  };
  const appSessionAuth = (token) => {
    const platform = hubStore.getPlatform?.() || {};
    const principal = verifyAppAccessToken(token, {
      publicKeys: appPublicKeys,
      hubId: platform.hubInstallId || serial,
      policyRevision: Math.max(Number(platform.policyRevision || 0), Number(hubStore?.getAuth?.().policyRevision || 0)),
    });
    if (!principal) return null;
    const identity = hubStore.getIdentity?.() || {};
    const acceptedLineages = new Set([serial, identity.instanceId, platform.hubInstallId].filter(Boolean).map(String));
    return acceptedLineages.has(String(principal.hubInstallId)) ? {
      ...principal,
      accessTokenHash: crypto.createHash("sha256").update(String(token), "utf8").digest("hex"),
      identityGeneration: Number(identity.generation || 0),
    } : null;
  };

  let automation;
  let nativeAutomationService;
  let nativeAutomationExecutor;
  let nativeAutomationScheduler;
  let heatingDemandController;
  let alexaIntegration;
  let haModel;
  let nativeCommandQueue = Promise.resolve();
  const nativeEventClients = new Set();
  const commissioningEventClients = new Set();
  const nativeCommandOutcomeTimers = new Map();
  let nativeEventQueue = Promise.resolve();
  const persistedNativeStreamId = String(hubStore.getSecurity?.()?.nativeStreamId || "");
  const nativeStreamIdValue = /^native:[0-9a-f-]{36}$/i.test(persistedNativeStreamId)
    ? persistedNativeStreamId
    : `native:${crypto.randomUUID()}`;
  if (nativeStreamIdValue !== persistedNativeStreamId) {
    hubStore.saveSecurity({ nativeStreamId: nativeStreamIdValue }).catch((error) => logger.warn(`[native-events] stream identity persistence failed (${String(error?.code || "storage_unavailable")})`));
  }
  const activity = new ActivityService({ store: hubStore, eventBus, logger });
  let activityIntegrationTimer = null;
  let electricTimer = null;
  const heating = new HeatingUsageTracker({
    store: hubStore,
    entityIdFor: (entity, device, rawId) => haModel?.entities().find((item) => item.device.id === device.id && item.rawId === rawId)?.haId || entity.haEntityId || entity.entityId || rawId,
    logger,
  });
  const electric = new ElectricUsageTracker({ store: hubStore, logger });
  const stateNotifier = new StateChangeNotifier({ url: runtimeConfig.stateChangeUrl, secret: runtimeConfig.stateChangeSecret, logger });
  async function notifyDeviceChanged(device, previous = null) {
    if (automation) await automation.onDeviceChanged(device, previous);
    await heating.onDeviceChanged(device);
    await electric.onDeviceChanged(device);
    try {
      await activity.recordDeviceChanged(device, previous);
    } catch (error) {
      logger.error(`[activity] Could not record device activity: ${error.message}`);
    }
    eventBus.emit("dinodia_dashboard_updated", { kind: "device", deviceId: device?.id || null, at: new Date().toISOString() });
    if (alexaIntegration) alexaIntegration.handleDeviceChanged().catch((error) => logger.error(`[alexa] ${error.message}`));
    if (haModel) {
      const items = haModel.entities().filter((item) => item.device.id === device.id);
      for (const item of items) {
        const state = haModel.stateFor(item);
        const oldEntity = previous && Object.values(previous.entities || {}).find((candidate) => candidate.sourceId === item.rawId || candidate.id === item.rawId || candidate.stateKey === item.entity.stateKey);
        const oldState = previous && oldEntity ? { ...state, state: oldEntity.available === false || previous.available === false ? "unavailable" : normalizeHaState(oldEntity.state), attributes: { ...state.attributes, friendly_name: oldEntity.name || state.attributes.friendly_name } } : null;
        eventBus.emit("state_changed", { entity_id: state.entity_id, old_state: oldState, new_state: state });
        stateNotifier.enqueue(state.entity_id);
      }
    }
    if (heatingDemandController) heatingDemandController.reconcileDeviceChange(device, previous).catch((error) => logger.error(`[heating-controller] ${error.message}`));
  }

  const mqtt = mqttBridge || new MqttBridge({
    url: runtimeConfig.mqttUrl,
    baseTopic: runtimeConfig.zigbeeBaseTopic,
    discoveryPrefix: runtimeConfig.zigbeeDiscoveryPrefix,
    pairingSeconds: runtimeConfig.zigbeePairingSeconds,
    eventDedupeMs: runtimeConfig.zigbeeEventDedupeMs,
    store: hubStore,
    onDeviceChanged: notifyDeviceChanged,
    onRemoteEvent: handleRemoteEvent,
    logger,
  });
  const matter = matterBridge || new MatterBridge({
    // A stored Thread setup owns the local Matter server unless the operator
    // explicitly supplied another Matter Server URL.
    url: runtimeConfig.matterServerUrl || (hubStore.getThread?.().configured ? "ws://127.0.0.1:5580/ws" : ""),
    store: hubStore,
    onDeviceChanged: notifyDeviceChanged,
    logger,
  });
  async function ingestHiveSnapshot(snapshot = {}) {
    const incoming = Array.isArray(snapshot.devices) ? snapshot.devices : [];
    await hubStore.saveConfigEntry({ entry_id: "ce_hive", domain: "hive", title: "Hive" });
    const incomingIds = new Set(incoming.map((device) => String(device.id || "")).filter(Boolean));
    for (const device of incoming) {
      const existing = hubStore.getDevice(device.id);
      const next = await hubStore.upsertDevice({
        ...device,
        configEntryId: "ce_hive",
        ...(existing ? {
          name: existing.name,
          areaId: existing.areaId,
          labels: existing.labels,
          labelIds: existing.labelIds,
          setup: existing.setup,
        } : {}),
      });
      const changed = !existing || JSON.stringify({ state: existing.state, entities: existing.entities, available: existing.available, name: existing.name, areaId: existing.areaId, labels: existing.labels, setup: existing.setup }) !== JSON.stringify({ state: next.state, entities: next.entities, available: next.available, name: next.name, areaId: next.areaId, labels: next.labels, setup: next.setup });
      if (changed) await notifyDeviceChanged(next, existing);
    }
    // A zone removed from the Hive cloud account should become unavailable in
    // Dinodia OS, not silently remain online with stale state. Keep the local
    // record so its assignment/history is recoverable if Hive restores it.
    for (const existing of hubStore.listDevices().filter((device) => String(device.protocol || "").toLowerCase() === "hive" && !incomingIds.has(String(device.id)))) {
      if (existing.available === false) continue;
      const next = await hubStore.upsertDevice({ ...existing, available: false });
      await notifyDeviceChanged(next, existing);
    }
    return { heatingDeviceCount: incoming.length, needsSetup: incoming.filter((device) => device.setup?.status === "needs_setup").map((device) => ({ deviceId: device.id, name: device.name, protocol: device.protocol, manufacturer: "Hive", model: device.metadata?.model || "" })) };
  }
  let lastHiveStatus = "";
  function onHiveStatus(status) {
    eventBus.emit("dinodia_dashboard_updated", { kind: "integration", integration: "hive", status, at: new Date().toISOString() });
    const current = String(status?.status || "");
    const previous = lastHiveStatus;
    lastHiveStatus = current;
    if (current === "reauth_required" && previous !== current) activity.record({ type: "hive_account_reauth_required", detail: "Hive authentication expired and needs to be reconnected." }).catch((error) => logger.error(`[activity] ${error.message}`));
    if (current === "degraded" && previous !== current) activity.record({ type: "hive_integration_unavailable", detail: "Hive cloud is temporarily unavailable; Dinodia OS will retry with bounded backoff." }).catch((error) => logger.error(`[activity] ${error.message}`));
    if (current === "connected" && ["degraded", "reauth_required"].includes(previous)) activity.record({ type: "hive_integration_recovered", detail: "Hive cloud connectivity and authentication recovered." }).catch((error) => logger.error(`[activity] ${error.message}`));
  }
  const hive = hiveBridge || new HiveBridge({
    store: hubStore,
    vault,
    config: runtimeConfig,
    onSnapshot: ingestHiveSnapshot,
    onStatus: onHiveStatus,
    logger,
  });
  async function ingestGoogleNestSnapshot(snapshot = {}, { allowIdentityMigration = false } = {}) {
    const incoming = Array.isArray(snapshot.devices) ? snapshot.devices : [];
    await hubStore.saveConfigEntry({ entry_id: "ce_google_nest", domain: "google_nest", title: "Google Nest" });
    const incomingIds = new Set(incoming.map((device) => String(device.id || "")).filter(Boolean));
    const existingGoogleNest = hubStore.listDevices().filter((device) => String(device.protocol || "").toLowerCase() === "google_nest");
    const reconciledExistingIds = new Set();
    for (const device of incoming) {
      const exactExisting = hubStore.getDevice(device.id);
      const existing = exactExisting || selectLegacyGoogleNestDevice({ incoming: device, incomingDevices: incoming, existingDevices: existingGoogleNest, usedIds: reconciledExistingIds });
      const identityChanged = Boolean(existing && String(existing.id) !== String(device.id));
      const verifiedIdentity = String(existing?.metadata?.resource_health || "").toLowerCase() === "verified";
      if (identityChanged && verifiedIdentity && !allowIdentityMigration) {
        const next = await hubStore.upsertDevice({ ...existing, state: device.state, available: device.available });
        reconciledExistingIds.add(String(existing.id));
        const changed = JSON.stringify({ state: existing.state, available: existing.available }) !== JSON.stringify({ state: next.state, available: next.available });
        if (changed) await notifyDeviceChanged(next, existing);
        continue;
      }
      const incomingDevice = {
        ...device,
        configEntryId: "ce_google_nest",
        ...(existing ? { name: existing.name, areaId: existing.areaId, labels: existing.labels, labelIds: existing.labelIds, setup: existing.setup } : {}),
      };
      const migrated = Boolean(existing && String(existing.id) !== String(device.id));
      const next = migrated
        ? await hubStore.migrateDeviceIdentity(existing.id, device.id, incomingDevice)
        : await hubStore.upsertDevice(incomingDevice);
      if (existing) reconciledExistingIds.add(String(existing.id));
      const changed = migrated || !existing || JSON.stringify({ state: existing.state, entities: existing.entities, available: existing.available, name: existing.name, areaId: existing.areaId, labels: existing.labels, setup: existing.setup }) !== JSON.stringify({ state: next.state, entities: next.entities, available: next.available, name: next.name, areaId: next.areaId, labels: next.labels, setup: next.setup });
      if (changed) await notifyDeviceChanged(next, existing);
    }
    for (const existing of hubStore.listDevices().filter((device) => String(device.protocol || "").toLowerCase() === "google_nest" && !incomingIds.has(String(device.id)) && !reconciledExistingIds.has(String(device.id)))) {
      if (existing.available === false) continue;
      const next = await hubStore.upsertDevice({ ...existing, available: false });
      await notifyDeviceChanged(next, existing);
    }
    return { thermostatDeviceCount: Number(snapshot.thermostatDeviceCount || incoming.length), unsupportedDeviceCount: Number(snapshot.unsupportedDeviceCount || 0) };
  }
  let lastGoogleNestStatus = "";
  function onGoogleNestStatus(status) {
    eventBus.emit("dinodia_dashboard_updated", { kind: "integration", integration: "googleNest", status, at: new Date().toISOString() });
    const current = String(status?.status || "");
    const previous = lastGoogleNestStatus;
    lastGoogleNestStatus = current;
    if (current === "reauth_required" && previous !== current) activity.record({ type: "google_nest_account_reauth_required", detail: "Google Nest authorization expired or was revoked; reconnect is required." }).catch((error) => logger.error(`[activity] ${error.message}`));
    if (current === "degraded" && previous !== current) activity.record({ type: "google_nest_integration_unavailable", detail: "Google Nest cloud is temporarily unavailable; Dinodia OS will retry with bounded backoff." }).catch((error) => logger.error(`[activity] ${error.message}`));
    if (current === "connected" && ["degraded", "reauth_required"].includes(previous)) activity.record({ type: "google_nest_integration_recovered", detail: "Google Nest cloud connectivity and authorization recovered." }).catch((error) => logger.error(`[activity] ${error.message}`));
  }
  const googleNest = googleNestBridge || new GoogleNestBridge({ store: hubStore, vault, config: runtimeConfig, onSnapshot: ingestGoogleNestSnapshot, onStatus: onGoogleNestStatus, logger, fetchImpl: googleNestFetchImpl, now: googleNestNow, updateSource: googleNestUpdateSource });
  const matterPairing = new MatterPairingSession({ matter, store: hubStore, ttlMs: runtimeConfig.matterPairingTtlMs, logger });
  if (matter && typeof matter === "object") matter.onDeviceIngested = (device) => matterPairing.observeDevice(device);
  const zigbeeRuntime = zigbeeService || new ZigbeeService({ composeFile: runtimeConfig.composeFile, envFile: runtimeConfig.envFile, projectDirectory: path.dirname(runtimeConfig.composeFile), logger });
  const threadRuntime = threadService || new ThreadService({ composeFile: runtimeConfig.composeFile, envFile: runtimeConfig.envFile, projectDirectory: path.dirname(runtimeConfig.composeFile), logger });
  const cloudflare = cloudflareTunnel || new CloudflareTunnel({
    store: hubStore,
    vault,
    origin: `http://127.0.0.1:${runtimeConfig.haPort}`,
    binary: runtimeConfig.cloudflaredBinary,
    initialToken: runtimeConfig.cloudflareTunnelToken,
    initialHostname: runtimeConfig.cloudflarePublicHostname,
    dataDir: runtimeConfig.dataDir,
    nodeEnv: runtimeConfig.nodeEnv,
    logger,
  });

  async function commandDevice(id, protocol, command) {
    const device = hubStore.getDevice(id);
    if (!device) throw Object.assign(new Error("Device not found"), { statusCode: 404 });
    const selected = protocol || device.protocol;
    if (selected === "zigbee") {
      await mqtt.command(device.id, command);
    } else if (selected === "matter") {
      await matter.command(device.id, command);
    } else if (selected === "hive") {
      const serviceId = command?.serviceId || command?.service_id;
      if (!serviceId) throw Object.assign(new Error("Hive commands must specify a service"), { statusCode: 400, code: "unsupported_service" });
      try {
        await hive.command(device, serviceId, command?.data || command);
        await activity.record({ type: "hive_command_succeeded", device: activity.deviceSnapshot(hubStore.getDevice(id)), detail: `${serviceId} accepted by Hive.`, change: { serviceId } });
      } catch (error) {
        await activity.record({ type: "hive_command_failed", device: activity.deviceSnapshot(device), detail: "Hive could not apply the requested control.", change: { serviceId, code: error.code || "hive_api_unavailable" } }).catch(() => {});
        throw error;
      }
    } else if (selected === "google_nest") {
      const serviceId = command?.serviceId || command?.service_id;
      if (!serviceId) throw Object.assign(new Error("Google Nest commands must specify a service"), { statusCode: 400, code: "unsupported_service" });
      try {
        await googleNest.command(device, serviceId, command?.data || command);
        await activity.record({ type: "google_nest_command_succeeded", device: activity.deviceSnapshot(hubStore.getDevice(id)), detail: `${serviceId} accepted by Google Nest.`, change: { serviceId } });
      } catch (error) {
        await activity.record({ type: "google_nest_command_failed", device: activity.deviceSnapshot(device), detail: "Google Nest could not apply the requested control.", change: { serviceId, code: error.code || "google_nest_api_unavailable" } }).catch(() => {});
        throw error;
      }
    } else if (selected === "virtual") {
      const previous = device;
      const patch = command && command.state && typeof command.state === "object" ? { ...command.state } : { ...(command || {}) };
      if (typeof patch.state === "string") {
        const preferredStateKey = Object.prototype.hasOwnProperty.call(device.state || {}, "power") ? "power" : "state";
        patch[preferredStateKey] = patch.state;
        if (preferredStateKey !== "state") delete patch.state;
      }
      for (const key of ["state", "power"]) {
        if (String(patch[key] || "").toUpperCase() !== "TOGGLE") continue;
        const current = device.state?.[key] ?? device.state?.power ?? device.state?.state;
        patch[key] = ["ON", "OPEN", "UNLOCK", "PLAY"].includes(String(current || "").toUpperCase()) ? "OFF" : "ON";
      }
      const updated = await hubStore.updateDeviceState(id, patch, { protocol: "virtual", available: true });
      await notifyDeviceChanged(updated, previous);
      await hubStore.addEvent({ type: "device_command", deviceId: id, protocol: "virtual" });
      return updated;
    } else {
      throw new Error(`Unsupported device protocol: ${selected}`);
    }
    return hubStore.getDevice(id);
  }

  async function commandEntity(device, entity, serviceId, data = {}, fallbackCommand = {}) {
    if (device.protocol === "zigbee" && entity.capability?.bindings?.length) {
      return mqtt.command(device.id, commandForZigbeeBinding(entity, serviceId, data));
    }
    if (device.protocol === "matter" && entity.capability?.bindings?.length) {
      return matter.command(device.id, commandForMatterBinding(entity, serviceId, data));
    }
    if (device.protocol === "hive" && entity.capability?.bindings?.length) {
      try {
        const result = await hive.command(device, serviceId, data);
        await activity.record({ type: "hive_command_succeeded", device: activity.deviceSnapshot(hubStore.getDevice(device.id)), detail: `${serviceId} accepted by Hive.`, change: { serviceId, entityId: entity.id } });
        return result;
      } catch (error) {
        await activity.record({ type: "hive_command_failed", device: activity.deviceSnapshot(device), detail: "Hive could not apply the requested control.", change: { serviceId, entityId: entity.id, code: error.code || "hive_api_unavailable" } }).catch(() => {});
        throw error;
      }
    }
    if (device.protocol === "google_nest" && entity.capability?.bindings?.length) {
      try {
        const result = await googleNest.command(device, serviceId, data);
        await activity.record({ type: "google_nest_command_succeeded", device: activity.deviceSnapshot(hubStore.getDevice(device.id)), detail: `${serviceId} accepted by Google Nest.`, change: { serviceId, entityId: entity.id } });
        return result;
      } catch (error) {
        await activity.record({ type: "google_nest_command_failed", device: activity.deviceSnapshot(device), detail: "Google Nest could not apply the requested control.", change: { serviceId, entityId: entity.id, code: error.code || "google_nest_api_unavailable" } }).catch(() => {});
        throw error;
      }
    }
    if (device.protocol === "virtual" && entity.capability?.bindings?.length) {
      const sourceService = String(serviceId || "").toLowerCase();
      let nextState;
      if (sourceService === "number.set_value") nextState = data.value;
      else if (sourceService === "select.select_option") nextState = data.option;
      else if (sourceService === "lock.lock") nextState = "LOCKED";
      else if (sourceService === "lock.unlock") nextState = "UNLOCKED";
      else if (["turn_on", "turn_off", "toggle"].includes(sourceService.split(".").pop())) {
        const operation = sourceService.split(".").pop();
        const current = String(entity.state || "").toUpperCase();
        nextState = operation === "turn_on" ? "ON" : operation === "turn_off" ? "OFF" : ["ON", "OPEN", "UNLOCK", "PLAY"].includes(current) ? "OFF" : "ON";
      }
      if (nextState !== undefined) {
        const previous = device;
        const updatedEntity = await hubStore.updateEntity(device.id, entity.id, {
          state: nextState,
          stateRevision: Math.max(0, Number(entity.stateRevision || entity.revision || 0)) + 1,
          lastChanged: new Date(clock()).toISOString(),
        });
        const updated = updatedEntity ? hubStore.getDevice(device.id) : null;
        if (!updated) return commandDevice(device.id, device.protocol, fallbackCommand);
        await notifyDeviceChanged(updated, previous);
        await hubStore.addEvent({ type: "device_command", deviceId: device.id, protocol: "virtual" });
        return updated;
      }
    }
    return commandDevice(device.id, device.protocol, fallbackCommand);
  }

  automation = new AutomationEngine({
    store: hubStore,
    executeAction: async (action) => {
      if (action && action.service && haModel) {
        const [domain, service] = String(action.service).split(".");
        await haModel.callService(domain, service, { ...(action.data || action.service_data || {}), ...(action.target || {}) });
        return;
      }
      if (!action || !action.deviceId) throw new Error("Automation action requires deviceId or service");
      const protocol = action.protocol || (hubStore.getDevice(action.deviceId) || {}).protocol;
      await commandDevice(String(action.deviceId), protocol, action.command || action.payload || {});
    },
    logger,
  });

  haModel = new HomeAssistantModel({
    store: hubStore,
    commandDevice,
    commandEntity,
    removeProtocolDevice: async (device, force) => {
      if (device.protocol === "zigbee") {
        const result = await mqtt.remove(device.id, force);
        mqtt.forgetDevice?.(device.id);
        return result;
      }
      if (device.protocol === "matter") {
        const result = await matter.remove(device.id, force);
        matter.forgetDevice?.(device.id);
        matterPairing.forgetDevice?.(device.id);
        return result;
      }
      if (device.protocol === "hive") {
        await hive.ignoreDevice(device);
        await activity.record({ type: "hive_device_ignored", device: activity.deviceSnapshot(device), detail: "This Hive device was hidden and will not be re-added automatically." });
        return true;
      }
      if (device.protocol === "google_nest") {
        await googleNest.ignoreDevice(device);
        await activity.record({ type: "google_nest_device_ignored", device: activity.deviceSnapshot(device), detail: "This Google Nest thermostat was hidden and will not be re-added automatically." });
        return true;
      }
      return true;
    },
    onDeviceRemoved: async (device) => {
      await activity.record({ type: "device_unpaired", device: activity.deviceSnapshot(device), detail: `${device.name} was completely removed from Dinodia OS.`, reportable: true, incident: { incidentId: `device_removed:${device.id}`, kind: "device_unpaired", state: "open", revision: 1, details: { protocol: device.protocol } } });
      await hubStore.saveActiveIncident(`device_offline:${device.id}`, null);
    },
    onDeviceChanged: async (device, previous) => {
      try { await activity.recordDeviceChanged(device, previous); } catch (error) { logger.error(`[activity] ${error.message}`); }
    },
    onEntityChanged: async (device, previousDevice, entity, previousEntity) => {
      try {
        await activity.record({
          type: entity ? "entity_configuration_changed" : "entity_removed",
          device: activity.deviceSnapshot(device || previousDevice),
          detail: entity ? "An entity name, area, or label changed." : "An entity was removed from the device.",
          change: { entityId: entity?.id || previousEntity?.id || null, before: previousEntity ? { name: previousEntity.name, areaId: previousEntity.areaId, labelIds: previousEntity.labelIds } : null, after: entity ? { name: entity.name, areaId: entity.areaId, labelIds: entity.labelIds } : null },
        });
      } catch (error) { logger.error(`[activity] ${error.message}`); }
    },
    eventBus,
    logger,
  });

  nativeAutomationService = new AutomationService({
    store: hubStore,
    getDevices: () => hubStore.listDevices(),
    getAreas: () => hubStore.listAreas(),
    getLabels: () => hubStore.listLabels(),
    activity,
    homeId: () => serial,
    logger,
  });
  nativeAutomationExecutor = new AutomationExecutor({
    store: hubStore,
    activity,
    logger,
    executeControl: async ({ automation, action }) => hubStore.withAutomationPolicyLock(async () => {
      const current = hubStore.getNativeAutomation(automation.id)?.automation;
      if (!current || current.enabled !== true || Number(current.revision) !== Number(automation.revision)) {
        throw Object.assign(new Error("The automation policy changed before this action could be dispatched"), { code: "automation_policy_changed" });
      }
      const device = hubStore.getDevice(action.deviceId);
      if (!device) throw Object.assign(new Error("The automation device is no longer available"), { code: "missing_device" });
      const match = findControl(nativeAutomationService.internalCatalogue(), action.deviceId, action.controlId);
      if (!match) throw Object.assign(new Error("The automation control is no longer available"), { code: "missing_control" });
      const compiled = compileTarget(match.control, action.targetValue);
      const route = resolveExecutionRoute(device, match.control, compiled);
      return commandEntity(device, route.entity, route.serviceId, route.data, {});
    }),
  });
  nativeAutomationScheduler = new AutomationScheduler({ store: hubStore, service: nativeAutomationService, executor: nativeAutomationExecutor, logger });

  heatingDemandController = new HeatingDemandController({
    store: hubStore,
    eventBus,
    activity,
    getDevices: () => hubStore.listDevices(),
    getIntegrations: () => integrationStatus(),
    commandResolver: ({ device, serviceId, data }) => {
      const surface = climateSurface(device);
      if (!surface) return { ok: false, reason: "The mapped boiler has no ready climate surface." };
      return commandValidation(surface, serviceId, data);
    },
    executeAction: async ({ deviceId, serviceId, data }) => {
      const device = hubStore.getDevice(deviceId);
      const surface = climateSurface(device);
      if (!device || !surface?.haEntityId) throw Object.assign(new Error("The mapped boiler climate entity is unavailable"), { code: "boiler_route_unavailable", statusCode: 409 });
      const [domain, service] = String(serviceId || "").split(".", 2);
      if (domain !== "climate" || !service) throw Object.assign(new Error("Heating controller only supports climate services"), { code: "unsupported_service", statusCode: 400 });
      return haModel.callService(domain, service, { entity_id: surface.haEntityId, ...(data || {}) });
    },
    logger,
  });

  let pairing;
  let nativeCommissioningService;
  alexaIntegration = new AlexaIntegration({
    store: hubStore,
    pairing,
    serial,
    config: runtimeConfig,
    getDevices: () => hubStore.listDevices(),
    getAreas: () => hubStore.listAreas(),
    executeControl: async ({ deviceId, surfaceId, serviceId, data }) => {
      const device = hubStore.getDevice(deviceId);
      if (!device) throw Object.assign(new Error("Device is no longer available"), { code: "no_such_endpoint", statusCode: 404 });
      const surface = allProjectedSurfaces(device).find((item) => String(item.id) === String(surfaceId));
      const route = surface?.serviceRoutes?.[serviceId];
      const entity = route?.entityId ? rawEntityById(device, route.entityId) : null;
      if (!surface || !route || !entity) throw Object.assign(new Error("The device control is no longer available"), { code: "invalid_directive", statusCode: 400 });
      return commandEntity(device, entity, route.serviceId || serviceId, data || {}, {});
    },
    logger,
  });

  async function handleRemoteEvent(event) {
    eventBus.emit("dinodia_remote_manager_event", event);
    const bindings = hubStore.listRemoteBindings ? hubStore.listRemoteBindings() : [];
    for (const binding of bindings) {
      const source = String(binding.sourceDeviceId || binding.device_id || binding.remote_device_id || "");
      const sourceDevice = hubStore.getDevice(event.deviceId) || haModel.findDevice(event.deviceId);
      const sourceRawId = sourceDevice?.id || event.deviceId;
      const sourceHaId = sourceDevice?.haDeviceId || "";
      if (binding.enabled === false || ![String(event.deviceId), String(sourceRawId), String(sourceHaId)].includes(source)) continue;
      if (binding.action && String(binding.action) !== String(event.action)) continue;
      const target = binding.target || { entity_id: binding.targetEntityId || binding.target_entity_id };
      const service = binding.service || binding.targetService || "toggle";
      const domain = binding.domain || (String(target.entity_id || "").split(".")[0]) || "homeassistant";
      try { await haModel.callService(domain, service, { ...(binding.data || {}), ...target }); }
      catch (error) { logger.error(`[remote-manager] ${error.message}`); }
    }
  }

  const heartbeat = platformSync || new PlatformSync({
    url: runtimeConfig.platformHeartbeatUrl,
    token: runtimeConfig.platformToken,
    hubId: serial,
    intervalMs: runtimeConfig.heartbeatIntervalMs,
    getSnapshot: () => ({
      version: VERSION,
      deviceCount: hubStore.listDevices().length,
      automationCount: hubStore.listAutomations().length,
      integrations: { mqtt: mqtt.status(), matter: matter.status(), hive: hive.status(), googleNest: googleNest.status() },
    }),
    logger,
  });

  pairing = new PlatformPairing({
    store: hubStore,
    vault,
    identityBroker,
    apiUrl: runtimeConfig.platformApiUrl,
    serial,
    haPort: runtimeConfig.haPort,
    intervalMs: runtimeConfig.operatorPolicySyncIntervalMs,
    heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
    getLanEndpoint: () => physicalLanListenersEnabled
      ? setupDiscovery.observation()
      : { version: 1, revision: 1, state: "UNAVAILABLE", discoveryHost: `dinodia-${serial.toLowerCase()}.local` },
    getLanTlsIdentity: () => lanTlsIdentity?.publicReport() || null,
    acknowledgeLanTlsIdentity: (generation) => lanTlsIdentity?.acknowledge(Number(generation)) || false,
    getUpdaterStatus: async () => {
      try {
        const result = await requestUpdaterControl({ operation: "status" }, updaterSocketPath);
        return result?.ok === true && result.status && typeof result.status === "object"
          ? result.status : { phase: "unavailable", trustState: "unavailable", activeReleaseVersion: null, lastAttempt: null, busy: false };
      } catch {
        return { phase: "unavailable", trustState: "unavailable", activeReleaseVersion: null, lastAttempt: null, busy: false };
      }
    },
    reconcileTenantDeviceRemoval: async ({ osDeviceId, ownerMembershipId }) => runNativeCommandSerial(async () => {
      const device = hubStore.getDevice(String(osDeviceId || ""));
      if (!device) return true;
      const localOwner = String(device.tenantOwnerMembershipId || device.metadata?.tenantOwnerMembershipId || "");
      if (String(device.managementClass || device.metadata?.managementClass || "").toLowerCase() !== "tenant_device"
        || !localOwner || localOwner !== String(ownerMembershipId || "")) return false;
      const currentPolicy = hubStore.getPlatform?.()?.devicePolicies?.[String(osDeviceId)] || null;
      if (currentPolicy?.managementClass === "TENANT_DEVICE"
        && String(currentPolicy.ownerMembershipId || "") === localOwner
        && ["INSTALLED", "VIEW_ONLY"].includes(String(currentPolicy.lifecycle))) return false;
      const removed = await haModel.removeDevice({ device_id: String(osDeviceId), force: false });
      return removed === true || !hubStore.getDevice(String(osDeviceId));
    }),
    runtime: {
      nodeEnv: runtimeConfig.nodeEnv,
      kind: "dinodia_os",
      version: VERSION,
      capabilities: { managedAreaProvisioningV1: true, managedDevicePresentationV1: true, activityIncidentReportingV1: true, alexaNativeProjectionV1: true, alexaNativeDirectiveV1: true,
        ...runtimeConfig.nativeCommissioningCapabilities },
    },
    getAreaSnapshot: () => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), areas: hubStore.listAreas().map((area) => ({ areaId: area.id, name: area.name })) }),
    getHeatingUsage: () => heating.payload(),
    getHeatingUsageResetAck: () => heating.resetAcknowledgement(),
    getElectricUsage: () => electric.payload(),
    getElectricUsageResetAck: () => electric.resetAcknowledgement(),
    getActivityIncidents: () => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), incidents: activity.store.listPendingIncidentEnvelopes(100).map((entry) => entry.envelope).filter((envelope) => envelope?.severity === "critical" && ["open", "resolved"].includes(envelope?.state)) }),
    getAlexaCatalog: () => alexaIntegration?.publicCatalog?.() || null,
    acceptOfflineAuthorisations: async (rows) => { for (const row of Array.isArray(rows) ? rows : []) await offlineLanAuthorisations.acceptPlatformEnvelope(row); },
    onOperatorCredentialStateChange: async () => {
      // A normal scheduled credential rotation must not end an already-issued
      // browser grant. The machine-authenticated durable revalidation path
      // distinguishes emergency revocation from ordinary grace retirement.
      await syncOperatorBrowserSessions();
    },
    legacyCompatibilityEnabled,
    onSyncResult: async (result, payload, resetAckAt, electricPayload, electricResetAckAt) => {
      heating.applyPlatformResponse(result);
      if (payload?.devices) heating.acknowledgeUploaded(payload.devices.map((entry) => entry.entityId));
      if (resetAckAt) heating.acknowledgeReset(resetAckAt);
      electric.applyPlatformResponse(result);
      if (electricPayload?.devices) electric.acknowledgeUploaded(electricPayload.devices);
      if (electricResetAckAt) electric.acknowledgeReset(electricResetAckAt);
      if (Array.isArray(result.acceptedActivityIncidentIds)) await activity.store.acknowledgeIncidentEnvelopes(result.acceptedActivityIncidentIds);
    },
    logger,
  });
  alexaIntegration.pairing = pairing;
  if (alexaIntegration.platformSync) alexaIntegration.platformSync.pairing = pairing;
  nativeCommissioningService = new NativeCommissioningService({ store: hubStore, mqtt, matter, pairing, vault, eventBus,
    commissioningCapabilities: runtimeConfig.nativeCommissioningCapabilities, clock, logger });
  eventBus.on("registry_updated", (event) => {
    if (event?.registry === "area") pairing.syncNow().catch(() => {});
  });

  const configuredHaToken = legacyCompatibilityEnabled ? String(runtimeConfig.haToken || "") : "";
  const existingAuth = hubStore.getAuth ? hubStore.getAuth() : {};
  let pendingHaToken = "";
  let pendingHaPassword = "";
  if (configuredHaToken && !existingAuth.haTokenHash) {
    hubStore.saveAuth({ haTokenHash: hashTokenValue(configuredHaToken), issuedAt: new Date().toISOString() }).catch((error) => logger.error(`[auth] ${error.message}`));
  }
  if (legacyCompatibilityEnabled && !configuredHaToken && !existingAuth.haTokenHash) {
    pendingHaToken = `dinodia_${crypto.randomBytes(30).toString("base64url")}`;
    hubStore.saveAuth({ haTokenHash: hashTokenValue(pendingHaToken), issuedAt: new Date().toISOString() }).catch((error) => logger.error(`[auth] ${error.message}`));
  }
  if (legacyCompatibilityEnabled && !existingAuth.passwordHash) {
    pendingHaPassword = `Dino-${crypto.randomBytes(12).toString("base64url")}`;
    const salt = crypto.randomBytes(16).toString("hex");
    const digest = crypto.scryptSync(pendingHaPassword, salt, 32).toString("hex");
    hubStore.saveAuth({ passwordHash: `scrypt$${salt}$${digest}`, issuedAt: existingAuth.issuedAt || new Date().toISOString() }).catch((error) => logger.error(`[auth] ${error.message}`));
  }
  const hubAgentFallbackToken = legacyCompatibilityEnabled ? String(runtimeConfig.hubAgentToken || (runtimeConfig.nodeEnv === "development" ? "dev-hub-token" : "")) : "";
  const tokenMatchesHash = (token, expectedHash) => {
    const actual = Buffer.from(hashTokenValue(token));
    const expected = Buffer.from(String(expectedHash || ""));
    return actual.length === expected.length && actual.length > 0 && crypto.timingSafeEqual(actual, expected);
  };
  const hubAgentAuth = (token) => {
    if (runtimeConfig.nodeEnv === "production") return false;
    if (!token || String(token).length > 256) return false;
    if (hubAgentFallbackToken && safeEqual(token, hubAgentFallbackToken)) return true;
    return hubStore.getPlatform().acceptedTokenHashes.some((hash) => tokenMatchesHash(token, hash));
  };
  const haAuth = (token) => {
    if (!legacyCompatibilityEnabled) return false;
    if (!token || String(token).length > 256) return false;
    const storedHash = hubStore.getAuth?.().haTokenHash || "";
    // Keep the explicitly configured token usable alongside a persisted token
    // hash. Existing iOS/platform clients may still hold either credential
    // during provisioning and migration.
    const configuredFallback = configuredHaToken && safeEqual(token, configuredHaToken);
    const developmentDashboardFallback = runtimeConfig.nodeEnv === "development" && !configuredHaToken && runtimeConfig.adminToken && safeEqual(token, runtimeConfig.adminToken);
    return Boolean(configuredFallback || developmentDashboardFallback || (pendingHaToken && safeEqual(token, pendingHaToken)) || tokenMatchesHash(token, storedHash));
  };
  const compatibilityFlows = {
    matter: { configure: async (data) => {
      if (!data.code) return { type: "abort", reason: "missing_code" };
      const result = await matter.commission(data.code, data.networkOnly);
      return { type: "create_entry", title: "Matter", result: result || {} };
    } },
    dinodia_remote_manager: { configure: async () => {
      const entry = await hubStore.saveConfigEntry({ entry_id: "ce_remote_manager", domain: "dinodia_remote_manager", title: "Dinodia Remote Manager" });
      return { type: "create_entry", title: entry.title, result: entry };
    } },
  };
  const haCompat = createCompatInterface({
    port: runtimeConfig.haPort,
    host: runtimeConfig.haHost,
    model: haModel,
    store: hubStore,
    auth: haAuth,
    // The dashboard websocket is multiplexed through the compatibility
    // listener, so its explicitly supplied compatibility admin token remains
    // accepted for dashboard sessions. It is intentionally not accepted by
    // the HTTP HA compatibility API above.
    // The compatibility WebSocket broadcasts the complete hub entity model.
    // It is therefore an operator-only surface in production; app tokens must
    // use the scoped native HTTP contract so a tenant can never receive a
    // cross-area or private-device broadcast through this legacy transport.
    wsAuth: (token, request) => {
      // Same-origin WebSockets carry the opaque HttpOnly browser handle in the
      // upgrade Cookie header; the browser never receives the signed bearer.
      const browserToken = request ? browserOperatorToken(request) : "";
      const operatorToken = browserToken || token;
      const principal = operatorSessionAuth(operatorToken);
      if (principal && principal.scope.includes("os:admin")) return principal;
      // Native customer credentials are accepted only by the canonical
      // /api/dinodia/v1 HTTP and event boundaries below. The HA-shaped
      // compatibility socket has broader request shapes and must never
      // become an alternate customer command or state channel.
      if (appSessionAuth(token)) return null;
      if (!legacyCompatibilityEnabled) return null;
      const haPrincipal = haAuth(token);
      if (haPrincipal) return { principalType: "legacy_ha", credentialFingerprint: hashTokenValue(token).slice(0, 32) };
      if (runtimeConfig.nodeEnv === "development" && runtimeConfig.adminToken && safeEqual(token, runtimeConfig.adminToken)) return { principalType: "legacy_admin", credentialFingerprint: hashTokenValue(token).slice(0, 32) };
      return null;
    },
    authorizeWsMessage: async (message, principal, context) => {
      if (!principal || principal.principalType !== "app") {
        // The HA compatibility surface is test/development-only. It never
        // authenticates a native route and is disabled by the production
        // boundary above; keep its legacy message authorization isolated so
        // existing compatibility fixtures remain truthful without creating a
        // production bypass.
        if (principal?.principalType === "operator") {
          const current = operatorSessionAuth(principal.authToken);
          if (!current || !current.scope.includes("os:admin")) {
            context.socket?.close?.(4401, "Operator session expired or revoked");
            return false;
          }
          return true;
        }
        return runtimeConfig.nodeEnv !== "production" && legacyCompatibilityEnabled && ["legacy_ha", "legacy_admin"].includes(principal?.principalType);
      }
      // A native app token is short-lived, but a WebSocket can outlive its
      // original HTTP request. Revalidate the exact signed token against the
      // current hub policy before every message so a policy/session/trusted
      // device change cannot leave an already-connected socket authorized.
      // The raw token exists only in this in-memory socket principal and is
      // never serialized or returned to the client.
      if (!principal.authToken || !appSessionAuth(principal.authToken)) {
        context.socket?.close?.(4401, "Policy changed");
        return false;
      }
      if (["get_states", "subscribe_events", "unsubscribe_events", "get_services_for_target"].includes(String(message.type))) return true;
      if (message.type !== "call_service" || principal.householdRole !== "TENANT" || !principal.scope.includes("tenant:device-command")) return false;
      const target = { ...(message.service_data || {}), ...(message.target || {}) };
      // Native tenant WS commands are single-control operations. Reject
      // device/area/label selectors and multi-entity values instead of
      // authorizing one entity and letting the HA compatibility model expand
      // the request to other devices during dispatch.
      const forbiddenSelectors = ["device_id", "deviceId", "area_id", "areaId", "label_id", "labelId", "target"];
      if (forbiddenSelectors.some((key) => Object.prototype.hasOwnProperty.call(target, key))) return false;
      if (Object.prototype.hasOwnProperty.call(target, "entity_id") && Object.prototype.hasOwnProperty.call(target, "entityId")) return false;
      const rawEntityId = target.entity_id ?? target.entityId;
      if (typeof rawEntityId !== "string" || !rawEntityId.trim() || /[,\s]/.test(rawEntityId.trim())) return false;
      const entityId = rawEntityId.trim();
      const entity = context.model.entities().find((item) => item.haId === entityId || item.entityId === entityId || item.rawId === entityId);
      if (!entity) return false;
      const targets = context.model.resolveTargets({ entity_id: entityId });
      if (targets.length !== 1 || targets[0].haId !== entity.haId) return false;
      const requestedService = message.domain && message.service
        ? `${String(message.domain).toLowerCase()}.${String(message.service).toLowerCase()}`
        : message.service;
      if (!appCanCommandDevice(principal, entity.device, target, entity, requestedService)) return false;

      const requestedDomain = String(message.domain || entity.domain || "").toLowerCase();
      const sensitive = Boolean(entity.entity?.capability?.sensitive) || /^(lock|alarm|security)$/i.test(requestedDomain.split(".")[0]);
      if (sensitive) {
        const descriptorDigests = message.descriptorDigests && typeof message.descriptorDigests === "object" && !Array.isArray(message.descriptorDigests)
          ? message.descriptorDigests
          : {};
        const currentDescriptor = stepUpDescriptorDigest(entity.device);
        const suppliedDescriptor = descriptorDigests[entity.device.id] == null ? null : String(descriptorDigests[entity.device.id]);
        const controlId = String(target.controlId || target.control_id || entity.entity?.controlId || entity.entity?.capability?.controlId || entity.entity?.id || "");
        if (!controlId || !currentDescriptor || !Object.prototype.hasOwnProperty.call(descriptorDigests, entity.device.id) || suppliedDescriptor !== currentDescriptor) return false;
        const serviceData = { ...target };
        for (const key of ["entity_id", "entityId", "controlId", "control_id", "stepUpProof", "step_up_proof", "descriptorDigests", "descriptor_digests"]) delete serviceData[key];
        const requestedValue = { ...serviceData, controlId };
        const proof = String(message.stepUpProof || message.step_up_proof || target.stepUpProof || target.step_up_proof || "");
        const approved = await stepUpVerifier.verify(proof, {
          actorId: principal.sub,
          trustedDeviceId: principal.trustedDeviceId,
          trustedSessionId: principal.sid,
          homeId: principal.homeId,
          membershipId: principal.membershipId,
          hubInstallId: principal.hubInstallId,
          operation: "device_sensitive_command",
          targetIds: [entity.device.id],
          value: descriptorBoundValue(requestedValue, { [entity.device.id]: suppliedDescriptor }),
        });
        if (!approved) return false;
      }
      return true;
    },
    filterWsStates: (states, principal) => {
      if (principal?.principalType !== "app") return states;
      const entities = new Map((haModel?.entities?.() || []).map((item) => [item.haId, item]));
      return states.filter((state) => {
        const entity = entities.get(state.entity_id);
        // An app principal may only receive entities that are present in the
        // current dynamic descriptor. Unknown legacy/raw states fail closed;
        // they must never become an accidental tenant-device side channel.
        return entity ? appCanReadDevice(principal, entity.device) : false;
      });
    },
    filterWsEvent: (eventType, data, principal) => {
      if (principal?.principalType !== "app") return data;
      if (eventType !== "state_changed") return null;
      const entityId = String(data?.entity_id || data?.entityId || "");
      const entity = (haModel?.entities?.() || []).find((item) => item.haId === entityId || item.entityId === entityId || item.rawId === entityId);
      return entity && appCanReadDevice(principal, entity.device) ? data : null;
    },
    onAuthenticated: (socket, principal) => {
      if (principal?.principalType === "operator" || principal?.principalType === "app") {
        const untrack = revocationCoordinator.track(socket, {
          fingerprint: principal.credentialFingerprint,
          jti: principal.jti,
          homeId: principal.homeId || null,
          credentialVersion: principal.credentialVersion || null,
        });
        socket.once?.("close", untrack);
      }
      if (principal?.principalType === "operator") {
        let stopped = false;
        let freshnessTimer;
        let expiryTimer;
        const checkFreshness = () => {
          if (stopped) return;
          const session = [...operatorBrowserSessions.values()].find((entry) => entry.jti === String(principal.jti));
          if (!session || operatorNow() >= session.expiresAt) { socket.close?.(4401, "Operator session expired"); return; }
          const remaining = session.lastAuthorizationCheckAt + 60_000 - operatorNow();
          if (remaining <= 0) { socket.close?.(4401, "Operator authorization could not be revalidated"); return; }
          freshnessTimer = setTimeout(checkFreshness, remaining);
          freshnessTimer.unref?.();
        };
        const expiryDelay = Math.max(1, Number(principal.exp) * 1000 - operatorNow());
        expiryTimer = setTimeout(() => socket.close?.(4401, "Operator session expired"), expiryDelay);
        expiryTimer.unref?.();
        checkFreshness();
        socket.once?.("close", () => { stopped = true; clearTimeout(freshnessTimer); clearTimeout(expiryTimer); });
      }
    },
    eventBus,
    onRegistryChange: async (change) => {
      if (change?.source !== "ha_compat" || change.registry !== "area") return;
      const current = change.current || change.previous;
      await activity.record({
        type: change.action === "created" ? "area_created" : change.action === "removed" ? "area_removed" : "area_renamed",
        area: current ? { id: current.id, name: current.name } : null,
        detail: change.action === "removed" ? `Area ${current?.name || current?.id || "unknown"} was removed.` : `Area ${current?.name || "unknown"} was ${change.action}.`,
        change: change.previous && change.current && change.previous.name !== change.current.name ? { field: "name", before: change.previous.name, after: change.current.name } : null,
      });
    },
    mqtt,
    syncStatus: () => pairing.status(),
    logger,
    hubAgent: false,
    healthMode: runtimeConfig.nodeEnv === "production" ? "native-v2" : undefined,
    buildId: runtimeConfig.buildId,
    flowHandlers: compatibilityFlows,
    onRemoteEvent: handleRemoteEvent,
  });
  const hubAgentCompat = createCompatServer({
    port: runtimeConfig.hubAgentPort,
    host: runtimeConfig.haHost,
    model: haModel,
    store: hubStore,
    auth: hubAgentAuth,
    eventBus,
    mqtt,
    syncStatus: () => pairing.status(),
    logger,
    hubAgent: true,
    healthMode: "hub-agent",
    buildId: runtimeConfig.buildId,
    flowHandlers: compatibilityFlows,
    onRemoteEvent: handleRemoteEvent,
  });

  async function integrationStatus() {
    const zigbeeSettings = hubStore.getZigbee();
    const threadSettings = hubStore.getThread ? hubStore.getThread() : { configured: false, rcpDevice: "", rcpName: "", baudRate: runtimeConfig.threadRcpBaudRate, infraIf: runtimeConfig.otInfraIf, threadIf: runtimeConfig.otThreadIf };
    const adapterPath = zigbeeSettings.adapterPath || runtimeConfig.zigbeeAdapterPath || "";
    const configuredRcpDevice = threadSettings.rcpDevice || runtimeConfig.threadRcpDevice || "";
    const otbrBaseUrl = runtimeConfig.otbrUrl || (configuredRcpDevice ? "http://127.0.0.1:8081" : "");
    const otbr = await fetchOtbr(otbrBaseUrl ? `${otbrBaseUrl.replace(/\/$/, "")}/node` : "");
    const cloudflareStatus = cloudflare.status();
    const pairingStatus = pairing.status();
    const nativeAutomationSummary = () => {
      const projections = hubStore.listNativeAutomations().map((item) => nativeAutomationService.projected(item.id)).filter(Boolean);
      const nextRuns = projections.map((item) => item.health?.nextRunAt).filter(Boolean).sort();
      const scheduler = nativeAutomationScheduler.status();
      return { mode: runtimeConfig.nativeAutomationsMode, nativeCount: projections.length, enabledCount: projections.filter((item) => item.enabled).length, suspendedCount: projections.filter((item) => item.health?.state === "suspended").length, nextRunAt: nextRuns[0] || null, schedulerRunning: scheduler.schedulerRunning, lastTickAt: scheduler.lastTickAt, lastErrorCode: scheduler.lastError ? "scheduler_error" : null, scheduler };
    };
    const result = {
      mqtt: mqtt.status(),
      zigbee: { ...mqtt.status(), service: await zigbeeRuntime.status(), adapterPath, adapterName: zigbeeSettings.adapterName || "", discoveryPrefix: zigbeeSettings.discoveryPrefix || runtimeConfig.zigbeeDiscoveryPrefix },
      matter: matter.status(),
      matterPairing: matterPairing.status(),
      otbr: { ...otbr, service: await threadRuntime.status(), rcpDevice: configuredRcpDevice, rcpName: threadSettings.rcpName || "", baudRate: threadSettings.baudRate || runtimeConfig.threadRcpBaudRate, infraIf: threadSettings.infraIf || runtimeConfig.otInfraIf, threadIf: threadSettings.threadIf || runtimeConfig.otThreadIf },
      platform: { ...heartbeat.status(), pairing: pairingStatus },
      stateChange: stateNotifier.status(),
      heatingUsage: heating.status(),
      electricUsage: electric.status(),
      nativeAutomations: nativeAutomationSummary(),
      cloudflare: cloudflareStatus,
      hive: hive.status(),
      googleNest: googleNest.status(),
      alexa: alexaIntegration ? alexaIntegration.status() : { available: runtimeConfig.alexaNativeEnabled, state: "starting", linked: false, endpointCount: 0 },
    };
    const integrationChecks = [
      ["zigbee2mqtt", !result.zigbee.configured || Boolean(result.zigbee.connected && (result.zigbee.service?.running !== false))],
      ["matter", !result.matter.configured || Boolean(result.matter.connected)],
      ["thread", !result.otbr.configured || Boolean(result.otbr.reachable && result.otbr.service?.running !== false)],
      ["cloudflare", !cloudflareStatus.configured || Boolean(cloudflareStatus.secureAccessVerified)],
      ["hive", !result.hive.configured || ["connected", "disconnected"].includes(String(result.hive.status || ""))],
      ["google_nest", !result.googleNest.configured || ["connected", "disconnected", "disabled"].includes(String(result.googleNest.status || ""))],
      ["platform", !pairingStatus.configured || !pairingStatus.paired || !pairingStatus.lastError],
      ["ethernet", ethernetIsAvailable(runtimeConfig.otInfraIf)],
    ];
    for (const [name, healthy] of integrationChecks) activity.observeIntegration(name, healthy).catch((error) => logger.error(`[activity] ${error.message}`));
    return result;
  }

  async function readiness() {
    const integrations = await integrationStatus();
    const checks = {
      storage: Boolean(hubStore.filePath),
      dashboard: server.listening,
      homeAssistant: server.listening,
      unifiedWeb: server.listening,
      hubAgent: hubAgentCompat.server.listening,
      mqtt: !integrations.mqtt.configured || Boolean(integrations.mqtt.connected),
      zigbee: !integrations.zigbee.configured || Boolean(integrations.zigbee.connected),
      matter: !integrations.matter.configured || Boolean(integrations.matter.connected),
      cloudflare: !integrations.cloudflare.configured || Boolean(integrations.cloudflare.connected),
      hive: !integrations.hive.configured || ["connected", "disconnected"].includes(String(integrations.hive.status || "")),
      googleNest: !integrations.googleNest.configured || ["connected", "disconnected", "disabled"].includes(String(integrations.googleNest.status || "")),
      platform: !integrations.platform.pairing.configured || Boolean(integrations.platform.pairing.paired && integrations.platform.pairing.acceptedTokenCount > 0),
      thread: !integrations.otbr.configured || (Boolean(integrations.otbr.service?.running) && Boolean(integrations.otbr.reachable) && ["leader", "router", "child", "detached"].includes(integrations.otbr.state)),
      nativeAutomations: runtimeConfig.nativeAutomationsMode !== "enabled" || Boolean(integrations.nativeAutomations?.scheduler?.schedulerRunning),
    };
    const ok = checks.storage && checks.dashboard && checks.homeAssistant && checks.unifiedWeb && checks.hubAgent;
    const degraded = !Object.values(checks).every(Boolean);
    return { ok, status: ok && !degraded ? "ready" : ok ? "degraded" : "not_ready", checks, integrations };
  }

  function hiveCredentialTransportAllowed(req) {
    return isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, allowInsecure: runtimeConfig.hiveAllowInsecureSetup, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "" });
  }
  function googleNestCredentialTransportAllowed(req) {
    return isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
  }
  function googleNestCallbackUri() {
    const hostname = String(runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return hostname && /^[a-z0-9.-]+(?::\d+)?$/i.test(hostname) ? "https://" + hostname + runtimeConfig.googleNestCallbackPath : "";
  }
  function googleNestDashboardStatus() {
    const status = googleNest.status();
    return { ...status, callbackUri: status.callbackUri || googleNestCallbackUri() };
  }

  async function handleNativeAlexaPlatformRequest(req, res, url) {
    if (!hubAgentAuth(bearerToken(req))) return json(res, 401, { error: "Hub token required", errorCode: "invalid_hub_token" });
    const suffix = url.pathname.slice("/_dinodia/platform/v1/alexa".length) || "/health";
    if (suffix === "/health" && req.method === "GET") return json(res, 200, { ok: true, ...alexaIntegration.status() });
    if (suffix === "/catalog" && req.method === "GET") return json(res, 200, alexaIntegration.publicCatalog());
    if (suffix === "/state" && req.method === "GET") {
      const endpointId = String(url.searchParams.get("endpointId") || "");
      const catalog = alexaIntegration.catalogue || alexaIntegration.buildCatalog();
      const endpoint = require("./integrations/alexa/catalogService").internalEndpoint(catalog, endpointId);
      if (!endpoint) return json(res, 404, { error: "Endpoint is no longer available", errorCode: "no_such_endpoint" });
      return json(res, 200, { endpointId: endpoint.endpointId, state: endpoint.state, available: endpoint.available, sourceUpdatedAt: endpoint.sourceUpdatedAt });
    }
    if (suffix === "/directives" && req.method === "POST") {
      try {
        const result = await alexaIntegration.handleDirective(await readBody(req));
        return json(res, 200, result);
      } catch (error) {
        return json(res, Number(error.statusCode) || 500, { error: error.message || "Directive failed", errorCode: error.code || "internal_error" });
      }
    }
    return json(res, 404, { error: "Unknown Alexa platform route" });
  }

  function appCanReadDevice(principal, device) {
    if (!principal || !["app", "offline"].includes(principal.principalType) || !device) return false;
    const platformHomeId = String(hubStore.getPlatform?.()?.homeId || "");
    if (platformHomeId && String(principal.homeId || "") !== platformHomeId) return false;
    if (!validateNativeMembership({
      accountId: String(principal.sub || ""),
      homeId: String(principal.homeId || ""),
      homeMembershipId: String(principal.membershipId || ""),
      role: String(principal.householdRole || ""),
      status: "active",
      areaIds: Array.isArray(principal.areaIds) ? principal.areaIds.map(String) : [],
      revision: Number(principal.policyRevision),
    }, String(principal.homeId || ""))) return false;
    // Homeowners and property managers use the Supabase projection. They do
    // not receive a local OS read or command authority, even when they have a
    // valid property:read token.
    if (String(principal.householdRole || "") !== "TENANT") return false;
    const areaId = canonicalAreaIdForHubArea(device.areaId || device.metadata?.areaId);
    const areaIds = new Set((principal.areaIds || []).map(String));
    if (!areaId || !areaIds.has(areaId)) return false;
    const platformPolicy = hubStore.getPlatform?.()?.devicePolicies?.[String(device.id)] || null;
    if (platformPolicy && ["RETIRED", "REMOVED", "REMOVAL_PENDING", "RECOMMISSION_REQUIRED"].includes(String(platformPolicy.lifecycle))) return false;
    const ownerMembershipId = String(platformPolicy?.ownerMembershipId || device.tenantOwnerMembershipId || device.metadata?.tenantOwnerMembershipId || "");
    const managementClass = platformPolicy?.managementClass === "TENANT_DEVICE" ? "tenant_device" : String(device.managementClass || device.metadata?.managementClass || "");
    const privateDevice = managementClass === "tenant_device" || Boolean(ownerMembershipId);
    // The durable membership is the only tenant-device authority. The legacy
    // account-level tenantOwnerId is deliberately ignored and can never grant
    // access, even if it happens to match the current account.
    if (privateDevice && (!ownerMembershipId || ownerMembershipId !== String(principal.membershipId || ""))) return false;
    return true;
  }

  // The authenticated token carries only Platform Area UUIDs. The machine-
  // authenticated token-state sync supplies the private Hub area aliases to
  // this process; aliases are never copied into a customer token or DTO.
  function canonicalAreaIdForHubArea(value) {
    const hubAreaId = String(value || "");
    if (!hubAreaId) return "";
    const bindings = hubStore.getPlatform?.().areaBindings || [];
    const matches = bindings.filter((binding) => String(binding.hubAreaId || "") === hubAreaId);
    return matches.length === 1 ? String(matches[0].areaId || "") : "";
  }

function nativeDeviceView(principal, device) {
    const canonicalAreaId = canonicalAreaIdForHubArea(device?.areaId || device?.metadata?.areaId);
    if (!canonicalAreaId || !(principal?.areaIds || []).map(String).includes(canonicalAreaId)) return null;
    const policy = hubStore.getPlatform?.()?.devicePolicies?.[String(device.id)] || null;
    return {
      ...device,
      areaId: canonicalAreaId,
      ...(policy ? {
        managementClass: policy.managementClass === "TENANT_DEVICE" ? "tenant_device" : "property_device",
        tenantOwnerMembershipId: policy.ownerMembershipId || null,
        name: policy.overrideName || device.name,
        customerLabel: policy.customerLabel || device.customerLabel,
        setup: { ...(device.setup || {}), viewOnly: String(policy.lifecycle || "").toUpperCase() === "VIEW_ONLY" },
        retired: ["RETIRED", "REMOVED", "REMOVAL_PENDING", "RECOMMISSION_REQUIRED"].includes(String(policy.lifecycle)),
      } : {}),
    };
  }

  function nativeContractError(res, status, code, message, retryable = false) {
    return json(res, status, { error: { code, message, requestId: crypto.randomUUID(), retryable } });
  }

  function nativeStreamId() { return nativeStreamIdValue; }

  function nativeSequence() {
    return Math.max(0, Number(hubStore.getSecurity?.()?.nativeEventSequence || 0));
  }

  function nativeAreasFor(principal) {
    const publicAreaIds = new Set((principal.areaIds || []).map(String));
    const homeId = String(principal.homeId || "");
    return hubStore.listAreas().flatMap((area) => {
      const id = canonicalAreaIdForHubArea(area.id);
      if (!id || !publicAreaIds.has(id)) return [];
      const value = { id, homeId, originalName: String(area.name || "Area").slice(0, 80), overrideName: null, revision: Number.isInteger(area.revision) ? area.revision : 0, lifecycle: "active" };
      return validateNativeArea(value, homeId) ? [value] : [];
    });
  }

  function nativeDevicesFor(principal) {
    const homeId = String(principal.homeId || "");
    const areaIds = (principal.areaIds || []).map(String);
    return hubStore.listDevices()
      .filter((device) => !nativeDeviceIsRetired(device) && !nativeCommissioningService?.isQuarantinedDevice(device.id)
        && !["needs_setup", "interviewing", "commissioning"].includes(String(device.setup?.status || "").toLowerCase())
        && appCanReadDevice(principal, device))
      .map((device) => serializeNativeDevice({
        device: nativeDeviceView(principal, device), homeId, homeMembershipId: String(principal.membershipId),
        role: String(principal.householdRole), areaIds, surfaces: allProjectedSurfaces(device),
        revision: Number(device.presentation?.descriptorRevision || device.descriptorRevision || 0),
      }))
      .filter(Boolean);
  }

  function nativeDeviceIsRetired(device) {
    return device?.retired === true || ["RETIRED", "REMOVED", "REPLACED", "DEREGISTERED", "RECOMMISSION_REQUIRED"].includes(String(device?.lifecycle || "").toUpperCase());
  }

  function rememberNativeCatalog(devices) {
    nativeEventQueue = nativeEventQueue.then(async () => {
      const security = hubStore.getSecurity?.() || {};
      const prior = Array.isArray(security.nativeCatalogIndex) ? security.nativeCatalogIndex : [];
      const byId = new Map(prior.map((entry) => [String(entry.deviceId), entry]));
      for (const dto of devices) {
        byId.set(dto.id, {
          deviceId: dto.id,
          alias: String(hubStore.getDevice(dto.id)?.haDeviceId || dto.id),
          homeId: dto.homeId,
          areaIds: dto.areaIds,
          managementClass: dto.managementClass,
          ownerMembershipId: dto.ownerMembershipId || null,
          descriptorRevision: dto.descriptorRevision,
          controlIds: dto.controls.map((control) => control.controlId),
        });
      }
      await hubStore.saveSecurity({ ...security, nativeCatalogIndex: [...byId.values()].slice(-512) });
    }).catch((error) => logger.warn(`[native-events] catalogue cursor write failed (${String(error?.code || "storage_unavailable")})`));
    return nativeEventQueue;
  }

  function nativeControlStates(principal, devices, onlyDeviceId = null) {
    const now = Number(clock());
    const states = [];
    for (const dto of devices) {
      if (onlyDeviceId && dto.id !== onlyDeviceId) continue;
      const source = hubStore.getDevice(dto.id);
      if (!source || !appCanReadDevice(principal, source)) continue;
      for (const control of dto.controls) {
        if (!control.observable || !Number.isInteger(control.maxStateValiditySeconds) || control.maxStateValiditySeconds <= 0) continue;
        const entity = nativeRawEntityForControl(source, control.controlId);
        const rawState = entity?.state && typeof entity.state === "object" && !Array.isArray(entity.state) && Object.hasOwn(entity.state, "state") ? entity.state.state : entity?.state;
        const observedMs = Date.parse(String(entity?.lastChanged || entity?.last_changed || ""));
        const receivedMs = Date.parse(String(entity?.updatedAt || ""));
        const hasObservedAt = Number.isFinite(observedMs);
        const hasReceivedAt = Number.isFinite(receivedMs);
        const effectiveObservedMs = hasObservedAt ? observedMs : NaN;
        const effectiveReceivedMs = hasReceivedAt ? receivedMs : hasObservedAt ? observedMs : NaN;
        const observedAt = Number.isFinite(effectiveObservedMs) ? new Date(effectiveObservedMs).toISOString() : null;
        const receivedAt = Number.isFinite(effectiveReceivedMs) ? new Date(Math.max(effectiveReceivedMs, Number.isFinite(effectiveObservedMs) ? effectiveObservedMs : effectiveReceivedMs)).toISOString() : null;
        const validUntilMs = Number.isFinite(effectiveObservedMs) ? effectiveObservedMs + control.maxStateValiditySeconds * 1000 : NaN;
        const isExpired = Number.isFinite(validUntilMs) && validUntilMs <= now;
        let value = rawState;
        if (!hasObservedAt) value = null;
        if (control.valueType === "boolean" && typeof value !== "boolean") {
          const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
          value = normalized === "on" || normalized === "true" ? true : normalized === "off" || normalized === "false" ? false : null;
        }
        if (control.valueType === "number" && typeof value !== "number") value = value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
        if (control.valueType === "option" && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") value = null;
        if (control.valueType === "text" && typeof value !== "string") value = null;
        if (control.valueType === "invoke") value = null;
        let quality = value === null ? "unknown" : isExpired ? "unknown" : "fresh";
        if (isExpired) value = null;
        const activityRole = ["power", "active_heat_demand", "active_heat_production"].includes(control.semanticRole);
        const analyticsActivity = activityRole && typeof value === "boolean" ? (value ? "on" : "off") : "unknown";
        const availability = source.availability === "offline" || source.online === false ? "offline" : value === null ? "unknown" : "online";
        const state = {
          deviceId: dto.id, controlId: control.controlId, homeId: dto.homeId,
          descriptorRevision: dto.descriptorRevision,
          revision: Math.max(0, Number.isSafeInteger(entity?.stateRevision) ? entity.stateRevision : Number.isSafeInteger(entity?.revision) ? entity.revision : Math.floor(hasObservedAt ? observedMs : 0)),
          observedAt, receivedAt, quality, value, validUntil: Number.isFinite(validUntilMs) ? new Date(Math.max(validUntilMs, effectiveObservedMs + 1)).toISOString() : null,
          deviceAvailability: availability, analyticsActivity,
        };
        if (validateNativeControlState(state, dto, control)) states.push(state);
      }
    }
    return states;
  }

  function nativeEnvelopeFor(principal, data, revision = 0, sequence = nativeSequence()) {
    return makeNativeEnvelope({ homeId: String(principal.homeId), streamId: nativeStreamId(), sequence, generatedAt: new Date(clock()).toISOString(), revision, data });
  }

  const nativeCommandReceiptTtlMs = 24 * 60 * 60 * 1000;
  const nativeCommandReceiptCapacity = 512;
  const nativeCommandConfirmationTimeoutMs = Math.max(50, Math.min(60_000, Number(config.nativeCommandConfirmationTimeoutMs) || 15_000));
  function nativeCommandPrincipalFingerprint(principal) {
    return crypto.createHash("sha256")
      .update(stableJson({ sub: String(principal?.sub || ""), homeId: String(principal?.homeId || ""), membershipId: String(principal?.membershipId || "") }), "utf8")
      .digest("hex");
  }
  function nativeCommandIdKey(principal, commandId) {
    return crypto.createHash("sha256")
      .update(`${nativeCommandPrincipalFingerprint(principal)}\n${String(commandId)}`, "utf8")
      .digest("hex");
  }
  function nativeCommandOperationDigest(command) {
    const operation = Object.fromEntries(Object.entries(command).filter(([key]) => key !== "issuedAt" && key !== "idempotencyKey"));
    return crypto.createHash("sha256").update(stableJson(operation), "utf8").digest("hex");
  }
  function pruneNativeCommandReceipts(results, commandIdIndex, nowMs) {
    const nextResults = { ...results };
    const nextIndex = { ...commandIdIndex };
    for (const [key, entry] of Object.entries(nextResults)) {
      if (!Number.isFinite(Date.parse(String(entry?.retentionExpiresAt || ""))) || Date.parse(entry.retentionExpiresAt) > nowMs) continue;
      if (!["applied", "failed", "timed_out", "rejected"].includes(String(entry.status))) continue;
      const idKey = String(entry.commandIdKey || "");
      if (idKey && nextIndex[idKey] === key) delete nextIndex[idKey];
      delete nextResults[key];
    }
    for (const [idKey, key] of Object.entries(nextIndex)) if (!Object.hasOwn(nextResults, key)) delete nextIndex[idKey];
    return { results: nextResults, commandIdIndex: nextIndex };
  }

  function queueNativeEvent(record) {
    nativeEventQueue = nativeEventQueue.then(async () => {
      const security = hubStore.getSecurity?.() || {};
      const sequence = Math.max(0, Number(security.nativeEventSequence || 0)) + 1;
      const events = [...(Array.isArray(security.nativeEvents) ? security.nativeEvents : []), { ...record, sequence, generatedAt: new Date(clock()).toISOString() }].slice(-1024);
      await hubStore.saveSecurity({ ...security, nativeEventSequence: sequence, nativeEvents: events });
      const item = events[events.length - 1];
      for (const client of [...nativeEventClients]) sendNativeEvent(client, item).catch(() => client.socket.close(1011, "Event unavailable"));
    }).catch((error) => logger.warn(`[native-events] event journal write failed (${String(error?.code || "storage_unavailable")})`));
    return nativeEventQueue;
  }

  function normalizedNativeObservedValue(device, control) {
    const entity = nativeRawEntityForControl(device, control?.controlId);
    if (!entity) return { entity: null, value: null, observedAtMs: NaN, revision: 0 };
    const raw = entity.state && typeof entity.state === "object" && !Array.isArray(entity.state) && Object.hasOwn(entity.state, "state") ? entity.state.state : entity.state;
    let value = raw;
    if (control.valueType === "boolean") {
      if (typeof raw === "boolean") value = raw;
      else {
        const normalized = String(raw ?? "").trim().toLowerCase();
        value = normalized === "on" || normalized === "true" || normalized === "open" || normalized === "unlocked" ? true
          : normalized === "off" || normalized === "false" || normalized === "closed" || normalized === "locked" ? false : null;
      }
    } else if (control.valueType === "number") {
      value = typeof raw === "number" && Number.isFinite(raw) ? raw : raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    }
    const timestamp = Date.parse(String(entity.lastChanged || entity.last_changed || entity.updatedAt || ""));
    return { entity, value, observedAtMs: timestamp, revision: Math.max(0, Number(entity.stateRevision || entity.revision || 0)) };
  }

  function nativeRawEntityForControl(device, controlId) {
    const requested = String(controlId || "");
    if (!requested) return null;
    return Object.values(device?.entities || {}).find((entity) => [
      entity?.capability?.controlId,
      entity?.controlId,
      entity?.id,
      entity?.sourceId,
    ].some((value) => value != null && String(value) === requested)) || null;
  }

  function nativeCommandValueMatches(control, requested, observed) {
    if (control.valueType === "boolean") return typeof requested === "boolean" && observed === requested;
    if (control.valueType === "number") return typeof requested === "number" && typeof observed === "number" && Object.is(requested, observed);
    return stableJson(requested) === stableJson(observed);
  }

  function nativeCommandOutcome(result, status, errorCode = null) {
    return { ...result, status, completedAt: new Date(clock()).toISOString(), errorCode };
  }

  async function saveNativeCommandOutcome(idempotencyHash, status, errorCode = null) {
    const security = hubStore.getSecurity?.() || {};
    const entries = { ...(security.nativeCommandResults || {}) };
    const entry = entries[idempotencyHash];
    if (!entry || !entry.result || !["dispatching", "accepted", "uncertain", "timed_out"].includes(String(entry.status))) return null;
    const result = nativeCommandOutcome(entry.result, status, errorCode);
    entries[idempotencyHash] = {
      ...entry,
      status,
      result,
      ...(status === "applied" || status === "failed" || status === "timed_out" ? { retentionExpiresAt: new Date(Number(clock()) + nativeCommandReceiptTtlMs).toISOString() } : {}),
    };
    await hubStore.saveSecurity({ ...security, nativeCommandResults: entries });
    const timer = nativeCommandOutcomeTimers.get(idempotencyHash);
    if (timer) clearTimeout(timer);
    nativeCommandOutcomeTimers.delete(idempotencyHash);
    queueNativeEvent({ kind: "command", deviceId: entry.deviceId, commandId: result.commandId, membershipFingerprint: entry.membershipFingerprint });
    return result;
  }

  async function reconcileNativeCommandObservation(deviceId, controlId) {
    const security = hubStore.getSecurity?.() || {};
    const candidates = Object.entries(security.nativeCommandResults || {})
      .filter(([, entry]) => String(entry.deviceId) === String(deviceId) && String(entry.controlId) === String(controlId) && ["accepted", "uncertain", "timed_out"].includes(String(entry.status)) && entry.result?.acceptedAt)
      .sort((a, b) => Date.parse(String(b[1].result.acceptedAt)) - Date.parse(String(a[1].result.acceptedAt)));
    const [key, entry] = candidates[0] || [];
    if (!entry) return;
    const device = hubStore.getDevice(String(deviceId));
    if (!device) return;
    const principal = { principalType: "app", sub: String(entry.accountId || ""), householdRole: "TENANT", homeId: String(entry.homeId || ""), membershipId: String(entry.membershipId || ""), homeMembershipId: String(entry.membershipId || ""), areaIds: (entry.areaIds || []).map(String), policyRevision: Number(entry.policyRevision || 0), scope: ["tenant:device-read"] };
    const dto = nativeDevicesFor(principal).find((item) => item.id === String(deviceId));
    const control = dto?.controls.find((item) => String(item.controlId) === String(controlId));
    if (!control) return;
    const observed = normalizedNativeObservedValue(device, control);
    const acceptedAt = Date.parse(String(entry.result.acceptedAt));
    if (!Number.isFinite(observed.observedAtMs) || observed.observedAtMs < acceptedAt || observed.revision <= Number(entry.observationRevision || 0)) return;
    if (nativeCommandValueMatches(control, entry.requestedValue, observed.value)) await saveNativeCommandOutcome(key, "applied");
  }

  async function recoverInterruptedNativeCommands() {
    const security = hubStore.getSecurity?.() || {};
    const entries = { ...(security.nativeCommandResults || {}) };
    let changed = false;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry?.status !== "dispatching") continue;
      entries[key] = { ...entry, status: "uncertain", result: nativeCommandOutcome(entry.result || {}, "uncertain", "COMMAND_INTERRUPTED") };
      changed = true;
    }
    if (changed) await hubStore.saveSecurity({ ...security, nativeCommandResults: entries });
  }

  function scheduleNativeCommandTimeout(idempotencyHash) {
    const timer = setTimeout(() => {
      nativeCommandOutcomeTimers.delete(idempotencyHash);
      saveNativeCommandOutcome(idempotencyHash, "timed_out", "COMMAND_CONFIRMATION_TIMEOUT").catch(() => {});
    }, nativeCommandConfirmationTimeoutMs);
    timer.unref?.();
    nativeCommandOutcomeTimers.set(idempotencyHash, timer);
  }

  async function sendNativeEvent(client, record) {
    const principal = client.offline
      ? (offlineLanAuthorisations.isCurrent(client.principal) ? client.principal : null)
      : appSessionAuth(client.token);
    if (!principal || principal.householdRole !== "TENANT" || principal.sub !== client.principal.sub || principal.sid !== client.principal.sid || principal.membershipId !== client.principal.membershipId || principal.homeId !== client.principal.homeId) {
      client.socket.close(4401, "Session expired or revoked");
      return;
    }
    const membershipFingerprint = crypto.createHash("sha256").update(String(principal.membershipId), "utf8").digest("hex");
    if (record.membershipFingerprint && record.membershipFingerprint !== membershipFingerprint) return;
    let data;
    let revision = 0;
    if (record.kind === "command") {
      const entry = Object.values(hubStore.getSecurity?.()?.nativeCommandResults || {}).find((candidate) => candidate?.membershipFingerprint === membershipFingerprint && candidate?.result?.commandId === record.commandId);
      if (!entry) return;
      data = entry.result;
    } else {
      const device = hubStore.getDevice(String(record.deviceId || ""));
      if (record.kind === "catalog" && (record.removed === true || nativeDeviceIsRetired(device))) {
        const saved = (Array.isArray(hubStore.getSecurity?.()?.nativeCatalogIndex) ? hubStore.getSecurity().nativeCatalogIndex : []).find((entry) => String(entry.deviceId) === String(record.deviceId));
        const grantedAreas = new Set((principal.areaIds || []).map(String));
        if (!saved || saved.homeId !== principal.homeId || !Array.isArray(saved.areaIds) || !saved.areaIds.length || !saved.areaIds.every((id) => grantedAreas.has(String(id))) || (saved.managementClass === "tenant_device" && saved.ownerMembershipId !== principal.membershipId)) return;
        revision = Math.max(0, Number(saved.descriptorRevision || 0)) + 1;
        data = { schemaVersion: "dinodia.v1", homeId: saved.homeId, deviceId: saved.deviceId, catalogRevision: revision, controls: [], deletedControlIds: Array.isArray(record.deletedControlIds) ? record.deletedControlIds : saved.controlIds };
      } else if (device && appCanReadDevice(principal, device)) {
        const dto = nativeDevicesFor(principal).find((candidate) => candidate.id === String(record.deviceId));
        if (!dto) return;
        revision = dto.descriptorRevision;
        if (record.kind === "state") {
          data = nativeControlStates(principal, [dto]).find((state) => state.controlId === String(record.controlId));
          if (!data) return;
        } else {
          data = { schemaVersion: "dinodia.v1", homeId: dto.homeId, deviceId: dto.id, catalogRevision: dto.descriptorRevision, controls: dto.controls, deletedControlIds: Array.isArray(record.deletedControlIds) ? record.deletedControlIds : [] };
        }
      } else {
        if (record.kind !== "catalog" || record.removed !== true) return;
        const saved = (Array.isArray(hubStore.getSecurity?.()?.nativeCatalogIndex) ? hubStore.getSecurity().nativeCatalogIndex : []).find((entry) => String(entry.deviceId) === String(record.deviceId));
        const grantedAreas = new Set((principal.areaIds || []).map(String));
        if (!saved || saved.homeId !== principal.homeId || !Array.isArray(saved.areaIds) || !saved.areaIds.length || !saved.areaIds.every((id) => grantedAreas.has(String(id))) || (saved.managementClass === "tenant_device" && saved.ownerMembershipId !== principal.membershipId)) return;
        revision = Math.max(0, Number(saved.descriptorRevision || 0)) + 1;
        data = { schemaVersion: "dinodia.v1", homeId: saved.homeId, deviceId: saved.deviceId, catalogRevision: revision, controls: [], deletedControlIds: Array.isArray(record.deletedControlIds) ? record.deletedControlIds : saved.controlIds };
      }
    }
    const envelope = nativeEnvelopeFor(principal, data, revision, record.sequence);
    if (envelope && client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(envelope));
  }

  eventBus.on("state_changed", (event = {}) => {
    const entityId = String(event.entity_id || "");
    if (!entityId) return;
    const device = hubStore.listDevices().find((item) => Object.values(item.entities || {}).some((entity) => String(entity.id || entity.sourceId || "") === entityId));
    if (!device) return;
    const entity = Object.values(device.entities || {}).find((item) => String(item.id || item.sourceId || "") === entityId);
    reconcileNativeCommandObservation(device.id, String(entity?.capability?.controlId || entity?.controlId || entity?.id || entityId)).catch(() => {});
    queueNativeEvent({ kind: "state", deviceId: String(device.id), controlId: String(entity?.capability?.controlId || entity?.controlId || entity?.id || entityId) });
  });
  eventBus.on("registry_updated", (event = {}) => {
    if (event.registry !== "device") return;
    const device = hubStore.listDevices().find((item) => [String(item.id), String(item.haDeviceId || "")].includes(String(event.id || "")));
    if (!device) return;
    if (nativeDeviceIsRetired(device)) {
      const prior = (Array.isArray(hubStore.getSecurity?.()?.nativeCatalogIndex) ? hubStore.getSecurity().nativeCatalogIndex : []).find((item) => item.deviceId === String(device.id));
      queueNativeEvent({ kind: "catalog", deviceId: String(device.id), deletedControlIds: prior?.controlIds || [], removed: true });
      return;
    }
    queueNativeEvent({ kind: "catalog", deviceId: String(device.id) });
  });
  eventBus.on("registry_removed", (event = {}) => {
    if (event.registry !== "device") return;
    const id = String(event.id || "");
    if (!id) return;
    const prior = Array.isArray(hubStore.getSecurity?.()?.nativeCatalogIndex) ? hubStore.getSecurity().nativeCatalogIndex.find((item) => item.deviceId === id || item.alias === id) : null;
    if (prior) queueNativeEvent({ kind: "catalog", deviceId: String(prior.deviceId), deletedControlIds: prior.controlIds || [], removed: true });
  });

  function appCanCommandDevice(principal, device, body, entity, serviceId) {
    if (!appCanReadDevice(principal, device) || principal.householdRole !== "TENANT" || !principal.scope.includes("tenant:device-command")) return false;
    const descriptor = entity?.surface || entity?.entity || entity || {};
    const capability = descriptor.capability || {};
    const controlId = String(body?.controlId || body?.control_id || descriptor.controlId || capability.controlId || "");
    if (capability.writable === false) return false;
    const requestedService = String(serviceId || body?.serviceId || body?.service_id || "").toLowerCase();
    const bindings = Array.isArray(capability.bindings) ? capability.bindings : [];
    const advertised = bindings.some((binding) => String(binding?.serviceId || "").toLowerCase() === requestedService);
    if (!advertised) return false;
    if (!controlId) return true;
    return String(descriptor.controlId || capability.controlId || descriptor.id) === controlId;
  }

  function nativeCommandBinding(control, entity) {
    const bindings = Array.isArray(entity?.capability?.bindings) ? entity.capability.bindings : [];
    if (!bindings.length) return null;
    const role = String(control.semanticRole || "");
    if (control.valueType === "boolean") {
      const ending = role === "security_lock" || role === "lock_state"
        ? (control.value ? "unlock" : "lock")
        : (control.value ? "turn_on" : "turn_off");
      return bindings.find((binding) => String(binding.serviceId || "").toLowerCase().endsWith(`.${ending}`)) || null;
    }
    if (control.valueType === "number") {
      return bindings.find((binding) => ["number.set_value", "climate.set_temperature", "light.turn_on", "fan.set_percentage", "cover.set_cover_position"].includes(String(binding.serviceId || "").toLowerCase())) || null;
    }
    if (control.valueType === "option") {
      return bindings.find((binding) => ["select.select_option", "climate.set_hvac_mode", "fan.set_preset_mode"].includes(String(binding.serviceId || "").toLowerCase())) || null;
    }
    if (control.valueType === "text") return bindings.find((binding) => String(binding.serviceId || "").toLowerCase() === "text.set_value") || null;
    return control.valueType === "invoke" && bindings.length === 1 ? bindings[0] : null;
  }

  function nativeCommandData(serviceId, value) {
    const service = String(serviceId || "").toLowerCase();
    if (service === "number.set_value") return { value };
    if (service === "climate.set_temperature") return { temperature: value };
    if (service === "light.turn_on") return { brightness: value };
    if (service === "fan.set_percentage") return { percentage: value };
    if (service === "cover.set_cover_position") return { position: value };
    if (service === "select.select_option") return { option: value };
    if (service === "climate.set_hvac_mode") return { hvac_mode: value };
    if (service === "fan.set_preset_mode") return { preset_mode: value };
    if (service === "text.set_value") return { value };
    if (service.endsWith(".press")) return {};
    return {};
  }

  async function dispatchNativeCommand(principal, device, control, value) {
    const raw = nativeRawEntityForControl(device, control.controlId);
    if (!raw) return false;
    const surface = allProjectedSurfaces(device).find((candidate) => String(candidate.id) === String(control.surfaceId) && (candidate.sourceEntityIds || []).map(String).includes(String(raw.id || raw.sourceId)));
    if (!surface || surface.capability?.writable === false) return false;
    const binding = nativeCommandBinding({ ...control, value }, raw);
    const serviceId = String(binding?.serviceId || "").toLowerCase();
    const dot = serviceId.indexOf(".");
    if (!binding || dot < 1 || !appCanCommandDevice(principal, device, { controlId: control.controlId }, raw, serviceId)) return false;
    const adapterResult = await commandEntity(device, raw, serviceId, nativeCommandData(serviceId, value), {});
    return { dispatched: true, protocol: String(device.protocol || "unknown"), adapterResult };
  }

  function isSupportOperator(principal) {
    return Boolean(principal?.principalType === "operator" && principal.scope?.includes("os:support"));
  }

  function supportCanReadDevice(principal, device) {
    if (!isSupportOperator(principal) || !device) return false;
    const areaIds = new Set((principal.areaIds || []).map(String));
    if (areaIds.size > 0 && !areaIds.has(canonicalAreaIdForHubArea(device.areaId || device.metadata?.areaId))) return false;
    const ownerMembershipId = String(device.tenantOwnerMembershipId || device.metadata?.tenantOwnerMembershipId || "");
    const managementClass = String(device.managementClass || device.metadata?.managementClass || "");
    const privateDevice = managementClass === "tenant_device" || Boolean(ownerMembershipId);
    if (!privateDevice) return true;
    return principal.supportScope === "TENANT_SCOPE" && principal.includesTenantDevices === true && ownerMembershipId === String(principal.targetMembershipId || "");
  }

  function supportPathAllowed(pathname) {
    return pathname === "/api/status" || pathname === "/api/areas" || pathname === "/api/devices" || /^\/api\/devices\/[^/]+(?:\/support-bundle|\/capabilities)?$/.test(pathname);
  }

  function runNativeCommandSerial(task) {
    const result = nativeCommandQueue.then(task, task);
    nativeCommandQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    const token = bearerToken(req) || browserOperatorToken(req);
    const developmentCompatibilityPrincipal = runtimeConfig.nodeEnv !== "production" && legacyCompatibilityEnabled && runtimeConfig.adminToken && safeEqual(token, runtimeConfig.adminToken)
      ? { principalType: "operator", scope: ["os:admin"], sub: "development-compatibility", jti: "development-compatibility", credentialFingerprint: hashTokenValue(token).slice(0, 32) }
      : null;
    const operatorPrincipal = await refreshedSupportBrowserPrincipal(req) || operatorSessionAuth(token) || developmentCompatibilityPrincipal;
    const appPrincipal = operatorPrincipal ? null : appSessionAuth(token);
    if (pathname === "/api/dinodia/v1/offline/challenges" && req.method === "POST"
      && !operatorPrincipal && !appPrincipal && !bearerToken(req)
      && isTrustedOfflineLanTransport(req)) {
      const grantId = String(req.headers["x-dinodia-offline-grant"] || "");
      const principal = offlineLanAuthorisations.currentPrincipal(grantId);
      if (!principal || principal.householdRole !== "TENANT" || !principal.scope?.includes("tenant:device-command")) {
        return nativeContractError(res, 401, "AUTH_REQUIRED", "A current enrolled offline grant is required");
      }
      let input;
      try { input = await readBody(req); } catch { return nativeContractError(res, 400, "VALIDATION_FAILED", "The offline challenge request is invalid"); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return nativeContractError(res, 400, "VALIDATION_FAILED", "The offline challenge request is invalid");
      const purpose = String(input.purpose || "");
      const requestPath = String(input.requestPath || "");
      const commonKeys = ["purpose", "requestPath"];
      const commandKeys = [...commonKeys, "deviceId", "controlId", "descriptorRevision", "valueDigest"];
      const commandPurpose = purpose === "native.command";
      if (Object.keys(input).sort().join("\n") !== (commandPurpose ? commandKeys : commonKeys).sort().join("\n")) {
        return nativeContractError(res, 400, "VALIDATION_FAILED", "The offline challenge contains unsupported fields");
      }
      const allowedReadPath = purpose === "native.read" && (
        ["/api/dinodia/v1/snapshot", "/api/dinodia/v1/areas", "/api/dinodia/v1/devices", "/api/dinodia/v1/control-catalog"].includes(requestPath)
        || /^\/api\/dinodia\/v1\/devices\/[^/?]+$/.test(requestPath)
        || /^\/api\/dinodia\/v1\/commands\/[^/?]+$/.test(requestPath)
      );
      const allowedEventsPath = purpose === "native.events" && /^\/api\/dinodia\/v1\/events\?after=(?:0|[1-9]\d{0,15})$/.test(requestPath);
      if (!allowedReadPath && !allowedEventsPath && !(commandPurpose && requestPath === "/api/dinodia/v1/commands")) {
        return nativeContractError(res, 403, "SCOPE_DENIED", "The requested offline operation is outside native device access");
      }
      let areaIds = [...new Set((principal.areaIds || []).map(String))].sort();
      let deviceId = null; let controlId = null; let descriptorRevision = null; let valueDigest = null;
      if (commandPurpose) {
        deviceId = String(input.deviceId || "");
        controlId = String(input.controlId || "");
        descriptorRevision = Number(input.descriptorRevision);
        valueDigest = String(input.valueDigest || "");
        if (!deviceId || !controlId || !Number.isSafeInteger(descriptorRevision) || descriptorRevision < 0 || !/^[a-f0-9]{64}$/.test(valueDigest)) {
          return nativeContractError(res, 400, "VALIDATION_FAILED", "The offline command challenge is incomplete");
        }
        const device = hubStore.getDevice(deviceId);
        if (!device || !appCanReadDevice(principal, device)) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The selected device is unavailable");
        const currentDto = serializeNativeDevice({
          device: nativeDeviceView(principal, device), homeId: String(principal.homeId),
          homeMembershipId: String(principal.membershipId), role: String(principal.householdRole),
          areaIds: (principal.areaIds || []).map(String), surfaces: allProjectedSurfaces(device),
          revision: Number(device.presentation?.descriptorRevision || 0),
        });
        const currentControl = currentDto?.controls.find((item) => item.controlId === controlId);
        if (!currentDto || currentDto.lifecycle !== "installed" || currentDto.descriptorRevision !== descriptorRevision
          || !currentControl || !currentControl.readable || !currentControl.writable) {
          return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "The current control descriptor is not commandable");
        }
        const hubAreaId = String(device.areaId || device.metadata?.areaId || "");
        const publicAreaId = canonicalAreaIdForHubArea(hubAreaId);
        if (!publicAreaId || !areaIds.includes(publicAreaId)) return nativeContractError(res, 403, "SCOPE_DENIED", "The selected device is outside the enrolled area scope");
        areaIds = [publicAreaId];
      }
      const challenge = createNativeLanChallenge({
        grantId, purpose, homeId: principal.homeId, hubInstallId: principal.hubInstallId,
        membershipId: principal.membershipId, trustedDeviceId: principal.trustedDeviceId,
        policyRevision: principal.policyRevision, areaIds, requestPath, deviceId, controlId,
        descriptorRevision, valueDigest, now: clock(),
      });
      const signingPayload = Buffer.from(stableJson(challenge), "utf8").toString("base64url");
      return json(res, 200, { ok: true, challenge, signingPayload });
    }
    let offlinePrincipal = null;
    let offlineChallenge = null;
    if (!operatorPrincipal && !appPrincipal) {
      const challengeHeader = String(req.headers["x-dinodia-offline-challenge"] || "");
      const signature = String(req.headers["x-dinodia-offline-signature"] || "");
      const grantId = String(req.headers["x-dinodia-offline-grant"] || "");
      if (challengeHeader && signature && grantId && isTrustedOfflineLanTransport(req)) {
        try {
          const challenge = JSON.parse(Buffer.from(challengeHeader, "base64url").toString("utf8"));
          offlineChallenge = challenge;
          const expectedPurpose = req.method === "POST" && url.pathname === "/api/dinodia/v1/commands"
            ? "native.command"
            : req.method === "GET" && (url.pathname === "/api/dinodia/v1/snapshot" || url.pathname === "/api/dinodia/v1/areas" || url.pathname === "/api/dinodia/v1/devices" || /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(url.pathname) || url.pathname === "/api/dinodia/v1/control-catalog" || /^\/api\/dinodia\/v1\/commands\/[^/]+$/.test(url.pathname)
              ? "native.read" : "");
          offlinePrincipal = await offlineLanAuthorisations.verify({ grantId, challenge, signature, expectedPurpose, expectedPath: `${url.pathname}${url.search}` });
        } catch { offlinePrincipal = null; }
      }
    }
    if (!operatorPrincipal && !appPrincipal && !offlinePrincipal) {
      return json(res, 401, { error: "Authentication required" });
    }
    const scopedPrincipal = appPrincipal || offlinePrincipal;
    const nativeTenantPrincipal = Boolean(scopedPrincipal && ["app", "offline"].includes(scopedPrincipal.principalType)
      && scopedPrincipal.householdRole === "TENANT" && scopedPrincipal.scope?.includes("tenant:device-command"));
    const supportOperator = isSupportOperator(operatorPrincipal);
    if (supportOperator && (req.method !== "GET" || !supportPathAllowed(pathname))) {
      return json(res, 403, { error: "Support sessions are read-only and limited to assigned diagnostics", errorCode: "support_scope_denied" });
    }
    if (scopedPrincipal && !(
      (req.method === "GET" && (pathname === "/api/status" || pathname === "/api/devices" || pathname.startsWith("/api/devices/") || pathname === "/api/dinodia/v1/health" || pathname === "/api/dinodia/v1/snapshot" || pathname === "/api/dinodia/v1/areas" || pathname === "/api/dinodia/v1/devices" || /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(pathname) || pathname === "/api/dinodia/v1/control-catalog" || pathname === "/api/dinodia/v1/maintenance/status" || /^\/api\/dinodia\/v1\/commands\/[^/]+$/.test(pathname))) ||
      (req.method === "DELETE" && /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(pathname)) ||
      (req.method === "POST" && pathname === "/api/dinodia/v1/commands") ||
      (nativeTenantPrincipal && req.method === "POST" && /^\/api\/dinodia\/v1\/commissioning\/sessions(?:\/[^/]+(?:\/(?:matter-payload|select|complete|cancel|resume))?)?$/.test(pathname)) ||
      (nativeTenantPrincipal && req.method === "GET" && /^\/api\/dinodia\/v1\/commissioning\/sessions\/[^/]+$/.test(pathname)) ||
      (req.method === "POST" && pathname.includes("/entities/") && pathname.endsWith("/service")) ||
      (req.method === "POST" && pathname === "/api/step-up/descriptor-challenge")
    )) {
      return json(res, 403, { error: "This app principal is not permitted to use this OS route", errorCode: "insufficient_scope" });
    }
    if (offlinePrincipal && !(req.method === "GET" && (pathname === "/api/dinodia/v1/snapshot" || pathname === "/api/dinodia/v1/areas" || pathname === "/api/dinodia/v1/devices" || /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(pathname) || pathname === "/api/dinodia/v1/control-catalog" || /^\/api\/dinodia\/v1\/commands\/[^/]+$/.test(pathname)) || req.method === "POST" && pathname === "/api/dinodia/v1/commands")) {
      return nativeContractError(res, 403, "SCOPE_DENIED", "Offline authority is limited to selected-home native device access");
    }
    if (pathname === "/api/dinodia/v1/maintenance/status" && req.method === "GET") {
      if (!(operatorPrincipal?.scope?.includes("os:admin") || nativeTenantPrincipal)) return nativeContractError(res, 403, "SCOPE_DENIED", "A selected tenant membership or authenticated operator is required");
      let result;
      try { result = await requestUpdaterControl({ operation: "status" }, updaterSocketPath); }
      catch { return nativeContractError(res, 503, "HUB_UNAVAILABLE", "Updater status is temporarily unavailable", true); }
      const source = result?.status;
      const phases = new Set(["idle", "downloading", "verifying", "staged", "maintenance", "activating", "health_check", "active", "rolled_back", "failed"]);
      const attemptPhases = new Set(["downloading", "verifying", "staged", "maintenance", "activating", "health_check", "active", "rolled_back", "failed"]);
      if (result?.ok !== true || !source || !phases.has(source.phase)
        || !["ready", "unprovisioned"].includes(source.trustState)
        || !(source.activeReleaseVersion === null || typeof source.activeReleaseVersion === "string" && source.activeReleaseVersion.length <= 96)
        || typeof source.busy !== "boolean"
        || !(source.lastAttempt === null || source.lastAttempt && typeof source.lastAttempt === "object"
          && attemptPhases.has(source.lastAttempt.phase)
          && (source.lastAttempt.result === null || typeof source.lastAttempt.result === "string" && source.lastAttempt.result.length <= 96)
          && (source.lastAttempt.updatedAt === null || typeof source.lastAttempt.updatedAt === "string" && Number.isFinite(Date.parse(source.lastAttempt.updatedAt))))) {
        return nativeContractError(res, 503, "HUB_UNAVAILABLE", "Updater status is temporarily unavailable", true);
      }
      const lastAttempt = source.lastAttempt ? { phase: source.lastAttempt.phase, result: source.lastAttempt.result || null, updatedAt: source.lastAttempt.updatedAt || null } : null;
      return json(res, 200, { schemaVersion: "dinodia.v1", status: {
        phase: source.phase, trustState: source.trustState, activeReleaseVersion: source.activeReleaseVersion || null,
        lastAttempt, busy: source.busy,
      } });
    }
    if (pathname === "/api/dinodia/v1/maintenance/update" && req.method === "POST") {
      if (!operatorPrincipal?.scope?.includes("os:admin")) return nativeContractError(res, 403, "SCOPE_DENIED", "Only an authenticated Dinodia operator may request a signed update");
      let body;
      try { body = await readBody(req, 16 * 1024); } catch { return nativeContractError(res, 400, "VALIDATION_FAILED", "The signed update request is invalid"); }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).sort().join("\n") !== "envelope\nschemaVersion"
        || body.schemaVersion !== "dinodia.v1"
        || !body.envelope || typeof body.envelope !== "object" || Array.isArray(body.envelope)
        || Object.keys(body.envelope).sort().join("\n") !== "payload\nsignature"
        || Buffer.byteLength(JSON.stringify(body), "utf8") > 16 * 1024) {
        return nativeContractError(res, 400, "VALIDATION_FAILED", "The signed update request is invalid");
      }
      let result;
      try { result = await requestUpdaterControl({ operation: "apply", envelope: body.envelope }, updaterSocketPath); }
      catch { return nativeContractError(res, 503, "HUB_UNAVAILABLE", "The isolated updater is unavailable", true); }
      if (result?.ok === true && result.status) return json(res, 200, { schemaVersion: "dinodia.v1", ok: true, status: result.status });
      if (result?.code === "UPDATER_DISABLED") return nativeContractError(res, 503, "FEATURE_NOT_ENABLED", "Approved release-signing trust has not been provisioned");
      if (result?.code === "UPDATE_ALREADY_RUNNING") return nativeContractError(res, 409, "CONFLICT", "A signed update is already in progress", true);
      return nativeContractError(res, 400, "VALIDATION_FAILED", "The signed release was rejected or could not be activated");
    }
    if (pathname.startsWith("/api/dinodia/v1/") && runtimeConfig.nodeEnv === "production") {
      const cloudOrigin = runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "";
      const trustedCloud = isHiveCredentialTransportAllowed(req, { nodeEnv: "production", configuredHostname: cloudOrigin, allowLoopback: true });
      if (req.socket?.encrypted !== true && !trustedCloud) return nativeContractError(res, 426, "HUB_UNAVAILABLE", "Native tenant transport requires the verified HTTPS hub endpoint", true);
    }
    if (pathname === "/api/health" && req.method === "GET") {
      const memory = process.memoryUsage();
      return json(res, 200, {
        ok: true,
        version: VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        memory: { rssMb: Math.round(memory.rss / 1024 / 1024), heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024) },
        storeSchemaVersion: hubStore.state?.version || 0,
      integrations: { mqtt: mqtt.status(), matter: matter.status(), hive: hive.status(), googleNest: googleNest.status() },
      });
    }

    // Native V1 routes are handled here and never passed to the HA-compatible
    // router. The public health response intentionally contains no home,
    // device, identity-key or credential material.
    if (pathname === "/api/dinodia/v1/health" && req.method === "GET") {
      return json(res, 200, { ok: true, schemaVersion: "dinodia.v1", mode: "native-v2" });
    }

    const commissioningPath = pathname.match(/^\/api\/dinodia\/v1\/commissioning\/sessions(?:\/([^/]+)(?:\/(matter-payload|select|complete|cancel|resume))?)?$/);
    if (commissioningPath) {
      if (!nativeTenantPrincipal || offlinePrincipal || !nativeCommissioningService) return nativeContractError(res, 403, "SCOPE_DENIED", "A current selected tenant session is required for commissioning");
      try {
        const sessionId = commissioningPath[1] ? decodeURIComponent(commissioningPath[1]) : "";
        const action = commissioningPath[2] || "";
        if (req.method === "POST" && !sessionId && !action) {
          const body = await readBody(req, 4096);
          if (Object.keys(body).sort().join("\n") !== "protocol\nschemaVersion" || body.schemaVersion !== "dinodia.v1") return nativeContractError(res, 400, "VALIDATION_FAILED", "The commissioning request is invalid");
          return json(res, 201, await nativeCommissioningService.start(scopedPrincipal, { protocol: body.protocol }, String(req.headers["idempotency-key"] || "")));
        }
        if (req.method === "GET" && sessionId && !action) {
          const after = Number(url.searchParams.get("after") || 0);
          const candidateAfter = url.searchParams.get("candidateAfter") || null;
          if (!Number.isSafeInteger(after) || after < 0 || candidateAfter !== null && !/^[0-9a-f-]{36}$/i.test(candidateAfter)) return nativeContractError(res, 400, "VALIDATION_FAILED", "The commissioning page cursor is invalid");
          return json(res, 200, await nativeCommissioningService.status(sessionId, scopedPrincipal, after, candidateAfter));
        }
        if (req.method === "POST" && sessionId && action) {
          const body = await readBody(req, 4096);
          if (action === "matter-payload") {
            if (Object.keys(body).sort().join("\n") !== "schemaVersion\nsetupPayload" || body.schemaVersion !== "dinodia.v1") return nativeContractError(res, 400, "VALIDATION_FAILED", "The Matter setup payload request is invalid");
            return json(res, 202, await nativeCommissioningService.matterPayload(sessionId, scopedPrincipal, body.setupPayload));
          }
          if (action === "select") return json(res, 200, await nativeCommissioningService.select(sessionId, scopedPrincipal, body));
          if (["complete", "cancel", "resume"].includes(action)) {
            const expectedKeys = action === "complete" ? "disposition\nschemaVersion" : "schemaVersion";
            if (Object.keys(body).sort().join("\n") !== expectedKeys || body.schemaVersion !== "dinodia.v1"
              || action === "complete" && !["install", "view_only", "remove"].includes(String(body.disposition))) return nativeContractError(res, 400, "VALIDATION_FAILED", "The commissioning action request is invalid");
            const result = action === "complete" ? await nativeCommissioningService.complete(sessionId, scopedPrincipal, String(body.disposition))
              : action === "cancel" ? await nativeCommissioningService.cancel(sessionId, scopedPrincipal)
                : await nativeCommissioningService.resume(sessionId, scopedPrincipal);
            return json(res, 200, result);
          }
        }
        return nativeContractError(res, 405, "METHOD_NOT_ALLOWED", "The commissioning method is not allowed");
      } catch (error) {
        const status = Number(error?.statusCode);
        const code = String(error?.code || "");
        if ([400, 403, 404, 409, 410, 413, 503].includes(status) && /^[a-z0-9_]{1,80}$/i.test(code)) return nativeContractError(res, status, code, String(error.message || "The commissioning operation is unavailable").slice(0, 180), status === 503 || status === 409);
        logger.warn(`[commissioning] request failed (${/^[a-z0-9_]{1,80}$/i.test(code) ? code : "internal_error"})`);
        return nativeContractError(res, 503, "HUB_UNAVAILABLE", "The commissioning service is temporarily unavailable", true);
      }
    }

    if (["/api/dinodia/v1/snapshot", "/api/dinodia/v1/areas", "/api/dinodia/v1/devices", "/api/dinodia/v1/control-catalog"].includes(pathname) && req.method === "GET") {
      if (!nativeTenantPrincipal) return nativeContractError(res, 403, "SCOPE_DENIED", "An active selected tenant membership is required");
      const platformHomeId = String(hubStore.getPlatform?.()?.homeId || "");
      if (platformHomeId && String(scopedPrincipal.homeId || "") !== platformHomeId) return nativeContractError(res, 403, "HOME_MISMATCH", "The app session is for a different home");
      const devices = nativeDevicesFor(scopedPrincipal);
      await rememberNativeCatalog(devices);
      let data;
      if (pathname === "/api/dinodia/v1/snapshot") {
        data = { areas: nativeAreasFor(scopedPrincipal), devices, states: nativeControlStates(scopedPrincipal, devices) };
      } else if (pathname === "/api/dinodia/v1/areas") {
        data = nativeAreasFor(scopedPrincipal);
      } else if (pathname === "/api/dinodia/v1/control-catalog") {
        const deviceId = String(url.searchParams.get("deviceId") || "");
        const device = devices.find((item) => item.id === deviceId);
        if (!device) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The selected device is unavailable");
        data = { schemaVersion: "dinodia.v1", homeId: device.homeId, deviceId: device.id, catalogRevision: device.descriptorRevision, controls: device.controls, deletedControlIds: [] };
      } else {
        data = devices;
      }
      const revision = Array.isArray(devices) ? devices.reduce((highest, device) => Math.max(highest, device.descriptorRevision), 0) : 0;
      const envelope = nativeEnvelopeFor(scopedPrincipal, data, revision);
      return envelope ? json(res, 200, envelope) : nativeContractError(res, 503, "CONTROL_UNAVAILABLE", "The current Native V1 view cannot be represented safely", true);
    }

    const nativeDeviceDetail = pathname.match(/^\/api\/dinodia\/v1\/devices\/([^/]+)$/);
    if (nativeDeviceDetail && req.method === "GET") {
      if (!nativeTenantPrincipal) return nativeContractError(res, 403, "SCOPE_DENIED", "An active selected tenant membership is required");
      const deviceId = decodeURIComponent(nativeDeviceDetail[1]);
      const device = nativeDevicesFor(scopedPrincipal).find((item) => item.id === deviceId);
      if (!device) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The selected device is unavailable");
      await rememberNativeCatalog([device]);
      const envelope = nativeEnvelopeFor(scopedPrincipal, device, device.descriptorRevision);
      return envelope ? json(res, 200, envelope) : nativeContractError(res, 503, "CONTROL_UNAVAILABLE", "The current device descriptor cannot be represented safely", true);
    }

    const nativeCommandStatus = pathname.match(/^\/api\/dinodia\/v1\/commands\/([^/]+)$/);
    if (nativeCommandStatus && req.method === "GET") {
      if (!nativeTenantPrincipal) return nativeContractError(res, 403, "SCOPE_DENIED", "An active selected tenant membership is required");
      const commandId = decodeURIComponent(nativeCommandStatus[1]);
      const membershipFingerprint = crypto.createHash("sha256").update(String(scopedPrincipal.membershipId), "utf8").digest("hex");
      let entries = Object.values(hubStore.getSecurity?.()?.nativeCommandResults || {});
      let receipt = entries.find((entry) => entry?.membershipFingerprint === membershipFingerprint && entry?.result?.commandId === commandId);
      if (!receipt) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The command receipt is unavailable to this membership");
      // Adapters may deliver the confirming observation before emitting their
      // event (or an event may be lost during reconnect). Reconcile against
      // current telemetry when the owning membership polls its receipt; this
      // does not replay the command or grant access to another membership.
      await reconcileNativeCommandObservation(String(receipt.deviceId), String(receipt.controlId));
      entries = Object.values(hubStore.getSecurity?.()?.nativeCommandResults || {});
      receipt = entries.find((entry) => entry?.membershipFingerprint === membershipFingerprint && entry?.result?.commandId === commandId);
      if (!receipt) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The command receipt is unavailable to this membership");
      return json(res, 200, receipt.result);
    }

    // Canonical Stage 2 read boundary. The bearer remains home- and
    // membership-bound; internal HA-compatible records are projected to the
    // versioned Native DTO and never returned from this route.
    if (pathname === "/api/dinodia/v1/devices" && req.method === "GET") {
      if (!nativeTenantPrincipal) {
        return nativeContractError(res, 403, "SCOPE_DENIED", "A selected tenant membership is required");
      }
      const platformHomeId = String(hubStore.getPlatform?.()?.homeId || "");
      if (platformHomeId && String(scopedPrincipal.homeId || "") !== platformHomeId) return nativeContractError(res, 403, "HOME_MISMATCH", "The app session is for a different home");
      const now = new Date(clock()).toISOString();
      const devices = nativeDevicesFor(scopedPrincipal);
      const revision = devices.reduce((highest, device) => Math.max(highest, device.descriptorRevision), 0);
      const envelope = nativeEnvelopeFor(scopedPrincipal, devices, revision);
      if (!envelope) return nativeContractError(res, 503, "CONTROL_UNAVAILABLE", "The current device catalogue cannot be represented safely", true);
      return json(res, 200, envelope);
    }

    const nativeTenantDeviceRemoval = pathname.match(/^\/api\/dinodia\/v1\/devices\/([^/]+)$/);
    if (nativeTenantDeviceRemoval && req.method === "DELETE") {
      if (!scopedPrincipal || scopedPrincipal.principalType !== "app" || !nativeTenantPrincipal) {
        return nativeContractError(res, 403, "SCOPE_DENIED", "An online selected tenant session is required for device removal");
      }
      let body;
      try { body = await readBody(req, 8 * 1024); }
      catch { return nativeContractError(res, 400, "VALIDATION_FAILED", "The tenant device removal request is invalid"); }
      const deviceId = decodeURIComponent(nativeTenantDeviceRemoval[1]);
      const idempotencyKey = String(req.headers["idempotency-key"] || "");
      const proof = String(req.headers["x-dinodia-step-up-proof"] || "");
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).sort().join("\n") !== ["schemaVersion", "homeId", "homeMembershipId", "deviceId", "descriptorRevision", "idempotencyKey"].sort().join("\n")
        || body.schemaVersion !== "dinodia.v1" || String(body.deviceId) !== deviceId
        || String(body.homeId) !== String(scopedPrincipal.homeId) || String(body.homeMembershipId) !== String(scopedPrincipal.membershipId)
        || String(body.idempotencyKey) !== idempotencyKey || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)
        || !Number.isSafeInteger(body.descriptorRevision) || Number(body.descriptorRevision) < 1
        || proof.length < 32 || proof.length > 8192) {
        return nativeContractError(res, 400, "VALIDATION_FAILED", "The tenant device removal request is invalid");
      }
      const requestDigest = crypto.createHash("sha256").update(stableJson({
        schemaVersion: body.schemaVersion, homeId: body.homeId, homeMembershipId: body.homeMembershipId,
        deviceId, descriptorRevision: body.descriptorRevision,
      }), "utf8").digest("hex");
      const principalDigest = crypto.createHash("sha256").update(stableJson({ actor: scopedPrincipal.sub,
        session: scopedPrincipal.sid, trustedDevice: scopedPrincipal.trustedDeviceId,
        home: scopedPrincipal.homeId, membership: scopedPrincipal.membershipId, hub: scopedPrincipal.hubInstallId }), "utf8").digest("hex");
      const receiptKey = crypto.createHash("sha256").update(`${principalDigest}\n${idempotencyKey}`, "utf8").digest("hex");
      return runNativeCommandSerial(async () => {
        const security = hubStore.getSecurity?.() || {};
        let receipts = { ...(security.tenantDeviceRemovalReceipts || {}) };
        const previous = receipts[receiptKey];
        if (previous) {
          if (previous.requestDigest !== requestDigest || previous.principalDigest !== principalDigest || previous.osDeviceId !== deviceId) {
            return nativeContractError(res, 409, "IDEMPOTENCY_CONFLICT", "This removal key is already bound to another operation");
          }
          if (!hubStore.getDevice(deviceId)) {
            const removed = { ...previous, status: "removed", updatedAt: new Date(clock()).toISOString() };
            receipts[receiptKey] = removed;
            await hubStore.saveSecurity({ tenantDeviceRemovalReceipts: receipts });
            return json(res, 200, removed.result);
          }
          return json(res, previous.status === "failed" ? 409 : 202, previous.result);
        }
        const currentPrincipal = appSessionAuth(bearerToken(req));
        const device = hubStore.getDevice(deviceId);
        const policy = hubStore.getPlatform?.()?.devicePolicies?.[deviceId] || null;
        const canonicalAreaId = device ? canonicalAreaIdForHubArea(device.areaId || device.metadata?.areaId) : "";
        const finalAuthority = Boolean(currentPrincipal && device && policy
          && currentPrincipal.principalType === "app" && currentPrincipal.sub === scopedPrincipal.sub
          && currentPrincipal.sid === scopedPrincipal.sid && currentPrincipal.trustedDeviceId === scopedPrincipal.trustedDeviceId
          && currentPrincipal.homeId === scopedPrincipal.homeId && currentPrincipal.membershipId === scopedPrincipal.membershipId
          && currentPrincipal.hubInstallId === scopedPrincipal.hubInstallId && currentPrincipal.householdRole === "TENANT"
          && currentPrincipal.scope?.includes("tenant:device-command")
          && policy.managementClass === "TENANT_DEVICE" && String(policy.ownerMembershipId || "") === String(currentPrincipal.membershipId)
          && ["INSTALLED", "REMOVAL_PENDING"].includes(String(policy.lifecycle))
          && canonicalAreaId && (currentPrincipal.areaIds || []).map(String).includes(canonicalAreaId)
          && String(hubStore.getPlatform?.()?.homeId || currentPrincipal.homeId) === String(currentPrincipal.homeId));
        if (!finalAuthority) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The tenant-owned device is not available to this selected membership");
        const dto = serializeNativeDevice({ device: nativeDeviceView(currentPrincipal, device), homeId: String(currentPrincipal.homeId),
          homeMembershipId: String(currentPrincipal.membershipId), role: "TENANT", areaIds: (currentPrincipal.areaIds || []).map(String),
          surfaces: allProjectedSurfaces(device), revision: Number(device.presentation?.descriptorRevision || device.descriptorRevision || 0) });
        const descriptorRevision = Number(dto?.descriptorRevision || device.presentation?.descriptorRevision || device.descriptorRevision || 0);
        if (!dto || descriptorRevision !== Number(body.descriptorRevision)) return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "The current device descriptor changed; refresh before removal");
        if (!["zigbee", "matter", "hive", "google_nest"].includes(String(device.protocol || "").toLowerCase())) {
          return nativeContractError(res, 409, "DEVICE_REMOVAL_UNSUPPORTED", "This device adapter cannot confirm safe physical removal");
        }
        const operationValue = { operation: "remove_tenant_device", descriptorRevision };
        const approved = await stepUpVerifier.verify(proof, {
          actorId: currentPrincipal.sub, trustedDeviceId: currentPrincipal.trustedDeviceId,
          trustedSessionId: currentPrincipal.sid, homeId: currentPrincipal.homeId,
          membershipId: currentPrincipal.membershipId, hubInstallId: currentPrincipal.hubInstallId,
          operationKind: "tenant_device_remove", targetIds: [deviceId], value: operationValue,
        });
        if (!approved) return nativeContractError(res, 403, "STEP_UP_REQUIRED", "A fresh confirmation for this exact device removal is required");
        const startedAt = new Date(clock()).toISOString();
        const pendingResult = { schemaVersion: "dinodia.v1", ok: true, homeId: currentPrincipal.homeId,
          homeMembershipId: currentPrincipal.membershipId, deviceId, state: "REMOVAL_PENDING", hubEnforcement: "PENDING" };
        receipts[receiptKey] = { requestDigest, principalDigest, osDeviceId: deviceId, membershipId: currentPrincipal.membershipId,
          status: "dispatching", createdAt: startedAt, updatedAt: startedAt, result: pendingResult };
        const liveEntries = Object.entries(receipts).filter(([, value]) => Date.parse(value?.updatedAt || value?.createdAt || "") > Number(clock()) - 30 * 24 * 60 * 60 * 1000);
        receipts = Object.fromEntries(liveEntries.sort((a, b) => Date.parse(a[1]?.createdAt || "") - Date.parse(b[1]?.createdAt || "")).slice(-512));
        await hubStore.saveSecurity({ tenantDeviceRemovalReceipts: receipts });
        try {
          const removed = await haModel.removeDevice({ device_id: deviceId, force: false });
          if (!removed) throw Object.assign(new Error("The hub could not confirm device removal"), { definite: true });
          const result = { ...pendingResult, state: "REMOVED", hubEnforcement: "ENFORCED", removedAt: new Date(clock()).toISOString() };
          receipts[receiptKey] = { ...receipts[receiptKey], status: "removed", updatedAt: new Date(clock()).toISOString(), result };
          await hubStore.saveSecurity({ tenantDeviceRemovalReceipts: receipts });
          return json(res, 200, result);
        } catch (error) {
          const result = { ...pendingResult, errorCode: error?.definite ? "DEVICE_REMOVAL_REJECTED" : "DEVICE_REMOVAL_UNCERTAIN" };
          receipts[receiptKey] = { ...receipts[receiptKey], status: error?.definite ? "failed" : "uncertain", updatedAt: new Date(clock()).toISOString(), result };
          await hubStore.saveSecurity({ tenantDeviceRemovalReceipts: receipts });
          return json(res, error?.definite ? 409 : 202, result);
        }
      });
    }

    if (pathname === "/api/dinodia/v1/commands" && req.method === "POST") {
      if (!scopedPrincipal || !["app", "offline"].includes(scopedPrincipal.principalType) || scopedPrincipal.householdRole !== "TENANT" || !scopedPrincipal.scope.includes("tenant:device-command")) {
        return nativeContractError(res, 403, "SCOPE_DENIED", "A selected tenant command permission is required");
      }
      const command = await readBody(req);
      if (offlinePrincipal && (offlineChallenge?.purpose !== "native.command"
        || offlineChallenge.deviceId !== String(command.deviceId || "")
        || offlineChallenge.controlId !== String(command.controlId || "")
        || offlineChallenge.descriptorRevision !== Number(command.descriptorRevision)
        || offlineChallenge.valueDigest !== digestNativeOfflineCommand(command))) {
        return nativeContractError(res, 403, "SCOPE_DENIED", "The offline proof is not bound to this exact current command");
      }
      const headerKey = String(req.headers["idempotency-key"] || "");
      if (!headerKey || headerKey !== String(command.idempotencyKey || "")) return nativeContractError(res, 400, "VALIDATION_FAILED", "The command idempotency header must match the command");
      const platformHomeId = String(hubStore.getPlatform?.()?.homeId || "");
      if (command.homeId !== String(scopedPrincipal.homeId) || command.homeMembershipId !== String(scopedPrincipal.membershipId) || (platformHomeId && platformHomeId !== String(scopedPrincipal.homeId))) return nativeContractError(res, 403, "HOME_MISMATCH", "The command is outside the selected home membership");
      const device = hubStore.getDevice(String(command.deviceId || ""));
      if (!device || !appCanReadDevice(scopedPrincipal, device)) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The selected device is unavailable");
      const surfaces = allProjectedSurfaces(device);
      const dto = serializeNativeDevice({ device: nativeDeviceView(scopedPrincipal, device), homeId: String(scopedPrincipal.homeId), homeMembershipId: String(scopedPrincipal.membershipId), role: String(scopedPrincipal.householdRole), areaIds: (scopedPrincipal.areaIds || []).map(String), surfaces, revision: Number(device.presentation?.descriptorRevision || 0) });
      if (!dto) return nativeContractError(res, 409, "CONTROL_UNAVAILABLE", "Refresh the current device controls");
      if (Number(command.descriptorRevision) !== dto.descriptorRevision) return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "Refresh the current device controls");
      const control = dto.controls.find((candidate) => candidate.controlId === command.controlId);
      if (!control || !validateNativeCommand(command, dto, control, String(scopedPrincipal.membershipId))) return nativeContractError(res, 400, "VALIDATION_FAILED", "The command does not match the current control descriptor");
      const rawEntity = nativeRawEntityForControl(device, control.controlId);
      const binding = nativeCommandBinding({ ...control, value: command.value }, rawEntity);
      const serviceId = String(binding?.serviceId || "").toLowerCase();
      if (!rawEntity || !binding || !appCanCommandDevice(scopedPrincipal, device, { controlId: control.controlId }, rawEntity, serviceId)) return nativeContractError(res, 403, "SCOPE_DENIED", "The current control is not writable for this membership");

      return runNativeCommandSerial(async () => {
        const security = hubStore.getSecurity?.() || {};
        const nowMs = Number(clock());
        const compacted = pruneNativeCommandReceipts(security.nativeCommandResults || {}, security.nativeCommandIdIndex || {}, nowMs);
        const commandResults = compacted.results;
        const commandIdIndex = compacted.commandIdIndex;
        const idempotencyHash = crypto.createHash("sha256").update(`${scopedPrincipal.homeMembershipId || scopedPrincipal.membershipId}\n${headerKey}`, "utf8").digest("hex");
        const commandDigest = crypto.createHash("sha256").update(stableJson(command), "utf8").digest("hex");
        const operationDigest = nativeCommandOperationDigest(command);
        const membershipFingerprint = crypto.createHash("sha256").update(String(scopedPrincipal.membershipId), "utf8").digest("hex");
        const principalFingerprint = nativeCommandPrincipalFingerprint(scopedPrincipal);
        const commandIdKey = nativeCommandIdKey(scopedPrincipal, command.commandId);
        const prior = commandResults[idempotencyHash];
        if (prior) {
          if (prior.operationDigest && prior.operationDigest !== operationDigest) return nativeContractError(res, 409, "IDEMPOTENCY_CONFLICT", "This command ID was already used for a different operation");
          if (prior.commandDigest !== commandDigest && !prior.operationDigest) return nativeContractError(res, 409, "REVISION_CONFLICT", "This idempotency key was used for a different command");
          if (prior.status === "rejected") return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "The original command was not dispatched because authority changed; refresh and confirm again");
          if (prior.commandDigest !== commandDigest && prior.operationDigest === operationDigest) return json(res, 202, prior.result);
          return json(res, 202, prior.result);
        }
        const priorKey = commandIdIndex[commandIdKey];
        const priorCommand = priorKey ? commandResults[priorKey] : Object.values(commandResults).find((entry) =>
          (entry?.principalFingerprint === principalFingerprint || entry?.membershipFingerprint === membershipFingerprint) &&
          entry?.result?.commandId === command.commandId);
        if (priorCommand) {
          if (!priorCommand.operationDigest || priorCommand.operationDigest !== operationDigest) return nativeContractError(res, 409, "IDEMPOTENCY_CONFLICT", "This command ID was already used for a different operation");
          if (priorCommand.status === "rejected") return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "The original command was not dispatched because authority changed; refresh and confirm again");
          return json(res, 202, priorCommand.result);
        }
        if (Object.keys(commandResults).length >= nativeCommandReceiptCapacity) {
          return nativeContractError(res, 503, "CONTROL_UNAVAILABLE", "The hub command receipt store is full; no command was dispatched", true);
        }

        // Re-read authority after entering the serial queue. The DTO checked
        // above may have been retired, moved, made read-only, or replaced
        // while this request waited behind another command.
        const liveDevice = hubStore.getDevice(String(command.deviceId || ""));
        if (!liveDevice || !appCanReadDevice(scopedPrincipal, liveDevice)) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The selected device is unavailable");
        const liveDto = serializeNativeDevice({ device: nativeDeviceView(scopedPrincipal, liveDevice), homeId: String(scopedPrincipal.homeId), homeMembershipId: String(scopedPrincipal.membershipId), role: String(scopedPrincipal.householdRole), areaIds: (scopedPrincipal.areaIds || []).map(String), surfaces: allProjectedSurfaces(liveDevice), revision: Number(liveDevice.presentation?.descriptorRevision || 0) });
        const liveControl = liveDto?.controls.find((candidate) => candidate.controlId === command.controlId);
        if (!liveDto || liveDto.lifecycle !== "installed" || liveDto.descriptorRevision !== command.descriptorRevision || !liveControl || stableJson(liveControl) !== stableJson(control) || !validateNativeCommand(command, liveDto, liveControl, String(scopedPrincipal.membershipId))) {
          return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "The current device or control authority changed; refresh before retrying");
        }
        const liveEntity = nativeRawEntityForControl(liveDevice, liveControl.controlId);
        const liveBinding = nativeCommandBinding({ ...liveControl, value: command.value }, liveEntity);
        if (!liveEntity || !liveBinding || !appCanCommandDevice(scopedPrincipal, liveDevice, { controlId: liveControl.controlId }, liveEntity, String(liveBinding.serviceId || "").toLowerCase())) {
          return nativeContractError(res, 403, "SCOPE_DENIED", "The current control is no longer writable for this membership");
        }

        const requiresStepUp = liveControl.stepUpPolicy === "required" || ["security_lock", "lock_state"].includes(liveControl.semanticRole);
        if (requiresStepUp && !offlinePrincipal) {
          const proof = String(req.headers["x-dinodia-step-up-proof"] || "");
          const descriptorDigest = stepUpDescriptorDigest(liveDevice);
          if (!descriptorDigest) return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "Refresh the current device controls before confirming this operation");
          const requestedValue = command.value && typeof command.value === "object" && !Array.isArray(command.value)
            ? { ...command.value, controlId: liveControl.controlId }
            : { value: command.value ?? null, controlId: liveControl.controlId };
          const approved = await stepUpVerifier.verify(proof, {
            actorId: scopedPrincipal.sub,
            trustedDeviceId: scopedPrincipal.trustedDeviceId,
            trustedSessionId: scopedPrincipal.sid,
            homeId: scopedPrincipal.homeId,
            membershipId: scopedPrincipal.membershipId,
            hubInstallId: scopedPrincipal.hubInstallId,
            operation: "device_sensitive_command",
            targetIds: [liveDevice.id],
            value: descriptorBoundValue(requestedValue, { [liveDevice.id]: descriptorDigest }),
          });
          if (!approved || approved.jti !== String(command.stepUpOperationId || "")) return nativeContractError(res, 403, "STEP_UP_REQUIRED", "A fresh confirmation for this exact operation is required");
        }

        const result = { commandId: command.commandId, homeId: command.homeId, status: "accepted", acceptedAt: new Date(clock()).toISOString(), completedAt: null, errorCode: null };
        const beforeObservation = normalizedNativeObservedValue(liveDevice, liveControl);
        commandResults[idempotencyHash] = {
          commandDigest, operationDigest, membershipFingerprint, principalFingerprint, commandIdKey,
          homeId: String(scopedPrincipal.homeId), membershipId: String(scopedPrincipal.membershipId), areaIds: (scopedPrincipal.areaIds || []).map(String),
          accountId: String(scopedPrincipal.sub), policyRevision: Number(scopedPrincipal.policyRevision || 0),
          deviceId: String(command.deviceId), controlId: String(command.controlId), requestedValue: command.value,
          observationRevision: beforeObservation.revision, observationAt: Number.isFinite(beforeObservation.observedAtMs) ? new Date(beforeObservation.observedAtMs).toISOString() : null,
          status: "dispatching", result,
        };
        commandIdIndex[commandIdKey] = idempotencyHash;
        await hubStore.saveSecurity({ nativeCommandResults: commandResults, nativeCommandIdIndex: commandIdIndex });
        try {
          // Persisting the dispatch claim is asynchronous. Re-resolve both
          // session authority and the live descriptor after that await, at
          // the final effect boundary; otherwise a grant revocation or a
          // control becoming read-only during persistence could still
          // dispatch the stale snapshot captured above.
          const currentPrincipal = offlinePrincipal ? (offlineLanAuthorisations.isCurrent(scopedPrincipal) ? scopedPrincipal : null) : appSessionAuth(bearerToken(req));
          const principalStillMatches = currentPrincipal &&
            currentPrincipal.sub === scopedPrincipal.sub &&
            currentPrincipal.sid === scopedPrincipal.sid &&
            currentPrincipal.membershipId === scopedPrincipal.membershipId &&
            currentPrincipal.homeId === scopedPrincipal.homeId &&
            currentPrincipal.hubInstallId === scopedPrincipal.hubInstallId &&
            currentPrincipal.householdRole === "TENANT" &&
            currentPrincipal.scope.includes("tenant:device-command");
          const dispatchDevice = principalStillMatches ? hubStore.getDevice(String(command.deviceId || "")) : null;
          const dispatchDto = dispatchDevice && appCanReadDevice(currentPrincipal, dispatchDevice)
            ? serializeNativeDevice({ device: nativeDeviceView(currentPrincipal, dispatchDevice), homeId: String(currentPrincipal.homeId), homeMembershipId: String(currentPrincipal.membershipId), role: String(currentPrincipal.householdRole), areaIds: (currentPrincipal.areaIds || []).map(String), surfaces: allProjectedSurfaces(dispatchDevice), revision: Number(dispatchDevice.presentation?.descriptorRevision || 0) })
            : null;
          const dispatchControl = dispatchDto?.controls.find((candidate) => candidate.controlId === command.controlId);
          const dispatchEntity = dispatchDevice && dispatchControl
            ? nativeRawEntityForControl(dispatchDevice, dispatchControl.controlId)
            : null;
          const dispatchBinding = dispatchControl && dispatchEntity
            ? nativeCommandBinding({ ...dispatchControl, value: command.value }, dispatchEntity)
            : null;
          const dispatchAuthorized = Boolean(
            principalStillMatches && dispatchDevice && dispatchDto?.lifecycle === "installed" &&
            dispatchDto.descriptorRevision === command.descriptorRevision &&
            dispatchControl && stableJson(dispatchControl) === stableJson(control) &&
            validateNativeCommand(command, dispatchDto, dispatchControl, String(currentPrincipal.membershipId)) &&
            dispatchEntity && dispatchBinding &&
            appCanCommandDevice(currentPrincipal, dispatchDevice, { controlId: dispatchControl.controlId }, dispatchEntity, String(dispatchBinding.serviceId || "").toLowerCase())
          );
          if (!dispatchAuthorized) {
            commandResults[idempotencyHash] = {
              commandDigest,
              operationDigest,
              membershipFingerprint,
              principalFingerprint,
              commandIdKey,
              deviceId: String(command.deviceId),
              controlId: String(command.controlId),
              status: "rejected",
              retentionExpiresAt: new Date(Number(clock()) + nativeCommandReceiptTtlMs).toISOString(),
              result: { commandId: command.commandId, homeId: command.homeId, status: "denied", acceptedAt: null, completedAt: null, errorCode: "AUTHORITY_CHANGED_BEFORE_DISPATCH" },
            };
            await hubStore.saveSecurity({ nativeCommandResults: commandResults, nativeCommandIdIndex: commandIdIndex });
            return nativeContractError(res, 409, "CATALOG_REVISION_MISMATCH", "The current session or control authority changed before dispatch; refresh and confirm again");
          }
          const dispatched = await dispatchNativeCommand(currentPrincipal, dispatchDevice, dispatchControl, command.value);
          if (!dispatched?.dispatched) throw Object.assign(new Error("The current protocol binding is unavailable"), { code: "CONTROL_BINDING_UNAVAILABLE", statusCode: 409 });
          commandResults[idempotencyHash] = { ...commandResults[idempotencyHash], status: "accepted", adapterProtocol: dispatched.protocol };
          await hubStore.saveSecurity({ nativeCommandResults: commandResults, nativeCommandIdIndex: commandIdIndex });
          await reconcileNativeCommandObservation(String(command.deviceId), String(command.controlId));
          const settledEntry = hubStore.getSecurity?.()?.nativeCommandResults?.[idempotencyHash];
          const settledResult = settledEntry?.result || result;
          if (settledEntry?.status === "accepted") {
            scheduleNativeCommandTimeout(idempotencyHash);
            queueNativeEvent({ kind: "command", deviceId: String(command.deviceId), commandId: String(command.commandId), membershipFingerprint });
          }
          return json(res, 202, settledResult);
        } catch (error) {
          const definiteFailure = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500;
          const finalStatus = definiteFailure ? "failed" : "uncertain";
          const finalCode = String(error?.code || (definiteFailure ? "COMMAND_REJECTED" : "COMMAND_OUTCOME_UNCERTAIN"));
          const settled = await saveNativeCommandOutcome(idempotencyHash, finalStatus, finalCode).catch(() => null);
          if (!settled) {
            commandResults[idempotencyHash] = { ...commandResults[idempotencyHash], status: finalStatus, result: nativeCommandOutcome(result, finalStatus, finalCode) };
            await hubStore.saveSecurity({ nativeCommandResults: commandResults, nativeCommandIdIndex: commandIdIndex }).catch(() => {});
            queueNativeEvent({ kind: "command", deviceId: String(command.deviceId), commandId: String(command.commandId), membershipFingerprint });
          }
          return json(res, 202, settled || commandResults[idempotencyHash].result);
        }
      });
    }

    // The phone must obtain the current descriptor from the hub over the
    // trusted LAN before Platform will create a Face ID/passcode challenge.
    // This route signs only the bounded descriptor assertion; it never signs
    // an arbitrary caller-selected operation or exposes hub private material.
    if (pathname === "/api/step-up/descriptor-challenge" && req.method === "POST") {
      const cloudOrigin = runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "";
      const trustedCustomerTransport = req.socket?.encrypted === true || isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: cloudOrigin, allowLoopback: true });
      if (!scopedPrincipal || scopedPrincipal.principalType !== "app" || !trustedCustomerTransport) return json(res, 403, { error: "A trusted Native V2 transport is required", errorCode: "step_up_local_session_required" });
      if (scopedPrincipal.householdRole !== "TENANT" || !scopedPrincipal.scope.includes("tenant:device-command")) return json(res, 403, { error: "Only an authorised tenant can request a device step-up", errorCode: "step_up_scope_denied" });
      const body = await readBody(req);
      const deviceId = String(body.deviceId || "").trim();
      const requestedControlId = String(body.controlId || body.control_id || "").trim();
      const nonce = String(body.nonce || "").trim();
      if (!deviceId || !requestedControlId || !/^[A-Za-z0-9_-]{20,128}$/.test(nonce)) return json(res, 400, { error: "Device, control and a fresh nonce are required", errorCode: "step_up_descriptor_fields_invalid" });
      const device = hubStore.getDevice(deviceId);
      if (!device || !appCanReadDevice(scopedPrincipal, device)) return json(res, 404, { error: "The selected device is unavailable", errorCode: "step_up_control_denied" });
      const descriptor = serializeNativeDevice({
        device: nativeDeviceView(scopedPrincipal, device),
        homeId: String(scopedPrincipal.homeId),
        homeMembershipId: String(scopedPrincipal.membershipId),
        role: String(scopedPrincipal.householdRole),
        areaIds: (scopedPrincipal.areaIds || []).map(String),
        surfaces: allProjectedSurfaces(device),
        revision: Number(device.presentation?.descriptorRevision || device.descriptorRevision || 0),
      });
      const control = descriptor?.controls.find((candidate) => candidate.controlId === requestedControlId);
      const rawEntity = nativeRawEntityForControl(device, requestedControlId);
      if (!descriptor || descriptor.lifecycle !== "installed" || !control || !rawEntity
        || control.stepUpPolicy !== "required" && !["security_lock", "lock_state"].includes(control.semanticRole)) {
        return json(res, 403, { error: "The requested sensitive control is not currently authorised", errorCode: "step_up_control_denied" });
      }
      const descriptorRevision = descriptor.descriptorRevision;
      if (!Number.isSafeInteger(descriptorRevision) || descriptorRevision < 1) return json(res, 409, { error: "The current device descriptor is unavailable", errorCode: "step_up_descriptor_unavailable" });
      const probeCommand = {
        commandId: `stepup-${nonce}`,
        homeId: String(scopedPrincipal.homeId),
        homeMembershipId: String(scopedPrincipal.membershipId),
        deviceId,
        controlId: requestedControlId,
        descriptorRevision,
        value: body.value,
        issuedAt: new Date(clock()).toISOString(),
        idempotencyKey: `stepup-${nonce}`,
        stepUpOperationId: `stepup-${nonce}`,
      };
      if (!validateNativeCommand(probeCommand, descriptor, control, String(scopedPrincipal.membershipId))) return json(res, 400, { error: "The sensitive operation value does not match the current control", errorCode: "step_up_value_invalid" });
      const binding = nativeCommandBinding({ ...control, value: body.value }, rawEntity);
      const suppliedService = String(body.serviceId || body.service_id || "").toLowerCase();
      if (!binding || suppliedService && String(binding.serviceId || "").toLowerCase() !== suppliedService
        || !appCanCommandDevice(scopedPrincipal, device, { controlId: requestedControlId }, rawEntity, String(binding.serviceId || ""))) {
        return json(res, 403, { error: "The requested sensitive control is not currently authorised", errorCode: "step_up_control_denied" });
      }
      const descriptorDigest = stepUpDescriptorDigest(device);
      if (!descriptorDigest) return json(res, 409, { error: "The current device descriptor is unavailable", errorCode: "step_up_descriptor_unavailable" });
      const requestedValue = body.value && typeof body.value === "object" && !Array.isArray(body.value) ? { ...body.value, controlId: requestedControlId } : { value: body.value ?? null, controlId: requestedControlId };
      const operationDigest = digestOperation({ actorId: scopedPrincipal.sub, trustedDeviceId: scopedPrincipal.trustedDeviceId, customerSessionId: scopedPrincipal.sid, homeId: scopedPrincipal.homeId, membershipId: scopedPrincipal.membershipId, hubInstallId: scopedPrincipal.hubInstallId, operationKind: "device_sensitive_command", targetIds: [deviceId], value: descriptorBoundValue(requestedValue, { [deviceId]: descriptorDigest }) });
      const identity = await pairing.getPublicIdentity();
      const payload = { version: 1, serial, identityGeneration: Number(identity.generation), actorId: String(scopedPrincipal.sub), customerSessionId: String(scopedPrincipal.sid), trustedDeviceId: String(scopedPrincipal.trustedDeviceId), homeId: String(scopedPrincipal.homeId), membershipId: String(scopedPrincipal.membershipId), hubInstallId: String(scopedPrincipal.hubInstallId), operationKind: "device_sensitive_command", targetIds: [deviceId], controlId: requestedControlId, descriptorRevision, descriptorDigest, operationDigest, nonce, issuedAt: Date.now() };
      let hubSignature;
      try { hubSignature = await pairing.signStepUpDescriptor(payload); } catch { return json(res, 503, { error: "The hub signing identity is unavailable", errorCode: "hub_identity_invalid" }); }
      return json(res, 200, { ok: true, ...payload, hubSignature });
    }

    const parts = pathname.split("/").filter(Boolean);
    const resource = parts[1];
    const id = parts[2] ? decodeURIComponent(parts[2]) : "";

    if (pathname === "/api/operator/sessions/revoke" && req.method === "POST") {
      const body = await readBody(req);
      const jti = String(body.jti || "").trim();
      if (!jti || jti.length > 256) return json(res, 400, { error: "A session id is required" });
      revokedOperatorJtis.add(jti);
      const security = hubStore.getSecurity?.() || {};
      await hubStore.saveSecurity?.({ revokedOperatorJtis: { ...(security.revokedOperatorJtis || {}), [jti]: new Date().toISOString() } });
      const closed = revocationCoordinator.revoke({ jti, homeId: body.homeId == null ? null : String(body.homeId), reason: "operator_session_revoked" });
      return json(res, 200, { ok: true, jti, closedSockets: closed });
    }

    if (pathname === "/api/offline/authorisations" && req.method === "POST") return json(res, 410, { error: "Direct offline authority enrolment is retired; use Platform-signed synchronisation", errorCode: "offline_authorisation_sync_required" });
    if (pathname.startsWith("/api/offline/authorisations/") && req.method === "DELETE") {
      if (!operatorPrincipal) return json(res, 403, { error: "Only an authenticated Dinodia operator may revoke offline authority", errorCode: "insufficient_scope" });
      const id = decodeURIComponent(pathname.slice("/api/offline/authorisations/".length));
      const revoked = await offlineLanAuthorisations.revoke(id, "cloud_policy_revoked");
      return json(res, revoked ? 200 : 404, { ok: revoked, id });
    }
    if (pathname === "/api/offline/authorisations/revoke-device" && req.method === "POST") {
      if (!operatorPrincipal) return json(res, 403, { error: "Only an authenticated Dinodia operator may revoke device authority", errorCode: "insufficient_scope" });
      const body = await readBody(req);
      const revoked = await offlineLanAuthorisations.revokeDevice(body.trustedDeviceId, "trusted_device_removed");
      return json(res, 200, { ok: true, revoked });
    }

    if (resource === "status" && req.method === "GET") {
      const integrations = await integrationStatus();
      return json(res, 200, {
        ok: true,
        version: VERSION,
        hubId: serial,
        devices: hubStore.listDevices().length,
        automations: integrations.nativeAutomations,
        legacyAutomations: hubStore.listAutomations().length,
        integrations,
        heatingDemandController: heatingDemandController.status(),
      });
    }
    if (pathname === "/api/integrations/alexa" && req.method === "GET") return json(res, 200, alexaIntegration.status());
    if (pathname === "/api/integrations/alexa/connect" && req.method === "POST") {
      if (!runtimeConfig.alexaConnectIntentsEnabled) return json(res, 503, { error: "Alexa connection is not enabled", errorCode: "feature_disabled" });
      const result = await alexaIntegration.connect();
      await activity.record({ type: "alexa_link_started", detail: "Alexa account linking was started." });
      return json(res, 200, result);
    }
    if (pathname === "/api/integrations/alexa/refresh" && req.method === "POST") {
      const result = await alexaIntegration.refresh();
      await activity.record({ type: "alexa_catalog_synced", detail: "Alexa device catalogue refreshed." });
      return json(res, 200, result);
    }
    if (pathname === "/api/integrations/alexa/account" && req.method === "DELETE") {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: "Confirmation is required", errorCode: "confirmation_required" });
      const result = await alexaIntegration.disconnect();
      await activity.record({ type: "alexa_account_disconnected", detail: "Alexa was disconnected from this home." });
      return json(res, 200, result);
    }
    if (pathname === "/api/heating-demand-controller" && req.method === "GET") {
      return json(res, 200, heatingDemandController.status());
    }
    if (pathname === "/api/heating-demand-controller/config" && req.method === "PUT") {
      const result = await heatingDemandController.configure(await readBody(req));
      return json(res, 200, result);
    }
    if (pathname === "/api/heating-demand-controller/verify" && req.method === "POST") {
      return json(res, 200, await heatingDemandController.verifyReadOnly());
    }
    if (pathname === "/api/heating-demand-controller/evaluate" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await heatingDemandController.evaluate({ reason: "manual", execute: body.execute !== false }));
    }
    if (pathname === "/api/integrations/hive" && req.method === "GET") return json(res, 200, hive.status());
    if (pathname === "/api/integrations/hive/connect" && req.method === "POST") {
      if (!hiveCredentialTransportAllowed(req)) return json(res, 400, { error: "Use the secure Cloudflare dashboard to connect Hive", errorCode: "secure_transport_required" });
      const body = await readBody(req);
      try {
        await activity.record({ type: "hive_account_connect_started", detail: "A Hive account connection was requested." });
        const result = await hive.connect({ username: body.username || body.email, password: body.password });
        await activity.record({ type: result.status === "mfa_required" ? "hive_mfa_required" : "hive_account_connected", detail: result.status === "mfa_required" ? "Hive requested SMS verification." : "Hive account connected and discovered.", change: { status: result.status, discovered: result.discovered || 0 } });
        return json(res, 200, result);
      } catch (error) {
        await activity.record({ type: "hive_account_connect_failed", detail: error.message || "Hive account connection failed.", change: { code: error.code || "hive_api_unavailable" } }).catch(() => {});
        throw error;
      }
    }
    if (parts[0] === "api" && parts[1] === "integrations" && parts[2] === "hive" && parts[3] === "sessions" && parts[4] && parts[5] === "mfa" && req.method === "POST") {
      if (!hiveCredentialTransportAllowed(req)) return json(res, 400, { error: "Use the secure Cloudflare dashboard to verify Hive", errorCode: "secure_transport_required" });
      const body = await readBody(req);
      try {
        const result = await hive.submitMfa(parts[4], body.code);
        await activity.record({ type: "hive_account_connected", detail: "Hive SMS verification completed and devices were discovered.", change: { discovered: result.discovered || 0 } });
        return json(res, 200, result);
      } catch (error) {
        await activity.record({ type: "hive_account_mfa_failed", detail: error.message || "Hive SMS verification failed.", change: { code: error.code || "invalid_mfa_code" } }).catch(() => {});
        throw error;
      }
    }
    if (parts[0] === "api" && parts[1] === "integrations" && parts[2] === "hive" && parts[3] === "sessions" && parts[4] && parts[5] === "cancel" && req.method === "POST") return json(res, 200, { ok: hive.cancelSetup(parts[4]) });
    if (pathname === "/api/integrations/hive/refresh" && req.method === "POST") {
      const result = await hive.refresh({ reason: "manual" });
      await activity.record({ type: "hive_discovery_completed", detail: "Hive devices refreshed.", change: { discovered: result.heatingDeviceCount || 0 } });
      return json(res, 200, { ok: true, discovered: result.heatingDeviceCount || 0, status: hive.status() });
    }
    if (parts[0] === "api" && parts[1] === "integrations" && parts[2] === "hive" && parts[3] === "ignored" && parts[4] && req.method === "DELETE") {
      const restored = await hive.restoreDevice(decodeURIComponent(parts.slice(4).join("/")));
      if (!restored) return json(res, 404, { error: "The Hive device is not hidden", errorCode: "device_not_found" });
      await activity.record({ type: "hive_device_discovered", detail: "A previously hidden Hive device was restored for setup." });
      return json(res, 200, { ok: true, status: hive.status() });
    }
    if (pathname === "/api/integrations/hive/reauthenticate" && req.method === "POST") {
      if (!hiveCredentialTransportAllowed(req)) return json(res, 400, { error: "Use the secure Cloudflare dashboard to reconnect Hive", errorCode: "secure_transport_required" });
      const body = await readBody(req);
      const result = await hive.connect({ username: body.username || body.email, password: body.password });
      await activity.record({ type: result.status === "mfa_required" ? "hive_mfa_required" : "hive_account_reauthenticated", detail: result.status === "mfa_required" ? "Hive requested SMS verification during reauthentication." : "Hive account reauthenticated.", change: { status: result.status } });
      return json(res, 200, result);
    }
    if (pathname === "/api/integrations/hive/account" && req.method === "DELETE") {
      const body = await readBody(req);
      const result = await hive.disconnect({ allowLocalOnly: Boolean(body.allowLocalOnly || body.force) });
      await activity.record({ type: "hive_account_disconnected", detail: "Hive account and all local Hive projections were removed.", change: { remote: result.remote } });
      eventBus.emit("dinodia_dashboard_updated", { kind: "integration", integration: "hive", at: new Date().toISOString() });
      return json(res, 200, result);
    }
    if (pathname === "/api/integrations/google-nest" && req.method === "GET") return json(res, 200, googleNestDashboardStatus());
    if (pathname === "/api/integrations/google-nest/configure" && req.method === "POST") {
      if (!googleNestCredentialTransportAllowed(req)) return json(res, 400, { error: "Use the secure Cloudflare dashboard to configure Google Nest", errorCode: "secure_cloudflare_required" });
      const body = await readBody(req);
      const redirectUri = googleNestCallbackUri();
      if (!redirectUri) return json(res, 400, { error: "Configure the Cloudflare hostname before saving Google Nest credentials", errorCode: "secure_cloudflare_required" });
      try {
        const result = await googleNest.configureDeveloper({
          deviceAccessProjectId: body.deviceAccessProjectId,
          oauthClientId: body.oauthClientId,
          oauthClientSecret: body.oauthClientSecret,
          registeredRedirectUri: redirectUri,
          releaseChannel: runtimeConfig.googleNestReleaseChannel,
        });
        await activity.record({ type: "google_nest_operator_credentials_configured", detail: "Google Nest Sandbox credentials were saved in the encrypted vault.", change: { releaseChannel: result.releaseChannel } });
        return json(res, 200, result);
      } catch (error) {
        await activity.record({ type: "google_nest_operator_credentials_failed", detail: "Google Nest Sandbox credentials could not be saved.", change: { code: error.code || "google_nest_config_invalid" } }).catch(() => {});
        throw error;
      }
    }
    if (pathname === "/api/integrations/google-nest/connect" && req.method === "POST") {
      if (!googleNestCredentialTransportAllowed(req)) return json(res, 400, { error: "Use the secure Cloudflare dashboard to connect Google Nest", errorCode: "secure_cloudflare_required" });
      try {
        await activity.record({ type: "google_nest_authorization_started", detail: "Google Nest authorization was started." });
        const redirectUri = googleNestCallbackUri();
        if (!redirectUri) throw Object.assign(new Error("Configure the Cloudflare hostname before connecting Google Nest"), { code: "secure_cloudflare_required", statusCode: 400 });
        const origin = new URL(redirectUri).origin;
        return json(res, 200, await googleNest.beginAuthorization({ redirectUri, origin }));
      } catch (error) {
        await activity.record({ type: "google_nest_authorization_failed", detail: "Google Nest authorization could not be started.", change: { code: error.code || "google_nest_not_configured" } }).catch(() => {});
        throw error;
      }
    }
    if (parts[0] === "api" && parts[1] === "integrations" && parts[2] === "google-nest" && parts[3] === "sessions" && parts[4] && parts[5] === "cancel" && req.method === "POST") {
      const cancelled = googleNest.cancelAuthorization(parts[4]);
      if (cancelled) await activity.record({ type: "google_nest_authorization_cancelled", detail: "Google Nest authorization was cancelled." });
      return json(res, 200, { ok: cancelled });
    }
    if (pathname === "/api/integrations/google-nest/refresh" && req.method === "POST") {
      // A manual refresh is also the operator's recovery action for a stale
      // Google SDM resource. Force a new access token so discovery cannot be
      // satisfied from a still-valid token that has an obsolete device view.
      const result = await googleNest.refresh({ reason: "manual", forceToken: true, bypassRateLimit: true });
      await activity.record({ type: "google_nest_discovery_completed", detail: "Google Nest thermostats refreshed.", change: { discovered: result.thermostatDeviceCount || 0 } });
      return json(res, 200, { ok: true, discovered: result.thermostatDeviceCount || 0, status: googleNest.status() });
    }
    if (parts[0] === "api" && parts[1] === "integrations" && parts[2] === "google-nest" && parts[3] === "ignored" && parts[4] && req.method === "DELETE") {
      const restored = await googleNest.restoreDevice(decodeURIComponent(parts.slice(4).join("/")));
      if (!restored) return json(res, 404, { error: "The Google Nest device is not hidden", errorCode: "device_not_found" });
      await activity.record({ type: "google_nest_device_discovered", detail: "A previously hidden Google Nest thermostat was restored for setup." });
      return json(res, 200, { ok: true, status: googleNest.status() });
    }
    if (pathname === "/api/integrations/google-nest/reauthenticate" && req.method === "POST") {
      if (!googleNestCredentialTransportAllowed(req)) return json(res, 400, { error: "Use the secure Cloudflare dashboard to reconnect Google Nest", errorCode: "secure_cloudflare_required" });
      const redirectUri = googleNestCallbackUri();
      if (!redirectUri) throw Object.assign(new Error("Configure the Cloudflare hostname before reconnecting Google Nest"), { code: "secure_cloudflare_required", statusCode: 400 });
      return json(res, 200, await googleNest.beginAuthorization({ redirectUri, origin: new URL(redirectUri).origin }));
    }
    if (pathname === "/api/integrations/google-nest/account" && req.method === "DELETE") {
      const body = await readBody(req);
      const result = await googleNest.disconnect({ allowLocalOnly: Boolean(body.allowLocalOnly || body.force) });
      await activity.record({ type: "google_nest_account_disconnected", detail: "Google Nest account and all local Nest projections were removed.", change: { remote: result.remote } });
      eventBus.emit("dinodia_dashboard_updated", { kind: "integration", integration: "googleNest", at: new Date().toISOString() });
      return json(res, 200, result);
    }
    if (resource === "readiness" && req.method === "GET") return json(res, 200, await readiness());
    if (resource === "provisioning" && req.method === "GET") {
      const identity = hubStore.getIdentity ? hubStore.getIdentity() : { serial };
      const credentials = legacyCompatibilityEnabled ? {
        username: runtimeConfig.haUsername,
        oneTimeLongLivedToken: pendingHaToken || undefined,
        oneTimePassword: pendingHaPassword || undefined,
        displayed: Boolean(hubStore.getAuth?.().displayedAt),
      } : undefined;
      return json(res, 200, {
        ok: true,
        identity: { serial: identity.serial || serial, instanceId: identity.instanceId || "" },
        setup: hubStore.getSetup ? hubStore.getSetup() : { state: "UNKNOWN" },
        platform: pairing.status(),
        pairing: provisioningPairing.status(),
        heatingUsage: heating.status(),
        electricUsage: electric.status(),
        ...(credentials ? { credentials } : {}),
        urls: { baseUrl: `http://${privateAddress(req)}:${runtimeConfig.haPort}`, hubAgentUrl: `http://${privateAddress(req)}:${runtimeConfig.hubAgentPort}`, cloudUrl: cloudflare.status().secureAccessVerified ? cloudflare.status().publicUrl || "" : "" },
      });
    }
    if (resource === "provisioning" && parts[2] === "credentials" && parts[3] === "ack" && req.method === "POST") {
      if (!legacyCompatibilityEnabled) return json(res, 410, { error: "Legacy credential acknowledgement is retired", errorCode: "legacy_credential_flow_retired" });
      pendingHaToken = "";
      pendingHaPassword = "";
      if (hubStore.saveAuth) await hubStore.saveAuth({ displayedAt: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }
    if (resource === "provisioning" && parts[2] === "credentials" && parts[3] === "regenerate" && req.method === "POST") {
      if (!legacyCompatibilityEnabled) return json(res, 410, { error: "Legacy credential regeneration is retired", errorCode: "legacy_credential_flow_retired" });
      const token = `dinodia_${crypto.randomBytes(30).toString("base64url")}`;
      const password = `Dino-${crypto.randomBytes(12).toString("base64url")}`;
      const salt = crypto.randomBytes(16).toString("hex");
      const digest = crypto.scryptSync(password, salt, 32).toString("hex");
      await hubStore.saveAuth({ haTokenHash: hashTokenValue(token), passwordHash: `scrypt$${salt}$${digest}`, issuedAt: new Date().toISOString(), displayedAt: null });
      pendingHaToken = token;
      pendingHaPassword = password;
      return json(res, 200, { ok: true, oneTimeLongLivedToken: token, oneTimePassword: password, restartRequired: false });
    }
    if (pathname === "/api/factory-reset" && req.method === "POST") {
      if (!operatorPrincipal) return json(res, 403, { error: "An authenticated Dinodia operator is required", errorCode: "insufficient_scope" });
      const proof = String(req.headers["x-dinodia-step-up-proof"] || "");
      const approved = await stepUpVerifier.verify(proof, {
        actorId: operatorPrincipal.sub,
        homeId: serial,
        operation: "factory_reset",
        targetIds: [serial],
        value: {},
      });
      if (!approved) return json(res, 403, { error: "A fresh operation-bound factory-reset confirmation is required", errorCode: "step_up_required" });
      await activity.record({ type: "factory_reset_requested", detail: "Factory reset was authorised by a Dinodia operator." }).catch(() => {});
      await cloudflare.disconnect();
      pairing.stop();
      await hive.close();
      await googleNest.close();
      if (vault.clearAll) await vault.clearAll();
      await hubStore.factoryReset();
      return json(res, 202, { ok: true, restartRequired: true, message: "Hub data and pairing state were removed. Restart Dinodia OS to initialize a new identity." });
    }
    if (resource === "provisioning" && parts[2] === "pair" && req.method === "POST") {
      const body = await readBody(req);
      if (!legacyCompatibilityEnabled) {
        // A local browser or caller must not self-redeem the presentation. In
        // production the hub proves the redeemed attempt through its outbound
        // Platform channel; this retired endpoint exists only to provide an
        // explicit, non-secret migration error to old clients.
        return json(res, 410, { error: "Local provisioning redemption is retired; use the outbound hub pairing channel", errorCode: "native_pairing_requires_outbound_channel" });
      }
      await pairing.configure({ bootstrapSecret: body.bootstrapSecret || body.bootstrap_secret, apiUrl: body.apiUrl });
      const result = await pairing.pair(body.bootstrapSecret || body.bootstrap_secret);
      await pairing.syncNow();
      if (hubStore.saveSetup) await hubStore.saveSetup({ state: "PLATFORM_PAIRED", completed: ["identity", "platform-paired"] });
      return json(res, 200, { ok: true, paired: true, result: { publishedVersion: result.publishedVersion || 0 }, status: pairing.status() });
    }
    if (resource === "provisioning" && parts[2] === "ha-token" && req.method === "POST") {
      if (!legacyCompatibilityEnabled) return json(res, 410, { error: "Legacy HA token provisioning is retired", errorCode: "legacy_credential_flow_retired" });
      const body = await readBody(req);
      const token = String(body.token || `dinodia_${crypto.randomBytes(30).toString("base64url")}`).trim();
      if (token.length < 24 || token.length > 256) return json(res, 400, { error: "HA token must be between 24 and 256 characters" });
      await hubStore.saveAuth({ haTokenHash: hashTokenValue(token), issuedAt: new Date().toISOString(), displayedAt: null });
      pendingHaToken = token;
      return json(res, 200, { ok: true, oneTimeLongLivedToken: token, restartRequired: Boolean(configuredHaToken) });
    }
    if (resource === "activity" && id === "devices" && req.method === "GET") return json(res, 200, { devices: hubStore.listActivityDevices() });
    if (resource === "activity" && req.method === "GET") {
      return json(res, 200, {
        ...hubStore.listActivity({
          limit: url.searchParams.get("limit"),
          before: url.searchParams.get("before"),
          deviceId: url.searchParams.get("deviceId"),
          severity: url.searchParams.get("severity"),
          category: url.searchParams.get("category"),
          before: url.searchParams.get("before") || url.searchParams.get("cursor"),
        }),
        filters: { devices: hubStore.listActivityDevices() },
      });
    }
    if (resource === "areas" && req.method === "GET" && !id) return json(res, 200, { areas: hubStore.listAreas() });
    if (resource === "areas" && req.method === "POST" && !id) {
      const input = await readBody(req);
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join(",") !== "icon,id,name"
        || typeof input.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)
        || typeof input.name !== "string" || input.name.trim().length < 1 || [...input.name.trim()].length > 80
        || /[\u0000-\u001f\u007f]/u.test(input.name) || input.icon !== "room") {
        return json(res, 400, { error: "Enter a valid Area name", errorCode: "area_input_invalid" });
      }
      const normalizedName = input.name.normalize("NFKC").trim();
      const idempotentArea = hubStore.getArea(input.id);
      if (idempotentArea) {
        if (idempotentArea.name === normalizedName && idempotentArea.icon === input.icon) return json(res, 200, idempotentArea);
        return json(res, 409, { error: "This Area request ID was already used with different details", errorCode: "area_request_conflict" });
      }
      const duplicate = hubStore.listAreas().find((area) => area.name.normalize("NFKC").trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
      if (duplicate) return json(res, 409, { error: "An Area with that name already exists", errorCode: "area_already_exists" });
      const area = await hubStore.saveArea({ name: normalizedName, icon: input.icon }, input.id);
      await activity.record({ type: "area_created", area: { id: area.id, name: area.name }, detail: `Area ${area.name} was created.` });
      eventBus.emit("registry_updated", { registry: "area", id: area.id });
      eventBus.emit("dinodia_dashboard_updated", { kind: "registry", registry: "area", id: area.id, at: new Date().toISOString() });
      return json(res, 201, area);
    }
    if (resource === "areas" && id && req.method === "PUT") {
      const previous = hubStore.getArea(id);
      if (!previous) return json(res, 404, { error: "Area not found" });
      const area = await hubStore.saveArea(await readBody(req), id);
      if (previous.name !== area.name) await activity.record({ type: "area_renamed", area: { id: area.id, name: area.name }, change: { field: "name", before: previous.name, after: area.name }, detail: `${previous.name} → ${area.name}` });
      await electric.tick(hubStore.listDevices());
      eventBus.emit("registry_updated", { registry: "area", id: area.id });
      eventBus.emit("dinodia_dashboard_updated", { kind: "registry", registry: "area", id: area.id, at: new Date().toISOString() });
      return json(res, 200, area);
    }
    if (resource === "areas" && id && req.method === "DELETE") {
      const removal = await hubStore.removeArea(id);
      if (removal.removed) {
        await activity.record({ type: "area_removed", area: { id, name: removal.areaName }, detail: `Area ${removal.areaName || id} was removed.`, change: { deviceAssignmentsCleared: removal.deviceAssignmentsCleared, entityAssignmentsCleared: removal.entityAssignmentsCleared } });
        eventBus.emit("registry_removed", { registry: "area", id });
        eventBus.emit("dinodia_dashboard_updated", { kind: "registry", registry: "area", id, at: new Date().toISOString() });
        await electric.tick(hubStore.listDevices());
      }
      return json(res, removal.removed ? 204 : 404, {});
    }
    if (resource === "labels" && req.method === "GET" && !id) return json(res, 200, { labels: hubStore.listLabels() });
    if (resource === "labels" && req.method === "POST" && !id) {
      const label = await hubStore.saveLabel(await readBody(req));
      eventBus.emit("dinodia_dashboard_updated", { kind: "registry", registry: "label", id: label.id, at: new Date().toISOString() });
      return json(res, 201, label);
    }
    if (resource === "labels" && id && req.method === "PUT") {
      if (!hubStore.getLabel(id)) return json(res, 404, { error: "Label not found" });
      const label = await hubStore.saveLabel(await readBody(req), id);
      await electric.tick(hubStore.listDevices());
      eventBus.emit("dinodia_dashboard_updated", { kind: "registry", registry: "label", id: label.id, at: new Date().toISOString() });
      return json(res, 200, label);
    }
    if (resource === "labels" && id && req.method === "DELETE") {
      const deleted = await hubStore.deleteLabel(id);
      if (deleted) {
        await electric.tick(hubStore.listDevices());
        eventBus.emit("dinodia_dashboard_updated", { kind: "registry", registry: "label", id, at: new Date().toISOString() });
      }
      return json(res, deleted ? 204 : 404, {});
    }
    if (resource === "devices" && req.method === "GET" && !id) {
      const devices = hubStore.listDevices()
        .filter((device) => supportOperator ? supportCanReadDevice(operatorPrincipal, device) : (!scopedPrincipal || appCanReadDevice(scopedPrincipal, device)))
        .map(dashboardDevice);
      return json(res, 200, { devices });
    }
    if (resource === "devices" && req.method === "POST" && !id) {
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: "id is required" });
      if (body.areaId && !hubStore.getArea(String(body.areaId))) return json(res, 400, { error: "Area not found" });
      const requestedLabels = body.labelIds || body.labels || [];
      if (!Array.isArray(requestedLabels) || requestedLabels.some((labelId) => !hubStore.getLabel(String(labelId)))) return json(res, 400, { error: "labelIds must contain existing label IDs" });
      const device = await hubStore.upsertDevice({
        id: String(body.id),
        name: body.name || body.id,
        protocol: body.protocol || "virtual",
        state: body.state || {},
        metadata: body.metadata || {},
        areaId: body.areaId || null,
        entities: body.entities || {},
        available: body.available !== false,
      });
      await activity.record({ type: "device_discovered", device: activity.deviceSnapshot(device), detail: `${device.protocol} device added to the local registry.` });
      await hubStore.addEvent({ type: "device_added", deviceId: device.id, protocol: device.protocol });
      await notifyDeviceChanged(device);
      return json(res, 201, dashboardDevice(device));
    }
    if (resource === "devices" && id && parts[3] === "entities" && parts[4] && req.method === "PUT") {
      const entityId = decodeURIComponent(parts.slice(4).join("/"));
      const device = hubStore.getDevice(id);
      if (!device) return json(res, 404, { error: "Device not found" });
      const patch = await readBody(req);
      if (patch.areaId && !hubStore.getArea(String(patch.areaId))) return json(res, 400, { error: "Area not found" });
      if (patch.labelIds || patch.labels) {
        const labelIds = patch.labelIds || patch.labels;
        if (!Array.isArray(labelIds) || labelIds.some((labelId) => !hubStore.getLabel(String(labelId)))) {
          return json(res, 400, { error: "labelIds must contain existing label IDs" });
        }
      }
      const entity = await hubStore.updateEntity(id, entityId, patch);
      if (entity) {
        const updatedDevice = hubStore.getDevice(id);
        const previousEntity = device.entities?.[entityId] || {};
        const changes = [];
        for (const field of ["name", "areaId", "labelIds"]) if (JSON.stringify(previousEntity[field]) !== JSON.stringify(entity[field])) changes.push({ field, before: previousEntity[field] || null, after: entity[field] || null });
        if (changes.length) await activity.record({ type: "entity_configuration_changed", device: activity.deviceSnapshot(updatedDevice), detail: "An entity name, area, or label changed.", change: { entityId, fields: changes } });
        if (updatedDevice) {
          await electric.onDeviceChanged(updatedDevice);
          eventBus.emit("dinodia_dashboard_updated", { kind: "device", deviceId: updatedDevice.id, at: new Date().toISOString() });
        }
      }
      return entity ? json(res, 200, entity) : json(res, 404, { error: "Entity not found" });
    }
    if (resource === "devices" && id && parts[3] === "setup" && req.method === "GET") {
      const device = hubStore.getDevice(id);
      if (!device) return json(res, 404, { error: "Device not found" });
      const preview = hubStore.previewDeviceSetup(id, { areaId: url.searchParams.get("areaId") || device.areaId, labelId: url.searchParams.get("labelId") || device.labelIds?.[0] || device.labels?.[0], name: device.name });
      return json(res, 200, { device: dashboardDevice(device), setup: device.setup || { status: "needs_setup" }, surfacePreview: preview ? { status: preview.status, inferredType: preview.inferredType, surfaces: Object.values(preview.surfaces || {}) } : null });
    }
    if (resource === "devices" && id && parts[3] === "setup" && req.method === "PUT") {
      const existing = hubStore.getDevice(id);
      if (!existing) return json(res, 404, { error: "Device not found" });
      if (!hubStore.listDevices().some((device) => device.id === existing.id)) return json(res, 400, { error: "Radio infrastructure cannot be assigned as a household device" });
      const body = await readBody(req);
      if (Object.prototype.hasOwnProperty.call(body, "entities") || Object.prototype.hasOwnProperty.call(body, "entityAssignments")) return json(res, 400, { error: "Assign the area and label at device level only" });
      const previous = existing;
      const device = await hubStore.completeDeviceSetup(id, body);
      if (!device) return json(res, 404, { error: "Device not found" });
      await hubStore.addEvent({ type: "device_setup_completed", deviceId: device.id, labelId: device.labelIds?.[0], areaId: device.areaId });
      eventBus.emit("registry_updated", { registry: "device", id: device.haDeviceId || device.id });
      await notifyDeviceChanged(device, previous);
      return json(res, 200, { device: dashboardDevice(device), setup: device.setup, surfacePreview: { status: device.presentation?.status, inferredType: device.presentation?.inferredType, surfaces: allProjectedSurfaces(device) } });
    }
    if (resource === "devices" && id && req.method === "PUT") {
      const existing = hubStore.getDevice(id);
      if (!existing) return json(res, 404, { error: "Device not found" });
      const patch = await readBody(req);
      if (patch.areaId && !hubStore.getArea(String(patch.areaId))) return json(res, 400, { error: "Area not found" });
      if (patch.labelIds || patch.labels) {
        const labelIds = patch.labelIds || patch.labels;
        if (!Array.isArray(labelIds) || labelIds.some((labelId) => !hubStore.getLabel(String(labelId)))) return json(res, 400, { error: "labelIds must contain existing label IDs" });
      }
      const device = await hubStore.updateDevice(id, {
        name: patch.name,
        areaId: patch.areaId,
        labelIds: patch.labelIds || patch.labels,
        metadata: patch.metadata,
      });
      await notifyDeviceChanged(device, existing);
      await hubStore.addEvent({ type: "device_updated", deviceId: id });
      eventBus.emit("dinodia_dashboard_updated", { kind: "device", deviceId: device.id, at: new Date().toISOString() });
      return json(res, 200, dashboardDevice(device));
    }
    if (resource === "devices" && id && parts[3] === "command" && req.method === "POST") {
      const body = await readBody(req);
      const protocol = body.protocol;
      const command = body.command !== undefined ? body.command : (() => {
        const { protocol: ignored, ...rest } = body;
        return rest;
      })();
      try {
        return json(res, 200, dashboardDevice(await commandDevice(id, protocol, command)));
      } catch (error) {
        await activity.record({
          type: "command_failed",
          device: activity.deviceSnapshot(hubStore.getDevice(id)),
          detail: error.message || "The device command failed.",
          change: { protocol: protocol || hubStore.getDevice(id)?.protocol || "unknown", command },
        }).catch(() => {});
        throw error;
      }
    }
    if (resource === "devices" && id && parts[3] === "capabilities" && req.method === "GET") {
      const device = hubStore.getDevice(id);
      if (!device) return json(res, 404, { error: "Device not found" });
      if (supportOperator && !supportCanReadDevice(operatorPrincipal, device)) return json(res, 403, { error: "Device is outside the support scope", errorCode: "support_scope_denied" });
      if (scopedPrincipal && !appCanReadDevice(scopedPrincipal, device)) return json(res, 403, { error: "Device is outside the selected membership scope", errorCode: "device_scope_denied" });
      const surfaces = allProjectedSurfaces(device);
      const sourceIds = new Set(surfaces.flatMap((surface) => surface.sourceEntityIds || []));
      const publicRaw = (entity) => ({
        id: entity.id,
        endpointId: entity.endpointId || "0",
        name: entity.name,
        domain: entity.domain,
        category: entity.category,
        state: entity.state,
        capability: entity.capability,
        manifest: publicCapability(entity.capability, entity)["dinodia_capability"] || null,
      });
      return json(res, 200, {
        id: device.id,
        protocol: device.protocol,
        name: device.name,
        available: device.available !== false,
        setup: device.setup || { status: "needs_setup" },
        presentation: { version: device.presentation?.version || 1, policyRevision: device.presentation?.policyRevision || null, sourceFingerprint: device.presentation?.sourceFingerprint || null, status: device.presentation?.status || "pending_assignment", inferredType: device.presentation?.inferredType || null },
        controlsShownInApps: surfaces,
        statusAndDiagnostics: Object.values(device.entities || {}).filter((entity) => !sourceIds.has(entity.id)).map(publicRaw),
        unsupported: Object.values(device.entities || {}).filter((entity) => entity.category === "unsupported").map(publicRaw),
        definition: { source: device.definition?.source || null, model: device.definition?.model || null, supported: device.definition?.supported !== false },
      });
    }
    if (resource === "devices" && id && parts[3] === "presentation" && parts[4] === "rebuild" && req.method === "POST") {
      const device = await hubStore.rebuildPresentation(id);
      if (!device) return json(res, 404, { error: "Device not found" });
      await hubStore.addEvent({ type: "device_presentation_rebuilt", deviceId: device.id, status: device.presentation?.status });
      return json(res, 200, { ok: true, device: dashboardDevice(device), presentation: device.presentation, surfaces: allProjectedSurfaces(device) });
    }
    if (resource === "devices" && id && !parts[3] && req.method === "DELETE") {
      const device = hubStore.getDevice(id);
      if (!device) return json(res, 404, { error: "Device not found" });
      if (!hubStore.listDevices().some((candidate) => candidate.id === device.id)) return json(res, 400, { error: "Radio infrastructure cannot be removed as a household device" });
      const body = await readBody(req);
      try {
        await activity.record({ type: "device_unpair_requested", device: activity.deviceSnapshot(device), detail: `${device.name} is being removed from the hub.` });
        await electric.retireDevice(device);
        const removed = await haModel.removeDevice({ device_id: device.id, force: Boolean(body.force) });
        if (removed) {
          eventBus.emit("dinodia_dashboard_updated", { kind: "device_removed", deviceId: device.id, at: new Date().toISOString() });
        }
        return json(res, removed ? 200 : 404, { ok: removed, removed: removed ? { id: device.id, protocol: device.protocol, name: device.name } : null });
      } catch (error) {
        await activity.record({ type: "device_remove_failed", device: activity.deviceSnapshot(device), detail: error.message || "The device could not be removed.", reportable: true, incident: { incidentId: `device_remove_failed:${device.id}`, kind: "device_remove_failed", state: "open", revision: 1, details: { protocol: device.protocol } } }).catch((activityError) => logger.error(`[activity] ${activityError.message}`));
        return json(res, Number(error.statusCode) || 502, { error: error.message || "The device could not be removed" });
      }
    }
    if (resource === "entities" && id && parts[3] === "service" && req.method === "POST") {
      const body = await readBody(req);
      const item = haModel.findEntity(id);
      if (!item) return json(res, 404, { error: "Entity not found" });
      const serviceId = String(body.serviceId || body.service_id || "");
      const dot = serviceId.indexOf(".");
      if (dot < 1) return json(res, 400, { error: "serviceId must look like domain.service" });
      if (scopedPrincipal && !appCanCommandDevice(scopedPrincipal, item.device, body, item.entity, serviceId)) return json(res, 403, { error: "This control is not writable for the selected tenant scope", errorCode: "control_scope_denied" });
      if (offlinePrincipal) {
        const requestedControlId = String(body.controlId || body.control_id || item.entity?.controlId || item.entity?.capability?.controlId || item.entity?.id || "");
        const expectedDigest = digestOfflineCommand({ deviceId: item.device.id, entityId: item.haId, controlId: requestedControlId, serviceId, value: body.data || {} });
        if (!offlineChallenge || String(offlineChallenge.deviceId) !== String(item.device.id) || String(offlineChallenge.controlId) !== requestedControlId || String(offlineChallenge.valueDigest) !== expectedDigest) {
          return json(res, 403, { error: "The offline authorization is not bound to this exact device control and value", errorCode: "offline_operation_scope_denied" });
        }
      }
      try {
        const sensitive = Boolean(item.entity?.capability?.sensitive) || /^(lock|alarm|security)$/i.test(String(item.domain || "").split(".")[0]);
        if (scopedPrincipal && sensitive) {
          const proof = String(req.headers["x-dinodia-step-up-proof"] || "");
          const descriptorDigests = body.descriptorDigests && typeof body.descriptorDigests === "object" && !Array.isArray(body.descriptorDigests)
            ? body.descriptorDigests
            : {};
          const currentDescriptor = stepUpDescriptorDigest(item.device);
          const suppliedDescriptor = descriptorDigests[item.device.id] == null ? null : String(descriptorDigests[item.device.id]);
          if (!currentDescriptor || !Object.prototype.hasOwnProperty.call(descriptorDigests, item.device.id) || suppliedDescriptor !== currentDescriptor) {
            return json(res, 409, { error: "Refresh the device controls before confirming this operation", errorCode: "step_up_descriptor_stale" });
          }
          const approved = await stepUpVerifier.verify(proof, {
            actorId: scopedPrincipal.sub,
            trustedDeviceId: scopedPrincipal.trustedDeviceId,
            trustedSessionId: scopedPrincipal.sid,
            homeId: scopedPrincipal.homeId,
            membershipId: scopedPrincipal.membershipId,
            hubInstallId: scopedPrincipal.hubInstallId,
            // The platform step-up contract uses a stable operation catalog;
            // the exact service remains bound by target IDs and value digest.
            operation: "device_sensitive_command",
            targetIds: [item.device.id],
            value: descriptorBoundValue({ ...(body.data || {}), controlId: requestedControlId }, { [item.device.id]: suppliedDescriptor }),
          });
          if (!approved) return json(res, 403, { error: "Fresh step-up confirmation is required for this sensitive control", errorCode: "step_up_required" });
        }
        const result = await haModel.callService(serviceId.slice(0, dot), serviceId.slice(dot + 1), { ...(body.data || {}), entity_id: item.haId });
        return json(res, 200, result);
      } catch (error) {
        await activity.record({ type: "command_failed", device: activity.deviceSnapshot(item.device), detail: error.message || "The entity command failed.", change: { entityId: item.haId, serviceId } }).catch(() => {});
        throw error;
      }
    }
    if (resource === "devices" && id && parts[3] === "support-bundle" && req.method === "GET") {
      const device = hubStore.getDevice(id);
      if (!device) return json(res, 404, { error: "Device not found" });
      if (supportOperator && !supportCanReadDevice(operatorPrincipal, device)) return json(res, 403, { error: "Device is outside the support scope", errorCode: "support_scope_denied" });
      if (scopedPrincipal && !appCanReadDevice(scopedPrincipal, device)) return json(res, 403, { error: "Device is outside the selected membership scope", errorCode: "device_scope_denied" });
      const metadata = JSON.parse(JSON.stringify(device.metadata || {}));
      for (const key of Object.keys(metadata)) if (/token|secret|credential|password|code|dataset|fabric/i.test(key)) delete metadata[key];
      if (device.protocol === "google_nest") {
        delete metadata.resource_name;
        delete metadata.account_fingerprint;
      }
      return json(res, 200, { generatedAt: new Date().toISOString(), device: { id: device.id, protocol: device.protocol, name: device.name, metadata, definition: device.definition || {}, entities: Object.values(device.entities || {}).map((entity) => ({ id: entity.id, endpointId: entity.endpointId, logicalKey: entity.logicalKey, domain: entity.domain, expose: entity.expose, capability: entity.capability })) } });
    }
    if (resource === "devices" && id && req.method === "GET") {
      const device = hubStore.getDevice(id);
      if (supportOperator && !supportCanReadDevice(operatorPrincipal, device)) return json(res, 403, { error: "Device is outside the support scope", errorCode: "support_scope_denied" });
      if (scopedPrincipal && !appCanReadDevice(scopedPrincipal, device)) return json(res, 403, { error: "Device is outside the selected membership scope", errorCode: "device_scope_denied" });
      return device ? json(res, 200, dashboardDevice(device)) : json(res, 404, { error: "Device not found" });
    }
    if (resource === "automations" && id === "catalog" && req.method === "GET") {
      if (runtimeConfig.nativeAutomationsMode === "off") return json(res, 200, { schemaVersion: 1, catalogRevision: "off", devices: [], mode: "off" });
      return json(res, 200, { ...nativeAutomationService.catalog({ homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }), mode: runtimeConfig.nativeAutomationsMode });
    }
    if (resource === "automations" && id && parts[3] === "executions" && req.method === "GET" && hubStore.getNativeAutomation(id)) return json(res, 200, nativeAutomationService.history(id, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }));
    if (resource === "automations" && id && parts[3] === "duplicate" && req.method === "POST" && hubStore.getNativeAutomation(id)) {
      if (runtimeConfig.nativeAutomationsMode !== "enabled") return json(res, 403, { error: { code: "native_automations_read_only", message: "Native automations are read-only on this hub" } });
      const body = await readBody(req);
      return json(res, 201, await nativeAutomationService.duplicate(id, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }, { name: body.name }));
    }
    if (resource === "automations" && id && parts[3] === "enabled" && req.method === "PATCH" && hubStore.getNativeAutomation(id)) {
      if (runtimeConfig.nativeAutomationsMode !== "enabled") return json(res, 403, { error: { code: "native_automations_read_only", message: "Native automations are read-only on this hub" } });
      const body = await readBody(req);
      return json(res, 200, await nativeAutomationService.setEnabled(id, body.enabled, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }, { expectedRevision: body.expectedRevision ?? req.headers["if-match"]?.replace(/^\"|\"$/g, "") }));
    }
    if (resource === "automations" && id && !parts[3] && req.method === "GET" && hubStore.getNativeAutomation(id)) return json(res, 200, nativeAutomationService.detail(id, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }));
    if (resource === "automations" && req.method === "GET" && !id) {
      const native = runtimeConfig.nativeAutomationsMode === "off" ? { automations: [], legacyAutomations: hubStore.listAutomations(), mode: "off" } : nativeAutomationService.list({ homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } });
      return json(res, 200, { schemaVersion: 1, automations: [...native.automations, ...native.legacyAutomations], nativeAutomations: native.automations, legacyAutomations: native.legacyAutomations, triggers: native.triggers || [], actions: native.actions || [], projections: native.projections || [], mode: runtimeConfig.nativeAutomationsMode });
    }
    if (resource === "automations" && req.method === "POST" && !id) {
      const body = await readBody(req);
      const isNative = Number(body.schemaVersion) === 1 || body.trigger?.type === "schedule" || (Array.isArray(body.actions) && body.actions.some((action) => action && (action.controlId || action.control_id)));
      if (isNative) {
        if (runtimeConfig.nativeAutomationsMode !== "enabled") return json(res, 403, { error: { code: "native_automations_read_only", message: "Native automations are read-only on this hub" } });
        return json(res, 201, await nativeAutomationService.create(body, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }, { idempotencyKey: req.headers["idempotency-key"] }));
      }
      return json(res, 201, await hubStore.saveAutomation(body));
    }
    if (resource === "automations" && id && !parts[3] && req.method === "PUT" && hubStore.getNativeAutomation(id)) {
      if (runtimeConfig.nativeAutomationsMode !== "enabled") return json(res, 403, { error: { code: "native_automations_read_only", message: "Native automations are read-only on this hub" } });
      const body = await readBody(req);
      return json(res, 200, await nativeAutomationService.update(id, body, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }, { expectedRevision: body.expectedRevision ?? req.headers["if-match"]?.replace(/^\"|\"$/g, "") }));
    }
    if (resource === "automations" && id && !parts[3] && req.method === "PUT") {
      const existing = hubStore.getAutomation(id);
      if (!existing) return json(res, 404, { error: "Automation not found" });
      return json(res, 200, await hubStore.saveAutomation({ ...existing, ...(await readBody(req)) }, id));
    }
    if (resource === "automations" && id && !parts[3] && req.method === "DELETE" && hubStore.getNativeAutomation(id)) {
      if (runtimeConfig.nativeAutomationsMode !== "enabled") return json(res, 403, { error: { code: "native_automations_read_only", message: "Native automations are read-only on this hub" } });
      const body = await readBody(req);
      const deleted = await nativeAutomationService.remove(id, { homeId: serial, owner: { type: "local_admin", subjectId: "local-admin" } }, { expectedRevision: body.expectedRevision ?? req.headers["if-match"]?.replace(/^\"|\"$/g, "") });
      return json(res, deleted ? 204 : 404, {});
    }
    if (resource === "automations" && id && !parts[3] && req.method === "DELETE") {
      const deleted = await hubStore.deleteAutomation(id);
      return json(res, deleted ? 204 : 404, {});
    }
    if (resource === "events" && req.method === "GET") return json(res, 200, { events: hubStore.listEvents(url.searchParams.get("limit")) });
    if (resource === "backups" && req.method === "POST") {
      try {
        const backupPath = await createBackup({ dataFile: runtimeConfig.dataFile, backupDir: runtimeConfig.backupDir, keyFile: path.join(runtimeConfig.dataDir, "machine.key"), vaultFile: path.join(runtimeConfig.dataDir, "vault.json") });
        await hubStore.addEvent({ type: "backup_created" });
        await activity.record({ type: "backup_created", detail: "A protected hub backup was created." });
        return json(res, 201, { ok: true, path: backupPath });
      } catch (error) {
        await activity.record({ type: "backup_failed", detail: error.message || "The hub backup could not be created." }).catch(() => {});
        throw error;
      }
    }
    if (resource === "integrations" && parts[2] === "refresh" && req.method === "POST") {
      return json(res, 200, { matter: await matter.refresh() });
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "adapters" && req.method === "GET") {
      const detectedAdapters = await serialAdapterLister();
      let settings = hubStore.getZigbee();
      const threadSettings = hubStore.getThread ? hubStore.getThread() : {};
      const detectedPaths = new Set(detectedAdapters.map((adapter) => String(adapter.path || "")));
      // Keep the removal marker for an adapter supplied through the legacy
      // environment fallback. Otherwise an unplugged adapter would be
      // immediately selected again from ZIGBEE_ADAPTER_PATH after removal.
      const removedAdapterPaths = (Array.isArray(settings.removedAdapterPaths) ? settings.removedAdapterPaths : []).filter((adapterPath) => detectedPaths.has(adapterPath) || adapterPath === runtimeConfig.zigbeeAdapterPath);
      if (removedAdapterPaths.length !== (settings.removedAdapterPaths || []).length) settings = await hubStore.saveZigbee({ removedAdapterPaths });
      const threadPath = threadSettings.rcpDevice || runtimeConfig.threadRcpDevice || "";
      // A physically connected adapter must stay visible after removal so the
      // dashboard can offer the same dongle again. The removal marker only
      // suppresses automatic selection of the legacy environment fallback.
      const adapters = detectedAdapters.filter((adapter) => String(adapter.path || "") !== threadPath);
      const removed = new Set(removedAdapterPaths);
      const selectedPath = settings.adapterPath || (runtimeConfig.zigbeeAdapterPath && !removed.has(runtimeConfig.zigbeeAdapterPath) ? runtimeConfig.zigbeeAdapterPath : "");
      const selectedAdapter = adapters.find((adapter) => adapter.path === selectedPath);
      return json(res, 200, {
        adapters,
        selected: selectedAdapter || (selectedPath ? { path: selectedPath, name: settings.adapterName || "Configured adapter", connected: false } : null),
        runtimePath: selectedAdapter?.target || null,
      });
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "probe" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await serialAdapterProbe(body.path));
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "adapter" && req.method === "POST") {
      const body = await readBody(req);
      const currentConfigurationPath = path.join(runtimeConfig.dataDir || path.dirname(runtimeConfig.dataFile), "zigbee2mqtt", "configuration.yaml");
      const previousConfiguration = await fs.promises.readFile(currentConfigurationPath, "utf8").catch(() => "");
      const adapters = await serialAdapterLister();
      const selected = adapters.find((adapter) => adapter.path === String(body.path || ""));
      if (!selected) return json(res, 400, { error: "Choose a connected adapter from the detected list" });
      if (!selected.supported) return json(res, 400, { error: selected.reason || "This adapter is not supported" });
      const settings = await hubStore.saveZigbee({ adapterPath: selected.path, adapterName: selected.name, adapterType: selected.adapterType, recommended: selected.recommended, discoveryPrefix: runtimeConfig.zigbeeDiscoveryPrefix });
      await hubStore.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
      const configurationPath = await writeZigbee2MqttConfiguration({ dataDir: runtimeConfig.dataDir || path.dirname(runtimeConfig.dataFile), settings, mqttUrl: runtimeConfig.mqttUrl || "mqtt://mosquitto:1883", baseTopic: runtimeConfig.zigbeeBaseTopic, discoveryPrefix: runtimeConfig.zigbeeDiscoveryPrefix });
      const service = runtimeConfig.zigbeeAutoRestart ? await zigbeeRuntime.applyConfiguration({ configurationPath, previousContents: previousConfiguration }) : { ok: true, skipped: true, reason: "auto_restart_disabled", restartRequired: true };
      if (service.rolledBack) return json(res, 502, { error: "Zigbee2MQTT could not start with this coordinator; the previous configuration was restored", service });
      if (service.ok === false && !service.skipped) return json(res, 502, { error: service.error || "Zigbee2MQTT could not be restarted", service });
      await activity.record({ type: "radio_connected", detail: `${selected.name || selected.path} is assigned as the Zigbee coordinator.`, change: { radio: "zigbee", path: selected.path, model: selected.name || null } });
      await hubStore.addEvent({ type: "zigbee_adapter_selected", adapterPath: selected.path });
      return json(res, 200, { ok: true, selected, settings, configurationPath, service, runtimePath: selected.target || null, restartRequired: Boolean(service.restartRequired) });
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "adapter" && req.method === "DELETE") {
      const body = await readBody(req);
      const settings = hubStore.getZigbee();
      const requestedPath = String(body.path || "").trim();
      const configuredPath = settings.adapterPath || runtimeConfig.zigbeeAdapterPath || "";
      const targetPath = requestedPath || configuredPath;
      if (!targetPath) return json(res, 404, { error: "No Zigbee dongle is configured or selected" });
      const selected = targetPath === configuredPath;
      if (!selected) {
        const adapters = await serialAdapterLister();
        if (!adapters.some((adapter) => String(adapter.path || "") === targetPath)) return json(res, 404, { error: "The requested Zigbee dongle is not connected" });
      }
      let service = { ok: true, skipped: false, state: "not-selected" };
      if (selected) {
        service = typeof zigbeeRuntime.remove === "function" ? await zigbeeRuntime.remove() : { ok: false, error: "Zigbee service removal is unavailable" };
        if (service.skipped) return json(res, 503, { error: "Docker Compose is unavailable; the Zigbee dongle remains configured", service });
        if (service.ok === false) return json(res, 502, { error: service.error || "Zigbee2MQTT could not be stopped", service });
      }
      const dataDirectory = runtimeConfig.dataDir || path.dirname(runtimeConfig.dataFile);
      const configurationPath = path.join(dataDirectory, "zigbee2mqtt", "configuration.yaml");
      const archivedConfigurationPath = `${configurationPath}.removed-${Date.now()}`;
      let archived = null;
      if (selected) {
        try {
          await fs.promises.rename(configurationPath, archivedConfigurationPath);
          archived = archivedConfigurationPath;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const removedPath = targetPath;
      // Pass the requested path explicitly. This matters when the dongle is
      // already unplugged or the selection came from the environment rather
      // than the persisted store record.
      const cleared = selected ? await hubStore.clearZigbee(removedPath) : await hubStore.markZigbeeAdapterRemoved(removedPath);
      await activity.record({ type: "radio_disconnected", detail: `${settings.adapterName || removedPath} was removed from the Zigbee coordinator role.`, change: { radio: "zigbee", path: removedPath } });
      await hubStore.addEvent({ type: "zigbee_adapter_removed", adapterPath: removedPath });
      return json(res, 200, { ok: true, removed: { path: removedPath, name: selected ? settings.adapterName || "Zigbee dongle" : "Zigbee dongle" }, settings: cleared, service, archivedConfigurationPath: archived, rescanAvailable: true, message: selected ? "The Zigbee dongle was removed. Household devices and their assignments were kept; the connected dongle is available to add again." : "The Zigbee dongle was removed from the selected role and is available to add again." });
    }
    if (resource === "integrations" && parts[2] === "thread" && parts[3] === "adapters" && req.method === "GET") {
      const detectedAdapters = await serialAdapterLister();
      const zigbeeSettings = hubStore.getZigbee();
      const threadSettings = hubStore.getThread ? hubStore.getThread() : {};
      const zigbeePath = zigbeeSettings.adapterPath || runtimeConfig.zigbeeAdapterPath || "";
      const adapters = detectedAdapters.filter((adapter) => String(adapter.path || "") !== zigbeePath);
      const selectedPath = threadSettings.rcpDevice || runtimeConfig.threadRcpDevice || "";
      return json(res, 200, {
        adapters,
        selected: adapters.find((adapter) => adapter.path === selectedPath) || (selectedPath ? { path: selectedPath, name: threadSettings.rcpName || "Configured Thread RCP", connected: false, supported: true } : null),
        baudRate: threadSettings.baudRate || runtimeConfig.threadRcpBaudRate,
        infraIf: threadSettings.infraIf || runtimeConfig.otInfraIf,
        threadIf: threadSettings.threadIf || runtimeConfig.otThreadIf,
      });
    }
    if (resource === "integrations" && parts[2] === "thread" && parts[3] === "adapter" && req.method === "POST") {
      const body = await readBody(req);
      const requestedPath = String(body.path || "").trim();
      if (!requestedPath) return json(res, 400, { error: "Choose the connected OpenThread RCP from the detected list" });
      const adapters = await serialAdapterLister();
      const selected = adapters.find((adapter) => String(adapter.path || "") === requestedPath);
      if (!selected) return json(res, 400, { error: "Choose a connected Thread RCP from the detected list" });
      const zigbeeSettings = hubStore.getZigbee();
      const zigbeePath = zigbeeSettings.adapterPath || runtimeConfig.zigbeeAdapterPath || "";
      if (requestedPath === zigbeePath) return json(res, 409, { error: "The Zigbee coordinator and Thread RCP must use different dongles" });
      const settings = await hubStore.saveThread({ configured: true, rcpDevice: requestedPath, rcpName: selected.name, baudRate: 460800, infraIf: runtimeConfig.otInfraIf, threadIf: runtimeConfig.otThreadIf });
      const service = await threadRuntime.start({ rcpDevice: settings.rcpDevice, baudRate: settings.baudRate, infraIf: settings.infraIf, threadIf: settings.threadIf });
      if (service.skipped) return json(res, 503, { error: "Docker is unavailable; the Thread RCP was saved but OTBR was not started", service });
      if (service.ok === false) return json(res, 502, { error: service.error || "OpenThread Border Router could not be started", service });
      if (!runtimeConfig.matterServerUrl && typeof matter.setUrl === "function") matter.setUrl("ws://127.0.0.1:5580/ws");
      await hubStore.saveConfigEntry({ entry_id: "ce_thread", domain: "thread", title: "OpenThread Border Router" });
      await activity.record({ type: "radio_connected", detail: `${selected.name || requestedPath} is assigned as the Thread Border Router RCP.`, change: { radio: "thread", path: requestedPath, model: selected.name || null } });
      await hubStore.addEvent({ type: "thread_rcp_selected", rcpDevice: requestedPath });
      return json(res, 200, { ok: true, selected, settings, service, baudRate: settings.baudRate, hardwareFlowControl: false, message: "OpenThread Border Router is starting with the selected Thread RCP." });
    }
    if (resource === "integrations" && parts[2] === "thread" && parts[3] === "adapter" && req.method === "DELETE") {
      const settings = hubStore.getThread ? hubStore.getThread() : {};
      const targetPath = String((await readBody(req)).path || settings.rcpDevice || runtimeConfig.threadRcpDevice || "").trim();
      if (!targetPath) return json(res, 404, { error: "No Thread RCP is configured or selected" });
      const service = typeof threadRuntime.remove === "function" ? await threadRuntime.remove() : { ok: false, error: "Thread service removal is unavailable" };
      if (service.skipped) return json(res, 503, { error: "Docker is unavailable; the Thread RCP remains configured", service });
      if (service.ok === false) return json(res, 502, { error: service.error || "OpenThread Border Router could not be stopped", service });
      const cleared = await hubStore.clearThread();
      if (!runtimeConfig.matterServerUrl && typeof matter.setUrl === "function") matter.setUrl("");
      if (hubStore.deleteConfigEntry) await hubStore.deleteConfigEntry("ce_thread");
      await activity.record({ type: "radio_disconnected", detail: `${settings.rcpName || targetPath} was removed from the Thread Border Router role.`, change: { radio: "thread", path: targetPath } });
      await hubStore.addEvent({ type: "thread_rcp_removed", rcpDevice: targetPath });
      return json(res, 200, { ok: true, removed: { path: targetPath, name: settings.rcpName || "Thread RCP" }, settings: cleared, service, rescanAvailable: true, message: "The Thread RCP and OpenThread Border Router configuration were removed; the connected dongle is available to add again." });
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "permit-join" && req.method === "POST") {
      const body = await readBody(req);
      const seconds = body.seconds === undefined ? 254 : body.seconds;
      const result = typeof mqtt.startPairing === "function" ? await mqtt.startPairing(seconds) : (await mqtt.permitJoin(seconds), { seconds: Number(seconds) });
      await activity.record({ type: "pairing_started", detail: `Zigbee pairing was opened for ${Number(seconds) || 254} seconds.`, change: { protocol: "zigbee", seconds: Number(seconds) || 254 } });
      return json(res, 200, { ok: true, pairing: result });
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "pairing" && req.method === "GET") {
      const pairingState = typeof mqtt.pairingStatus === "function" ? mqtt.pairingStatus() : { active: Boolean(mqtt.status().permitJoinUntil) };
      return json(res, 200, { ...pairingState, needsSetup: hubStore.listDevices().filter((device) => ["needs_setup", "interviewing"].includes(device.setup?.status)).map((device) => ({ deviceId: device.id, stage: device.setup?.status || "needs_setup", name: device.name, protocol: device.protocol, manufacturer: device.metadata?.manufacturer || "", model: device.metadata?.model || "", surfacePreview: { count: Object.keys(device.presentation?.surfaces || {}).length, types: Object.values(device.presentation?.surfaces || {}).map((surface) => surface.inferredType || surface.domain) } })) });
    }
    if (resource === "integrations" && parts[2] === "zigbee" && parts[3] === "pairing" && parts[4] === "stop" && req.method === "POST") {
      if (typeof mqtt.stopPairing === "function") await mqtt.stopPairing(); else await mqtt.permitJoin(0);
      await activity.record({ type: "pairing_completed", detail: "Zigbee pairing was closed.", change: { protocol: "zigbee" } });
      return json(res, 200, { ok: true });
    }
    if (resource === "integrations" && parts[2] === "cloudflare" && req.method === "GET") return json(res, 200, cloudflare.status());
    if (resource === "integrations" && parts[2] === "cloudflare" && req.method === "POST") {
      const body = await readBody(req);
      if (body.action === "quick" && runtimeConfig.nodeEnv === "production") return json(res, 410, { error: "Quick tunnels are disabled in production", errorCode: "quick_tunnel_disabled" });
      if (body.action === "quick") return json(res, 200, await cloudflare.startQuick());
      if (body.action === "disconnect") return json(res, 200, await cloudflare.disconnect());
      if (body.action === "setup") {
        if (runtimeConfig.nodeEnv === "production") {
          let reservation;
          try { reservation = await pairing.getCloudflareReservation(); } catch (error) { return json(res, Number(error.statusCode) || 503, { error: "The installation-specific Cloudflare reservation could not be loaded", errorCode: "cloudflare_reservation_unavailable" }); }
          return json(res, 200, await cloudflare.beginSetup({ tunnelName: reservation.reservedTunnelName, hostname: reservation.reservedHostname, reservationToken: reservation.reservationToken }));
        }
        return json(res, 200, await cloudflare.beginSetup({ tunnelName: body.tunnelName, hostname: body.hostname }));
      }
      if (body.action === "reverify") {
        if (runtimeConfig.nodeEnv !== "production") return json(res, 409, { error: "A live reserved Cloudflare tunnel is required for independent verification", errorCode: "cloudflare_reverification_unavailable" });
        const result = cloudflare.status();
        if (result.mode !== "local" || !result.connected || !result.publicUrl || !result.tunnelId || !result.tunnelName || result.hostname !== new URL(result.publicUrl).hostname) return json(res, 409, { error: "The existing reserved Cloudflare tunnel is not connected and ready to verify", errorCode: "cloudflare_tunnel_not_connected" });
        try { return json(res, 200, await reportCloudflareVerification(result, { reverifyChallenge: true })); }
        catch (error) {
          await cloudflare.markPlatformVerification({ state: "PLATFORM_REPORT_FAILED", error: error.message || "Independent Platform CloudURL verification failed" }).catch(() => {});
          throw error;
        }
      }
      if (body.action === "finish") {
        const result = await cloudflare.finishSetup();
        try {
          return json(res, 200, await reportCloudflareVerification(result));
        } catch (error) {
          await cloudflare.markPlatformVerification({ state: "PLATFORM_REPORT_FAILED", error: error.message || "Platform CloudURL verification failed" }).catch(() => {});
          throw error;
        }
      }
      if (body.action === "connect" && runtimeConfig.nodeEnv === "production") return json(res, 410, { error: "Arbitrary Cloudflare tunnel tokens are retired", errorCode: "cloudflare_token_flow_retired" });
      if (body.action === "connect") return json(res, 200, await cloudflare.configure({ token: body.token, hostname: body.hostname }));
      return json(res, 400, { error: "action must be quick, setup, finish, reverify, connect, or disconnect" });
    }
    if (resource === "integrations" && parts[2] === "matter" && parts[3] === "commission" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.code) return json(res, 400, { error: "code is required" });
      try {
        const result = await matterPairing.start(body.code, body.networkOnly);
        await activity.record({ type: "pairing_completed", detail: "Matter commissioning completed.", change: { protocol: "matter" } });
        return json(res, 200, result);
      } catch (error) {
        await activity.record({ type: "pairing_failed", detail: error.message || "Matter commissioning failed.", change: { protocol: "matter" }, reportable: true, incident: { incidentId: "pairing_failed:matter", kind: "pairing_failed", state: "open", revision: 1, details: { protocol: "matter" } } }).catch(() => {});
        throw error;
      }
    }
    if (resource === "integrations" && parts[2] === "matter" && parts[3] === "pairing" && req.method === "GET" && !parts[4]) return json(res, 200, { ...matterPairing.status(), needsSetup: hubStore.listDevices().filter((device) => ["needs_setup", "interviewing"].includes(device.setup?.status)).map((device) => ({ deviceId: device.id, stage: device.setup?.status || "needs_setup", name: device.name, protocol: device.protocol })) });
    if (resource === "integrations" && parts[2] === "matter" && parts[3] === "pairing" && parts[4] && req.method === "GET") return json(res, 200, matterPairing.get(parts[4]) || { error: "Pairing session not found" });
    if (resource === "integrations" && parts[2] === "matter" && parts[3] === "pairing" && parts[4] && parts[5] === "cancel" && req.method === "POST") return json(res, 200, { ok: matterPairing.cancel(parts[4]) });
    if (resource === "integrations" && parts[2] === "matter" && parts[3] === "wifi" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.ssid || !body.credentials) return json(res, 400, { error: "ssid and credentials are required" });
      return json(res, 200, await matter.setWifiCredentials(body.ssid, body.credentials, body.id));
    }
    if (resource === "integrations" && parts[2] === "matter" && parts[3] === "thread" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.dataset) return json(res, 400, { error: "dataset is required" });
      return json(res, 200, await matter.setThreadDataset(body.dataset, body.id));
    }
    return json(res, 404, { error: "Route not found" });
  }

  async function serveStatic(res, url) {
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const root = path.resolve(runtimeConfig.staticDir);
    const filePath = path.resolve(root, requested);
    if (!filePath.startsWith(`${root}${path.sep}`)) return text(res, 403, "Forbidden");
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      res.writeHead(200, { "content-type": contentType(filePath), "cache-control": requested === "index.html" ? "no-cache" : "public, max-age=3600" });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      return text(res, 404, "Not found");
    }
  }

  const dashboardAdminPrefix = "/_dinodia/admin";
  function dashboardApiUrl(url) {
    const rewritten = new URL(url.toString());
    rewritten.pathname = url.pathname.slice(dashboardAdminPrefix.length) || "/";
    return rewritten;
  }
  function isDashboardAdminPath(pathname) {
    return pathname === dashboardAdminPrefix || pathname.startsWith(`${dashboardAdminPrefix}/`);
  }
  function isNativeAppRoute(req, url) {
    return (req.method === "GET" && (url.pathname === "/api/dinodia/v1/snapshot" || url.pathname === "/api/dinodia/v1/areas" || url.pathname === "/api/dinodia/v1/devices" || /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(url.pathname) || url.pathname === "/api/dinodia/v1/control-catalog" || url.pathname === "/api/dinodia/v1/maintenance/status" || /^\/api\/dinodia\/v1\/commands\/[^/]+$/.test(url.pathname)))
      || (req.method === "DELETE" && /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(url.pathname))
      || (req.method === "POST" && (url.pathname === "/api/dinodia/v1/commands" || url.pathname === "/api/dinodia/v1/offline/challenges" || url.pathname === "/api/dinodia/v1/maintenance/update" || url.pathname === "/api/step-up/descriptor-challenge" || /^\/api\/dinodia\/v1\/commissioning\/sessions(?:\/[^/]+(?:\/(?:matter-payload|select|complete|cancel|resume))?)?$/.test(url.pathname)))
      || (req.method === "GET" && /^\/api\/dinodia\/v1\/commissioning\/sessions\/[^/]+$/.test(url.pathname));
  }
  function isHaCompatibilityPath(pathname) {
    return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/_dinodia/zha/") || pathname === "/_dinodia/sync-status";
  }
  function applyDashboardHeaders(res) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-dinodia-token, x-dinodia-step-up-proof, x-dinodia-offline-challenge, x-dinodia-offline-signature, x-dinodia-offline-grant, idempotency-key, if-match");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  }
  function googleNestCallbackAllowed(req) {
    return isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, allowInsecure: runtimeConfig.nodeEnv !== "production", configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "" });
  }

  async function reportCloudflareVerification(result = cloudflare.status(), { reverifyChallenge = false } = {}) {
    if (!result?.publicUrl || !pairing?.reportCloudUrl) throw new Error("The local Cloudflare tunnel is not ready to report to Platform");
    await cloudflare.markPlatformVerification({ state: "PLATFORM_REPORT_PENDING", cloudUrl: result.publicUrl, verificationId: cloudflare.status()?.platformVerification?.verificationId || null });
    let reservationToken = cloudflare.reservationToken();
    if (!reservationToken && runtimeConfig.nodeEnv === "production" && pairing.getCloudflareReservation) {
      const reservation = await pairing.getCloudflareReservation();
      if (String(reservation.reservedHostname || "") !== String(result.hostname || "") || String(reservation.reservedTunnelName || "") !== String(result.tunnelName || "")) throw new Error("The installation Cloudflare reservation does not match the paired tunnel");
      reservationToken = await cloudflare.setReservationToken(reservation.reservationToken);
    }
    const report = await pairing.reportCloudUrl(result.publicUrl, { tunnelId: result.tunnelId, tunnelName: result.tunnelName, hostname: result.hostname, reservationToken, reverifyChallenge });
    return cloudflare.markPlatformVerification({ state: "PLATFORM_VERIFIED", cloudUrl: result.publicUrl, verificationId: report.verificationId || null });
  }

  function localSetupHostAllowed(req) {
    const host = String(req.headers.host || "").split(":")[0].toLowerCase();
    const expected = `dinodia-${String(serial).toLowerCase()}.local`;
    const remote = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    const privateRemote = remote === "127.0.0.1" || remote === "::1" || (() => {
      if (net.isIP(remote) !== 4) return false;
      const octets = remote.split(".").map(Number);
      return octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
    })();
    if (!privateRemote) return false;
    const selectedInterface = privateInterface(runtimeConfig.setupInterfaceName);
    const localAddress = String(req.socket?.localAddress || "").replace(/^::ffff:/, "");
    if (host === expected && (!selectedInterface || localAddress !== selectedInterface.address)) return false;
    if ([expected, "localhost", "127.0.0.1", "::1"].includes(host)) return true;
    // A private-IP Host is accepted only when the TCP peer itself is private;
    // an attacker cannot turn a public request into a setup request by merely
    // changing Host/X-Forwarded-Host.
    if (net.isIP(host) === 4) {
      const octets = host.split(".").map(Number);
      return octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
    }
    return false;
  }

  function setupCookie(req, name) {
    const prefix = `${name}=`;
    const entry = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
  }

  function setupBrowserSessionValid(req) {
    const browser = setupCookie(req, "dinodia_setup_browser");
    const attemptId = setupCookie(req, "dinodia_setup_attempt");
    const browserNonce = setupCookie(req, "dinodia_setup_nonce");
    const csrfCookie = setupCookie(req, "dinodia_setup_csrf");
    const csrfHeader = String(req.headers["x-dinodia-setup-csrf"] || "");
    if (!browser || !attemptId || !browserNonce || !csrfCookie || !csrfHeader || csrfCookie.length !== csrfHeader.length) return false;
    if (!provisioningPairing.matchesBrowserSession({ attemptId, browserNonce, browserId: browser })) return false;
    return crypto.timingSafeEqual(Buffer.from(csrfCookie), Buffer.from(csrfHeader));
  }

  function setupInitialBrowserSessionValid(req) {
    const browser = setupCookie(req, "dinodia_setup_browser");
    const csrfCookie = setupCookie(req, "dinodia_setup_csrf");
    const csrfHeader = String(req.headers["x-dinodia-setup-csrf"] || "");
    if (!browser || !csrfCookie || !csrfHeader || csrfCookie.length !== csrfHeader.length) return false;
    return crypto.timingSafeEqual(Buffer.from(csrfCookie), Buffer.from(csrfHeader));
  }

  async function setupRateLimitAllows(req) {
    const remote = String(req.socket?.remoteAddress || "unknown");
    const key = crypto.createHash("sha256").update(`${serial}:${remote}`, "utf8").digest("hex").slice(0, 48);
    const now = Date.now();
    const security = hubStore.getSecurity?.() || {};
    const existing = security.setupRateLimits?.[key] || { startedAt: now, count: 0 };
    const current = now - Number(existing.startedAt) >= 15 * 60 * 1000 ? { startedAt: now, count: 0 } : existing;
    if (Number(current.count) >= 10) return false;
    await hubStore.saveSecurity({ setupRateLimits: { ...(security.setupRateLimits || {}), [key]: { startedAt: current.startedAt, count: Number(current.count) + 1 } } });
    return true;
  }

  function setupHeaders(res, cookies = []) {
    applyDashboardHeaders(res);
    res.setHeader("cache-control", "no-store, private");
    res.setHeader("pragma", "no-cache");
    res.setHeader("referrer-policy", "no-referrer");
    if (cookies.length) res.setHeader("set-cookie", cookies);
  }

  async function handleLocalSetupRequest(req, res, url) {
    if (!localSetupHostAllowed(req)) return json(res, 404, { error: "Setup page is available only on the private provisioning network" });
    setupHeaders(res);
    if (!["GET", "POST", "DELETE"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
    // Permanent-label Home authority is never resolved over the installer-only
    // serial/port-80 setup channel. The only supported resolver is the pinned
    // publicHubId HTTPS listener below.
    if (url.pathname === "/_dinodia/setup/claim-challenge") return json(res, 404, { error: "Claim resolver is unavailable" });
    if (req.method === "POST") {
      const origin = String(req.headers.origin || "");
      if (origin !== `http://${req.headers.host}`) return json(res, 403, { error: "Setup request origin is not allowed" });
      if (url.pathname === "/_dinodia/setup/pairing" ? !setupInitialBrowserSessionValid(req) : !setupBrowserSessionValid(req)) return json(res, 403, { error: "This setup browser session is not valid" });
      if (!(await setupRateLimitAllows(req))) return json(res, 429, { error: "Too many setup attempts. Wait before trying again." });
    }
    if (url.pathname === "/_dinodia/setup/status" && req.method === "GET") {
      if (!setupInitialBrowserSessionValid(req)) return json(res, 403, { error: "This setup browser session is not valid" });
      return json(res, 200, {
        ok: true,
        locked: true,
        dataEmptyBeforePairing: true,
        identity: { serial },
        pairing: provisioningPairing.status(),
        platformPaired: Boolean(hubStore.getPlatform?.().paired),
      });
    }
    if (url.pathname === "/_dinodia/setup/pairing" && req.method === "POST") {
      if (hubStore.getPlatform?.().paired) return json(res, 409, { error: "This hub is already paired", errorCode: "hub_already_paired" });
      const body = await readBody(req);
      const attemptId = setupCookie(req, "dinodia_setup_attempt") || crypto.randomUUID();
      const browserNonce = crypto.randomBytes(24).toString("base64url");
      let setupBaseUrl = "";
      try { setupBaseUrl = new URL(`http://${String(req.headers.host || "")}`).origin; } catch {}
      if (!setupBaseUrl) return json(res, 400, { error: "The local setup origin is invalid", errorCode: "setup_origin_invalid" });
      const presentation = provisioningPairing.issue({ attemptId, browserNonce, browserId: setupCookie(req, "dinodia_setup_browser"), publicKeyFingerprint: body.publicKeyFingerprint, baseUrl: setupBaseUrl });
      await provisioningPairing.waitForPersistence();
      if (runtimeConfig.nodeEnv === "production" || pairing.loadManufacturingIdentity?.()) {
        try {
          const registration = await pairing.registerProvisioningAttempt({ pairing: presentation, baseUrl: setupBaseUrl });
          await hubStore.saveSetup({ pairing: { ...(hubStore.getSetup?.().pairing || {}), platformAttemptId: registration.attemptId, platformPairingId: registration.pairingId } });
        } catch (error) {
          provisioningPairing.revoke();
          return json(res, Number(error.statusCode) || 503, { error: "The hub could not register its factory identity with Dinodia Platform", errorCode: "manufacturing_registration_failed" });
        }
      }
      setupHeaders(res, [
        `dinodia_setup_attempt=${encodeURIComponent(presentation.attemptId)}; HttpOnly; SameSite=Strict; Path=/_dinodia/setup; Max-Age=900`,
        `dinodia_setup_nonce=${encodeURIComponent(browserNonce)}; HttpOnly; SameSite=Strict; Path=/_dinodia/setup; Max-Age=900`,
      ]);
      const qrSvg = await QRCode.toString(presentation.qrPayload, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      return json(res, 201, { ok: true, expiresAt: presentation.expiresAt, code: presentation.code, qrPayload: presentation.qrPayload, qrSvg });
    }
    if (url.pathname === "/_dinodia/setup/pairing" && req.method === "DELETE") {
      if (!setupBrowserSessionValid(req) || !setupCookie(req, "dinodia_setup_attempt") || !setupCookie(req, "dinodia_setup_nonce")) return json(res, 403, { error: "Setup session is required" });
      provisioningPairing.revoke();
      return json(res, 204, {});
    }
    if (url.pathname === "/setup" && req.method === "GET") {
      const browser = setupCookie(req, "dinodia_setup_browser") || crypto.randomBytes(24).toString("base64url");
      const csrf = setupCookie(req, "dinodia_setup_csrf") || crypto.randomBytes(24).toString("base64url");
      const operatorBinding = setupCookie(req, "dinodia_operator_binding") || crypto.randomBytes(32).toString("base64url");
      const operatorAttempt = setupCookie(req, "dinodia_operator_attempt") || crypto.randomBytes(32).toString("base64url");
      const filePath = path.resolve(runtimeConfig.staticDir, "setup.html");
      const markup = await fs.promises.readFile(filePath, "utf8").catch(() => null);
      if (markup === null) return text(res, 404, "Not found");
      setupHeaders(res, [
        `dinodia_setup_browser=${encodeURIComponent(browser)}; HttpOnly; SameSite=Strict; Path=/_dinodia/setup; Max-Age=900`,
        `dinodia_setup_csrf=${encodeURIComponent(csrf)}; SameSite=Strict; Path=/; Max-Age=900`,
        `dinodia_operator_binding=${encodeURIComponent(operatorBinding)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`,
        `dinodia_operator_attempt=${encodeURIComponent(operatorAttempt)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`,
      ]);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private" });
      return res.end(markup);
    }
    return json(res, 404, { error: "Setup route not found" });
  }

  async function handleSetupScriptRequest(req, res) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    if (!local && !remote) return json(res, 404, { error: "Setup assets are available only on the paired setup network or secure Dinodia Cloud endpoint" });
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const filePath = path.resolve(runtimeConfig.staticDir, "setup.js");
    const script = await fs.promises.readFile(filePath, "utf8").catch(() => null);
    if (script === null) return text(res, 404, "Not found");
    setupHeaders(res);
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store, private" });
    return res.end(script);
  }

  async function revokeSupportLease(lease) {
    if (!lease?.sessionId || !lease?.lease) return false;
    try {
      await pairing.requestWithHubIdentity("/api/hub-agent/support/v2/revocation", { serial, sessionId: String(lease.sessionId), lease: String(lease.lease) });
      return true;
    } catch (error) {
      logger.warn(`[support] hub revocation acknowledgement pending: ${error.message}`);
      return false;
    }
  }

  async function handleSupportAccessRequest(req, res) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    if (!local && !remote) return json(res, 404, { error: "Support access is available only on the private setup network or secure Dinodia Cloud endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const expectedProtocol = remote ? "https" : "http";
    if (String(req.headers.origin || "") !== `${expectedProtocol}://${req.headers.host}`) return json(res, 403, { error: "Support access origin is not allowed" });
    if (local && !setupBrowserSessionValid(req)) return json(res, 403, { error: "This setup browser session is not valid" });
    const body = await readBody(req);
    const action = String(body.action || "").trim().toLowerCase();
    if (action === "redeem") {
      const ticketId = String(body.ticketId || "").trim();
      const code = String(body.code || "").trim();
      if (!ticketId || !code || ticketId.length > 256 || code.length > 512) return json(res, 400, { error: "A support ticket and one-use code are required" });
      let result;
      try {
        const proof = await pairing.requestWithHubIdentity("/api/hub-agent/support/v2/proof", { serial, ticketId });
        const proofEnvelope = String(proof?.employeeProofEnvelope || "");
        const proofRequestId = String(proof?.requestId || "");
        const proofIdentityGeneration = Number(proof?.identityGeneration || 0);
        if (!proofEnvelope || proofEnvelope.length > 12000 || !/^[0-9a-f-]{36}$/i.test(proofRequestId) || !Number.isInteger(proofIdentityGeneration) || proofIdentityGeneration < 1) throw Object.assign(new Error("The employee proof was not delivered to the hub"), { statusCode: 401, code: "support_proof_unavailable" });
        const decryptedProofPayload = await pairing.decryptCredentialDelivery({ version: 1, envelope: JSON.parse(proofEnvelope) }, "support-session");
        let proofPayload;
        try { proofPayload = JSON.parse(decryptedProofPayload); } catch { proofPayload = null; }
        if (proofPayload?.version !== 2 || typeof proofPayload.employeeGrant !== "string" || typeof proofPayload.employeeProofPrivateKey !== "string") throw Object.assign(new Error("The employee proof payload is invalid"), { statusCode: 401, code: "support_proof_invalid" });
        const proofToken = proofPayload.employeeGrant;
        const proofPrincipal = verifyOperatorSessionToken(proofToken, { publicKey: operatorPublicKey, hubId: serial, requiredScope: "support:redeem", requireRecentAuth: true });
        if (!proofPrincipal || String(proofPrincipal.requestId || "") !== proofRequestId || !proofPrincipal.homeId || Number(proofPrincipal.identityGeneration) !== proofIdentityGeneration) throw Object.assign(new Error("The employee proof is not valid for this hub request"), { statusCode: 401, code: "support_proof_invalid" });
        const codeHash = crypto.createHash("sha256").update(code, "utf8").digest("hex");
        const proofContext = {
          serial,
          ticketId,
          requestId: proofRequestId,
          employeeId: String(proofPrincipal.sub),
          homeId: String(proofPrincipal.homeId),
          codeHash,
          identityGeneration: proofIdentityGeneration,
          nonce: crypto.randomBytes(24).toString("base64url"),
          proofExpiresAt: Number(proofPrincipal.exp),
        };
        const possession = createSupportProofOfPossession({ ...proofContext, privateKeyPem: proofPayload.employeeProofPrivateKey });
        proofPayload.employeeProofPrivateKey = "";
        result = await pairing.requestWithHubIdentity("/api/hub-agent/support/v2/redeem", {
          serial, ticketId, requestId: proofRequestId, identityGeneration: proofIdentityGeneration,
          employeeId: proofContext.employeeId, homeId: proofContext.homeId, code,
          nonce: proofContext.nonce, proofExpiresAt: proofContext.proofExpiresAt,
          requestBodyDigest: possession.requestBodyDigest, employeeProofSignature: possession.signature,
        });
      } catch (error) {
        return json(res, Number(error.statusCode) || 502, { error: "The support code was not accepted", errorCode: error.code || "support_redeem_rejected" });
      }
      if (!result?.lease || !result.sessionId || !result.expiresAt) return json(res, 502, { error: "The Platform did not issue a support lease" });
      const session = { sessionId: String(result.sessionId), lease: String(result.lease), scope: String(result.scope || ""), areaIds: Array.isArray(result.areaIds) ? result.areaIds.map(String) : [], targetMembershipId: result.targetMembershipId == null ? null : String(result.targetMembershipId), targetUserId: result.targetUserId == null ? null : String(result.targetUserId), includesTenantDevices: result.includesTenantDevices === true, expiresAt: new Date(result.expiresAt).getTime() };
      const issued = issueSupportBrowserSession(session, remote);
      const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
      setTimeout(() => revokeSupportLease(session).finally(() => supportBrowserSessions.delete(issued.handle)), Math.max(1, session.expiresAt - Date.now())).unref?.();
      setupHeaders(res, [`dinodia_os_support_session=${encodeURIComponent(issued.handle)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${remote ? "; Secure" : ""}`]);
      return json(res, 200, { ok: true, expiresAt: new Date(session.expiresAt).toISOString(), scope: session.scope, areaCount: session.areaIds.length });
    }
    if (action === "revoke") {
      const prefix = "dinodia_os_support_session=";
      const entry = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
      const handle = entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
      const session = supportBrowserSessions.get(handle);
      if (!session) return json(res, 404, { error: "No active support session" });
      await revokeSupportLease(session);
      supportBrowserSessions.delete(handle);
      setupHeaders(res, [`dinodia_os_support_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${remote ? "; Secure" : ""}`]);
      return json(res, 200, { ok: true, message: "Support access revoked" });
    }
    return json(res, 400, { error: "Support access action must be redeem or revoke" });
  }

  async function currentPermanentInstallationPrincipal(req) {
    const cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("dinodia_os_operator_session="));
    const handle = cookie ? decodeURIComponent(cookie.slice("dinodia_os_operator_session=".length)) : "";
    const session = operatorBrowserSessions.get(handle);
    if (!session || !session.handoffId || !session.jti || revokedOperatorJtis.has(String(session.jti)) || operatorNow() >= Number(session.expiresAt || 0)) return null;
    const principal = operatorSessionAuth(session.token);
    if (!principal || principal.scope.length !== 1 || principal.scope[0] !== "os:permanent-installation") return null;
    try {
      const result = await pairing.requestWithHubIdentity("/api/hub-agent/operator-session/revalidate", { handoffId: session.handoffId, jti: session.jti, credentialVersion: session.credentialVersion });
      if (result?.active !== true) {
        await revokeLocalOperatorSession(session, "operator_installation_authority_changed");
        return null;
      }
      session.lastAuthorizationCheckAt = operatorNow();
      return operatorSessionAuth(session.token);
    } catch {
      // An installer mutation must have a fresh Platform authorization result;
      // unlike a dashboard session, an old successful check is not sufficient.
      return null;
    }
  }

  function operatorRequestTransportAllowed(req) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    const tlsReport = lanTlsIdentity?.publicReport?.() || null;
    const expectedLanHost = tlsReport?.state === "CURRENT" ? `${String(tlsReport.host || "").toLowerCase()}:${lanListenerPort}` : "";
    const directLanTls = isTrustedOfflineLanTransport(req)
      && Boolean(expectedLanHost)
      && String(req.headers.host || "").toLowerCase() === expectedLanHost
      && Number(req.socket?.localPort) === lanListenerPort
      && Boolean(physicalLanAddress)
      && String(req.socket?.localAddress || "").replace(/^::ffff:/, "") === String(physicalLanAddress).replace(/^::ffff:/, "")
      && isPrivateLanRequest(req);
    if (!local && !remote && !directLanTls) return null;
    const expectedProtocol = remote || directLanTls ? "https" : "http";
    if (req.headers.origin && String(req.headers.origin) !== `${expectedProtocol}://${req.headers.host}`) return null;
    // Forwarded headers are trusted only on the already authenticated local
    // Cloudflare connector path. A LAN/browser client cannot manufacture a
    // secure CloudURL origin by adding them to an HTTP request.
    if (!remote && (req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"])) return null;
    return { local, remote, directLanTls, expectedProtocol };
  }

  async function handlePermanentInstallationCommissioning(req, res, url) {
    const transport = operatorRequestTransportAllowed(req);
    if (!transport) return nativeContractError(res, 404, "SCOPE_DENIED", "The assigned installation workspace is unavailable on this endpoint");
    if (req.method !== "GET" && req.method !== "POST") return nativeContractError(res, 405, "METHOD_NOT_ALLOWED", "The commissioning method is not allowed");
    if (req.method === "POST" && (String(req.headers.origin || "") !== `${transport.expectedProtocol}://${req.headers.host}` || !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")
      || String(req.headers["x-dinodia-setup-csrf"] || "") !== setupCookie(req, "dinodia_setup_csrf"))) return nativeContractError(res, 403, "AUTH_REQUIRED", "The assigned installation browser context is not valid");
    const pathMatch = url.pathname.match(/^\/_dinodia\/installer\/commissioning(?:\/sessions(?:\/([^/]+)(?:\/(matter-payload|select|complete|cancel|resume))?)?)?$/);
    if (!pathMatch) return nativeContractError(res, 404, "RESOURCE_NOT_FOUND", "The commissioning route is unavailable");
    const sessionId = pathMatch[1] ? decodeURIComponent(pathMatch[1]) : "";
    const action = pathMatch[2] || "";
    // Matter setup codes are network credentials. Never accept them over the
    // physical installer HTTP listener, even for an otherwise valid staff
    // handoff. The approved CloudURL or current pinned LAN TLS listener is
    // required before a request body is read.
    if (req.method === "POST" && action === "matter-payload" && !transport.remote && !transport.directLanTls) {
      return nativeContractError(res, 403, "SECURE_TRANSPORT_REQUIRED", "Matter setup codes require the verified secure hub connection");
    }
    const principal = await currentPermanentInstallationPrincipal(req);
    if (!principal) return nativeContractError(res, 401, "AUTH_REQUIRED", "The assigned work or Company Portal session expired. Close this window and reopen the work from Company Portal.");
    try {
      if (req.method === "GET" && !sessionId && !action) {
        return json(res, 200, { schemaVersion: "dinodia.v1", requestId: principal.requestId, workflowId: principal.workflow,
          areas: (Array.isArray(principal.areaOptions) ? principal.areaOptions : []).map((area) => ({ id: area.id, name: area.name })),
          protocols: {
            zigbee: { enabled: runtimeConfig.nativeCommissioningCapabilities.nativeZigbeeCommissioningV1 === true, adapterReady: mqtt.status().connected === true && Boolean(hubStore.getZigbee?.().adapterPath) },
            matter: { enabled: runtimeConfig.nativeCommissioningCapabilities.nativeMatterCommissioningV1 === true, adapterReady: matter.status().connected === true && hubStore.getThread?.().configured === true },
          } }, { "Cache-Control": "no-store" });
      }
      if (!nativeCommissioningService) return nativeContractError(res, 503, "HUB_UNAVAILABLE", "The hub commissioning service is unavailable", true);
      if (req.method === "POST" && !sessionId && !action) {
        const body = await readBody(req, 4096);
        if (Object.keys(body).sort().join("\n") !== "protocol\nschemaVersion" || body.schemaVersion !== "dinodia.v1") return nativeContractError(res, 400, "VALIDATION_FAILED", "The commissioning request is invalid");
        return json(res, 201, await nativeCommissioningService.start(principal, { protocol: body.protocol }, String(req.headers["idempotency-key"] || "")), { "Cache-Control": "no-store" });
      }
      if (req.method === "GET" && sessionId && !action) {
        const after = Number(url.searchParams.get("after") || 0);
        const candidateAfter = url.searchParams.get("candidateAfter") || null;
        if (!Number.isSafeInteger(after) || after < 0 || candidateAfter !== null && !/^[0-9a-f-]{36}$/i.test(candidateAfter)) return nativeContractError(res, 400, "VALIDATION_FAILED", "The commissioning cursor is invalid");
        return json(res, 200, await nativeCommissioningService.status(sessionId, principal, after, candidateAfter), { "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && sessionId && action) {
        const body = await readBody(req, 4096);
        if (action === "matter-payload") {
          if (Object.keys(body).sort().join("\n") !== "schemaVersion\nsetupPayload" || body.schemaVersion !== "dinodia.v1") return nativeContractError(res, 400, "VALIDATION_FAILED", "The Matter setup payload request is invalid");
          return json(res, 202, await nativeCommissioningService.matterPayload(sessionId, principal, body.setupPayload), { "Cache-Control": "no-store" });
        }
        if (action === "select") return json(res, 200, await nativeCommissioningService.select(sessionId, principal, body), { "Cache-Control": "no-store" });
        if (["complete", "cancel", "resume"].includes(action)) {
          const expected = action === "complete" ? "disposition\nschemaVersion" : "schemaVersion";
          if (Object.keys(body).sort().join("\n") !== expected || body.schemaVersion !== "dinodia.v1") return nativeContractError(res, 400, "VALIDATION_FAILED", "The commissioning action request is invalid");
          const result = action === "complete" ? await nativeCommissioningService.complete(sessionId, principal, String(body.disposition))
            : action === "cancel" ? await nativeCommissioningService.cancel(sessionId, principal) : await nativeCommissioningService.resume(sessionId, principal);
          return json(res, 200, result, { "Cache-Control": "no-store" });
        }
      }
      return nativeContractError(res, 405, "METHOD_NOT_ALLOWED", "The commissioning method is not allowed");
    } catch (error) {
      const status = Number(error?.statusCode) || 503;
      const code = /^[a-z0-9_]{1,64}$/i.test(String(error?.code || "")) ? String(error.code).toUpperCase() : "COMMISSIONING_UNAVAILABLE";
      return nativeContractError(res, status, code, status >= 500 ? "The commissioning service is temporarily unavailable" : String(error.message || "The commissioning request was rejected"), status >= 500);
    }
  }

  async function handlePermanentInstallationPage(req, res) {
    const transport = operatorRequestTransportAllowed(req);
    if (!transport) return text(res, 404, "Not found");
    if (req.method !== "GET") return text(res, 405, "Method not allowed");
    const principal = await currentPermanentInstallationPrincipal(req);
    if (!principal) return handleRemoteSupportPage(req, res);
    const asset = req.url?.split("?")[0] === "/permanent-installation.js";
    const filePath = path.resolve(runtimeConfig.staticDir, asset ? "permanent-installation.js" : "permanent-installation.html");
    const content = await fs.promises.readFile(filePath, "utf8").catch(() => null);
    if (content === null) return text(res, 404, "Not found");
    setupHeaders(res);
    res.writeHead(200, { "content-type": asset ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store, private", "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    return res.end(content);
  }

  async function handleRemoteSupportPage(req, res) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    if (!local && !remote) return text(res, 404, "Not found");
    if (req.method !== "GET") return text(res, 405, "Method not allowed");
    const filePath = path.resolve(runtimeConfig.staticDir, "setup.html");
    const markup = await fs.promises.readFile(filePath, "utf8").catch(() => null);
    if (markup === null) return text(res, 404, "Not found");
    const browser = crypto.randomBytes(24).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    const operatorBinding = crypto.randomBytes(32).toString("base64url");
    const operatorAttempt = crypto.randomBytes(32).toString("base64url");
    setupHeaders(res, [
      `dinodia_setup_browser=${encodeURIComponent(browser)}; HttpOnly; SameSite=Strict; Path=/_dinodia/setup; Max-Age=900${remote ? "; Secure" : ""}`,
      `dinodia_setup_csrf=${encodeURIComponent(csrf)}; SameSite=Strict; Path=/; Max-Age=900${remote ? "; Secure" : ""}`,
      `dinodia_operator_binding=${encodeURIComponent(operatorBinding)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900${remote ? "; Secure" : ""}`,
      `dinodia_operator_attempt=${encodeURIComponent(operatorAttempt)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900${remote ? "; Secure" : ""}`,
    ]);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private" });
    return res.end(markup);
  }

  async function handleOperatorAttemptRegistration(req, res) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    if (!local && !remote) return json(res, 404, { error: "Operator setup is available only on the paired local or secure Cloudflare endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const expectedProtocol = remote ? "https" : "http";
    if (String(req.headers.origin || "") !== `${expectedProtocol}://${req.headers.host}`) return json(res, 403, { error: "Operator setup origin is not allowed" });
    if (!setupInitialBrowserSessionValid(req)) return json(res, 403, { error: "This setup browser session is not valid" });
    const binding = setupCookie(req, "dinodia_operator_binding");
    const attemptId = setupCookie(req, "dinodia_operator_attempt");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(binding) || !/^[A-Za-z0-9_-]{32,160}$/.test(attemptId)) return json(res, 400, { error: "A hub-created operator browser attempt is required" });
    try {
      const operatorOrigin = `${remote ? "https" : "http"}://${req.headers.host}`;
      const result = await pairing.requestWithHubIdentity("/api/hub-agent/operator-session/attempt", {
        setupAttemptId: attemptId,
        browserBindingHash: crypto.createHash("sha256").update(binding, "utf8").digest("hex"),
        accessMode: remote ? "secure" : "local",
        operatorOrigin,
      });
      return json(res, 200, { ok: true, setupAttemptId: result.setupAttemptId, expiresAt: result.expiresAt });
    } catch (error) {
      return json(res, Number(error.statusCode) || 503, { error: "The hub could not register this operator browser", errorCode: error.code || "operator_browser_registration_failed" });
    }
  }

  function operatorHandoffJobKey(setupAttemptId, browserBinding) {
    return crypto.createHash("sha256").update(`${setupAttemptId}\0${browserBinding}`, "utf8").digest("hex");
  }

  function pruneOperatorHandoffJobs() {
    const now = operatorNow();
    for (const [key, job] of operatorHandoffJobs) {
      if (now >= job.retainUntil) operatorHandoffJobs.delete(key);
    }
    if (operatorHandoffJobs.size >= 128) {
      const terminal = [...operatorHandoffJobs].find(([, job]) => job.state !== "pending");
      if (terminal) operatorHandoffJobs.delete(terminal[0]);
    }
    return operatorHandoffJobs.size < 128;
  }

  function respondOperatorHandoffJob(res, job) {
    if (job.state === "pending") {
      return json(res, 202, { ok: true, state: "pending", correlationId: job.correlationId, handoffPhase: job.phase });
    }
    if (job.state === "failed") {
      return json(res, job.statusCode || 502, {
        ok: false,
        error: "The secure Dinodia OS operator handoff could not be completed. Close this window and relaunch from Company Portal.",
        errorCode: job.errorCode || "operator_handoff_rejected",
        handoffPhase: job.phase || "hub",
        correlationId: job.correlationId,
      });
    }
    if (!job.sessionHandle || !Number.isFinite(job.expiresAt) || operatorNow() >= job.expiresAt) {
      job.state = "failed";
      job.phase = "hub";
      job.errorCode = "operator_session_expired";
      job.statusCode = 401;
      return respondOperatorHandoffJob(res, job);
    }
    const sessionMaxAge = Math.max(1, Math.min(Math.ceil((job.expiresAt - operatorNow()) / 1000), runtimeConfig.stage1InternalOperatorDaySession === true ? 86_400 : 900));
    setupHeaders(res, [
      `dinodia_os_operator_session=${encodeURIComponent(job.sessionHandle)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAge}${job.remote ? "; Secure" : ""}`,
      "dinodia_os_operator=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "dinodia_operator_binding=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "dinodia_operator_attempt=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    ]);
    return json(res, 200, { ok: true, state: "established", expiresAt: new Date(job.expiresAt).toISOString(), serial, correlationId: job.correlationId,
      destination: job.operatorScope === "os:permanent-installation" ? "/permanent-installation" : "/" });
  }

  async function runOperatorHandoffJob(job) {
    let handoffSecret = null;
    let operatorToken = null;
    const operatorPlatformRequest = async (requestBody) => {
      const timestamp = Date.now();
      const nonce = crypto.randomBytes(24).toString("base64url");
      const identity = await pairing.getPublicIdentity();
      if (!identity?.generation) throw Object.assign(new Error("identity unavailable"), { safeCode: "hub_identity_unavailable" });
      const signedBody = { serial, identityGeneration: Number(identity.generation), ...requestBody };
      const bodyHash = crypto.createHash("sha256").update(JSON.stringify(signedBody), "utf8").digest("hex");
      const platform = pairing.store?.getPlatform?.() || {};
      const machineCredential = pairing.vault?.get?.("platform.machineCredential");
      const machineVersion = Number(platform.provisioningCredentialVersion || 0);
      if (!machineCredential || !Number.isInteger(machineVersion) || machineVersion < 1) throw Object.assign(new Error("machine credential unavailable"), { safeCode: "machine_credential_unavailable" });
      const machineSignature = crypto.createHmac("sha256", crypto.createHash("sha256").update(String(machineCredential), "utf8").digest("hex")).update(["POST", "/api/hub-agent/operator-session/consume", String(timestamp), nonce, bodyHash].join("\n"), "utf8").digest("base64url");
      const platformOrigin = String(pairing.apiUrl || runtimeConfig.platformApiUrl || "").replace(/\/$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        return await fetch(`${platformOrigin}/api/hub-agent/operator-session/consume`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "x-dinodia-hub-timestamp": String(timestamp), "x-dinodia-hub-nonce": nonce, "x-dinodia-body-sha256": bodyHash, "x-dinodia-machine-version": String(machineVersion), "x-dinodia-machine-signature": machineSignature },
          body: JSON.stringify(signedBody),
          signal: controller.signal,
        });
      } finally { clearTimeout(timer); }
    };
    const readPlatformJson = async (response, phase) => {
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("application/json")) throw Object.assign(new Error("non-json platform response"), { safeCode: "platform_non_json_response", phase, statusCode: 502 });
      let body;
      try { body = await response.json(); }
      catch { throw Object.assign(new Error("invalid platform response"), { safeCode: "platform_invalid_response", phase, statusCode: 502 }); }
      if (!response.ok) {
        const candidate = String(body?.errorCode || "operator_handoff_rejected");
        throw Object.assign(new Error("platform rejected handoff"), { safeCode: /^[a-z0-9_]{1,64}$/.test(candidate) ? candidate : "operator_handoff_rejected", phase, statusCode: response.status || 502 });
      }
      return body;
    };
    try {
      if (operatorNow() >= job.deadlineAt) throw Object.assign(new Error("handoff expired"), { safeCode: "operator_handoff_expired", phase: "prepare", statusCode: 401 });
      job.phase = "prepare";
      let response = await operatorPlatformRequest({ handoffId: job.handoffId, browserBinding: job.browserBinding, setupAttemptId: job.setupAttemptId, serial, phase: "prepare" });
      const prepared = await readPlatformJson(response, "prepare");
      if (!prepared.handoffSecretEnvelope) throw Object.assign(new Error("prepare envelope missing"), { safeCode: "operator_handoff_prepare_incomplete", phase: "prepare", statusCode: 502 });
      try { handoffSecret = await pairing.decryptCredentialDelivery({ version: 1, envelope: JSON.parse(String(prepared.handoffSecretEnvelope)) }, "operator-handoff"); }
      catch { throw Object.assign(new Error("handoff envelope rejected"), { safeCode: "operator_handoff_delivery_failed", phase: "prepare", statusCode: 502 }); }
      if (operatorNow() >= job.deadlineAt) throw Object.assign(new Error("handoff expired"), { safeCode: "operator_handoff_expired", phase: "consume", statusCode: 401 });
      job.phase = "consume";
      response = await operatorPlatformRequest({ handoffId: job.handoffId, browserBinding: job.browserBinding, setupAttemptId: job.setupAttemptId, serial, phase: "consume", handoffSecret });
      const consumed = await readPlatformJson(response, "consume");
      if (!consumed.sessionGrant?.envelope) throw Object.assign(new Error("session grant missing"), { safeCode: "operator_session_grant_missing", phase: "consume", statusCode: 502 });
      try { operatorToken = await pairing.decryptCredentialDelivery({ version: Number(consumed.sessionGrant.version || 1), envelope: consumed.sessionGrant.envelope }, "operator-session"); }
      catch { throw Object.assign(new Error("session envelope rejected"), { safeCode: "operator_session_delivery_failed", phase: "consume", statusCode: 502 }); }
      const grantedPrincipal = verifyOperatorSessionToken(operatorToken, {
        publicKey: operatorPublicKey,
        hubId: serial,
        requiredScope: null,
        requireRecentAuth: false,
        now: operatorNow(),
        internalOperatorDaySession: runtimeConfig.stage1InternalOperatorDaySession === true,
      });
      const scopeList = Array.isArray(grantedPrincipal?.scope) ? grantedPrincipal.scope.map(String) : [];
      const operatorScope = scopeList.length === 1 && ["os:admin", "os:permanent-installation"].includes(scopeList[0]) ? scopeList[0] : "";
      const grantBound = Boolean(grantedPrincipal && grantedPrincipal.handoffId === job.handoffId && grantedPrincipal.homeId && grantedPrincipal.employeeSessionId);
      const staffGrantComplete = operatorScope !== "os:permanent-installation" || Boolean(grantedPrincipal?.workflow && grantedPrincipal?.requestId
        && Array.isArray(grantedPrincipal?.areaIds) && Array.isArray(grantedPrincipal?.areaOptions) && Number.isSafeInteger(Number(grantedPrincipal?.workRevision)));
      if (!grantBound || !operatorScope || !staffGrantComplete) {
        throw Object.assign(new Error("grant policy mismatch"), { safeCode: "operator_session_grant_invalid", phase: "consume", statusCode: 502 });
      }
      const expiresAt = Math.min(Number(new Date(consumed.expiresAt).getTime()), Number(grantedPrincipal.exp) * 1000);
      if (!Number.isFinite(expiresAt) || expiresAt <= operatorNow()) throw Object.assign(new Error("grant expired"), { safeCode: "operator_session_expired", phase: "consume", statusCode: 401 });
      job.sessionHandle = issueBrowserOperatorSession(operatorToken, expiresAt, { jti: grantedPrincipal.jti, handoffId: grantedPrincipal.handoffId, credentialVersion: grantedPrincipal.credentialVersion });
      job.expiresAt = expiresAt;
      job.operatorScope = operatorScope;
      job.state = "established";
      job.phase = null;
      job.retainUntil = Math.min(expiresAt, operatorNow() + 2 * 60_000);
      logger.log(`[operator-handoff] correlation=${job.correlationId} state=established`);
    } catch (error) {
      job.state = "failed";
      job.phase = error?.phase === "prepare" || error?.phase === "consume" ? error.phase : job.phase || "hub";
      job.errorCode = String(error?.safeCode || (error?.name === "AbortError" ? "platform_request_timeout" : "platform_unavailable"));
      if (!/^[a-z0-9_]{1,64}$/.test(job.errorCode)) job.errorCode = "operator_handoff_rejected";
      job.statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : error?.name === "AbortError" ? 504 : 503;
      job.retainUntil = operatorNow() + 60_000;
      logger.warn(`[operator-handoff] correlation=${job.correlationId} phase=${job.phase} code=${job.errorCode} status=${job.statusCode}`);
    } finally {
      handoffSecret = null;
      operatorToken = null;
      job.handoffSecret = null;
      job.running = false;
    }
  }

  async function handleOperatorHandoffRequest(req, res) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    if (!local && !remote) return json(res, 404, { error: "Operator handoff is available only on the paired local or secure Cloudflare endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const expectedProtocol = remote ? "https" : "http";
    if (String(req.headers.origin || "") !== `${expectedProtocol}://${req.headers.host}`) return json(res, 403, { error: "Operator handoff origin is not allowed" });
    const body = await readBody(req);
    if (!setupInitialBrowserSessionValid(req)) return json(res, 403, { error: "This setup browser session is not valid" });
    const browserBinding = setupCookie(req, "dinodia_operator_binding");
    const setupAttemptId = setupCookie(req, "dinodia_operator_attempt");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(browserBinding || "") || !/^[A-Za-z0-9_-]{8,160}$/.test(setupAttemptId)) return json(res, 400, { error: "The hub-created operator browser context is unavailable", errorCode: "operator_browser_context_invalid", handoffPhase: "hub" });
    const key = operatorHandoffJobKey(setupAttemptId, browserBinding);
    const handoffCapacityAvailable = pruneOperatorHandoffJobs();
    const origin = `${expectedProtocol}://${req.headers.host}`;
    let job = operatorHandoffJobs.get(key);
    if (String(body.action || "start") === "start") {
      const handoffId = String(body.handoffId || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(handoffId)) return json(res, 400, { error: "A one-use operator handoff reference is required", errorCode: "operator_handoff_reference_invalid", handoffPhase: "hub" });
      const handoffHash = hashTokenValue(handoffId);
      if (job) {
        if (job.handoffHash !== handoffHash || job.origin !== origin) return json(res, 409, { error: "This browser already has a different operator handoff in progress", errorCode: "operator_handoff_conflict", handoffPhase: job.phase || "hub", correlationId: job.correlationId });
        return respondOperatorHandoffJob(res, job);
      }
      if (!handoffCapacityAvailable) return json(res, 503, { error: "The hub is completing other secure handoffs. Try again shortly.", errorCode: "operator_handoff_capacity_reached", handoffPhase: "hub" });
      job = {
        handoffId,
        handoffHash,
        browserBinding,
        setupAttemptId,
        origin,
        remote,
        key,
        correlationId: crypto.randomUUID(),
        state: "pending",
        phase: "prepare",
        createdAt: operatorNow(),
        deadlineAt: operatorNow() + 55_000,
        retainUntil: operatorNow() + 2 * 60_000,
        running: true,
      };
      operatorHandoffJobs.set(key, job);
      void runOperatorHandoffJob(job);
      return respondOperatorHandoffJob(res, job);
    }
    if (String(body.action) !== "status") return json(res, 400, { error: "Unknown operator handoff action", errorCode: "operator_handoff_action_invalid", handoffPhase: "hub" });
    if (!job || job.origin !== origin || operatorNow() >= job.retainUntil) return json(res, 404, { error: "No active handoff exists for this originating browser", errorCode: "operator_handoff_job_missing", handoffPhase: "hub" });
    return respondOperatorHandoffJob(res, job);
  }

  async function handleOperatorSessionEnd(req, res) {
    const local = localSetupHostAllowed(req);
    const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
    if (!local && !remote) return json(res, 404, { error: "Not found" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const expectedProtocol = remote ? "https" : "http";
    if (String(req.headers.origin || "") !== `${expectedProtocol}://${req.headers.host}`) return json(res, 403, { error: "Operator session origin is not allowed" });
    const cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("dinodia_os_operator_session="));
    const handle = cookie ? decodeURIComponent(cookie.slice("dinodia_os_operator_session=".length)) : "";
    const session = operatorBrowserSessions.get(handle);
    if (session) {
      const principal = operatorSessionAuth(session.token);
      if (!principal || !(principal.scope.includes("os:admin") || principal.scope.includes("os:permanent-installation"))) return json(res, 401, { error: "This Dinodia OS session has expired or is no longer active", errorCode: "operator_session_expired" });
      await revokeLocalOperatorSession(session, "operator_session_ended");
    }
    setupHeaders(res, ["dinodia_os_operator_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"]);
    return json(res, 200, { ok: true, message: "Dinodia OS session ended" });
  }
  function googleNestCallbackPage(kind = "success") {
    const success = kind === "success";
    const title = success ? "Google Nest connected" : kind === "cancelled" ? "Google Nest authorization cancelled" : "Google Nest setup could not be completed";
    const message = success ? "Google Nest is connected. You can close this tab." : kind === "cancelled" ? "No account was connected. You can close this tab." : "Return to the Dinodia OS dashboard and try again.";
    const signal = success ? "google_nest_connected" : kind === "cancelled" ? "google_nest_cancelled" : "google_nest_failed";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main><script>try{if(window.opener)window.opener.postMessage({type:${JSON.stringify(signal)}},window.location.origin)}catch{};setTimeout(()=>window.close(),250)</script></body></html>`;
  }
  async function handleGoogleNestCallback(req, res, url) {
    if (req.method !== "GET") return text(res, 405, "Method not allowed");
    if (!googleNestCallbackAllowed(req)) return text(res, 400, "Google Nest callback must use the secure Cloudflare hostname");
    // Google includes the issuer and granted scope in a successful OAuth
    // response. Keep the callback allow-list strict, but accept and validate
    // those standard response parameters instead of treating a valid Google
    // redirect as malformed.
    const allowed = new Set(["state", "code", "error", "error_description", "iss", "scope"]);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) return text(res, 400, "Invalid Google Nest callback");
    const stateValue = url.searchParams.get("state") || "";
    const codeValue = url.searchParams.get("code") || "";
    const errorValue = url.searchParams.get("error") || "";
    const issuerValue = url.searchParams.get("iss") || "";
    const scopeValue = url.searchParams.get("scope") || "";
    if ((issuerValue && issuerValue !== "https://accounts.google.com") || stateValue.length > 512 || codeValue.length > 4096 || errorValue.length > 128 || issuerValue.length > 128 || scopeValue.length > 2048 || (url.searchParams.get("error_description") || "").length > 512) return text(res, 400, "Invalid Google Nest callback");
    let kind = "success";
    try {
      await googleNest.completeAuthorization({ state: stateValue, code: codeValue, error: errorValue });
      await activity.record({ type: "google_nest_account_connected", detail: "Google Nest account connected and thermostats discovered." });
    } catch (error) {
      kind = error.code === "oauth_access_denied" ? "cancelled" : "failed";
      await activity.record({ type: kind === "cancelled" ? "google_nest_authorization_cancelled" : "google_nest_authorization_failed", detail: kind === "cancelled" ? "Google Nest authorization was cancelled." : "Google Nest authorization failed.", change: { code: error.code || "oauth_callback_invalid" } }).catch(() => {});
    }
    res.writeHead(kind === "success" ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    res.end(googleNestCallbackPage(kind));
  }
  function browserOperatorToken(req) {
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("dinodia_os_operator_session="));
    const handle = cookie ? decodeURIComponent(cookie.slice("dinodia_os_operator_session=".length)) : "";
    return browserSessionToken(handle) || bearerToken(req);
  }

  async function handleDashboardRequest(req, res, url) {
    applyDashboardHeaders(res);
    if (req.method === "OPTIONS") return text(res, 204, "");
    const dashboardUrl = isDashboardAdminPath(url.pathname) ? dashboardApiUrl(url) : url;
    const directNativeAppApi = !isDashboardAdminPath(url.pathname) && isNativeAppRoute(req, url);
    const browserToken = browserOperatorToken(req);
    const operator = await refreshedSupportBrowserPrincipal(req) || operatorSessionAuth(browserToken);
    if (operator?.scope?.includes("os:permanent-installation") && !operator.scope.includes("os:admin")) {
      return nativeContractError(res, 403, "SCOPE_DENIED", "This assigned-work session can open only its permanent-installation workspace");
    }
    const app = appSessionAuth(bearerToken(req));
    const nativeAppApi = directNativeAppApi || isDashboardAdminPath(url.pathname) && (
      dashboardUrl.pathname === "/api/status" ||
      dashboardUrl.pathname === "/api/devices" ||
      dashboardUrl.pathname === "/api/dinodia/v1/devices" ||
      (req.method === "POST" && dashboardUrl.pathname === "/api/dinodia/v1/commands") ||
      dashboardUrl.pathname.startsWith("/api/devices/") ||
      (req.method === "POST" && dashboardUrl.pathname.startsWith("/api/entities/") && dashboardUrl.pathname.endsWith("/service"))
    );
    // Offline authority may enter only the direct Native V1 read/command
    // routes. The deeper handler verifies the signed exact-home grant and
    // one-use request challenge. No dashboard or HA-shaped route is admitted.
    const offlineHeadersPresent = Boolean(req.headers["x-dinodia-offline-grant"])
      && Boolean(req.headers["x-dinodia-offline-challenge"])
      && Boolean(req.headers["x-dinodia-offline-signature"]);
    const offlineChallengeRequest = runtimeConfig.nodeEnv === "production" && !operator && !app
      && url.pathname === "/api/dinodia/v1/offline/challenges" && req.method === "POST"
      && Boolean(req.headers["x-dinodia-offline-grant"]) && !bearerToken(req)
      && isTrustedOfflineLanTransport(req);
    const offlineNativeRoute = runtimeConfig.nodeEnv === "production" && !operator && !app && (offlineChallengeRequest || offlineHeadersPresent)
      && isTrustedOfflineLanTransport(req)
      && directNativeAppApi
      && (offlineChallengeRequest || (req.method === "GET" && (url.pathname === "/api/dinodia/v1/snapshot" || url.pathname === "/api/dinodia/v1/areas" || url.pathname === "/api/dinodia/v1/devices" || /^\/api\/dinodia\/v1\/devices\/[^/]+$/.test(url.pathname) || url.pathname === "/api/dinodia/v1/control-catalog" || /^\/api\/dinodia\/v1\/commands\/[^/]+$/.test(url.pathname)))
        || (req.method === "POST" && url.pathname === "/api/dinodia/v1/commands"));
    if (runtimeConfig.nodeEnv === "production" && !operator && !app && !offlineNativeRoute) {
      if (directNativeAppApi) return nativeContractError(res, 401, "AUTH_REQUIRED", "A valid selected-home app session is required");
      const hasOperatorCookie = String(req.headers.cookie || "").split(";").some((item) => item.trim().startsWith("dinodia_os_operator_session="));
      if (hasOperatorCookie) {
        setupHeaders(res, ["dinodia_os_operator_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"]);
        return json(res, 401, { error: "Your Dinodia OS session expired or was revoked. Return to Company Portal and launch secure access again.", errorCode: "operator_session_expired" });
      }
      return json(res, 401, { error: "A temporary Dinodia OS operator session is required", errorCode: "operator_session_required" });
    }
    if (runtimeConfig.nodeEnv === "production" && app && !operator && !nativeAppApi) return json(res, 403, { error: "This app principal cannot open the Dinodia OS dashboard", errorCode: "insufficient_scope" });
    try {
      if (isDashboardAdminPath(url.pathname) || directNativeAppApi) return await handleApi(req, res, dashboardUrl);
      if (req.method !== "GET") return text(res, 405, "Method not allowed");
      return await serveStatic(res, url);
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      logger.error(`[dashboard] ${req.method} ${url.pathname}: ${error.message}`);
      if (error.details || String(error.code || "").includes("automation") || ["invalid_value", "missing_device", "missing_control", "invalid_option", "invalid_number", "revision_conflict", "revision_required", "idempotency_conflict"].includes(error.code)) {
        return json(res, status, { error: { code: String(error.code || "automation_error").slice(0, 96), message: status === 500 ? "Internal server error" : error.message, details: Array.isArray(error.details) ? error.details : undefined } });
      }
      return json(res, status, { error: status === 500 ? "Internal server error" : error.message, ...(error.code ? { errorCode: String(error.code).slice(0, 96) } : {}) });
    }
  }
  async function handleUnifiedRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/dinodia/v1/claim-resolver/challenge") {
      if (req.method !== "POST") return nativeContractError(res, 405, "METHOD_NOT_ALLOWED", "The claim resolver method is not allowed");
      const report = lanTlsIdentity?.publicReport();
      const expectedHost = report?.state === "CURRENT" ? `${report.host}:${lanListenerPort}` : "";
      const localAddress = String(req.socket?.localAddress || "").replace(/^::ffff:/, "");
      const selectedAddress = String(physicalLanAddress || "").replace(/^::ffff:/, "");
      const host = String(req.headers.host || "").toLowerCase();
      const servername = String(req.socket?.servername || "").toLowerCase();
      const forwarded = req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"];
      if (!req.socket?.encrypted || req.socket.localPort !== lanListenerPort || !expectedHost
        || host !== expectedHost.toLowerCase() || servername !== report.host.toLowerCase()
        || !selectedAddress || localAddress !== selectedAddress || !isPrivateLanRequest(req) || forwarded
        || req.headers.origin || req.headers.authorization || req.headers.cookie
        || !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        return nativeContractError(res, 404, "CLAIM_RESOLVER_UNAVAILABLE", "The local claim resolver is unavailable");
      }
      if (!(await setupRateLimitAllows(req))) return nativeContractError(res, 429, "RATE_LIMITED", "Wait before trying again");
      let body;
      try { body = await readBody(req, 2_048); } catch { return nativeContractError(res, 400, "VALIDATION_FAILED", "The claim resolver request is invalid"); }
      if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length !== 1
        || typeof body.reference !== "string" || !/^DNO-HOME-[A-Za-z0-9_-]{32,64}$/.test(body.reference)) {
        return nativeContractError(res, 400, "VALIDATION_FAILED", "The claim resolver request is invalid");
      }
      try {
        const challenge = await pairing.requestPermanentClaimChallenge(body.reference);
        return json(res, 200, { ok: true, ...challenge });
      } catch {
        return nativeContractError(res, 404, "CLAIM_RESOLVER_UNAVAILABLE", "The local claim resolver is unavailable");
      }
    }
    if (url.pathname === "/api/dinodia/v1/health" && req.method === "GET") return json(res, 200, { ok: true, schemaVersion: "dinodia.v1", mode: "native-v2" });
    if (url.pathname === "/_dinodia/cloud-challenge" && req.method === "GET") {
      const remote = isHiveCredentialTransportAllowed(req, { nodeEnv: runtimeConfig.nodeEnv, configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: false });
      if (!remote) return json(res, 404, { error: "Not found" });
      const challenge = String(url.searchParams.get("challenge") || "");
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(challenge)) return json(res, 400, { error: "A valid challenge is required" });
      const connector = connectedLocalTunnelIdentity(
        cloudflare.status(),
        String(req.headers.host || "").split(":")[0],
        String(url.searchParams.get("tunnelId") || "").trim(),
        String(url.searchParams.get("tunnelName") || "").trim(),
      );
      if (!connector.ok) {
        const status = connector.reason === "connector_identity_mismatch" ? 403 : 503;
        return json(res, status, { error: "The active Cloudflare connector identity could not be independently verified", errorCode: connector.reason });
      }
      const { cloudUrl, tunnelId, tunnelName } = connector;
      const publicIdentity = await pairing.getPublicIdentity();
      const identityFingerprint = publicIdentity?.publicKeyFingerprint || null;
      if (!identityFingerprint) return json(res, 503, { error: "Hub signing identity is unavailable" });
      const unsignedBody = { version: 1, serial, cloudUrl, challenge, tunnelId, tunnelName, timestamp: Date.now(), identityFingerprint, identityGeneration: Number(publicIdentity.generation) };
      const bodyHash = crypto.createHash("sha256").update(canonicalCloudChallengeUnsigned(unsignedBody), "utf8").digest("hex");
      const responseBody = { version: 1, serial, cloudUrl, challenge, tunnelId, tunnelName, timestamp: unsignedBody.timestamp, bodyHash, identityFingerprint, identityGeneration: unsignedBody.identityGeneration };
      let hubSignature;
      try {
        hubSignature = await pairing.signCloudChallenge(responseBody);
      } catch (error) {
        logger.warn(`[cloud-challenge] signing unavailable: ${error.message}`);
        return json(res, 503, { error: "Hub signing identity is unavailable" });
      }
      return json(res, 200, { ok: true, ...responseBody, hubSignature });
    }
    if (url.pathname === runtimeConfig.googleNestCallbackPath) return handleGoogleNestCallback(req, res, url);
    if (url.pathname === "/permanent-installation" || url.pathname === "/permanent-installation.js") return handlePermanentInstallationPage(req, res);
    if (url.pathname === "/_dinodia/installer/commissioning" || url.pathname.startsWith("/_dinodia/installer/commissioning/")) return handlePermanentInstallationCommissioning(req, res, url);
    if (url.pathname === "/support-access") return handleRemoteSupportPage(req, res);
    if (url.pathname === "/_dinodia/setup/support-access") return handleSupportAccessRequest(req, res);
    if (url.pathname === "/_dinodia/setup/operator-attempt") return handleOperatorAttemptRegistration(req, res);
    if (url.pathname === "/_dinodia/setup/operator-session") return handleOperatorHandoffRequest(req, res);
    if (url.pathname === "/_dinodia/operator-session/end") return handleOperatorSessionEnd(req, res);
    if (url.pathname === "/setup.js") return handleSetupScriptRequest(req, res);
    if (url.pathname === "/setup" || url.pathname.startsWith("/_dinodia/setup/")) return handleLocalSetupRequest(req, res, url);
    if (url.pathname.startsWith("/_dinodia/platform/v1/alexa")) return handleNativeAlexaPlatformRequest(req, res, url);
    // Only the canonical Native V1 app routes and its descriptor-bound
    // sensitive-command challenge bypass HA compatibility.
    // Their app token is still verified by handleDashboardRequest/handleApi;
    // every other /api/* path remains on the existing compatibility router.
    if (isNativeAppRoute(req, url)) return handleDashboardRequest(req, res, url);
    if (isDashboardAdminPath(url.pathname)) return handleDashboardRequest(req, res, url);
    if (isHaCompatibilityPath(url.pathname)) return haCompat.handleHttp(req, res);
    return handleDashboardRequest(req, res, url);
  }
  const nativeEventServer = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024 });
  const commissioningEventServer = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024 });
  const server = http.createServer(handleUnifiedRequest);
  function queueCommissioningSnapshot(client) {
    client.sendQueue = client.sendQueue.then(async () => {
      if (client.socket.readyState !== WebSocket.OPEN) return;
      const principal = appSessionAuth(client.token);
      if (!principal || principal.householdRole !== "TENANT" || principal.scope?.includes("tenant:device-command") !== true
        || principal.sub !== client.principal.sub || principal.sid !== client.principal.sid
        || principal.membershipId !== client.principal.membershipId || principal.homeId !== client.principal.homeId
        || !nativeCommissioningService) {
        client.socket.close(4401, "Session expired or revoked");
        return;
      }
      try {
        await nativeCommissioningService.requireSession(client.sessionId, principal);
        const snapshot = await nativeCommissioningService.status(client.sessionId, principal, client.afterSequence, null);
        if (client.socket.readyState !== WebSocket.OPEN) return;
        const encoded = JSON.stringify(snapshot);
        if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
          client.socket.close(1009, "Commissioning update too large");
          return;
        }
        client.socket.send(encoded);
        client.afterSequence = Math.max(client.afterSequence, ...(snapshot.events || []).map((event) => Number(event.sequence) || 0));
        if (["completed", "cancelled", "expired", "failed"].includes(snapshot.status) && snapshot.cleanup?.pendingCount === 0) {
          client.socket.close(1000, "Commissioning session complete");
        }
      } catch (error) {
        logger.warn(`[commissioning-events] projection failed (${String(error?.code || "unavailable").slice(0, 48)})`);
        if (client.socket.readyState === WebSocket.OPEN) client.socket.close(4403, "Commissioning authority changed");
      }
    }).catch(() => {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.close(1011, "Commissioning event unavailable");
    });
  }
  eventBus.on("dinodia_dashboard_updated", (event = {}) => {
    if (event.kind !== "commissioning" || !/^[0-9a-f-]{36}$/i.test(String(event.sessionId || ""))) return;
    for (const client of commissioningEventClients) if (client.sessionId === String(event.sessionId)) queueCommissioningSnapshot(client);
  });
  const setupServer = http.createServer((req, res) => {
    let pathname = "";
    try { pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname; } catch {}
    const setupRoute = (pathname === "/setup" || pathname === "/setup.js") && req.method === "GET"
      || pathname === "/_dinodia/setup/status" && req.method === "GET"
      || ["/_dinodia/setup/operator-attempt", "/_dinodia/setup/pairing", "/_dinodia/setup/support-access", "/_dinodia/setup/operator-session"].includes(pathname)
        && (req.method === "POST" || pathname === "/_dinodia/setup/pairing" && req.method === "DELETE");
    const staticRoute = req.method === "GET" && (["/", "/index.html", "/styles.css", "/app.js", "/permanent-installation", "/permanent-installation.js"].includes(pathname)
      || /^\/js\/[A-Za-z0-9._/-]+$/.test(pathname) && !pathname.split("/").includes(".."));
    const installerReadRoutes = new Set([
      "/api/status", "/api/devices", "/api/automations", "/api/areas", "/api/labels",
      "/api/provisioning", "/api/readiness", "/api/integrations/zigbee/pairing",
      "/api/heating-demand-controller", "/api/activity",
    ]);
    const adminApiPath = pathname.startsWith("/_dinodia/admin/") ? pathname.slice("/_dinodia/admin".length) : "";
    const operatorReadRoute = req.method === "GET" && installerReadRoutes.has(adminApiPath);
    const operatorAreaCreateRoute = req.method === "POST" && adminApiPath === "/api/areas";
    const operatorEndRoute = req.method === "POST" && pathname === "/_dinodia/operator-session/end";
    const permanentInstallationRoute = pathname === "/_dinodia/installer/commissioning" || /^\/_dinodia\/installer\/commissioning\/sessions(?:\/[^/]+(?:\/(?:matter-payload|select|complete|cancel|resume))?)?$/.test(pathname);
    const recognizedPath = setupRoute || staticRoute || operatorReadRoute || operatorAreaCreateRoute || operatorEndRoute || permanentInstallationRoute;
    if (!recognizedPath && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return json(res, 404, { error: "Not found" });
    if (!recognizedPath) return text(res, 405, "Method not allowed");
    if (!setupRoute && !staticRoute && !operatorReadRoute && !operatorAreaCreateRoute && !operatorEndRoute && !permanentInstallationRoute) return json(res, 404, { error: "Not found" });
    return handleUnifiedRequest(req, res);
  });
  let httpsServer = null;
  let physicalLanAddress = "";
  let certificateRefreshTimer = null;
  let physicalListenerQueue = Promise.resolve();
  server.on("upgrade", async (req, socket, head) => {
    let url;
    try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
    catch { socket.destroy(); return; }
    const commissioningEvents = url.pathname.match(/^\/api\/dinodia\/v1\/commissioning\/sessions\/([0-9a-f-]{36})\/events$/i);
    if (commissioningEvents) {
      const token = bearerToken(req);
      const principal = appSessionAuth(token);
      const afterText = url.searchParams.get("after") || "0";
      const after = /^(?:0|[1-9]\d{0,15})$/.test(afterText) ? Number(afterText) : NaN;
      const productionTransportAllowed = runtimeConfig.nodeEnv !== "production"
        || req.socket?.encrypted === true
        || isHiveCredentialTransportAllowed(req, { nodeEnv: "production", configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: true });
      const onlyAfter = [...url.searchParams.keys()].every((key) => key === "after") && url.searchParams.getAll("after").length <= 1;
      if (!productionTransportAllowed) { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"); return; }
      if (!principal || principal.householdRole !== "TENANT" || principal.scope?.includes("tenant:device-command") !== true) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      if (!Number.isSafeInteger(after) || after < 0 || !onlyAfter || !nativeCommissioningService) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
      try { await nativeCommissioningService.requireSession(commissioningEvents[1], principal); }
      catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      commissioningEventServer.handleUpgrade(req, socket, head, (clientSocket) => {
        const client = { socket: clientSocket, token, principal, sessionId: commissioningEvents[1], afterSequence: after, sendQueue: Promise.resolve() };
        commissioningEventClients.add(client);
        clientSocket.once("close", () => { commissioningEventClients.delete(client); clearInterval(client.authTimer); });
        client.authTimer = setInterval(() => queueCommissioningSnapshot(client), 5000);
        client.authTimer.unref?.();
        queueCommissioningSnapshot(client);
      });
      return;
    }
    if (url.pathname === "/api/dinodia/v1/events") {
      const token = bearerToken(req);
      let principal = appSessionAuth(token);
      let offline = false;
      if (!principal && isTrustedOfflineLanTransport(req)) {
        try {
          const encoded = String(req.headers["x-dinodia-offline-challenge"] || "");
          const challenge = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
          const path = `${url.pathname}${url.search}`;
          principal = await offlineLanAuthorisations.verify({
            grantId: String(req.headers["x-dinodia-offline-grant"] || ""),
            challenge,
            signature: String(req.headers["x-dinodia-offline-signature"] || ""),
            expectedPurpose: "native.events",
            expectedPath: path,
          });
          offline = Boolean(principal);
        } catch { principal = null; }
      }
      const afterText = url.searchParams.get("after") || "0";
      const after = /^(?:0|[1-9]\d{0,15})$/.test(afterText) ? Number(afterText) : NaN;
      const productionTransportAllowed = runtimeConfig.nodeEnv !== "production"
        || req.socket?.encrypted === true
        || isHiveCredentialTransportAllowed(req, { nodeEnv: "production", configuredHostname: runtimeConfig.cloudflarePublicHostname || cloudflare.status().hostname || "", allowLoopback: true });
      if (!productionTransportAllowed) { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"); return; }
      if (!principal || principal.householdRole !== "TENANT" || !principal.scope?.includes("tenant:device-command")) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      if (!Number.isSafeInteger(after) || after < 0) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
      const platformHomeId = String(hubStore.getPlatform?.()?.homeId || "");
      if (platformHomeId && principal.homeId !== platformHomeId) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      nativeEventServer.handleUpgrade(req, socket, head, (clientSocket) => {
        const client = { socket: clientSocket, token, principal, offline };
        nativeEventClients.add(client);
        clientSocket.once("close", () => { nativeEventClients.delete(client); clearInterval(client.authTimer); });
        const security = hubStore.getSecurity?.() || {};
        const events = Array.isArray(security.nativeEvents) ? security.nativeEvents : [];
        const oldest = events.length ? Number(events[0].sequence) : Number(security.nativeEventSequence || 0) + 1;
        if (after > 0 && after < oldest - 1) {
          clientSocket.send(JSON.stringify({ error: { code: "RESNAPSHOT_REQUIRED", message: "The requested event cursor is no longer retained", requestId: crypto.randomUUID(), retryable: true } }));
          clientSocket.close(4409, "Resnapshot required");
          return;
        }
        client.authTimer = setInterval(() => {
          const current = offline
            ? (offlineLanAuthorisations.isCurrent(principal) ? principal : null)
            : appSessionAuth(token);
          if (!current || current.sub !== principal.sub || current.sid !== principal.sid || current.membershipId !== principal.membershipId || current.homeId !== principal.homeId) clientSocket.close(4401, "Session expired or revoked");
        }, 5000);
        client.authTimer.unref?.();
        for (const event of events.filter((entry) => Number(entry.sequence) > after)) sendNativeEvent(client, event).catch(() => clientSocket.close(1011, "Event unavailable"));
      });
      return;
    }
    if (url.pathname.startsWith("/api/dinodia/v1/")) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    haCompat.handleUpgrade(req, socket, head);
  });
  async function closeListeningServer(listener) {
    if (!listener?.listening) return;
    listener.closeAllConnections?.();
    await new Promise((resolve) => listener.close(resolve));
  }
  function setupObservationUnavailable(observation) {
    return { version: 1, revision: Number(observation?.revision) || 1, state: "UNAVAILABLE", discoveryHost: `dinodia-${serial.toLowerCase()}.local` };
  }
  refreshPhysicalLanListeners = (observation, { refreshCertificate = false } = {}) => {
    const run = async () => {
      const address = physicalLanListenersEnabled && observation?.state === "CURRENT"
        && (loopbackLanListenerForTest
          ? observation.address === "127.0.0.1"
          : privateInterface(runtimeConfig.setupInterfaceName)?.address === observation.address) ? observation.address : "";
      if (!address) {
        await closeListeningServer(httpsServer);
        httpsServer = null;
        await closeListeningServer(setupServer);
        physicalLanAddress = "";
        return;
      }
      const addressChanged = physicalLanAddress !== address;
      if (addressChanged || refreshCertificate) {
        await closeListeningServer(httpsServer);
        httpsServer = null;
      }
      if (addressChanged) await closeListeningServer(setupServer);
      if (!httpsServer && lanTlsIdentity?.publicReport()?.state === "CURRENT") {
        try {
          httpsServer = https.createServer(lanTlsIdentity.tlsOptions(), handleUnifiedRequest);
          httpsServer.on("upgrade", (req, socket, head) => server.emit("upgrade", req, socket, head));
          await new Promise((resolve, reject) => {
            httpsServer.once("error", reject);
            httpsServer.listen(lanListenerPort, address, resolve);
          });
        } catch (error) {
          await closeListeningServer(httpsServer).catch(() => {});
          httpsServer = null;
          logger.warn(`[lan-tls] customer HTTPS listener unavailable (${String(error?.code || "bind-failed").slice(0, 48)}); direct LAN remains fail-closed`);
        }
      }
      if (loopbackLanListenerForTest) {
        physicalLanAddress = address;
        return;
      }
      if (!setupServer.listening) {
        try {
          await new Promise((resolve, reject) => {
            setupServer.once("error", reject);
            setupServer.listen(80, address, resolve);
          });
        } catch (error) {
          logger.error(`[setup-discovery] restricted HTTP setup listener unavailable (${String(error?.code || "bind-failed").slice(0, 48)})`);
          throw error;
        }
      }
      physicalLanAddress = address;
    };
    const result = physicalListenerQueue.then(run, run);
    physicalListenerQueue = result.catch(() => {});
    return result;
  };

  async function start() {
    if (runtimeConfig.nodeEnv === "production" && legacyCompatibilityEnabled) throw new Error("Legacy dashboard authentication cannot be enabled in production");
    await recoverInterruptedNativeCommands();
    mqtt.start();
    matter.start();
    const threadSettings = hubStore.getThread?.();
    if (threadSettings?.configured && threadSettings.rcpDevice) {
      threadRuntime.start({ rcpDevice: threadSettings.rcpDevice, baudRate: threadSettings.baudRate, infraIf: threadSettings.infraIf, threadIf: threadSettings.threadIf })
        .then((result) => {
          if (result.ok && !runtimeConfig.matterServerUrl && typeof matter.setUrl === "function") matter.setUrl("ws://127.0.0.1:5580/ws");
          if (!result.ok) logger.error(`[thread] automatic startup failed: ${result.error || result.reason || "unknown error"}`);
        })
        .catch((error) => logger.error(`[thread] automatic startup failed: ${error.message}`));
    }
    automation.start?.();
    await hubStore.pruneActivity();
    activity.start();
    if (runtimeConfig.nodeEnv === "production" && !operatorSessionRevalidationTimer) {
      operatorSessionRevalidationTimer = setInterval(() => syncOperatorBrowserSessions().catch(() => {}), runtimeConfig.operatorPolicySyncIntervalMs);
      operatorSessionRevalidationTimer.unref?.();
    }
    if (runtimeConfig.nativeAutomationsMode === "enabled") await nativeAutomationScheduler.start();
    const previousActivity = hubStore.getActivityState();
    const previousShutdownClean = previousActivity.lastShutdownClean !== false;
    await hubStore.setActivityRuntime({ lastShutdownClean: false, lastStartedAt: new Date().toISOString() });
    await activity.record({ type: "hub_started", detail: previousShutdownClean ? "Dinodia OS is running and ready for local control." : "Dinodia OS restarted after an unclean shutdown; inspect recent activity for interrupted work.", change: { previousShutdownClean } });
    activityIntegrationTimer = setInterval(() => integrationStatus().catch((error) => logger.error(`[activity] ${error.message}`)), 30000);
    activityIntegrationTimer.unref?.();
    if (lanTlsIdentity) {
      try { await lanTlsIdentity.initialize(); }
      catch { logger.warn("[lan-tls] customer HTTPS identity unavailable; direct LAN control remains fail-closed"); }
    }
    const cloudOriginHost = runtimeConfig.nodeEnv === "production" ? "127.0.0.1" : runtimeConfig.haHost;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(runtimeConfig.haPort, cloudOriginHost, resolve);
    });
    if (physicalLanListenersEnabled) {
      if (!loopbackLanListenerForTest) setupDiscovery.start(80, 80, lanTlsIdentity?.publicReport()?.host || "", runtimeConfig.haPort);
      await refreshPhysicalLanListeners(setupDiscovery.observation()).catch(() => {});
    }
    if (lanTlsIdentity && !certificateRefreshTimer) {
      certificateRefreshTimer = setInterval(async () => {
        try {
          await lanTlsIdentity.initialize();
          await refreshPhysicalLanListeners(setupDiscovery.observation(), { refreshCertificate: true });
          pairing?.requestImmediateHeartbeat?.();
        } catch { logger.warn("[lan-tls] certificate refresh unavailable; customer LAN remains fail-closed"); }
      }, 60 * 60 * 1000);
      certificateRefreshTimer.unref?.();
    }
    await electric.tick(hubStore.listDevices());
    electricTimer = setInterval(() => electric.tick(hubStore.listDevices()).catch((error) => logger.error(`[electric] ${error.message}`)), 5 * 60 * 1000);
    electricTimer.unref?.();
    await hubAgentCompat.start();
    cloudflare.start();
    const cloudflareSettings = hubStore.getCloudflare?.() || {};
    if (runtimeConfig.nodeEnv === "production" && cloudflareSettings.mode === "local" && cloudflareSettings.platformVerification?.state !== "PLATFORM_VERIFIED") {
      const retry = setTimeout(() => reportCloudflareVerification().catch((error) => logger.warn(`[cloudflare] automatic verification retry unavailable: ${error.message}`)), 3000);
      retry.unref?.();
    }
    heartbeat.start();
    pairing.start();
    alexaIntegration.start();
    hive.start().catch((error) => logger.error(`[hive] automatic startup failed: ${error.message}`));
    googleNest.start().catch((error) => logger.error(`[google-nest] automatic startup failed: ${error.message}`));
    await heatingDemandController.evaluate({ reason: "startup", execute: false });
    await heatingDemandController.start();
    if (legacyCompatibilityEnabled && runtimeConfig.platformBootstrapSecret && !hubStore.getPlatform().paired) {
      pairing.configure({ bootstrapSecret: runtimeConfig.platformBootstrapSecret })
        .then(() => pairing.pair(runtimeConfig.platformBootstrapSecret))
        .then(() => pairing.syncNow())
        .catch((error) => logger.error(`[platform] automatic pairing failed: ${error.message}`));
    }
    logger.log(`[dinodia] CloudURL loopback HTTP and selected-interface Native V2 HTTPS listener active on port ${runtimeConfig.haPort}`);
    logger.log(`[dinodia] Hub Agent compatibility on http://${runtimeConfig.haHost}:${runtimeConfig.hubAgentPort}`);
    if (legacyCompatibilityEnabled && runtimeConfig.nodeEnv !== "production") logger.log("[dinodia] legacy compatibility harness enabled; native production credentials remain disabled");
    return server;
  }

  async function stop() {
    for (const client of commissioningEventClients) client.socket.close(1001, "Hub stopping");
    commissioningEventClients.clear();
    for (const timer of nativeCommandOutcomeTimers.values()) clearTimeout(timer);
    nativeCommandOutcomeTimers.clear();
    if (operatorSessionRevalidationTimer) clearInterval(operatorSessionRevalidationTimer);
    operatorSessionRevalidationTimer = null;
    await nativeCommissioningService?.close?.();
    mqtt.close();
    matter.close();
    heatingDemandController.stop();
    await hive.close();
    await googleNest.close();
    automation.stop?.();
    if (nativeAutomationScheduler) await nativeAutomationScheduler.stop();
    await cloudflare.stop();
    heartbeat.stop();
    pairing.stop();
    setupDiscovery.stop();
    if (certificateRefreshTimer) clearInterval(certificateRefreshTimer);
    certificateRefreshTimer = null;
    alexaIntegration.stop();
    activity.stop();
    if (activityIntegrationTimer) clearInterval(activityIntegrationTimer);
    activityIntegrationTimer = null;
    if (electricTimer) clearInterval(electricTimer);
    electricTimer = null;
    await hubStore.setActivityRuntime({ lastShutdownClean: true, lastStoppedAt: new Date().toISOString() });
    await haCompat.stop();
    await hubAgentCompat.stop();
    await closeListeningServer(httpsServer);
    await closeListeningServer(setupServer);
    await closeListeningServer(server);
  }

  return { server, start, stop, haServer: server, setupServer, getLanHttpsServer: () => httpsServer, hubAgentServer: hubAgentCompat.server, store: hubStore, mqtt, matter, hive, googleNest, alexa: alexaIntegration, heatingDemandController, cloudflare, sync: heartbeat, pairing, activity, electric, model: haModel, vault, eventBus, config: runtimeConfig, syncOperatorBrowserSessions, nativeAutomationService, nativeAutomationScheduler, nativeCommissioningService };
}

if (require.main === module) {
  const hub = createHub();
  hub.start().catch((error) => {
    console.error(`[dinodia] startup failed: ${error.message}`);
    process.exitCode = 1;
  });
  const shutdown = () => hub.stop().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createHub, safeEqual, hiveCredentialTransportAllowed: isHiveCredentialTransportAllowed, isPrivateLanRequest, isTrustedOfflineLanTransport };
