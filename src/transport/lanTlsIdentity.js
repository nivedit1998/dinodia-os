"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

const execFileAsync = promisify(execFile);
const ROTATE_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
const CERTIFICATE_LIFETIME_DAYS = 730;

function publicId() {
  return crypto.randomBytes(10).toString("hex");
}

function safeId(value) {
  return typeof value === "string" && /^[a-f0-9]{20}$/.test(value);
}

function pinForCertificate(pem) {
  const certificate = pem instanceof crypto.X509Certificate ? pem : new crypto.X509Certificate(pem);
  const publicKey = certificate.publicKey.export({ type: "spki", format: "der" });
  return `sha256/${crypto.createHash("sha256").update(publicKey).digest("base64")}`;
}

function certificateDate(value, fallback) {
  const parsed = fallback === undefined ? Date.parse(value) : fallback;
  if (!Number.isFinite(parsed)) throw new Error("The customer LAN certificate has an invalid validity date");
  return parsed;
}

class LanTlsIdentity {
  constructor({ dataDir, runner = execFileAsync, now = () => Date.now() } = {}) {
    if (!dataDir) throw new TypeError("A persistent OS data directory is required");
    this.root = path.join(dataDir, "lan-tls");
    this.metadataPath = path.join(this.root, "identity.json");
    this.runner = runner;
    this.now = now;
    this.identity = null;
  }

  async initialize() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    let state = null;
    try { state = JSON.parse(fs.readFileSync(this.metadataPath, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw new Error("The persisted customer LAN identity is corrupt");
    }
    if (!state) state = { version: 1, publicHubId: publicId(), generation: 0, revision: 0, reportState: "CURRENT", acknowledgedGeneration: 0, current: null, next: null };
    if (state.version !== 1 || !safeId(state.publicHubId) || !Number.isSafeInteger(state.generation)
      || state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 0)
      || !Number.isSafeInteger(state.acknowledgedGeneration) || state.acknowledgedGeneration < 0
      || state.acknowledgedGeneration > state.generation) throw new Error("The persisted customer LAN identity is invalid");
    if (!Number.isSafeInteger(state.revision)) state.revision = Math.max(1, state.generation);
    if (state.reportState !== "CURRENT" && state.reportState !== "UNAVAILABLE") state.reportState = "CURRENT";
    if (!state.current) {
      state.current = await this.#generate(state.publicHubId, state.generation + 1, "current");
      state.generation = state.current.generation;
      state.revision += 1;
    }
    else this.#verifyStored(state, state.current);
    if (state.next) this.#verifyStored(state, state.next);
    const currentExpiration = Date.parse(state.current.notAfter);
    if (!state.next && currentExpiration - this.now() <= ROTATE_WITHIN_MS && this.now() < currentExpiration) {
      state.next = await this.#generate(state.publicHubId, Math.max(state.generation, state.current.generation) + 1, "next");
      state.generation = state.next.generation;
      state.revision += 1;
    }
    state.generation = Math.max(state.generation, state.current.generation, state.next?.generation || 0);
    if (state.current.notAfterMs <= this.now()) {
      if (!state.next || state.next.notBeforeMs > this.now() || state.acknowledgedGeneration < state.next.generation) {
        if (state.reportState !== "UNAVAILABLE") { state.reportState = "UNAVAILABLE"; state.revision += 1; }
        this.identity = state;
        this.#save();
        return this.publicReport();
      } else {
        state.current = state.next;
        state.next = null;
        state.revision += 1;
      }
    }
    if (state.reportState !== "CURRENT") { state.reportState = "CURRENT"; state.revision += 1; }
    this.identity = state;
    this.#save();
    return this.publicReport();
  }

  #verifyStored(state, record) {
    if (!record || !Number.isSafeInteger(record.generation) || record.generation < 1
      || typeof record.keyFile !== "string" || typeof record.certificateFile !== "string"
      || path.basename(record.keyFile) !== record.keyFile || path.basename(record.certificateFile) !== record.certificateFile
      || !/^[a-f0-9]{64}$/.test(String(record.spkiSha256 || ""))) throw new Error("The customer LAN certificate metadata is invalid");
    const keyPath = path.join(this.root, record.keyFile);
    const certificatePath = path.join(this.root, record.certificateFile);
    const keyStat = fs.statSync(keyPath);
    const certStat = fs.statSync(certificatePath);
    if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0 || !certStat.isFile()) throw new Error("The customer LAN TLS private key is not protected");
    const cert = new crypto.X509Certificate(fs.readFileSync(certificatePath));
    const expectedHost = `dinodia-${state.publicHubId}.local`;
    if (!cert.checkHost(expectedHost)) throw new Error("The customer LAN certificate public identity does not match its persisted hub ID");
    if (pinForCertificate(cert) !== `sha256/${Buffer.from(record.spkiSha256, "hex").toString("base64")}`
      || certificateDate(cert.validFrom) !== record.notBeforeMs || certificateDate(cert.validTo) !== record.notAfterMs) {
      throw new Error("The customer LAN certificate does not match its persisted identity");
    }
  }

  async #generate(hubId, generation, slot) {
    const host = `dinodia-${hubId}.local`;
    const prefix = `lan-${slot}-${generation}`;
    const keyFile = `${prefix}.key.pem`;
    const certificateFile = `${prefix}.cert.pem`;
    const keyPath = path.join(this.root, keyFile);
    const certificatePath = path.join(this.root, certificateFile);
    const temporaryKey = `${keyPath}.tmp`;
    const temporaryCertificate = `${certificatePath}.tmp`;
    await this.runner("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", temporaryKey], { timeout: 15_000 });
    fs.chmodSync(temporaryKey, 0o600);
    await this.runner("openssl", ["req", "-new", "-x509", "-sha256", "-key", temporaryKey, "-out", temporaryCertificate,
      "-days", String(CERTIFICATE_LIFETIME_DAYS), "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`,
      "-addext", "keyUsage=digitalSignature,keyAgreement", "-addext", "extendedKeyUsage=serverAuth"], { timeout: 15_000 });
    fs.chmodSync(temporaryCertificate, 0o644);
    fs.renameSync(temporaryKey, keyPath);
    fs.renameSync(temporaryCertificate, certificatePath);
    const certificate = new crypto.X509Certificate(fs.readFileSync(certificatePath));
    if (!certificate.checkHost(host)) throw new Error("Generated LAN certificate does not name its exact public hub hostname");
    const spki = certificate.publicKey.export({ type: "spki", format: "der" });
    return {
      generation,
      keyFile,
      certificateFile,
      spkiSha256: crypto.createHash("sha256").update(spki).digest("hex"),
      notBeforeMs: certificateDate(certificate.validFrom),
      notAfterMs: certificateDate(certificate.validTo),
      notBefore: new Date(certificateDate(certificate.validFrom)).toISOString(),
      notAfter: new Date(certificateDate(certificate.validTo)).toISOString(),
    };
  }

  #save() {
    const temporary = `${this.metadataPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.identity)}\n`, { mode: 0o600, flag: "w" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.metadataPath);
    fs.chmodSync(this.metadataPath, 0o600);
  }

  publicReport() {
    if (!this.identity) return null;
    const current = this.identity.current;
    return {
      version: 1,
      publicHubId: this.identity.publicHubId,
      revision: this.identity.revision,
      state: current.notBeforeMs <= this.now() && current.notAfterMs > this.now() ? "CURRENT" : "UNAVAILABLE",
      host: `dinodia-${this.identity.publicHubId}.local`,
      port: 8123,
      certificateGeneration: current.generation,
      currentSpkiPin: `sha256/${Buffer.from(current.spkiSha256, "hex").toString("base64")}`,
      currentNotBefore: current.notBefore,
      currentNotAfter: current.notAfter,
      ...(this.identity.next ? {
        nextCertificateGeneration: this.identity.next.generation,
        nextSpkiPin: `sha256/${Buffer.from(this.identity.next.spkiSha256, "hex").toString("base64")}`,
        nextNotBefore: this.identity.next.notBefore,
        nextNotAfter: this.identity.next.notAfter,
      } : {}),
      acknowledgedGeneration: this.identity.acknowledgedGeneration,
    };
  }

  acknowledge(generation) {
    if (!this.identity || !Number.isSafeInteger(generation) || !this.identity.next || generation !== this.identity.next.generation) return false;
    this.identity.acknowledgedGeneration = generation;
    this.#save();
    return true;
  }

  tlsOptions() {
    if (!this.identity) throw new Error("Customer LAN TLS identity has not been initialized");
    const current = this.identity.current;
    if (current.notBeforeMs > this.now() || current.notAfterMs <= this.now()) {
      if (this.identity.next && this.identity.acknowledgedGeneration >= this.identity.next.generation
        && this.identity.next.notBeforeMs <= this.now() && this.identity.next.notAfterMs > this.now()) {
        return { key: fs.readFileSync(path.join(this.root, this.identity.next.keyFile)), cert: fs.readFileSync(path.join(this.root, this.identity.next.certificateFile)), minVersion: "TLSv1.2" };
      }
      throw new Error("Customer LAN TLS certificate is outside its validity interval");
    }
    return { key: fs.readFileSync(path.join(this.root, current.keyFile)), cert: fs.readFileSync(path.join(this.root, current.certificateFile)), minVersion: "TLSv1.2" };
  }
}

module.exports = { LanTlsIdentity, pinForCertificate, ROTATE_WITHIN_MS, CERTIFICATE_LIFETIME_DAYS };
