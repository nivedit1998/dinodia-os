const crypto = require("node:crypto");

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 15 * 60 * 1000;

class HiveAuthSession {
  constructor({ now = () => Date.now(), ttlMs = SESSION_TTL_MS, logger = console } = {}) {
    this.now = now;
    this.ttlMs = Math.max(60_000, Number(ttlMs) || SESSION_TTL_MS);
    this.logger = logger;
    this.current = null;
    this.cooldownUntil = 0;
    this.attempts = 0;
  }

  begin(username, password) {
    if (this.now() < this.cooldownUntil) throw Object.assign(new Error("Hive authentication is temporarily paused after failed attempts"), { code: "authentication_rate_limited", statusCode: 429 });
    if (!String(username || "").trim() || !String(password || "")) throw Object.assign(new Error("Hive email and password are required"), { code: "invalid_credentials", statusCode: 400 });
    this.current = { id: crypto.randomUUID(), username: String(username).trim(), password: String(password), createdAt: this.now(), expiresAt: this.now() + this.ttlMs, attempts: 0 };
    return this.current;
  }

  get(id) {
    if (!this.current || String(this.current.id) !== String(id)) return null;
    if (this.now() >= this.current.expiresAt) {
      this.clear();
      return null;
    }
    return this.current;
  }

  recordFailure(id) {
    const session = this.get(id);
    if (!session) return;
    session.attempts += 1;
    this.attempts += 1;
    if (session.attempts >= MAX_ATTEMPTS || this.attempts >= MAX_ATTEMPTS) {
      this.cooldownUntil = this.now() + COOLDOWN_MS;
      this.clear();
    }
  }

  clear() {
    if (this.current) {
      this.current.password = "";
      this.current.username = "";
    }
    this.current = null;
  }

  resetFailures() {
    this.attempts = 0;
    this.cooldownUntil = 0;
  }

  sanitized(id) {
    const session = this.get(id);
    return session ? { sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() } : null;
  }
}

module.exports = { HiveAuthSession, SESSION_TTL_MS, MAX_ATTEMPTS, COOLDOWN_MS };
