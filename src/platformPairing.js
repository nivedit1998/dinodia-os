const crypto = require("node:crypto");
const { canonicalCloudChallenge } = require("./auth/identityBroker");
const { privateInterface, isPrivateIPv4 } = require("./setupDiscovery");
const { applyCloudConfiguration } = require("./sync/cloudConfiguration");

function sign(secret, serial, ts, nonce) {
  return crypto.createHmac("sha256", String(secret)).update(`${serial}.${ts}.${nonce}`).digest("hex");
}

function canonicalStepUpDescriptor(input) {
  return JSON.stringify({
    version: Number(input.version),
    serial: String(input.serial),
    identityGeneration: Number(input.identityGeneration),
    actorId: String(input.actorId),
    customerSessionId: String(input.customerSessionId),
    trustedDeviceId: String(input.trustedDeviceId),
    homeId: String(input.homeId),
    membershipId: String(input.membershipId),
    hubInstallId: String(input.hubInstallId),
    operationKind: String(input.operationKind),
    targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(String) : [],
    controlId: String(input.controlId),
    descriptorRevision: Number(input.descriptorRevision),
    descriptorDigest: input.descriptorDigest == null ? null : String(input.descriptorDigest),
    operationDigest: String(input.operationDigest),
    nonce: String(input.nonce),
    issuedAt: Number(input.issuedAt),
  });
}

function canonicalHubRequest({ method, path, timestamp, nonce, bodyHash }) {
  return [String(method).toUpperCase(), String(path), String(timestamp), String(nonce), String(bodyHash).toLowerCase()].join("\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function privateLanIp() {
  return privateInterface()?.address || "";
}

function validateLanEndpointObservation(value, serial, expectedPort = 80) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["version", "revision", "state", "baseUrl", "discoveryHost"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || value.discoveryHost !== `dinodia-${String(serial || "").toLowerCase()}.local`) return false;
  if (value.state === "UNAVAILABLE") return !Object.hasOwn(value, "baseUrl");
  if (value.state !== "CURRENT" || typeof value.baseUrl !== "string") return false;
  const match = value.baseUrl.match(/^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  const allowedPorts = expectedPort === 80 ? new Set(["80", "8123"]) : new Set([String(expectedPort)]);
  if (!match || !allowedPorts.has(match[2]) || !isPrivateIPv4(match[1])) return false;
  try {
    const parsed = new URL(value.baseUrl);
    const normalizedPort = parsed.port || (parsed.protocol === "http:" ? "80" : "443");
    return parsed.protocol === "http:" && parsed.hostname === match[1] && allowedPorts.has(normalizedPort)
      && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
  } catch { return false; }
}

class PlatformPairing {
  constructor({ store, vault, identityBroker = null, apiUrl = "", serial, haPort = 8123, intervalMs = 120000, heartbeatIntervalMs = 120000, runtime, getLanEndpoint = null, getLanTlsIdentity = null, acknowledgeLanTlsIdentity = null, getUpdaterStatus = null, getAreaSnapshot, getHeatingUsage, getHeatingUsageResetAck, getElectricUsage, getElectricUsageResetAck, getActivityIncidents, getAlexaCatalog, acceptOfflineAuthorisations, onSyncResult, onOperatorCredentialStateChange, logger = console, fetchImpl = fetch, legacyCompatibilityEnabled = false, clock = () => Date.now() } = {}) {
    this.store = store;
    this.vault = vault;
    this.identityBroker = identityBroker;
    this.production = String(runtime?.nodeEnv || process.env.NODE_ENV || "development") === "production";
    const storedPlatform = store?.getPlatform?.() || {};
    const requestedApiUrl = String(apiUrl || "").replace(/\/$/, "");
    const storedApiUrl = String(storedPlatform.apiUrl || "").replace(/\/$/, "");
    this.apiUrl = String(requestedApiUrl || storedApiUrl).replace(/\/$/, "");
    this.serial = String(serial || store?.getIdentity()?.serial || "");
    this.haPort = Number(haPort) || 8123;
    this.intervalMs = Math.max(15000, Number(intervalMs) || 120000);
    this.heartbeatIntervalMs = Math.max(15000, Number(heartbeatIntervalMs) || 120000);
    this.clock = clock;
    this.lastHeartbeatAt = 0;
    this.getLanEndpoint = getLanEndpoint || (() => {
      const selected = privateInterface();
      return selected
        ? { state: "CURRENT", address: selected.address, interfaceName: selected.name }
        : { state: "UNAVAILABLE", address: "", interfaceName: null };
    });
    this.getLanTlsIdentity = getLanTlsIdentity || (() => null);
    this.acknowledgeLanTlsIdentity = acknowledgeLanTlsIdentity || (() => false);
    this.getUpdaterStatus = getUpdaterStatus || (async () => null);
    this.pendingEndpointHeartbeat = false;
    this.queuedImmediateSync = false;
    this.runtime = {
      kind: String(runtime?.kind || "dinodia_os"),
      version: String(runtime?.version || "0.0.0"),
      capabilities: { managedAreaProvisioningV1: true, managedDevicePresentationV1: true, activityIncidentReportingV1: true, alexaNativeProjectionV1: true, alexaNativeDirectiveV1: true, ...(runtime?.capabilities || {}) },
    };
    this.getAreaSnapshot = getAreaSnapshot || (() => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), areas: [] }));
    this.getHeatingUsage = getHeatingUsage || (() => null);
    this.getHeatingUsageResetAck = getHeatingUsageResetAck || (() => null);
    this.getElectricUsage = getElectricUsage || (() => null);
    this.getElectricUsageResetAck = getElectricUsageResetAck || (() => null);
    this.getActivityIncidents = getActivityIncidents || (() => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), incidents: [] }));
    this.getAlexaCatalog = getAlexaCatalog || null;
    this.onSyncResult = onSyncResult || (() => {});
    this.onOperatorCredentialStateChange = onOperatorCredentialStateChange || (async () => {});
    this.acceptOfflineAuthorisations = acceptOfflineAuthorisations || (async () => {});
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.legacyCompatibilityEnabled = Boolean(legacyCompatibilityEnabled);
    this.timer = null;
    this.syncing = false;
    this.publishAttempts = 0;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.nextRetryAt = 0;
    this.lastError = null;
    this.lastSuccess = null;
  }

  status() {
    const platform = this.store?.getPlatform?.() || {};
    const sync = this.store?.getSyncOutbox?.() || {};
    return {
      configured: Boolean(this.apiUrl && this.serial),
      paired: Boolean(platform.paired),
      serial: this.serial,
      apiUrl: this.apiUrl,
      agentSeenVersion: Number(platform.agentSeenVersion || 0),
      publishedVersion: Number(platform.publishedVersion || 0),
      acceptedTokenCount: Array.isArray(platform.acceptedTokenHashes) ? platform.acceptedTokenHashes.length : 0,
      syncIntervalMinutes: Number(platform.syncIntervalMinutes || 2),
      runtime: { ...this.runtime, capabilities: { ...this.runtime.capabilities } },
      lastSuccess: this.lastSuccess || platform.lastSyncAt || null,
      lastError: this.lastError || platform.lastError || null,
      sync: {
        streamId: sync.streamId || null,
        acknowledgedSequence: Number(sync.acknowledgedSequence || 0),
        queueDepth: Array.isArray(sync.events) ? sync.events.length : 0,
        lastSuccessfulSyncAt: sync.lastSuccessfulSyncAt || null,
        lastErrorCode: sync.lastErrorCode || null,
        criticalBacklog: sync.criticalBacklog === true,
        gapDetected: sync.gapDetected === true,
      },
      updater: platform.updaterStatus || { phase: "unavailable", trustState: "unavailable", activeReleaseVersion: null, lastAttempt: null, busy: false },
    };
  }

  async configure({ bootstrapSecret, apiUrl } = {}) {
    if (apiUrl) this.apiUrl = String(apiUrl).replace(/\/$/, "");
    if (bootstrapSecret && !this.legacyCompatibilityEnabled) throw new Error("Legacy bootstrap pairing is retired");
    if (bootstrapSecret && this.vault) await this.vault.set("platform.bootstrapSecret", String(bootstrapSecret).trim());
    await this.store.savePlatform({ apiUrl: this.apiUrl });
    return this.status();
  }

  loadManufacturingIdentity() {
    if (this.production && !this.identityBroker) throw new Error("The production identity broker is required");
    if (this.identityBroker) return null;
    const readKey = (name) => {
      const pem = this.vault?.get?.(name);
      return pem ? crypto.createPrivateKey(pem) : null;
    };
    const signingPrivateKey = readKey("platform.identityPrivateKey");
    const encryptionPrivateKey = readKey("platform.encryptionPrivateKey");
    const signingPublicPem = this.vault?.get?.("platform.identityPublicKey");
    const encryptionPublicPem = this.vault?.get?.("platform.encryptionPublicKey");
    if (!signingPrivateKey || !encryptionPrivateKey || !signingPublicPem || !encryptionPublicPem) return null;
    return {
      serial: this.serial,
      privateKey: signingPrivateKey,
      publicKey: crypto.createPublicKey(signingPublicPem),
      encryptionPrivateKey,
      encryptionPublicKey: crypto.createPublicKey(encryptionPublicPem),
      publicKeyFingerprint: String(this.vault?.get?.("platform.identityFingerprint") || ""),
      encryptionKeyFingerprint: String(this.vault?.get?.("platform.encryptionFingerprint") || ""),
      manufacturingSignature: String(this.vault?.get?.("platform.manufacturingCertificateSignature") || ""),
      generation: Number(this.vault?.get?.("platform.identityGeneration") || 0),
    };
  }

  async getPublicIdentity() {
    if (this.identityBroker) {
      const identity = await this.identityBroker.getPublicIdentity();
      return {
        serial: String(identity.serial || this.serial),
        publicKey: crypto.createPublicKey(String(identity.signingPublicKeyPem || "")),
        encryptionPublicKey: crypto.createPublicKey(String(identity.encryptionPublicKeyPem || "")),
        publicKeyPem: String(identity.signingPublicKeyPem || ""),
        encryptionPublicKeyPem: String(identity.encryptionPublicKeyPem || ""),
        publicKeyFingerprint: String(identity.publicKeyFingerprint || ""),
        encryptionKeyFingerprint: String(identity.encryptionKeyFingerprint || ""),
        manufacturingSignature: String(identity.manufacturingSignature || ""),
        generation: Number(identity.generation || 0),
      };
    }
    const identity = this.loadManufacturingIdentity();
    if (!identity) return null;
    return { ...identity, publicKeyPem: identity.publicKey.export({ type: "spki", format: "pem" }).toString(), encryptionPublicKeyPem: identity.encryptionPublicKey.export({ type: "spki", format: "pem" }).toString() };
  }

  async signPlatformRequest({ method = "POST", path, timestamp, nonce, bodyHash } = {}) {
    const canonical = [String(method), String(path), String(timestamp), String(nonce), String(bodyHash)].join("\n");
    if (this.identityBroker) return (await this.identityBroker.signPlatformRequest({ method, path, timestamp, nonce, bodyHash })).signature;
    const identity = this.loadManufacturingIdentity();
    if (!identity?.privateKey) throw new Error("A factory-enrolled hub signing identity is required");
    return crypto.sign(null, Buffer.from(canonical, "utf8"), identity.privateKey).toString("base64url");
  }

  async signCloudChallenge(payload) {
    if (this.identityBroker) return (await this.identityBroker.signCloudChallenge({ payload })).signature;
    const identity = this.loadManufacturingIdentity();
    if (!identity?.privateKey) throw new Error("A factory-enrolled hub signing identity is required");
    const canonical = canonicalCloudChallenge(payload);
    return crypto.sign(null, Buffer.from(canonical, "utf8"), identity.privateKey).toString("base64url");
  }

  async signStepUpDescriptor(payload) {
    const path = "/api/step-up/descriptor-challenge";
    const bodyHash = sha256(canonicalStepUpDescriptor(payload));
    if (this.identityBroker) {
      return (await this.identityBroker.signPlatformRequest({
        method: "POST",
        path,
        timestamp: Number(payload.issuedAt),
        nonce: String(payload.nonce),
        bodyHash,
      })).signature;
    }
    const identity = this.loadManufacturingIdentity();
    if (!identity?.privateKey) throw new Error("A hub signing identity is required");
    return crypto.sign(null, Buffer.from(canonicalHubRequest({ method: "POST", path, timestamp: Number(payload.issuedAt), nonce: String(payload.nonce), bodyHash }), "utf8"), identity.privateKey).toString("base64url");
  }

  async registerProvisioningAttempt({ pairing, baseUrl } = {}) {
    if (!pairing?.code || !pairing?.attemptId || !pairing?.expiresAt) throw new Error("A provisioning presentation is required");
    const identity = await this.getPublicIdentity();
    const manufacturingSignature = identity.manufacturingSignature || this.vault?.get?.("platform.manufacturingCertificateSignature");
    if (!identity || !manufacturingSignature) throw new Error("A factory-enrolled manufacturing identity is required");
    const envelopeBody = {
      version: 1,
      serial: identity.serial,
      identityGeneration: identity.generation,
      attemptId: pairing.attemptId,
      publicKeyPem: identity.publicKeyPem,
      encryptionPublicKeyPem: identity.encryptionPublicKeyPem,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      encryptionKeyFingerprint: identity.encryptionKeyFingerprint,
      baseUrl,
      issuedAt: Date.now(),
      expiresAt: pairing.expiresAt,
    };
    const hubSignature = this.identityBroker
      ? (await this.identityBroker.signProvisioningEnvelope({ payload: envelopeBody })).signature
      : crypto.sign(null, Buffer.from(JSON.stringify(envelopeBody), "utf8"), identity.privateKey).toString("base64url");
    const envelope = { ...envelopeBody, hubSignature, manufacturingSignature };
    const response = await this.fetchImpl(`${this.apiUrl}/api/hub-agent/v2/pairing/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ envelope, code: pairing.code }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `Platform returned HTTP ${response.status}`), { statusCode: response.status });
    await this.store.savePlatform({ apiUrl: this.apiUrl, hubInstallId: result.hubInstallId || null, provisioningAttemptId: result.attemptId || result.pairingId || null, manufacturingIdentityRegisteredAt: new Date().toISOString(), lastError: null });
    return result;
  }

  async request(path, body, secret) {
    if (!this.apiUrl) throw new Error("A native V2 platform URL is required");
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(18).toString("hex");
    const payload = { serial: this.serial, ts, nonce, sig: sign(secret, this.serial, ts, nonce), ...body };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || `Platform returned HTTP ${response.status}`), { statusCode: response.status });
    return result;
  }

  getSyncSecret() {
    return this.vault && this.vault.get("platform.syncSecret");
  }

  async requestWithSecret(path, body, secret) {
    return this.request(path, body, secret);
  }

  async pair(bootstrapSecret) {
    if (!this.legacyCompatibilityEnabled) throw new Error("Legacy bootstrap pairing is retired; use the signed provisioning presentation");
    const secret = String(bootstrapSecret || (this.vault && this.vault.get("platform.bootstrapSecret")) || "").trim();
    if (!secret) throw new Error("Bootstrap secret is required");
    const result = await this.request("/api/hub-agent/pair", {}, secret);
    if (result.syncSecret && this.vault) await this.vault.set("platform.syncSecret", String(result.syncSecret));
    await this.store.savePlatform({
      apiUrl: this.apiUrl,
      paired: true,
      agentSeenVersion: Number(result.latestVersion || result.publishedVersion || 0),
      publishedVersion: Number(result.publishedVersion || 0),
      acceptedTokenHashes: Array.isArray(result.hubTokenHashes) ? result.hubTokenHashes : [],
      syncIntervalMinutes: Number(result.platformSyncIntervalMinutes || 2),
      lastPairAt: new Date().toISOString(),
      lastError: null,
    });
    this.lastError = null;
    this.retryAttempt = 0;
    this.nextRetryAt = 0;
    return result;
  }

  async requestWithHubIdentity(path, body) {
    if (!this.apiUrl) throw new Error("A native V2 platform URL is required");
    const identity = await this.getPublicIdentity();
    if (!identity?.generation) throw new Error("A registered hub identity generation is required");
    const signedBody = { serial: this.serial, identityGeneration: Number(identity.generation), ...(body || {}) };
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(24).toString("base64url");
    const bodyHash = crypto.createHash("sha256").update(JSON.stringify(signedBody), "utf8").digest("hex");
    const platform = this.store.getPlatform?.() || {};
    const machineCredential = platform.paired ? this.vault?.get?.("platform.machineCredential") : null;
    const machineVersion = Number(platform.provisioningCredentialVersion || 0);
    const signature = machineCredential && machineVersion > 0
      ? crypto.createHmac("sha256", crypto.createHash("sha256").update(String(machineCredential), "utf8").digest("hex")).update(["POST", path, String(timestamp), nonce, bodyHash].join("\n"), "utf8").digest("base64url")
      : await this.signPlatformRequest({ method: "POST", path, timestamp, nonce, bodyHash });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      const headers = { "content-type": "application/json", accept: "application/json", "x-dinodia-hub-timestamp": String(timestamp), "x-dinodia-hub-nonce": nonce, "x-dinodia-body-sha256": bodyHash };
      if (machineCredential && machineVersion > 0) { headers["x-dinodia-machine-version"] = String(machineVersion); headers["x-dinodia-machine-signature"] = signature; } else headers["x-dinodia-hub-signature"] = signature;
      response = await this.fetchImpl(`${this.apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(signedBody), signal: controller.signal });
    } finally { clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || `Platform returned HTTP ${response.status}`), { statusCode: response.status });
    return result;
  }

  async buildLanEndpointObservation(identityGeneration) {
    const selected = await this.getLanEndpoint();
    const state = selected?.state === "CURRENT" && isPrivateIPv4(selected.address) ? "CURRENT" : "UNAVAILABLE";
    // The native HTTP contract has one fixed installer port. Do not derive it
    // from an ephemeral test listener or a configurable tenant transport.
    const setupPort = this.production ? 80 : this.haPort;
    const discoveryHost = `dinodia-${this.serial.toLowerCase()}.local`;
    let baseUrl;
    if (state === "CURRENT") {
      const candidate = String(selected.address || "");
      const parsed = new URL(`http://${candidate}:${setupPort}`);
      const normalizedPort = parsed.port || (parsed.protocol === "http:" ? "80" : "443");
      if (parsed.hostname !== candidate || normalizedPort !== String(setupPort) || parsed.pathname !== "/") throw new Error("The selected physical LAN endpoint is malformed");
      baseUrl = `http://${candidate}:${setupPort}`;
    }
    const previous = this.store?.getPlatform?.()?.lanEndpointObservation || null;
    if (previous && Number(previous.identityGeneration) !== Number(identityGeneration)) {
      throw Object.assign(new Error("LAN endpoint revision reset requires reviewed identity-generation recovery"), { code: "lan_endpoint_generation_reset_required" });
    }
    const same = previous
      && previous.state === state
      && String(previous.baseUrl || "") === String(baseUrl || "")
      && String(previous.discoveryHost || "") === discoveryHost
      && String(previous.interfaceName || "") === String(selected?.interfaceName || "");
    const revision = previous ? Number(previous.revision) + (same ? 0 : 1) : 1;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("The persisted LAN endpoint revision is invalid");
    const observation = { version: 1, revision, state, ...(baseUrl ? { baseUrl } : {}), discoveryHost };
    if (!validateLanEndpointObservation(observation, this.serial, setupPort)) throw new Error("The selected LAN endpoint does not match the canonical dinodia.v1 contract");
    await this.store.savePlatform({ lanEndpointObservation: { ...observation, interfaceName: selected?.interfaceName || null, identityGeneration: Number(identityGeneration) } });
    return observation;
  }

  async requestImmediateHeartbeat() {
    this.pendingEndpointHeartbeat = true;
    if (this.syncing) {
      this.queuedImmediateSync = true;
      return null;
    }
    return this.syncNow();
  }

  async getCloudflareReservation() {
    return this.requestWithHubIdentity("/api/hub-agent/v2/pairing/reservation", { serial: this.serial });
  }

  async requestPermanentClaimChallenge(reference) {
    const value = String(reference || '').trim();
    if (!value || value.length > 512) throw new Error("A permanent hub claim reference is required");
    const challenge = await this.requestWithHubIdentity("/api/hub-agent/v2/claim/resolver/challenge", { serial: this.serial, reference: value });
    if (!challenge?.challenge || !challenge.challengeId || !challenge.expiresAt) throw new Error("Platform did not issue a permanent hub claim challenge");
    const identity = await this.getPublicIdentity();
    const proof = { version: 1, serial: this.serial, identityGeneration: Number(identity.generation || 0), challengeId: String(challenge.challengeId), challenge: String(challenge.challenge), resolverGeneration: Number(challenge.resolverGeneration || 0), expiresAt: String(challenge.expiresAt) };
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(24).toString("base64url");
    const bodyHash = crypto.createHash("sha256").update(JSON.stringify(proof), "utf8").digest("hex");
    const hubSignature = await this.signPlatformRequest({ method: "POST", path: "/api/hub-agent/v2/claim/resolver/challenge", timestamp, nonce, bodyHash });
    return { ...proof, timestamp, nonce, bodyHash, hubSignature };
  }

  async reportCloudUrl(cloudUrl, metadata = {}) {
    const value = String(cloudUrl || "").trim().replace(/\/$/, "");
    if (!/^https:\/\/([a-z0-9-]+\.)*dinodiasmartliving\.com$/i.test(value)) throw new Error("A Dinodia company CloudURL is required");
    return this.requestWithHubIdentity("/api/hub-agent/v2/pairing/cloud-url", { serial: this.serial, cloudUrl: value, tunnelId: String(metadata.tunnelId || ""), tunnelName: String(metadata.tunnelName || ""), hostname: String(metadata.hostname || new URL(value).hostname), reservationToken: String(metadata.reservationToken || ""), ...(metadata.reverifyChallenge === true ? { reverifyChallenge: true } : {}) });
  }

  async decryptCredentialDelivery(delivery, purpose = "operator-credential") {
    if (!delivery?.envelope || !Number.isInteger(Number(delivery.version))) throw new Error("Invalid operator credential delivery");
    if (this.identityBroker) return (await this.identityBroker.decryptMachineCredentialEnvelope({ envelope: delivery.envelope, version: Number(delivery.version), purpose })).credential;
    const identity = this.loadManufacturingIdentity();
    if (!identity?.encryptionPrivateKey) throw new Error("A hub encryption identity is required");
    const envelope = delivery.envelope;
    if (envelope.algorithm !== "x25519-hkdf-sha256/aes-256-gcm") throw new Error("Unsupported operator credential envelope");
    const ephemeralPublicKey = crypto.createPublicKey(String(envelope.ephemeralPublicKeyPem || ""));
    if (ephemeralPublicKey.asymmetricKeyType !== "x25519") throw new Error("Invalid operator credential sender key");
    const shared = crypto.diffieHellman({ privateKey: identity.encryptionPrivateKey, publicKey: ephemeralPublicKey });
    if (String(envelope.purpose || "operator-credential") !== purpose) throw new Error("Credential delivery purpose does not match");
    const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(`dinodia-os-${purpose}`), Buffer.from(String(delivery.version)), 32));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(envelope.iv), "base64"));
    decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
    const credential = Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), "base64")), decipher.final()]).toString("utf8");
    return credential;
  }

  async acceptOperatorCredentialDelivery(delivery) {
    const credential = await this.decryptCredentialDelivery(delivery, "operator-credential");
    await this.vault.set(`platform.operatorCredential.${Number(delivery.version)}`, credential);
    const current = this.store.getPlatform?.() || {};
    // This compatibility method is retained for callers that only receive a
    // delivery envelope.  Delivery is not acknowledgement: it must remain
    // unusable until the hub sends the exact fingerprint back to Platform.
    await this.store.savePlatform({ operatorCredentialReceivedAt: new Date().toISOString(), operatorCredentialStates: [...(current.operatorCredentialStates || []).filter((entry) => Number(entry.version) !== Number(delivery.version)), { version: Number(delivery.version), state: 'DELIVERED', graceUntil: null }] });
    return Number(delivery.version);
  }

  async completeProvisioningHandshake() {
    const platform = this.store.getPlatform?.() || {};
    const attemptId = String(platform.provisioningAttemptId || "").trim();
    if (!attemptId || platform.paired) return null;
    const challenge = await this.requestWithHubIdentity("/api/hub-agent/v2/pairing/challenge", { serial: this.serial, attemptId });
    if (!challenge?.challenge) throw new Error("Platform did not issue a provisioning challenge");
    const delivery = await this.requestWithHubIdentity("/api/hub-agent/v2/pairing/prove", { serial: this.serial, attemptId, challenge: challenge.challenge });
    if (!delivery?.envelope || !Number.isInteger(Number(delivery.version))) throw new Error("Platform did not deliver an encrypted machine credential");
    const credential = await this.decryptCredentialDelivery(delivery, "machine-credential");
    const fingerprint = crypto.createHash("sha256").update(credential, "utf8").digest("hex");
    await this.vault.set("platform.machineCredential", credential);
    await this.requestWithHubIdentity("/api/hub-agent/v2/pairing/acknowledge", { serial: this.serial, attemptId, version: Number(delivery.version), credentialFingerprint: fingerprint });
    await this.store.savePlatform({ paired: true, provisioningCompletedAt: new Date().toISOString(), provisioningCredentialVersion: Number(delivery.version), provisioningAttemptId: attemptId, lastPairAt: new Date().toISOString(), lastError: null });
    return { paired: true, version: Number(delivery.version) };
  }

  async publishSignedHeartbeat(nativeIdentity) {
    const lanEndpoint = await this.buildLanEndpointObservation(nativeIdentity.generation);
    const lanTlsIdentity = this.getLanTlsIdentity();
    const heartbeat = await this.requestWithHubIdentity("/api/hub-agent/v2/heartbeat", {
      serial: this.serial,
      hubRuntime: this.store.getSyncRuntime?.(this.runtime) || this.runtime,
      lanEndpoint,
      ...(lanTlsIdentity ? { lanTlsIdentity } : {}),
    });
    if (Number(heartbeat?.lanEndpoint?.revision) !== lanEndpoint.revision || heartbeat?.lanEndpoint?.state !== lanEndpoint.state) {
      throw Object.assign(new Error("Platform did not acknowledge the current LAN endpoint revision"), { code: "lan_endpoint_ack_mismatch" });
    }
    const acknowledgedTlsGeneration = Number(heartbeat?.lanTlsIdentity?.acknowledgedGeneration || 0);
    if (acknowledgedTlsGeneration > 0 && !this.acknowledgeLanTlsIdentity(acknowledgedTlsGeneration)) {
      throw Object.assign(new Error("Platform acknowledged an unknown customer LAN certificate generation"), { code: "lan_tls_ack_mismatch" });
    }
    this.lastHeartbeatAt = this.clock();
    this.pendingEndpointHeartbeat = this.queuedImmediateSync;
    return heartbeat;
  }

  async syncNow() {
    if (this.syncing) return null;
    if (this.nextRetryAt && Date.now() < this.nextRetryAt) return null;
    let platform = this.store.getPlatform();
    if (!platform.paired && platform.provisioningAttemptId) {
      try { await this.completeProvisioningHandshake(); } catch (error) {
        this.lastError = String(error.message || error);
        await this.store.savePlatform({ lastError: this.lastError });
        return null;
      }
      platform = this.store.getPlatform();
    }
    if (!platform.paired) return null;
    this.syncing = true;
    let heartbeatIdentity = null;
    let heartbeatAuthorityConfirmed = false;
    try {
      await this.store.ensureSyncSnapshot?.(this.clock());
      await this.store.ensureSyncIncidentEvents?.(this.clock());
      await this.store.ensureAutomationOutcomeEvents?.(this.clock());
      const payload = {
        agentSeenVersion: Number(platform.agentSeenVersion || 0),
        hubRuntime: this.runtime,
        operatorCredentialVersion: Number(platform.operatorCredentialVersion || 0),
      };
      // Heartbeat is sent only after the signed bootstrap policy and complete
      // v2 configuration have been durably applied. On reconnect, the hub
      // cannot report normal liveness while it is still using stale policy.
      const nativeIdentity = await this.getPublicIdentity();
      heartbeatIdentity = nativeIdentity;
      const result = nativeIdentity
        ? await this.requestWithHubIdentity("/api/hub-agent/token-state", payload)
        : this.legacyCompatibilityEnabled && this.vault?.get("platform.syncSecret")
          ? await this.request("/api/hub-agent/token-state", payload, this.vault.get("platform.syncSecret"))
          : null;
      if (!result) throw new Error("A factory-enrolled hub identity is required for Platform synchronisation");
      const reportedHubInstallId = result.hubInstallId == null ? "" : String(result.hubInstallId);
      const hubInstallId = reportedHubInstallId || String(platform.hubInstallId || "");
      const developmentCompatibilityOnly = !nativeIdentity && this.legacyCompatibilityEnabled && !this.production;
      const installationSyncMode = result.installationSyncMode == null ? "ACTIVE" : String(result.installationSyncMode);
      if (!["ACTIVE", "INSTALLATION_BOOTSTRAP", "UNAVAILABLE"].includes(installationSyncMode)) {
        throw Object.assign(new Error("Platform returned an invalid installation sync mode"), { code: "installation_sync_mode_invalid" });
      }
      if (installationSyncMode === "UNAVAILABLE") {
        throw Object.assign(new Error("Platform has not granted current synchronization authority to this installation"), { code: "hub_sync_authority_changed" });
      }
      const serverAcceptedSequence = Number(result.syncAcceptedSequence ?? 0);
      const serverStreamId = result.syncStreamId == null ? null : String(result.syncStreamId);
      if (!Number.isSafeInteger(serverAcceptedSequence) || serverAcceptedSequence < 0
        || (serverStreamId !== null && (serverStreamId.length < 16 || serverStreamId.length > 80))) {
        throw Object.assign(new Error("Platform returned an invalid native sync cursor"), { code: "hub_sync_cursor_invalid" });
      }
      if (reportedHubInstallId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportedHubInstallId)) {
        throw Object.assign(new Error("Platform returned an invalid enrolled hub installation ID"), { code: "hub_installation_id_invalid" });
      }
      if (platform.hubInstallId && reportedHubInstallId && String(platform.hubInstallId) !== reportedHubInstallId) {
        throw Object.assign(new Error("Platform hub installation identity changed; refusing to rebind this paired OS"), { code: "hub_installation_id_changed" });
      }
      if (!hubInstallId && !developmentCompatibilityOnly) {
        throw Object.assign(new Error("Platform did not provide the enrolled hub installation ID required for native synchronisation"), { code: "hub_installation_id_missing" });
      }
      if (result.homeId !== undefined && (typeof result.homeId !== "string" || !result.homeId || result.homeId.length > 160)) throw new Error("Platform returned an invalid Native V1 home binding");
      const areaBindings = Array.isArray(result.areaBindings)
        ? result.areaBindings.filter((binding) => binding && typeof binding === "object" && !Array.isArray(binding)
          && Object.keys(binding).length === 2 && typeof binding.areaId === "string" && binding.areaId.length > 0 && binding.areaId.length <= 160
          && typeof binding.hubAreaId === "string" && binding.hubAreaId.length > 0 && binding.hubAreaId.length <= 160)
        : [];
      if (areaBindings.length !== (Array.isArray(result.areaBindings) ? result.areaBindings.length : 0)
        || new Set(areaBindings.map((binding) => binding.areaId)).size !== areaBindings.length
        || new Set(areaBindings.map((binding) => binding.hubAreaId)).size !== areaBindings.length) {
        throw new Error("Platform returned an invalid Native V1 area binding map");
      }
      const previousOperatorCredentialStates = Array.isArray(platform.operatorCredentialStates) ? platform.operatorCredentialStates : [];
      let operatorCredentialStates = Array.isArray(result.operatorCredentialStates)
        ? result.operatorCredentialStates.map((entry) => ({ version: Number(entry.version), state: String(entry.state || ''), graceUntil: entry.graceUntil || null }))
        : (platform.operatorCredentialStates || []);
      if (result.operatorCredentialDelivery) {
        const deliveredVersion = Number(result.operatorCredentialDelivery.version);
        const acceptedCredential = await this.decryptCredentialDelivery(result.operatorCredentialDelivery, "operator-credential");
        await this.vault.set(`platform.operatorCredential.${deliveredVersion}`, acceptedCredential);
        const currentPlatform = this.store.getPlatform?.() || {};
        // Receipt is durable before acknowledgement.  The credential must not
        // become usable as an operator session until Platform has accepted the
        // exact fingerprint.  If the acknowledgement fails, the next sync can
        // retry the same encrypted delivery without creating a second active
        // version.
        await this.store.savePlatform({ operatorCredentialReceivedAt: new Date().toISOString(), operatorCredentialStates: [...(currentPlatform.operatorCredentialStates || []).filter((entry) => Number(entry.version) !== deliveredVersion), { version: deliveredVersion, state: 'DELIVERED', graceUntil: null }] });
        const credentialFingerprint = crypto.createHash("sha256").update(acceptedCredential, "utf8").digest("hex");
        await this.requestWithHubIdentity("/api/hub-agent/v2/credentials/acknowledge", { version: deliveredVersion, credentialFingerprint });
        await this.requestWithHubIdentity("/api/hub-agent/v2/credentials/activate", { version: deliveredVersion, credentialFingerprint });
        operatorCredentialStates = [...operatorCredentialStates.filter((entry) => Number(entry.version) !== deliveredVersion), { version: deliveredVersion, state: 'ACTIVE', graceUntil: null }];
        await this.store.savePlatform({ operatorCredentialVersion: deliveredVersion, operatorCredentialStates });
      }
      const nextVersion = Math.max(Number(platform.agentSeenVersion || 0), Number(result.latestVersion || 0));
      const returnedHashes = Array.isArray(result.hubTokenHashes) && result.hubTokenHashes.length
        ? result.hubTokenHashes
        : (platform.acceptedTokenHashes || []);
      await this.store.savePlatform({
        paired: true,
        ...(hubInstallId ? { hubInstallId } : {}),
        agentSeenVersion: nextVersion,
        publishedVersion: Number(result.publishedVersion || platform.publishedVersion || 0),
        acceptedTokenHashes: returnedHashes,
        homeId: String(result.homeId || platform.homeId || "") || null,
        areaBindings,
        operatorCredentialStates,
        policyRevision: Number(result.policyRevision ?? platform.policyRevision ?? 0),
        syncIntervalMinutes: Number(result.platformSyncIntervalMinutes || platform.syncIntervalMinutes || 2),
        lastError: null,
      });
      // The deliberately isolated development compatibility adapter only
      // refreshes its legacy token allowlist. It has no Native V2 installation
      // authority, so it must not enter the durable cloud sync route.
      if (developmentCompatibilityOnly) {
        await this.onSyncResult(result, undefined, undefined, undefined, undefined);
        this.lastError = null;
        this.retryAttempt = 0;
        this.nextRetryAt = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        return result;
      }
      heartbeatAuthorityConfirmed = Boolean(nativeIdentity);
      await this.onOperatorCredentialStateChange({ previous: previousOperatorCredentialStates, current: operatorCredentialStates, now: Date.now(), hubId: this.serial });
      if (Array.isArray(result.offlineAuthorisations)) await this.acceptOfflineAuthorisations(result.offlineAuthorisations);
      const updaterStatus = await this.getUpdaterStatus().catch(() => null);
      if (updaterStatus) await this.store.ensureUpdaterStatusEvent?.(updaterStatus, this.clock());
      const syncState = this.store.getSyncOutbox();
      const bootstrapBatchOptions = installationSyncMode === "INSTALLATION_BOOTSTRAP"
        ? {
          allowedTypesPrefix: ["sync.compacted", "update.status", "area.upsert", "incident.transition"],
          allowedEventPrefix: (event) => event.type !== "incident.transition"
            || event.payload?.osDeviceId === null && /^(hub|integration)_/.test(String(event.payload?.kind || "")),
          serverAcceptedSequence, serverStreamId,
        }
        : {};
      const syncBatch = await this.store.prepareSyncBatch(hubInstallId, this.runtime, this.clock(), bootstrapBatchOptions);
      let syncResult = null;
      if (syncBatch || installationSyncMode === "ACTIVE") {
        const syncEnvelope = syncBatch || {
          schemaVersion: 1,
          hubInstallationId: hubInstallId,
          streamId: String(syncState.streamId),
          fromSequence: Number(syncState.acknowledgedSequence || 0) + 1,
          toSequence: Number(syncState.acknowledgedSequence || 0),
          events: [],
          queueDepth: 0,
          acknowledgedCloudRevision: Number(syncState.cloudRevision || 0),
          runtime: this.store.getSyncRuntime?.(this.runtime) || this.runtime,
          sentAt: new Date(this.clock()).toISOString(),
        };
        syncResult = await this.requestWithHubIdentity("/api/hub-agent/v2/sync", syncEnvelope);
        if (syncResult?.streamId !== syncEnvelope.streamId || !Number.isSafeInteger(Number(syncResult?.cloudRevision))
          || !syncResult?.configuration || syncResult.configuration.revision !== Number(syncResult.cloudRevision)) {
          throw Object.assign(new Error("Platform returned an invalid native sync acknowledgement/configuration"), { code: "sync_response_invalid" });
        }
        await applyCloudConfiguration(this.store, syncResult.configuration);
        if (syncBatch) {
          await this.store.acknowledgeSyncBatch({
            streamId: syncResult.streamId,
            acceptedThroughSequence: Number(syncResult.acceptedThroughSequence),
            cloudRevision: Number(syncResult.cloudRevision),
            configurationAppliedRevision: Number(syncResult.configurationAppliedRevision),
            resnapshotRequired: syncResult.resnapshotRequired === true,
          }, this.clock());
        } else {
          await this.store.acknowledgeSyncConfiguration(Number(syncResult.cloudRevision), this.clock());
        }
        await this.store.advanceSyncUsage?.(this.clock());
      }
      const heartbeatAt = this.clock();
      if (nativeIdentity && (installationSyncMode === "INSTALLATION_BOOTSTRAP" || this.pendingEndpointHeartbeat || heartbeatAt - this.lastHeartbeatAt >= this.heartbeatIntervalMs)) {
        await this.publishSignedHeartbeat(nativeIdentity);
      }
      await this.store.savePlatform({ ...(syncResult ? { lastSyncAt: new Date(this.clock()).toISOString() } : {}), lastError: null });
      await this.onSyncResult(result, undefined, undefined, undefined, undefined);
      // Alexa has a dedicated bounded synchroniser. Keeping it outside this
      // heartbeat prevents a catalogue update from delaying token/state sync.
      if (syncResult) this.lastSuccess = new Date().toISOString();
      this.lastError = null;
      const outboxAfterSync = this.store.getSyncOutbox?.();
      const nextPending = (outboxAfterSync?.events || []).find((event) => event.sequence > Number(outboxAfterSync?.acknowledgedSequence || 0));
      if (nextPending && (installationSyncMode === "ACTIVE" || (syncResult && nextPending.type === "area.upsert"))) {
        setImmediate(() => this.syncNow().catch(() => {}));
      }
      this.retryAttempt = 0;
      this.nextRetryAt = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (Number(result.publishedVersion || 0) >= nextVersion) this.publishAttempts = 0;
      else if (nextVersion > 0 && this.publishAttempts < 3) {
        this.publishAttempts += 1;
        setImmediate(() => this.syncNow().catch(() => {}));
      }
      return result;
    } catch (error) {
      this.lastError = String(error.message || error);
      this.retryAttempt = Math.min(this.retryAttempt + 1, 8);
      const errorCode = String(error?.code || "sync_failed").slice(0, 80);
      await this.store.markSyncFailure?.(errorCode).catch(() => {});
      // Heartbeat and sync are separate facts. Once current installation
      // authority has been confirmed, report the persisted queue/error snapshot
      // even when inventory ingestion itself failed. This does not advance the
      // sync receipt/cursor or acknowledge a newer cloud policy.
      if (heartbeatIdentity && heartbeatAuthorityConfirmed) {
        try { await this.publishSignedHeartbeat(heartbeatIdentity); }
        catch (heartbeatError) {
          const heartbeatCode = String(heartbeatError?.code || "heartbeat_report_failed");
          this.logger.warn(`[platform] signed queue-status heartbeat unavailable (${/^[a-z0-9_.:-]{1,80}$/i.test(heartbeatCode) ? heartbeatCode : "heartbeat_report_failed"})`);
        }
      }
      // Full-jitter exponential retry; the independent durable interval and
      // policy refresh continue even after a transient sync failure.
      const retryCeiling = Math.min(5 * 60_000, 1000 * (2 ** (this.retryAttempt - 1)));
      const retryDelay = Math.floor(Math.random() * retryCeiling);
      this.nextRetryAt = Date.now() + retryDelay;
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.syncNow().catch(() => {});
        }, retryDelay);
        this.retryTimer.unref?.();
      }
      if (this.store?.listPendingIncidentEnvelopes?.().length && this.store?.markIncidentUploadError) {
        await this.store.markIncidentUploadError(this.lastError).catch(() => {});
      }
      await this.store.savePlatform({ lastError: this.lastError });
      this.logger.error(`[platform] ${this.lastError}`);
      return null;
    } finally {
      this.syncing = false;
      if (this.queuedImmediateSync) {
        this.queuedImmediateSync = false;
        setImmediate(() => this.syncNow().catch(() => {}));
      }
    }
  }

  start() {
    if (!this.apiUrl || !this.serial) return;
    this.syncNow().catch(() => {});
    this.timer = setInterval(() => this.syncNow().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }
}

module.exports = { PlatformPairing, sign, privateLanIp, validateLanEndpointObservation };
