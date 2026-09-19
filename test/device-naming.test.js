const test = require("node:test");
const assert = require("node:assert/strict");
const { isMachineName, matterName, zigbeeName } = require("../src/deviceNaming");

test("machine identities are detected without rejecting user names", () => {
  assert.equal(isMachineName("0xf044d3fffe1242f6"), true);
  assert.equal(isMachineName("zigbee:abc123"), true);
  assert.equal(isMachineName("Kitchen radiator"), false);
});

test("Zigbee default names use manufacturer and model", () => {
  assert.equal(zigbeeName({ friendly_name: "0xf044d3fffe1242f6", manufacturer: "SONOFF", model_id: "TRVZB" }), "SONOFF TRVZB");
  assert.equal(zigbeeName({ friendly_name: "kitchen-switch", manufacturer: "SONOFF", model_id: "SWV" }), "kitchen-switch");
});

test("Matter default names use vendor and product", () => {
  assert.equal(matterName({ node_id: 17, vendor_name: "Eve", product_name: "Thermo" }), "Eve Thermo");
  assert.equal(matterName({ node_id: 17 }), "Matter device 17");
});
