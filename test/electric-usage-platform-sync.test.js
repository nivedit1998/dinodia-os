const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { SecretVault } = require('../src/secretVault');
const { PlatformPairing } = require('../src/platformPairing');

test('retired bootstrap and bearer secrets cannot enter Native V2 sync or acknowledge usage rows', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-electric-pairing-'));
  const store = new Store(path.join(directory, 'dinodia.json'));
  await store.saveIdentity({ serial: 'electric-hub' });
  const vault = new SecretVault({ dataDir: directory });
  await vault.set('platform.bootstrapSecret', 'retired-bootstrap');
  await vault.set('platform.syncSecret', 'retired-sync');
  await store.savePlatform({ apiUrl: 'https://platform.test', paired: true });
  let sent;
  const requestedPaths = [];
  const tracker = {
    payload: () => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), devices: [{ label: 'Light', entityId: 'light.kitchen', trackingEpoch: 'track-1', assignmentEpoch: 'area-1', onSeconds: 10, offSeconds: 0, unknownSeconds: 0, lastSeenAt: new Date().toISOString(), lastWasOn: true, lastWasKnown: true }] }),
    resetAcknowledgement: () => null,
    applyPlatformResponse: () => {},
    acknowledgeUploaded: (rows) => { sent = rows; },
    acknowledgeReset: () => {},
  };
  const fetchImpl = async (url, options) => {
    requestedPaths.push(new URL(url).pathname);
    throw new Error(`retired transport unexpectedly called: ${new URL(url).pathname}`);
  };
  const pairing = new PlatformPairing({ store, vault, apiUrl: 'https://platform.test', serial: 'electric-hub', fetchImpl, getElectricUsage: () => tracker.payload(), getElectricUsageResetAck: tracker.resetAcknowledgement, onSyncResult: async (result, heating, heatingReset, electric) => { tracker.applyPlatformResponse(result); if (electric?.devices) tracker.acknowledgeUploaded(electric.devices); } });
  await pairing.syncNow();
  assert.deepEqual(requestedPaths, []);
  assert.equal(sent, undefined);
  assert.equal(pairing.lastError, 'A factory-enrolled hub identity is required for Platform synchronisation');
});
