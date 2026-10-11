const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function safeHostname(value) {
  const hostname = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!hostname) return "";
  if (!/^[a-z0-9.-]+$/i.test(hostname) || hostname.includes("..")) throw new Error("Cloudflare hostname is invalid");
  return hostname;
}

function isDinodiaCloudHostname(value) {
  const hostname = safeHostname(value);
  return Boolean(hostname && (hostname === "dinodiasmartliving.com" || hostname.endsWith(".dinodiasmartliving.com")));
}

function isPermanentRecoveryIdentityFailure(error) {
  return ["cloudflare_reservation_invalid", "cloudflare_reservation_identity_mismatch", "cloudflare_local_identity_invalid"].includes(String(error?.code || ""));
}

function verifyLocalTunnelCredential({ dataDir, tunnelId, tunnelName, hostname, origin }) {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(String(tunnelId || "")) || !/^[a-z0-9][a-z0-9 ._-]{1,62}$/i.test(String(tunnelName || ""))) return false;
    const cloudflareHome = path.join(String(dataDir || ""), "cloudflared");
    const configPath = path.join(cloudflareHome, "config.yml");
    const configStat = fs.lstatSync(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink()) return false;
    const config = fs.readFileSync(configPath, "utf8");
    const configuredId = config.match(/^tunnel:\s*(\S+)\s*$/m)?.[1] || "";
    const configuredCredential = config.match(/^credentials-file:\s*(\S+)\s*$/m)?.[1] || "";
    const configuredHostname = config.match(/^\s*- hostname:\s*(\S+)\s*$/m)?.[1] || "";
    const configuredOrigin = config.match(/^\s*service:\s*(\S+)\s*$/m)?.[1] || "";
    const expectedCredential = path.join(cloudflareHome, ".cloudflared", `${tunnelId}.json`);
    if (configuredId !== tunnelId || path.resolve(configuredCredential) !== path.resolve(expectedCredential)
      || configuredHostname !== hostname || configuredOrigin !== origin
      || !config.includes("  - service: http_status:404")) return false;
    const credentialStat = fs.lstatSync(expectedCredential);
    if (!credentialStat.isFile() || credentialStat.isSymbolicLink() || (credentialStat.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === "function" && credentialStat.uid !== process.getuid()) return false;
    const credential = JSON.parse(fs.readFileSync(expectedCredential, "utf8"));
    return credential && String(credential.TunnelID || "") === tunnelId
      && typeof credential.TunnelSecret === "string"
      && /^[A-Za-z0-9+/=]{32,512}$/.test(credential.TunnelSecret)
      && typeof credential.AccountTag === "string"
      && /^[A-Za-z0-9_-]{8,128}$/.test(credential.AccountTag);
  } catch {
    // Never include tunnel credential contents or filesystem details in a
    // status/error response. A mismatch simply prevents remote verification.
    return false;
  }
}

function connectedLocalTunnelIdentity(status, requestHost, claimedTunnelId = "", claimedTunnelName = "") {
  if (!status || status.mode !== "local" || status.running !== true || status.connected !== true || status.connectorIdentityVerified !== true) return { ok: false, reason: "connector_unavailable" };
  const tunnelId = String(status.tunnelId || "").trim();
  const tunnelName = String(status.tunnelName || "").trim();
  let hostname;
  let publicUrl;
  try {
    hostname = safeHostname(status.hostname);
    publicUrl = new URL(String(status.publicUrl || ""));
  } catch {
    return { ok: false, reason: "connector_identity_invalid" };
  }
  if (!tunnelId || !tunnelName || !hostname || !isDinodiaCloudHostname(hostname)
    || publicUrl.protocol !== "https:" || publicUrl.hostname.toLowerCase() !== hostname.toLowerCase()
    || publicUrl.username || publicUrl.password || publicUrl.port || publicUrl.pathname !== "/"
    || String(requestHost || "").trim().toLowerCase() !== hostname.toLowerCase()) {
    return { ok: false, reason: "connector_identity_invalid" };
  }
  if ((claimedTunnelId && String(claimedTunnelId) !== tunnelId)
    || (claimedTunnelName && String(claimedTunnelName) !== tunnelName)) {
    return { ok: false, reason: "connector_identity_mismatch" };
  }
  return { ok: true, tunnelId, tunnelName, hostname, cloudUrl: `https://${hostname}` };
}

class CloudflareTunnel {
  constructor({ store, vault, origin = "http://127.0.0.1:8123", binary = "cloudflared", initialToken = "", initialHostname = "", dataDir = process.cwd(), nodeEnv = process.env.NODE_ENV || "development", logger = console, spawnImpl = spawn, fetchImpl = globalThis.fetch, clock = () => Date.now(), retryBaseMs = 5000, maxRetryDelayMs = 300000, healthIntervalMs = 30000, metricsAddress = "127.0.0.1:20241", originFailureGraceMs = 90000 } = {}) {
    this.store = store;
    this.vault = vault;
    this.nodeEnv = String(nodeEnv || "development");
    this.origin = origin;
    this.binary = binary;
    this.allowInitialToken = String(nodeEnv) !== "production";
    this.initialToken = this.allowInitialToken ? String(initialToken || "").trim() : "";
    this.initialHostname = String(initialHostname || "").trim();
    this.dataDir = String(dataDir || process.cwd());
    this.cloudflareHome = path.join(this.dataDir, "cloudflared");
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.retryBaseMs = Math.max(25, Number(retryBaseMs) || 5000);
    this.maxRetryDelayMs = Math.max(this.retryBaseMs, Number(maxRetryDelayMs) || 300000);
    this.healthIntervalMs = Math.max(1000, Number(healthIntervalMs) || 30000);
    this.metricsAddress = String(metricsAddress || "127.0.0.1:20241");
    this.originFailureGraceMs = Math.max(this.healthIntervalMs, Number(originFailureGraceMs) || 90000);
    this.process = null;
    this.processGeneration = 0;
    this.processStartedAt = 0;
    this.intentionalChildren = new WeakSet();
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.healthTimer = null;
    this.healthProbeInFlight = false;
    this.edgeDownSince = null;
    this.reservationProvider = null;
    this.statusObserver = null;
    this.transport = { sampledAt: null, originState: "UNKNOWN", edgeState: "UNKNOWN", activeConnections: null };
    this.loginProcess = null;
    this.lastError = null;
    this.publicUrl = "";
    this.connected = false;
    this.setup = { state: "idle", authUrl: "", tunnelName: "", hostname: "", reservationToken: "", error: null };
  }

  settings() {
    const stored = this.store?.getCloudflare?.() || {};
    const storedMode = stored.mode || "disabled";
    const hasLegacyLocalState = storedMode === "local" && stored.tunnelId && stored.tunnelName && stored.hostname;
    const explicitlyHeld = Boolean(stored.explicitHoldAt) || stored.recoveryIntent === "held";
    const localArtifactsExist = storedMode === "disabled" && !stored.recoveryIntent
      && Boolean(this.localTunnelConfig()?.tunnelId);
    return {
      mode: storedMode === "disabled" && this.initialToken ? "named" : storedMode,
      token: (this.vault && this.vault.get("cloudflare.token")) || stored.token || this.initialToken,
      hostname: stored.hostname || this.initialHostname,
      tunnelName: stored.tunnelName || "",
      tunnelId: stored.tunnelId || "",
      recoveryIntent: explicitlyHeld ? "held" : stored.recoveryIntent || (hasLegacyLocalState ? "enabled" : localArtifactsExist ? "ambiguous" : storedMode === "disabled" ? "unconfigured" : "enabled"),
    };
  }

  setReservationProvider(provider) { this.reservationProvider = typeof provider === "function" ? provider : null; }

  setStatusObserver(observer) { this.statusObserver = typeof observer === "function" ? observer : null; }

  observeStatus() {
    try { this.statusObserver?.(this.status()); } catch { /* status observers cannot stop local recovery */ }
  }

  async currentReservedIdentity(reservation = null) {
    const current = reservation || await this.reservationProvider?.();
    if (!current || typeof current !== "object") throw Object.assign(new Error("The current signed installation tunnel reservation is unavailable"), { code: "cloudflare_reservation_unavailable" });
    const tunnelId = String(current.tunnelId || "").trim();
    const tunnelName = String(current.reservedTunnelName || "").trim();
    const hostname = safeHostname(current.reservedHostname);
    if (!/^[a-f0-9-]{36}$/i.test(tunnelId) || !/^[a-z0-9][a-z0-9 ._-]{1,62}$/i.test(tunnelName)
      || !hostname || !isDinodiaCloudHostname(hostname)
      || !/^[A-Za-z0-9_-]{32,256}$/.test(String(current.reservationToken || ""))) {
      throw Object.assign(new Error("The current signed tunnel reservation is incomplete"), { code: "cloudflare_reservation_invalid" });
    }
    return { tunnelId, tunnelName, hostname, reservationToken: String(current.reservationToken || "") };
  }

  async verifyCurrentReservation(settings = this.settings(), reservation = null) {
    const current = await this.currentReservedIdentity(reservation);
    if (settings.tunnelId !== current.tunnelId || settings.tunnelName !== current.tunnelName || safeHostname(settings.hostname) !== current.hostname) {
      throw Object.assign(new Error("The saved tunnel does not match this installation's current signed reservation"), { code: "cloudflare_reservation_identity_mismatch" });
    }
    if (!this.localConnectorIdentityVerified({ ...settings, mode: "local" })) {
      throw Object.assign(new Error("The saved tunnel configuration or private credential did not verify"), { code: "cloudflare_local_identity_invalid" });
    }
    return current;
  }

  async start() {
    const stored = this.store ? this.store.getCloudflare() : {};
    if (stored.token && this.vault) {
      this.vault.set("cloudflare.token", stored.token)
        .then(() => this.store.saveCloudflare({ token: "", origin: this.origin }))
        .catch((error) => this.logger.error(`[cloudflare] secret migration failed: ${error.message}`));
    }
    const settings = this.settings();
    if (settings.mode === "local" && settings.tunnelId && settings.tunnelName && settings.recoveryIntent !== "held") {
      try {
        if (this.nodeEnv === "production") await this.verifyCurrentReservation(settings);
        else if (!this.localConnectorIdentityVerified(settings)) throw Object.assign(new Error("The saved local tunnel identity or credential did not verify"), { code: "cloudflare_local_identity_invalid" });
        this.startLocal(settings);
      } catch (error) {
        this.lastError = String(error.code || "cloudflare_recovery_unavailable").slice(0, 80);
        this.observeStatus();
        if (!isPermanentRecoveryIdentityFailure(error)) this.scheduleRecovery();
      }
    }
    if (settings.mode === "named" && settings.token) this.startNamed(settings.token, settings.hostname);
    if (settings.mode === "quick" && this.nodeEnv !== "production") this.spawnTunnel(["tunnel", "--no-autoupdate", "--url", this.origin]);
  }

  runtimeEnv() {
    return { ...process.env, HOME: this.cloudflareHome };
  }

  async ensureCloudflareHome() {
    await fsp.mkdir(path.join(this.cloudflareHome, ".cloudflared"), { recursive: true, mode: 0o700 });
  }

  async runCommand(args) {
    await this.ensureCloudflareHome();
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd: this.cloudflareHome, env: this.runtimeEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk) => { output += chunk.toString(); if (output.length > 128 * 1024) output = output.slice(-128 * 1024); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("exit", (code, signal) => code === 0 ? resolve(output) : reject(new Error(`cloudflared ${args[1] || args[0]} failed${signal ? ` (${signal})` : ` with code ${code}`}: ${output.trim().slice(-1000)}`)));
    });
  }

  async beginSetup({ tunnelName, hostname, reservationToken = "" } = {}) {
    if (this.nodeEnv === "production") throw Object.assign(new Error("Production setup cannot create or route a tunnel. Use recovery for this installation's exact existing signed reservation."), { code: "cloudflare_setup_retired" });
    const stored = this.store?.getCloudflare?.() || {};
    if (stored.recoveryIntent === "held" || stored.explicitHoldAt) throw Object.assign(new Error("Secure access is deliberately on hold; clear the hold through the separate authorized maintenance action"), { code: "cloudflare_recovery_held" });
    const cleanHostname = safeHostname(hostname);
    if (!cleanHostname || !isDinodiaCloudHostname(cleanHostname)) throw new Error("Cloudflare hostname must use a dinodiasmartliving.com host");
    const cleanName = String(tunnelName || "").trim();
    if (!cleanName || !/^[a-z0-9][a-z0-9 ._-]{1,62}$/i.test(cleanName)) throw new Error("Cloudflare tunnel name must be 2–63 characters and contain only letters, numbers, spaces, dots, hyphens, or underscores");
    await this.ensureCloudflareHome();
    await this.stopLogin();
    if (this.nodeEnv === "production" && !/^[A-Za-z0-9_-]{32,256}$/.test(String(reservationToken))) throw new Error("An installation-specific Cloudflare reservation is required");
    if (reservationToken && this.vault) await this.vault.set("cloudflare.reservationToken", String(reservationToken));
    this.setup = { state: "authorizing", authUrl: "", tunnelName: cleanName, hostname: cleanHostname, reservationToken: String(reservationToken || ""), error: null };
    const child = spawn(this.binary, ["tunnel", "login"], { cwd: this.cloudflareHome, env: this.runtimeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    this.loginProcess = child;
    const collect = (chunk) => {
      const output = chunk.toString();
      const match = output.match(/https:\/\/dash\.cloudflare\.com\/[^\s]+/i);
      if (match) this.setup.authUrl = match[0].replace(/[),.]$/, "");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => { this.loginProcess = null; this.setup = { ...this.setup, state: "error", error: error.code === "ENOENT" ? "cloudflared is not installed" : error.message }; });
    child.on("exit", (code, signal) => {
      if (this.loginProcess === child) this.loginProcess = null;
      if (code === 0) this.setup = { ...this.setup, state: "authorized", error: null };
      else if (this.setup.state !== "error") this.setup = { ...this.setup, state: "error", error: `Cloudflare authorization exited with code ${code}${signal ? ` (${signal})` : ""}` };
    });
    return this.status();
  }

  async stopLogin() {
    const child = this.loginProcess;
    this.loginProcess = null;
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  }

  async findTunnelId(name, { attempts = 4 } = {}) {
    const expectedName = String(name || "").trim().toLowerCase();
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      const output = await this.runCommand(["tunnel", "list", "--output", "json"]);
      let tunnels;
      try { tunnels = JSON.parse(output); } catch { tunnels = []; }
      const id = (Array.isArray(tunnels) ? tunnels : []).find((item) => String(item.name || "").trim().toLowerCase() === expectedName)?.id || "";
      if (id) return String(id);
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    return "";
  }

  localTunnelConfig() {
    const configPath = path.join(this.cloudflareHome, "config.yml");
    try {
      const content = fs.readFileSync(configPath, "utf8");
      const tunnelId = content.match(/^tunnel:\s*(\S+)\s*$/m)?.[1] || "";
      const credentialsFile = content.match(/^credentials-file:\s*(\S+)\s*$/m)?.[1] || "";
      const hostname = content.match(/^\s*- hostname:\s*(\S+)\s*$/m)?.[1] || "";
      return { tunnelId, credentialsFile, hostname };
    } catch {
      return null;
    }
  }

  localConnectorIdentityVerified(settings = this.settings()) {
    return settings.mode === "local" && verifyLocalTunnelCredential({
      dataDir: this.dataDir,
      tunnelId: settings.tunnelId,
      tunnelName: settings.tunnelName,
      hostname: safeHostname(settings.hostname),
      origin: this.origin,
    });
  }

  existingTunnelIdForSafeResume({ tunnelName, hostname, listedTunnelId }) {
    const local = this.localTunnelConfig();
    const credentialsFile = path.join(this.cloudflareHome, ".cloudflared", `${listedTunnelId}.json`);
    if (!fs.existsSync(credentialsFile)) throw new Error("The staged Cloudflare tunnel credential is missing; refusing to adopt the existing tunnel");
    if (local?.tunnelId === listedTunnelId && local.hostname === hostname) return listedTunnelId;
    // A previous attempt may have written a config for a different tunnel
    // before Cloudflare's list became authoritative. The durable reservation,
    // exact listed name and matching local credential are the only evidence
    // accepted for repairing that interrupted local state.
    if (local?.tunnelId && local.tunnelId !== listedTunnelId) return listedTunnelId;
    if (!local?.tunnelId) return listedTunnelId;
    const localCredentialsFile = local.credentialsFile || path.join(this.cloudflareHome, ".cloudflared", `${local.tunnelId}.json`);
    if (!fs.existsSync(localCredentialsFile)) throw new Error("The staged Cloudflare tunnel configuration is inconsistent; refusing to adopt the existing tunnel");
    return listedTunnelId;
  }

  async finishSetup() {
    if (this.nodeEnv === "production") throw Object.assign(new Error("Production setup cannot create or route a tunnel. Reconnect the exact existing signed reservation instead."), { code: "cloudflare_setup_retired" });
    const currentIntent = this.store?.getCloudflare?.() || {};
    if (currentIntent.recoveryIntent === "held" || currentIntent.explicitHoldAt) throw Object.assign(new Error("Secure access is deliberately on hold; setup cannot override the maintenance hold"), { code: "cloudflare_recovery_held" });
    if (this.setup.state === "authorizing" || this.loginProcess) throw new Error("Finish authorization in the Cloudflare browser tab first, then try again");
    const stored = this.settings();
    const retryExisting = stored.mode === "local" && stored.tunnelId && stored.tunnelName && stored.hostname;
    if (this.setup.state !== "authorized" && !retryExisting) throw new Error(this.setup.error || "Start Cloudflare setup first");
    const { tunnelName, hostname } = this.setup.state === "authorized" ? this.setup : stored;
    let tunnelId = "";
    if (retryExisting) {
      // A resumed paired hub deliberately has no account-wide cert.pem. The
      // durable installation record, local config and tunnel credential are
      // sufficient to retry the signed Platform report; account-level list,
      // create and DNS-route commands must never be needed here.
      tunnelId = String(stored.tunnelId);
      const local = this.localTunnelConfig();
      const credentialPath = path.join(this.cloudflareHome, ".cloudflared", `${tunnelId}.json`);
      if (!local || local.tunnelId !== tunnelId || local.hostname !== hostname || !fs.existsSync(credentialPath)) {
        throw new Error("The paired Cloudflare tunnel state is incomplete or inconsistent; refusing to resume it");
      }
    } else {
      tunnelId = await this.findTunnelId(tunnelName);
      if (tunnelId) {
        tunnelId = this.existingTunnelIdForSafeResume({ tunnelName, hostname, listedTunnelId: tunnelId });
      } else {
        try {
          await this.runCommand(["tunnel", "create", tunnelName]);
        } catch (error) {
          // Cloudflare can make the tunnel visible after the create request has
          // already returned an error. Recover only when the exact reserved
          // name and its local credential become visible on retry.
          const recoveredId = await this.findTunnelId(tunnelName, { attempts: 8 });
          if (!recoveredId) throw error;
          tunnelId = this.existingTunnelIdForSafeResume({ tunnelName, hostname, listedTunnelId: recoveredId });
        }
        if (tunnelId) {
          // The create race recovered the authoritative existing tunnel.
        } else {
          tunnelId = await this.findTunnelId(tunnelName, { attempts: 8 });
        }
        if (!tunnelId) throw new Error("Cloudflare created the tunnel but its ID could not be found");
      }
    }
    const credentialPath = path.join(this.cloudflareHome, ".cloudflared", `${tunnelId}.json`);
    if (!fs.existsSync(credentialPath)) throw new Error("Cloudflare tunnel credentials were not created");
    const configPath = path.join(this.cloudflareHome, "config.yml");
    const config = [`tunnel: ${tunnelId}`, `credentials-file: ${credentialPath}`, "ingress:", `  - hostname: ${hostname}`, `    service: ${this.origin}`, "  - service: http_status:404", ""].join("\n");
    await fsp.writeFile(configPath, config, { mode: 0o600 });
    if (!retryExisting) await this.runCommand(["tunnel", "route", "dns", tunnelName, hostname]);
    // The account-wide browser certificate is only needed to create the named
    // tunnel. Never retain it as a long-lived hub secret.
    await fsp.rm(path.join(this.cloudflareHome, ".cloudflared", "cert.pem"), { force: true });
    if (this.store) await this.store.saveCloudflare({ mode: "local", recoveryIntent: "enabled", explicitHoldAt: null, token: "", hostname, tunnelName, tunnelId, origin: this.origin, platformVerification: { state: "PLATFORM_REPORT_PENDING", error: null, updatedAt: new Date().toISOString() } });
    this.setup = { state: "complete", authUrl: "", tunnelName, hostname, reservationToken: this.setup.reservationToken || "", error: null };
    if (!this.process) this.startLocal({ mode: "local", tunnelName, tunnelId, hostname });
    return this.status();
  }

  async markPlatformVerification({ state, error = null, ...details } = {}) {
    const allowed = new Set(["LOCAL_TUNNEL_CONNECTED", "PLATFORM_REPORT_PENDING", "PLATFORM_VERIFIED", "PLATFORM_REPORT_FAILED"]);
    const nextState = allowed.has(String(state)) ? String(state) : "PLATFORM_REPORT_FAILED";
    const verifiedAt = nextState === "PLATFORM_VERIFIED" ? new Date(this.clock()).toISOString() : null;
    const platformVerification = { state: nextState, error: error ? String(error).replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 160) : null, ...details, ...(verifiedAt ? { verifiedAt } : {}), updatedAt: new Date(this.clock()).toISOString() };
    if (this.store) await this.store.saveCloudflare({ platformVerification });
    this.observeStatus();
    return this.status();
  }

  startLocal(settings) {
    if (!this.localConnectorIdentityVerified(settings)) throw Object.assign(new Error("The saved local tunnel configuration or private credential did not verify"), { code: "cloudflare_local_identity_invalid" });
    if (!/^127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(this.metricsAddress) || Number(this.metricsAddress.split(":")[1]) > 65535) throw Object.assign(new Error("The tunnel metrics listener must be bound to loopback"), { code: "cloudflare_metrics_address_invalid" });
    this.publicUrl = settings.hostname ? `https://${safeHostname(settings.hostname)}` : "";
    this.lastError = null;
    this.connected = false;
    this.processStartedAt = this.clock();
    this.edgeDownSince = null;
    this.localOriginDownSince = null;
    this.transport = { sampledAt: null, originState: "UNKNOWN", edgeState: "UNKNOWN", activeConnections: null };
    this.spawnTunnel(["tunnel", "--no-autoupdate", "--metrics", this.metricsAddress, "--config", path.join(this.cloudflareHome, "config.yml"), "run", settings.tunnelName], this.runtimeEnv(), { managedLocal: true });
    this.startHealthMonitor();
  }

  async reconnectExisting({ reservation = null } = {}) {
    const stored = this.store?.getCloudflare?.() || {};
    if (stored.recoveryIntent === "held" || stored.explicitHoldAt) throw Object.assign(new Error("Secure access is deliberately on hold; clear the hold through the separate authorized maintenance action"), { code: "cloudflare_recovery_held" });
    const current = await this.currentReservedIdentity(reservation);
    const local = this.localTunnelConfig();
    if (!local || local.tunnelId !== current.tunnelId || local.hostname !== current.hostname) {
      throw Object.assign(new Error("The existing local tunnel configuration does not match the current signed installation reservation"), { code: "cloudflare_reservation_identity_mismatch" });
    }
    const settings = { mode: "local", tunnelId: current.tunnelId, tunnelName: current.tunnelName, hostname: current.hostname };
    if (!this.localConnectorIdentityVerified(settings)) throw Object.assign(new Error("The exact reserved tunnel credential or ingress configuration is unavailable or invalid"), { code: "cloudflare_local_identity_invalid" });
    await this.setReservationToken(current.reservationToken);
    await this.store?.saveCloudflare?.({ mode: "local", recoveryIntent: "enabled", explicitHoldAt: null, token: "", hostname: current.hostname, tunnelName: current.tunnelName, tunnelId: current.tunnelId, origin: this.origin, platformVerification: { state: "PLATFORM_REPORT_PENDING", error: null, updatedAt: new Date(this.clock()).toISOString() } });
    this.retryAttempt = 0;
    this.lastError = null;
    this.startLocal({ ...settings, recoveryIntent: "enabled" });
    this.observeStatus();
    return this.status();
  }

  async retryRecovery({ reservation = null } = {}) {
    const settings = this.settings();
    if (settings.recoveryIntent === "held") throw Object.assign(new Error("Secure access is deliberately on hold"), { code: "cloudflare_recovery_held" });
    if (settings.mode === "disabled" || settings.recoveryIntent === "ambiguous" || settings.recoveryIntent === "unconfigured") {
      return this.reconnectExisting({ reservation });
    }
    if (settings.mode !== "local") throw Object.assign(new Error("Only the existing paired local tunnel can be recovered"), { code: "cloudflare_recovery_unavailable" });
    await this.verifyCurrentReservation(settings, reservation);
    if (this.process) {
      await this.probeTransport();
      return this.status();
    }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryAttempt = 0;
    this.startLocal(settings);
    this.observeStatus();
    return this.status();
  }

  reservationToken() {
    return String(this.setup.reservationToken || this.vault?.get?.("cloudflare.reservationToken") || "");
  }

  async setReservationToken(token) {
    const value = String(token || "").trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error("An installation-specific Cloudflare reservation is required");
    if (this.vault) await this.vault.set("cloudflare.reservationToken", value);
    this.setup.reservationToken = value;
    return value;
  }

  spawnTunnel(args, env = {}, { managedLocal = false } = {}) {
    if (this.process) return;
    const generation = ++this.processGeneration;
    const child = this.spawnImpl(this.binary, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    const consume = (chunk) => {
      const output = chunk.toString();
      const match = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/i);
      if (match) this.publicUrl = match[0].replace(/[),.]$/, "");
      if (/registered tunnel connection|connection [a-z0-9-]+ registered|tunnel.*connected/i.test(output)) this.lastError = null;
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      if (generation !== this.processGeneration) return;
      this.lastError = error.code === "ENOENT" ? "cloudflared is not installed" : "cloudflared could not start";
      if (this.process === child) this.process = null;
      this.connected = false;
      this.transport.edgeState = "DISCONNECTED";
      this.logger.warn(`[cloudflare] ${this.lastError}`);
      if (managedLocal) this.scheduleRecovery();
      this.observeStatus();
    });
    child.on("exit", (code, signal) => {
      if (generation !== this.processGeneration) return;
      if (this.process === child) this.process = null;
      this.connected = false;
      this.transport.edgeState = "DISCONNECTED";
      if (!this.intentionalChildren.has(child) && code !== 0) this.lastError = `cloudflared exited unexpectedly${signal ? ` (${String(signal).slice(0, 16)})` : ""}`;
      if (managedLocal && !this.intentionalChildren.has(child)) this.scheduleRecovery();
      this.observeStatus();
    });
    this.observeStatus();
  }

  startHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.probeTransport().catch(() => {});
    this.healthTimer = setInterval(() => this.probeTransport().catch(() => {}), this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  async boundedFetch(url, timeoutMs = 2500) {
    if (typeof this.fetchImpl !== "function") throw new Error("fetch unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try { return await this.fetchImpl(url, { method: "GET", cache: "no-store", signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async probeTransport() {
    if (this.healthProbeInFlight) return this.transport;
    this.healthProbeInFlight = true;
    try {
      let originState = "UNKNOWN";
      let edgeState = "UNKNOWN";
      let activeConnections = null;
      try {
        const originUrl = new URL(this.origin);
        if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(originUrl.hostname)) throw new Error("origin is not loopback");
        const response = await this.boundedFetch(new URL("/api/health", originUrl).toString());
        const body = response.ok ? await response.json() : null;
        originState = body?.ok === true && body?.mode === "native-v2" ? "HEALTHY" : "UNHEALTHY";
      } catch { originState = "UNHEALTHY"; }
      try {
        const response = await this.boundedFetch(`http://${this.metricsAddress}/metrics`);
        if (response.ok) {
          const metrics = await response.text();
          const values = [...metrics.matchAll(/^cloudflared_tunnel_ha_connections(?:\{[^\n]*\})?\s+([0-9.eE+-]+)\s*$/gm)].map((match) => Number(match[1])).filter(Number.isFinite);
          if (values.length) {
            activeConnections = values.reduce((sum, value) => sum + value, 0);
            edgeState = activeConnections > 0 ? "CONNECTED" : "DISCONNECTED";
          }
        }
      } catch { edgeState = "UNKNOWN"; }
      this.transport = { sampledAt: new Date(this.clock()).toISOString(), originState, edgeState, activeConnections };
      this.connected = Boolean(this.process && edgeState === "CONNECTED");
      if (edgeState === "DISCONNECTED" && this.process) {
        if (this.edgeDownSince === null) this.edgeDownSince = this.clock();
        if (this.clock() - this.edgeDownSince >= this.originFailureGraceMs) {
          const child = this.process;
          if (child && !this.intentionalChildren.has(child)) child.kill("SIGTERM");
        }
      } else if (edgeState === "CONNECTED" || edgeState === "UNKNOWN") {
        this.edgeDownSince = null;
        if (edgeState === "CONNECTED") this.retryAttempt = 0;
      }
      if (this.transport.originState === "UNHEALTHY") this.localOriginDownSince ??= this.clock();
      else this.localOriginDownSince = null;
      this.observeStatus();
      return this.transport;
    } finally { this.healthProbeInFlight = false; }
  }

  scheduleRecovery() {
    if (this.retryTimer || this.process) return;
    const settings = this.settings();
    if (settings.mode !== "local" || settings.recoveryIntent === "held" || !settings.tunnelId || !settings.tunnelName) return;
    const ceiling = Math.min(this.maxRetryDelayMs, this.retryBaseMs * (2 ** Math.min(this.retryAttempt, 10)));
    const delay = Math.floor(ceiling * (0.5 + Math.random() * 0.5));
    this.retryAttempt = Math.min(this.retryAttempt + 1, 10);
    this.lastError = this.lastError || "Remote access is reconnecting";
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.process) return;
      try {
        const current = this.settings();
        if (current.mode !== "local" || current.recoveryIntent === "held") return;
        if (this.nodeEnv === "production") await this.verifyCurrentReservation(current);
        else if (!this.localConnectorIdentityVerified(current)) throw Object.assign(new Error("The saved local tunnel identity or credential did not verify"), { code: "cloudflare_local_identity_invalid" });
        this.startLocal(current);
      } catch (error) {
        this.lastError = String(error.code || "cloudflare_recovery_unavailable").slice(0, 80);
        this.observeStatus();
        if (!isPermanentRecoveryIdentityFailure(error)) this.scheduleRecovery();
      }
    }, delay);
    this.retryTimer.unref?.();
    this.observeStatus();
  }

  startNamed(token, hostname = "") {
    this.publicUrl = hostname ? `https://${safeHostname(hostname)}` : "";
    this.lastError = null;
    this.connected = false;
    // TUNNEL_TOKEN avoids exposing the credential in process listings and logs.
    this.spawnTunnel(["tunnel", "--no-autoupdate", "run"], { TUNNEL_TOKEN: token });
    return this.status();
  }

  async configure({ token, hostname } = {}) {
    if (this.nodeEnv === "production") throw Object.assign(new Error("Arbitrary Cloudflare tunnel tokens are retired in production"), { code: "cloudflare_token_flow_retired" });
    const cleanToken = String(token || "").trim();
    if (!cleanToken) throw new Error("Cloudflare tunnel token is required");
    const cleanHostname = safeHostname(hostname);
    if (!cleanHostname || !isDinodiaCloudHostname(cleanHostname)) throw new Error("Cloudflare hostname must use a dinodiasmartliving.com host");
    await this.stop();
    if (this.vault) await this.vault.set("cloudflare.token", cleanToken);
    if (this.store) await this.store.saveCloudflare({ mode: "named", token: "", hostname: cleanHostname, origin: this.origin });
    this.startNamed(cleanToken, cleanHostname);
    return this.status();
  }

  async startQuick() {
    if (this.nodeEnv === "production") throw Object.assign(new Error("Quick Cloudflare tunnels are retired in production"), { code: "cloudflare_quick_tunnel_retired" });
    await this.stop();
    if (this.vault) await this.vault.clear("cloudflare.token");
    if (this.vault) await this.vault.clear("cloudflare.reservationToken");
    if (this.store) await this.store.saveCloudflare({ mode: "quick", token: "", hostname: "", origin: this.origin });
    this.publicUrl = "";
    this.lastError = null;
    this.connected = false;
    this.spawnTunnel(["tunnel", "--no-autoupdate", "--url", this.origin]);
    return this.status();
  }

  async stop() {
    await this.stopLogin();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const child = this.process;
    this.process = null;
    if (child) {
      this.intentionalChildren.add(child);
      this.processGeneration += 1;
      if (child.exitCode !== null || child.signalCode) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }

  async disconnect() {
    await this.stop();
    this.publicUrl = "";
    this.lastError = null;
    this.connected = false;
    if (this.vault) await this.vault.clear("cloudflare.token");
    if (this.store) await this.store.saveCloudflare({ mode: "disabled", recoveryIntent: "held", explicitHoldAt: new Date(this.clock()).toISOString(), token: "", hostname: "", origin: this.origin });
    this.transport = { sampledAt: new Date(this.clock()).toISOString(), originState: "UNKNOWN", edgeState: "DISCONNECTED", activeConnections: null };
    this.observeStatus();
    return this.status();
  }

  status() {
    const settings = this.settings();
    const hostname = settings.hostname ? safeHostname(settings.hostname) : "";
    const stored = this.store ? this.store.getCloudflare() : {};
    const verification = stored.platformVerification && typeof stored.platformVerification === "object" ? stored.platformVerification : { state: "LOCAL_TUNNEL_CONNECTED", error: null };
    const verifiedAt = Date.parse(String(verification.verifiedAt || ""));
    const verificationAge = Number.isFinite(verifiedAt) ? this.clock() - verifiedAt : Infinity;
    const platformVerification = { ...verification, fresh: verification.state === "PLATFORM_VERIFIED" && verificationAge >= 0 && verificationAge <= 420000 && verifiedAt >= this.processStartedAt };
    const secureAccessVerified = platformVerification.fresh && this.connected && this.transport.originState === "HEALTHY";
    const { reservationToken: _reservationToken, ...safeSetup } = this.setup;
    const recoveryIntent = settings.recoveryIntent;
    const recoveryState = recoveryIntent === "held" ? "HELD"
      : recoveryIntent === "ambiguous" ? "RECONNECT_REQUIRED"
        : recoveryIntent === "unconfigured" ? "UNCONFIGURED"
          : secureAccessVerified ? "READY"
            : settings.mode === "local" && isPermanentRecoveryIdentityFailure({ code: this.lastError }) ? "RECONNECT_REQUIRED"
              : settings.mode === "disabled" && recoveryIntent === "enabled" ? "RECONNECT_REQUIRED"
                : settings.mode === "local" ? "RECONNECTING" : settings.mode === "disabled" ? "UNAVAILABLE" : "RECONNECTING";
    return {
      configured: settings.mode !== "disabled",
      setupAllowed: this.nodeEnv !== "production" && settings.recoveryIntent !== "held",
      mode: settings.mode,
      running: Boolean(this.process),
      connected: this.connected,
      secureAccessVerified,
      platformVerification,
      recoveryIntent,
      recoveryState,
      transport: { ...this.transport, childRunning: Boolean(this.process), localOriginDownSince: this.localOriginDownSince ? new Date(this.localOriginDownSince).toISOString() : null },
      hostname,
      tunnelName: settings.tunnelName,
      tunnelId: settings.tunnelId,
      // This is true only when the active local config, exact origin, private
      // tunnel-specific credential file, and credential's embedded TunnelID
      // all agree with the running connector's durable installation record.
      connectorIdentityVerified: this.localConnectorIdentityVerified(settings),
      publicUrl: this.publicUrl || (hostname ? `https://${hostname}` : ""),
      origin: this.origin,
      lastError: this.lastError,
      setup: { ...safeSetup, loginActive: Boolean(this.loginProcess) },
    };
  }
}

module.exports = { CloudflareTunnel, safeHostname, connectedLocalTunnelIdentity, verifyLocalTunnelCredential };
