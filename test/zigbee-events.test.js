const test = require("node:test");
const assert = require("node:assert/strict");
const { ZigbeeEventNormalizer } = require("../src/integrations/zigbee/eventNormalizer");

test("Zigbee remote actions are normalized and immediate duplicates are suppressed", () => {
  const normalizer = new ZigbeeEventNormalizer({ windowMs: 750 });
  const first = normalizer.normalize({ deviceId: "zigbee:remote", endpointId: "1", payload: { action: "on", button: "on" } });
  const duplicate = normalizer.normalize({ deviceId: "zigbee:remote", endpointId: "1", payload: { action: "on", button: "on" } });
  const hold = normalizer.normalize({ deviceId: "zigbee:remote", endpointId: "1", payload: { action: "hold" } });
  assert.equal(first.action, "single");
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(hold.action, "hold");
});
