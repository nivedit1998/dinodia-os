const crypto = require("node:crypto");

const DEFAULT_TTL_MS = 10 * 60 * 1000;

class GoogleNestOAuthSession {
  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.current = null;
  }

  begin({ redirectUri, origin } = {}) {
    if (this.current && this.get(this.current.id)) throw Object.assign(new Error("A Google Nest authorization is already in progress"), { code: "setup_in_progress", statusCode: 409 });
    const id = crypto.randomUUID();
    const state = crypto.randomBytes(32).toString("base64url");
    const createdAt = this.now();
    this.current = { id, state, redirectUri: String(redirectUri || ""), origin: String(origin || ""), createdAt, expiresAt: createdAt + this.ttlMs, used: false };
    return { id, state, expiresAt: new Date(this.current.expiresAt).toISOString() };
  }

  get(id) {
    if (!this.current || String(this.current.id) !== String(id || "") || this.current.used) return null;
    if (this.now() >= this.current.expiresAt) {
      this.clear();
      return null;
    }
    return this.current;
  }

  consume(state) {
    const session = this.current;
    if (!session || session.used || this.now() >= session.expiresAt) {
      this.clear();
      return null;
    }
    const actual = Buffer.from(String(state || ""));
    const expected = Buffer.from(String(session.state || ""));
    if (!actual.length || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    session.used = true;
    this.current = null;
    return { ...session };
  }

  clear() {
    if (this.current) this.current.state = "";
    this.current = null;
  }

  status() {
    const current = this.current && this.get(this.current.id);
    return current ? { pending: true, expiresAt: new Date(current.expiresAt).toISOString() } : { pending: false, expiresAt: null };
  }
}

module.exports = { GoogleNestOAuthSession, DEFAULT_TTL_MS };
