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

class CloudflareTunnel {
  constructor({ store, vault, origin = "http://127.0.0.1:8123", binary = "cloudflared", initialToken = "", initialHostname = "", dataDir = process.cwd(), nodeEnv = process.env.NODE_ENV || "development", logger = console } = {}) {
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
    this.process = null;
    this.loginProcess = null;
    this.lastError = null;
    this.publicUrl = "";
    this.connected = false;
    this.setup = { state: "idle", authUrl: "", tunnelName: "", hostname: "", reservationToken: "", error: null };
  }

  settings() {
    const stored = this.store?.getCloudflare?.() || {};
    const storedMode = stored.mode || "disabled";
    return {
      mode: storedMode === "disabled" && this.initialToken ? "named" : storedMode,
      token: (this.vault && this.vault.get("cloudflare.token")) || stored.token || this.initialToken,
      hostname: stored.hostname || this.initialHostname,
      tunnelName: stored.tunnelName || "",
      tunnelId: stored.tunnelId || "",
    };
  }

  start() {
    const stored = this.store ? this.store.getCloudflare() : {};
    if (stored.token && this.vault) {
      this.vault.set("cloudflare.token", stored.token)
        .then(() => this.store.saveCloudflare({ token: "", origin: this.origin }))
        .catch((error) => this.logger.error(`[cloudflare] secret migration failed: ${error.message}`));
    }
    const settings = this.settings();
    if (settings.mode === "local" && settings.tunnelId && settings.tunnelName) this.startLocal(settings);
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
    if (this.store) await this.store.saveCloudflare({ mode: "local", token: "", hostname, tunnelName, tunnelId, origin: this.origin, platformVerification: { state: "PLATFORM_REPORT_PENDING", error: null, updatedAt: new Date().toISOString() } });
    this.setup = { state: "complete", authUrl: "", tunnelName, hostname, reservationToken: this.setup.reservationToken || "", error: null };
    if (!this.process) this.startLocal({ tunnelName, tunnelId, hostname });
    return this.status();
  }

  async markPlatformVerification({ state, error = null, ...details } = {}) {
    const allowed = new Set(["LOCAL_TUNNEL_CONNECTED", "PLATFORM_REPORT_PENDING", "PLATFORM_VERIFIED", "PLATFORM_REPORT_FAILED"]);
    const nextState = allowed.has(String(state)) ? String(state) : "PLATFORM_REPORT_FAILED";
    const platformVerification = { state: nextState, error: error ? String(error).slice(0, 240) : null, ...details, updatedAt: new Date().toISOString() };
    if (this.store) await this.store.saveCloudflare({ platformVerification });
    return this.status();
  }

  startLocal(settings) {
    this.publicUrl = settings.hostname ? `https://${safeHostname(settings.hostname)}` : "";
    this.lastError = null;
    this.connected = false;
    this.spawnTunnel(["tunnel", "--no-autoupdate", "--config", path.join(this.cloudflareHome, "config.yml"), "run", settings.tunnelName], this.runtimeEnv());
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

  spawnTunnel(args, env = {}) {
    if (this.process) return;
    const child = spawn(this.binary, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    const consume = (chunk) => {
      const output = chunk.toString();
      const match = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/i);
      if (match) this.publicUrl = match[0].replace(/[),.]$/, "");
      if (/registered tunnel connection|connection [a-z0-9-]+ registered|tunnel.*connected/i.test(output)) {
        this.lastError = null;
        this.connected = true;
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      this.lastError = error.code === "ENOENT" ? "cloudflared is not installed" : error.message;
      this.process = null;
      this.connected = false;
      this.logger.error(`[cloudflare] ${this.lastError}`);
    });
    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      this.connected = false;
      if (code && !this.lastError) this.lastError = `cloudflared exited with code ${code}${signal ? ` (${signal})` : ""}`;
    });
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
    const child = this.process;
    this.process = null;
    if (child) {
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
    if (this.store) await this.store.saveCloudflare({ mode: "disabled", token: "", hostname: "", origin: this.origin });
    return this.status();
  }

  status() {
    const settings = this.settings();
    const hostname = settings.hostname ? safeHostname(settings.hostname) : "";
    const stored = this.store ? this.store.getCloudflare() : {};
    const platformVerification = stored.platformVerification && typeof stored.platformVerification === "object" ? { ...stored.platformVerification } : { state: "LOCAL_TUNNEL_CONNECTED", error: null };
    const secureAccessVerified = platformVerification.state === "PLATFORM_VERIFIED";
    const { reservationToken: _reservationToken, ...safeSetup } = this.setup;
    return {
      configured: settings.mode !== "disabled",
      mode: settings.mode,
      running: Boolean(this.process),
      connected: this.connected,
      secureAccessVerified,
      platformVerification,
      hostname,
      tunnelName: settings.tunnelName,
      tunnelId: settings.tunnelId,
      publicUrl: this.publicUrl || (hostname ? `https://${hostname}` : ""),
      origin: this.origin,
      lastError: this.lastError,
      setup: { ...safeSetup, loginActive: Boolean(this.loginProcess) },
    };
  }
}

module.exports = { CloudflareTunnel, safeHostname };
