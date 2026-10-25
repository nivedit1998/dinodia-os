'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../src/store');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const twoGang = require('./fixtures/zigbee/two-gang-light.json');
const { AreaDeletionService } = require('../src/lifecycle/areaDeletionService');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-area-fence-'));
  const file = path.join(dir, 'store.json');
  const store = new Store(file);
  t.after(async () => { await store.flushPersist(); await fs.rm(dir, { recursive: true, force: true }); });
  await store.saveArea({ name: 'Room 1' }, 'r1');
  await store.saveArea({ name: 'Room 2' }, 'r2');
  const parent = normalizeZigbeeDevice(twoGang);
  await store.upsertDevice(parent);
  const children = await store.assignLogicalDevices(parent.id, {
    expectedManifestDigest: store.logicalDeviceManifest(parent.id).digest,
    assignments: ['l1', 'l2'].map((channelKey, i) => ({ channelKey, areaId: `r${i + 1}`, name: `Light ${i + 1}`, labelId: 'light' })) });
  return { store, parent, children, file };
}

test('Area fence preserves another room on shared physical hardware and is idempotent', async t => {
  const { store, parent, children } = await fixture(t);
  const preview = store.areaDeletionPlan('r1');
  assert.deepEqual(preview.parents[0].preservedChildren, [children[1].id]);
  const input = { areaId: 'r1', digest: preview.digest, cloudDigest: 'a'.repeat(64), confirmationName: 'Room 1' };
  const id = crypto.randomUUID();
  const job = await store.fenceAreaDeletion(id, input);
  assert.equal(job.physical[parent.id], 'PRESERVED_SHARED_PARENT');
  assert.equal(store.getArea('r1'), null);
  assert.equal(store.getManagedDevice(children[0].id), null);
  assert.ok(store.getManagedDevice(children[1].id));
  assert.ok(store.getDevice(parent.id));
  assert.equal(store.deletionBlocksSource(parent.id, preview.targets[0].sourceIds[0]), true);
  assert.deepEqual(await store.fenceAreaDeletion(id, input), job);
  await assert.rejects(store.fenceAreaDeletion(id, { ...input, cloudDigest: 'b'.repeat(64) }), /changed/);
});

test('restoring a pre-deletion Store cannot resurrect a room or child', async t => {
  const { store, children, file } = await fixture(t);
  const oldStore = await fs.readFile(file);
  const preview = store.areaDeletionPlan('r1');
  await store.fenceAreaDeletion(crypto.randomUUID(), { areaId: 'r1', digest: preview.digest,
    cloudDigest: 'c'.repeat(64), confirmationName: 'Room 1' });
  await fs.writeFile(file, oldStore); // Synthetic restore only, private temporary directory.
  const restored = new Store(file);
  assert.equal(restored.getArea('r1'), null);
  assert.equal(restored.getManagedDevice(children[0].id), null);
  assert.ok(restored.getManagedDevice(children[1].id));
  await restored.flushPersist();
  await fs.unlink(`${file}.deletion-ledger.json`);
  assert.throws(() => new Store(file), /security ledger is missing/);
});

test('changed assignment inventory or wrong typed confirmation cannot fence an Area', async t => {
  const { store } = await fixture(t);
  const preview = store.areaDeletionPlan('r1');
  await assert.rejects(store.fenceAreaDeletion(crypto.randomUUID(), { areaId: 'r1', digest: preview.digest,
    cloudDigest: 'd'.repeat(64), confirmationName: 'Room 2' }), /changed/);
  assert.ok(store.getArea('r1'));
  await store.saveArea({ name: 'Renamed' }, 'r1');
  await assert.rejects(store.fenceAreaDeletion(crypto.randomUUID(), { areaId: 'r1', digest: preview.digest,
    cloudDigest: 'd'.repeat(64), confirmationName: 'Renamed' }), /changed/);
  assert.ok(store.getArea('r1'));
});

test('connected coordinator commits and purges one child without any radio removal', async t => {
  const { store, parent, children, file } = await fixture(t);
  await store.commit(state => { state.events.push({ deviceId: children[0].id, value: 'private erased record' }); });
  await store.savePlatform({ areaBindings: [{ areaId: crypto.randomUUID(), hubAreaId: 'r1' }] });
  const backup = await fs.readFile(file);
  const calls = [], removals = [];
  const service = new AreaDeletionService({ store, removePhysical: async device => { removals.push(device.id); return { acknowledged: true }; },
    platform: async (url, body) => {
      calls.push(body.action);
      if (body.action === 'preview') return { osAreaId: 'r1', osDeviceIds: [children[0].id], digest: 'e'.repeat(64), state: 'PREVIEW' };
      if (body.action === 'reserve') return { state: 'RESERVED' };
      if (body.action === 'commit') return { state: 'WAITING_HUB' };
      return { state: 'COMPLETE' };
    } });
  const principal = { scope: ['os:admin'], handoffId: crypto.randomUUID(), jti: crypto.randomUUID(), credentialVersion: 1 };
  const preview = await service.preview(principal, 'r1');
  assert.equal(preview.sharedHardwarePreserved, 1);
  assert.equal(JSON.stringify(preview).includes(children[0].id), false, 'operator preview reveals no private identity');
  const result = await service.confirm(principal, { ...preview, confirmationName: 'Room 1' });
  assert.equal(result.state, 'COMPLETE');
  assert.deepEqual(calls, ['preview', 'reserve', 'commit', 'finish']);
  assert.deepEqual(removals, []);
  assert.ok(store.getDevice(parent.id));
  assert.ok(store.getManagedDevice(children[1].id));
  assert.equal(store.getManagedDevice(children[0].id), null);
  const receipt = store.areaDeletionJob(preview.operationId);
  assert.equal(JSON.stringify(receipt).includes('r1'), false, 'completed receipt contains no room identity');
  assert.equal(JSON.stringify(receipt).includes(children[0].id), false);
  await fs.writeFile(file, backup);
  const restored = new Store(file);
  assert.equal(restored.state.logicalDevices.children[children[0].id], undefined, 'restore purges the erased child registry, not merely the tile');
  assert.equal(restored.state.events.some(event => event.deviceId === children[0].id), false, 'old private records are erased on restore');
  assert.ok(restored.getManagedDevice(children[1].id));
  await restored.flushPersist();
});

test('cloud failure after fencing stays visibly pending and a retry does not remove shared hardware', async t => {
  const { store, children } = await fixture(t);
  await store.savePlatform({ areaBindings: [{ areaId: crypto.randomUUID(), hubAreaId: 'r1' }] });
  let failCommit = true;
  const service = new AreaDeletionService({ store, removePhysical: async () => { throw new Error('Shared hardware must not be removed'); },
    platform: async (url, body) => {
      if (body.action === 'preview') return { osAreaId: 'r1', osDeviceIds: [children[0].id], digest: 'f'.repeat(64), state: 'PREVIEW' };
      if (body.action === 'reserve') return { state: 'RESERVED' };
      if (body.action === 'commit' && failCommit) throw new Error('Synthetic network outage');
      return { state: body.action === 'commit' ? 'WAITING_HUB' : 'COMPLETE' };
    } });
  const principal = { scope: ['os:admin'], handoffId: crypto.randomUUID(), jti: crypto.randomUUID() };
  const preview = await service.preview(principal, 'r1');
  const input = { ...preview, confirmationName: 'Room 1' };
  await assert.rejects(service.confirm(principal, input), /network outage/);
  assert.equal(store.areaDeletionJob(preview.operationId).state, 'FENCED');
  assert.equal(store.getManagedDevice(children[0].id), null);
  assert.ok(store.getManagedDevice(children[1].id));
  failCommit = false;
  assert.equal((await service.confirm(principal, input)).state, 'COMPLETE');
});

test('cloud reservation failure leaves local access and transport completely unchanged', async t => {
  const { store, children } = await fixture(t);
  await store.savePlatform({ areaBindings: [{ areaId: crypto.randomUUID(), hubAreaId: 'r1' }] });
  const service = new AreaDeletionService({ store, removePhysical: async () => { throw new Error('Must not run'); },
    platform: async (url, body) => {
      if (body.action === 'preview') return { osAreaId: 'r1', osDeviceIds: [children[0].id], digest: 'a'.repeat(64), state: 'PREVIEW' };
      throw new Error('Synthetic reservation outage');
    } });
  const principal = { scope: ['os:admin'], handoffId: crypto.randomUUID(), jti: crypto.randomUUID() };
  const preview = await service.preview(principal, 'r1');
  await assert.rejects(service.confirm(principal, { ...preview, confirmationName: 'Room 1' }), /reservation outage/);
  assert.equal(store.areaDeletionJob(preview.operationId), null);
  assert.ok(store.getArea('r1'));
  assert.ok(store.getManagedDevice(children[0].id));
});

test('unacknowledged last-parent removal remains pending; exact retry finishes without affecting another room', async t => {
  const { store, children, parent } = await fixture(t);
  await store.assignLogicalDevices(parent.id, { expectedManifestDigest: store.logicalDeviceManifest(parent.id).digest,
    assignments: [{ channelKey: 'l2', areaId: 'r1', name: 'Light 2', labelId: 'light' }] });
  await store.savePlatform({ areaBindings: [{ areaId: crypto.randomUUID(), hubAreaId: 'r1' }] });
  let acknowledged = false, removals = 0, finishes = 0;
  const service = new AreaDeletionService({ store,
    removePhysical: async device => { assert.equal(device.id, parent.id); removals++; return { acknowledged }; },
    platform: async (url, body) => {
      if (body.action === 'preview') return { osAreaId: 'r1', osDeviceIds: children.map(child => child.id), digest: 'b'.repeat(64), state: 'PREVIEW' };
      if (body.action === 'reserve') return { state: 'RESERVED' };
      if (body.action === 'commit') return { state: 'WAITING_HUB' };
      finishes++; return { state: 'COMPLETE' };
    } });
  const principal = { scope: ['os:admin'], handoffId: crypto.randomUUID(), jti: crypto.randomUUID() };
  const preview = await service.preview(principal, 'r1');
  const input = { ...preview, confirmationName: 'Room 1' };
  await assert.rejects(service.confirm(principal, input), /not acknowledged/);
  assert.equal(store.areaDeletionJob(preview.operationId).state, 'CLOUD_COMMITTED');
  assert.equal(finishes, 0, 'cloud purge cannot be falsely completed after an adapter timeout');
  assert.ok(store.getArea('r2'));
  acknowledged = true;
  assert.equal((await service.confirm(principal, input)).state, 'COMPLETE');
  assert.equal(removals, 2);
  assert.equal(finishes, 1);
  assert.equal(store.getDevice(parent.id), null);
});
