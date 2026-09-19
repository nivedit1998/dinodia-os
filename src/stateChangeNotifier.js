class StateChangeNotifier {
  constructor({ url = "", secret = "", logger = console, fetchImpl = fetch } = {}) {
    this.url = String(url || "").replace(/\/$/, "");
    this.secret = String(secret || "");
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.pending = new Map();
    this.lastSent = new Map();
    this.lastError = null;
    this.sent = 0;
    this.deduped = 0;
    this.failed = 0;
    this.dropped = 0;
  }

  configured() { return Boolean(this.url && this.secret); }

  status() { return { configured: this.configured(), sent: this.sent, deduped: this.deduped, failed: this.failed, dropped: this.dropped, pending: this.pending.size, lastError: this.lastError }; }

  enqueue(entityId, extra = {}) {
    if (!this.configured() || !entityId) return;
    const key = String(entityId);
    if (Date.now() - Number(this.lastSent.get(key) || 0) < 1000) {
      this.deduped += 1;
      return;
    }
    const current = this.pending.get(key);
    if (current) {
      current.extra = { ...current.extra, ...extra };
      this.deduped += 1;
      return;
    }
    this.pending.set(key, { extra: { ...extra }, attempts: 0 });
    const deliver = async () => {
      const item = this.pending.get(key);
      if (!item) return;
      try {
        const response = await this.fetchImpl(`${this.url}/api/homeassistant/state-change`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ entity_id: key, ...item.extra }),
        });
        if (!response.ok) throw new Error(`state-change returned HTTP ${response.status}`);
        this.pending.delete(key);
        this.lastSent.set(key, Date.now());
        this.sent += 1;
        this.lastError = null;
      } catch (error) {
        item.attempts += 1;
        this.lastError = String(error.message || error);
        this.failed += 1;
        this.logger.error(`[state-change] ${this.lastError}`);
        if (item.attempts >= 3) {
          this.pending.delete(key);
          this.dropped += 1;
          return;
        }
        const retry = setTimeout(() => deliver().catch(() => {}), 250 * (2 ** (item.attempts - 1)));
        retry.unref?.();
      }
    };
    setImmediate(() => deliver().catch(() => {}));
  }
}

module.exports = { StateChangeNotifier };
