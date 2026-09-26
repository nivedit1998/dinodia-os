const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { SetupDiscovery, privateInterface, privateAddress } = require("../src/setupDiscovery");
const { configureSetupDiscovery, avahiSetupConfigMatches } = require("../src/avahiSetupConfig");
const configuredAvahi = configureSetupDiscovery("", { serial: "din-home-001", interfaceName: "eth0" });

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
    spawnProcess, logger: { warn() {} }, readAvahiConfig: () => configuredAvahi,
  });
  discovery.start(8123);
  assert.equal(discovery.status().running, false, "discovery is not reported ready until both publisher processes spawn");
  calls.forEach(({ child }) => child.emit("spawn"));
  const status = discovery.status();
  assert.deepEqual(status, { running: true, hostname: "dinodia-din-home-001.local", address: "192.168.1.76", error: null });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["avahi-publish-address", ["-R", "dinodia-din-home-001.local", "192.168.1.76"]],
    ["avahi-publish-service", ["Dinodia OS din-home-001", "_http._tcp", "8123", "path=/setup", "serial=din-home-001"]],
  ]);
  discovery.stop();
  assert.equal(discovery.status().running, false);
});

test("missing Avahi publisher reports discovery unavailable instead of claiming it is running", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} }, readAvahiConfig: () => configuredAvahi });
  discovery.start(8123);
  calls[0].child.pid = undefined;
  calls[0].child.emit("error", Object.assign(new Error("missing publisher"), { code: "ENOENT" }));
  assert.equal(discovery.status().running, false);
  assert.equal(discovery.status().error, "avahi-publish-address is not installed");
  assert.equal(calls[0].child.killed, undefined, "a failed spawn has no child PID and must not signal the test process group");
});

test("mDNS publisher refuses to run when daemon interface binding differs from the selected private LAN", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({
    serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst,
    spawnProcess, logger: { warn() {} },
    readAvahiConfig: () => configureSetupDiscovery("", { serial: "din-home-001", interfaceName: "wlan0" }),
  });
  discovery.start(8123);
  assert.equal(calls.length, 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /not restricted to the selected setup interface/);
});

test("a publisher that exits during startup prevents the other late publisher from becoming active", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} }, readAvahiConfig: () => configuredAvahi });
  discovery.start(8123);
  calls[0].child.emit("spawn");
  calls[0].child.exitCode = 0;
  calls[0].child.emit("exit", 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /exited before discovery/);
});

test("a publisher that exits successfully is still reported unavailable", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} }, readAvahiConfig: () => configuredAvahi });
  discovery.start(8123);
  calls.forEach(({ child }) => child.emit("spawn"));
  calls[0].child.exitCode = 0;
  calls[0].child.emit("exit", 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /exited before discovery/);
  assert.equal(calls[0].child.killed, undefined, "an exited publisher does not need a kill signal");
});

test("Pi installer preflights candidate before installing Avahi publisher dependency", () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "scripts", "install-pi.sh"), "utf8");
  const preflight = installer.indexOf("BUILD_ID=\"$(node");
  const avahiInstall = installer.indexOf("apt-get install -y avahi-daemon avahi-utils");
  const stageCopy = installer.indexOf("cp -a \"${candidate_files[@]/#/$APP_SOURCE/}\"");
  assert.ok(preflight >= 0 && avahiInstall > preflight && stageCopy > avahiInstall);
  assert.match(installer, /avahi-publish-service.*required for locked-setup discovery/);
  assert.match(installer, /avahi-publish-address.*required for locked-setup discovery/);
  assert.match(installer, /apt-get install -y avahi-daemon avahi-utils/);
  assert.match(installer, /avahi-resolve-host-name/);
  assert.match(installer, /avahi-publish-address --help/);
  assert.match(installer, /--no-reverse/);
  assert.match(installer, /AVAHI_CONFIG/);
  assert.match(installer, /cp -p "\$AVAHI_CONFIG" "\$BACKUP_DIR\/avahi-daemon.conf"/);
  assert.match(installer, /install -o root -g root -m 0644 "\$BACKUP_DIR\/avahi-daemon.conf" "\$AVAHI_CONFIG"/);
  assert.match(installer, /resolved_address.*AVAHI_SETUP_ADDRESS/s);
  assert.match(installer, /avahi-resolve-host-name -4/);
  assert.ok(installer.indexOf('if [[ "$discovery_ok" -ne 1 ]]') < installer.indexOf("COMPLETED=1"));
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "src", "setupDiscovery.js"), "utf8"), /avahi-publish-(?:address|service).*\[["']-i["']/s);
});

test("Avahi daemon configuration confines alias and service publication to one selected interface", () => {
  const existing = "[server]\n#host-name=old-host\n#allow-interfaces=wlan0\nuse-ipv4=yes\n\n[publish]\n#publish-addresses=no\npublish-workstation=no\n";
  const configured = configureSetupDiscovery(existing, { serial: "DIN-HOME-001", interfaceName: "eth0" });
  assert.match(configured, /^\[server\]\nallow-interfaces=eth0\n#host-name=old-host\nuse-ipv4=yes/m);
  assert.match(configured, /\[publish\]\npublish-addresses=yes\npublish-workstation=no/);
  assert.doesNotMatch(configured, /allow-interfaces=.*(?:wlan0|docker0)/);
  assert.equal(avahiSetupConfigMatches(configured, { serial: "din-home-001", interfaceName: "eth0" }), true);
  assert.equal(avahiSetupConfigMatches(configured, { serial: "din-home-001", interfaceName: "wlan0" }), false);
  assert.throws(() => configureSetupDiscovery(existing, { serial: "bad/serial", interfaceName: "eth0" }), /serial is invalid/);
  assert.throws(() => configureSetupDiscovery(existing, { serial: "din-home-001", interfaceName: "interface-name-too-long" }), /interface is invalid/);
  assert.throws(() => configureSetupDiscovery(`${existing}\n[server]\nallow-interfaces=wlan0\n`, { serial: "din-home-001", interfaceName: "eth0" }), /ambiguous \[server\] sections/);
  assert.equal(avahiSetupConfigMatches(`${configured}\n[server]\nallow-interfaces=wlan0\n`, { serial: "din-home-001", interfaceName: "eth0" }), false);
});

test("Avahi CLI integration confirms supported publisher syntax when Linux tools are installed", { skip: !fs.existsSync("/usr/bin/avahi-publish-service") && !fs.existsSync("/usr/sbin/avahi-publish-service") }, () => {
  const { spawnSync } = require("node:child_process");
  const addressHelp = spawnSync("avahi-publish-address", ["--help"], { encoding: "utf8" });
  const help = spawnSync("avahi-publish-service", ["--help"], { encoding: "utf8" });
  assert.equal(addressHelp.status, 0);
  assert.match(addressHelp.stdout + addressHelp.stderr, /<host-name> <address>/);
  assert.match(addressHelp.stdout + addressHelp.stderr, /-R\s+--no-reverse/);
  assert.equal(help.status, 0);
  assert.match(help.stdout + help.stderr, /<name> <type> <port>/);
  assert.doesNotMatch(addressHelp.stdout + addressHelp.stderr + help.stdout + help.stderr, /--interface/);
});

test("isolated Linux Avahi daemon proves reverse-record collision avoidance, interface scope, and restart", {
  skip: process.platform !== "linux" || process.env.DINODIA_AVAHI_LINUX_INTEGRATION !== "1" || process.getuid?.() !== 0,
}, () => {
  const { spawnSync } = require("node:child_process");
  const script = path.join(__dirname, "..", "scripts", "test_setup_discovery_linux.sh");
  const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Avahi setup discovery integration passed/);
});
