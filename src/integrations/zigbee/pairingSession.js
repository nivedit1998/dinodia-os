class ZigbeePairingSession {
  constructor({ ttlSeconds = 120, logger = console } = {}) {
    this.ttlSeconds = Math.max(30, Math.min(Number(ttlSeconds) || 120, 254));
    this.logger = logger;
    this.reset();
  }

  start(expiresAt, seconds = this.ttlSeconds, knownIds = []) {
    this.state = {
      active: true,
      startedAt: new Date().toISOString(),
      expiresAt: expiresAt || new Date(Date.now() + seconds * 1000).toISOString(),
      found: [],
      foundDetails: {},
    };
    this.baseline = new Set((Array.isArray(knownIds) ? knownIds : []).map(String));
    return this.status();
  }

  stop() {
    this.state = { ...this.state, active: false, expiresAt: null };
    return this.status();
  }

  add(deviceId, details = {}) {
    const id = String(deviceId || "");
    if (this.state.active && id && !this.baseline.has(id) && !this.state.found.includes(id)) this.state.found.push(id);
    if (this.state.active && id && this.state.found.includes(id) && details && typeof details === "object") this.state.foundDetails[id] = { ...this.state.foundDetails[id], ...details };
    return this.status();
  }

  isNew(deviceId) {
    const id = String(deviceId || "");
    return Boolean(id && !this.baseline.has(id));
  }

  forget(deviceId) {
    const id = String(deviceId || "");
    this.state.found = this.state.found.filter((item) => item !== id);
    delete this.state.foundDetails[id];
    this.baseline.delete(id);
    return this.status();
  }

  status() {
    if (this.state.active && this.state.expiresAt && Date.parse(this.state.expiresAt) <= Date.now()) this.stop();
    return { ...this.state, found: [...this.state.found] };
  }

  reset() {
    this.state = { active: false, startedAt: null, expiresAt: null, found: [], foundDetails: {} };
    this.baseline = new Set();
  }
}

module.exports = { ZigbeePairingSession };
