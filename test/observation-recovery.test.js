const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { MqttBridge } = require('../src/mqttBridge');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const { ObservationReconciler, STATES } = require('../src/observation/reconciler');
const { observeUsage, advanceUsage, capUsageAtLastAlive } = require('../src/sync/usageBuckets');

const at = Date.parse('2026-10-23T00:00:00.000Z');
const sample = (extra = {}) => ({ osDeviceId: 'device', osAreaId: 'area', category: 'RADIATOR', controlId: 'heat',
  sourceGeneration: 1, activity: 'on', observedAt: new Date(at).toISOString(), validUntil: new Date(at + 660_000).toISOString(), nowMs: at, ...extra });

test('restart coverage cap preserves observation identity: duplicate replay is harmless and the gap stays Unknown', () => {
  const state = observeUsage({}, sample()).state;
  capUsageAtLastAlive(state, at + 60_000);
  const replay = observeUsage(state, sample({ nowMs: at + 300_000 }));
  assert.equal(replay.changed, false);
  const result = advanceUsage(replay.state, at + 300_000).state;
  assert.deepEqual(Object.values(result.buckets).map(b => [b.onSeconds, b.offSeconds, b.unknownSeconds]), [[60, 0, 240]]);
  assert.throws(() => observeUsage(result, sample({ activity: 'off', nowMs: at + 300_000 })), /Conflicting/);
});

async function household(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-observation-recovery-'));
  try {
    const file = path.join(directory, 'store.json');
    const store = new Store(file);
    store.setUsageClockTrust(() => true);
    store.setSyncSourceGeneration(1);
    await store.saveArea({ name: 'Synthetic room' }, 'area');
    await store.savePlatform({ homeId: 'synthetic-home' });
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zigbee/sonoff-trvzb-observation.json'), 'utf8'));
    raw.endpoints = { 1: { clusters: { input: ['hvacThermostat'] }, configured_reportings: [] } };
    raw.power_source = 'Battery';
    const normalized = normalizeZigbeeDevice(raw);
    const device = await store.upsertDevice({ ...normalized, metadata: { ...normalized.metadata, power_source: 'Battery' }, areaId: 'area',
      setup: { status: 'ready', assignmentMode: 'device_inherited_v1' } },
    { devicePolicy: { managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR', lifecycle: 'INSTALLED' } });
    const t = Math.floor(Date.now() / 1000) * 1000 - 600_000;
    await store.updateDeviceState(device.id, { running_state: 'heat' }, {
      reportedStateKeys: ['running_state'], sourceObservedAtByStateKey: { running_state: new Date(t).toISOString() },
      sourceReceivedAtByStateKey: { running_state: new Date(t).toISOString() }, nowMs: t,
    });
    await run({ store, file, device, raw, t });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('retained availability followed by inventory never rewrites declared capabilities or churns the descriptor', async () => {
  await household(async ({ store, device, raw }) => {
    const bridge = new MqttBridge({ url: '', store, logger: { log() {}, error() {}, warn() {} } });
    await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([raw])), { retain: true });
    const before = store.getDevice(device.id);
    await bridge.handleMessage(`zigbee2mqtt/${raw.friendly_name}/availability`, Buffer.from('online'), { retain: true });
    const after = store.getDevice(device.id);
    assert.equal(after.presentation.descriptorRevision, before.presentation.descriptorRevision);
    assert.equal(after.presentation.sourceFingerprint, before.presentation.sourceFingerprint);
    await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([raw])), { retain: true });
    assert.equal(store.getDevice(device.id).presentation.descriptorRevision, before.presentation.descriptorRevision);
  });
});

test('real bridge startup after a saved running marker discovers existing-device policy without replaying history', async () => {
  await household(async ({ store, file, device, raw, t }) => {
    await store.markUsageAlive(t + 60_000);
    const reopened = new Store(file);
    reopened.setUsageClockTrust(() => true); reopened.setSyncSourceGeneration(1);
    const bridge = new MqttBridge({ url: '', store: reopened, clock: () => t + 300_000, logger: { log() {}, error() {}, warn() {} } });
    const reconciler = new ObservationReconciler({ store: reopened, resolveDeviceId: value => bridge.resolveDeviceId(value),
      publishBridgeRequest: async () => assert.fail('inventory discovery must not send requests') });
    bridge.observationPolicy = reconciler;
    await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([raw])), { retain: true });
    assert.equal(reconciler.status().length, 1);
    assert.equal(reconciler.status()[0].deviceId, device.id);
    await reopened.advanceSyncUsage(t + 300_000);
    const totals = Object.values(reopened.snapshot().syncUsage.buckets).reduce((sum, bucket) =>
      sum.map((value, index) => value + [bucket.onSeconds, bucket.offSeconds, bucket.unknownSeconds][index]), [0, 0, 0]);
    assert.deepEqual(totals, [60, 0, 240]);
  });
});

test('legacy capped history is not reinterpreted with a new deadline on a metadata-only update', async () => {
  await household(async ({ store, device, t }) => {
    const source = Object.values(store.state.syncUsage.sources)[0];
    source.validUntil = new Date(t + 20_000).toISOString();
    delete source.observationValidUntil;
    await store.upsertDevice({ ...store.getDevice(device.id), name: 'Metadata only' });
    assert.equal(Object.values(store.state.syncUsage.sources)[0].validUntil, new Date(t + 20_000).toISOString());
  });
});

test('an inventory projection error does not starve policy reconciliation for an already registered device', async () => {
  await household(async ({ store, raw }) => {
    const bridge = new MqttBridge({ url: '', store, logger: { log() {}, error() {}, warn() {} } });
    const reconciler = new ObservationReconciler({ store, resolveDeviceId: value => bridge.resolveDeviceId(value), publishBridgeRequest: async () => {} });
    bridge.observationPolicy = reconciler;
    store.upsertDevice = async () => { throw Object.assign(new Error('synthetic projection error'), { code: 'synthetic_failure' }); };
    await bridge.handleMessage('zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([raw])), { retain: true });
    assert.equal(reconciler.status().length, 1);
  });
});

test('an analytics validation error rolls back the complete device mutation, not only disk writes', async () => {
  await household(async ({ store, device }) => {
    const source = Object.values(store.state.syncUsage.sources)[0];
    source.activity = 'off'; // deliberately inconsistent fixture: a true conflict must still fail
    const before = store.snapshot();
    await assert.rejects(store.upsertDevice({ ...store.getDevice(device.id), name: 'Must not survive' }), /Conflicting/);
    assert.deepEqual(store.snapshot(), before);
  });
});

test('unproved duplicate attribute delivery cannot renew lastReportedAt or observation validity', async () => {
  await household(async ({ store, device }) => {
    const heat = () => Object.values(store.getDevice(device.id).entities).find(e => e.stateKey === 'running_state' && e.capability?.semanticRole === 'active_heat_demand');
    const before = { ...heat() };
    await store.updateDeviceState(device.id, { running_state: 'heat' }, { reportedStateKeys: ['running_state'],
      sourceObservedAtByStateKey: {}, sourceReceivedAtByStateKey: {} });
    assert.equal(heat().sourceObservedAt, before.sourceObservedAt);
    assert.equal(heat().lastReportedAt, before.lastReportedAt);
    assert.equal(heat().sourceValidUntil, before.sourceValidUntil);
  });
});

test('a larger policy lifetime applies only to a genuinely newer observation', async () => {
  await household(async ({ store, device, t }) => {
    const heat = () => Object.values(store.getDevice(device.id).entities).find(e => e.stateKey === 'running_state' && e.capability?.semanticRole === 'active_heat_demand');
    const deadline = heat().sourceValidUntil;
    assert.ok(deadline);
    const updated = store.getDevice(device.id);
    updated.metadata.model = 'unknown-model'; updated.metadata.model_id = 'unknown-model';
    await store.upsertDevice(updated);
    assert.equal(heat().sourceValidUntil, deadline, 'fallback 1800 s cannot extend the existing 660 s observation');
    const at = new Date(t + 300_000).toISOString();
    await store.updateDeviceState(device.id, { running_state: 'heat' }, { reportedStateKeys: ['running_state'],
      sourceObservedAtByStateKey: { running_state: at }, sourceReceivedAtByStateKey: { running_state: at }, nowMs: t + 300_000 });
    assert.equal(heat().sourceValidUntil, new Date(t + 300_000 + 1800_000).toISOString());
  });
});

test('availability loss ends coverage without conflicting with the old sample; reconnect alone cannot resume it', async () => {
  await household(async ({ store, device, t }) => {
    await store.updateDeviceState(device.id, {}, { available: false, reportedStateKeys: [], nowMs: t + 120_000 });
    assert.equal(store.getDevice(device.id).available, false);
    await store.updateDeviceState(device.id, {}, { available: true, reportedStateKeys: [], nowMs: t + 200_000 });
    await store.advanceSyncUsage(t + 300_000);
    const totals = Object.values(store.snapshot().syncUsage.buckets).reduce((sum, b) =>
      sum.map((v, i) => v + [b.onSeconds, b.offSeconds, b.unknownSeconds][i]), [0, 0, 0]);
    assert.deepEqual(totals, [120, 0, 180]);
  });
});

test('store normalization records a real migration time rather than inventing 1970', async () => {
  await household(async ({ store, file, device }) => {
    const saved = store.snapshot();
    saved.devices[device.id].presentation.sourceFingerprint = 'synthetic-old-fingerprint';
    fs.writeFileSync(file, JSON.stringify(saved));
    const reopened = new Store(file);
    const latest = reopened.getDevice(device.id).presentation.revisionHistory.at(-1);
    assert.ok(latest);
    assert.equal(latest.at, saved.devices[device.id].updatedAt);
  });
});

function recoveryHarness(state, extra = {}) {
  const record = { key: 'synthetic', deviceId: 'device', profileId: 'zigbee.sonoff.trvzb.running_state', endpoint: '1',
    cluster: 'hvacThermostat', attribute: 'runningState', ieee: 'synthetic', state, updatedAt: at,
    nextAttemptAt: at, lastTransaction: 'dinodia-obs-original',
    desired: { minimumReportInterval: 0, maximumReportInterval: 600, reportableChange: 0 }, ...extra };
  const records = { synthetic: record }; const sent = []; const clock = { now: at + 1000 };
  const reconciler = new ObservationReconciler({ store: { getObservationPolicyRecords: () => records, getDevice: () => ({ available: true }),
    putObservationPolicyRecord: async (key, value) => { records[key] = value; } }, resolveDeviceId: () => 'device',
    publishBridgeRequest: async (request, payload) => sent.push({ request, payload }), clock: () => clock.now });
  return { reconciler, sent, records, clock };
}

for (const state of [STATES.READ_PENDING, STATES.CONFIGURING]) {
  test(`restart recovers ${state} with a bounded read-back before any possible reconfiguration`, async () => {
    const h = recoveryHarness(state);
    await h.reconciler.tick();
    assert.equal(h.sent.length, 0, 'an interrupted request is not immediately resent');
    const recovered = h.reconciler.status()[0];
    assert.equal(recovered.state, STATES.PENDING_DELIVERY);
    assert.ok(recovered.nextAttemptAt > h.clock.now);
    h.clock.now = recovered.nextAttemptAt;
    await h.reconciler.tick();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].request, 'device/reporting/read', 'the interrupted configure may already have reached the device');
  });
}

test('configuration read-back cannot resurrect cadence after failure; new consecutive reports are required', async () => {
  const h = recoveryHarness(STATES.CADENCE_FAILED, { cadence: { verifiedAt: new Date(at - 1000).toISOString(), lastReportAt: new Date(at - 2000).toISOString() } });
  await h.reconciler.onBridgeResponse('read', { status: 'ok', transaction: 'dinodia-obs-original',
    data: { endpoint: 1, cluster: 'hvacThermostat', configs: [{ status: 0, minRepIntval: 0, maxRepIntval: 600, repChange: 0 }] } });
  assert.equal(h.reconciler.status()[0].state, STATES.CADENCE_PENDING);
  for (let i = 0; i < 4; i++) {
    h.clock.now = at + 1000 + i * 600_000;
    await h.reconciler.onValueObserved('device', 'running_state', '1', new Date(h.clock.now).toISOString());
    assert.equal(h.reconciler.status()[0].state, i < 3 ? STATES.CADENCE_PENDING : STATES.CADENCE_VERIFIED);
  }
});

test('a malformed reporting response never authorizes a configure command', async () => {
  const h = recoveryHarness(STATES.UNKNOWN);
  await h.reconciler.tick();
  const tx = h.sent[0].payload.transaction;
  await h.reconciler.onBridgeResponse('read', { status: 'ok', transaction: tx, data: {} });
  assert.equal(h.reconciler.status()[0].state, STATES.PENDING_DELIVERY);
  h.clock.now = h.reconciler.status()[0].nextAttemptAt;
  await h.reconciler.tick();
  assert.equal(h.sent.at(-1).request, 'device/reporting/read');
});

test('policy health cannot report a state that failed to persist', async () => {
  const h = recoveryHarness(STATES.UNKNOWN);
  h.reconciler.store.putObservationPolicyRecord = async () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(h.reconciler.tick(), /synthetic disk failure/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.reconciler.status()[0].state, STATES.UNKNOWN);
});

test('concurrent policy ticks publish only one outstanding request', async () => {
  const h = recoveryHarness(STATES.UNKNOWN);
  await Promise.all([h.reconciler.tick(), h.reconciler.tick(), h.reconciler.tick()]);
  assert.equal(h.sent.length, 1);
});

test('silence immediately removes cadence verification while read-back stays bounded', async () => {
  const h = recoveryHarness(STATES.CADENCE_VERIFIED, { cadence: { verifiedAt: new Date(at).toISOString(), lastReportAt: new Date(at).toISOString() } });
  h.clock.now = at + 661_000;
  await h.reconciler.tick();
  assert.equal(h.reconciler.status()[0].state, STATES.CADENCE_FAILED);
  assert.equal(h.sent.length, 0, 'one late report does not trigger immediate repeated radio reads');
  h.clock.now = at + 1800_000;
  await h.reconciler.tick();
  assert.equal(h.sent[0].request, 'device/reporting/read');
});
