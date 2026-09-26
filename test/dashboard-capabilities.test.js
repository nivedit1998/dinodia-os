const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const controls = fs.readFileSync(path.join(__dirname, "../public/js/capabilityControls.js"), "utf8");
const devicesScript = fs.readFileSync(path.join(__dirname, "../public/js/devices.js"), "utf8");
const radiosScript = fs.readFileSync(path.join(__dirname, "../public/js/radios.js"), "utf8");
const apiScript = fs.readFileSync(path.join(__dirname, "../public/js/api.js"), "utf8");
const pairingScript = fs.readFileSync(path.join(__dirname, "../public/js/pairing.js"), "utf8");
const automationsScript = fs.readFileSync(path.join(__dirname, "../public/js/automations.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
const configScript = fs.readFileSync(path.join(__dirname, "../src/config.js"), "utf8");
const compose = fs.readFileSync(path.join(__dirname, "../docker-compose.yml"), "utf8");
const dockerfile = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");
const healthcheck = fs.readFileSync(path.join(__dirname, "../scripts/healthcheck.js"), "utf8");
const installer = fs.readFileSync(path.join(__dirname, "../scripts/install-pi.sh"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");

test("dashboard keeps the intended setup order and production safety boundary", () => {
  const order = ["cloudflare-section", "provisioning-section", "areas-section", "radios-section", "devices-section"];
  assert.ok(order.every((id) => html.includes(`id="${id}"`)));
  assert.ok(order.every((id, index) => html.indexOf(`id="${id}"`) < html.indexOf(`id="${order[index + 1] || id}"`) || index === order.length - 1));
  assert.match(html, /Areas are created during hub provisioning or by Home Support/);
  assert.doesNotMatch(html, /Add test device|Raw JSON command/i);
});

test("pairing status renders friendly Zigbee and Matter device identities", () => {
  assert.match(app, /foundDevices\.map/);
  assert.match(app, /loadMatterPairingStatus/);
  assert.match(app, /integrations\/matter\/pairing/);
  assert.match(app, /device\.manufacturer, device\.model/);
});

test("Google Nest setup shows the official project and credentials steps", () => {
  assert.match(app, /console\.nest\.google\.com\/device-access\/project-list/);
  assert.match(app, /console\.cloud\.google\.com\/apis\/credentials/);
  assert.match(app, /Step 1 — Start a Device Access project/);
  assert.match(app, /OAuth 2\.0 Client ID → Web application/);
  assert.match(app, /authorised redirect URI/);
  assert.match(app, /Device Access project ID.*different from the Google Cloud project ID/);
  assert.match(app, /Never send the secret in chat or store it in source control/);
});

test("Hive pairing exposes a sanitized summary and suggests Boiler at device setup", () => {
  const context = { window: {} };
  vm.runInNewContext(pairingScript, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.DinodiaPairing.hiveSummary({ configured: true, status: "connected", heatingDeviceCount: 2, ignoredDeviceIds: ["zone-1"] }))), {
    configured: true,
    connected: true,
    status: "connected",
    heatingDeviceCount: 2,
    hotWaterDeviceCount: 0,
    ignoredDeviceCount: 1,
    needsReauth: false,
  });
  assert.match(app, /\["hive",\s*"google_nest"\]\.includes\(device\.protocol\).*device\.definition\?\.kind === "heating"/);
  assert.match(app, /suggestedLabel/);
  assert.match(app, /localCount = state\.devices\.filter/);
});

test("completed secure access and provisioning replace setup inputs with confirmation rows", () => {
  assert.match(html, /id="cloudflare-connected-row" class="setup-complete-row hidden"/);
  assert.match(html, /id="provisioning-complete-row" class="setup-complete-row hidden"/);
  assert.match(app, /\$\("#cloudflare-setup-form"\)\.classList\.toggle\("hidden", localConnected\)/);
  assert.match(app, /platformVerification\?\.state === "PLATFORM_VERIFIED"/);
  assert.match(app, /\$\("#pair-form"\)\.classList\.toggle\("hidden", paired\)/);
  assert.doesNotMatch(html, /advanced-cloudflare|regenerate-credentials/);
  assert.doesNotMatch(app, /bootstrapSecret|haUsername|haPassword|oneTimeLongLivedToken/);
});

test("secure-access re-verification requires a connected tunnel and the operator handoff confirms an authenticated session", () => {
  const setupScript = fs.readFileSync(path.join(__dirname, "../public/setup.js"), "utf8");
  assert.match(html, /id="cloudflare-reverify"/);
  assert.match(app, /cloudflare-reverify.*hidden.*verified && localConnected/);
  assert.match(app, /action: "reverify"/);
  assert.match(setupScript, /fetch\("\/_dinodia\/admin\/api\/status", \{ cache: "no-store", credentials: "same-origin" \}\)/);
  assert.match(setupScript, /if \(!sessionCheck\.ok\) throw/);
  assert.match(setupScript, /dinodia-operator-session-established/);
  assert.match(setupScript, /"https:\/\/dinodia-platform-v2\.vercel\.app"/);
  assert.match(fs.readFileSync(path.join(__dirname, "../src/config.js"), "utf8"), /operatorPolicySyncIntervalMs: Math\.max\(15000, Math\.min\(numberEnv\("DINODIA_OPERATOR_POLICY_SYNC_INTERVAL_MS", 30000\), 60000\)\)/);
});

test("dashboard controls are generated from capability metadata and call the typed route", () => {
  assert.match(controls, /data-service/);
  assert.match(controls, /capability\.kind === "number"/);
  assert.match(app, /\/api\/entities\/\$\{encodeURIComponent\(entityId\)\}\/service/);
  assert.doesNotMatch(app, /raw-command|test-device/i);
});

test("range controls show their current value and submit on release", () => {
  const context = { window: {} };
  vm.runInNewContext(controls, context);
  const html = context.window.DinodiaCapabilityControls.controls({
    id: "zigbee:radiator:surface:climate",
    name: "Radiator upstairs",
    state: "heat",
    attributes: { temperature: 12.5 },
    capability: {
      kind: "composite",
      writable: true,
      bindings: [{ serviceId: "climate.set_temperature", parameter: { key: "temperature", type: "number", min: 4, max: 35, step: 0.5 } }],
    },
  });
  assert.match(html, /class="range-value"/);
  assert.match(html, />12\.5<\/output>/);
  const genericHtml = context.window.DinodiaCapabilityControls.controls({ id: "device:surface", name: "Generic device", state: "on", attributes: { target_level: 42 }, capability: { kind: "composite", writable: true, bindings: [{ serviceId: "number.set_value", parameter: { key: "target_level", type: "number", min: 0, max: 100, step: 1 } }] } });
  assert.match(genericHtml, /data-parameter="target_level"/);
  assert.match(genericHtml, />42<\/output>/);
  assert.match(app, /control\.type === "range"\) control\.addEventListener\("change"/);
  assert.match(app, /input\.type !== "range"/);
});

test("dashboard API requests use the unified same-origin admin namespace", () => {
  assert.match(apiScript, /const ADMIN_API_PREFIX = "\/_dinodia\/admin"/);
  assert.match(apiScript, /value\.startsWith\("\/api\/"\)/);
  assert.match(apiScript, /fetch\(dashboardRoute\(route\)/);
});

test("Devices & entities receives pushed updates and has a polling fallback", () => {
  assert.match(app, /new WebSocket\(dashboardWebSocketUrl\(\)\)/);
  assert.match(app, /state_changed/);
  assert.match(app, /dinodia_dashboard_updated/);
  assert.match(app, /setInterval\(refreshDevices, 10000\)/);
  assert.match(app, /deviceEditorHasFocus/);
});

test("activity defaults to ten rows and can expand while automations use a full-width section", () => {
  assert.match(html, /id="activity-expand"/);
  assert.match(app, /expanded: false/);
  assert.match(app, /limit: state\.activity\.expanded \? "50" : "10"/);
  assert.match(app, /records\.slice\(0, 10\)/);
  assert.match(html, /class="management-stack"/);
  assert.match(html, /class="panel compact-panel automation-panel"/);
});

test("native automation dashboard is catalogue-driven and does not expose raw JSON controls", () => {
  assert.match(html, /id="automation-native"/);
  assert.match(html, /js\/automations\.js/);
  assert.match(automationsScript, /api\/automations\/catalog/);
  assert.match(automationsScript, /data-action-device/);
  assert.match(automationsScript, /data-automation-area-filter/);
  assert.match(automationsScript, /data-automation-label-filter/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /id="automation-form"|name="actions"[^>]*textarea/i);
  assert.doesNotMatch(automationsScript, /name=["'](?:serviceId|deviceId)["']/i);
  assert.doesNotMatch(automationsScript, /<textarea/i);
});

test("heating demand controller has explicit mappings, read-only verification, and an enablement boundary", () => {
  assert.match(html, /id="heating-demand-section"/);
  assert.match(html, /Heating demand controller/);
  assert.ok(app.includes("/api/heating-demand-controller"));
  assert.ok(app.includes("/api/heating-demand-controller/verify"));
  assert.match(app, /Read-only verification never sends climate commands/);
  assert.match(app, /Enable automatic heating control/);
  assert.ok(app.includes("Dinodia OS may send heat/off commands"));
  assert.match(app, /radiatorDeviceIds/);
  assert.match(app, /heatingDemandFormIsFocused/);
  assert.match(app, /heatingDemandDraft/);
  assert.match(app, /controllerStatusReason/);
  assert.match(app, /heating-demand-radiator-picker/);
  assert.match(app, /On: set the value below during heat demand/);
  assert.match(css, /max-height: 225px/);
  assert.match(css, /controller-health-amber/);
  assert.match(css, /controller-switch:has\(input:checked\)/);
  assert.match(css, /appearance: none/);
});

test("activity renders friendly incident copy for current and legacy outage records", () => {
  assert.match(app, /friendlyActivityRecord/);
  assert.match(app, /Matter services/);
  assert.match(app, /service has not recovered/);
  assert.match(app, /activityIntegrationName\(change.integration\)/);
});

test("final packaging has no separate legacy dashboard port", () => {
  assert.doesNotMatch(configScript, /DINODIA_(?:PORT|HOST)\b/);
  assert.doesNotMatch(compose, /3000:3000/);
  assert.doesNotMatch(dockerfile, /EXPOSE[^\n]*3000/);
  assert.doesNotMatch(healthcheck, /127\.0\.0\.1:3000/);
  assert.doesNotMatch(installer, /:3000\b/);
  assert.doesNotMatch(readme, /:3000\b/);
  assert.match(compose, /uart-baudrate=460800/);
  assert.match(html, /thread-adapter-select/);
  assert.match(app, /integrations\/thread\/adapter/);
});

test("radio setup collapses into connected rows and renders both protocol roles", () => {
  assert.match(html, /id="zigbee-radio-setup"/);
  assert.match(html, /id="thread-radio-setup"/);
  assert.match(html, /id="zigbee-connected-row" class="setup-complete-row radio-connected-row hidden"/);
  assert.match(html, /id="thread-connected-row" class="setup-complete-row radio-connected-row hidden"/);
  assert.match(app, /radioInventory: \{ zigbee: null, thread: null \}/);
  assert.match(app, /window\.DinodiaRadios\.threadConnectionStatus/);
  assert.match(app, /\/api\/integrations\/\$\{kind\}\/adapter/);
  assert.match(app, /data-radio-kind="\$\{kind\}"/);
  assert.match(app, /protocolName = kind === "zigbee" \? "Zigbee" : "Thread"/);
  assert.match(app, /networkGraphSvg/);
  assert.match(app, /network-graph-edges/);
  assert.match(app, /network-graph-node/);
});

test("device manager sorts legacy entities while keeping the device area authoritative", () => {
  const context = { window: {} };
  vm.runInNewContext(devicesScript, context);
  const device = {
    areaId: null,
    entities: {
      "device:voltage": { id: "device:voltage", name: "Voltage", capability: { kind: "number", writable: false }, labelIds: [] },
      "device:switch-2": { id: "device:switch-2", name: "Switch 2", capability: { kind: "boolean", writable: true, bindings: [{ service: "switch.turn_on" }] }, labelIds: [] },
      "device:switch-1": { id: "device:switch-1", name: "Switch 1", capability: { kind: "boolean", writable: true, bindings: [{ service: "switch.turn_on" }] }, labelIds: ["light"] },
      "device:battery": { id: "device:battery", name: "Battery", capability: { kind: "number", writable: false }, labelIds: ["tenant_device"] },
    },
  };
  assert.deepEqual(Array.from(context.window.DinodiaDevices.sortEntities(device), (entity) => entity.id), [
    "device:switch-1",
    "device:switch-2",
    "device:battery",
    "device:voltage",
  ]);
  device.areaId = "kitchen";
  device.entities["device:switch-1"].areaId = "bedroom";
  device.entities["device:switch-2"].areaId = "bedroom";
  assert.deepEqual(Array.from(context.window.DinodiaDevices.effectiveAreaIds(device)), ["kitchen"]);
  assert.equal(context.window.DinodiaDevices.areaSummary(device, [{ id: "kitchen", name: "Kitchen" }, { id: "bedroom", name: "Bedroom" }]), "Kitchen");
});

test("label selectors provide a None option that clears labels", () => {
  assert.match(app, /const NONE_LABEL_VALUE = "__none__"/);
  assert.match(app, />None<\/option>/);
  assert.match(app, /selectedLabelIds\(select\)/);
  assert.match(app, /!selected \|\| selected === NONE_LABEL_VALUE \? \[\] : \[selected\]/);
  assert.doesNotMatch(app, /<select multiple data-(?:device|entity)-labels/);
});

test("dashboard defensively hides radio infrastructure records", () => {
  const context = { window: {} };
  vm.runInNewContext(devicesScript, context);
  assert.equal(context.window.DinodiaDevices.isInfrastructureDevice({ protocol: "zigbee", name: "Coordinator", metadata: { type: "Coordinator" } }), true);
  assert.equal(context.window.DinodiaDevices.isInfrastructureDevice({ protocol: "zigbee", name: "Coordinator", metadata: { type: "EndDevice" }, entities: { "zigbee:lamp:state": {} } }), false);
});

test("radio tiles only report online when the selected dongle, MQTT, and Zigbee2MQTT are working", () => {
  const context = { window: {} };
  vm.runInNewContext(radiosScript, context);
  const adapter = { path: "/dev/serial/by-id/usb-Home_Assistant_Connect", name: "Home Assistant Connect ZBT-1", supported: true, connected: true };
  assert.equal(context.window.DinodiaRadios.connectionStatus(adapter, adapter.path, { connected: true, service: { running: true } }).label, "Online");
  assert.equal(context.window.DinodiaRadios.connectionStatus(adapter, adapter.path, { connected: false, service: { running: true } }).label, "Offline");
  assert.equal(context.window.DinodiaRadios.connectionStatus(adapter, "/dev/other", { connected: true, service: { running: true } }).label, "Not selected");
  assert.equal(context.window.DinodiaRadios.connectionStatus({ ...adapter, supported: false, reason: "Unsupported" }, adapter.path, { connected: true, service: { running: true } }).label, "Unsupported");
  const threadAdapter = { path: "/dev/serial/by-id/usb-SONOFF_Thread", name: "SONOFF Thread MG21", supported: true, connected: true };
  assert.equal(context.window.DinodiaRadios.threadConnectionStatus(threadAdapter, threadAdapter.path, { reachable: true, state: "leader", service: { running: true } }).label, "Online");
  assert.equal(context.window.DinodiaRadios.threadConnectionStatus(threadAdapter, threadAdapter.path, { reachable: false, state: "leader", service: { running: true } }).label, "Offline");
  assert.equal(context.window.DinodiaRadios.threadConnectionStatus(threadAdapter, "/dev/other", { reachable: true, state: "leader", service: { running: true } }).label, "Not selected");
});

test("radio tiles expose a selected-dongle removal action", () => {
  assert.match(app, /data-remove-radio/);
  assert.match(app, /method: "DELETE"/);
  assert.match(app, /Remove .* from Dinodia OS/);
  assert.match(app, /Remove dongle/);
  assert.match(app, /Close details/);
  assert.match(app, /this does not remove or change the dongle/);
  assert.match(app, /back in the scan list/);
  assert.doesNotMatch(app, /data-remove-radio="\$\{escapeHtml\(key\)\}"[^>]*disabled/);
});
