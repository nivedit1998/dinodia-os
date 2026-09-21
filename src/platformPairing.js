const crypto = require("node:crypto");
const os = require("node:os");

function sign(secret, serial, ts, nonce) {
  return crypto.createHmac("sha256", String(secret)).update(`${serial}.${ts}.${nonce}`).digest("hex");
}

function privateLanIp() {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
    }
  }
  return "127.0.0.1";
}

class PlatformPairing {
  constructor({ store, vault, identityBroker = null, apiUrl = "", serial, haPort = 8123, intervalMs = 120000, runtime, getAreaSnapshot, getHeatingUsage, getHeatingUsageResetAck, getElectricUsage, getElectricUsageResetAck, getActivityIncidents, getAlexaCatalog, onSyncResult, logger = console, fetchImpl = fetch, legacyCompatibilityEnabled = false } = {}) {
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
    const canonical = JSON.stringify({ version: 1, serial: String(payload.serial), cloudUrl: String(payload.cloudUrl), challenge: String(payload.challenge), identityFingerprint: String(payload.identityFingerprint), identityGeneration: Number(payload.identityGeneration) });
    return crypto.sign(null, Buffer.from(canonical, "utf8"), identity.privateKey).toString("base64url");
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
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(24).toString("base64url");
    const bodyHash = crypto.createHash("sha256").update(JSON.stringify(body ?? null), "utf8").digest("hex");
    const signature = await this.signPlatformRequest({ method: "POST", path, timestamp, nonce, bodyHash });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-dinodia-hub-timestamp": String(timestamp), "x-dinodia-hub-nonce": nonce, "x-dinodia-hub-signature": signature }, body: JSON.stringify(body), signal: controller.signal });
    } finally { clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || `Platform returned HTTP ${response.status}`), { statusCode: response.status });
    return result;
  }

  async reportCloudUrl(cloudUrl) {
    const value = String(cloudUrl || "").trim().replace(/\/$/, "");
    if (!/^https:\/\/([a-z0-9-]+\.)*dinodiasmartliving\.com$/i.test(value)) throw new Error("A Dinodia company CloudURL is required");
    return this.requestWithHubIdentity("/api/hub-agent/v2/pairing/cloud-url", { serial: this.serial, cloudUrl: value });
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
    await this.store.savePlatform({ operatorCredentialVersion: Number(delivery.version), operatorCredentialReceivedAt: new Date().toISOString() });
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
    try {
      const heatingUsage = this.getHeatingUsage() || undefined;
      const heatingUsageResetAckAt = this.getHeatingUsageResetAck() || undefined;
      const electricUsage = this.getElectricUsage() || undefined;
      // The legacy reset epoch is intentionally shared by both local usage
      // trackers so platform/home-reset remains one atomic compatibility
      // contract for old and new hubs.
      const electricUsageResetAckAt = this.getElectricUsageResetAck() || undefined;
      const sharedUsageResetAckAt = heatingUsageResetAckAt || electricUsageResetAckAt;
      const activityIncidents = this.getActivityIncidents() || undefined;
      const payload = {
        agentSeenVersion: Number(platform.agentSeenVersion || 0),
        lanBaseUrl: `http://${privateLanIp()}:${this.haPort}`,
        hubRuntime: this.runtime,
        haAreas: this.getAreaSnapshot(),
        heatingUsage,
        heatingUsageResetAckAt: sharedUsageResetAckAt,
        electricUsage,
        activityIncidents,
        operatorCredentialVersion: Number(platform.operatorCredentialVersion || 0),
      };
      const result = (await this.getPublicIdentity())
        ? await this.requestWithHubIdentity("/api/hub-agent/token-state", payload)
        : this.legacyCompatibilityEnabled && this.vault?.get("platform.syncSecret")
          ? await this.request("/api/hub-agent/token-state", payload, this.vault.get("platform.syncSecret"))
          : null;
      if (!result) throw new Error("A factory-enrolled hub identity is required for Platform synchronisation");
      if (result.operatorCredentialDelivery) await this.acceptOperatorCredentialDelivery(result.operatorCredentialDelivery);
      const nextVersion = Math.max(Number(platform.agentSeenVersion || 0), Number(result.latestVersion || 0));
      const returnedHashes = Array.isArray(result.hubTokenHashes) && result.hubTokenHashes.length
        ? result.hubTokenHashes
        : (platform.acceptedTokenHashes || []);
      await this.store.savePlatform({
        paired: true,
        agentSeenVersion: nextVersion,
        publishedVersion: Number(result.publishedVersion || platform.publishedVersion || 0),
        acceptedTokenHashes: returnedHashes,
        syncIntervalMinutes: Number(result.platformSyncIntervalMinutes || platform.syncIntervalMinutes || 2),
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      });
      await this.onSyncResult(result, heatingUsage, heatingUsageResetAckAt, electricUsage, electricUsageResetAckAt);
      // Alexa has a dedicated bounded synchroniser. Keeping it outside this
      // heartbeat prevents a catalogue update from delaying token/state sync.
      this.lastSuccess = new Date().toISOString();
      this.lastError = null;
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
      const retryDelay = Math.min(15 * 60 * 1000, 5000 * (2 ** (this.retryAttempt - 1))) + Math.floor(Math.random() * 1000);
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

module.exports = { PlatformPairing, sign, privateLanIp };
