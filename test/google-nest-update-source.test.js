const test = require("node:test");
const assert = require("node:assert/strict");
const { PollingUpdateSource, MAX_BACKOFF_MS } = require("../src/integrations/googleNest/updateSource");

test("Google Nest polling uses bounded exponential backoff and resets after recovery", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  let shouldFail = true;
  try {
    const source = new PollingUpdateSource({ intervalMs: 30_000, jitterMs: 0, onPoll: async () => { if (shouldFail) throw new Error("temporary"); } });
    source.start();
    assert.equal(timers[0].delay, 30_000);
    await timers[0].callback();
    assert.equal(timers[1].delay, 30_000);
    await timers[1].callback();
    assert.equal(timers[2].delay, 60_000);
    await timers[2].callback();
    assert.equal(timers[3].delay, 120_000);
    assert.ok(timers[3].delay <= MAX_BACKOFF_MS);
    shouldFail = false;
    await timers[3].callback();
    assert.equal(timers[4].delay, 30_000);
    assert.equal(source.status().consecutiveFailures, 0);
    source.stop();
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});
