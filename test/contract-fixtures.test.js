'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('../src/contracts/dinodiaV1');
const analytics = require('../src/contracts/analyticsV1');
const root = path.join(__dirname, 'fixtures/contracts/dinodia-v1');
const good = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/multi-control-device.json')));
const wrongOwner = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/tenant-device-wrong-owner.json')));
test('OS activity and aggregation semantics match the shared dinodia.v1 fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/analytics-semantics.json')));
  const now = Date.parse(fixture.now);
  for (const item of fixture.activityCases) assert.equal(analytics.classifyActivityV1(item, now), item.expected, item.id);
  assert.deepEqual(analytics.averageContributingSamplesV1(fixture.aggregation.periodSamples), fixture.aggregation.periodExpected);
  assert.deepEqual(analytics.sumSelectedDevicesPerHourV1(fixture.aggregation.hourSamples), fixture.aggregation.hourExpected);
  assert.deepEqual(analytics.averageDisplayedBucketsV1(fixture.aggregation.displayedBuckets), fixture.aggregation.summaryExpected);
  const invalid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/analytics-invalid-sample.json')));
  assert.throws(() => analytics.sumSelectedDevicesPerHourV1([invalid.sample]), /Invalid analytics sample/);
});
test('OS accepts canonical current-home permanent device descriptors', () => assert.equal(c.validateDevice(good.device, { ...good.context }), true));
test('OS rejects tenant-owned data for the wrong membership and wrong-home replay', () => {
  assert.equal(c.validateDevice(wrongOwner.device, { ...wrongOwner.context, role: 'TENANT' }), false);
  const ownTenantDevice = { ...wrongOwner.device, ownerMembershipId: wrongOwner.context.homeMembershipId };
  assert.equal(c.validateDevice(ownTenantDevice, { ...wrongOwner.context, role: 'TENANT' }), true);
  assert.equal(c.validateDevice(ownTenantDevice, { ...wrongOwner.context, role: 'OWNER' }), false);
  assert.equal(c.validateDevice(good.device, { homeId: 'home:other', homeMembershipId: good.context.homeMembershipId }), false);
});
test('OS control state is descriptor-bound and expires to Unknown at the exact deadline', () => {
  const device = good.device; const control = device.controls[0];
  const state = { deviceId: device.id, controlId: control.controlId, homeId: device.homeId, descriptorRevision: device.descriptorRevision, revision: 1, observedAt: '2026-09-27T10:00:00Z', receivedAt: '2026-09-27T10:00:01Z', validUntil: '2026-09-27T10:02:00Z', quality: 'fresh', value: true, deviceAvailability: 'online', analyticsActivity: 'on' };
  assert.equal(c.validateControlState(state, device, control), true);
  assert.equal(c.effectiveControlQuality(state, Date.parse(state.validUntil) - 1), 'fresh');
  assert.equal(c.effectiveControlQuality(state, Date.parse(state.validUntil)), 'unknown');
  assert.equal(c.validateControlState({ ...state, descriptorRevision: 3 }, device, control), false);
});
test('OS rejects stale descriptor command and unsupported envelope version', () => {
  assert.equal(c.validateEnvelope({ schemaVersion: 'dinodia.v0', homeId: 'home:a', generatedAt: new Date().toISOString(), revision: 1, data: [] }), false);
  const device = good.device; const control = device.controls[0];
  assert.equal(c.validateCommand({ homeId: device.homeId, homeMembershipId: good.context.homeMembershipId, deviceId: device.id, controlId: control.id, descriptorRevision: 3, idempotencyKey: '1234567890123456' }, device, control, good.context.homeMembershipId), false);
});
test('OS command validation enforces typed bounds, increments and sensitive proof references', () => {
  const brightness = good.device.controls.find((control) => control.controlId === 'control:brightness');
  const lock = good.device.controls.find((control) => control.controlId === 'control:lock');
  const command = (control, value, extra = {}) => ({ commandId: 'command:test', homeId: good.device.homeId, homeMembershipId: good.context.homeMembershipId, deviceId: good.device.id, controlId: control.controlId, descriptorRevision: good.device.descriptorRevision, value, issuedAt: '2026-09-27T10:00:00Z', idempotencyKey: 'idempotency-key-0001', ...extra });
  assert.equal(c.validateCommand(command(brightness, 25), good.device, brightness, good.context.homeMembershipId), true);
  for (const value of [100000, -1, 2.5, '50', NaN]) assert.equal(c.validateCommand(command(brightness, value), good.device, brightness, good.context.homeMembershipId), false);
  assert.equal(c.validateCommand(command(lock, true), good.device, lock, good.context.homeMembershipId), false);
  assert.equal(c.validateCommand(command(lock, true, { stepUpOperationId: 'step-up:one-use' }), good.device, lock, good.context.homeMembershipId), true);
  assert.equal(c.validateCommand(command(brightness, 25), good.device, { ...brightness, constraints: { ...brightness.constraints, maximum: 1000000 } }, good.context.homeMembershipId), false);
  const downgradedLock = { ...good.device, controls: good.device.controls.map((item) => item.controlId === lock.controlId ? { ...item, stepUpPolicy: 'none' } : item) };
  assert.equal(c.validateDevice(downgradedLock), false);
});
test('OS rejects noncanonical numeric precision and option descriptor extensions', () => {
  const base = structuredClone(good.device);
  const index = base.controls.findIndex((control) => control.valueType === 'number');
  assert.notEqual(index, -1);
  base.controls[index].constraints = { ...(base.controls[index].constraints || {}), precision: 13 };
  assert.equal(c.validateDevice(base), false);
  const options = structuredClone(good.device);
  const option = options.controls.find((control) => control.valueType === 'option');
  if (option) {
    option.constraints = { ...(option.constraints || {}), options: [{ value: 'x', label: 'X', adminOnly: true }] };
    assert.equal(c.validateDevice(options), false);
  }
});
test('OS serializes option controls with no declared choices as read-only', () => {
  const projected = c.serializeDevice({
    device: { id: 'device:enum', areaId: 'area:one', name: 'Mode', protocol: 'matter', setup: { status: 'complete' }, presentation: { descriptorRevision: 3 } },
    homeId: 'home:one', homeMembershipId: 'membership:tenant', role: 'TENANT', areaIds: ['area:one'],
    surfaces: [{ id: 'surface:mode', capability: { kind: 'enum', controlId: 'control:mode', semanticRole: 'operating_mode', bindings: [{ serviceId: 'climate.set_mode' }], writable: true, automatable: true }, expose: { values: [] } }],
  });
  assert.equal(projected.controls[0].valueType, 'option');
  assert.equal(projected.controls[0].writable, false);
  assert.equal(projected.controls[0].interactionKind, 'read_only');
});
test('custom presentation labels never infer control semantics and descriptor constraints are bounded', () => {
  const { serializeDevice } = c;
  const projected = serializeDevice({
    device: { id: 'device:custom', areaId: 'area:one', name: 'Door Lock', protocol: 'matter', setup: { status: 'complete' }, presentation: { descriptorRevision: 3 } },
    homeId: 'home:one', homeMembershipId: 'membership:tenant', role: 'TENANT', areaIds: ['area:one'],
    surfaces: [{ id: 'surface:one', name: 'Door Lock', capability: { kind: 'binary', controlId: 'control:one', semanticRole: 'unknown', display: { label: 'Door Lock', control: 'toggle' }, readable: true, writable: true, automatable: false, observable: true, bindings: [{ serviceId: 'switch.turn_on' }], catalogRevision: 3 } }],
  });
  assert.equal(projected.controls[0].label, 'Door Lock');
  assert.equal(projected.controls[0].semanticRole, 'unknown');
  assert.equal(projected.controls[0].stepUpPolicy, 'none');
  const malformed = structuredClone(good.device);
  malformed.controls[1].constraints = { minimum: 100, maximum: 10 };
  assert.equal(c.validateDevice(malformed), false);
  malformed.controls[1].constraints = { minimum: 0, maximum: 100, step: 0 };
  assert.equal(c.validateDevice(malformed), false);
});
