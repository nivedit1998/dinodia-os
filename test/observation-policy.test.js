const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { MqttBridge } = require("../src/mqttBridge");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { serializeDevice } = require("../src/contracts/dinodiaV1");
const { buildPresentation, getSurfaces } = require("../src/capabilities/devicePresentation");

function publicDescriptor(device) {
  const presented = { ...device, presentation: device.presentation || buildPresentation(device) };
  return serializeDevice({ device: presented, homeId: "home-fixture", homeMembershipId: "membership-fixture", role: "OWNER",
    areaIds: [presented.areaId], surfaces: getSurfaces(presented), revision: presented.presentation.descriptorRevision });
}
const { cachedReportingFor, matchObservationProfile, PROFILES } = require("../src/observation/profiles");
const { ObservationReconciler, STATES } = require("../src/observation/reconciler");

// Plan: Code Planning/DINODIA_HUB_OBSERVATION_POLICY_PLAN_20261023.md (revision 3).

const trvzbRaw = () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
  // Live TRVZB configuration on 22 Oct 2026 before the heating-state profile: the converter sets
  // localTemp, setpoint and systemMode reporting on endpoint 1, nothing for runningState.
  raw.endpoints = { 1: { bindings: [], clusters: { input: ["hvacThermostat"], output: [] }, configured_reportings: [
    { cluster: "hvacThermostat", attribute: "localTemp", minimum_report_interval: 0, maximum_report_interval: 3600, reportable_change: 10 },
    { cluster: "hvacThermostat", attribute: "occupiedHeatingSetpoint", minimum_report_interval: 0, maximum_report_interval: 3600, reportable_change: 10 },
    { cluster: "hvacThermostat", attribute: "systemMode", minimum_report_interval: 10, maximum_report_interval: 3600 },
  ] } };
  raw.software_build_id = "1.4.1";
  raw.date_code = "20251028";
  raw.type = "EndDevice";
  raw.power_source = "Battery";
  return raw;
};
const withRunningState = (raw, max = 600) => {
  const copy = JSON.parse(JSON.stringify(raw));
  copy.endpoints[1].configured_reportings.push({ cluster: "hvacThermostat", attribute: "runningState", minimum_report_interval: 0, maximum_report_interval: max, reportable_change: 0 });
  return copy;
};

async function harness({ raw = trvzbRaw() } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-observation-policy-"));
  const store = new Store(path.join(directory, "store.json"));
  const device = normalizeZigbeeDevice(raw);
  await store.upsertDevice({ ...device, metadata: { ...device.metadata, power_source: "Battery" } });
  const clock = { now: Date.parse("2026-10-23T10:00:00.000Z") };
  const sent = [];
  const make = (targetStore = store) => new ObservationReconciler({
    store: targetStore,
    publishBridgeRequest: async (requestPath, payload) => { sent.push({ path: requestPath, payload }); },
    resolveDeviceId: (value) => {
      const all = Object.values(targetStore.state.devices || {});
      return all.find((item) => item.metadata?.ieee_address === value || item.metadata?.friendly_name === value || item.id === value)?.id || null;
    },
    clock: () => clock.now,
  });
  return { directory, store, device, clock, sent, make, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

const reply = (sent, status, extra = {}) => ({ status: "ok", transaction: sent.at(-1).payload.transaction,
  data: { cluster: "hvacThermostat", endpoint: 1, configs: [{ attrId: 41, status, ...extra }] } });

test("profiles match the exact integration, model, endpoint, property and role", () => {
  const device = normalizeZigbeeDevice(trvzbRaw());
  const running = Object.values(device.entities).find((entity) => entity.stateKey === "running_state");
  const temperature = Object.values(device.entities).find((entity) => entity.stateKey === "local_temperature");
  assert.equal(matchObservationProfile(device, running)?.id, "zigbee.sonoff.trvzb.running_state");
  assert.equal(matchObservationProfile(device, temperature), null, "no profile for room temperature yet");
  assert.equal(matchObservationProfile(device, { ...running, endpointId: "2" }), null, "a different endpoint never matches");
  assert.equal(matchObservationProfile({ ...device, metadata: { ...device.metadata, model: "TRVZB-2" } }, running), null, "a different model never matches");
  assert.equal(matchObservationProfile({ ...device, protocol: "matter" }, running), null);
  const light = normalizeZigbeeDevice(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/dimmable-light.json"), "utf8")));
  for (const entity of Object.values(light.entities)) {
    assert.equal(matchObservationProfile(light, entity), null, "generic light profiles need an explicit model approval");
  }
  const approved = matchObservationProfile(light, Object.values(light.entities).find((entity) => entity.capability?.semanticRole === "power"),
    { approvedModels: [{ profileId: "zigbee.generic.mains_light.on_off", manufacturer: light.metadata.manufacturer, model: light.metadata.model }] });
  assert.equal(approved?.id, "zigbee.generic.mains_light.on_off");
});

test("a multi-endpoint device never borrows another endpoint's reporting guarantee", () => {
  const profile = PROFILES.find((item) => item.id === "zigbee.generic.mains_light.on_off");
  const raw = { endpoints: {
    11: { configured_reportings: [{ cluster: "genOnOff", attribute: "onOff", minimum_report_interval: 0, maximum_report_interval: 300 }] },
    12: { configured_reportings: [{ cluster: "genOnOff", attribute: "onOff", minimum_report_interval: 0, maximum_report_interval: 3600 }] },
    13: { configured_reportings: [] },
  } };
  assert.equal(cachedReportingFor(raw, profile, "11").maximumReportInterval, 300);
  assert.equal(cachedReportingFor(raw, profile, "12").maximumReportInterval, 3600, "its own interval, not the shortest on the device");
  assert.equal(cachedReportingFor(raw, profile, "13"), null);
});

test("the descriptor carries the profile lifetime for the profiled control only", () => {
  const device = normalizeZigbeeDevice(trvzbRaw());
  device.areaId = "room"; device.setup = { status: "ready", assignmentMode: "device_inherited_v1" };
  device.metadata = { ...device.metadata, power_source: "Battery" };
  const controls = publicDescriptor(device).controls.filter((control) => control.observable);
  const running = controls.find((control) => control.semanticRole === "active_heat_demand");
  assert.equal(running.maxStateValiditySeconds, 660, "600 s reports + 60 s delivery grace, no missed report");
  assert.equal(running.expectedReportingIntervalSeconds, 600);
  for (const control of controls.filter((item) => item.semanticRole !== "active_heat_demand")) {
    assert.equal(control.maxStateValiditySeconds, 1800, "unprofiled battery values keep the existing lifetime");
  }
});

test("pairing: read back first, configure only when absent, read back again, then verify cadence", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([trvzbRaw()]);
    assert.equal(reconciler.status()[0].state, STATES.UNKNOWN);
    await reconciler.tick();
    assert.equal(h.sent.at(-1).path, "device/reporting/read");
    assert.deepEqual(h.sent.at(-1).payload.configs, [{ attribute: "runningState" }]);
    await reconciler.onBridgeResponse("read", reply(h.sent, 0x8b));
    assert.equal(reconciler.status()[0].state, STATES.DRIFTED);
    await reconciler.tick();
    assert.equal(h.sent.length, 1, "Hub-wide spacing: no second request within 30 s");
    h.clock.now += 30_000;
    await reconciler.tick();
    assert.equal(h.sent.at(-1).path, "device/reporting/configure");
    assert.equal(h.sent.at(-1).payload.maximum_report_interval, 600);
    assert.equal(h.sent.at(-1).payload.attribute, "runningState");
    await reconciler.onBridgeResponse("configure", { status: "ok", transaction: h.sent.at(-1).payload.transaction, data: {} });
    assert.equal(reconciler.status()[0].state, STATES.UNKNOWN, "an accepted configure is not proof: read back next");
    h.clock.now += 30_000;
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    assert.equal(reconciler.status()[0].state, STATES.CADENCE_PENDING, "read back matches; cadence still to be shown");
    for (let index = 0; index < 4; index += 1) {
      await reconciler.onValueObserved(h.device.id, "running_state", "1", new Date(h.clock.now + index * 600_000).toISOString());
    }
    assert.equal(reconciler.status()[0].state, STATES.CADENCE_VERIFIED);
    assert.ok(h.sent.every((item) => ["device/reporting/read", "device/reporting/configure"].includes(item.path)), "never an actuator command");
  } finally { h.cleanup(); }
});

test("an already configured device is verified without any configure command", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([withRunningState(trvzbRaw())]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    assert.deepEqual(h.sent.map((item) => item.path), ["device/reporting/read"]);
    assert.equal(reconciler.status()[0].state, STATES.CADENCE_PENDING);
  } finally { h.cleanup(); }
});

test("restart and reconnect compare only: no command while the evidence is unchanged", async () => {
  const h = await harness();
  try {
    const first = h.make();
    await first.onInventory([withRunningState(trvzbRaw())]);
    await first.tick();
    await first.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    const sentBefore = h.sent.length;
    const restartedStore = new Store(path.join(h.directory, "store.json"));
    const second = h.make(restartedStore);
    assert.equal(second.status()[0].state, STATES.CADENCE_PENDING, "policy state survives a Hub restart");
    await second.onInventory([withRunningState(trvzbRaw())]); // Zigbee2MQTT restart / MQTT reconnect
    await second.onInventory([withRunningState(trvzbRaw())]);
    h.clock.now += 120_000;
    await second.onValueObserved(h.device.id, "running_state", "1", new Date(h.clock.now).toISOString());
    await second.tick();
    assert.equal(h.sent.length, sentBefore, "zero reporting requests on restart/reconnect");
  } finally { h.cleanup(); }
});

test("factory reset or changed cache triggers a read-back, never a blind configure", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([withRunningState(trvzbRaw())]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    await reconciler.onInventory([trvzbRaw()]); // cache lost the entry
    h.clock.now += 30_000;
    await reconciler.tick();
    assert.equal(h.sent.at(-1).path, "device/reporting/read");
  } finally { h.cleanup(); }
});

test("a reset the cache missed is detected by silence while reachable", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([withRunningState(trvzbRaw())]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    await reconciler.onValueObserved(h.device.id, "running_state", "1", new Date(h.clock.now).toISOString());
    h.clock.now += 3 * 600_000 + 1;
    await reconciler.tick();
    assert.equal(reconciler.status()[0].lastError, "value_silent");
    h.clock.now += 30_000;
    await reconciler.tick();
    assert.equal(h.sent.at(-1).path, "device/reporting/read");
    // An unreachable device is not "silent": no requests at all.
    reconciler.onAvailability(h.device.id, false);
    const count = h.sent.length;
    h.clock.now += 3_600_000;
    await reconciler.tick();
    assert.equal(h.sent.length, count, "no requests while the device is unavailable");
  } finally { h.cleanup(); }
});

test("firmware change re-verifies; replacement gets its own record and the old one is cancelled", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([withRunningState(trvzbRaw())]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    const updated = withRunningState(trvzbRaw()); updated.software_build_id = "1.5.0";
    await reconciler.onInventory([updated]);
    assert.equal(reconciler.status()[0].state, STATES.UNKNOWN, "firmware change invalidates verification");
    await reconciler.onInventory([]); // device removed from Zigbee2MQTT
    assert.equal(reconciler.status().length, 0, "removal cancels its policy work");
    assert.deepEqual(h.store.getObservationPolicyRecords(), {});
  } finally { h.cleanup(); }
});

test("unanswered requests become pending delivery, wait out the check-in window, accept a late reply, and give up after three configure attempts", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([trvzbRaw()]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0x8b));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      h.clock.now += 30_000;
      await reconciler.tick();
      if (attempt === 1) assert.equal(h.sent.at(-1).path, "device/reporting/configure");
      h.clock.now += 120_001;
      await reconciler.tick();
      const record = reconciler.status()[0];
      if (attempt < 3) {
        assert.equal(record.state, STATES.PENDING_DELIVERY);
        const count = h.sent.length;
        h.clock.now += 3_600_000;
        await reconciler.tick();
        assert.equal(h.sent.length, count, "no resend inside the check-in window");
        h.clock.now = record.nextAttemptAt;
      } else {
        assert.equal(record.state, STATES.FAILED, "three unanswered configure attempts in a day: failed (diagnostic)");
      }
    }
    const late = { status: "ok", transaction: h.sent.at(-1).payload.transaction, data: {} };
    await reconciler.onBridgeResponse("configure", late);
    assert.equal(reconciler.status()[0].state, STATES.UNKNOWN, "a late reply is still accepted and leads to a read-back");
  } finally { h.cleanup(); }
});

test("unsupported attributes are recorded once and never retried", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([trvzbRaw()]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0x86));
    assert.equal(reconciler.status()[0].state, STATES.UNSUPPORTED);
    const count = h.sent.length;
    h.clock.now += 7 * 24 * 3_600_000;
    await reconciler.tick();
    assert.equal(h.sent.length, count);
  } finally { h.cleanup(); }
});

test("routine reports do not write the Store; a missed report fails cadence without lengthening anything", async () => {
  const h = await harness();
  try {
    const reconciler = h.make();
    await reconciler.onInventory([withRunningState(trvzbRaw())]);
    await reconciler.tick();
    await reconciler.onBridgeResponse("read", reply(h.sent, 0, { minRepIntval: 0, maxRepIntval: 600, repChange: 0 }));
    for (let index = 0; index < 4; index += 1) await reconciler.onValueObserved(h.device.id, "running_state", "1", new Date(h.clock.now + index * 600_000).toISOString());
    let writes = 0;
    const original = h.store.putObservationPolicyRecord.bind(h.store);
    h.store.putObservationPolicyRecord = async (...args) => { writes += 1; return original(...args); };
    for (let index = 4; index < 10; index += 1) await reconciler.onValueObserved(h.device.id, "running_state", "1", new Date(h.clock.now + index * 600_000).toISOString());
    assert.equal(writes, 0, "on-time reports are kept in memory only");
    await reconciler.onValueObserved(h.device.id, "running_state", "1", new Date(h.clock.now + 9 * 600_000 + 1_300_000).toISOString());
    assert.equal(reconciler.status()[0].state, STATES.CADENCE_FAILED);
    assert.equal(writes, 1);
    const device = { ...h.store.getDevice(h.device.id), areaId: "room", setup: { status: "ready", assignmentMode: "device_inherited_v1" }, presentation: undefined };
    assert.equal(publicDescriptor(device).controls.find((control) => control.semanticRole === "active_heat_demand").maxStateValiditySeconds, 660,
      "verification failure never changes (or lengthens) the value's lifetime");
  } finally { h.cleanup(); }
});

test("bridge requests are limited to reporting read/configure", async () => {
  const bridge = new MqttBridge({ url: "", store: { getDevice() { return null; } }, logger: { log() {}, error() {} } });
  bridge.client = { publish(topic, payload, options, callback) { callback(); } };
  bridge.connected = true;
  await bridge.bridgeRequest("device/reporting/read", {});
  await assert.rejects(() => bridge.bridgeRequest("device/options", {}), { code: "bridge_request_not_permitted" });
  await assert.rejects(() => bridge.bridgeRequest("device/configure", {}), { code: "bridge_request_not_permitted" });
});

test("provenance: same-value genuine reports refresh; replays, retained and other attributes never do", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-observation-provenance-"));
  try {
    const store = new Store(path.join(directory, "store.json"));
    const raw = trvzbRaw();
    const device = normalizeZigbeeDevice(raw);
    await store.upsertDevice(device);
    const configPath = path.join(directory, "configuration.yaml");
    fs.writeFileSync(configPath, `advanced:\n  last_seen: ISO_8601\ndevices:\n  '${raw.ieee_address}':\n    friendly_name: ${raw.friendly_name}\n    optimistic: false\n    filtered_cache: [running_state, local_temperature]\n`);
    const bridge = new MqttBridge({ url: "", store, observationConfigPath: configPath, logger: { log() {}, error() {}, warn() {} } });
    const observed = [];
    bridge.observationPolicy = { onValueObserved: async (...args) => observed.push(args) };
    const send = (payload, retain = false) => bridge.handleMessage(`zigbee2mqtt/${raw.friendly_name}`, Buffer.from(JSON.stringify(payload)), { retain });
    const running = () => Object.values(store.getDevice(device.id).entities).find((entity) => entity.stateKey === "running_state");
    const t1 = new Date(Date.now() - 30_000).toISOString();
    await send({ running_state: "heat", last_seen: t1 });
    assert.equal(running().sourceObservedAt, t1);
    await send({ running_state: "heat", last_seen: t1 }); // replay after the bridge is online
    assert.equal(observed.length, 1, "a replay with the same last_seen is not a new observation");
    await send({ running_state: "heat", last_seen: new Date(Date.now() - 20_000).toISOString() }, true);
    assert.equal(observed.length, 1, "retained delivery never refreshes");
    await send({ local_temperature: 20.5, last_seen: new Date(Date.now() - 15_000).toISOString() });
    assert.equal(running().sourceObservedAt, t1, "another attribute's report does not refresh heating state");
    const t2 = new Date(Date.now() - 10_000).toISOString();
    await send({ running_state: "heat", last_seen: t2 });
    assert.equal(running().sourceObservedAt, t2, "the same value genuinely re-reported refreshes it");
    assert.deepEqual(observed.at(-1).slice(1), ["running_state", "1", t2]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const { planBoundedReads, unknownReason } = require("../src/observation/freshness");
const { boundedReadLifetime, periodicLifetime } = require("../src/observation/profiles");
const { advanceUsage, initialUsageState, observeUsage } = require("../src/sync/usageBuckets");

test("fallback reads: interval and lifetime align, so successful reads leave no gap and a failed read leaves exactly one", () => {
  const lifetime = boundedReadLifetime(600);
  assert.equal(lifetime, 660); // D9: the 30-second timeout is inside the 60-second delivery allowance.
  let state = initialUsageState();
  const start = Date.parse("2026-10-23T10:00:00.000Z");
  const read = (offsetSeconds, activity = "on") => {
    const at = start + offsetSeconds * 1000;
    state = observeUsage(state, { osDeviceId: "plug", osAreaId: "room", category: "LIGHT", controlId: "power", sourceGeneration: 1, activity,
      observedAt: new Date(at).toISOString(), validUntil: new Date(at + lifetime * 1000).toISOString(), nowMs: at }).state;
  };
  for (let index = 0; index <= 6; index += 1) read(index * 600 + 20); // replies arrive within the 30 s timeout
  state = advanceUsage(state, start + 3600 * 1000).state;
  const bucket = Object.values(state.buckets)[0];
  assert.equal(bucket.unknownSeconds, 0);
  let gapped = initialUsageState();
  state = gapped;
  for (const index of [0, 1, 3, 4, 5, 6]) read(index * 600 + 20); // the read at 1220 s fails
  state = advanceUsage(state, start + 3600 * 1000).state;
  assert.equal(Object.values(state.buckets)[0].unknownSeconds, 1820 - (620 + 660), "only the time beyond the last good read's lifetime is Unknown");
});

test("bounded read planning honours interval, device cap, Hub spacing and refuses budgets that would leave gaps", () => {
  const values = [{ key: "a", deviceId: "d1", enabled: true, power: "mains", intervalSeconds: 600 }, { key: "b", deviceId: "d2", enabled: true, power: "mains", intervalSeconds: 600 }];
  const now = 1_000_000_000;
  assert.deepEqual(planBoundedReads({ nowMs: now, values }).due.map((value) => value.key), ["a"]);
  assert.deepEqual(planBoundedReads({ nowMs: now, values, lastHubReadAtMs: now - 5_000 }).due, [], "Hub-wide spacing");
  assert.deepEqual(planBoundedReads({ nowMs: now, values, lastReadAtByKey: { a: now - 100_000, b: now - 100_000 } }).due, [], "interval not yet reached");
  assert.equal(planBoundedReads({ nowMs: now, values: [{ ...values[0], intervalSeconds: 60 }, { ...values[0], key: "c", intervalSeconds: 60 }] }).reason, "device_read_budget_insufficient");
  assert.deepEqual(planBoundedReads({ nowMs: now, values: [{ ...values[0], power: "battery" }] }).due, [], "battery reads are disabled");
  assert.deepEqual(planBoundedReads({ nowMs: now, values: [{ ...values[0], available: false }] }).due, [], "no reads to an unavailable device");
});

test("Unknown reasons separate Hub, clock, reachability and per-value staleness", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const ago = (minutes) => now - minutes * 60_000;
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: ago(1), valueObservedMs: ago(5), valueValidUntilMs: ago(-6) }), null);
  assert.equal(unknownReason({ nowMs: now, hubRunning: false }), "hub_not_running");
  assert.equal(unknownReason({ nowMs: now, clockTrusted: false }), "clock_not_trusted");
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: false, valueObservedMs: ago(40), valueValidUntilMs: ago(29) }), "device_unreachable");
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: ago(2), valueObservedMs: ago(379), valueValidUntilMs: ago(368), reachabilityWindowSeconds: 1800 }), "value_not_recently_reported");
  assert.equal(unknownReason({ nowMs: now, deviceAvailable: true, deviceLastSeenMs: ago(2), reachabilityWindowSeconds: 1800 }), "value_never_reported");
});

test("cloud and Matter values without verified per-value observation semantics never become fresh history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-observation-cloud-"));
  try {
    const store = new Store(path.join(directory, "store.json"));
    store.setSyncSourceGeneration(1);
    await store.saveArea({ name: "Room" }, "room");
    // A cloud-polled (Hive) or Matter update carries a value but no per-value observation time.
    for (const protocol of ["hive", "matter"]) {
      await store.upsertDevice({ id: `${protocol}-boiler`, name: `${protocol} boiler`, protocol, areaId: "room",
        setup: { status: "ready", assignmentMode: "device_inherited_v1" }, state: { heating: true },
        entities: { heat: { id: "heat", stateKey: "heating", domain: "binary_sensor", capability: { controlId: `${protocol}-heat`, kind: "binary", readable: true, writable: false,
          observable: true, semanticRole: "active_heat_production", maxStateValiditySeconds: 420, bindings: [] } } } });
      await store.updateDeviceState(`${protocol}-boiler`, { heating: true }, { protocol, reportedStateKeys: ["heating"], nowMs: Date.now() });
    }
    assert.equal(Object.keys(store.snapshot().syncUsage.buckets).length, 0, "no history without a verified observation time");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("profile activation is one intentional descriptor revision; rebuilding the same device never bumps it", () => {
  const device = normalizeZigbeeDevice(trvzbRaw());
  device.areaId = "room"; device.setup = { status: "ready", assignmentMode: "device_inherited_v1" };
  const first = buildPresentation(device);
  const again = buildPresentation({ ...device, presentation: first });
  assert.equal(again.descriptorRevision, first.descriptorRevision, "same device, same profile: no churn");
  const withoutProfile = buildPresentation({ ...device, metadata: { ...device.metadata, model: "TRVZB-legacy" }, presentation: first });
  assert.equal(withoutProfile.descriptorRevision, first.descriptorRevision + 1, "a profile change (here: no longer matched) is one revision");
  assert.equal(periodicLifetime(600), 660);
});

test("an unnamed endpoint resolves only when exactly one endpoint carries the cluster (live TRVZB stores endpoint 0)", () => {
  const device = normalizeZigbeeDevice(trvzbRaw());
  const running = { ...Object.values(device.entities).find((entity) => entity.stateKey === "running_state"), endpointId: "0" };
  const one = { ...device, metadata: { ...device.metadata, endpoints: { 1: { clusters: { input: ["genBasic", "hvacThermostat"], output: [] } } } } };
  assert.equal(matchObservationProfile(one, running)?.id, "zigbee.sonoff.trvzb.running_state");
  const two = { ...device, metadata: { ...device.metadata, endpoints: { 1: { clusters: { input: ["hvacThermostat"] } }, 2: { clusters: { input: ["hvacThermostat"] } } } } };
  assert.equal(matchObservationProfile(two, running), null, "ambiguous: never guessed");
  const none = { ...device, metadata: { ...device.metadata, endpoints: { 1: { clusters: { input: ["genBasic"] } } } } };
  assert.equal(matchObservationProfile(none, running), null);
});

test("each descriptor revision records which fingerprint sections changed", () => {
  const device = normalizeZigbeeDevice(trvzbRaw());
  device.areaId = "room"; device.setup = { status: "ready", assignmentMode: "device_inherited_v1" };
  const first = buildPresentation(device);
  const second = buildPresentation({ ...device, metadata: { ...device.metadata, software_build_id: "1.5.0" }, presentation: first });
  assert.equal(second.descriptorRevision, first.descriptorRevision + 1);
  assert.deepEqual(second.revisionHistory.at(-1).changed, ["metadata.software_build_id"]);
  const third = buildPresentation({ ...device, metadata: { ...device.metadata, software_build_id: "1.5.0" }, presentation: second });
  assert.equal(third.revisionHistory.length, second.revisionHistory.length, "no entry without a revision change");
});
