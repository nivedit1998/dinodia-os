const MAX_BACKOFF_MS = 15 * 60 * 1000;

class PollingUpdateSource {
  constructor({ intervalMs = 60_000, jitterMs = 5000, onPoll, now = () => Date.now(), logger = console } = {}) {
    this.intervalMs = Math.max(30_000, Number(intervalMs) || 60_000);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.onPoll = onPoll;
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.inFlight = false;
    this.nextPollAt = null;
    this.failureCount = 0;
  }
  schedule(delayOverrideMs) {
    this.stop();
    const normalDelay = this.intervalMs + (this.jitterMs ? Math.floor(Math.random() * this.jitterMs) : 0);
    const delay = Number.isFinite(Number(delayOverrideMs)) ? Math.max(30_000, Math.min(MAX_BACKOFF_MS, Number(delayOverrideMs))) : normalDelay;
    this.nextPollAt = new Date(this.now() + delay).toISOString();
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.inFlight) return this.schedule();
      this.inFlight = true;
      try {
        await this.onPoll?.();
        this.failureCount = 0;
      } catch (error) {
        this.failureCount += 1;
        this.logger.warn("[google-nest] scheduled poll failed: " + error.message);
      } finally {
        this.inFlight = false;
        if (!this.timer) {
          const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * (2 ** Math.max(0, this.failureCount - 1)));
          this.schedule(this.failureCount ? backoff : undefined);
        }
      }
    }, delay);
    this.timer.unref?.();
  }
  start() { this.schedule(); }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.nextPollAt = null; }
  status() { return { nextPollAt: this.nextPollAt, inFlight: this.inFlight, consecutiveFailures: this.failureCount }; }
}

module.exports = { PollingUpdateSource, MAX_BACKOFF_MS };
