const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const markup = fs.readFileSync(path.join(root, "public/permanent-installation.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public/permanent-installation.js"), "utf8");

class Element {
  constructor(id = "") {
    this.id = id; this.children = []; this.listeners = new Map(); this.textContent = "";
    this.hidden = false; this.disabled = false; this.value = ""; this.className = "";
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  add(child) { this.children.push(child); }
}

function harness({ context, devicesStatus = 200, devices = [], holdDeviceList = false, seededStorage = {} } = {}) {
  const elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  const storage = new Map();
  for (const [key, value] of Object.entries(seededStorage)) storage.set(key, String(value));
  const sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  const calls = [];
  let releaseDeviceList;
  const deviceListGate = holdDeviceList ? new Promise((resolve) => { releaseDeviceList = resolve; }) : null;
  const document = {
    cookie: "dinodia_setup_csrf=test-csrf",
    getElementById: (id) => elements.get(id) || null,
    createElement: () => new Element(),
  };
  class Option extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } }
  const fetch = async (url) => {
    calls.push(String(url));
    if (url === "/_dinodia/installer/commissioning") return response(200, context);
    if (url === "/_dinodia/installer/commissioning/devices") {
      if (deviceListGate) await deviceListGate;
      return response(devicesStatus, devicesStatus === 200 ? { devices, completedDevices: [] }
        : { error: { code: "COMMISSIONING_AUTHORITY_DENIED", message: "A current assigned permanent-installation authority is required" } });
    }
    return response(404, { error: "not_found" });
  };
  const timers = new Set();
  const sandbox = {
    document, sessionStorage, fetch, Option, crypto: crypto.webcrypto,
    setInterval: (fn) => { const timer = { fn }; timers.add(timer); return timer; },
    clearInterval: (timer) => timers.delete(timer),
    window: { opener: null, confirm: () => false },
    location: { protocol: "https:", replace() {} },
    URL, Date, Set, Map, Error, console,
  };
  vm.runInNewContext(script, sandbox, { filename: "permanent-installation.js" });
  return { elements, calls, storage, timers, releaseDeviceList, flush: async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); } };
}

function response(status, value) {
  return { status, ok: status >= 200 && status < 300, json: async () => value };
}

const areaId = "11111111-1111-4111-8111-111111111111";
const validContext = (registrationEnabled = true) => ({
  schemaVersion: "dinodia.v1", requestId: "22222222-2222-4222-8222-222222222222",
  areas: [{ id: areaId, name: "Private Test Area" }],
  protocols: {
    registrationEnabled,
    zigbee: { enabled: true, adapterReady: true, readinessMessage: "Zigbee is ready" },
    matter: { enabled: false, adapterReady: false, readinessMessage: "Matter is offline" },
  },
});

test("assigned installation page erases protected scope and disables actions after a dependent authorization denial", async () => {
  const page = harness({ context: validContext(), devicesStatus: 403,
    seededStorage: { "dinodia-installation:22222222-2222-4222-8222-222222222222:session": "33333333-3333-4333-8333-333333333333" } });
  await page.flush();
  assert.ok(page.calls.includes("/_dinodia/installer/commissioning/devices"));
  assert.equal(page.elements.get("area").children.some((option) => option.textContent === "Private Test Area"), false,
    "a previously loaded Area must not remain visible after any protected commissioning endpoint denies authority");
  assert.equal(page.elements.get("summary").textContent.includes("Private Test Area"), false);
  assert.equal(page.elements.get("start-zigbee").disabled, true,
    "radio action must be disabled when the dependent protected list request rejects the handoff");
  assert.equal(page.elements.get("status").textContent, "No protected installation scope is retained in this window.");
  assert.equal(page.storage.size, 0, "cached session pointers for this installation window are cleared on known denial");
  assert.match(page.elements.get("error").textContent, /current assigned permanent-installation authority/i);
  await page.elements.get("start-zigbee").listeners.get("click")();
  assert.equal(page.calls.some((url) => url === "/_dinodia/installer/commissioning/sessions"), false,
    "a denied page must not send a later commissioning mutation");
});

test("assigned installation page keeps radio actions disabled until all required authority checks finish", async () => {
  const page = harness({ context: validContext(), devicesStatus: 200, holdDeviceList: true });
  await page.flush();
  assert.equal(page.elements.get("area").children.some((option) => option.textContent === "Private Test Area"), true);
  assert.equal(page.elements.get("start-zigbee").disabled, true,
    "radio actions remain disabled while the second protected authority check is pending");
  page.releaseDeviceList();
  await page.flush();
  assert.equal(page.elements.get("start-zigbee").disabled, false,
    "radio actions become available only after the required protected checks confirm current authority and readiness");
});

test("assigned installation page renders eligible already-paired devices with an explicit registration action", async () => {
  const device = { candidateRef: "44444444-4444-4444-8444-444444444444", protocol: "zigbee", name: "Living room radiator",
    manufacturer: "SONOFF", model: "TRVZB", originalAreaName: "Living Room", originalAreaId: areaId,
    availableAreas: [{ id: areaId, name: "Private Test Area" }] };
  const page = harness({ context: validContext(), devices: [device] });
  await page.flush();
  const list = page.elements.get("existing-device-list");
  assert.equal(list.children.length, 1);
  const rendered = list.children[0];
  assert.equal(rendered.children[0].textContent, "Living room radiator");
  assert.match(rendered.children[1].textContent, /ZIGBEE.*SONOFF.*TRVZB.*Living Room/);
  assert.match(rendered.children[2].textContent, /Not registered to this property yet/);
  assert.equal(rendered.children[3].textContent, "Review and register");
  assert.equal(rendered.children[3].disabled, false);
  assert.equal(list.children.some((child) => JSON.stringify(child).includes(device.candidateRef)), false,
    "the opaque review reference is used only by the registration action and is not rendered into page text");
});
