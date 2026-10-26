const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { ObservationReconciler } = require('../src/observation/reconciler');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const daily = require('../src/sync/dailyAnalytics');
const { initialUsageState, observeUsage } = require('../src/sync/usageBuckets');

async function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-reporting-epochs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'store.json');
  const store = new Store(file);
  store.setSyncSourceGeneration(1); store.setUsageClockTrust(() => true);
  const raw = structuredClone(require('./fixtures/zigbee/sonoff-trvzb-observation.json'));
  raw.endpoints = { 1: { clusters: { input: ['hvacThermostat'], output: [] }, configured_reportings: [] } };
  const device = normalizeZigbeeDevice(raw);
  await store.upsertDevice(device);
  const sent = []; let now = Date.parse('2026-10-26T14:00:00Z');
  const reconciler = new ObservationReconciler({ store, clock: () => now,
    resolveDeviceId: () => device.id,
    publishBridgeRequest: async (route, payload) => { sent.push({ route, payload }); } });
  return { store, raw, device, sent, reconciler, file, advance: ms => { now += ms; },
    reply: (status, extra = {}) => ({ status: 'ok', transaction: sent.at(-1).payload.transaction,
      data: { endpoint: 1, cluster: 'hvacThermostat', configs: [{ attrId: 41, status, ...extra }] } }) };
}

test('inventory refresh preserves not-configured result and completes approved setup once', async t => {
  const h = await harness(t), r = h.reconciler;
  await r.onInventory([h.raw]); await r.tick();
  await r.onBridgeResponse('read', h.reply(139));
  for (let i = 0; i < 3; i++) await r.onInventory([h.raw]);
  assert.equal(r.status()[0].state, 'drifted');
  h.advance(30000); await r.tick();
  assert.deepEqual(h.sent.map(s => s.route), ['device/reporting/read', 'device/reporting/configure']);
  await r.onBridgeResponse('configure', { status: 'ok', transaction: h.sent.at(-1).payload.transaction });
  h.advance(30000); await r.tick();
  await r.onBridgeResponse('read', h.reply(0, { minRepIntval: 0, maxRepIntval: 600 }));
  for (let i = 0; i < 4; i++) {
    h.advance(600000);
    await r.onValueObserved(h.device.id, 'running_state', '1', new Date(Date.parse('2026-10-26T14:01:00Z') + (i + 1) * 600000).toISOString(), 'idle');
  }
  const record = [...r.records.values()][0];
  assert.equal(record.state, 'cadence_verified'); assert.ok(record.evidenceVerifiedAt);
  assert.equal(record.sourceGeneration, 1);
  const restarted = new Store(h.file);
  assert.equal(Object.values(restarted.getObservationPolicyRecords())[0].state, 'cadence_verified');
  assert.equal(h.sent.filter(s => s.route.endsWith('/configure')).length, 1);
});

test('unsupported reporting stays unsupported across inventory refreshes without a read loop', async t => {
  const h = await harness(t), r = h.reconciler;
  await r.onInventory([h.raw]); await r.tick();
  await r.onBridgeResponse('read', h.reply(134));
  for (let i = 0; i < 5; i++) { h.advance(30000); await r.onInventory([h.raw]); await r.tick(); }
  assert.equal(r.status()[0].state, 'unsupported'); assert.equal(h.sent.length, 1);
});

test('a reporting reply from the previous source generation cannot become new proof', async t => {
  const h = await harness(t), r = h.reconciler;
  await r.onInventory([h.raw]); await r.tick();
  const oldReply = h.reply(0, { minRepIntval: 0, maxRepIntval: 600 });
  h.store.setSyncSourceGeneration(2);
  await r.onBridgeResponse('read', oldReply);
  assert.notEqual(r.status()[0].state, 'cadence_pending');
  h.advance(30000); await r.onInventory([h.raw]); await r.tick();
  await r.onBridgeResponse('read', h.reply(0, { minRepIntval: 0, maxRepIntval: 600 }));
  assert.equal([...r.records.values()][0].sourceGeneration, 2);
});

test('legacy approved records acquire their exact control binding without inheriting old cadence', async t => {
  const h = await harness(t), r = h.reconciler;
  await r.onInventory([h.raw]);
  const record = [...r.records.values()][0];
  delete record.controlId; delete record.property;
  await r.save({ ...record, state: 'cadence_verified', evidenceVerifiedAt: '2026-10-26T13:00:00Z' });
  await r.onInventory([h.raw]);
  const next = [...r.records.values()][0];
  assert.equal(next.property, 'running_state'); assert.ok(next.controlId);
  assert.equal(next.state, 'configuration_unknown'); assert.equal(next.evidenceVerifiedAt, null);
});

const writerFrom = '2026-10-25T17:00:00.000Z';
const signed = '2026-10-26T13:46:35.504Z';
const canonical = '2026-10-26T13:46:35.000Z';
const local = '2026-10-26T13:46:38.000Z';
const sample = { osDeviceId: 'device', osAreaId: 'area', category: 'RADIATOR', controlId: 'heat',
  sourceGeneration: 1, bindingRevision: 1, analyticsIntervalId: 'interval', analyticsPolicyVersion: 3 };
const policy = { managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED', analyticsCategory: 'RADIATOR',
  osAreaIds: ['area'], analyticsAssignmentStartedAt: signed,
  analyticsInterval: { id: 'interval', revision: 1, sourceGeneration: 1, writerEnabled: true } };
function usageFixture() {
  let usage = initialUsageState();
  daily.initialize(usage, { version: 1, enabled: true, timezone: 'Europe/London', writerFrom }, Date.parse(writerFrom));
  usage.dailyAnalytics.assignmentEpochs.device = local;
  usage = observeUsage(usage, { ...sample, assignmentEpochAt: local, activity: 'unknown',
    observedAt: local, validUntil: new Date(Date.parse(local) + 1).toISOString(), nowMs: Date.parse(local) + 60000 }).state;
  return usage;
}

test('signed assignment identity wins over delayed registration, while unsynced local moves keep a separate boundary', () => {
  const usage = usageFixture();
  assert.equal(daily.assignmentStart(usage, { id: 'device', areaId: 'area' }, policy), canonical);
  assert.equal(daily.assignmentStart(usage, { id: 'device', areaId: 'other' }, policy), local);
});

test('guarded epoch recovery republishes original counters once and retains immutable queued bytes', () => {
  const usage = usageFixture(), device = { id: 'device', areaId: 'area' };
  const [oldKey] = Object.keys(usage.dailyAnalytics.days), before = structuredClone(usage.dailyAnalytics.days[oldKey]);
  usage.dailyAnalytics.queuedRevisions[oldKey] = before.revision;
  const immutableEvent = JSON.stringify({ payload: before });
  assert.equal(daily.reconcileAssignment(usage, device, policy), true);
  const events = daily.dailyEvents(usage);
  assert.equal(events.length, 1); assert.equal(events[0].payload.assignmentEpochAt, canonical);
  assert.equal(events[0].payload.unknownSeconds, before.unknownSeconds);
  assert.equal(events[0].payload.coverageStartAt, before.coverageStartAt);
  assert.equal(events[0].payload.coverageEndAt, before.coverageEndAt);
  assert.equal(events[0].payload.onSeconds, 0);
  assert.equal(JSON.stringify({ payload: before }), immutableEvent);
  assert.equal(Object.values(usage.sources)[0].assignmentEpochAt, canonical);
  assert.equal(daily.reconcileAssignment(usage, device, policy), false);
  assert.equal(Object.keys(usage.dailyAnalytics.days).length, 1);
});

test('epoch recovery cannot rebind tenant data, another generation, an earlier assignment or a switch-back', () => {
  for (const changed of [{ managementClass: 'TENANT_DEVICE' }, { ownerMembershipId: 'tenant' },
    { analyticsAssignmentStartedAt: '2026-10-26T15:00:00.000Z' },
    { analyticsInterval: { ...policy.analyticsInterval, sourceGeneration: 2 } }, { osAreaIds: ['other'] }]) {
    const usage = usageFixture(), before = JSON.stringify(usage);
    assert.equal(daily.reconcileAssignment(usage, { id: 'device', areaId: 'area' }, { ...policy, ...changed }), false);
    assert.equal(JSON.stringify(usage), before);
  }
});

test('epoch repair preserves temperature retraction links and refuses colliding fragments atomically', () => {
  const usage = usageFixture(), device = { id: 'device', areaId: 'area' }, at = Date.parse(local);
  daily.observeTemperature(usage, { ...sample, assignmentEpochAt: local, controlId: 'temperature',
    observedAt: local, validUntil: new Date(at + 600000).toISOString(), value: 20 }, at + 60000);
  assert.equal(daily.reconcileAssignment(usage, device, policy), true);
  const temperature = Object.values(usage.dailyAnalytics.temperatures)[0];
  assert.equal(temperature.assignmentEpochAt, canonical);
  assert.ok(temperature._integrations.every(s => usage.dailyAnalytics.days[s.key]));
  daily.observeTemperature(usage, { ...sample, assignmentEpochAt: canonical, controlId: 'temperature',
    observedAt: new Date(at + 30000).toISOString(), validUntil: new Date(at + 600000).toISOString(), value: 24 }, at + 60000);
  const row = Object.values(usage.dailyAnalytics.days).find(r => r.kind === 'TEMPERATURE');
  assert.equal(row.knownMilliseconds, 60000); assert.equal(row.celsiusMilliseconds / row.knownMilliseconds, 22);
  const collision = usageFixture(), first = Object.values(collision.dailyAnalytics.days)[0];
  collision.dailyAnalytics.days.collision = { ...structuredClone(first), assignmentEpochAt: new Date(at + 1000).toISOString() };
  const before = JSON.stringify(collision);
  assert.equal(daily.reconcileAssignment(collision, device, policy), false);
  assert.equal(JSON.stringify(collision), before);
});

test('actual Store sweep repairs persisted assignment identity and queues an absolute replacement through the normal outbox', async t => {
  const h = await harness(t), store = h.store;
  await store.saveArea({ name: 'Synthetic room' }, 'area');
  await store.upsertDevice({ ...store.getDevice(h.device.id), areaId: 'area',
    setup: { status: 'ready', assignmentMode: 'device_inherited_v1' } });
  const usage = usageFixture();
  for (const source of Object.values(usage.sources)) source.osDeviceId = h.device.id;
  for (const row of Object.values(usage.dailyAnalytics.days)) row.osDeviceId = h.device.id;
  store.state.syncUsage = usage;
  store.state.platform.homeId = 'synthetic-home';
  store.state.platform.cloudConfiguration = { analyticsHistory: usage.dailyAnalytics.config };
  store.state.platform.devicePolicies[h.device.id] = { ...policy, osDeviceId: h.device.id };
  usage.dailyAnalytics.barrierQueued = true;
  await store.advanceSyncUsage(Date.parse(local) + 120000);
  const events = store.getSyncOutbox().events.filter(e => e.type === 'analytics.day');
  assert.ok(events.length); assert.equal(events.at(-1).payload.assignmentEpochAt, canonical);
  assert.equal(events.at(-1).payload.onSeconds, 0);
  const restored = new Store(h.file);
  assert.ok(Object.values(restored.state.syncUsage.dailyAnalytics.days).every(r => r.assignmentEpochAt === canonical));
});
