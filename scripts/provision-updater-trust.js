"use strict";

const net = require("node:net");
const { spawnSync } = require("node:child_process");
const { provisionTrustedUpdaterPolicy, validatePolicyFile } = require("../src/updater/trustProvisioning");

const SOCKET_PATH = "/run/dinodia-os-updater/control.sock";

function argsOf(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || result.has(key)) throw new Error("invalid arguments");
    result.set(key, value);
  }
  return result;
}

function createRestartAndVerify({ systemctlPath = "/bin/systemctl", socketPath = SOCKET_PATH } = {}) {
  return function restartAndVerify() {
    const command = spawnSync(systemctlPath, ["restart", "dinodia-os-updater.service"], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    if (command.error || command.status !== 0) throw new Error("fixed updater restart failed");
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let response = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("updater status timeout")); }, 5_000);
      socket.once("connect", () => socket.write('{"operation":"status"}\n'));
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.length > 4096) { socket.destroy(); clearTimeout(timer); reject(new Error("updater status response too large")); return; }
        const newline = response.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        socket.end();
        let result;
        try {
          result = JSON.parse(response.slice(0, newline));
        } catch {
          reject(new Error("updater status response was invalid"));
          return;
        }
        if (result.ok !== true || result.status?.trustState !== "ready") {
          reject(new Error("updater status did not confirm ready trust"));
          return;
        }
        resolve({ trustState: result.status.trustState });
      });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("updater status socket unavailable")); });
    });
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = argsOf(argv);
  const candidatePath = args.get("--candidate");
  if (!candidatePath || args.size < 2) throw new Error("usage: provision-updater-trust.js --inspect|--apply yes --candidate FILE [--approve-sha256 HASH]");
  if (args.get("--inspect") === "yes" && args.size === 2) {
    const result = validatePolicyFile(candidatePath, { ownerUid: process.getuid() });
    process.stdout.write(`${JSON.stringify({ policySha256: result.sha256, publicKeyFingerprint: result.fingerprint, signingKeyId: result.signingKeyId, channel: result.channel, allowedArtifactHosts: result.allowedArtifactHosts })}\n`);
    return;
  }
  if (args.get("--apply") !== "yes" || args.size !== 3 || process.getuid?.() !== 0) throw new Error("apply requires root and an explicit approved policy SHA-256");
  const result = await provisionTrustedUpdaterPolicy({
    candidatePath,
    approvedSha256: args.get("--approve-sha256"),
    restartAndVerify: createRestartAndVerify(),
  });
  process.stdout.write(`${JSON.stringify({ ...result, trustState: "ready" })}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Updater trust provisioning stopped safely: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { argsOf, createRestartAndVerify };
