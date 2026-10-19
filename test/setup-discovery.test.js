const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
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
  const physical = () => true;
  assert.equal(privateAddress("", interfacesWithBridgeFirst, physical), "192.168.1.76");
  assert.deepEqual(privateInterface("", interfacesWithBridgeFirst, physical), { name: "eth0", address: "192.168.1.76", physicalPriority: 0 });
  assert.equal(privateAddress("192.168.1.76", interfacesWithBridgeFirst, physical), "192.168.1.76", "a stale configured IP is not treated as an interface selector");
  assert.deepEqual(privateInterface("wlan0", interfacesWithBridgeFirst, physical), { name: "wlan0", address: "10.0.0.27", physicalPriority: -1 });
  assert.equal(privateAddress("172.17.0.1", interfacesWithBridgeFirst, physical), "192.168.1.76", "a stale Docker address cannot pin or poison selection");
  assert.equal(privateInterface("", { ...interfacesWithBridgeFirst, eth0: interfacesWithBridgeFirst.eth0 }, (name) => name !== "eth0" && name !== "wlan0"), null, "RFC1918 alone does not prove a physical interface");
});

test("production setup discovery pins the exact serial alias and setup service to the selected LAN interface", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({
    serial: "DIN-HOME-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst,
    spawnProcess, logger: { warn() {} }, physicalCheck: () => true, readAvahiConfig: () => configuredAvahi,
  });
  discovery.start(8123);
  assert.equal(discovery.status().running, false, "discovery is not reported ready until both publisher processes spawn");
  calls.forEach(({ child }) => child.emit("spawn"));
  const status = discovery.status();
  assert.deepEqual(status, { running: true, hostname: "dinodia-din-home-001.local", address: "192.168.1.76", error: null });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["avahi-publish-address", ["-R", "dinodia-din-home-001.local", "192.168.1.76"]],
    ["avahi-publish-service", ["Dinodia OS Setup din-home-001", "_http._tcp", "8123", "path=/setup", "serial=din-home-001"]],
  ]);
  discovery.stop();
  assert.equal(discovery.status().running, false);
});

test("production publishes separate restricted HTTP setup and public-ID HTTPS runtime names", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({
    serial: "DIN-HOME-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst,
    spawnProcess, logger: { warn() {} }, physicalCheck: () => true, readAvahiConfig: () => configuredAvahi,
  });
  discovery.start(80, 80, "dinodia-0123456789abcdefabcd.local", 8123);
  calls.forEach(({ child }) => child.emit("spawn"));
  assert.equal(discovery.observation().baseUrl, "http://192.168.1.76:80", "installer HTTP remains a private-IP setup endpoint on port 80");
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["avahi-publish-address", ["-R", "dinodia-din-home-001.local", "192.168.1.76"]],
    ["avahi-publish-service", ["Dinodia OS Setup din-home-001", "_http._tcp", "80", "path=/setup", "serial=din-home-001"]],
    ["avahi-publish-address", ["-R", "dinodia-0123456789abcdefabcd.local", "192.168.1.76"]],
    ["avahi-publish-service", ["Dinodia OS din-home-001", "_https._tcp", "8123", "path=/api/dinodia/v1/health"]],
  ]);
  discovery.stop();
});

test("missing Avahi publisher reports discovery unavailable instead of claiming it is running", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} }, physicalCheck: () => true, readAvahiConfig: () => configuredAvahi });
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
    spawnProcess, logger: { warn() {} }, physicalCheck: () => true,
    readAvahiConfig: () => configureSetupDiscovery("", { serial: "din-home-001", interfaceName: "wlan0" }),
  });
  discovery.start(8123);
  assert.equal(calls.length, 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /not restricted to the selected setup interface/);
});

test("a link change waits for Avahi's root-owned interface rebind then republishes without losing the new endpoint", () => {
  const { calls, spawnProcess } = spawnRecorder();
  let interfaces = { ...interfacesWithBridgeFirst };
  let avahiConfig = configuredAvahi;
  const observations = [];
  const discovery = new SetupDiscovery({
    serial: "din-home-001", nodeEnv: "production", interfaces: () => interfaces,
    spawnProcess, logger: { warn() {} }, physicalCheck: () => true,
    readAvahiConfig: () => avahiConfig, onEndpointChange: (value) => observations.push(value),
    networkCheckIntervalMs: 60_000,
  });
  discovery.start(8123);
  calls.slice(0, 2).forEach(({ child }) => child.emit("spawn"));
  interfaces = { ...interfacesWithBridgeFirst, eth0: [], wlan0: [{ address: "10.0.0.27", family: "IPv4", internal: false }] };
  discovery.refresh();
  assert.equal(discovery.status().error, "Avahi is not restricted to the selected setup interface");
  assert.equal(calls.length, 2, "do not publish until the daemon is bound to the new NIC");
  assert.equal(observations.at(-1).baseUrl, "http://10.0.0.27:8123");

  avahiConfig = configureSetupDiscovery(avahiConfig, { serial: "din-home-001", interfaceName: "wlan0" });
  discovery.refresh();
  assert.equal(calls.length, 4, "same-address poll retries publication after the privileged config switch");
  calls.slice(2).forEach(({ child }) => child.emit("spawn"));
  assert.equal(discovery.status().running, true);
  assert.equal(discovery.status().address, "10.0.0.27");
  discovery.stop();
});

test("a publisher that exits during startup prevents the other late publisher from becoming active", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} }, physicalCheck: () => true, readAvahiConfig: () => configuredAvahi });
  discovery.start(8123);
  calls[0].child.emit("spawn");
  calls[0].child.exitCode = 0;
  calls[0].child.emit("exit", 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /exited before discovery/);
});

test("a publisher that exits successfully is still reported unavailable", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, spawnProcess, logger: { warn() {} }, physicalCheck: () => true, readAvahiConfig: () => configuredAvahi });
  discovery.start(8123);
  calls.forEach(({ child }) => child.emit("spawn"));
  calls[0].child.exitCode = 0;
  calls[0].child.emit("exit", 0);
  assert.equal(discovery.status().running, false);
  assert.match(discovery.status().error, /exited before discovery/);
  assert.equal(calls[0].child.killed, undefined, "an exited publisher does not need a kill signal");
});

test("DHCP/subnet changes re-publish the restricted alias and immediately report a new endpoint", () => {
  const { calls, spawnProcess } = spawnRecorder();
  let interfaces = { ...interfacesWithBridgeFirst };
  const observations = [];
  const discovery = new SetupDiscovery({
    serial: "din-home-001", nodeEnv: "production", interfaces: () => interfaces,
    spawnProcess, logger: { warn() {} }, physicalCheck: () => true,
    readAvahiConfig: () => configuredAvahi, onEndpointChange: (value) => observations.push(value),
    networkCheckIntervalMs: 60_000,
  });
  discovery.start(8123);
  calls.forEach(({ child }) => child.emit("spawn"));
  assert.equal(discovery.observation().baseUrl, "http://192.168.1.76:8123");
  interfaces = { ...interfacesWithBridgeFirst, eth0: [{ address: "192.168.0.110", family: "IPv4", internal: false }] };
  discovery.refresh();
  calls.slice(2).forEach(({ child }) => child.emit("spawn"));
  assert.equal(discovery.status().address, "192.168.0.110");
  assert.equal(discovery.observation().baseUrl, "http://192.168.0.110:8123");
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(observations.map((value) => value.baseUrl), ["http://192.168.1.76:8123", "http://192.168.0.110:8123"]);
  assert.equal(calls.slice(2).every(({ args }) => !args.includes("-i")), true);
  discovery.stop();
});

test("missing physical LAN interface reports UNAVAILABLE rather than a loopback or virtual address", () => {
  const { calls, spawnProcess } = spawnRecorder();
  const discovery = new SetupDiscovery({ serial: "din-home-001", nodeEnv: "production", interfaces: () => interfacesWithBridgeFirst, physicalCheck: () => false, spawnProcess, logger: { warn() {} } });
  discovery.start(8123);
  assert.equal(discovery.observation().state, "UNAVAILABLE");
  assert.equal(discovery.observation().baseUrl, undefined);
  assert.equal(calls.length, 0);
  discovery.stop();
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
  assert.match(installer, /dinodia-setup-discovery-sync\.timer/);
  assert.match(installer, /disable --now dinodia-setup-discovery-sync\.timer/);
  assert.match(installer, /install -o root -g root -m 0555 .*reconcile_setup_avahi\.mjs/);
  assert.match(installer, /DISCOVERY_RELEASE_ROOT="\/usr\/local\/lib\/dinodia-setup-discovery-releases"/);
  assert.match(installer, /DISCOVERY_CURRENT_LINK="\/usr\/local\/lib\/dinodia-setup-discovery-current"/);
  assert.match(installer, /DISCOVERY_LINK_SWITCHED/);
  assert.match(installer, /DINODIA_HIVE_WHEELHOUSE/);
  assert.match(installer, /the Hive wheelhouse may contain only top-level wheel files/);
  assert.match(installer, /wheel count does not match the locked requirement count/);
  assert.match(installer, /--no-index --find-links .*--only-binary=:all: --require-hashes/);
  const offlinePipInstall = installer.indexOf("--no-index --find-links");
  const wheelhouseRemoval = installer.indexOf('rm -rf -- "$HIVE_WHEELHOUSE_STAGE"');
  const releasePublish = installer.indexOf('mv -T --no-clobber -- "$STAGE_DIR" "$RELEASE_DIR"');
  assert.ok(offlinePipInstall > stageCopy && wheelhouseRemoval > offlinePipInstall && releasePublish > wheelhouseRemoval);
  const serviceUnit = fs.readFileSync(path.join(__dirname, "..", "systemd", "dinodia-setup-discovery-sync.service"), "utf8");
  const timerUnit = fs.readFileSync(path.join(__dirname, "..", "systemd", "dinodia-setup-discovery-sync.timer"), "utf8");
  assert.match(serviceUnit, /User=root/);
  assert.match(serviceUnit, /ReadWritePaths=\/etc\/avahi/);
  assert.match(serviceUnit, /\/usr\/local\/lib\/dinodia-setup-discovery-current\/scripts\/reconcile_setup_avahi\.mjs/);
  assert.doesNotMatch(serviceUnit, /\/opt\/dinodia-os(?:-releases)?\/.*reconcile_setup_avahi/);
  assert.match(timerUnit, /OnUnitActiveSec=10s/);
  assert.match(timerUnit, /Unit=dinodia-setup-discovery-sync\.service/);
});

test("root Avahi reconciler tracks the selected interface, atomically rebinds, and withdraws when no private NIC exists", async () => {
  const os = require("node:os");
  const osTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-avahi-reconcile-"));
  const identityPath = path.join(osTmp, "identity.json");
  const environmentPath = path.join(osTmp, ".env");
  const configPath = path.join(osTmp, "avahi-daemon.conf");
  const events = [];
  let daemonActive = true;
  const runSystemctl = (args) => {
    events.push(args);
    if (args[0] === "stop") daemonActive = false;
    if (args[0] === "restart" || args[0] === "start") daemonActive = true;
  };
  const replaceConfig = (file, text) => { events.push(["atomic-write", file]); fs.writeFileSync(file, text); };
  try {
    fs.writeFileSync(identityPath, JSON.stringify({ serial: "din-home-001" }));
    fs.writeFileSync(environmentPath, "DINODIA_SETUP_INTERFACE=wlan0\n");
    fs.writeFileSync(configPath, configuredAvahi);
    const { reconcileAvahiSetup } = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "reconcile_setup_avahi.mjs")).href);
    const ethernetAndWifi = {
      ...interfacesWithBridgeFirst,
      wlan0: [{ address: "10.0.0.27", family: "IPv4", internal: false }],
    };
    const switched = reconcileAvahiSetup({ identityPath, environmentPath, configPath, interfaces: ethernetAndWifi, physicalCheck: () => true, isActive: () => daemonActive, runSystemctl, replaceConfig });
    assert.deepEqual(switched, { state: "CURRENT", action: "restart", interfaceName: "wlan0" });
    assert.equal(avahiSetupConfigMatches(fs.readFileSync(configPath, "utf8"), { serial: "din-home-001", interfaceName: "wlan0" }), true);
    assert.deepEqual(events.slice(-1), [["restart", "avahi-daemon"]]);
    events.length = 0;
    const unchanged = reconcileAvahiSetup({ identityPath, environmentPath, configPath, interfaces: ethernetAndWifi, physicalCheck: () => true, isActive: () => true, runSystemctl, replaceConfig });
    assert.deepEqual(unchanged, { state: "CURRENT", action: "none", interfaceName: "wlan0" });
    assert.equal(events.length, 0);
    const unavailable = reconcileAvahiSetup({ identityPath, environmentPath, configPath, interfaces: {}, physicalCheck: () => true, isActive: () => true, runSystemctl, replaceConfig });
    assert.deepEqual(unavailable, { state: "UNAVAILABLE", action: "stop" });
    assert.deepEqual(events, [["stop", "avahi-daemon"]]);
    events.length = 0;
    const alreadyStopped = reconcileAvahiSetup({ identityPath, environmentPath, configPath, interfaces: {}, physicalCheck: () => true, isActive: () => false, runSystemctl, replaceConfig });
    assert.deepEqual(alreadyStopped, { state: "UNAVAILABLE", action: "none" });
    assert.equal(events.length, 0, "no-interface polling does not repeatedly invoke systemctl when Avahi is already stopped");
  } finally {
    fs.rmSync(osTmp, { recursive: true, force: true });
  }
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

test("Avahi reconciliation restores exact prior configuration when restart or applied-config verification fails", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-avahi-rollback-"));
  const identityPath = path.join(temporary, "identity.json");
  const environmentPath = path.join(temporary, "environment");
  const configPath = path.join(temporary, "avahi-daemon.conf");
  const original = "[server]\nallow-interfaces=eth0\n\n[publish]\npublish-addresses=yes\npublish-workstation=no\n";
  const interfaces = { wlan0: [{ address: "192.168.50.14", family: "IPv4", internal: false }] };
  try {
    fs.writeFileSync(identityPath, JSON.stringify({ serial: "din-home-001" }));
    fs.writeFileSync(environmentPath, "DINODIA_SETUP_INTERFACE=eth0\n");
    fs.writeFileSync(configPath, original);
    const { reconcileAvahiSetup } = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "reconcile_setup_avahi.mjs")).href);

    let restartCalls = 0;
    assert.throws(() => reconcileAvahiSetup({
      identityPath, environmentPath, configPath, interfaces, physicalCheck: () => true,
      active: true, isActive: () => true,
      replaceConfig: (file, text) => fs.writeFileSync(file, text),
      runSystemctl(args) {
        if (args[0] === "restart" && restartCalls++ === 0) throw new Error("simulated restart failure");
      },
    }), /simulated restart failure/);
    assert.equal(fs.readFileSync(configPath, "utf8"), original, "failed daemon restart must restore the exact old config bytes");
    assert.equal(restartCalls, 2, "rollback attempts one restart with the restored config");

    assert.throws(() => reconcileAvahiSetup({
      identityPath, environmentPath, configPath, interfaces, physicalCheck: () => true,
      active: true, isActive: () => true,
      runSystemctl() {},
      replaceConfig(file, text) {
        // Simulate an atomic writer that returned but did not apply the
        // selected-interface configuration. The reconciler must detect it.
        fs.writeFileSync(file, text === original ? original : `${text}\n[server]\nallow-interfaces=eth0\n`);
      },
    }), /did not match the selected physical interface/);
    assert.equal(fs.readFileSync(configPath, "utf8"), original, "failed postcondition must restore the exact old config bytes");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("root discovery CLI executes through release symlinks and imports remain side-effect free", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-avahi-cli-"));
  const identityPath = path.join(temporary, "identity.json");
  const environmentPath = path.join(temporary, "environment");
  const configPath = path.join(temporary, "avahi-daemon.conf");
  const symlinkPath = path.join(temporary, "reconcile-current.mjs");
  const symlinkChainPath = path.join(temporary, "reconcile-current-chain.mjs");
  const scriptPath = path.join(__dirname, "..", "scripts", "reconcile_setup_avahi.mjs");
  const interfaces = {
    wlan0: [{ address: "192.168.50.14", family: "IPv4", internal: false }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  };
  try {
    fs.writeFileSync(identityPath, JSON.stringify({ serial: "din-home-001" }));
    fs.writeFileSync(environmentPath, "DINODIA_SETUP_INTERFACE=eth0\n");
    fs.writeFileSync(configPath, configureSetupDiscovery("", { serial: "din-home-001", interfaceName: "eth0" }));
    fs.symlinkSync(scriptPath, symlinkPath);
    fs.symlinkSync(symlinkPath, symlinkChainPath);

    const invoke = (entry, nodeOptions = []) => spawnSync(process.execPath, [...nodeOptions, entry, "--dry-run", "--identity", identityPath,
      "--environment", environmentPath, "--config", configPath, "--interfaces-json", JSON.stringify(interfaces)],
    { encoding: "utf8", timeout: 5000 });
    for (const [entry, options] of [
      [scriptPath, []],
      [symlinkPath, []],
      [symlinkChainPath, ["--no-warnings"]],
      [symlinkChainPath, ["--preserve-symlinks-main"]],
    ]) {
      const result = invoke(entry, options);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout, "mDNS interface plan state=AVAILABLE action=restart interface=wlan0\n");
      assert.equal(result.stderr, "");
    }

    const beforeImport = fs.readFileSync(configPath, "utf8");
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(require("node:url").pathToFileURL(scriptPath).href)})`],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "", "library import must not run or print the privileged CLI");
    assert.equal(fs.readFileSync(configPath, "utf8"), beforeImport, "library import must not mutate Avahi configuration");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Avahi CLI integration confirms supported publisher syntax when Linux tools are installed", { skip: !fs.existsSync("/usr/bin/avahi-publish-service") && !fs.existsSync("/usr/sbin/avahi-publish-service") }, () => {
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
