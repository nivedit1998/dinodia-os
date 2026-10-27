const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMatterNode } = require("../src/integrations/matter/nodeNormalizer");
const { commandForBinding } = require("../src/integrations/matter/commandAdapter");
const { analyticsReadiness } = require("../src/analytics/readiness");
const { MatterBridge } = require('../src/matterBridge');
const { Store } = require('../src/store');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test("Matter endpoint and cluster data creates typed controls", () => {
  const device = normalizeMatterNode({ node_id: 17, fabric_id: "fabric-a", name: "Matter lamp", endpoints: {
    1: { device_types: [{ id: 257 }], clusters: { 6: { attributes: { 0: true } }, 8: { attributes: { 0: 128 } } } },
  } });
  assert.equal(device.id, "matter:fabric-a:17");
  const controls = Object.values(device.entities);
  const onoff = controls.find((entity) => entity.binding.clusterId === "6");
  const level = controls.find((entity) => entity.binding.clusterId === "8");
  assert.equal(onoff.domain, "switch");
  assert.ok(onoff.capability.services.includes("switch.toggle"));
  assert.equal(level.domain, "number");
  assert.deepEqual(commandForBinding(onoff, "switch.turn_on"), { endpoint_id: 1, cluster_id: 6, attribute_id: 0, command_name: "On", operation: "turn_on", payload: {} });
  assert.deepEqual(commandForBinding(level, "number.set_value", { value: 200 }), { endpoint_id: 1, cluster_id: 8, attribute_id: 0, command_name: "MoveToLevel", operation: "set_value", payload: { level: 200, transitionTime: 0 } });
});

test('Matter Server flat attribute paths produce exact endpoint cover command evidence', () => {
  const device = normalizeMatterNode({ node_id: 44, fabric_id: 'f', endpoints: {}, attributes: {
    '1/258/8': 30, '1/258/65529': [0, 1], '2/258/8': 70, '2/258/65529': [2], '1/513/0': 2150,
  } });
  const entities = Object.values(device.entities);
  const cover = endpoint => entities.find(e => e.binding?.endpointId === endpoint && e.binding?.attributeId === '8');
  assert.deepEqual(cover('1').capability.services, ['cover.open_cover', 'cover.close_cover']);
  assert.deepEqual(cover('2').capability.services, ['cover.stop_cover']);
  assert.equal(commandForBinding(cover('1'), 'cover.open_cover', {}, device).endpoint_id, 1);
  assert.throws(() => commandForBinding(cover('2'), 'cover.open_cover', {}, device));
  assert.equal(entities.find(e => e.binding?.clusterId === '513').state, 21.5, 'Matter temperatures use hundredths of a degree');
  const oversized = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`1/9/${i}`, i]));
  oversized['1/258/8'] = 30;
  assert.equal(Object.keys(normalizeMatterNode({ node_id: 45, attributes: oversized }).entities).length, 0);
});

test("Matter nodes without endpoint data still remain compatible and observable", () => {
  const device = normalizeMatterNode({ node_id: 7, state: { power: "OFF", temperature: 21 } });
  assert.equal(device.legacyIds[0], "matter-7");
  assert.ok(Object.values(device.entities).some((entity) => entity.domain === "switch"));
  assert.ok(Object.values(device.entities).some((entity) => entity.domain === "sensor"));
});

test("Matter devices use vendor/product names instead of node IDs by default", () => {
  const device = normalizeMatterNode({ node_id: 17, vendor_name: "Eve", product_name: "Thermo" });
  assert.equal(device.name, "Eve Thermo");
});

test("Matter standard cover and fan clusters expose only typed controls", () => {
  const device = normalizeMatterNode({ node_id: 18, fabric_id: "fabric-a", name: "Matter cover and fan", endpoints: {
    1: { device_types: [{ id: 514 }], clusters: { 258: { attributes: { 8: 50, 65529: [0, 1, 2, 5] } } } },
    2: { device_types: [{ id: 19 }], clusters: { 514: { attributes: { 0: "medium", 2: 75 } } } },
  } });
  const cover = Object.values(device.entities).find((entity) => entity.domain === "cover");
  const fan = Object.values(device.entities).find((entity) => entity.domain === "fan" && entity.binding.attributeId === "2");
  assert.ok(cover.capability.services.includes("cover.open_cover"));
  assert.ok(cover.capability.services.includes("cover.set_cover_position"));
  assert.ok(fan.capability.services.includes("fan.set_percentage"));
  assert.deepEqual(commandForBinding(cover, "cover.open_cover", {}, device), { endpoint_id: 1, cluster_id: 258, attribute_id: 8, command_name: "UpOrOpen", operation: "open_cover", payload: {} });
  assert.deepEqual(commandForBinding(fan, "fan.set_percentage", { percentage: 60 }), { endpoint_id: 2, cluster_id: 514, attribute_id: 2, attribute_value:60, operation: "set_percentage" });
});

test('Matter cover commands require the exact endpoint accepted-command list, including persisted bindings', () => {
  const make = list => normalizeMatterNode({ node_id: 30, fabric_id: 'f', endpoints: {
    1: { clusters: { 258: { attributes: { 8: 40, ...(list === undefined ? {} : { 65529: list }) } } } },
  } });
  const cover = d => Object.values(d.entities).find(e => e.binding.attributeId === '8');
  const noProof = cover(make(undefined));
  assert.equal(noProof.capability.services.includes('cover.open_cover'), false);
  const verifiedDevice = make([0, 2]);
  const verified = cover(verifiedDevice);
  assert.deepEqual(verified.capability.services, ['cover.open_cover', 'cover.stop_cover']);
  assert.equal(commandForBinding(verified, 'cover.open_cover', {}, verifiedDevice).command_name, 'UpOrOpen');
  assert.throws(() => commandForBinding(verified, 'cover.close_cover', {}, verifiedDevice));
  const persisted = structuredClone(verified);
  delete persisted.attributes.acceptedCommandIds;
  assert.throws(() => commandForBinding(persisted, 'cover.open_cover', {}, verifiedDevice));
  assert.equal(cover(make(['0', 2])).capability.services.length, 0);
  const changed = structuredClone(verifiedDevice);
  Object.values(changed.entities).find(e => e.binding.attributeId === '65529').state = [2];
  assert.throws(() => commandForBinding(verified, 'cover.open_cover', {}, changed));
  const corrupted = structuredClone(verified);
  corrupted.capability.bindings.find(b => b.serviceId === 'cover.open_cover').operation = 'stop_cover';
  assert.throws(() => commandForBinding(corrupted, 'cover.open_cover', {}, verifiedDevice));
  assert.ok(cover(make({ value: [0] })).capability.services.includes('cover.open_cover'));
  const positionDevice = make([5]);
  const position = cover(positionDevice);
  assert.deepEqual(commandForBinding(position, 'cover.set_cover_position', {position: 75}, positionDevice).payload, {liftPercent100thsValue: 2500});
  assert.equal(position.state, 60, 'Matter closed percentage is inverted to opening percentage');
  for (const invalid of [null, '', '50', -1, 101, NaN])
    assert.throws(() => commandForBinding(position, 'cover.set_cover_position', { position: invalid }, positionDevice));
  const missing = structuredClone(position);
  delete missing.capability.bindings[0].parameter;
  assert.throws(() => commandForBinding(missing, 'cover.set_cover_position', { position: 50 }, positionDevice));
});

test("Matter covering actual position and operational status are not conflated", () => {
  const device = normalizeMatterNode({ node_id: 29, fabric_id: "fabric-a", endpoints: {
    1: { clusters: { 258: { attributes: { 8: { value: 30, writable: false }, 10: 1, 11: 5000, 14: 3000 } } } },
  } });
  const byAttribute = Object.fromEntries(Object.values(device.entities).map(entity => [entity.binding.attributeId, entity]));
  assert.equal(byAttribute["8"].capability.semanticRole, "opening_percentage");
  assert.equal(byAttribute["8"].capability.writable, false);
  // Hundredths require a dedicated conversion before percentage presentation.
  assert.notEqual(byAttribute["14"].capability.semanticRole, "opening_percentage");
  assert.notEqual(byAttribute["10"].capability.semanticRole, "opening_percentage");
  assert.notEqual(byAttribute["11"].capability.semanticRole, "opening_percentage");
  const readiness = analyticsReadiness({}, device, { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null,
    lifecycle: 'INSTALLED', analyticsCategory: 'BLIND' });
  assert.equal(readiness.state, 'limited');
  assert.equal(readiness.reason, 'compatible_analytics_writer_unavailable');
  assert.equal(readiness.signal, 'opening_percentage');
  assert.equal(readiness.candidates.length, 1);
});

test('Matter bridge updates the authoritative accepted list before a subsequent dispatch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-matter-command-proof-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const bridge = new MatterBridge({ url: '', store });
    await bridge.ingestNodes([{ node_id: 31, fabric_id: 'f', endpoints: {
      1: { clusters: { 258: { attributes: { 8: 30, 65529: [0, 1] } } } },
    } }], { allowNew: true });
    let device = store.getDevice('matter:f:31');
    let position = Object.values(device.entities).find(e => e.binding?.attributeId === '8');
    assert.equal(commandForBinding(position, 'cover.open_cover', {}, device).command_name, 'UpOrOpen');
    const persist = store.persist.bind(store);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const persistenceStarted = new Promise(resolve => { entered = resolve; });
    store.persist = async () => { entered(); await held; return persist(); };
    const change = bridge.handleMessage(JSON.stringify({ event: 'attribute_updated', data: [31, '1/258/65529', [1]] }));
    await persistenceStarted;
    // The in-memory change must be coherent even while persistence is pending.
    const during = store.getDevice('matter:f:31');
    const duringPosition = Object.values(during.entities).find(e => e.binding?.attributeId === '8');
    assert.equal(duringPosition.capability.services.includes('cover.open_cover'), false);
    assert.throws(() => commandForBinding(duringPosition, 'cover.open_cover', {}, during));
    release();
    await change;
    store.persist = persist;
    device = store.getDevice('matter:f:31');
    position = Object.values(device.entities).find(e => e.binding?.attributeId === '8');
    assert.equal(position.capability.services.includes('cover.open_cover'), false);
    assert.throws(() => commandForBinding(position, 'cover.open_cover', {}, device));
    assert.equal(commandForBinding(position, 'cover.close_cover', {}, device).command_name, 'DownOrClose');
    const restarted = new Store(path.join(directory, 'dinodia.json')).getDevice('matter:f:31');
    const restartedPosition = Object.values(restarted.entities).find(e => e.binding?.attributeId === '8');
    assert.equal(restartedPosition.capability.services.includes('cover.open_cover'), false);
    assert.throws(() => commandForBinding(restartedPosition, 'cover.open_cover', {}, restarted));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed Matter command-list persistence does not discard a queued unrelated Store mutation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-matter-command-failure-'));
  try {
    const file = path.join(directory, 'dinodia.json');
    const store = new Store(file);
    const bridge = new MatterBridge({ url: '', store });
    await bridge.ingestNodes([{ node_id: 32, fabric_id: 'f', endpoints: {
      1: { clusters: { 258: { attributes: { 8: 30, 65529: [0, 1] } } } },
    } }], { allowNew: true });
    const persist = store.persist.bind(store);
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let first = true;
    store.persist = async () => { if (first) { first = false; entered(); await held; throw new Error('synthetic disk failure'); } return persist(); };
    const change = bridge.handleMessage(JSON.stringify({ event: 'attribute_updated', data: [32, '1/258/65529', [1]] }));
    await started;
    const area = store.saveArea({ name: 'Unrelated' }, 'unrelated');
    release();
    await assert.rejects(change, /synthetic disk failure/);
    await area;
    store.persist = persist;
    const restarted = new Store(file);
    assert.ok(restarted.listAreas().some(item => item.id === 'unrelated'));
    const restored = restarted.getDevice('matter:f:32');
    assert.equal(commandForBinding(Object.values(restored.entities).find(e => e.binding?.attributeId === '8'), 'cover.open_cover', {}, restored).command_name, 'UpOrOpen');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Matter cover dispatch is fenced until current-connection inventory is persisted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-matter-session-proof-'));
  try {
    const store = new Store(path.join(directory, 'dinodia.json'));
    const bridge = new MatterBridge({ url: '', store });
    const node = { node_id: 33, fabric_id: 'f', endpoints: { 1: { clusters: { 258: { attributes: { 8: 30, 65529: [0] } } } } } };
    await bridge.ingestNodes([node], { allowNew: true });
    bridge.connected = true;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    bridge.request = async command => { if (command === 'start_listening') { await held; return [node]; } return { ok: true }; };
    const command = { endpoint_id: 1, cluster_id: 258, command_name: 'UpOrOpen', payload: {} };
    const refresh = bridge.refresh();
    await assert.rejects(bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), /current verified/);
    release();
    await refresh;
    await assert.rejects(bridge.command('matter:f:33', command), /current verified/);
    await assert.rejects(bridge.command('matter:f:33', { command: 'device_command', args: command }), /verified control binding/);
    await assert.rejects(bridge.command('matter:f:33', {...command,payload:undefined}, {verifiedCoverBinding:true}), /payload/);
    assert.deepEqual(await bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), { ok: true });
    const persist = store.persist.bind(store);
    let releaseOld, enterOld;
    const oldHeld = new Promise(resolve => { releaseOld = resolve; });
    const oldStarted = new Promise(resolve => { enterOld = resolve; });
    store.persist = async () => { enterOld(); await oldHeld; return persist(); };
    const oldEvent = bridge.handleMessage(JSON.stringify({ event: 'attribute_updated', data: [33, '1/258/65529', [0]] }));
    await oldStarted;
    bridge.close();
    bridge.connected = true;
    releaseOld();
    await oldEvent;
    store.persist = persist;
    await assert.rejects(bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), /current verified/);
    await bridge.refresh();
    assert.deepEqual(await bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), { ok: true });
    let completeOld;
    const olderResponse = new Promise(resolve => { completeOld = resolve; });
    let refreshCount = 0;
    const newerNode = structuredClone(node);
    newerNode.endpoints[1].clusters[258].attributes[65529] = [];
    bridge.request = async name => name === 'start_listening' ? (++refreshCount === 1 ? olderResponse : [newerNode]) : { ok: true };
    const olderRefresh = bridge.refresh();
    await bridge.refresh();
    completeOld([node]);
    await olderRefresh;
    await assert.rejects(bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), /current verified/);
    bridge.request = async name => name === 'start_listening' ? [node] : { ok: true };
    await bridge.refresh();
    assert.deepEqual(await bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), { ok: true });
    await bridge.handleMessage(JSON.stringify({ event: 'node_updated', data: { node: { node_id: 99, fabric_id: 'f' } } }));
    assert.deepEqual(await bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), { ok: true });
    await bridge.handleMessage(JSON.stringify({ event: 'node_updated', data: { node: { node_id: 33, fabric_id: 'f' } } }));
    await assert.rejects(bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), /current verified/);
    await bridge.handleMessage(JSON.stringify({ event: 'node_updated', data: { node } }));
    assert.deepEqual(await bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), { ok: true });
    let cachedReads = 0;
    bridge.request = async (name, args) => {
      if (name === 'get_node') { cachedReads++; assert.equal(args.node_id, 33); return node; }
      if (name === 'start_listening') return [node];
      return {ok:true};
    };
    await bridge.handleMessage(JSON.stringify({ event: 'node_updated', data: { node_id: 33, endpoints: {2:{clusters:{6:{attributes:{0:true}}}}} } }));
    assert.equal(cachedReads, 1, 'partial updates reconcile once from controller cache');
    assert.deepEqual(await bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), { ok: true });
    await bridge.handleMessage(JSON.stringify({ event: 'attribute_updated', data: [33, '1/258/65529', []] }));
    await assert.rejects(bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), /current verified/);
    bridge.close();
    bridge.connected = true;
    await assert.rejects(bridge.command('matter:f:33', command, { verifiedCoverBinding: true }), /current verified/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
