// Bounded, dedicated Alexa projection synchronisation. This deliberately sits
// outside the general platform heartbeat so a large Alexa catalogue cannot
// delay ordinary hub/device synchronisation.
class AlexaPlatformSync {
  constructor({ pairing, store, buildCatalog, logger = console, debounceMs = 1000, stateFlushMs = 1000 } = {}) {
    this.pairing = pairing;
    this.store = store;
    this.buildCatalog = buildCatalog;
    this.logger = logger;
    this.debounceMs = Math.max(250, Number(debounceMs) || 1000);
    this.stateFlushMs = Math.max(250, Number(stateFlushMs) || 1000);
    this.catalogTimer = null;
    this.stateTimer = null;
    this.catalogInFlight = false;
    this.pendingState = new Map();
  }

  queueCatalog(reason = "device_changed") {
    if (this.catalogTimer) clearTimeout(this.catalogTimer);
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = null;
      this.pushCatalog(reason).catch((error) => this.logger.error(`[alexa] catalogue sync failed: ${error.message}`));
    }, this.debounceMs);
    this.catalogTimer.unref?.();
  }

  queueState(endpointId, state, available = true) {
    if (!endpointId) return;
    this.pendingState.set(String(endpointId), { endpointId: String(endpointId), state, available: available !== false });
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.flushState().catch((error) => this.logger.error(`[alexa] state sync failed: ${error.message}`));
    }, this.stateFlushMs);
    this.stateTimer.unref?.();
  }

  async pushCatalog(reason = "manual") {
    if (this.catalogInFlight || !this.pairing?.status?.().paired) return null;
    const secret = this.pairing.getSyncSecret?.();
    if (!secret) return null;
    this.catalogInFlight = true;
    try {
      const catalogue = this.buildCatalog();
      const result = await this.pairing.requestWithSecret("/api/hub-agent/alexa/catalog", { catalog: catalogue, reason }, secret);
      await this.store?.saveAlexa?.({ catalogRevision: catalogue.catalogRevision, endpointCount: catalogue.endpoints.length, lastSuccessfulSyncAt: new Date().toISOString(), errorCode: null });
      return result;
    } finally {
      this.catalogInFlight = false;
    }
  }

  async flushState() {
    if (!this.pendingState.size || !this.pairing?.status?.().paired) return null;
    const secret = this.pairing.getSyncSecret?.();
    if (!secret) return null;
    const updates = [...this.pendingState.values()].slice(0, 500);
    updates.forEach((item) => this.pendingState.delete(item.endpointId));
    try {
      return await this.pairing.requestWithSecret("/api/hub-agent/alexa/state-delta", { updates }, secret);
    } catch (error) {
      for (const update of updates) this.pendingState.set(update.endpointId, update);
      throw error;
    }
  }

  stop() {
    if (this.catalogTimer) clearTimeout(this.catalogTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.catalogTimer = null;
    this.stateTimer = null;
    this.pendingState.clear();
  }
}

module.exports = { AlexaPlatformSync };
