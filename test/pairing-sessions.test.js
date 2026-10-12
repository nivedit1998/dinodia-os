const test = require("node:test");
const assert = require("node:assert/strict");
const { ZigbeePairingSession } = require("../src/integrations/zigbee/pairingSession");
const { MatterPairingSession } = require("../src/integrations/matter/pairingSession");

test("Zigbee pairing is bounded, deduplicates found devices, and stops idempotently", () => {
  const session = new ZigbeePairingSession({ ttlSeconds: 30 });
  session.start(new Date(Date.now() + 60_000).toISOString());
  session.add("zigbee:one");
  session.add("zigbee:one");
  assert.deepEqual(session.status().found, ["zigbee:one"]);
  assert.equal(session.stop().active, false);
  assert.equal(session.stop().active, false);
});

test("Zigbee pairing reports the radio join window closed while preserving its longer discovery tracker", async () => {
  const session = new ZigbeePairingSession({ ttlSeconds: 30 });
  const joinDeadline = new Date(Date.now() + 25).toISOString();
  session.start(joinDeadline, 30, [], { sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(session.status().active, true, "the discovery tracker remains available for an in-flight interview");
  assert.equal(session.status().permitJoinOpen, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const closed = session.status();
  assert.equal(closed.active, true, "closing the radio window must not discard a candidate already being interviewed");
  assert.equal(closed.permitJoinOpen, false);
  assert.ok(Date.parse(closed.permitJoinExpiresAt) <= Date.now());
  session.add("zigbee:joined-before-close");
  assert.deepEqual(session.status().found, ["zigbee:joined-before-close"]);
});

test("Matter pairing public state never returns the setup code", async () => {
  const pairing = new MatterPairingSession({ matter: { commission: async () => ({ ok: true }) } });
  const result = await pairing.start("MT:Y3.1234567890");
  assert.equal(result.stage, "complete");
  assert.equal(result.codeLast4, "7890");
  assert.equal(result.code, undefined);
  assert.equal(pairing.get(result.id).code, undefined);
});
