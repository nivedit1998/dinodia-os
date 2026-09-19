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

test("Matter pairing public state never returns the setup code", async () => {
  const pairing = new MatterPairingSession({ matter: { commission: async () => ({ ok: true }) } });
  const result = await pairing.start("MT:Y3.1234567890");
  assert.equal(result.stage, "complete");
  assert.equal(result.codeLast4, "7890");
  assert.equal(result.code, undefined);
  assert.equal(pairing.get(result.id).code, undefined);
});
