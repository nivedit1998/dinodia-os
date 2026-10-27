'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeDevice, validateDevice } = require('../src/contracts/dinodiaV1');

test('a write-only action cannot make an otherwise valid device disappear for a legacy v1 client', () => {
  const device = { id: 'device:fixture', areaId: 'area:fixture', name: 'Fixture device', protocol: 'zigbee',
    setup: { status: 'ready' }, presentation: { descriptorRevision: 1 } };
  const surfaces = [
    { id: 'surface:power', name: 'Power', capability: { controlId: 'control:power', kind: 'binary',
      semanticRole: 'power', readable: true, writable: true, observable: true,
      bindings: [{ serviceId: 'switch.turn_on' }, { serviceId: 'switch.turn_off' }] } },
    { id: 'surface:action', name: 'Action', capability: { controlId: 'control:action', kind: 'button',
      semanticRole: 'unknown', readable: false, writable: true, observable: false, idempotency: 'invoke',
      bindings: [{ serviceId: 'button.press' }] } },
  ];
  assert.ok(serializeDevice({ device, surfaces: surfaces.slice(0, 1), homeId: 'home:fixture',
    homeMembershipId: 'membership:fixture', role: 'TENANT', areaIds: ['area:fixture'] }),
  'the same device with its valid power control is a valid baseline');
  const dto = serializeDevice({ device, surfaces, homeId: 'home:fixture', homeMembershipId: 'membership:fixture',
    role: 'TENANT', areaIds: ['area:fixture'] });
  assert.ok(dto, 'an incompatible action must not discard the entire device');
  assert.equal(validateDevice(dto), true, 'the legacy descriptor must remain valid');
  assert.ok(dto.controls.some(control => control.controlId === 'control:power' && control.writable));
  const action = dto.controls.find(control => control.controlId === 'control:action');
  assert.ok(!action || action.writable === false && action.unsupportedReason,
    'legacy clients must not receive an unsafe writable-only action without version negotiation');
});
