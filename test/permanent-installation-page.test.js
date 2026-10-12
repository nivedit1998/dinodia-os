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

function harness({ context, devicesStatus = 200, devices = [], session = null, holdDeviceList = false, seededStorage = {}, secureContext = true, requestHandler = null } = {}) {
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
  const requests = [];
  let releaseDeviceList;
  const deviceListGate = holdDeviceList ? new Promise((resolve) => { releaseDeviceList = resolve; }) : null;
  const documentListeners = new Map();
  const document = {
    cookie: "dinodia_setup_csrf=test-csrf",
    getElementById: (id) => elements.get(id) || null,
    createElement: () => new Element(),
    querySelectorAll: (selector) => {
      if (!["[data-review-candidate]", "[data-review-existing]"].includes(selector)) return [];
      const matches = [];
      const visit = (element) => {
        if (selector === "[data-review-candidate]" && element?.dataset?.reviewCandidate === "true") matches.push(element);
        if (selector === "[data-review-existing]" && element?.dataset?.reviewExisting === "true") matches.push(element);
        for (const child of element?.children || []) visit(child);
      };
      for (const element of elements.values()) visit(element);
      return matches;
    },
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    visibilityState: "visible",
  };
  class Option extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } }
  const fetch = async (url, options = {}) => {
    calls.push(String(url));
    requests.push({ url: String(url), options });
    const overridden = await requestHandler?.(String(url), options);
    if (overridden) return overridden;
    if (url === "/_dinodia/installer/commissioning") return response(200, context);
    if (url === "/_dinodia/installer/commissioning/devices") {
      if (deviceListGate) await deviceListGate;
      return response(currentDevicesStatus, currentDevicesStatus === 200 ? { devices, completedDevices: [] }
        : { error: { code: currentDevicesStatus === 503 ? "AUTHORITY_UNAVAILABLE" : "COMMISSIONING_AUTHORITY_DENIED", message: currentDevicesStatus === 503 ? "Authority is temporarily unavailable" : "A current assigned permanent-installation authority is required" } });
    }
    if (url === "/_dinodia/installer/commissioning/sessions" && options.method === "POST") {
      const body = JSON.parse(options.body);
      const existing = body.operationKind === "REGISTER_EXISTING";
      return response(201, { sessionId: "77777777-7777-4777-8777-777777777777", protocol: body.protocol,
        operationKind: body.operationKind, status: existing ? "reviewing_existing" : "searching", revision: 1, updatedAt: new Date().toISOString(),
        candidates: existing ? [{ candidateRef: body.candidateRef, name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB", stage: "existing_interview_verified" }] : [] });
    }
    if (session && String(url).startsWith(`/_dinodia/installer/commissioning/sessions/${session.sessionId}`)) return response(200, session);
    return response(404, { error: "not_found" });
  };
  const timers = new Set();
  let monotonicNow = 100;
  const performance = { now: () => monotonicNow };
  const browserCrypto = secureContext ? crypto.webcrypto : { getRandomValues: (bytes) => crypto.webcrypto.getRandomValues(bytes) };
  const sandbox = {
    document, sessionStorage, fetch, Option, crypto: browserCrypto,
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
  return { elements, calls, requests, storage, timers, documentListeners, setMonotonicNow: (value) => { monotonicNow = value; }, setDevicesStatus: (value) => { currentDevicesStatus = value; }, releaseDeviceList, flush: async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); } };
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

test("assigned Zigbee start creates a secure idempotency key on private HTTP without crypto.randomUUID", async () => {
  const page = harness({ context: validContext(), secureContext: false });
  await page.flush();

  await page.elements.get("start-zigbee").listeners.get("click")();

  const request = page.requests.find((entry) => entry.url === "/_dinodia/installer/commissioning/sessions" && entry.options.method === "POST");
  assert.ok(request, "a ready assigned local page should send exactly the requested start operation");
  assert.equal(JSON.parse(request.options.body).operationKind, "PAIR_NEW");
  assert.equal(JSON.parse(request.options.body).protocol, "zigbee");
  assert.match(request.options.headers["idempotency-key"], /^install-start-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(page.elements.get("status").textContent, /ZIGBEE · searching/);
  assert.doesNotMatch(page.elements.get("error").textContent, /randomUUID/i);
});

test("permanent-device review offers an optional analytics category and sends the selected value to the canonical owner", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const candidateRef = "66666666-6666-4666-8666-666666666666";
  const session = { sessionId, protocol: "zigbee", operationKind: "REGISTER_EXISTING", status: "reviewing_existing", revision: 2,
    updatedAt: new Date().toISOString(), candidates: [{ candidateRef, name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB",
      stage: "existing_interview_verified", interviewStatus: "successful" }] };
  const requestId = "22222222-2222-4222-8222-222222222222";
  const page = harness({ context: validContext(), session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  }, requestHandler: async (url, options) => {
    if (options.method === "POST" && url.endsWith("/select")) return response(200, { ...session, status: "selected", revision: 3, catalogueStatus: "ready",
      selectedCandidateRef: candidateRef, selectedAnalyticsCategory: JSON.parse(options.body).analyticsCategory,
      selectedControls: [{ name: "Heat demand", semanticRole: "active_heat_demand", readable: true, writable: false }] });
    return null;
  } });
  await page.flush();

  assert.match(markup, /id="analytics-category"/);
  assert.match(markup, /value="NONE"[^>]*>None/);
  page.elements.get("candidate-list").children[0].children[2].listeners.get("click")();
  page.elements.get("area").value = areaId;
  page.elements.get("label").value = "Radiator";
  page.elements.get("name").value = "Room 1 Radiator";
  page.elements.get("analytics-category").value = "RADIATOR";
  await page.elements.get("select").listeners.get("click")();

  const reviewRequest = page.requests.find((entry) => entry.url.endsWith("/select") && entry.options.method === "POST");
  assert.ok(reviewRequest, "the chosen category is sent as part of the existing reviewed registration operation");
  assert.equal(JSON.parse(reviewRequest.options.body).analyticsCategory, "RADIATOR");
  assert.equal(page.elements.get("install").hidden, false, "the category choice does not bypass the existing device review step");
  assert.match(page.elements.get("selected-controls").textContent, /Heat demand/);
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

test("existing-device review action is disabled immediately while its one registration session is being created", async () => {
  const device = { candidateRef: "44444444-4444-4444-8444-444444444444", protocol: "zigbee", name: "SONOFF TRVZB",
    manufacturer: "SONOFF", model: "TRVZB", originalAreaName: "Not assigned", originalAreaId: null, availableAreas: [{ id: areaId, name: "Room 1" }] };
  const page = harness({ context: validContext(), devices: [device] });
  await page.flush();

  const review = page.elements.get("existing-device-list").children[0].children[3];
  const pending = review.listeners.get("click")();
  assert.equal(review.disabled, true, "a second click must not create a duplicate REGISTER_EXISTING request while the first is pending");
  assert.equal(page.requests.filter((request) => request.url === "/_dinodia/installer/commissioning/sessions" && request.options.method === "POST").length, 1);
  await pending;
  assert.equal(page.elements.get("status").textContent.includes("reviewing existing"), true);
});

test("normal background status polls keep the reviewed Area and action controls usable", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const session = { sessionId, protocol: "zigbee", operationKind: "REGISTER_EXISTING", status: "reviewing_existing", revision: 2,
    updatedAt: new Date().toISOString(), candidates: [{ candidateRef: "66666666-6666-4666-8666-666666666666",
      name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB", stage: "existing_interview_verified" }] };
  const requestId = "22222222-2222-4222-8222-222222222222";
  const page = harness({ context: validContext(), session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  } });
  await page.flush();
  page.elements.get("area").value = areaId;
  page.elements.get("label").value = "Radiator";
  page.elements.get("name").value = "Room 1 Radiator";

  const poll = [...page.timers].find((timer) => timer.delay === 3000);
  assert.ok(poll, "an active session has a bounded background status poll");
  poll.fn();

  assert.equal(page.elements.get("area").disabled, false, "a background refresh must not revoke the last verified form while it rechecks the same handoff");
  assert.equal(page.elements.get("label").disabled, false);
  assert.equal(page.elements.get("name").disabled, false);
  assert.equal(page.elements.get("install").disabled, false);
  await page.flush();
  assert.equal(page.elements.get("area").value, areaId);
  assert.equal(page.elements.get("label").value, "Radiator");
  assert.equal(page.elements.get("name").value, "Room 1 Radiator");
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

test("candidate review remains open across session refreshes without losing the operator's draft", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const session = { sessionId, protocol: "zigbee", operationKind: "PAIR_NEW", status: "searching", revision: 2,
    updatedAt: new Date().toISOString(), candidates: [{ candidateRef: "66666666-6666-4666-8666-666666666666",
      name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB", stage: "needs_setup", interviewStatus: "successful" }] };
  const requestId = "22222222-2222-4222-8222-222222222222";
  const page = harness({ context: validContext(), session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  } });
  await page.flush();

  const candidate = page.elements.get("candidate-list").children[0];
  assert.equal(candidate.children[0].textContent, "SONOFF TRVZB");
  assert.match(candidate.children[1].textContent, /SONOFF.*TRVZB.*Interview complete/);
  candidate.children[2].listeners.get("click")();
  page.elements.get("area").value = areaId;
  page.elements.get("label").value = "Radiator";
  page.elements.get("name").value = "Room 1 Radiator";
  assert.equal(page.elements.get("device-result").hidden, false);

  page.documentListeners.get("visibilitychange")();
  await page.flush();
  assert.equal(page.elements.get("device-result").hidden, false,
    "an ordinary protected status poll must not hide the selected review form");
  assert.equal(page.elements.get("area").value, areaId);
  assert.equal(page.elements.get("label").value, "Radiator");
  assert.equal(page.elements.get("name").value, "Room 1 Radiator");
});

test("descriptor conflict returns the device to explicit re-review instead of trapping Install in a 409 loop", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const candidateRef = "66666666-6666-4666-8666-666666666666";
  const session = { sessionId, protocol: "zigbee", operationKind: "PAIR_NEW", status: "selected", revision: 7,
    updatedAt: new Date().toISOString(), candidates: [{ candidateRef, name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB", stage: "needs_setup", interviewStatus: "successful" }],
    selectedCandidateRef: candidateRef, selectedAreaId: areaId, selectedName: "Room 1 Radiator", selectedCustomerLabel: "Radiator",
    catalogueStatus: "ready", selectedControls: [{ name: "Target temperature", semanticRole: "target_temperature", kind: "number", readable: true, writable: true }] };
  const requestId = "22222222-2222-4222-8222-222222222222";
  let completeCalls = 0; let selectCalls = 0;
  const page = harness({ context: validContext(), session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  }, requestHandler: async (url, options) => {
    if (options.method !== "POST") return null;
    if (url.endsWith("/complete")) {
      completeCalls += 1;
      if (completeCalls === 1) return response(409, { error: { code: "COMMISSIONING_REVISION_CONFLICT", reason: "device_descriptor_changed_after_review", message: "The device descriptor changed after review; refresh and review it again" } });
      return response(200, { ...session, status: "completed", revision: 9, finalDisposition: "install", localSyncState: "pending" });
    }
    if (url.endsWith("/select")) {
      selectCalls += 1;
      return response(200, { ...session, status: "selected", revision: 8,
        selectedControls: [{ name: "Target temperature", semanticRole: "target_temperature", kind: "number", readable: true, writable: true },
          { name: "Operating mode", semanticRole: "operating_mode", kind: "option", readable: true, writable: true }] });
    }
    return null;
  } });
  await page.flush();
  page.elements.get("area").value = areaId;
  page.elements.get("label").value = "Radiator";
  page.elements.get("name").value = "Room 1 Radiator";

  await page.elements.get("install").listeners.get("click")();

  assert.equal(completeCalls, 1, "a descriptor conflict must never auto-submit registration again");
  assert.equal(page.elements.get("install").hidden, true, "stale reviewed controls cannot be installed");
  assert.equal(page.elements.get("select").hidden, false, "the user is given a direct re-review action");
  assert.equal(page.elements.get("select").textContent, "Review updated device");
  assert.match(page.elements.get("error").textContent, /changed after review/i);

  await page.elements.get("select").listeners.get("click")();
  assert.equal(selectCalls, 1);
  assert.match(page.elements.get("selected-controls").textContent, /Operating mode/);
  assert.equal(page.elements.get("install").hidden, false, "Install returns only after a fresh explicit review");
  await page.elements.get("install").listeners.get("click")();
  assert.equal(completeCalls, 2);
  assert.match(page.elements.get("status").textContent, /Home sync is still pending acknowledgement/);
});

test("stale discovery revision is refreshed and retried once for the same reviewed Zigbee candidate", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const candidateRef = "66666666-6666-4666-8666-666666666666";
  const session = { sessionId, protocol: "zigbee", operationKind: "PAIR_NEW", status: "searching", revision: 4,
    updatedAt: new Date().toISOString(), candidates: [{ candidateRef, name: "SONOFF TRVZB", manufacturer: "SONOFF", model: "TRVZB", stage: "needs_setup", interviewStatus: "successful" }] };
  const requestId = "22222222-2222-4222-8222-222222222222";
  let selectCalls = 0;
  const page = harness({ context: validContext(), session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  }, requestHandler: async (url, options) => {
    if (options.method !== "POST" && url.endsWith(`/${sessionId}`) && selectCalls === 1) return response(200, { ...session, revision: 5 });
    if (options.method !== "POST" || !url.endsWith("/select")) return null;
    selectCalls += 1;
    if (selectCalls === 1) return response(409, { error: { code: "COMMISSIONING_REVISION_CONFLICT", reason: "candidate_list_revision_changed", message: "The discovered device list changed; refresh and select again" } });
    const body = JSON.parse(options.body);
    assert.equal(body.expectedRevision, 5, "the one retry must use the refreshed revision");
    assert.equal(body.candidateRef, candidateRef, "retry must target the same candidate, never a different device");
    return response(200, { ...session, status: "selected", revision: 6, selectedCandidateRef: candidateRef, selectedAreaId: areaId,
      selectedName: body.name, selectedCustomerLabel: body.customerLabel, catalogueStatus: "ready",
      selectedControls: [{ name: "Target temperature", semanticRole: "target_temperature", kind: "number", readable: true, writable: true }] });
  } });
  await page.flush();
  page.elements.get("candidate-list").children[0].children[2].listeners.get("click")();
  page.elements.get("area").value = areaId;
  page.elements.get("label").value = "Radiator";
  page.elements.get("name").value = "Room 1 Radiator";

  await page.elements.get("select").listeners.get("click")();

  assert.equal(selectCalls, 2, "only one bounded retry is permitted");
  assert.equal(page.elements.get("error").hidden, true);
  assert.equal(page.elements.get("install").hidden, false);
  assert.equal(page.elements.get("status").textContent.includes("selected"), true);
});

test("cancelled Matter session hides the setup-code controls in the rendered production page", async () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const requestId = "22222222-2222-4222-8222-222222222222";
  const context = validContext();
  context.protocols.matter = { enabled: true, adapterReady: true, readinessMessage: "Matter is connected" };
  const session = { sessionId, protocol: "matter", operationKind: "PAIR_NEW", status: "cancelled", revision: 2,
    updatedAt: new Date().toISOString(), candidates: [] };
  const page = harness({ context, session, seededStorage: {
    [`dinodia-installation:${requestId}:session`]: sessionId,
  } });
  await page.flush();

  assert.equal(page.elements.get("matter-entry").hidden, true);
  assert.equal(page.elements.get("matter-entry-row").hidden, true);
  assert.match(markup, /\.row\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/,
    "the component's flex display rule must not override the browser hidden attribute");
});
