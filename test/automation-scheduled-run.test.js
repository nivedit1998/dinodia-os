const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { applyCloudConfiguration } = require("../src/sync/cloudConfiguration");
const { AutomationService } = require("../src/automations/service");
const { AutomationExecutor } = require("../src/automations/executor");
const { AutomationScheduler } = require("../src/automations/scheduler");
const { normalizeZigbeeDevice } = require("../src/integrations/zigbee/exposeNormalizer");
const { getSurfaces } = require("../src/capabilities/devicePresentation");
const { serializeDevice } = require("../src/contracts/dinodiaV1");

// End-to-end scheduler proof for a Platform tenant automation targeting a real SONOFF TRVZB.
// The Platform stores the control ID the app chose from the Hub's PUBLIC descriptor; the Hub
// must accept that ID, run the schedule exactly once and never retry a physical action.

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function signedConfiguration(unsigned) {
  return { ...unsigned, checksum: crypto.createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex") };
}

const NOW = new Date("2026-10-23T06:00:00.000Z"); // Friday 07:00 Europe/London (BST)

async function trvHome() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-automation-scheduled-run-"));
  const dataFile = path.join(directory, "dinodia.json");
  const store = new Store(dataFile);
  await store.saveIdentity({ serial: "DINODIA-SCHEDULED-RUN-HUB", instanceId: "scheduled-run-home" });
  await store.saveArea({ name: "Room 1" }, "os-room-1");
  const fixture = JSON.parse(fsSync.readFileSync(path.join(__dirname, "fixtures/zigbee/sonoff-trvzb-observation.json"), "utf8"));
  const normalized = normalizeZigbeeDevice(fixture);
  await store.upsertDevice({ ...normalized, areaId: "os-room-1", managementClass: "PROPERTY_DEVICE",
    setup: { status: "ready", assignmentMode: "device_inherited_v1" },
    state: { occupied_heating_setpoint: 20, local_temperature: 19.5, system_mode: "heat", running_state: "heat", battery: 80 } });
  const device = store.getDevice(normalized.id);
  const descriptor = serializeDevice({ device, homeId: "home-fixture", homeMembershipId: "membership-fixture", role: "OWNER",
    areaIds: ["os-room-1"], surfaces: getSurfaces(device) });
  const setpoint = descriptor.controls.find((control) => control.semanticRole === "target_temperature");
  const mode = descriptor.controls.find((control) => control.semanticRole === "operating_mode");
  assert.ok(setpoint && mode, "the public descriptor exposes the TRV setpoint and system mode");
  return { directory, dataFile, store, device, setpoint, mode };
}

function configurationFor(device, actions, { revision = 1, status = "ACTIVE" } = {}) {
  const descriptorDigest = crypto.createHash("sha256").update(String(device.presentation.sourceFingerprint || ""), "utf8").digest("hex");
  return signedConfiguration({
    revision, policyRevision: 1,
    areas: [{ id: "platform-area-room-1", osAreaId: "os-room-1", originalName: "Room 1", overrideName: null, revision: 1 }],
    memberships: [{ id: "platform-tenant", role: "TENANT", accessRevision: 1, areaIds: ["platform-area-room-1"], grantRevisions: [{ areaId: "platform-area-room-1", revision: 1 }] }],
    devicePolicies: [{ osDeviceId: device.id, managementClass: "PROPERTY_DEVICE", ownerMembershipId: null, analyticsCategory: "RADIATOR",
      lifecycle: "INSTALLED", customerLabel: null, overrideName: null, descriptorRevision: device.presentation.descriptorRevision, descriptorDigest, osAreaIds: ["os-room-1"] }],
    automations: actions === null ? [] : [{
      id: "platform-automation-radiator-morning", name: "Radiator morning", status, revision: 1,
      definitionChecksum: crypto.createHash("sha256").update("radiator-morning").digest("hex"),
      timezone: "Europe/London",
      triggers: [{ id: "platform-trigger-morning", kind: "SCHEDULE", configuration: { minuteOfDay: 420, weekdays: [5] }, revision: 1 }],
      actions,
    }],
    releasePolicy: { mode: "MANUAL", automaticInstallEnabled: false, desiredRelease: null },
  });
}

function actionFor(device, control, actionValue, id = "platform-action-setpoint") {
  return { id, osDeviceId: device.id, osAreaId: "os-room-1", controlId: control.controlId,
    descriptorRevision: device.presentation.descriptorRevision, actionValue, needsAttention: false };
}

function schedulerFor(store, executeControl, now = NOW) {
  const service = new AutomationService({ store, homeId: "scheduled-run-home", now: () => new Date(now) });
  const executor = new AutomationExecutor({ store, now: () => new Date(now), executeControl, logger: { error() {}, warn() {}, log() {} } });
  return new AutomationScheduler({ store, service, executor, now: () => new Date(now), setIntervalFn: () => null, clearIntervalFn() {}, logger: { error() {}, warn() {}, log() {} } });
}

test("a Platform schedule using the public descriptor setpoint ID runs exactly once at its minute", async () => {
  const { store, dataFile, device, setpoint } = await trvHome();
  await applyCloudConfiguration(store, configurationFor(device, [actionFor(device, setpoint, { type: "number", number: 21.5 })]));
  const effects = [];
  const execute = async (input) => { effects.push({ actionId: input.action.id, controlId: input.action.controlId, value: input.action.targetValue }); };

  const before = new Date(NOW.getTime() - 60_000);
  assert.deepEqual(await schedulerFor(store, execute, before).tick(before), { claimed: 0 }, "nothing runs before the scheduled minute");
  assert.deepEqual(await schedulerFor(store, execute).tick(NOW), { claimed: 1 }, "exactly one occurrence at the minute");
  assert.equal(effects.length, 1, "exactly one device action");
  assert.equal(effects[0].value.number, 21.5);
  assert.equal(store.state.automationExecutions[0].status, "succeeded");

  const later = new Date(NOW.getTime() + 30_000);
  assert.deepEqual(await schedulerFor(store, execute, later).tick(later), { claimed: 0 }, "a later tick in the same window does not re-run");
  const restarted = new Store(dataFile);
  assert.deepEqual(await schedulerFor(restarted, async () => { effects.push("duplicate"); }).tick(NOW), { claimed: 0 }, "a Hub restart does not re-run");
  assert.equal(effects.length, 1);
  assert.equal(await restarted.ensureAutomationOutcomeEvents(NOW.getTime() + 1000), 1, "one outcome is queued for the Platform");
  assert.equal(restarted.getSyncOutbox().events.filter((event) => event.type === "automation.outcome").length, 1);
});

test("with activation off the Platform sends no automations and nothing runs", async () => {
  const { store, device } = await trvHome();
  await applyCloudConfiguration(store, configurationFor(device, null));
  let ran = 0;
  assert.deepEqual(await schedulerFor(store, async () => { ran += 1; }).tick(NOW), { claimed: 0 });
  assert.equal(ran, 0);
});

test("an uncertain device action is recorded as uncertain and never retried", async () => {
  const { store, device, setpoint } = await trvHome();
  await applyCloudConfiguration(store, configurationFor(device, [actionFor(device, setpoint, { type: "number", number: 21.5 })]));
  let calls = 0;
  const stalled = async () => { calls += 1; throw Object.assign(new Error("The adapter did not return in time"), { code: "COMMAND_DISPATCH_TIMEOUT", uncertain: true }); };
  assert.deepEqual(await schedulerFor(store, stalled).tick(NOW), { claimed: 1 });
  assert.equal(store.state.automationExecutions[0].status, "failed");
  const occurrence = Object.values(store.state.automationOccurrences)[0];
  assert.equal(occurrence.actionOutcomes[0].status, "uncertain");
  assert.deepEqual(await schedulerFor(store, stalled).tick(NOW), { claimed: 0 }, "no automatic retry");
  assert.equal(calls, 1);
});

test("the system mode descriptor ID is also accepted", async () => {
  const { store, device, mode } = await trvHome();
  await applyCloudConfiguration(store, configurationFor(device, [actionFor(device, mode, { type: "option", option: "heat" }, "platform-action-mode")]));
  const effects = [];
  assert.deepEqual(await schedulerFor(store, async (input) => { effects.push(input.action.targetValue.option); }).tick(NOW), { claimed: 1 });
  assert.deepEqual(effects, ["heat"]);
});

test("the live scheduler (service keyed by Hub serial) runs a Platform schedule stored under the instance ID", async () => {
  // Production builds AutomationService with homeId = Hub serial, while cloud configuration stores
  // Platform rules under identity.instanceId. The scheduler must still see and run them.
  const { store, device, setpoint } = await trvHome();
  await applyCloudConfiguration(store, configurationFor(device, [actionFor(device, setpoint, { type: "number", number: 21.5 })]));
  const effects = [];
  const service = new AutomationService({ store, homeId: () => "DINODIA-SCHEDULED-RUN-HUB", now: () => new Date(NOW) });
  const executor = new AutomationExecutor({ store, now: () => new Date(NOW), executeControl: async (input) => { effects.push(input.action.targetValue.number); }, logger: { error() {}, warn() {}, log() {} } });
  const scheduler = new AutomationScheduler({ store, service, executor, now: () => new Date(NOW), setIntervalFn: () => null, clearIntervalFn() {}, logger: { error() {}, warn() {}, log() {} } });
  assert.deepEqual(await scheduler.tick(NOW), { claimed: 1 });
  assert.deepEqual(effects, [21.5]);
});
