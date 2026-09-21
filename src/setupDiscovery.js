const os = require("node:os");
const { spawn } = require("node:child_process");

function privateAddress(interfaceName = "") {
  for (const [name, values] of Object.entries(os.networkInterfaces())) {
    if (interfaceName && name !== interfaceName) continue;
    for (const item of values || []) {
      if (!item || item.internal || item.family !== "IPv4") continue;
      const octets = item.address.split(".").map(Number);
      const privateNetwork = octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
      if (privateNetwork) return item.address;
    }
  }
  return "";
}

class SetupDiscovery {
  constructor({ serial, interfaceName = "", nodeEnv = "development", logger = console } = {}) {
    this.serial = String(serial || "").toLowerCase();
    this.interfaceName = String(interfaceName || "");
    this.nodeEnv = String(nodeEnv || "development");
    this.logger = logger;
    this.children = [];
    this.state = { running: false, hostname: `dinodia-${this.serial}.local`, address: "", error: null };
  }

  start(port) {
    if (this.nodeEnv !== "production" || this.children.length || !this.serial) return this.status();
    const address = privateAddress(this.interfaceName);
    this.state = { ...this.state, address, error: address ? null : "No private interface is available" };
    if (!address) return this.status();
    const specs = [
      ["avahi-publish-address", [this.state.hostname, address]],
      ["avahi-publish-service", [`Dinodia OS ${this.serial}`, "_http._tcp", String(port), "path=/setup", `serial=${this.serial}`]],
    ];
    for (const [command, args] of specs) {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (chunk) => {
        const message = String(chunk || "").trim();
        if (message) this.logger.warn?.(`[setup-discovery] ${message.slice(0, 240)}`);
      });
      child.on("error", (error) => {
        this.state = { ...this.state, error: error.code === "ENOENT" ? `${command} is not installed` : error.message };
      });
      this.children.push(child);
    }
    this.state.running = true;
    return this.status();
  }

  stop() {
    for (const child of this.children.splice(0)) {
      try { child.kill("SIGTERM"); } catch {}
    }
    this.state.running = false;
  }

  status() { return { ...this.state }; }
}

module.exports = { SetupDiscovery, privateAddress };
