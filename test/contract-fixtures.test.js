'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('../src/contracts/dinodiaV1');
const capabilitySchema = require('../src/capabilities/schema');
const analytics = require('../src/contracts/analyticsV1');
const root = path.join(__dirname, 'fixtures/contracts/dinodia-v1');
const good = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/multi-control-device.json')));
const wrongOwner = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/tenant-device-wrong-owner.json')));
test('OS applies shared Unicode-code-point bounds to descriptor strings and command values', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/bounded-string-unicode-semantics.json')));
  const device = good.device;
  const repeat = (item, count) => item.repeat.repeat(count);
  assert.equal(fixture.lengthUnit, 'unicode_code_points');
  for (const item of [...fixture.boundaryCases, ...fixture.combiningSequenceCases]) {
    const at = repeat(item, item.validRepeatCount);
    const over = repeat(item, item.invalidRepeatCount);
    if (item.field === 'opaqueId') {
      const withId = (id) => ({ ...device, id, controls: device.controls.map((control) => ({ ...control, deviceId: id })) });
      assert.equal(c.validateDevice(withId(at)), true, `${item.id} at limit`);
      assert.equal(c.validateDevice(withId(over)), false, `${item.id} over limit`);
    } else if (item.field === 'areaName') {
      const area = { id: 'area:living', homeId: device.homeId, originalName: at, overrideName: null, revision: 1, lifecycle: 'active' };
      assert.equal(c.validateArea(area, device.homeId), true, `${item.id} at limit`);
      assert.equal(c.validateArea({ ...area, originalName: over }, device.homeId), false, `${item.id} over limit`);
    } else if (item.field === 'controlLabel') {
      const withLabel = (label) => ({ ...device, controls: device.controls.map((control, index) => index ? control : { ...control, label }) });
      assert.equal(c.validateDevice(withLabel(at)), true, `${item.id} at limit`);
      assert.equal(c.validateDevice(withLabel(over)), false, `${item.id} over limit`);
    } else if (item.field === 'constraintUnit' || item.field === 'optionLabel') {
      const withConstraintText = (value) => ({ ...device, controls: [{ ...device.controls[0], valueType: 'option', interactionKind: 'picker', constraints: { unit: item.field === 'constraintUnit' ? value : 'mode', options: [{ value: 'on', label: item.field === 'optionLabel' ? value : 'On' }] } }] });
      assert.equal(c.validateDevice(withConstraintText(at)), true, `${item.id} at limit`);
      assert.equal(c.validateDevice(withConstraintText(over)), false, `${item.id} over limit`);
    } else if (item.field === 'textCommand' || item.field === 'idempotencyKey') {
      const commandFixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/command-valid.json')));
      const control = { ...device.controls[0], valueType: item.field === 'textCommand' ? 'text' : 'boolean', interactionKind: item.field === 'textCommand' ? 'text_input' : 'toggle' };
      const candidate = { ...device, controls: [control] };
      const command = (value, idempotencyKey) => ({ ...commandFixture, homeId: candidate.homeId, deviceId: candidate.id, controlId: control.controlId, descriptorRevision: candidate.descriptorRevision, value, idempotencyKey });
      const valueAt = item.field === 'textCommand' ? at : true;
      const valueOver = item.field === 'textCommand' ? over : true;
      const keyAt = item.field === 'idempotencyKey' ? at : commandFixture.idempotencyKey;
      const keyOver = item.field === 'idempotencyKey' ? over : commandFixture.idempotencyKey;
      assert.equal(c.validateCommand(command(valueAt, keyAt), candidate, control, commandFixture.homeMembershipId), true, `${item.id} at limit`);
      assert.equal(c.validateCommand(command(valueOver, keyOver), candidate, control, commandFixture.homeMembershipId), false, `${item.id} over limit`);
      if (item.invalidMinimumRepeatCount) assert.equal(c.validateCommand(command(true, repeat(item, item.invalidMinimumRepeatCount)), candidate, control, commandFixture.homeMembershipId), false, `${item.id} below minimum`);
    }
  }
});
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
test('OS reads the shared Stage 2 decision fixture and preserves membership, privacy, lifecycle, and offline boundaries', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/stage2-decision-matrix.json')));
  assert.equal(fixture.schemaVersion, c.VERSION);
  assert.equal(fixture.identity.customerIsEmployee, false);
  assert.equal(fixture.identity.activeOwnerMembershipIds.length, 1);
  assert.ok(fixture.identity.activeManagerMembershipIds.length > 1);
  assert.equal(fixture.identity.membershipCreatedForPendingInvitation, false);
  assert.deepEqual(fixture.tenantPrivacy.visibleToMembershipIds, [fixture.tenantPrivacy.ownerMembershipId]);
  assert.equal(fixture.tenantPrivacy.ownerCanRead || fixture.tenantPrivacy.managerCanRead || fixture.tenantPrivacy.otherTenantCanRead, false);
  assert.equal(fixture.tenantPrivacy.labelChangesAuthority, false);
  assert.equal(fixture.controls.staleOrOfflineCommandAllowed, false);
  assert.equal(fixture.controls.securityControlAutomatable, false);
  assert.equal(fixture.controls.securityControlAlexaExposed, false);
  assert.equal(fixture.automation.saveRequiresCurrentRevision, true);
  assert.equal(fixture.automation.staleRevisionIsRejectedWithoutMerge, true);
  assert.equal(fixture.automation.presentationLabelsGrantCapability, false);
  assert.equal(fixture.alexa.activeMembershipRole, 'TENANT');
  assert.equal(fixture.alexa.selectedAreaIdsAreAuthoritative, true);
  assert.equal(fixture.alexa.ownTenantDeviceEligible, true);
  assert.equal(fixture.alexa.otherTenantDeviceEligible, false);
  assert.equal(fixture.alexa.appOnlySecurityControlEligible, false);
  assert.equal(fixture.alexa.exposureGenerationMonotonic, true);
  assert.equal(fixture.trustedDevice.removalRevokesAccountInstallation, true);
  assert.equal(fixture.trustedDevice.offlineReenrollmentAllowed, false);
  assert.equal(fixture.provisioning.cloudUrlIndependentlyVerified, true);
  assert.equal(fixture.provisioning.manufacturingRootPrivateKeyOnHub, false);
  assert.equal(fixture.roomQr.claimReservationFirstWins, true);
  assert.equal(fixture.roomQr.installerSetupPresentationIsCustomerClaim, false);
  assert.deepEqual(fixture.support.categories, ['ACCOUNT_OR_SIGN_IN', 'ACCESS_OR_PERMISSIONS', 'DEVICE_PROBLEM', 'HUB_OR_CONNECTION', 'AUTOMATION', 'ALEXA', 'OTHER']);
  assert.equal(fixture.support.privateTenantDeviceTicketVisibleToOwner, false);
  assert.equal(fixture.support.infrastructureNoticeContainsTenantPrivateDetails, false);
  assert.deepEqual(fixture.notifications.channels, ['push', 'verified_email']);
  assert.equal(fixture.notifications.deliveryReceiptGrantsAuthority, false);
  assert.equal(fixture.offline.scopeCanWiden, false);
  assert.equal(fixture.offline.policyAppliedBeforeConnected, true);
});
test('OS accepts canonical current-home permanent device descriptors', () => assert.equal(c.validateDevice(good.device, { ...good.context }), true));
test('OS rejects negative area revisions and unsafe writable descriptor combinations', () => {
  assert.equal(c.validateArea({ id: 'area:test', homeId: 'home:opaque-a', originalName: 'Kitchen', overrideName: null, revision: -1, lifecycle: 'active' }, 'home:opaque-a'), false);
  const unreadableWritable = structuredClone(good.device);
  unreadableWritable.controls[0].readable = false;
  assert.equal(c.validateDevice(unreadableWritable), false);
  const safeUnknown = structuredClone(good.device);
  Object.assign(safeUnknown.controls[0], { interactionKind: 'vendor_future', writable: false, automatable: false, idempotency: 'none', confirmationPolicy: 'none', stepUpPolicy: 'none' });
  assert.equal(c.validateDevice(safeUnknown), true, 'unknown controls may remain only safe read-only metadata');
  safeUnknown.controls[0].writable = true;
  assert.equal(c.validateDevice(safeUnknown), false);
});
test('OS consumes the canonical unknown-interaction positive and commandable negative fixtures', () => {
  const safeFixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/unknown-interaction-kind.json')));
  assert.equal(c.validateDevice(safeFixture.device, { homeId: safeFixture.device.homeId, homeMembershipId: 'membership:owner-a', role: 'OWNER', areaIds: safeFixture.device.areaIds }), true);
  const negative = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/unknown-interaction-commandable.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, negative.sourceFixture)));
  const device = structuredClone(source.device);
  const control = device.controls.find((item) => item.controlId === negative.controlId);
  Object.assign(control, negative.mutation);
  assert.equal(c.validateDevice(device, { homeId: device.homeId, homeMembershipId: 'membership:owner-a', role: 'OWNER', areaIds: device.areaIds }), false, negative.expected);
});
test('OS consumes the shared negative area/state/control fixtures with strict descriptor semantics', () => {
  const negativeArea = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/area-negative-revision.json')));
  assert.equal(c.validateArea(negativeArea), false);
  const invalidState = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/control-state-boolean-string.json'))).data;
  const booleanControl = good.device.controls.find((control) => control.valueType === 'boolean');
  assert.equal(c.validateControlState(invalidState, good.device, booleanControl), false);
  const optionState = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/control-state-option-outside-descriptor.json')));
  const optionControl = optionState.device.controls.find((control) => control.controlId === optionState.state.controlId);
  assert.equal(c.validateDevice(optionState.device), true);
  assert.equal(c.validateControlState(optionState.validState, optionState.device, optionControl), true);
  assert.equal(c.validateControlState(optionState.state, optionState.device, optionControl), false,
    'option state must be a member of the current descriptor choices');
  const mutationFixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/writable-unreadable-control.json')));
  const device = structuredClone(JSON.parse(fs.readFileSync(path.join(root, mutationFixture.sourceFixture)))).device;
  const target = device.controls.find((control) => control.controlId === mutationFixture.mutation.controlId);
  Object.assign(target, mutationFixture.mutation);
  assert.equal(c.validateDevice(device), false);
  assert.equal(mutationFixture.expectedOutcome, 'reject_before_dispatch');
});
test('OS rejects duplicate control IDs through its Native V1 device validator', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/duplicate-device-control-id.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture)));
  const device = structuredClone(source.device);
  const target = device.controls.find((control) => control.controlId === mutation.targetControlId);
  assert.ok(target);
  assert.ok(device.controls.some((control) => control.controlId === mutation.duplicateControlId));
  target.controlId = mutation.duplicateControlId;
  assert.equal(mutation.expected, 'reject_descriptor_before_projection_or_dispatch');
  assert.equal(c.validateDevice(device, { homeId: device.homeId, homeMembershipId: source.context.homeMembershipId, role: 'OWNER', areaIds: device.areaIds }), false);
});
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
  assert.equal(c.validateControlState({ ...state, value: 'true' }, device, control), false, 'string is not a boolean reading');
});
test('OS rejects stale descriptor command and unsupported envelope version', () => {
  assert.equal(c.validateEnvelope({ schemaVersion: 'dinodia.v0', homeId: 'home:a', generatedAt: new Date().toISOString(), revision: 1, data: [] }), false);
  const impossibleDate = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/impossible-calendar-date-envelope.json')));
  assert.equal(c.validateEnvelope(impossibleDate), false, 'impossible Gregorian dates are not normalized into accepted timestamps');
  const device = good.device; const control = device.controls[0];
  assert.equal(c.validateCommand({ homeId: device.homeId, homeMembershipId: good.context.homeMembershipId, deviceId: device.id, controlId: control.id, descriptorRevision: 3, idempotencyKey: '1234567890123456' }, device, control, good.context.homeMembershipId), false);
});
test('OS command validator rejects impossible calendar dates but accepts valid UTC and leap-day instants', () => {
  const invalid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/impossible-calendar-date-command.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, invalid.sourceFixture || 'fixtures/command-valid.json')));
  const command = invalid.command || source;
  const control = good.device.controls.find((item) => item.controlId === command.controlId);
  assert.ok(control);
  assert.equal(c.validateCommand(command, good.device, control, command.homeMembershipId), false);
  assert.equal(invalid.expected, 'reject_before_dispatch');
  assert.equal(c.validateCommand({ ...command, issuedAt: '2026-02-28T23:59:59Z' }, good.device, control, command.homeMembershipId), true);
  assert.equal(c.validateCommand({ ...command, issuedAt: '2024-02-29T12:00:00Z' }, good.device, control, command.homeMembershipId), true);
  assert.equal(c.validateCommand({ ...command, issuedAt: '2025-02-29T12:00:00Z' }, good.device, control, command.homeMembershipId), false);
});
test('OS rejects descriptors missing the required step-up policy field', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/device-missing-step-up-policy.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture)));
  const device = structuredClone(source.device);
  const control = device.controls.find((item) => item.controlId === mutation.controlId);
  assert.ok(control);
  delete control[mutation.removeField];
  assert.equal(c.validateDevice(device), false);
});
test('OS rejects a step-up policy outside the canonical enum', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/device-invalid-step-up-policy.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture)));
  const device = structuredClone(source.device);
  const control = device.controls.find((item) => item.controlId === mutation.controlId);
  assert.ok(control);
  control[mutation.field] = mutation.invalidValue;
  assert.equal(c.validateDevice(device), false);
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
  assert.equal(c.validateCommand(command(brightness, 25), { ...good.device, lifecycle: 'retired' }, brightness, good.context.homeMembershipId), false);
  assert.equal(c.validateCommand(command(brightness, 25), { ...good.device, lifecycle: 'view_only' }, brightness, good.context.homeMembershipId), false);
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
test('OS serializer does not resurrect a cached surface after all declared source entities are removed', () => {
  const projected = c.serializeDevice({
    device: {
      id: 'device:removed-source', homeId: 'home:one', areaId: 'area:one', name: 'Removed control', protocol: 'matter',
      setup: { status: 'complete' }, presentation: { descriptorRevision: 2 }, entities: {},
    },
    homeId: 'home:one', homeMembershipId: 'membership:tenant', role: 'TENANT', areaIds: ['area:one'],
    surfaces: [{
      id: 'surface:removed-source', sourceEntityIds: ['control:removed'], name: 'Stale power',
      capability: { kind: 'binary', controlId: 'control:removed', semanticRole: 'power', readable: true, writable: true, bindings: [{ serviceId: 'switch.turn_on' }] },
    }],
  });
  assert.ok(projected, 'device identity may remain visible when its last source control disappears');
  assert.deepEqual(projected.controls, [], 'a stale surface descriptor is not a replacement authority for its removed source');
});
test('OS serializer maps an explicitly sensitive capability to mandatory step-up', () => {
  const controlId = 'control:sensitive-power';
  const projected = c.serializeDevice({
    device: {
      id: 'device:sensitive-switch', homeId: 'home:one', areaId: 'area:one', name: 'Sensitive switch', protocol: 'virtual',
      setup: { status: 'complete' }, presentation: { descriptorRevision: 4 },
      entities: {
        [controlId]: { id: controlId, name: 'Power', state: false, capability: {
          kind: 'binary', controlId, semanticRole: 'unknown', readable: true, writable: true, automatable: true,
          observable: true, sensitive: true, bindings: [{ serviceId: 'switch.turn_on' }], catalogRevision: 4,
        } },
      },
    },
    homeId: 'home:one', homeMembershipId: 'membership:tenant', role: 'TENANT', areaIds: ['area:one'],
    surfaces: [{ id: 'surface:sensitive-switch', sourceEntityIds: [controlId], name: 'Switch' }],
  });
  assert.ok(projected);
  assert.equal(projected.controls[0].stepUpPolicy, 'required');
  assert.equal(projected.controls[0].confirmationPolicy, 'step_up');
  assert.equal(projected.controls[0].riskLevel, 'sensitive');
  assert.equal(projected.controls[0].automatable, false);
});
test('OS capability normalization and manifest round-trip retain mandatory step-up policy', () => {
  const input = { runtime: 'dinodia_os', kind: 'binary', category: 'control', readable: true, writable: true, automatable: true, primary: true, semanticRole: 'power', sensitive: true, bindings: [{ serviceId: 'switch.turn_on' }] };
  const normalized = capabilitySchema.normalizeCapability(input);
  assert.equal(normalized.sensitive, true);
  assert.equal(normalized.stepUpPolicy, 'required');
  assert.equal(normalized.automatable, false);
  const manifest = capabilitySchema.manifestFromCapability(normalized);
  assert.equal(manifest.sensitive, true);
  assert.equal(manifest.stepUpPolicy, 'required');
  assert.equal(manifest.automatable, false);
  const decoded = capabilitySchema.validateManifest(manifest);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.manifest.sensitive, true);
  assert.equal(decoded.manifest.stepUpPolicy, 'required');
  assert.equal(decoded.manifest.automatable, false);
  for (const malformed of [
    { ...input, sensitive: 'false', stepUpPolicy: 'none' },
    { ...input, sensitive: false, stepUpPolicy: 'required-but-unrecognized' },
  ]) {
    const failClosed = capabilitySchema.normalizeCapability(malformed);
    assert.equal(failClosed.stepUpPolicy, 'required', 'malformed security metadata must not downgrade to no step-up');
    assert.equal(failClosed.automatable, false);
  }
});
test('OS serializer projects customer labels at the shared Unicode code-point boundary', () => {
  const fixture = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/contracts/dinodia-v1/fixtures/customer-label-unicode-boundaries.json'), 'utf8'));
  for (const item of fixture.cases) {
    const raw = typeof item.value === 'string' ? item.value : String(item.repeat || '').repeat(Number(item.repeatCount || 0));
    const controlId = 'control:label-fixture';
    const projected = c.serializeDevice({
      device: {
        id: 'device:label-fixture', areaId: 'area:one', name: raw, protocol: 'virtual', setup: { status: 'complete' },
        presentation: { descriptorRevision: 1 },
        entities: { [controlId]: { id: controlId, name: 'Power', capability: { kind: 'binary', controlId, semanticRole: 'power', readable: true, writable: false, observable: true } } },
      },
      homeId: 'home:one', homeMembershipId: 'membership:owner', role: 'OWNER', areaIds: ['area:one'],
      surfaces: [{ id: 'surface:one', sourceEntityIds: [controlId], name: 'Main' }],
    });
    const expected = raw.length === 0 ? null : Array.from(raw).slice(0, fixture.maximumPublicCodePoints).join('');
    assert.ok(projected, `serializer must preserve device identity for ${item.id}`);
    assert.equal(projected.customerLabel, expected, item.id);
    assert.equal(Array.from(projected.customerLabel || '').length, item.projectedCodePoints, item.id);
    assert.equal(projected.controls.length, 1, `label ${item.id} cannot remove controls`);
  }
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
