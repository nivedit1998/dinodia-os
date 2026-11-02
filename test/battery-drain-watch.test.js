const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { matchObservationProfile } = require("../src/observation/profiles");
const { ObservationReconciler, STATES } = require("../src/observation/reconciler");

const DAY = 86_400_000;
// A battery radiator valve from a brand the hub has never seen.
function unknownBrandValve({ withBattery = true, reported = [] } = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
  raw.definition.vendor = "Acme"; raw.definition.model = "TRV-X"; raw.model_id = "TRV-X";
  if (!withBattery) raw.definition.exposes = raw.definition.exposes.filter((expose) => expose.property !== "battery");
  raw.endpoints = { 1: { bindings: [], clusters: { input: ["hvacThermostat"], output: [] }, configured_reportings: reported } };
  raw.type = "EndDevice"; raw.power_source = "Battery"; raw.software_build_id = "1.0"; raw.date_code = "20260101";
  return raw;
}

async function harness({ battery = 80, withBattery = true, reported = [{ cluster: "hvacThermostat", attribute: "runningState", minimum_report_interval: 1, maximum_report_interval: 3600, reportable_change: 0 }] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-battery-watch-"));
  const store = new Store(path.join(directory, "store.json"));
  const raw = unknownBrandValve({ withBattery, reported });
  const device = normalizeZigbeeDevice(raw);
  await store.upsertDevice({ ...device, metadata: { ...device.metadata, power_source: "Battery" } });
  if (battery !== null && withBattery) await store.updateDeviceState(device.id, { battery }, { protocol: "zigbee", available: true });
  const clock = { now: Date.parse("2026-11-02T10:00:00.000Z") };
  const sent = [];
  const reconciler = new ObservationReconciler({ store, publishBridgeRequest: async (requestPath, payload) => { sent.push({ path: requestPath, payload }); },
    resolveDeviceId: () => device.id, clock: () => clock.now });
  const step = async () => { clock.now += 60_000; return reconciler.tick(); };
  const answer = async (kind, config) => reconciler.onBridgeResponse(kind, { status: "ok", transaction: sent.at(-1).payload.transaction,
    data: { cluster: "hvacThermostat", endpoint: 1, configs: [{ attrId: 41, ...config }] } });
  const record = () => [...reconciler.records.values()][0];
  return { directory, store, raw, device, clock, sent, reconciler, step, answer, record, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

// Runs the device through read, configure and read-back until its battery is being watched.
async function configured(h) {
  await h.reconciler.onInventory([h.raw]);
  await h.step(); assert.equal(h.sent.at(-1).path, "device/reporting/read");
  await h.answer("read", { status: 0, minRepIntval: 1, maxRepIntval: 3600, repChange: 0 });
  assert.equal(h.record().state, STATES.DRIFTED);
  assert.deepEqual(h.record().originalReporting, { minimumReportInterval: 1, maximumReportInterval: 3600, reportableChange: 0 }, "the original setting is remembered");
  await h.step(); assert.equal(h.sent.at(-1).path, "device/reporting/configure");
  assert.equal(h.sent.at(-1).payload.maximum_report_interval, 600);
  await h.answer("configure", {});
  assert.equal(h.record().batteryWatch.status, "watching");
  assert.equal(h.record().batteryWatch.samples[0].level, 80, "the watch starts from the battery level at the time of the change");
  await h.step(); assert.equal(h.sent.at(-1).path, "device/reporting/read");
  await h.answer("read", { status: 0, minRepIntval: 0, maxRepIntval: 600, repChange: 0 });
  assert.equal(h.record().state, STATES.CADENCE_PENDING);
}

test("a battery thermostat of any brand is profiled, but only if its battery level is readable", async () => {
  const withBattery = normalizeZigbeeDevice(unknownBrandValve());
  const running = (device) => Object.values(device.entities).find((entity) => entity.stateKey === "running_state");
  const asBattery = (device) => ({ ...device, metadata: { ...device.metadata, power_source: "Battery" } });
  assert.equal(matchObservationProfile(asBattery(withBattery), running(withBattery))?.id, "zigbee.generic.battery_thermostat.heat_demand");
  const without = normalizeZigbeeDevice(unknownBrandValve({ withBattery: false }));
  assert.equal(matchObservationProfile(asBattery(without), running(without)), null, "no battery reading, no automatic change");
  const mains = { ...withBattery, metadata: { ...withBattery.metadata, power_source: "Mains (single phase)" } };
  assert.ok(matchObservationProfile(mains, running(mains)), "(the valve fixture's endpoint carries the thermostat cluster)");
  assert.equal(matchObservationProfile(mains, running(mains))?.id, "zigbee.generic.mains_thermostat.heat_demand", "a mains thermostat is configured like a mains switch");
  const unknownPower = { ...withBattery, metadata: { ...withBattery.metadata, power_source: "Unknown" } };
  assert.equal(matchObservationProfile(unknownPower, running(unknownPower)), null);
});

test("the original setting is read first, remembered, and the change is made only then", async () => {
  const h = await harness();
  try { await configured(h); } finally { h.cleanup(); }
});

test("a battery device whose level is unknown is never changed", async () => {
  const h = await harness({ battery: null });
  try {
    await h.reconciler.onInventory([h.raw]);
    await h.step(); await h.answer("read", { status: 0, minRepIntval: 1, maxRepIntval: 3600, repChange: 0 });
    assert.equal(h.record().state, STATES.DRIFTED);
    await h.step(); await h.step();
    assert.deepEqual(h.sent.map((item) => item.path), ["device/reporting/read"], "no configure request without a known battery level");
  } finally { h.cleanup(); }
});

test("a slow, normal drain is left alone", async () => {
  const h = await harness();
  try {
    await configured(h);
    const start = h.clock.now;
    for (let day = 1; day <= 12; day += 1) await h.reconciler.onBatteryReading(h.device.id, 80 - Math.floor(day / 4), new Date(start + day * DAY).toISOString());
    assert.equal(h.record().batteryWatch.status, "watching");
    assert.equal(h.record().revertedForBattery, undefined);
  } finally { h.cleanup(); }
});

test("a fast drain restores the original setting automatically and the device is never changed again", async () => {
  const h = await harness();
  try {
    await configured(h);
    const start = h.clock.now;
    await h.reconciler.onBatteryReading(h.device.id, 78, new Date(start + 1 * DAY).toISOString());
    assert.equal(h.record().revertedForBattery, undefined, "one day of readings is never judged");
    await h.reconciler.onBatteryReading(h.device.id, 72, new Date(start + 3 * DAY).toISOString());
    assert.equal(h.record().revertedForBattery.reason, "battery_drain_high");
    assert.deepEqual(h.record().desired, { minimumReportInterval: 1, maximumReportInterval: 3600, reportableChange: 0 }, "the original is the new target");
    h.clock.now = start + 3 * DAY;
    await h.step(); assert.equal(h.sent.at(-1).path, "device/reporting/configure");
    assert.equal(h.sent.at(-1).payload.maximum_report_interval, 3600, "the original interval is sent back");
    await h.answer("configure", {});
    await h.step(); assert.equal(h.sent.at(-1).path, "device/reporting/read");
    await h.answer("read", { status: 0, minRepIntval: 1, maxRepIntval: 3600, repChange: 0 });
    assert.equal(h.record().state, STATES.UNSUPPORTED);
    assert.equal(h.record().lastError, "reverted_for_battery");
    assert.equal(h.record().approvedForAutomaticConfiguration, false, "only a person can approve it again");
    const before = h.sent.length;
    for (let i = 0; i < 5; i += 1) await h.step();
    assert.equal(h.sent.length, before, "nothing more is ever sent to it");
    // A later inventory or firmware change must not bring the automatic setting back.
    const upgraded = { ...h.raw, software_build_id: "2.0" };
    await h.reconciler.onInventory([upgraded]);
    assert.equal(h.record().approvedForAutomaticConfiguration, false);
    assert.equal(h.record().revertedForBattery.reason, "battery_drain_high");
  } finally { h.cleanup(); }
});

test("a low battery restores the setting straight away, and a new battery restarts the watch", async () => {
  const h = await harness();
  try {
    await configured(h);
    const start = h.clock.now;
    await h.reconciler.onBatteryReading(h.device.id, 9, new Date(start + 1000).toISOString());
    assert.equal(h.record().revertedForBattery.reason, "battery_low");
  } finally { h.cleanup(); }
  const g = await harness();
  try {
    await configured(g);
    const start = g.clock.now;
    await g.reconciler.onBatteryReading(g.device.id, 40, new Date(start + 10 * DAY).toISOString());
    assert.equal(g.record().revertedForBattery.reason, "battery_drain_high", "40 points in ten days is far too fast");
  } finally { g.cleanup(); }
  const k = await harness();
  try {
    await configured(k);
    const start = k.clock.now;
    await k.reconciler.onBatteryReading(k.device.id, 30, new Date(start + 0.5 * DAY).toISOString());
    await k.reconciler.onBatteryReading(k.device.id, 99, new Date(start + 1 * DAY).toISOString());
    assert.equal(k.record().batteryWatch.samples.length, 1, "a fresh battery starts the watch again");
    assert.equal(k.record().revertedForBattery, undefined);
  } finally { k.cleanup(); }
});

test("a battery that is already low is never changed", async () => {
  const h = await harness({ battery: 8 });
  try {
    await h.reconciler.onInventory([h.raw]);
    await h.step(); await h.answer("read", { status: 0, minRepIntval: 1, maxRepIntval: 3600, repChange: 0 });
    await h.step(); await h.step();
    assert.deepEqual(h.sent.map((item) => item.path), ["device/reporting/read"]);
  } finally { h.cleanup(); }
});
