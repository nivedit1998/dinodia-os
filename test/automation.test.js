const test = require("node:test");
const assert = require("node:assert/strict");
const { AutomationEngine, triggerMatches } = require("../src/automation");

test("automation trigger matches device state conditions", () => {
  const device = { id: "motion", protocol: "virtual", available: true, state: { motion: "ON", level: 3 } };
  assert.equal(triggerMatches({ deviceId: "motion", field: "motion", equals: "ON" }, device), true);
  assert.equal(triggerMatches({ deviceId: "motion", field: "level", greaterThan: 4 }, device), false);
  assert.equal(triggerMatches({ deviceId: "other", field: "motion", equals: "ON" }, device), false);
});

test("automation engine runs actions and records a single cooldown event", async () => {
  const automation = { id: "a1", name: "Test", enabled: true, trigger: { deviceId: "motion", field: "motion", equals: "ON" }, actions: [{ deviceId: "lamp", command: { state: { power: "ON" } } }], cooldownMs: 60000 };
  const calls = [];
  const events = [];
  const store = { listAutomations: () => [automation], addEvent: async (event) => events.push(event) };
  const engine = new AutomationEngine({ store, executeAction: async (action) => calls.push(action) });
  const device = { id: "motion", state: { motion: "ON" }, protocol: "virtual" };
  await engine.onDeviceChanged(device);
  await engine.onDeviceChanged(device);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
});

test("state transitions and attribute delta conditions use the previous device snapshot", async () => {
  const previous = {
    id: "lamp",
    protocol: "virtual",
    state: { power: "OFF", brightness: 10 },
    entities: { "lamp:power": { id: "lamp:power", stateKey: "power", state: "OFF", haEntityId: "switch.lamp" } },
  };
  const current = {
    ...previous,
    state: { power: "ON", brightness: 30 },
    entities: { "lamp:power": { ...previous.entities["lamp:power"], state: "ON" } },
  };
  assert.equal(triggerMatches({ entity_id: "switch.lamp", from: "OFF", to: "ON" }, current, previous), true);
  assert.equal(triggerMatches({ entity_id: "switch.lamp", from: "ON", to: "OFF" }, current, previous), false);

  const automation = {
    id: "brightness-up",
    name: "Brightness increased",
    enabled: true,
    trigger: { entity_id: "switch.lamp", attribute: "brightness" },
    conditions: [{ condition: "template", value_template: "{{ (trigger.to_state.attributes['brightness'] | default(0)) - (trigger.from_state.attributes['brightness'] | default(0)) >= 10 }}" }],
    actions: [{ deviceId: "fan", command: { state: { power: "ON" } } }],
    cooldownMs: 0,
  };
  const calls = [];
  const store = { listAutomations: () => [automation], addEvent: async () => {} };
  const engine = new AutomationEngine({ store, executeAction: async (action) => calls.push(action) });
  await engine.onDeviceChanged(current, previous);
  assert.equal(calls.length, 1);
});
