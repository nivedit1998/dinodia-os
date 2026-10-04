const os = require("node:os");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { avahiSetupConfigMatches } = require("./avahiSetupConfig");

function isPrivateIPv4(address) {
  const octets = String(address || "").split(".");
  const parts = octets.map(Number);
  if (parts.length !== 4 || parts.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== octets[index])) return false;
  const [a, b, , last] = parts;
  if (last === 0 || last === 255 || a === 172 && (b === 17 || b === 18)) return false;
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}

function isVirtualInterface(name) {
  return /^(lo$|docker\d*$|br-|veth|virbr|cni|flannel|podman|tailscale|wg\d*|tun\d*|tap\d*|zt|vboxnet|vmnet|utun|awdl|llw|bridge\d*)/i.test(String(name || ""));
}

function isPhysicalLanInterface(name) {
  return /^(eth\d*|en[a-z0-9]*|wl[a-z0-9]*)$/i.test(String(name || ""));
}

function hasPhysicalDevice(name) {
  if (process.platform !== "linux") return true;
  // Linux exposes a device link for hardware/virtual-machine NICs. Container
  // veth eth0 has no such link and must not become an advertised endpoint.
  try { return fs.existsSync(`/sys/class/net/${String(name)}/device`); } catch { return false; }
}

/** Select a deterministic physical RFC1918 interface; never pin a DHCP address. */
function privateInterface(interfaceName = "", interfaces = os.networkInterfaces(), physicalCheck = hasPhysicalDevice) {
  // Interface names survive DHCP changes; an old configured IPv4 address must
  // never pin discovery or Platform reporting to the previous router.
  const requested = /^[A-Za-z][A-Za-z0-9_.:-]{0,14}$/.test(String(interfaceName || "").trim())
    ? String(interfaceName).trim()
    : "";
  const candidates = [];
  for (const [name, values] of Object.entries(interfaces || {})) {
    if (isVirtualInterface(name) || !isPhysicalLanInterface(name) || !physicalCheck(name)) continue;
    for (const item of values || []) {
      if (!item || item.internal || (item.family !== "IPv4" && item.family !== 4) || !isPrivateIPv4(item.address)) continue;
      candidates.push({ name, address: item.address, physicalPriority: name === requested ? -1 : isPhysicalLanInterface(name) ? 0 : 1 });
    }
  }
  candidates.sort((left, right) => left.physicalPriority - right.physicalPriority || left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
  return candidates[0] || null;
}

function privateAddress(interfaceName = "", interfaces = os.networkInterfaces(), physicalCheck = hasPhysicalDevice) {
  return privateInterface(interfaceName, interfaces, physicalCheck)?.address || "";
}

class SetupDiscovery {
  constructor({ serial, interfaceName = "", interfaceAddress = "", nodeEnv = "development", logger = console, spawnProcess = spawn, interfaces = os.networkInterfaces, physicalCheck = hasPhysicalDevice, readAvahiConfig = () => fs.readFileSync("/etc/avahi/avahi-daemon.conf", "utf8"), onEndpointChange = () => {}, networkCheckIntervalMs = 10000 } = {}) {
    this.serial = String(serial || "").toLowerCase();
    // interfaceAddress is accepted only for source compatibility with old
    // tests/callers; it is intentionally not used as a DHCP-stable selector.
    this.interfaceName = String(interfaceName || "").trim() || (isPhysicalLanInterface(interfaceAddress) ? String(interfaceAddress).trim() : "");
    this.nodeEnv = String(nodeEnv || "development");
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.interfaces = interfaces;
    this.physicalCheck = physicalCheck;
    this.readAvahiConfig = readAvahiConfig;
    this.onEndpointChange = onEndpointChange;
    this.networkCheckIntervalMs = Math.max(1000, Number(networkCheckIntervalMs) || 10000);
    this.port = 8123;
    this.servicePort = 8123;
    this.customerHostname = "";
    this.customerPort = 8123;
    this.watchTimer = null;
    this.lastEndpointKey = null;
    this.selected = null;
    this.children = [];
    this.generation = 0;
    this.activeGeneration = null;
    this.state = { running: false, hostname: `dinodia-${this.serial}.local`, address: "", error: null };
  }

  start(servicePort, endpointPort = servicePort, customerHostname = "", customerPort = 8123) {
    if (this.nodeEnv !== "production" || !this.serial) return this.status();
    this.servicePort = Number(servicePort) || 80;
    this.port = Number(endpointPort) || this.servicePort;
    this.customerHostname = /^dinodia-[a-f0-9]{20}\.local$/.test(String(customerHostname)) ? String(customerHostname) : "";
    this.customerPort = Number(customerPort) || 8123;
    this.refresh();
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => this.refresh(), this.networkCheckIntervalMs);
      this.watchTimer.unref?.();
    }
    return this.status();
  }

  observation() {
    const selected = privateInterface(this.interfaceName, this.interfaces(), this.physicalCheck);
    return selected
      // `address` and `interfaceName` are private in-process inputs for the
      // heartbeat builder. It emits only the canonical versioned DTO fields.
      ? { version: 1, state: "CURRENT", address: selected.address, baseUrl: `http://${selected.address}:${this.port}`, discoveryHost: `dinodia-${this.serial}.local`, interfaceName: selected.name }
      : { version: 1, state: "UNAVAILABLE", address: "", discoveryHost: `dinodia-${this.serial}.local`, interfaceName: null };
  }

  refresh() {
    if (this.nodeEnv !== "production" || !this.serial) return this.status();
    const selectedInterface = privateInterface(this.interfaceName, this.interfaces(), this.physicalCheck);
    const address = selectedInterface?.address || "";
    const endpointKey = selectedInterface ? `${selectedInterface.name}\n${address}` : "UNAVAILABLE";
    const changed = endpointKey !== this.lastEndpointKey;
    if (changed) {
      this.lastEndpointKey = endpointKey;
      this.selected = selectedInterface;
      this.stopPublishers();
      this.state = { ...this.state, address, error: address ? null : "No physical private interface is available" };
      try {
        Promise.resolve(this.onEndpointChange(this.observation())).catch((error) => {
          this.logger.warn?.(`[setup-discovery] endpoint report queued for retry (${String(error?.code || "unavailable").slice(0, 48)})`);
        });
      } catch {}
    } else if (!selectedInterface || this.children.length > 0 || this.state.running) {
      return this.status();
    }
    // The root-owned Avahi reconciler may still be switching the daemon's
    // interface filter. Retry publication on later polls even when the DHCP
    // address itself has not changed.
    if (!selectedInterface) return this.status();
    let avahiConfig = "";
    try { avahiConfig = this.readAvahiConfig(); } catch {}
    if (!avahiSetupConfigMatches(avahiConfig, { serial: this.serial, interfaceName: selectedInterface.name })) {
      this.state = { ...this.state, error: "Avahi is not restricted to the selected setup interface" };
      return this.status();
    }
    // Avahi's publisher CLI does not accept an interface option. The guarded
    // installer restricts the daemon to the selected private LAN interface.
    // -R is required because the Pi's existing hostname already owns the
    // address's reverse-DNS record; the setup alias needs only a forward A
    // record, otherwise Avahi reports a local name collision.
    const specs = [
      ["avahi-publish-address", ["-R", this.state.hostname, address]],
      ["avahi-publish-service", [`Dinodia OS Setup ${this.serial}`, "_http._tcp", String(this.servicePort), "path=/setup", `serial=${this.serial}`]],
    ];
    if (this.customerHostname) specs.push(
      ["avahi-publish-address", ["-R", this.customerHostname, address]],
      ["avahi-publish-service", [`Dinodia OS ${this.serial}`, "_https._tcp", String(this.customerPort), "path=/api/dinodia/v1/health"]],
    );
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
        this.stopPublishers();
      });
      child.on("exit", () => {
        if (this.activeGeneration === generation) {
          this.state = { ...this.state, running: false, error: `${command} exited before discovery was established` };
          this.stopPublishers();
        }
      });
      this.children.push(child);
    }
    return this.status();
  }

  stop() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.stopPublishers();
  }

  stopPublishers() {
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

module.exports = { SetupDiscovery, privateInterface, privateAddress, isPrivateIPv4, isVirtualInterface, isPhysicalLanInterface };
