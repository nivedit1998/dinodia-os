'use strict';
// Synthetic transport only. Exercises the real bridge/reconciler/Store; no broker or radio.
const fs = require('node:fs');
const path = require('node:path');
const { MqttBridge } = require('../../src/mqttBridge');
const { ObservationReconciler } = require('../../src/observation/reconciler');
const { normalizeZigbeeDevice } = require('../../src/integrations/zigbee/exposeNormalizer');

async function checkedStateFixture({ store, directory, generation = 3, now = Date.now(), onDeviceChanged,
  registryDeviceId, areaId = 'fixture-area', controlId }) {
  let clock = now - 1500000;
  const raw = { ieee_address: '0x00124b00aabbccdd', friendly_name: 'synthetic-checked-light', type: 'Router', supported: true,
    power_source: 'Mains (single phase)', endpoints: { 1: { clusters: { input: ['genOnOff'] }, configured_reportings: [] } },
    definition: { vendor: 'Previously unseen', model: 'synthetic-only', exposes: [{ type: 'light', endpoint: 1,
      features: [{ type: 'binary', property: 'state', name: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }] }] } };
  const device = { ...normalizeZigbeeDevice(raw), areaId, setup: { status: 'ready' } };
  if (registryDeviceId) {
    const originalId = device.id; device.id = registryDeviceId;
    device.entities = Object.fromEntries(Object.values(device.entities).map(entity => {
      const id = entity.id.replace(originalId, registryDeviceId);
      return [id, { ...entity, id, sourceId: id, deviceId: registryDeviceId,
        capability: { ...entity.capability, ...(controlId ? { controlId } : {}) } }];
    }));
  }
  store.setSyncSourceGeneration(generation);
  await store.savePlatform({ ...store.getPlatform(), homeId: store.getPlatform()?.homeId || 'fixture-home', devicePolicies: {
    ...(store.getPlatform()?.devicePolicies || {}), [device.id]: { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null,
      analyticsCategory: 'LIGHT', lifecycle: 'INSTALLED', analyticsInterval: { id: 'fixture-interval', revision: 1,
        sourceGeneration: generation, validFrom: new Date(clock).toISOString(), writerEnabled: false, genericCollectionEnabled: true } },
  } });
  await store.upsertDevice(device);
  const configuration = path.join(directory, 'synthetic-observation.yaml');
  fs.writeFileSync(configuration, `advanced:\n  last_seen: ISO_8601\ndevices:\n  '${raw.ieee_address}':\n    friendly_name: ${raw.friendly_name}\n    optimistic: false\n    filtered_cache: [state]\n`, { mode: 0o600 });
  const requests = [];
  const bridge = new MqttBridge({ url: '', store, observationConfigPath: configuration, clock: () => clock,
    onDeviceChanged, logger: { log() {}, warn() {}, error() {} } });
  bridge.client = { publish(topic, text, options, callback) { requests.push({ topic, value: JSON.parse(text) }); callback?.(); }, end() {} };
  bridge.connected = true;
  const runtime = new ObservationReconciler({ store, clock: () => clock, resolveDeviceId: () => device.id,
    publishBridgeRequest: (kind, payload) => bridge.bridgeRequest(kind, payload) });
  bridge.observationPolicy = runtime;
  await bridge.handleMessage('zigbee2mqtt/bridge/info', Buffer.from(JSON.stringify({ restart_required: false,
    config: { advanced: { last_seen: 'ISO_8601' }, devices: { [raw.ieee_address]: { friendly_name: raw.friendly_name,
      optimistic: false, filtered_cache: ['state'] } } } })));
  if (!registryDeviceId) await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([raw])), { retain: true });
  await runtime.onInventory([raw]); await runtime.tick();
  const request = requests.find(item => item.topic.endsWith('/device/reporting/read'));
  if (!request) throw new Error('Real reporting-read path was not reached');
  await bridge.handleMessage('zigbee2mqtt/bridge/response/device/reporting/read', Buffer.from(JSON.stringify({
    status: 'ok', transaction: request.value.transaction, data: { endpoint: 1, cluster: 'genOnOff',
      configs: [{ attrId: 0, status: 0, minRepIntval: 0, maxRepIntval: 300, repChange: 0 }] },
  })));
  const report = async (value = 'ON', { retain = false, advance = 300000 } = {}) => {
    clock += advance;
    await bridge.handleMessage(`zigbee2mqtt/${raw.friendly_name}`, Buffer.from(JSON.stringify({ state: value,
      last_seen: new Date(clock).toISOString() })), { retain });
  };
  for (let i = 0; i < 5; i++) await report();
  return { deviceId: device.id, raw, bridge, runtime, requests, report, clock: () => clock };
}
module.exports = { checkedStateFixture };
