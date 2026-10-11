const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldAttemptCloudflareVerification } = require("../src/server");

const healthyPending = {
  mode: "local",
  connected: true,
  connectorIdentityVerified: true,
  transport: { originState: "HEALTHY", edgeState: "CONNECTED" },
  platformVerification: { state: "PLATFORM_REPORT_PENDING", fresh: false },
};

test("a healthy existing tunnel retries a persisted pending signed verification after restart", () => {
  assert.equal(shouldAttemptCloudflareVerification(healthyPending, { now: 1000 }), true);
});

test("automatic signed verification waits for healthy transport, current identity, and retry backoff", () => {
  assert.equal(shouldAttemptCloudflareVerification({ ...healthyPending, transport: { originState: "UNHEALTHY" } }, { now: 1000 }), false);
  assert.equal(shouldAttemptCloudflareVerification({ ...healthyPending, connectorIdentityVerified: false }, { now: 1000 }), false);
  assert.equal(shouldAttemptCloudflareVerification({ ...healthyPending, platformVerification: { state: "PLATFORM_VERIFIED", fresh: true } }, { now: 1000 }), false);
  assert.equal(shouldAttemptCloudflareVerification(healthyPending, { inFlight: true, now: 1000 }), false);
  assert.equal(shouldAttemptCloudflareVerification(healthyPending, { retryAt: 1001, now: 1000 }), false);
  assert.equal(shouldAttemptCloudflareVerification(healthyPending, { retryAt: 1000, now: 1000 }), true);
});
