const test = require('node:test');
const assert = require('node:assert/strict');
const { observeUsage, endUsageAssignment, advanceUsage } = require('../src/sync/usageBuckets');
test('actual Store inventory events keep the mutation clock used by their assignment boundary', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Store } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-event-clock-'));
  try {
    const store = new Store(path.join(dir, 'state.json'));
    const at = Date.parse('2026-10-08T10:30:00Z');
    await store.saveArea({ name: 'area' }, 'area');
    await store.upsertDevice({ id: 'd', protocol: 'zigbee', name: 'd', areaId: 'area' }, {
      nowMs: at, devicePolicy: { managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED', analyticsCategory: 'LIGHT' } });
    assert.equal(store.getSyncOutbox().events.find(event => event.type === 'device.upsert').occurredAt, new Date(at).toISOString());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('three interval revisions partition a same-hour source switch and switch-back', () => {
  let state; const start = Date.parse('2026-10-23T10:00:00Z');
  for (let revision = 1; revision <= 3; revision++) {
    const time = start + (revision - 1) * 600000;
    state = observeUsage(state, { osDeviceId: 'device', osAreaId: 'area', category: revision === 2 ? 'RADIATOR' : 'LIGHT', controlId: revision === 2 ? 'heat' : 'power',
      sourceGeneration: 1, bindingRevision: revision, analyticsPolicyVersion: 2, analyticsIntervalId: `interval-${revision}`,
      activity: 'on', observedAt: new Date(time).toISOString(), validUntil: new Date(time + 600000).toISOString(), nowMs: time }).state;
    state = endUsageAssignment(state, { osDeviceId: 'device', osAreaId: 'area', endedAtMs: time + 600000 }).state;
  }
  state = advanceUsage(state, start + 1800000).state;
  assert.equal(Object.keys(state.buckets).length, 3);
  assert.deepEqual(Object.values(state.buckets).map(b => b.bindingRevision), [1, 2, 3]);
  assert.equal(Object.values(state.buckets).reduce((n, b) => n + b.onSeconds + b.offSeconds + b.unknownSeconds, 0), 1800);
});

for (const transition of ['NONE', 'writer_disabled']) for (const trustedAtChange of [true, false]) test(`actual signed-policy application closes ${transition} with trusted clock=${trustedAtChange} and never seeds switch-back with an old sample`, async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'); const { Store } = require('../src/store');
  const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-lifecycle-'));
  try {
    const store = new Store(path.join(dir, 'state.json')); store.setUsageClockTrust(() => true); store.setSyncSourceGeneration(1);
    const at = Date.parse('2026-10-23T10:00:00Z');
    await store.saveArea({ name: 'room' }, 'room');
    await store.savePlatform({ homeId: 'synthetic-home' });
    const d = normalizeZigbeeDevice(require('./fixtures/zigbee/dimmable-light.json'));
    const policy = revision => ({ managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED', analyticsCategory: revision === 2 && transition === 'NONE' ? 'NONE' : 'LIGHT',
      analyticsInterval: { id: `interval-${revision}`, revision, writerEnabled: !(revision === 2 && transition === 'writer_disabled'), sourceGeneration: 1, validFrom: new Date(at + (revision - 1) * 60000).toISOString() } });
    await store.upsertDevice({ ...d, areaId: 'room', setup: { status: 'ready', assignmentMode: 'device_inherited_v1' } }, { devicePolicy: policy(1), nowMs: at });
    const report = async (time, state) => store.updateDeviceState(d.id, { state }, { nowMs: time, reportedStateKeys: ['state'],
      sourceObservedAtByStateKey: { state: new Date(time).toISOString() }, sourceReceivedAtByStateKey: { state: new Date(time).toISOString() } });
    await report(at + 1000, 'OFF');
    await store.advanceSyncUsage(at + 60000);
    store.setUsageClockTrust(() => trustedAtChange);
    await store.applyCloudConfigurationSnapshot({ cloudRevision: 2, devicePolicies: { [d.id]: policy(2) } }, [], { nowMs: at + 60000 });
    store.setUsageClockTrust(() => true);
    await report(at + 70000, 'ON');
    assert.equal(Object.values(store.snapshot().syncUsage.sources).some(source => source.assignmentEndedAt == null), false,
      'neither a new report nor clock recovery may resume recording under disabled authority');
    await store.advanceSyncUsage(at + 120000);
    assert.equal(Object.values(store.snapshot().syncUsage.buckets).reduce((n, b) => n + b.offSeconds + b.unknownSeconds, 0), 59);
    await store.applyCloudConfigurationSnapshot({ cloudRevision: 3, devicePolicies: { [d.id]: policy(3) } }, [], { nowMs: at + 120000 });
    await store.upsertDevice(store.getDevice(d.id), { nowMs: at + 120000 });
    assert.equal(Object.values(store.snapshot().syncUsage.sources).some(source => source.bindingRevision === 3), false);
    await report(at + 121000, 'ON'); await store.advanceSyncUsage(at + 180000);
    assert.deepEqual(Object.values(store.snapshot().syncUsage.buckets).map(b => [b.bindingRevision, b.onSeconds, b.offSeconds]), [[1, 0, 59], [3, 59, 0]]);
    const reopened = new Store(path.join(dir, 'state.json'));
    assert.deepEqual(Object.values(reopened.snapshot().syncUsage.buckets).map(b => b.bindingRevision), [1, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
