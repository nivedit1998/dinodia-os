const os = require("node:os");
const { spawn } = require("node:child_process");

function isPrivateIPv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function isVirtualInterface(name) {
  return /^(lo$|docker\d*$|br-|veth|virbr|cni|flannel|podman|tailscale|wg\d*|tun\d*|tap\d*|zt)/i.test(String(name || ""));
}

function isPhysicalLanInterface(name) {
  return /^(eth\d*|en[a-z0-9]*|wl[a-z0-9]*)$/i.test(String(name || ""));
}

/**
 * Select the configured setup-interface IPv4 address when present. Otherwise
 * prefer a physical Ethernet/Wi-Fi interface and never publish a container,
 * VPN, loopback or bridge address just because it is RFC1918.
 */
function privateAddress(interfaceAddress = "", interfaces = os.networkInterfaces()) {
  const requested = String(interfaceAddress || "").trim();
  const candidates = [];
  for (const [name, values] of Object.entries(interfaces || {})) {
    if (isVirtualInterface(name)) continue;
    for (const item of values || []) {
      if (!item || item.internal || (item.family !== "IPv4" && item.family !== 4) || !isPrivateIPv4(item.address)) continue;
      if (requested && requested !== item.address) continue;
      candidates.push({ name, address: item.address, physicalPriority: isPhysicalLanInterface(name) ? 0 : 1 });
    }
  }
  candidates.sort((left, right) => left.physicalPriority - right.physicalPriority || left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
  return candidates[0]?.address || "";
}

class SetupDiscovery {
  constructor({ serial, interfaceAddress = "", nodeEnv = "development", logger = console, spawnProcess = spawn, interfaces = os.networkInterfaces } = {}) {
    this.serial = String(serial || "").toLowerCase();
    this.interfaceAddress = String(interfaceAddress || "").trim();
    this.nodeEnv = String(nodeEnv || "development");
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.interfaces = interfaces;
    this.children = [];
    this.generation = 0;
    this.activeGeneration = null;
    this.state = { running: false, hostname: `dinodia-${this.serial}.local`, address: "", error: null };
  }

  start(port) {
    if (this.nodeEnv !== "production" || this.children.length || !this.serial) return this.status();
    const address = privateAddress(this.interfaceAddress, this.interfaces());
    this.state = { ...this.state, address, error: address ? null : "No physical private interface is available" };
    if (!address) return this.status();
    const specs = [
      ["avahi-publish-address", [this.state.hostname, address]],
      ["avahi-publish-service", [`Dinodia OS ${this.serial}`, "_http._tcp", String(port), "path=/setup", `serial=${this.serial}`]],
    ];
    const spawned = new Set();
    const generation = ++this.generation;
    this.activeGeneration = generation;
    this.state = { ...this.state, running: false, error: null };
    for (const [command, args] of specs) {
      const child = this.spawnProcess(command, args, { stdio: ["ignore", "ignore", "pipe"] });
      child.once("spawn", () => {
        if (this.activeGeneration !== generation) {
          if (Number.isInteger(child.pid) && child.pid > 1 && child.exitCode === null && !child.signalCode) {
            try { child.kill("SIGTERM"); } catch {}
          }
          return;
        }
        spawned.add(child);
        if (spawned.size === specs.length && this.children.length === specs.length) this.state = { ...this.state, running: true, error: null };
      });
      child.stderr?.on("data", (chunk) => {
        const message = String(chunk || "").trim();
        if (message) this.logger.warn?.(`[setup-discovery] ${message.slice(0, 240)}`);
      });
      child.on("error", (error) => {
        if (this.activeGeneration !== generation) return;
        this.state = { ...this.state, running: false, error: error.code === "ENOENT" ? `${command} is not installed` : "mDNS publisher failed" };
        this.stop();
      });
      child.on("exit", () => {
        if (this.activeGeneration === generation) {
          this.state = { ...this.state, running: false, error: `${command} exited before discovery was established` };
          this.stop();
        }
      });
      this.children.push(child);
    }
    return this.status();
  }

  stop() {
    this.activeGeneration = null;
    for (const child of this.children.splice(0)) {
      // ChildProcess.kill() with no PID can signal the current process group on
      // some runtimes. ENOENT spawn failures have no child process to stop.
      if (!Number.isInteger(child?.pid) || child.pid <= 1 || child.exitCode !== null || child.signalCode) continue;
      try { child.kill("SIGTERM"); } catch {}
    }
    this.state.running = false;
  }

  status() { return { ...this.state }; }
}

module.exports = { SetupDiscovery, privateAddress, isPrivateIPv4, isVirtualInterface };
