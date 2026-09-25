const crypto = require("node:crypto");

const DEFAULT_TTL_MS = 15 * 60 * 1000;

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

class ProvisioningPairingService {
  constructor({ serial, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, store = null, vault = null, logger = console } = {}) {
    this.serial = String(serial || "");
    this.now = now;
    this.ttlMs = ttlMs;
    this.store = store;
    this.vault = vault;
    this.logger = logger;
    this.current = null;
    this.pendingPersist = Promise.resolve();
    this.restore();
  }

  restore() {
    const persisted = this.store?.getSetup?.().pairing;
    if (!persisted || String(persisted.serial || "") !== this.serial || !persisted.codeVaultKey) return;
    const code = this.vault?.get?.(persisted.codeVaultKey);
    if (!code) return;
    this.current = { ...persisted, codeHash: hash(code) };
  }

  persist() {
    if (!this.store?.saveSetup || !this.current) return Promise.resolve();
    const { codeHash, ...safe } = this.current;
    this.pendingPersist = this.store.saveSetup({ pairing: safe }).catch((error) => {
      this.logger.warn?.(`[pairing] state persistence failed: ${error.message}`);
      throw error;
    });
    return this.pendingPersist;
  }

  async waitForPersistence() {
    await this.pendingPersist;
  }

  issue({ attemptId = crypto.randomUUID(), publicKeyFingerprint = "", baseUrl = "", browserNonce = "", browserId = "" } = {}) {
    const code = `DNO-${crypto.randomBytes(18).toString("base64url")}`;
    const issuedAt = Number(this.now());
    const codeVaultKey = `provisioning.pairing.code.${crypto.randomUUID()}`;
    this.current = {
      id: crypto.randomUUID(),
      attemptId: String(attemptId),
      serial: this.serial,
      publicKeyFingerprint: String(publicKeyFingerprint || ""),
      baseUrl: String(baseUrl || "").replace(/\/$/, ""),
      codeHash: hash(code),
      codeVaultKey,
      browserIdHash: browserId ? hash(browserId) : "",
      browserNonceHash: browserNonce ? hash(browserNonce) : "",
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      consumedAt: null,
      revokedAt: null,
      failures: 0,
    };
    if (this.vault?.set) {
      this.pendingPersist = this.vault.set(codeVaultKey, code).then(() => this.persist());
    } else {
      this.persist();
    }
    return {
      id: this.current.id,
      attemptId: this.current.attemptId,
      expiresAt: this.current.expiresAt,
      code,
      qrPayload: `dinodia-pairing-v1:${code}`,
    };
  }

  status(now = this.now()) {
    const value = this.current;
    if (!value) return { state: "not_issued", serial: this.serial };
    const expired = Number(now) >= value.expiresAt;
    return {
      state: value.revokedAt ? "revoked" : value.consumedAt ? "consumed" : expired ? "expired" : "active",
      serial: value.serial,
      expiresAt: value.expiresAt,
      failures: value.failures,
    };
  }

  matchesBrowserSession({ attemptId = "", browserNonce = "", browserId = "" } = {}) {
    const value = this.current;
    if (!value || value.revokedAt || value.consumedAt || Number(this.now()) >= value.expiresAt) return false;
    if (String(attemptId || "") !== value.attemptId || !value.browserNonceHash || !browserNonce || !value.browserIdHash || !browserId) return false;
    if (hash(browserId) !== value.browserIdHash) return false;
    const expected = Buffer.from(value.browserNonceHash, "hex");
    const supplied = Buffer.from(hash(browserNonce), "hex");
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }

  redeem({ code, attemptId, serial, publicKeyFingerprint, browserNonce = "", now = this.now() } = {}) {
    const value = this.current;
    const reason = (message) => ({ ok: false, errorCode: message });
    if (!value) return reason("pairing_not_issued");
    if (value.revokedAt) return reason("pairing_revoked");
    if (value.consumedAt) return reason("pairing_already_consumed");
    if (Number(now) >= value.expiresAt) return reason("pairing_expired");
    if (String(attemptId || "") !== value.attemptId || String(serial || "") !== value.serial) return reason("pairing_identity_mismatch");
    if (value.browserNonceHash && hash(browserNonce) !== value.browserNonceHash) return reason("setup_session_mismatch");
    if (value.publicKeyFingerprint && String(publicKeyFingerprint || "") !== value.publicKeyFingerprint) return reason("pairing_key_mismatch");
    if (!code || !crypto.timingSafeEqual(Buffer.from(hash(code)), Buffer.from(value.codeHash))) {
      value.failures += 1;
      if (value.failures >= 5) value.revokedAt = Number(now);
      this.persist();
      return reason("pairing_code_invalid");
    }
    value.consumedAt = Number(now);
    this.persist();
    return { ok: true, pairingId: value.id, attemptId: value.attemptId, serial: value.serial, baseUrl: value.baseUrl };
  }

  revoke() {
    if (this.current && !this.current.consumedAt) {
      this.current.revokedAt = Number(this.now());
      this.persist();
    }
  }
}

module.exports = { DEFAULT_TTL_MS, ProvisioningPairingService };
