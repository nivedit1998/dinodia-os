'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { removePhysical } = require('../src/lifecycle/physicalRemoval');
test('confirmed current coordinator absence resumes cleanup without a second unpair command', async () => {
  let removals = 0;
  const input = { device: { id: 'zigbee:fixture', protocol: 'zigbee', protocolIdentity: { ieeeAddress: 'fixture' } },
    mqtt: { deviceInventorySnapshot: () => ({ complete: true, current: true, devices: [] }),
      remove: async () => { removals++; } } };
  assert.equal((await removePhysical(input)).kind, 'coordinator_absence_confirmed');
  assert.equal(removals, 0);
  input.mqtt.deviceInventorySnapshot = () => ({ complete: true, current: false, devices: [] });
  input.mqtt.remove = async (_id, force) => { assert.equal(force, false); throw new Error('No acknowledgement'); };
  await assert.rejects(removePhysical(input), /No acknowledgement/);
});
test('Matter cleanup uses verified existing inventory API and never treats an invalid response as absence', async () => {
  let removals = 0;
  const input = { device: { id: 'matter:fixture', protocol: 'matter', protocolIdentity: { nodeId: '12' } },
    matter: { connected: true, request: async name => { assert.equal(name, 'start_listening'); return []; },
      remove: async () => { removals++; } } };
  assert.equal((await removePhysical(input)).kind, 'controller_absence_confirmed');
  assert.equal(removals, 0);
  input.matter.request = async () => ({});
  await assert.rejects(removePhysical(input), /complete inventory/);
});
test('provider cleanup truthfully reports local detachment, not account-wide unpairing', async () => {
  let calls = 0;
  const result = await removePhysical({ device: { id: 'fixture', protocol: 'hive' },
    hive: { ignoreDevice: async () => { calls++; } } });
  assert.equal(calls, 1); assert.equal(result.kind, 'local_provider_detachment');
});
