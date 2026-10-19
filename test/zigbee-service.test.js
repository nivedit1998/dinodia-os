const test = require("node:test");
const assert = require("node:assert/strict");
const { ZigbeeService } = require("../src/zigbeeService");

test("Zigbee service manager does not shell out to an unavailable runtime", async () => {
  const service = new ZigbeeService({ composeFile: "/tmp/docker-compose.yml", dockerBinary: "dinodia-command-that-does-not-exist" });
  assert.equal((await service.status()).available, false);
  assert.deepEqual(await service.restart(), { ok: false, skipped: true, reason: "docker_compose_unavailable" });
  assert.deepEqual(await service.remove(), { ok: false, skipped: true, reason: "docker_compose_unavailable" });
});

test("Zigbee Compose operations stay bound to the stable installation project", () => {
  const service = new ZigbeeService({ composeFile: "/opt/dinodia-os/docker-compose.yml", envFile: "/opt/dinodia-os/.env" });
  assert.deepEqual(service.args("--profile", "zigbee", "up", "-d", "zigbee2mqtt"), [
    "compose", "-p", "dinodia-os", "-f", "/opt/dinodia-os/docker-compose.yml", "--env-file", "/opt/dinodia-os/.env",
    "--profile", "zigbee", "up", "-d", "zigbee2mqtt",
  ]);
});

test("Zigbee startup fails closed before Compose when LAN allocations overlap", async () => {
  const service = new ZigbeeService({ networkGuard: async () => { throw Object.assign(new Error("router overlap"), { code: "docker_network_lan_overlap" }); } });
  service.available = async () => true;
  let composeCalls = 0;
  service.compose = async () => { composeCalls += 1; };
  const result = await service.restart();
  assert.equal(result.ok, false);
  assert.match(result.error, /router overlap/);
  assert.equal(composeCalls, 0);
});
