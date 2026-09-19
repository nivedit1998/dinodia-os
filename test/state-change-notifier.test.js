const test = require("node:test");
const assert = require("node:assert/strict");
const { StateChangeNotifier } = require("../src/stateChangeNotifier");

test("state-change delivery coalesces updates and retries without blocking local callers", async () => {
  let attempts = 0;
  const notifier = new StateChangeNotifier({
    url: "https://platform.test",
    secret: "webhook-secret",
    logger: { error() {} },
    fetchImpl: async (_url, options) => {
      attempts += 1;
      assert.match(options.headers.authorization, /^Bearer webhook-secret$/);
      if (attempts < 2) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    },
  });
  notifier.enqueue("light.example", { source: "physical" });
  notifier.enqueue("light.example", { source: "coalesced" });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(attempts, 2);
  assert.equal(notifier.status().sent, 1);
  assert.equal(notifier.status().pending, 0);
  assert.equal(notifier.status().deduped, 1);
});
