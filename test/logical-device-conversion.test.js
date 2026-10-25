'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Store } = require('../src/store');
const { LogicalDeviceConversion } = require('../src/commissioning/logicalDeviceConversion');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const fixture = require('./fixtures/zigbee/two-gang-light.json');

for (const lostPhase of ['reserve', 'commit']) test(`explicit conversion survives lost ${lostPhase} acknowledgement without duplicate children or physical commands`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-conversion-'));
  const file = path.join(dir, 'store.json');
  let store = new Store(file);
  t.after(async () => { await store.flushPersist(); await fs.rm(dir, { recursive: true }); });
  const device = normalizeZigbeeDevice(fixture), areaId = crypto.randomUUID(), homeId = crypto.randomUUID();
  await store.saveArea({ name: 'Room' }, 'r1');
  await store.upsertDevice({ ...device, areaId: 'r1', labelIds: ['light'], name: 'Old switch', setup: { status: 'ready' } });
  const policy = { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED',
    customerLabel: 'Light', analyticsCategory: 'LIGHT', canonicalAreaIds: [areaId], osAreaIds: ['r1'] };
  await store.savePlatform({ homeId, hubInstallId: crypto.randomUUID(), areaBindings: [{ areaId, hubAreaId: 'r1' }], devicePolicies: { [device.id]: policy } });
  const principal = { scope: ['os:admin'], handoffId: crypto.randomUUID(), jti: crypto.randomUUID() };
  let channels, failCommit = true, commits = 0;
  const platform = async (_endpoint, body) => {
    if (body.action === 'preview') { channels = body.channels; return { digest: 'a'.repeat(64), confirmationName: 'Old switch' }; }
    if (body.action === 'reserve') {
      if (lostPhase === 'reserve' && failCommit) throw new Error('Synthetic response loss');
      return { state: 'RESERVED' };
    }
    commits++;
    if (failCommit) throw new Error('Synthetic response loss');
    return { state: 'COMPLETE', children: channels.map(channel => ({ id: crypto.randomUUID(), osDeviceId: channel.catalogue.osDeviceId,
      ...policy, descriptorRevision: channel.catalogue.descriptorRevision, descriptorDigest: channel.catalogue.descriptorDigest, binding: channel.binding })) };
  };
  const identity = () => ({ hash: 'b'.repeat(64) });
  const service = new LogicalDeviceConversion({ store, platform, protocolIdentity: identity });
  const preview = await service.preview(principal, device.id);
  await assert.rejects(service.confirm(principal, preview), /response loss/);
  assert.equal(store.getManagedDevice(device.id).areaId, lostPhase === 'commit' ? null : 'r1');
  assert.ok(store.snapshot().logicalConversions[preview.operationId], 'confirmed intent is durable before the reservation request');
  await store.flushPersist();
  store = new Store(file);
  failCommit = false;
  const resumed = new LogicalDeviceConversion({ store, platform, protocolIdentity: identity });
  assert.equal((await resumed.confirm(principal, preview)).state, 'COMPLETE');
  assert.equal((await resumed.confirm(principal, preview)).state, 'COMPLETE');
  assert.equal(commits, lostPhase === 'commit' ? 2 : 1, 'only the lost operation is replayed; completed retry does no new work');
  assert.equal(store.listManagedDevices().length, 2);
  assert.equal(store.getManagedDevice(device.id), null);
  await assert.rejects(resumed.preview({ ...principal, scope: ['os:support'] }, device.id));
});
