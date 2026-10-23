'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeUsage, advanceUsage } = require('../src/sync/usageBuckets');
const start = Date.parse('2026-10-23T08:00:00Z');
function trace(first, second) {
  const observation = (activity, offset) => ({ osDeviceId: 'synthetic-light', osAreaId: 'synthetic-area',
    category: 'LIGHT', controlId: 'power', sourceGeneration: 1, activity,
    observedAt: new Date(start + offset).toISOString(), validUntil: new Date(start + offset + 660_000).toISOString(),
    nowMs: start + offset });
  let state = observeUsage({}, observation(first, 0)).state;
  state = observeUsage(state, observation(second, 600_000)).state;
  state = advanceUsage(state, start + 1_200_000).state;
  return Object.values(state.buckets)[0];
}
test('legacy absolute counters cannot be retroactively divided at a category-policy boundary', () => {
  // Genuine opposite traces have byte-identical bucket facts, including revision and coverage.
  // At 08:10 one trace has 600 On seconds before the boundary, the other has 600 Off seconds.
  // An interval table alone cannot recover that distinction from a delayed v1 payload.
  const onThenOff = trace('on', 'off');
  const offThenOn = trace('off', 'on');
  assert.deepEqual(onThenOff, offThenOn);
  assert.equal(onThenOff.onSeconds, 600);
  assert.equal(onThenOff.offSeconds, 600);
  assert.equal(onThenOff.coverageEndAt, '2026-10-23T08:20:00.000Z');
});
