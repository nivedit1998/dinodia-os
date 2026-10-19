const test = require("node:test");
const assert = require("node:assert/strict");
const { ThreadService } = require("../src/threadService");

test("automatic Thread startup never creates a dataset when no active dataset exists", async () => {
  const service = new ThreadService();
  const commands = [];
  service.otCtl = async (args) => {
    commands.push(args.join(" "));
    throw new Error("Error 23: NotFound");
  };

  await assert.rejects(service.ensureNetwork(), (error) => error.code === "thread_dataset_missing");
  assert.deepEqual(commands, ["dataset active -x"]);
  assert.equal(commands.some((command) => command.includes("dataset init")), false);
});

test("explicit Thread setup initializes only a positively missing dataset", async () => {
  const service = new ThreadService();
  const commands = [];
  service.otCtl = async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command === "dataset active -x") throw new Error("Error 23: NotFound");
    if (command === "state") return { stdout: "leader" };
    return { stdout: "Done" };
  };

  assert.equal(await service.ensureNetwork({ initializeDataset: true }), "leader");
  assert.deepEqual(commands, ["dataset active -x", "dataset init new", "dataset commit active", "ifconfig up", "thread start", "state"]);
});

test("a transient Thread RCP error never authorizes creation of replacement dataset credentials", async () => {
  const service = new ThreadService();
  const commands = [];
  service.otCtl = async (args) => {
    commands.push(args.join(" "));
    throw new Error("serial transport timed out");
  };

  await assert.rejects(service.ensureNetwork({ initializeDataset: true, attempts: 1 }), /serial transport timed out/);
  assert.deepEqual(commands, ["dataset active -x"]);
});

test("Thread Compose operations use the same stable installation project as Zigbee", () => {
  const service = new ThreadService({ composeFile: "/opt/dinodia-os/docker-compose.yml", envFile: "/opt/dinodia-os/.env" });
  assert.deepEqual(service.args("--profile", "thread", "up", "-d", "otbr"), [
    "compose", "-p", "dinodia-os", "-f", "/opt/dinodia-os/docker-compose.yml", "--env-file", "/opt/dinodia-os/.env",
    "--profile", "thread", "up", "-d", "otbr",
  ]);
});

test("Thread/Matter startup fails closed before Compose when LAN allocations overlap", async () => {
  const service = new ThreadService({ networkGuard: async () => { throw Object.assign(new Error("router overlap"), { code: "docker_network_lan_overlap" }); } });
  service.available = async () => true;
  let composeCalls = 0;
  service.compose = async () => { composeCalls += 1; };
  const result = await service.start({ rcpDevice: "/dev/serial/by-id/verified-thread-rcp" });
  assert.equal(result.ok, false);
  assert.match(result.error, /router overlap/);
  assert.equal(composeCalls, 0);
});
