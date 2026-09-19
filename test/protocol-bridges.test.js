const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { Store } = require("../src/store");
const { MqttBridge } = require("../src/mqttBridge");
const { MatterBridge } = require("../src/matterBridge");

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for condition"));
      setTimeout(check, 10);
    };
    check();
  });
}

test("MQTT bridge ingests Zigbee2MQTT state messages", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const changed = [];
  const bridge = new MqttBridge({ url: "", store, onDeviceChanged: async (device) => changed.push(device) });
  bridge.pairingSession.start(new Date(Date.now() + 60000).toISOString(), 60, []);
  await bridge.handleMessage("zigbee2mqtt/kitchen-light", Buffer.from('{"state":"ON","brightness":80}'));
  assert.equal(store.getDevice("kitchen-light").state.brightness, 80);
  assert.equal(changed.length, 1);
});

test("MQTT bridge imports Zigbee exposes as child entities", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-devices-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const bridge = new MqttBridge({ url: "", store });
  bridge.pairingSession.start(new Date(Date.now() + 60000).toISOString(), 60, []);
  await bridge.handleMessage("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([{
    friendly_name: "Coordinator",
    ieee_address: "0x9035eafffed2bcb9",
    type: "Coordinator",
  }, {
    friendly_name: "kitchen-light",
    ieee_address: "0x123",
    definition: { exposes: [{ type: "light", features: [{ type: "binary", name: "state", property: "state", access: 7 }, { type: "numeric", name: "brightness", property: "brightness", access: 7 }] }] },
  }])));
  const device = store.getDevice("kitchen-light");
  assert.equal(device.protocol, "zigbee");
  assert.equal(device.setup.status, "needs_setup");
  assert.equal(Object.keys(device.presentation.surfaces).length, 0);
  assert.equal(device.entities["kitchen-light:brightness"].stateKey, "brightness");
  assert.deepEqual(store.listDevices().map((item) => item.name), ["kitchen-light"]);
});

test("MQTT bridge gives code-only Zigbee devices a friendly manufacturer/model name", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-name-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const bridge = new MqttBridge({ url: "", store });
  bridge.pairingSession.start(new Date(Date.now() + 60000).toISOString(), 60, []);
  await bridge.handleMessage("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([{ friendly_name: "0xf044d3fffe1242f6", ieee_address: "0xf044d3fffe1242f6", definition: { vendor: "SONOFF", model: "TRVZB", exposes: [] } }])));
  assert.equal(store.listDevices()[0].name, "SONOFF TRVZB");
});

test("MQTT rediscovery never replaces a ready device's user-assigned name", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-name-preserve-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const bridge = new MqttBridge({ url: "", store });
  await store.upsertDevice({ id: "zigbee:f044d3fffe1242f6", name: "Radiator upstairs", protocol: "zigbee", setup: { status: "ready" }, metadata: { ieee_address: "0xf044d3fffe1242f6" } });
  await bridge.handleMessage("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([{ friendly_name: "0xf044d3fffe1242f6", ieee_address: "0xf044d3fffe1242f6", definition: { vendor: "SONOFF", model: "TRVZB", exposes: [] } }])));
  assert.equal(store.getDevice("zigbee:f044d3fffe1242f6").name, "Radiator upstairs");
});

test("MQTT bridge migrates an early friendly-name state record to stable IEEE identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-migration-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const bridge = new MqttBridge({ url: "", store });
  bridge.pairingSession.start(new Date(Date.now() + 60000).toISOString(), 60, []);
  await bridge.handleMessage("zigbee2mqtt/kitchen-light", Buffer.from('{"state":"ON"}'));
  await bridge.handleMessage("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([{ friendly_name: "kitchen-light", ieee_address: "0x123", definition: { exposes: [{ type: "switch", name: "state", access: 7 }] } }] )));
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listDevices()[0].id, "zigbee:123");
  assert.equal(store.getDevice("kitchen-light").id, "zigbee:123");
});

test("MQTT bridge never auto-pairs unsolicited inventory or state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-no-autopair-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const bridge = new MqttBridge({ url: "", store });
  await bridge.handleMessage("zigbee2mqtt/unknown-light", Buffer.from('{"state":"ON"}'));
  await bridge.handleMessage("zigbee2mqtt/unknown-light/availability", Buffer.from("online"));
  await bridge.handleMessage("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([{ friendly_name: "unknown-light", ieee_address: "0x999", definition: { exposes: [] } }])));
  assert.equal(store.listDevices().length, 0);
});

test("MQTT device removal addresses Zigbee2MQTT by friendly name and supports force removal", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-mqtt-remove-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "zigbee:123", name: "Radiator upstairs", protocol: "zigbee", metadata: { friendly_name: "0x123", ieee_address: "0x123" } });
  const published = [];
  const bridge = new MqttBridge({ url: "", store });
  bridge.client = {
    publish: (topic, payload, options, callback) => {
      published.push({ topic, payload: JSON.parse(payload), options });
      callback();
      setImmediate(() => {
        bridge.handleMessage("zigbee2mqtt/bridge/response/device/remove", Buffer.from(JSON.stringify({ status: "ok", data: { id: "0x123" }, transaction: published[0].payload.transaction })));
      });
    },
  };
  bridge.connected = true;
  await bridge.remove("zigbee:123", true);
  assert.equal(published[0].topic, "zigbee2mqtt/bridge/request/device/remove");
  assert.deepEqual(published[0].payload, { id: "0x123", clear_cache: true, transaction: published[0].payload.transaction, force: true });
  assert.equal(published[0].options.qos, 0);
  assert.equal(published[0].options.retain, false);
});

test("Matter bridge starts listening, ingests nodes/events, and sends commands", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-matter-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.command === "start_listening") {
        socket.send(JSON.stringify({ message_id: message.message_id, result: [{ node_id: 7, name: "Matter lamp", available: true, state: { power: "OFF" } }] }));
        setTimeout(() => socket.send(JSON.stringify({ event: "attribute_updated", data: [7, "1/6/0", true] })), 20);
      } else {
        socket.send(JSON.stringify({ message_id: message.message_id, result: { ok: true, command: message.command } }));
      }
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const changed = [];
  const bridge = new MatterBridge({ url: `ws://127.0.0.1:${address.port}`, store, onDeviceChanged: async (device) => changed.push(device) });
  bridge.allowNewNodes = true;
  bridge.start();
  await waitFor(() => Boolean(store.getDevice("matter-7")));
  await waitFor(() => changed.length >= 2);
  assert.equal(store.getDevice("matter-7").setup.status, "needs_setup");
  assert.equal(Object.keys(store.getDevice("matter-7").presentation.surfaces).length, 0);
  assert.equal(store.getDevice("matter-7").state.attribute_1_6_0, true);
  const result = await bridge.command("matter-7", { endpoint_id: 1, cluster_id: 6, command_name: "toggle", payload: {} });
  assert.equal(result.ok, true);
  bridge.close();
  await new Promise((resolve) => server.close(resolve));
});

test("Matter bridge migrates legacy node IDs to fabric/node identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-matter-migration-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "matter-7", protocol: "matter", name: "Legacy Matter", metadata: { node_id: "7" }, state: { power: "OFF" } });
  const bridge = new MatterBridge({ url: "", store });
  await bridge.ingestNodes([{ node_id: 7, fabric_id: "fabric-a", name: "Legacy Matter", state: { power: "OFF" } }]);
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listDevices()[0].id, "matter:fabric-a:7");
  assert.equal(store.getDevice("matter-7").id, "matter:fabric-a:7");
});

test("Matter device removal uses the Matter Server remove_node command", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-matter-remove-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  await store.upsertDevice({ id: "matter:fabric-a:7", protocol: "matter", name: "Matter lamp", protocolIdentity: { nodeId: "7", fabricId: "fabric-a" } });
  const bridge = new MatterBridge({ url: "", store });
  const requests = [];
  bridge.request = async (command, args) => { requests.push({ command, args }); return { ok: true }; };
  const result = await bridge.remove("matter:fabric-a:7");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(requests, [{ command: "remove_node", args: { node_id: 7 } }]);
});
