'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyActivityV1 } = require('../src/contracts/analyticsV1');
const fixture = require('./fixtures/category-analytics-next-policy.json');
// Draft next-policy expectations against the real current classifier, not a test implementation.
// powerCapabilityPresent specifies why a missing power value must not authorize brightness fallback.
for (const row of fixture.cases) test('next category policy: ' + row.id, () => {
  assert.equal(classifyActivityV1({ ...row, quality: 'fresh', validUntil: fixture.validUntil },
    Date.parse(fixture.now)), row.expected);
});
test('expired measurements remain Unknown under the next policy', () => {
  assert.equal(classifyActivityV1({ category: 'light', quality: 'fresh',
    validUntil: fixture.now, signals: { powerOn: true } }, Date.parse(fixture.now)), 'unknown');
});
