const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createHub } = require("../src/server");

// cloudflared keeps idle connections to the origin for up to 90 seconds and reuses them. If the
// Hub closes an idle keep-alive connection first, the tunnel's next request on it fails with
// "error proxying to origin", and a POST (e.g. a device command) is lost before reaching the Hub.

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function mockIntegration() {
  return { start() {}, close() {}, status() { return { configured: false, connected: false, lastError: null }; },
    async command() {}, async refresh() { return []; }, async permitJoin() {} };
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number((/content-length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd)) || [])[1] || 0);
      if (buffer.length >= headerEnd + 4 + length) {
        socket.off("data", onData);
        resolve(buffer.slice(0, buffer.indexOf("\r\n")));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("the Cloud origin listener keeps idle keep-alive connections longer than cloudflared reuses them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-origin-keepalive-"));
  const port = await freePort();
  const hub = createHub({
    config: {
      nodeEnv: "development", adminToken: "admin-token-for-keepalive-test", port: 3000, nativeApiPort: port,
      dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"),
      staticDir: path.join(__dirname, "..", "public"), otbrUrl: "",
    },
    mqttBridge: mockIntegration(), matterBridge: mockIntegration(),
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  try {
    await hub.start();
    assert.ok(hub.server.keepAliveTimeout > 90_000, "idle keep-alive must outlive cloudflared's 90 s origin keep-alive");
    assert.ok(hub.server.headersTimeout > hub.server.keepAliveTimeout, "headersTimeout must exceed keepAliveTimeout");

    const socket = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    let closedByServer = false;
    socket.once("close", () => { closedByServer = true; });
    const get = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n";
    socket.write(get);
    assert.match(await readResponse(socket), /200/);
    await new Promise((resolve) => setTimeout(resolve, 6_000)); // longer than Node's 5 s default
    assert.equal(closedByServer, false, "the Hub must not close an idle keep-alive connection after 5 s");
    socket.write(get);
    assert.match(await readResponse(socket), /200/, "a reused idle connection still reaches the Hub");
    socket.destroy();
  } finally {
    await hub.stop();
  }
});
