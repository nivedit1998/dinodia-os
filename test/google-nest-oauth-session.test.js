const test = require("node:test");
const assert = require("node:assert/strict");
const { GoogleNestOAuthSession } = require("../src/integrations/googleNest/oauthSession");

test("Google Nest OAuth state is high entropy, expires, and is single-use", () => {
  let now = 1000;
  const session = new GoogleNestOAuthSession({ now: () => now, ttlMs: 60000 });
  const started = session.begin({ redirectUri: "https://hub.example/callback", origin: "https://hub.example" });
  assert.ok(started.state.length >= 40);
  assert.equal(session.consume("wrong"), null);
  assert.equal(session.consume(started.state).id, started.id);
  assert.equal(session.consume(started.state), null);
  const second = session.begin({ redirectUri: "https://hub.example/callback", origin: "https://hub.example" });
  now += 60001;
  assert.equal(session.consume(second.state), null);
});

test("Google Nest OAuth does not allow two active setup sessions", () => {
  const session = new GoogleNestOAuthSession();
  session.begin({ redirectUri: "https://hub.example/callback" });
  assert.throws(() => session.begin({ redirectUri: "https://hub.example/callback" }), (error) => error.code === "setup_in_progress");
  session.clear();
  assert.equal(session.status().pending, false);
});
