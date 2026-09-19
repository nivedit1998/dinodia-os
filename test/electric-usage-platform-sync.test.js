const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { SecretVault } = require('../src/secretVault');
const { PlatformPairing, sign } = require('../src/platformPairing');

test('platform sync sends electric rows and acknowledges only the sent composite epochs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-electric-pairing-'));
  const store = new Store(path.join(directory, 'dinodia.json'));
  await store.saveIdentity({ serial: 'electric-hub' });
  const vault = new SecretVault({ dataDir: directory });
  let sent;
  const tracker = {
    payload: () => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), devices: [{ label: 'Light', entityId: 'light.kitchen', trackingEpoch: 'track-1', assignmentEpoch: 'area-1', onSeconds: 10, offSeconds: 0, unknownSeconds: 0, lastSeenAt: new Date().toISOString(), lastWasOn: true, lastWasKnown: true }] }),
    resetAcknowledgement: () => null,
    applyPlatformResponse: () => {},
    acknowledgeUploaded: (rows) => { sent = rows; },
    acknowledgeReset: () => {},
  };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const secret = url.endsWith('/pair') ? 'bootstrap' : 'sync';
    assert.equal(body.sig, sign(secret, body.serial, body.ts, body.nonce));
    if (url.endsWith('/pair')) return { ok: true, async json() { return { syncSecret: 'sync', latestVersion: 1, publishedVersion: 1, hubTokenHashes: [] }; } };
    assert.equal(body.electricUsage.devices[0].entityId, 'light.kitchen');
    return { ok: true, async json() { return { latestVersion: 1, publishedVersion: 1, hubTokenHashes: [crypto.createHash('sha256').update('token').digest('hex')] }; } };
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: 'https://platform.test', serial: 'electric-hub', fetchImpl, getElectricUsage: () => tracker.payload(), getElectricUsageResetAck: tracker.resetAcknowledgement, onSyncResult: async (result, heating, heatingReset, electric) => { tracker.applyPlatformResponse(result); tracker.acknowledgeUploaded(electric.devices); } });
  await pairing.configure({ bootstrapSecret: 'bootstrap' });
  await pairing.pair();
  await pairing.syncNow();
  assert.equal(sent[0].assignmentEpoch, 'area-1');
});
