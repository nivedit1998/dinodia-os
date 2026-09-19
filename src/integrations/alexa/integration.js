const { catalog, internalEndpoint, publicCatalog } = require("./catalogService");
const { executeDirective } = require("./directiveService");
const { validateCatalog } = require("./contracts");
const { AlexaPlatformSync } = require("./platformSync");

class AlexaIntegration {
  constructor({ store, pairing, serial, config = {}, getDevices, getAreas, executeControl, logger = console } = {}) {
    this.store = store;
    this.pairing = pairing;
    this.serial = String(serial || "");
    this.config = config;
    this.getDevices = getDevices || (() => []);
    this.getAreas = getAreas || (() => []);
    this.executeControl = executeControl;
    this.logger = logger;
    this.catalogue = null;
    this.catalogTimer = null;
    this.syncInFlight = false;
    this.receiptTtlMs = 10 * 60 * 1000;
    this.directiveInFlight = new Map();
    this.statusTimer = null;
    this.platformSync = new AlexaPlatformSync({ pairing, store, buildCatalog: () => this.publicCatalog(), logger });
  }

  state() {
    return this.store?.getAlexa?.() || { enabled: true, linked: false, status: "disconnected", endpointCount: 0 };
  }

  status() {
    const local = this.state();
    const pairing = this.pairing?.status?.() || {};
    return {
      available: this.config.alexaNativeEnabled !== false,
      enabled: this.config.alexaNativeEnabled !== false,
      state: local.status || (local.linked ? "linked" : "disconnected"),
      linked: Boolean(local.linked),
      endpointCount: Number(local.endpointCount || this.catalogue?.endpoints?.length || 0),
      catalogRevision: local.catalogRevision || this.catalogue?.catalogRevision || null,
      lastSuccessfulSyncAt: local.lastSuccessfulSyncAt || null,
      lastStatusCheckAt: local.lastStatusCheckAt || null,
      errorCode: local.errorCode || null,
      paired: Boolean(pairing.paired),
      nativeCapability: pairing.runtime?.capabilities?.alexaNativeProjectionV1 === true,
      lastError: pairing.lastError || null,
    };
  }

  buildCatalog() {
    const identity = this.store?.getIdentity?.() || {};
    const value = catalog({ serial: this.serial, instanceId: identity.instanceId || this.serial, devices: this.getDevices(), areas: this.getAreas() });
    const checked = validateCatalog(publicCatalog(value));
    if (!checked.ok) throw Object.assign(new Error(`Alexa catalogue rejected: ${checked.reason}`), { code: "catalog_invalid" });
    this.catalogue = value;
    return value;
  }

  publicCatalog() {
    return publicCatalog(this.catalogue || this.buildCatalog());
  }

  scheduleSync(reason = "device_changed") {
    this.platformSync.queueCatalog(reason);
  }

  async syncCatalog(reason = "manual") {
    const result = await this.platformSync.pushCatalog(reason);
    if (result) await this.store.saveAlexa({ status: this.state().linked ? "linked" : "disconnected" });
    return result;
  }

  async connect() {
    const secret = this.pairing.getSyncSecret?.();
    if (!secret) throw Object.assign(new Error("Dinodia OS is not paired with the platform"), { code: "platform_not_paired", statusCode: 409 });
    const result = await this.pairing.requestWithSecret("/api/hub-agent/alexa/connect-intents", {}, secret);
    await this.store.saveAlexa({ status: "connecting", lastStatusCheckAt: new Date().toISOString() });
    return result;
  }

  async refresh() {
    await this.syncCatalog("manual");
    const secret = this.pairing.getSyncSecret?.();
    if (secret) {
      const result = await this.pairing.requestWithSecret("/api/hub-agent/alexa/status", {}, secret).catch(() => null);
      if (result?.status) await this.store.saveAlexa({ status: String(result.status).toLowerCase(), linked: String(result.status) === "LINKED", lastStatusCheckAt: new Date().toISOString(), endpointCount: Number(result.endpointCount || this.state().endpointCount || 0) });
      await this.pairing.requestWithSecret("/api/hub-agent/alexa/reconcile", {}, secret).catch(() => {});
    }
    return this.status();
  }

  async disconnect() {
    const secret = this.pairing.getSyncSecret?.();
    if (!secret) throw Object.assign(new Error("Dinodia OS is not paired with the platform"), { code: "platform_not_paired", statusCode: 409 });
    const result = await this.pairing.requestWithSecret("/api/hub-agent/alexa/disconnect", { confirm: true }, secret);
    await this.store.saveAlexa({ linked: false, status: "disconnected", lastStatusCheckAt: new Date().toISOString() });
    return result;
  }

  async handleDirective(directive) {
    if (!this.catalogue) this.buildCatalog();
    const messageId = String(directive?.header?.messageId || "").trim();
    if (messageId) {
      const current = this.state().directiveReceipts || [];
      const existing = current.find((receipt) => receipt.messageId === messageId && (!receipt.expiresAt || Date.parse(receipt.expiresAt) > Date.now()));
      if (existing?.status === "completed" && existing.response) return existing.response;
      if (this.directiveInFlight.has(messageId)) return this.directiveInFlight.get(messageId);
    }
    const operation = (async () => {
      const endpoint = await executeDirective({ catalogue: this.catalogue, directive, executeControl: this.executeControl });
      this.buildCatalog();
      const currentEndpoint = require("./catalogService").internalEndpoint(this.catalogue, endpoint.endpointId) || endpoint;
      const response = { ok: true, endpointId: currentEndpoint.endpointId, state: currentEndpoint.state };
      if (messageId) {
        const receipts = (this.state().directiveReceipts || []).filter((receipt) => !receipt.expiresAt || Date.parse(receipt.expiresAt) > Date.now()).filter((receipt) => receipt.messageId !== messageId);
        receipts.unshift({ messageId, status: "completed", response, completedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.receiptTtlMs).toISOString() });
        await this.store.saveAlexa({ directiveReceipts: receipts });
      }
      this.platformSync.queueState(currentEndpoint.endpointId, currentEndpoint.state, currentEndpoint.available);
      this.scheduleSync("directive");
      return response;
    })();
    if (messageId) this.directiveInFlight.set(messageId, operation);
    try { return await operation; } finally { if (messageId) this.directiveInFlight.delete(messageId); }
  }

  async handleDeviceChanged() {
    this.scheduleSync("device_changed");
  }

  start() {
    this.buildCatalog();
    if (this.pairing?.status?.().paired) {
      this.scheduleSync("startup");
      this.statusTimer = setInterval(() => this.refresh().catch(() => {}), 30_000);
      this.statusTimer.unref?.();
    }
  }

  stop() {
    this.platformSync.stop();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    if (this.catalogTimer) clearTimeout(this.catalogTimer);
    this.catalogTimer = null;
  }
}

module.exports = { AlexaIntegration, internalEndpoint };
