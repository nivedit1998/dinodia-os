const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { SetupDiscovery, privateInterface, privateAddress } = require("../src/setupDiscovery");

const interfacesWithBridgeFirst = {
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  "br-1234567890ab": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
  eth0: [{ address: "192.168.1.76", family: "IPv4", internal: false }],
  wlan0: [{ address: "10.0.0.27", family: "IPv4", internal: false }],
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
};

function spawnRecorder() {
  const calls = [];
  let nextPid = 1000;
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = nextPid++;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => { child.killed = true; return true; };
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

test("mDNS discovery prefers the actual Ethernet/Wi-Fi address over RFC1918 container bridges", () => {
  assert.equal(privateAddress("", interfacesWithBridgeFirst), "192.168.1.76");
  assert.deepEqual(privateInterface("", interfacesWithBridgeFirst), { name: "eth0", address: "192.168.1.76", physicalPriority: 0 });
  assert.equal(privateAddress("10.0.0.27", interfacesWithBridgeFirst), "10.0.0.27");
  assert.deepEqual(privateInterface("10.0.0.27", interfacesWithBridgeFirst), { name: "wlan0", address: "10.0.0.27", physicalPriority: 0 });
  assert.equal(privateAddress("172.17.0.1", interfacesWithBridgeFirst), "", "configured Docker bridge address is refused");
});

test("production setup discovery pins the exact serial alias and setup service to the selected LAN interface", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({
    serial: "DIN-HOME-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst,
    spawnProcess, logger: { warn() {} },
  });
  discovery.start(8123);
  assert.equal(discovery.status().running, false, "discovery is not reported ready until both publisher processes spawn");
  calls.forEach(({ child }) => child.emit("spawn"));
  const status = discovery.status();
  assert.deepEqual(status, { running: true, hostname: "dinodia-din-home-001.local", address: "192.168.1.76", error: null });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["avahi-publish-address", ["--interface", "eth0", "dinodia-din-home-001.local", "192.168.1.76"]],
    ["avahi-publish-service", ["--interface", "eth0", "Dinodia OS din-home-001", "_http._tcp", "8123", "path=/setup", "serial=din-home-001"]],
  ]);
  discovery.stop();
  assert.equal(discovery.status().running, false);
});

test("missing Avahi publisher reports discovery unavailable instead of claiming it is running", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} } });
  discovery.start(8123);
  calls[0].child.pid = undefined;
  calls[1].child.pid = undefined;
  calls[0].child.emit("error", Object.assign(new Error("missing publisher"), { code: "ENOENT" }));
  assert.equal(discovery.status().running, false);
  assert.equal(discovery.status().error, "avahi-publish-address is not installed");
  assert.equal(calls[0].child.killed, undefined, "a failed spawn has no child PID and must not signal the test process group");
  assert.equal(calls[1].child.killed, undefined, "a publisher still starting has no PID to signal");
  calls[1].child.pid = 1001;
  calls[1].child.emit("spawn");
  assert.equal(calls[1].child.killed, true, "a late publisher is stopped when its attempt was already invalidated");
});

test("a publisher that exits during startup prevents the other late publisher from becoming active", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} } });
  discovery.start(8123);
  calls[0].child.emit("spawn");
  calls[0].child.exitCode = 0;
  calls[0].child.emit("exit", 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /exited before discovery/);
  calls[1].child.pid = 1001;
  calls[1].child.emit("spawn");
  assert.equal(discovery.status().running, false);
  assert.equal(calls[1].child.killed, true, "the late process is terminated without claiming readiness");
});

test("a publisher that exits successfully is still reported unavailable", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} } });
  discovery.start(8123);
  calls.forEach(({ child }) => child.emit("spawn"));
  calls[0].child.exitCode = 0;
  calls[0].child.emit("exit", 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /exited before discovery/);
  assert.equal(calls[0].child.killed, undefined, "an exited publisher does not need a kill signal");
  assert.equal(calls[1].child.killed, true, "the paired publisher is stopped when one exits early");
});

test("Pi installer preflights candidate before installing Avahi publisher dependency", () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "scripts", "install-pi.sh"), "utf8");
  const preflight = installer.indexOf("BUILD_ID=\"$(node");
  const avahiInstall = installer.indexOf("apt-get install -y avahi-daemon avahi-utils");
  const stageCopy = installer.indexOf("cp -a \"${candidate_files[@]/#/$APP_SOURCE/}\"");
  assert.ok(preflight >= 0 && avahiInstall > preflight && stageCopy > avahiInstall);
  assert.match(installer, /avahi-publish-address.*required for locked-setup discovery/);
  assert.match(installer, /avahi-publish-service.*required for locked-setup discovery/);
  assert.match(installer, /apt-get install -y avahi-daemon avahi-utils/);
});
