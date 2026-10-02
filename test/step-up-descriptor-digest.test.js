const test = require("node:test");
const assert = require("node:assert/strict");
const { stepUpDescriptorDigest } = require("../src/auth/stepUpDescriptorDigest");

test("step-up descriptor digest matches the canonical raw-hex contract and preserves the OS fingerprint", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  assert.equal(stepUpDescriptorDigest({ presentation: { sourceFingerprint: fingerprint } }), "a".repeat(64));
  assert.equal(stepUpDescriptorDigest({ presentation: { descriptorDigest: "b".repeat(64) } }), "b".repeat(64));
  assert.equal(stepUpDescriptorDigest({ presentation: { sourceFingerprint: "sha256:truncated" } }), null);
  assert.equal(stepUpDescriptorDigest({ presentation: {} }), null);
  assert.equal(stepUpDescriptorDigest(null), null);
});
