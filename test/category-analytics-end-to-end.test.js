const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { Store } = require('../src/store'); const { MqttBridge } = require('../src/mqttBridge');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { ObservationReconciler } = require('../src/observation/reconciler');
test('unknown-vendor light: genuine MQTT -> exact source -> epoch usage -> durable outbox; retained and cached siblings rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-end-to-end-'));
  try {
    let now = Date.parse('2026-10-23T10:00:00Z');
    const raw = structuredClone(require('./fixtures/zigbee/dimmable-light.json'));
    raw.ieee_address = '0x00124b00aabbccdd';
    raw.definition.vendor = 'New manufacturer'; raw.definition.model = 'New light';
    raw.endpoints = { 1: { clusters: { input: ['genOnOff'] }, configured_reportings: [] } };
    const store = new Store(path.join(dir, 'store.json')); store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
    await store.saveArea({ name: 'Synthetic room' }, 'area'); await store.savePlatform({ homeId: 'test' });
    const device = await store.upsertDevice({ ...normalizeZigbeeDevice(raw), areaId: 'area', setup: { status: 'ready', assignmentMode: 'device_inherited_v1' } },
      { devicePolicy: { managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'LIGHT', lifecycle: 'INSTALLED', analyticsInterval: {
        id: 'b9c4a040-830a-4a77-b605-b906dbed0361', revision: 1, sourceGeneration: 1, validFrom: new Date(now).toISOString(), writerEnabled: true, genericCollectionEnabled: true } } });
    const configPath = path.join(dir, 'configuration.yaml');
    fs.writeFileSync(configPath, `advanced:\n  last_seen: ISO_8601\ndevices:\n  '${raw.ieee_address}':\n    friendly_name: ${raw.friendly_name}\n    optimistic: false\n    filtered_cache: [state]\n`);
    const bridge = new MqttBridge({ url: '', store, observationConfigPath: configPath, clock: () => now, logger: { log() {}, warn() {}, error() {} } });
    const reconciler = new ObservationReconciler({ store, resolveDeviceId: () => device.id, clock: () => now, publishBridgeRequest: async () => {} });
    await reconciler.onInventory([raw]); bridge.observationPolicy = reconciler;
    const send = (state, retain = false) => bridge.handleMessage(`zigbee2mqtt/${raw.friendly_name}`, Buffer.from(JSON.stringify(state)), { retain });
    await send({ state: 'OFF', brightness: 128, last_seen: new Date(now).toISOString() });
    assert.equal(Object.values(store.getDevice(device.id).entities).find(entity => entity.stateKey === 'state').sourceObservedAt, null,
      'a configuration file alone cannot prove the generic publisher runtime options');
    await bridge.handleMessage('zigbee2mqtt/bridge/info', Buffer.from(JSON.stringify({ restart_required: false, config: {
      advanced: { last_seen: 'ISO_8601' }, devices: { [raw.ieee_address]: { friendly_name: raw.friendly_name, optimistic: false, filtered_cache: ['state'] } } } })), { retain: true });
    await require('./helpers/publisher-ready-fixture').readyPublisher(bridge);
    await send({ state: 'OFF', brightness: 128, last_seen: new Date(now).toISOString() });
    now += 60000; await store.advanceSyncUsage(now);
    const prior = Object.values(store.getDevice(device.id).entities).find(entity => entity.stateKey === 'state').sourceObservedAt;
    await send({ state: 'OFF', last_seen: new Date(now).toISOString() }, true);
    assert.equal(Object.values(store.getDevice(device.id).entities).find(entity => entity.stateKey === 'state').sourceObservedAt, prior);
    await send({ brightness: 128, battery: 80, last_seen: new Date(now).toISOString() });
    assert.equal(Object.values(store.getDevice(device.id).entities).find(entity => entity.stateKey === 'state').sourceObservedAt, prior);
    now += 1000; await send({ state: 'OFF', last_seen: new Date(now).toISOString() });
    assert.notEqual(Object.values(store.getDevice(device.id).entities).find(entity => entity.stateKey === 'state').sourceObservedAt, prior);
    const events = store.getSyncOutbox().events.filter(event => event.type === 'usage.bucket');
    assert.ok(events.length); assert.ok(events.every(event => event.payload.bindingRevision === 1 && event.payload.analyticsPolicyVersion === 2));
    assert.equal(events.at(-1).payload.onSeconds, 0); assert.ok(events.at(-1).payload.offSeconds >= 60);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
