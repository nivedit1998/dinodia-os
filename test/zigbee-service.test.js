const test = require("node:test");
const assert = require("node:assert/strict");
const { ZigbeeService } = require("../src/zigbeeService");

test("Zigbee service manager does not shell out to an unavailable runtime", async () => {
  const service = new ZigbeeService({ composeFile: "/tmp/docker-compose.yml", dockerBinary: "dinodia-command-that-does-not-exist" });
  assert.equal((await service.status()).available, false);
  assert.deepEqual(await service.restart(), { ok: false, skipped: true, reason: "docker_compose_unavailable" });
  assert.deepEqual(await service.remove(), { ok: false, skipped: true, reason: "docker_compose_unavailable" });
});
