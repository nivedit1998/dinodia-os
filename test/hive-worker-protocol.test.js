const test = require("node:test");
const assert = require("node:assert/strict");
const { request, parseLine, validateResponse, safeError, OPERATIONS } = require("../src/integrations/hive/workerProtocol");

test("Hive worker protocol is allow-listed and bounded", () => {
  const message = request("devices.poll", { reason: "test" });
  assert.equal(message.protocolVersion, 1);
  assert.ok(OPERATIONS.has(message.operation));
  assert.deepEqual(parseLine(JSON.stringify(message)), message);
  assert.deepEqual(validateResponse({ protocolVersion: 1, id: message.id, ok: true, payload: {} }).payload, {});
  assert.throws(() => request("eval", {}), /Unsupported/);
  assert.throws(() => parseLine(JSON.stringify({ protocolVersion: 2, id: "x" })), /Invalid/);
  assert.equal(safeError(new Error("password=super-secret"), "fallback").message.includes("super-secret"), false);
});
