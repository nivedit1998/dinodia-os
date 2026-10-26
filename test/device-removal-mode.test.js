const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os');
const { Store } = require('../src/store'); const { HomeAssistantModel } = require('../src/haModel');

async function fixture(t, fail = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-removal-mode-'));
  const store = new Store(path.join(dir, 'store.json'));
  t.after(async () => { await store.persist(); await fs.rm(dir, { recursive: true, force: true }); });
  await store.upsertDevice({ id: 'zigbee:fixture', name: 'New radiator', protocol: 'zigbee', available: true });
  const calls = [], removed = [];
  const model = new HomeAssistantModel({ store, removeProtocolDevice: async (...args) => { calls.push(args); if (fail) throw new Error('device asleep'); }, onDeviceRemoved: d => removed.push(d.id) });
  return { model, store, calls, removed };
}
test('normal removal requests an acknowledged network leave without force or rejoin block', async t => {
  const f = await fixture(t); assert.equal(await f.model.removeDevice({ device_id: 'zigbee:fixture', force: false }), true);
  assert.equal(f.calls[0][1], false); assert.deepEqual(f.calls[0][2], { block: false });
  assert.equal(f.store.getDevice('zigbee:fixture'), null); assert.equal(f.removed.length, 1);
});
test('failed network leave retains the household record and never falls back to force', async t => {
  const f = await fixture(t, true); await assert.rejects(f.model.removeDevice({ device_id: 'zigbee:fixture' }), /asleep/);
  assert.ok(f.store.getDevice('zigbee:fixture')); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], false); assert.equal(f.removed.length, 0);
});
test('explicit force forget remains available and blocks a later unexpected rejoin', async t => {
  const f = await fixture(t); await f.model.removeDevice({ device_id: 'zigbee:fixture', force: true });
  assert.equal(f.calls[0][1], true); assert.deepEqual(f.calls[0][2], { block: true });
});
