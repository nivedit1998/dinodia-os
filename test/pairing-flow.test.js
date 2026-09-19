const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { MatterPairingSession } = require("../src/integrations/matter/pairingSession");
const { ZigbeePairingSession } = require("../src/integrations/zigbee/pairingSession");

test("pairing baselines keep known devices out and automatically close after a new interview", () => {
  const session = new ZigbeePairingSession({ ttlSeconds: 30 });
  session.start(new Date(Date.now() + 60_000).toISOString(), 30, ["known"]);
  session.add("known", { stage: "joined" });
  session.add("new", { stage: "interviewing" });
  assert.deepEqual(session.status().found, ["new"]);
  assert.equal(session.isNew("new"), true);
  session.stop();
  session.add("another", { stage: "joined" });
  assert.deepEqual(session.status().found, ["new"]);
});

test("Matter commissioning remains needs_setup until the actual node is ingested", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-pairing-flow-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const pairing = new MatterPairingSession({ store, matter: { commission: async () => ({ ok: true }) } });
  const result = await pairing.start("MT:Y3.1234567890");
  assert.equal(result.stage, "waiting_for_device");
  assert.equal(result.deviceId, null);
  assert.equal(result.code, undefined);
});
