const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMatterServerUrl } = require("../src/integrations/matter/connectionConfig");

test("a selected local Thread RCP enables the bundled Matter Server without inventing a Thread network", () => {
  assert.equal(resolveMatterServerUrl("", { configured: false, rcpDevice: "/dev/serial/by-id/usb-thread" }, {}), "ws://127.0.0.1:5580/ws");
  assert.equal(resolveMatterServerUrl("", { configured: false, rcpDevice: "" }, { threadRcpDevice: "/dev/serial/by-id/usb-thread" }), "ws://127.0.0.1:5580/ws");
  assert.equal(resolveMatterServerUrl("", { configured: false, rcpDevice: "" }, {}), "");
});

test("an explicitly configured Matter Server URL always takes precedence", () => {
  assert.equal(resolveMatterServerUrl("ws://matter.example/ws", { rcpDevice: "/dev/serial/by-id/usb-thread" }, {}), "ws://matter.example/ws");
});
