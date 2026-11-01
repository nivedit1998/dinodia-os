const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { MqttBridge } = require('../src/mqttBridge');
const { isBarePlaceholder } = require('../src/commissioning/barePlaceholder');

const ghost = (id, extra = {}) => ({ id, name: id, protocol: 'zigbee', state: {}, metadata: {}, available: true, protocolIdentity: { ieeeAddress: id },
  setup: { status: 'needs_setup', reason: 'area_and_label_required' }, entities: { 'sensor.linkquality': { id: 'sensor.linkquality', state: '90' } }, ...extra });

test('a bare leftover record is recognised; an interviewed, modelled, placed or platform-owned one is not', () => {
  assert.equal(isBarePlaceholder(ghost('0x01')), true);
  assert.equal(isBarePlaceholder(ghost('0x01', { interviewStatus: 'successful' })), false);
  assert.equal(isBarePlaceholder(ghost('0x01', { metadata: { model: 'ZBM5' } })), false);
  assert.equal(isBarePlaceholder(ghost('0x01', { areaId: 'room' })), false);
  assert.equal(isBarePlaceholder(ghost('0x01', { setup: { status: 'ready' } })), false);
  assert.equal(isBarePlaceholder(ghost('0x01'), { devicePolicies: { '0x01': {} } }), false);
});

test('a removed radio does not come back by itself: with no search running its leftover record is dropped, during a search it is kept', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-leftover-'));
  try {
    const store = new Store(path.join(directory, 'store.json'));
    await store.upsertDevice(ghost('0x983268fffe0641a7'));
    const bridge = new MqttBridge({ url: '', store, logger: { log() {}, error() {}, warn() {} } });
    bridge.pairingSession.status = () => ({ active: true });
    await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from('[]'), { retain: true });
    assert.ok(store.getDevice('0x983268fffe0641a7'), 'kept while a pairing search is running');
    bridge.pairingSession.status = () => ({ active: false });
    await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from('[]'), { retain: true });
    assert.ok(!store.getDevice('0x983268fffe0641a7'), 'dropped when nothing is searching');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
