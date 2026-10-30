const test = require("node:test");
const assert = require("node:assert/strict");
const { lastReadingFrom, LAST_READING_MAX_AGE_MS } = require("../src/observation/alexaLastReading");

const now = Date.parse("2026-10-30T20:00:00.000Z");
const control = { controlId: "room-temperature", semanticRole: "ambient_temperature", valueType: "number", writable: false };
const state = { quality: "unknown", value: null, revision: 7 };
const report = (observedAt, extra = {}) => ({ lastReported: { value: 21.5, observedAt, provenance: "device_report", ...extra }, evidence: { status: "stale" } });
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

test("a read-only room temperature that is no longer current carries its last device report", () => {
  assert.deepEqual(lastReadingFrom({ control, state, evidence: report(at(45)), now }), { value: 21.5, observedAt: at(45), revision: 7 });
});

test("a current state, a setting, another kind of control, or a non-number never gets a last reading", () => {
  const evidence = report(at(45));
  assert.equal(lastReadingFrom({ control, state: { ...state, quality: "fresh" }, evidence, now }), null);
  assert.equal(lastReadingFrom({ control: { ...control, writable: true }, state, evidence, now }), null);
  assert.equal(lastReadingFrom({ control: { ...control, semanticRole: "power", valueType: "boolean" }, state, evidence, now }), null);
  assert.equal(lastReadingFrom({ control: { ...control, valueType: "text" }, state, evidence, now }), null);
  assert.equal(lastReadingFrom({ control, state, evidence: report(at(45), { value: "21.5" }), now }), null);
});

test("only a value the device itself reported counts, and never when the device is offline or the clock is untrusted", () => {
  assert.equal(lastReadingFrom({ control, state, evidence: report(at(45), { provenance: "command_echo" }), now }), null);
  for (const status of ["clock_untrusted", "device_offline", "no_observation"]) {
    assert.equal(lastReadingFrom({ control, state, evidence: { ...report(at(45)), evidence: { status } }, now }), null);
  }
  assert.equal(lastReadingFrom({ control, state, evidence: null, now }), null);
});

test("a report from the future, an unreadable time, or older than the limit is dropped", () => {
  assert.equal(lastReadingFrom({ control, state, evidence: report(at(-5)), now }), null);
  assert.equal(lastReadingFrom({ control, state, evidence: report("not a time"), now }), null);
  assert.equal(lastReadingFrom({ control, state, evidence: report(new Date(now - LAST_READING_MAX_AGE_MS - 1000).toISOString()), now }), null);
  assert.notEqual(lastReadingFrom({ control, state, evidence: report(new Date(now - LAST_READING_MAX_AGE_MS + 1000).toISOString()), now }), null);
  assert.equal(lastReadingFrom({ control, state: { ...state, revision: 0 }, evidence: report(at(45)), now }), null);
});
