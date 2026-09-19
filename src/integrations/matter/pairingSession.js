const crypto = require("node:crypto");

class MatterPairingSession {
  constructor({ matter, store, ttlMs = 5 * 60 * 1000, logger = console } = {}) {
    this.matter = matter;
    this.store = store;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.sessions = new Map();
    this.recent = [];
  }

  status() {
    return { active: [...this.sessions.values()].filter((session) => session.expiresAt > Date.now()).map((session) => this.publicSession(session)), recent: this.recent.map((item) => ({ ...item })) };
  }

  async start(code, networkOnly = false) {
    const value = String(code || "").trim();
    if (!value) throw Object.assign(new Error("Matter setup code is required"), { statusCode: 400, code: "invalid_code" });
    const id = crypto.randomUUID();
    const baselineNodeIds = new Set((this.store?.listDevices?.() || []).filter((device) => device.protocol === "matter").map((device) => String(device.protocolIdentity?.nodeId || "")));
    const session = { id, protocol: "matter", stage: "commissioning", codeLast4: value.slice(-4), networkOnly: Boolean(networkOnly), startedAt: new Date().toISOString(), expiresAt: Date.now() + this.ttlMs, error: null, deviceId: null, baselineNodeIds };
    this.sessions.set(id, session);
    try {
      await this.matter.commission(value, networkOnly);
      if (typeof this.matter.refresh === "function") await this.matter.refresh({ allowNew: true }).catch((error) => this.logger.warn?.(`[matter-pairing] refresh after commissioning: ${error.message}`));
      const added = (this.store?.listDevices?.() || []).find((device) => device.protocol === "matter" && !baselineNodeIds.has(String(device.protocolIdentity?.nodeId || "")));
      if (added) {
        session.deviceId = added.id;
        session.stage = added.setup?.status === "ready" ? "complete" : "needs_setup";
      } else if (this.store) {
        session.stage = "waiting_for_device";
      } else {
        // Keep the small no-store unit-test/mock integration useful. A real
        // Dinodia OS runtime always has a store and therefore waits for the
        // actual ingested node before declaring commissioning complete.
        session.stage = "complete";
      }
      session.completedAt = new Date().toISOString();
    } catch (error) {
      session.stage = "failed";
      session.error = String(error.message || error);
      this.recent.unshift({ id, protocol: "matter", stage: "failed", error: session.error, at: new Date().toISOString() });
      this.recent = this.recent.slice(0, 10);
      throw error;
    }
    return this.publicSession(session);
  }

  get(id) {
    const session = this.sessions.get(String(id));
    if (!session) return null;
    return this.publicSession(session);
  }

  cancel(id) {
    return this.sessions.delete(String(id));
  }

  forgetDevice(deviceId) {
    const id = String(deviceId || "");
    for (const [sessionId, session] of this.sessions.entries()) if (String(session.deviceId || "") === id) this.sessions.delete(sessionId);
    this.recent = this.recent.filter((item) => String(item.deviceId || "") !== id);
  }

  observeDevice(device) {
    if (!device || device.protocol !== "matter") return;
    for (const session of this.sessions.values()) {
      if (session.stage !== "commissioning" || session.baselineNodeIds?.has(String(device.protocolIdentity?.nodeId || ""))) continue;
      session.deviceId = device.id;
      session.stage = device.setup?.status === "ready" ? "complete" : "needs_setup";
      session.completedAt = session.completedAt || new Date().toISOString();
    }
  }

  publicSession(session) {
    if (!session) return null;
    const { codeLast4, id, protocol, stage, networkOnly, startedAt, completedAt, expiresAt, error, deviceId } = session;
    return { id, protocol, stage, networkOnly, startedAt, completedAt, expiresAt, codeLast4, error, deviceId };
  }
}

module.exports = { MatterPairingSession };
