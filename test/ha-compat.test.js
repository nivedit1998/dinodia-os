const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createHub } = require("../src/server");

function mockIntegration() {
  return {
    start() {},
    close() {},
    status() { return { configured: false, connected: false, lastError: null }; },
    async command() {},
    async refresh() { return []; },
    async permitJoin() {},
  };
}

function mockCloudflare() {
  return { start() {}, async stop() {}, status() { return { configured: false, connected: false, running: false, mode: "disabled", publicUrl: "", lastError: null }; } };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function websocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2000);
    socket.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

test("HA compatibility listeners share state and support registry/service operations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-ha-"));
  const hub = createHub({
    config: { nodeEnv: "development", port: 0, haPort: 0, hubAgentPort: 0, haToken: "ha-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  await hub.store.saveArea({ name: "Living Room" }, "living_room");
  await hub.store.saveLabel({ name: "Tenant Device" }, "tenant_device");
  await hub.store.upsertDevice({ id: "lamp", name: "Lamp", protocol: "virtual", areaId: "living_room", state: { power: "OFF" } });
  await hub.store.upsertDevice({
    id: "legacy-a",
    name: "Legacy A",
    protocol: "virtual",
    entities: { linkquality: { stateKey: "linkquality", haEntityId: "sensor.duplicate_linkquality", state: 216 } },
  });
  await hub.store.upsertDevice({
    id: "legacy-b",
    name: "Legacy B",
    protocol: "virtual",
    entities: { linkquality: { stateKey: "linkquality", haEntityId: "sensor.duplicate_linkquality", state: 216, capability: { kind: "sensor", readable: true, observable: true } } },
  });
  const haBase = `http://127.0.0.1:${hub.haServer.address().port}`;
  const localBase = `http://127.0.0.1:${hub.hubAgentServer.address().port}`;
  const headers = { authorization: "Bearer ha-token" };
  const landing = await fetch(`${haBase}/`);
  const landingBody = await landing.text();
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get("content-type"), /text\/html/);
  assert.match(landingBody, /Good to see you|Dinodia OS/);
  assert.doesNotMatch(landingBody, /Home Assistant-compatible API used by Dinodia apps/);
  const states = await request(haBase, "/api/states", { headers });
  assert.equal(states.response.status, 200);
  assert.equal(states.body.some((state) => state.entity_id === "switch.lamp_power"), true);
  assert.equal(states.body.filter((state) => state.entity_id === "sensor.duplicate_linkquality").length, 1);
  const registry = await request(haBase, "/api/config/device_registry/list", { headers });
  assert.equal(registry.body[0].area_id, "living_room");
  const entity = (await request(haBase, "/api/config/entity_registry/list", { headers })).body.find((item) => item.device_id === registry.body[0].id);
  assert.ok(entity);
  const rename = await request(haBase, "/api/config/entity_registry/update", { method: "POST", headers, body: JSON.stringify({ entity_id: entity.entity_id, name: "Lamp Power", new_entity_id: "switch.living_room_lamp" }) });
  assert.equal(rename.response.status, 200);
  const call = await request(haBase, "/api/services/switch/turn_on", { method: "POST", headers, body: JSON.stringify({ entity_id: "switch.living_room_lamp" }) });
  assert.equal(call.response.status, 200);
  assert.equal(hub.store.getDevice("lamp").state.power, "ON");
  const nestedToggle = await request(haBase, "/api/services/homeassistant/toggle?return_response", { method: "POST", headers, body: JSON.stringify({ target: { entity_id: ["switch.living_room_lamp"] } }) });
  assert.equal(nestedToggle.response.status, 200);
  assert.equal(hub.store.getDevice("lamp").state.power, "OFF");
  const unsupported = await request(haBase, "/api/services/sensor/turn_on", { method: "POST", headers, body: JSON.stringify({ entity_id: "switch.living_room_lamp" }) });
  assert.equal(unsupported.response.status, 400);
  const restFlow = await request(haBase, "/api/config/config_entries/flow", { method: "POST", headers, body: JSON.stringify({ handler: "dinodia_remote_manager" }) });
  assert.equal(restFlow.response.status, 200);
  const restFlowResult = await request(haBase, `/api/config/config_entries/flow/${encodeURIComponent(restFlow.body.flow_id)}`, { method: "POST", headers, body: JSON.stringify({ user_input: {} }) });
  assert.equal(restFlowResult.response.status, 200);
  assert.equal(restFlowResult.body.type, "create_entry");
  await hub.store.updateDevice("lamp", { labelIds: ["tenant_device"] });
  const metadataTemplate = await request(haBase, "/api/template", { method: "POST", headers, body: JSON.stringify({ template: `{% set ns = namespace(result=[]) %}\n{% for s in states %}\n  {% set did = device_id(s.entity_id) %}\n  {% set entity_labels = (labels(s.entity_id) | map('label_name') | list) %}\n  {% set device_labels = (labels(did) | map('label_name') | list) if did else [] %}\n  {% set labels_list = ((entity_labels + device_labels) | unique | list) %}\n  {% set item = {\"entity_id\": s.entity_id, \"area_name\": area_name(s.entity_id), \"device_id\": did, \"entity_labels\": entity_labels, \"device_labels\": device_labels, \"labels\": labels_list} %}\n  {% set ns.result = ns.result + [item] %}\n{% endfor %}\n{{ ns.result | tojson }}` }) });
  assert.equal(metadataTemplate.response.status, 200);
  assert.equal(metadataTemplate.body[0].device_labels.includes("Tenant Device"), true);
  const areaDelete = await request(haBase, "/api/config/area_registry/delete", { method: "POST", headers, body: JSON.stringify({ area_id: "living_room" }) });
  assert.equal(areaDelete.response.status, 200);
  assert.equal(areaDelete.body.ok, true);
  assert.equal(hub.store.getDevice("lamp").areaId, null);
  assert.equal(Object.values(hub.store.getDevice("lamp").entities).every((item) => item.areaId === null), true);
  assert.equal((await request(haBase, "/api/config/area_registry/list", { headers })).body.some((item) => item.area_id === "living_room"), false);
  const wrong = await request(localBase, "/api/", { headers: { authorization: "Bearer wrong" } });
  assert.equal(wrong.response.status, 401);
  const options = await request(haBase, "/api/states", { method: "OPTIONS" });
  assert.equal(options.response.status, 204);
  assert.equal(options.response.headers.get("access-control-allow-origin"), null);
  const ws = new WebSocket(`${localBase.replace("http", "ws")}/api/websocket`);
  assert.equal((await websocketMessage(ws)).type, "auth_required");
  ws.send(JSON.stringify({ type: "auth", access_token: "dev-hub-token" }));
  assert.equal((await websocketMessage(ws)).type, "auth_ok");
  ws.send(JSON.stringify({ id: 1, type: "get_states" }));
  const result = await websocketMessage(ws);
  assert.equal(result.success, true);
  assert.equal(result.result.some((state) => state.entity_id === "switch.living_room_lamp"), true);
  ws.send(JSON.stringify({ id: 2, type: "get_services_for_target", target: { entity_id: "switch.living_room_lamp" } }));
  const services = await websocketMessage(ws);
  assert.equal(Array.isArray(services.result), true);
  assert.equal(services.result.includes("switch.toggle"), true);
  ws.send(JSON.stringify({ id: 3, type: "config_entries/flow/init", handler: "dinodia_remote_manager" }));
  const flowStart = await websocketMessage(ws);
  assert.equal(flowStart.result.type, "form");
  ws.send(JSON.stringify({ id: 4, type: "config_entries/flow/configure", flow_id: flowStart.result.flow_id, user_input: {} }));
  const flowDone = await websocketMessage(ws);
  assert.equal(flowDone.result.type, "create_entry");
  assert.equal(hub.store.getConfigEntries().ce_remote_manager.domain, "dinodia_remote_manager");
  ws.close();
  await hub.stop();
});

test("Hub Agent remote-manager inventory, binding, simulation, and scoped cleanup work end to end", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-remote-"));
  const hub = createHub({
    config: { nodeEnv: "development", port: 0, haPort: 0, hubAgentPort: 0, haToken: "ha-token", dataDir: directory, dataFile: path.join(directory, "dinodia.json"), backupDir: path.join(directory, "backups"), staticDir: path.join(__dirname, "..", "public"), otbrUrl: "" },
    mqttBridge: mockIntegration(),
    matterBridge: mockIntegration(),
    cloudflareTunnel: mockCloudflare(),
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
  });
  await hub.start();
  await hub.store.upsertDevice({ id: "target", name: "Target", protocol: "virtual", state: { power: "OFF" } });
  await hub.store.upsertDevice({ id: "remote", name: "Remote", protocol: "zigbee", metadata: { ieee_address: "00:12:4b:00:24:ab:cd:12", manufacturer: "Example", model: "Remote" }, state: { action: "idle" } });
  const localBase = `http://127.0.0.1:${hub.hubAgentServer.address().port}`;
  const headers = { authorization: "Bearer dev-hub-token" };
  const inventory = await request(localBase, "/api/services/dinodia_remote_manager/list_trigger_device_dashboard?return_response", { method: "POST", headers, body: "{}" });
  const row = inventory.body.service_response.trigger_devices[0];
  assert.equal(row.device_id, hub.model.deviceRegistry().find((device) => device.name === "Remote").id);
  assert.equal(row.resolution_state, "unbound");
  const targetEntity = hub.model.entityRegistry().find((entity) => entity.device_id === hub.model.deviceRegistry().find((device) => device.name === "Target").id).entity_id;
  const bind = await request(localBase, "/api/services/dinodia_remote_manager/set_trigger_target?return_response", { method: "POST", headers, body: JSON.stringify({ remote_device_id: row.device_id, target_entity_id: targetEntity, owner_user_id: "42" }) });
  assert.equal(bind.response.status, 200);
  assert.equal(bind.body.service_response.binding.remoteDeviceId, row.device_id);
  const simulated = await request(localBase, "/api/services/dinodia_remote_manager/simulate_remote_event?return_response", { method: "POST", headers, body: JSON.stringify({ deviceId: row.device_id, action: "button_short" }) });
  assert.equal(simulated.response.status, 200);
  assert.equal(hub.store.getDevice("target").state.power, "ON");
  const cleanup = await request(localBase, "/api/services/dinodia_remote_manager/remove_trigger_bindings_for_devices?return_response", { method: "POST", headers, body: JSON.stringify({ owner_user_id: "42", remote_device_ids: [row.device_id] }) });
  assert.equal(cleanup.body.service_response.removed.bindings, 1);
  assert.equal(hub.store.listRemoteBindings().length, 0);
  await hub.stop();
});
