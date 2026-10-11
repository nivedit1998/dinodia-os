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
    this.hidden = false; this.disabled = false; this.value = ""; this.className = ""; this.dataset = {};
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  add(child) { this.children.push(child); }
}

function harness({ context, devicesStatus = 200, devices = [], session = null, holdDeviceList = false, seededStorage = {} } = {}) {
  let currentDevicesStatus = devicesStatus;
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
  const documentListeners = new Map();
  const document = {
    cookie: "dinodia_setup_csrf=test-csrf",
    getElementById: (id) => elements.get(id) || null,
    createElement: () => new Element(),
    querySelectorAll: (selector) => {
      if (selector !== "[data-review-candidate]") return [];
      const matches = [];
      const visit = (element) => {
        if (element?.dataset?.reviewCandidate === "true") matches.push(element);
        for (const child of element?.children || []) visit(child);
      };
      for (const element of elements.values()) visit(element);
      return matches;
    },
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    visibilityState: "visible",
  };
  class Option extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } }
  const fetch = async (url) => {
    calls.push(String(url));
    if (url === "/_dinodia/installer/commissioning") return response(200, context);
    if (url === "/_dinodia/installer/commissioning/devices") {
      if (deviceListGate) await deviceListGate;
      return response(currentDevicesStatus, currentDevicesStatus === 200 ? { devices, completedDevices: [] }
        : { error: { code: currentDevicesStatus === 503 ? "AUTHORITY_UNAVAILABLE" : "COMMISSIONING_AUTHORITY_DENIED", message: currentDevicesStatus === 503 ? "Authority is temporarily unavailable" : "A current assigned permanent-installation authority is required" } });
    }
    if (session && String(url).startsWith(`/_dinodia/installer/commissioning/sessions/${session.sessionId}`)) return response(200, session);
    return response(404, { error: "not_found" });
  };
  const timers = new Set();
  let monotonicNow = 100;
  const performance = { now: () => monotonicNow };
  const sandbox = {
    document, sessionStorage, fetch, Option, crypto: crypto.webcrypto,
    performance,
    setInterval: (fn, delay) => { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearInterval: (timer) => timers.delete(timer),
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    window: { opener: null, confirm: () => false, performance },
    location: { protocol: "https:", pathname: "/_dinodia/operator/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/installation", replace() {} },
    URL, Date, Set, Map, Error, console,
  };
  vm.runInNewContext(script, sandbox, { filename: "permanent-installation.js" });
  return { elements, calls, storage, timers, documentListeners, setMonotonicNow: (value) => { monotonicNow = value; }, setDevicesStatus: (value) => { currentDevicesStatus = value; }, releaseDeviceList, flush: async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); } };
}

function response(status, value) {
  return { status, ok: status >= 200 && status < 300, json: async () => value };
}

const areaId = "11111111-1111-4111-8111-111111111111";
const validContext = (registrationEnabled = true) => ({
  schemaVersion: "dinodia.v1", requestId: "22222222-2222-4222-8222-222222222222",
  sessionExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), serverNow: new Date().toISOString(), authorityVerifiedAt: new Date().toISOString(),
  areas: [{ id: areaId, name: "Private Test Area" }],
  protocols: {
    registrationEnabled,
    zigbee: { enabled: true, adapterReady: true, readinessMessage: "Zigbee is ready" },
    matter: { enabled: false, adapterReady: false, readinessMessage: "Matter is offline" },
  },
});

test("temporary verifier outage keeps the same assigned window, shows the last verification time, and disables mutations", async () => {
  const page = harness({ context: validContext(), devicesStatus: 503,
    seededStorage: { "dinodia.operatorSessionSelector": "A".repeat(32), "dinodia-installation:22222222-2222-4222-8222-222222222222:session": "33333333-3333-4333-8333-333333333333" } });
  await page.flush();
  assert.equal(page.storage.get("dinodia.operatorSessionSelector"), "A".repeat(32));
  assert.equal(page.elements.get("area").children.some((option) => option.textContent === "Private Test Area"), true,
    "a transient failure does not misrepresent an unexpired, correctly scoped snapshot as revoked");
  assert.match(page.elements.get("summary").textContent, /temporarily unavailable.*not been declared expired/i);
  assert.match(page.elements.get("summary").textContent, /Last verified/i);
  assert.equal(page.elements.get("start-zigbee").disabled, true);
  await page.elements.get("start-zigbee").listeners.get("click")();
  assert.equal(page.calls.some((url) => url === "/_dinodia/installer/commissioning/sessions"), false);
});

test("temporary assigned-authority outage retries the same window at a bounded interval without launching another handoff", async () => {
  const page = harness({ context: validContext(), devicesStatus: 503,
    seededStorage: { "dinodia.operatorSessionSelector": "B".repeat(32) } });
  await page.flush();
  assert.equal(page.storage.get("dinodia.operatorSessionSelector"), "B".repeat(32));
  const retry = [...page.timers].find((timer) => timer.delay === 15000);
  assert.ok(retry, "a transient verifier outage schedules a bounded retry rather than a rapid poll or immediate relaunch");
  const priorDeviceReads = page.calls.filter((url) => url === "/_dinodia/installer/commissioning/devices").length;
  page.setDevicesStatus(200);
  page.timers.delete(retry);
  retry.fn();
  await page.flush();
  assert.equal(page.calls.filter((url) => url === "/_dinodia/installer/commissioning/devices").length, priorDeviceReads + 1);
  assert.equal(page.storage.get("dinodia.operatorSessionSelector"), "B".repeat(32));
  assert.equal(page.calls.some((url) => url === "/_dinodia/setup/operator-session"), false);
  assert.equal(page.elements.get("start-zigbee").disabled, false, "actions become available only after the same scope revalidates successfully");
});

test("assigned workspace uses the server-anchored 30-minute deadline and refreshes once on return to the foreground", async () => {
  const page = harness({ context: validContext(), devicesStatus: 200 });
  await page.flush();
  assert.match(page.elements.get("operator-session-status").textContent, /30m 00s remaining/);
  const contextReads = page.calls.filter((url) => url === "/_dinodia/installer/commissioning").length;
  page.documentListeners.get("visibilitychange")();
  await page.flush();
  assert.equal(page.calls.filter((url) => url === "/_dinodia/installer/commissioning").length, contextReads + 1);
  page.setMonotonicNow(1_800_101);
  [...page.timers].find((timer) => timer.delay === 1000)?.fn();
  assert.match(page.elements.get("operator-session-status").textContent, /reached its absolute deadline/i);
  assert.equal(page.elements.get("start-zigbee").disabled, true);
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

test("discovery candidate review stays enabled after the initial busy refresh completes", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const session = { sessionId, protocol: "zigbee", operationKind: "PAIR_NEW", status: "searching", revision: 1,
    updatedAt: new Date().toISOString(), candidates: [{ candidateRef: "66666666-6666-4666-8666-666666666666",
      name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB", stage: "interviewing" }] };
  const requestId = "22222222-2222-4222-8222-222222222222";
  const page = harness({ context: validContext(), session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  } });
  await page.flush();

  const review = page.elements.get("candidate-list").children[0].children[2];
  assert.equal(review.textContent, "Review candidate");
  assert.equal(review.disabled, false, "the candidate action must be re-enabled after protected loading finishes");
  review.listeners.get("click")();
  assert.equal(page.elements.get("device-result").hidden, false, "review opens the real device/Area/name form");
  assert.equal(page.elements.get("name").value, "SONOFF TRVZB");
});
