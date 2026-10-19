const { run } = require("./zigbeeService");
const { assertNoDockerNetworkOverlap } = require("./dockerNetworkGuard");

class ThreadService {
  constructor({ composeFile = "", envFile = "", projectDirectory = "", dockerBinary = "docker", composeBinary = "/usr/libexec/docker/cli-plugins/docker-compose", logger = console, runCommand = run, networkGuard = assertNoDockerNetworkOverlap } = {}) {
    this.composeFile = composeFile;
    this.envFile = envFile;
    this.projectDirectory = projectDirectory;
    this.dockerBinary = dockerBinary;
    this.composeBinary = composeBinary;
    this.logger = logger;
    this.runCommand = runCommand;
    this.networkGuard = networkGuard;
    this.lastError = null;
    this.lastActionAt = null;
  }

  args(...rest) {
    // Keep the existing Matter/OTBR workloads on the one installation-owned
    // Compose project across versioned release directories and host moves.
    const args = ["compose", "-p", "dinodia-os"];
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

  async otCtl(args) {
    return run(this.dockerBinary, ["exec", "dinodia-otbr", "ot-ctl", ...args], { timeoutMs: 10000 });
  }

  async ensureNetwork({ initializeDataset = false, attempts = 45 } = {}) {
    let lastError;
    const maxAttempts = Math.min(45, Math.max(1, Number(attempts) || 45));
    // A freshly recreated OTBR container can be running before its Spinel
    // socket is ready. Keep the API request deterministic by waiting for the
    // RCP instead of failing the add-again action during that small window.
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        let datasetExists = true;
        try {
          const activeDataset = await this.otCtl(["dataset", "active", "-x"]);
          datasetExists = /\b[0-9a-f]{32,}\b/i.test(String(activeDataset?.stdout || ""));
        } catch (error) {
          // Only an explicit Thread setup operation may create a new dataset,
          // and only when ot-ctl positively reports that no active dataset
          // exists. A disconnected RCP, transient daemon error or timeout is
          // never interpreted as permission to replace Thread credentials.
          if (!/\b(?:Error\s+23:\s*)?NotFound\b/i.test(String(error?.message || ""))) throw error;
          if (!initializeDataset) {
            throw Object.assign(new Error("No active Thread dataset is present; automatic startup will not create or replace one"), { code: "thread_dataset_missing" });
          }
          datasetExists = false;
        }
        if (!datasetExists && !initializeDataset) {
          throw Object.assign(new Error("No active Thread dataset is present; automatic startup will not create or replace one"), { code: "thread_dataset_missing" });
        }
        if (!datasetExists) {
          await this.otCtl(["dataset", "init", "new"]);
          await this.otCtl(["dataset", "commit", "active"]);
        }
        await this.otCtl(["ifconfig", "up"]);
        await this.otCtl(["thread", "start"]);
        const state = (await this.otCtl(["state"])).stdout.trim().split(/\s+/)[0].toLowerCase();
        if (["leader", "router", "child", "detached"].includes(state)) return state;
        lastError = new Error(`Thread network entered unexpected state: ${state || "unknown"}`);
      } catch (error) {
        if (error?.code === "thread_dataset_missing") throw error;
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw lastError || new Error("Thread RCP did not become ready");
  }

  async available() {
    try {
      await run(this.dockerBinary, ["version"], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    if (!(await this.available())) return { configured: Boolean(this.composeFile || this.projectDirectory), available: false, service: "otbr", state: "runtime-unavailable", running: false, lastError: this.lastError || "Docker is unavailable" };
    try {
      const result = await run(this.dockerBinary, ["inspect", "--format", "{{.State.Status}}", "dinodia-otbr"], { timeoutMs: 5000 });
      return { configured: true, available: true, service: "otbr", state: result.stdout || "unknown", running: result.stdout === "running", lastError: this.lastError };
    } catch (error) {
      return { configured: true, available: true, service: "otbr", state: "not-created", running: false, lastError: this.lastError || error.message };
    }
  }

  async start({ rcpDevice, baudRate = 460800, infraIf = "eth0", threadIf = "wpan0", initializeDataset = false } = {}) {
    if (!rcpDevice) return { ok: false, error: "A Thread RCP device is required" };
    if (!(await this.available())) return { ok: false, skipped: true, reason: "docker_unavailable" };
    this.lastActionAt = new Date().toISOString();
    const rcpUrl = `spinel+hdlc+uart:///dev/ttyACM0?uart-baudrate=${Number(baudRate) || 460800}`;
      const composeOptions = {
      timeoutMs: 120000,
      // THREAD_RCP_DEVICE controls Compose's host-device mapping. OT_RCP_DEVICE
      // controls the serial URL inside the OTBR container; both are required
      // when the selected stable by-id path changes or a removed radio is
      // added again.
      env: { THREAD_RCP_DEVICE: rcpDevice, OT_RCP_DEVICE: rcpUrl, OT_INFRA_IF: infraIf || "eth0", OT_THREAD_IF: threadIf || "wpan0" },
    };
    try {
      // Never allow an existing bridge/VPN overlap to be reactivated while
      // starting OTBR/Matter on a newly selected household LAN.
      await this.networkGuard({ dockerBinary: this.dockerBinary, runCommand: this.runCommand });
      try {
        await this.compose(["--profile", "thread", "--profile", "matter", "up", "-d", "otbr", "matter-server"], { ...composeOptions, cwd: this.projectDirectory || undefined });
      } catch {
        // Absolute compose/env paths make a cwd-free retry safe and handle
        // systemd sandboxes where the working directory is read-only.
        await this.compose(["--profile", "thread", "--profile", "matter", "up", "-d", "otbr", "matter-server"], composeOptions);
      }
      const networkState = await this.ensureNetwork({ initializeDataset: initializeDataset === true });
      this.lastError = null;
      return { ok: true, ...(await this.status()), rcpDevice, baudRate: Number(baudRate) || 460800, networkState };
    } catch (error) {
      this.lastError = String(error.message || error);
      this.logger.error(`[thread-service] ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }
  }

  async remove() {
    this.lastActionAt = new Date().toISOString();
    try {
      await this.compose(["--profile", "thread", "--profile", "matter", "rm", "--force", "--stop", "otbr", "matter-server"], { cwd: this.projectDirectory || undefined, timeoutMs: 120000 });
      this.lastError = null;
      return { ok: true, ...(await this.status()) };
    } catch (error) {
      try {
        for (const container of ["dinodia-otbr", "dinodia-matter-server"]) {
          try { await run(this.dockerBinary, ["rm", "--force", container], { timeoutMs: 30000 }); } catch { /* already absent */ }
        }
        this.lastError = null;
        return { ok: true, ...(await this.status()), fallback: "docker-container-remove" };
      } catch (fallbackError) {
        this.lastError = String(fallbackError.message || error.message || error);
        this.logger.error(`[thread-service] ${this.lastError}`);
        return { ok: false, error: this.lastError };
      }
    }
  }
}

module.exports = { ThreadService };
