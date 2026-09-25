class RevocationCoordinator {
  constructor({ closeCode = 4401 } = {}) {
    this.closeCode = closeCode;
    this.sockets = new Map();
  }

  track(socket, { fingerprint, jti, homeId, credentialVersion } = {}) {
    if (!socket || !fingerprint) return;
    const entry = { socket, fingerprint: String(fingerprint), jti: jti ? String(jti) : null, homeId: homeId == null ? null : String(homeId), credentialVersion: credentialVersion == null ? null : Number(credentialVersion) };
    const current = this.sockets.get(entry.fingerprint) || new Set();
    current.add(entry);
    this.sockets.set(entry.fingerprint, current);
    return () => this.untrack(entry);
  }

  untrack(entry) {
    const current = this.sockets.get(entry?.fingerprint);
    if (!current) return;
    current.delete(entry);
    if (current.size === 0) this.sockets.delete(entry.fingerprint);
  }

  revoke({ fingerprint, jti, homeId, credentialVersion, reason = "credential_revoked" } = {}) {
    let closed = 0;
    for (const [key, entries] of this.sockets.entries()) {
        if (fingerprint && key !== String(fingerprint)) continue;
        for (const entry of [...entries]) {
          if (jti && entry.jti !== String(jti)) continue;
          if (homeId != null && entry.homeId !== String(homeId)) continue;
          if (credentialVersion != null && entry.credentialVersion !== Number(credentialVersion)) continue;
        try { entry.socket.close?.(this.closeCode, String(reason).slice(0, 120)); } catch {}
        this.untrack(entry);
        closed += 1;
      }
    }
    return closed;
  }
}

module.exports = { RevocationCoordinator };
