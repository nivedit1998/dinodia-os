const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

function run(command, args, { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : undefined, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error(`${command} timed out`), { code: "command_timeout" }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Object.assign(new Error(stderr.trim() || `${command} exited with ${code}`), { code: "command_failed", exitCode: code }));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

class ZigbeeService {
  constructor({ composeFile = "", envFile = "", projectDirectory = "", dockerBinary = "docker", composeBinary = "/usr/libexec/docker/cli-plugins/docker-compose", logger = console } = {}) {
    this.composeFile = composeFile;
    this.envFile = envFile;
    this.projectDirectory = projectDirectory;
    this.dockerBinary = dockerBinary;
    this.composeBinary = composeBinary;
    this.logger = logger;
    this.lastError = null;
    this.lastActionAt = null;
  }

  args(...rest) {
    const args = ["compose"];
    if (this.composeFile) args.push("-f", this.composeFile);
    if (this.envFile) args.push("--env-file", this.envFile);
    args.push(...rest);
    return args;
  }

  async compose(rest, options = {}) {
    const args = this.args(...rest);
    try {
      return await run(this.dockerBinary, args, options);
    } catch (error) {
      if (!this.composeBinary || this.composeBinary === this.dockerBinary) throw error;
      try {
        return await run(this.composeBinary, args.slice(1), options);
      } catch {
        throw error;
      }
    }
  }

  async available() {
    try {
      // Check the Docker daemon rather than Compose from the service's cwd.
      // Under systemd the Compose plugin can reject the working directory
      // even though the daemon and the Compose subcommand are usable.
      await run(this.dockerBinary, ["version"], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    const configured = Boolean(this.composeFile || this.projectDirectory);
    if (!configured) return { configured: false, available: false, service: "zigbee2mqtt", state: "not-managed", lastError: this.lastError };
    if (!(await this.available())) return { configured: true, available: false, service: "zigbee2mqtt", state: "runtime-unavailable", running: false, lastError: this.lastError || "Docker Compose is unavailable" };
    try {
      const result = await run(this.dockerBinary, ["inspect", "--format", "{{.State.Status}}", "dinodia-zigbee2mqtt"], { timeoutMs: 5000 });
      return { configured: true, available: true, service: "zigbee2mqtt", state: result.stdout || "unknown", running: result.stdout === "running", lastError: this.lastError };
    } catch (error) {
      return { configured: true, available: true, service: "zigbee2mqtt", state: "not-created", running: false, lastError: this.lastError || error.message };
    }
  }

  async restart() {
    if (!(await this.available())) return { ok: false, skipped: true, reason: "docker_compose_unavailable" };
    this.lastActionAt = new Date().toISOString();
    try {
      const options = { timeoutMs: 120000 };
      try {
        await this.compose(["--profile", "zigbee", "up", "-d", "zigbee2mqtt"], { ...options, cwd: this.projectDirectory || undefined });
      } catch {
        // Compose and env paths are absolute in production, so retry without
        // a cwd for systemd environments that restrict the service directory.
        await this.compose(["--profile", "zigbee", "up", "-d", "zigbee2mqtt"], options);
      }
      this.lastError = null;
      return { ok: true, ...(await this.status()) };
    } catch (error) {
      this.lastError = String(error.message || error);
      this.logger.error(`[zigbee-service] ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }
  }

  async remove() {
    this.lastActionAt = new Date().toISOString();
    const composeAvailable = await this.available();
    if (composeAvailable) {
      try {
        await this.compose(["--profile", "zigbee", "rm", "--force", "--stop", "zigbee2mqtt"], { cwd: this.projectDirectory || undefined, timeoutMs: 120000 });
        this.lastError = null;
        return { ok: true, ...(await this.status()) };
      } catch {
        // Fall through to the fixed-name Docker cleanup below. This covers a
        // crash-looping container that Compose can no longer resolve.
      }
    }

    // A container that is crash-looping because its USB coordinator was
    // unplugged can be missed by Compose's project lookup. The named
    // container is still safe to remove directly, and doing so prevents
    // restart: unless-stopped from bringing the broken runtime back. We also
    // try this when only the Compose plugin is unavailable: the Dinodia
    // service can still have access to the Docker daemon itself.
    try {
      await run(this.dockerBinary, ["rm", "--force", "dinodia-zigbee2mqtt"], { timeoutMs: 30000 });
      this.lastError = null;
      return { ok: true, ...(await this.status()), fallback: "docker-container-remove" };
    } catch (error) {
      if (!composeAvailable) return { ok: false, skipped: true, reason: "docker_compose_unavailable" };
      this.lastError = String(error.message || error);
      this.logger.error(`[zigbee-service] ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }
  }

  async applyConfiguration({ configurationPath, previousContents = "" } = {}) {
    const result = await this.restart();
    if (result.ok || result.skipped) return { ...result, restartRequired: Boolean(result.skipped) };
    if (previousContents && configurationPath) {
      const rollbackPath = `${configurationPath}.${process.pid}.rollback`;
      await fs.writeFile(rollbackPath, previousContents, { mode: 0o600 });
      await fs.rename(rollbackPath, configurationPath);
      await this.restart().catch(() => {});
      return { ok: false, rolledBack: true, error: result.error, restartRequired: true };
    }
    return { ...result, restartRequired: true };
  }
}

module.exports = { ZigbeeService, run };
