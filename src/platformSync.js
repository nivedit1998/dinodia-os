class PlatformSync {
  constructor({ url, token, hubId, intervalMs, getSnapshot, logger = console }) {
    this.url = url;
    this.token = token;
    this.hubId = hubId;
    this.intervalMs = intervalMs;
    this.getSnapshot = getSnapshot;
    this.logger = logger;
    this.timer = null;
    this.lastSuccess = null;
    this.lastError = null;
  }

  start() {
    if (!this.url) return;
    this.send().catch(() => {});
    this.timer = setInterval(() => this.send().catch(() => {}), this.intervalMs);
  }

  async send() {
    if (!this.url) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ hubId: this.hubId, ...this.getSnapshot() }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`platform heartbeat returned HTTP ${response.status}`);
      this.lastSuccess = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error && error.message ? error.message : error);
      this.logger.error(`[platform] ${this.lastError}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  status() {
    return { configured: Boolean(this.url), lastSuccess: this.lastSuccess, lastError: this.lastError };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { PlatformSync };
