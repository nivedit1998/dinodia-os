'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHub } = require('../src/server');
const { normalizeZigbeeDevice } = require('../src/integrations/zigbee/exposeNormalizer');
const fixture = require('./fixtures/zigbee/two-gang-light.json');

const mock = () => ({ start() {}, close() {}, status() { return { configured: false, connected: false }; }, async refresh() {} });
function token(claims, key) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'EdDSA', typ: 'DNO-APP-1', v: 1 })}.${encode(claims)}`;
  return `dno-app-1.${input}.${crypto.sign(null, Buffer.from(input), key).toString('base64url')}`;
}

test('real authenticated native HTTP catalog isolates channel rooms and rejects sibling lookup', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-logical-http-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const hubId = 'logical-test-hub', homeId = crypto.randomUUID(), membershipId = crypto.randomUUID();
  const hub = createHub({ config: { nodeEnv: 'production', v2Environment: 'test', hubId,
    appPublicKeys: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, 'store.json'),
    backupDir: path.join(directory, 'backups'), staticDir: path.join(__dirname, '..', 'public'), otbrUrl: '' },
    mqttBridge: mock(), matterBridge: mock(), platformSync: { start() {}, stop() {}, status() { return {}; } },
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, running: false, connected: false, mode: 'disabled', publicUrl: '' }; } } });
  t.after(async () => { await hub.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const publicAreas = [crypto.randomUUID(), crypto.randomUUID()];
  await hub.store.saveArea({ name: 'Room 1' }, 'room-1');
  await hub.store.saveArea({ name: 'Room 2' }, 'room-2');
  const parent = normalizeZigbeeDevice(fixture);
  await hub.store.upsertDevice(parent);
  const children = await hub.store.assignLogicalDevices(parent.id, {
    expectedManifestDigest: hub.store.logicalDeviceManifest(parent.id).digest,
    assignments: ['l1', 'l2'].map((channelKey, index) => ({ channelKey, areaId: `room-${index + 1}`, name: `Light ${index + 1}`, labelId: 'light' })) });
  await hub.store.savePlatform({ hubInstallId: hubId, homeId, policyRevision: 4,
    areaBindings: publicAreas.map((areaId, i) => ({ areaId, hubAreaId: `room-${i + 1}` })),
    devicePolicies: Object.fromEntries(children.map((child, i) => [child.id, {
      managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED',
      osAreaIds: [`room-${i + 1}`], canonicalAreaIds: [publicAreas[i]],
    }])) });
  await hub.start();
  const now = Math.floor(Date.now() / 1000);
  const auth = token({ iss: 'dinodia-platform-v2', aud: `dinodia-hub:${hubId}`, sub: 'tenant-account',
    sid: 'tenant-session', jti: crypto.randomUUID(), membershipId, trustedDeviceId: 'fixture-phone',
    hubInstallationId: hubId, homeId, iat: now, exp: now + 300, householdRole: 'TENANT',
    areaIds: [publicAreas[0]], policyRevision: 4, scope: ['tenant:device-command'] }, keys.privateKey);
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { authorization: `Bearer ${auth}` };
  const response = await fetch(`${base}/api/dinodia/v1/devices`, { headers });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].id, children[0].id);
  assert.equal(envelope.data[0].controls.length, 1);
  assert.equal(envelope.data[0].controls.some(control => control.controlId.includes('state_l2')), false);
  for (const forbidden of [children[1].id, parent.id]) {
    const denied = await fetch(`${base}/api/dinodia/v1/devices/${encodeURIComponent(forbidden)}`, { headers });
    assert.equal(denied.status, 404);
  }
});
