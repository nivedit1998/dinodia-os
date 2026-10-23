const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Store } = require('../src/store');
const { BoundedReadCoordinator } = require('../src/observation/readCoordinator');
test('D9 delivery allowance contains the bounded-read timeout', () => assert.equal(require('../src/observation/profiles').boundedReadLifetime(300), 360));
test('read provenance rejects cache, wrong endpoint, future time and extra response fields', () => {
  const { validateReadObservation } = require('../src/observation/adapterContract');
  const request = { requestId: 'r', deviceId: 'd', controlId: 'p', endpointId: '1', sentAt: 1000 };
  const response = { ...request, value: false, observedAt: new Date(1000).toISOString(), networkRead: true, provenance: 'device_read' };
  assert.ok(validateReadObservation(request, request, response, 1000));
  for (const changes of [{ networkRead: false }, { endpointId: '2' }, { requestId: 'old' }, { value: NaN }, { observedAt: new Date(1001).toISOString() }, { cached: true }])
    assert.equal(validateReadObservation(request, request, { ...response, ...changes }, 1000), null);
});
test('read intent must persist before dispatch and a policy change during read prevents admission', async () => {
  const policy = { managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED', analyticsCategory: 'LIGHT', analyticsInterval: { genericCollectionEnabled: true } };
  let currentPolicy = policy; let calls = 0; let admitted = 0;
  const store = { getObservationPolicyRecords: () => ({}), getPlatform: () => ({ devicePolicies: { d: currentPolicy } }),
    putObservationPolicyRecord: async () => { throw new Error('disk_unavailable'); } };
  const target = { key: 'd|p', deviceId: 'd', controlId: 'p', endpointId: '1', integration: 'test', power: 'mains', intervalSeconds: 300, enabled: true };
  const adapters = { test: { supports: () => true, read: async request => { calls++; currentPolicy = { ...policy, analyticsCategory: 'NONE' };
    return { ...request, value: true, observedAt: new Date(1000000).toISOString(), networkRead: true, provenance: 'device_read' }; } } };
  const make = () => new BoundedReadCoordinator({ store, adapters, clock: () => 1000000, admit: async () => { admitted++; } });
  await make().tick([target]); assert.equal(calls, 0);
  store.putObservationPolicyRecord = async () => {};
  await make().tick([target]); assert.equal(calls, 1); assert.equal(admitted, 0);
  await make().tick([target]); assert.equal(calls, 1);
});
test('adapter-connected read intent and hourly budget survive restart; no actuator or implicit retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-read-')); let now = Date.parse('2026-10-23T10:00:00Z');
  try {
    const store = new Store(path.join(dir, 'store.json')); const calls = [];
    await store.savePlatform({ devicePolicies: { d: { managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED', analyticsCategory: 'LIGHT', analyticsInterval: { genericCollectionEnabled: true } } } });
    const target = { key: 'd|1|power', deviceId: 'd', controlId: 'power', endpointId: '1', property: 'state', integration: 'test', power: 'mains', intervalSeconds: 300, enabled: true };
    const make = targetStore => new BoundedReadCoordinator({ store: targetStore, clock: () => now, adapters: { test: {
      supports: () => true, read: async request => { calls.push(request); return { ...request, value: true, observedAt: new Date(now).toISOString(), provenance: 'device_read', networkRead: true }; }
    } }, admit: async observation => assert.equal(observation.validUntil, new Date(now + 360000).toISOString()) });
    let runtime = make(store);
    for (let i = 0; i < 12; i++) { await runtime.tick([target]); now += 300000; }
    assert.equal(calls.length, 12);
    now -= 1; runtime = make(new Store(path.join(dir, 'store.json'))); await runtime.tick([target]); assert.equal(calls.length, 12);
    assert.equal(calls.every(request => request.requestId && request.controlId === 'power'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
