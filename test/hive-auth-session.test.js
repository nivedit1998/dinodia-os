const test = require("node:test");
const assert = require("node:assert/strict");
const { HiveAuthSession, COOLDOWN_MS } = require("../src/integrations/hive/authSession");

test("Hive credential sessions expire, clear secrets, and rate-limit repeated failures", () => {
  let now = 1_000_000;
  const session = new HiveAuthSession({ now: () => now, ttlMs: 60_000 });
  const current = session.begin("owner@example.com", "secret-password");
  assert.equal(session.sanitized(current.id).sessionId, current.id);
  session.recordFailure(current.id);
  session.recordFailure(current.id);
  assert.ok(session.get(current.id));
  session.recordFailure(current.id);
  assert.equal(session.get(current.id), null);
  assert.throws(() => session.begin("owner@example.com", "secret-password"), { code: "authentication_rate_limited" });
  now += COOLDOWN_MS + 1;
  const replacement = session.begin("owner@example.com", "new-secret");
  assert.equal(session.get(replacement.id).password, "new-secret");
  session.clear();
  assert.equal(session.current, null);
});

test("invalid Hive setup input is rejected before the worker is called", () => {
  const session = new HiveAuthSession();
  assert.throws(() => session.begin("", "password"), { code: "invalid_credentials" });
  assert.throws(() => session.begin("owner@example.com", ""), { code: "invalid_credentials" });
});
