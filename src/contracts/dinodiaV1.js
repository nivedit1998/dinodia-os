'use strict';
const VERSION = 'dinodia.v1';
const roles = new Set(['OWNER', 'PROPERTY_MANAGER', 'TENANT']);
const interactions = new Set(['toggle', 'slider', 'thermostat', 'picker', 'text_input', 'momentary_action', 'read_only']);
const semanticRoles = new Set(['power','brightness','active_heat_demand','active_heat_production','target_temperature','ambient_temperature','opening_percentage','connectivity','security_lock','lock_state','operating_mode','position','volume','color','state','unknown']);
function isObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function codePointLength(value) { return Array.from(value).length; }
function isId(x) { return typeof x === 'string' && x.trim().length > 0 && codePointLength(x) <= 160; }
function truncateCodePoints(value, maximum) { return Array.from(value).slice(0, maximum).join(''); }
function isUtcTimestamp(x) {
  if (typeof x !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(x);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(x));
}
function hasOnlyKeys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
const deviceKeys = ['id','homeId','managementClass','ownerMembershipId','lifecycle','technicalLabel','customerLabel','areaIds','controls','descriptorRevision'];
const controlKeys = ['schemaVersion','deviceId','surfaceId','controlId','label','group','sortOrder','valueType','interactionKind','semanticRole','readable','writable','automatable','observable','idempotency','confirmationPolicy','riskLevel','stepUpPolicy','constraints','expectedReportingIntervalSeconds','maxStateValiditySeconds','unsupportedReason','catalogRevision'];
function validateEnvelope(value, homeId) {
  return isObject(value) && hasOnlyKeys(value, ['schemaVersion','homeId','streamId','sequence','generatedAt','revision','data']) && value.schemaVersion === VERSION && isId(value.homeId) && isId(value.streamId) && (!homeId || value.homeId === homeId) && Number.isInteger(value.sequence) && value.sequence >= 0 && Number.isInteger(value.revision) && value.revision >= 0 && isUtcTimestamp(value.generatedAt) && Object.hasOwn(value, 'data');
}
function validateMembership(value, homeId) {
  return isObject(value) && hasOnlyKeys(value, ['accountId','homeId','homeMembershipId','role','status','areaIds','revision']) && isId(value.accountId) && isId(value.homeId) && value.homeId === homeId && isId(value.homeMembershipId) && roles.has(value.role) && value.status === 'active' && Array.isArray(value.areaIds) && value.areaIds.every(isId) && new Set(value.areaIds).size === value.areaIds.length && Number.isInteger(value.revision) && value.revision >= 0;
}
function validateArea(value, homeId) {
  return isObject(value) && hasOnlyKeys(value, ['id','homeId','originalName','overrideName','revision','lifecycle']) && isId(value.id) && value.homeId === homeId && typeof value.originalName === 'string' && value.originalName.trim().length > 0 && codePointLength(value.originalName) <= 80 && (value.overrideName == null || typeof value.overrideName === 'string' && value.overrideName.trim().length > 0 && codePointLength(value.overrideName) <= 80) && Number.isInteger(value.revision) && value.revision >= 0 && ['active','retired'].includes(value.lifecycle);
}
function validateDevice(value, { homeId, homeMembershipId, role, areaIds } = {}) {
  if (!isObject(value) || !hasOnlyKeys(value, deviceKeys) || !isId(value.id) || !isId(value.homeId) || (homeId && value.homeId !== homeId) || !['property_device', 'tenant_device'].includes(value.managementClass) || !['commissioning','installed','view_only','retired'].includes(value.lifecycle) || !isId(value.technicalLabel) || codePointLength(value.technicalLabel) > 80 || !(value.customerLabel == null || typeof value.customerLabel === 'string' && codePointLength(value.customerLabel) <= 40) || !Array.isArray(value.controls) || value.controls.length > 64 || !Array.isArray(value.areaIds) || value.areaIds.length === 0 || new Set(value.areaIds).size !== value.areaIds.length || !Number.isInteger(value.descriptorRevision) || value.descriptorRevision < 0) return false;
  if (value.managementClass === 'tenant_device' && (role !== undefined && role !== 'TENANT' || value.ownerMembershipId !== homeMembershipId)) return false;
  if (value.managementClass === 'property_device' && value.ownerMembershipId != null) return false;
  if (!value.areaIds.every(isId) || (Array.isArray(areaIds) && value.areaIds.some((areaId) => !areaIds.includes(areaId)))) return false;
  const ids = new Set();
  return value.controls.every((c) => {
    if (!isObject(c) || !hasOnlyKeys(c, controlKeys) || c.schemaVersion !== 1 || c.deviceId !== value.id || !isId(c.controlId) || ids.has(c.controlId) || !(c.surfaceId == null || isId(c.surfaceId)) || typeof c.label !== 'string' || !c.label.trim() || codePointLength(c.label) > 80 || !(c.group == null || typeof c.group === 'string' && codePointLength(c.group) <= 80) || !semanticRoles.has(c.semanticRole) || typeof c.interactionKind !== 'string' || !c.interactionKind || codePointLength(c.interactionKind) > 64 || !['boolean','number','option','text','invoke'].includes(c.valueType) || !['set_value','invoke_once','none'].includes(c.idempotency) || !['none','matching_observation','explicit_user','step_up'].includes(c.confirmationPolicy) || !['low','normal','sensitive','critical'].includes(c.riskLevel) || !['none','required'].includes(c.stepUpPolicy) || !Number.isInteger(c.catalogRevision) || c.catalogRevision !== value.descriptorRevision || !Number.isInteger(c.sortOrder) || c.sortOrder < 0 || typeof c.writable !== 'boolean' || typeof c.readable !== 'boolean' || c.writable && !c.readable || typeof c.automatable !== 'boolean' || typeof c.observable !== 'boolean' || !(c.unsupportedReason == null || typeof c.unsupportedReason === 'string' && codePointLength(c.unsupportedReason) <= 120) || !validConstraints(c.constraints)) return false;
    if (!interactions.has(c.interactionKind) && (c.writable || c.automatable || c.idempotency !== 'none' || c.confirmationPolicy !== 'none' || c.stepUpPolicy !== 'none')) return false;
    if (c.valueType === 'option' && c.writable && (!Array.isArray(c.constraints?.options) || c.constraints.options.length === 0)) return false;
    if (c.observable && (!(Number.isInteger(c.expectedReportingIntervalSeconds) && c.expectedReportingIntervalSeconds > 0) || !(Number.isInteger(c.maxStateValiditySeconds) && c.maxStateValiditySeconds > 0))) return false;
    if (c.stepUpPolicy === 'required' && c.automatable) return false;
    if (['security_lock','lock_state'].includes(c.semanticRole) && (c.stepUpPolicy !== 'required' || c.automatable)) return false;
    ids.add(c.controlId); return true;
  });
}
function validConstraints(value) {
  if (value === undefined) return true;
  if (!isObject(value) || !hasOnlyKeys(value, ['minimum','maximum','step','precision','unit','options'])) return false;
  if (value.minimum !== undefined && !Number.isFinite(value.minimum) || value.maximum !== undefined && !Number.isFinite(value.maximum)) return false;
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) return false;
  if (value.step !== undefined && !(Number.isFinite(value.step) && value.step > 0)) return false;
  if (value.precision !== undefined && !(Number.isInteger(value.precision) && value.precision >= 0 && value.precision <= 12)) return false;
  if (value.unit !== undefined && !(typeof value.unit === 'string' && codePointLength(value.unit) <= 32)) return false;
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 128 || value.options.some((option) => !isObject(option) || !hasOnlyKeys(option, ['value','label']) || !Object.hasOwn(option, 'value') || typeof option.label !== 'string' || codePointLength(option.label) > 80) || new Set(value.options.map((option) => JSON.stringify(option.value))).size !== value.options.length)) return false;
  return true;
}
function sameJsonValue(a, b) {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return false;
  const ak = Object.keys(a).sort(); const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && sameJsonValue(a[key], b[key]));
}
function commandValueMatches(control, value) {
  if (control.valueType === 'boolean') return typeof value === 'boolean';
  if (control.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const bounds = control.constraints || {};
    const min = Number.isFinite(bounds.minimum) ? bounds.minimum : -Infinity;
    const max = Number.isFinite(bounds.maximum) ? bounds.maximum : Infinity;
    if (value < min || value > max) return false;
    if (bounds.step !== undefined) {
      if (!Number.isFinite(bounds.step) || bounds.step <= 0) return false;
      const base = Number.isFinite(min) ? min : 0;
      if (Math.abs((value - base) / bounds.step - Math.round((value - base) / bounds.step)) > 1e-8) return false;
    }
    if (Number.isInteger(bounds.precision) && Math.abs(value * 10 ** bounds.precision - Math.round(value * 10 ** bounds.precision)) > 1e-8) return false;
    return true;
  }
  if (control.valueType === 'option') return Array.isArray(control.constraints?.options) && control.constraints.options.some((option) => isObject(option) && sameJsonValue(option.value, value));
  if (control.valueType === 'text') return typeof value === 'string' && codePointLength(value) <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  return control.valueType === 'invoke' && value === null;
}
function validateCommand(command, device, control, membershipId) {
  if (!isObject(command) || !hasOnlyKeys(command, ['commandId','homeId','homeMembershipId','deviceId','controlId','descriptorRevision','value','issuedAt','idempotencyKey','stepUpOperationId'])) return false;
  if (typeof command.idempotencyKey !== 'string' || codePointLength(command.idempotencyKey) < 16 || codePointLength(command.idempotencyKey) > 160) return false;
  const currentControl = device.controls.find((candidate) => candidate.controlId === control.controlId && candidate.deviceId === control.deviceId);
  if (!validateDevice(device, { homeId: device.homeId, homeMembershipId: membershipId, role: 'TENANT' }) || !currentControl || !sameJsonValue(currentControl, control)) return false;
  const requiresStepUp = control.stepUpPolicy === 'required' || ['security_lock','lock_state'].includes(control.semanticRole);
  return device.lifecycle === 'installed' && isId(command.commandId) && command.homeId === device.homeId && command.homeMembershipId === membershipId && command.deviceId === device.id && command.controlId === control.controlId && Number.isInteger(command.descriptorRevision) && command.descriptorRevision >= 0 && command.descriptorRevision === device.descriptorRevision && command.descriptorRevision === control.catalogRevision && control.readable && control.writable && control.interactionKind !== 'read_only' && commandValueMatches(control, command.value) && isUtcTimestamp(command.issuedAt) && typeof command.idempotencyKey === 'string' && codePointLength(command.idempotencyKey) >= 16 && codePointLength(command.idempotencyKey) <= 160 && (!requiresStepUp || isId(command.stepUpOperationId));
}
function validateControlState(value, device, control) {
  if (!isObject(value) || !hasOnlyKeys(value, ['deviceId','controlId','homeId','descriptorRevision','revision','observedAt','receivedAt','validUntil','quality','value','deviceAvailability','analyticsActivity'])) return false;
  const observed = value.observedAt == null ? NaN : Date.parse(value.observedAt);
  const received = value.receivedAt == null ? NaN : Date.parse(value.receivedAt);
  const validUntil = value.validUntil == null ? NaN : Date.parse(value.validUntil);
  const valueMatches = value.value === null
    ? ['unknown','unavailable'].includes(value.quality)
    : commandValueMatches(control, value.value);
  const noObservation = value.observedAt == null;
  const timesValid = noObservation
    ? value.validUntil == null && ['unknown','unavailable'].includes(value.quality) && value.value === null && value.analyticsActivity === 'unknown' && (value.receivedAt == null || isUtcTimestamp(value.receivedAt))
    : isUtcTimestamp(value.observedAt) && isUtcTimestamp(value.receivedAt) && isUtcTimestamp(value.validUntil) && Number.isFinite(observed) && Number.isFinite(received) && Number.isFinite(validUntil) && received >= observed && validUntil > observed && Number.isInteger(control.maxStateValiditySeconds) && validUntil - observed <= control.maxStateValiditySeconds * 1000;
  return value.deviceId === device.id && value.controlId === control.controlId && value.homeId === device.homeId && value.descriptorRevision === device.descriptorRevision && value.descriptorRevision === control.catalogRevision && Number.isInteger(value.revision) && value.revision >= 0 && timesValid && ['fresh','stale','unknown','unavailable'].includes(value.quality) && valueMatches && ['online','offline','unknown'].includes(value.deviceAvailability) && ['on','off','unknown'].includes(value.analyticsActivity);
}
function effectiveControlQuality(state, now = Date.now()) {
  const validUntil = Date.parse(state.validUntil);
  return !Number.isFinite(validUntil) || validUntil <= now ? 'unknown' : state.quality;
}
function serializeDevice({ device, homeId, homeMembershipId, role, areaIds, surfaces, revision = 0 }) {
  if (!isObject(device) || !Array.isArray(surfaces)) return null;
  const metadata = isObject(device.metadata) ? device.metadata : {};
  const managementClass = device.managementClass === 'tenant_device' || metadata.managementClass === 'tenant_device' || Boolean(device.tenantOwnerMembershipId || metadata.tenantOwnerMembershipId) ? 'tenant_device' : 'property_device';
  const ownerMembershipId = managementClass === 'tenant_device'
    ? String(device.tenantOwnerMembershipId || metadata.tenantOwnerMembershipId || '') || null
    : null;
  const areaId = String(device.areaId || metadata.areaId || '');
  const descriptorRevision = Number(device.presentation?.descriptorRevision || device.descriptorRevision || revision);
  if (!areaId || !Number.isInteger(descriptorRevision) || descriptorRevision < 0) return null;
  const sourceById = new Map(Object.values(device.entities || {}).flatMap((entity) => {
    if (!isObject(entity)) return [];
    return [[String(entity.id || entity.sourceId || entity.stateKey || entity.name || ''), entity]];
  }).filter(([id]) => id));
  const controls = [];
  const seenControlIds = new Set();
  for (const surface of surfaces) {
    const sourceIds = Array.isArray(surface.sourceEntityIds) ? surface.sourceEntityIds.map(String) : [];
    const sources = sourceIds.map((id) => sourceById.get(id)).filter(Boolean);
    // Preserve one row per adapter-declared control. A rendered surface can
    // combine power, brightness, mode and setpoint, but the wire contract must
    // not collapse those independent controls into a lossy `composite` value.
    // A surface with declared source entities is not itself a fallback
    // authority. If every source was removed, projecting the cached surface
    // would resurrect its old control ID and bindings. Only source-less
    // adapter surfaces may use their own descriptor as the source.
    const sourceControls = sources.length ? sources : sourceIds.length === 0 ? [surface] : [];
    for (const source of sourceControls) {
      const capability = isObject(source.capability) ? source.capability : {};
      const bindings = Array.isArray(capability.bindings) ? capability.bindings : [];
      const controlId = String(capability.controlId || source.controlId || source.id || surface.id || '');
      if (!controlId || seenControlIds.has(controlId)) continue;
      seenControlIds.add(controlId);
      const nativeRole = semanticRoles.has(String(capability.semanticRole)) ? String(capability.semanticRole) : 'unknown';
      const kind = String(capability.kind || (typeof source.state === 'boolean' ? 'binary' : typeof source.state === 'number' ? 'number' : 'text'));
      const valueType = kind === 'binary' ? 'boolean' : kind === 'number' ? 'number' : kind === 'enum' ? 'option' : kind === 'button' || kind === 'event' ? 'invoke' : 'text';
      const rawConstraints = isObject(capability.constraints) ? capability.constraints : {};
      const rawOptions = Array.isArray(rawConstraints.options) ? rawConstraints.options : Array.isArray(source.expose?.values) ? source.expose.values : [];
      const options = rawOptions.map((option) => isObject(option) && Object.hasOwn(option, 'value')
        ? { value: option.value, label: String(option.label || option.value).slice(0, 80) }
        : { value: option, label: String(option).slice(0, 80) });
      const writable = capability.writable === true && bindings.length > 0 && !(valueType === 'option' && options.length === 0);
      const interactionKind = !writable ? 'read_only' : valueType === 'boolean' ? 'toggle' : valueType === 'number' ? (nativeRole === 'target_temperature' ? 'thermostat' : 'slider') : valueType === 'option' ? 'picker' : valueType === 'invoke' ? 'momentary_action' : 'text_input';
      const stepUpPolicy = capability.stepUpPolicy === 'required' || capability.sensitive === true || ['security_lock','lock_state'].includes(nativeRole) ? 'required' : 'none';
      const revisionForControl = Number(capability.catalogRevision ?? descriptorRevision);
      const constraints = {
        ...(Number.isFinite(rawConstraints.min) ? { minimum: rawConstraints.min } : {}),
        ...(Number.isFinite(rawConstraints.max) ? { maximum: rawConstraints.max } : {}),
        ...(Number.isFinite(rawConstraints.step) && rawConstraints.step > 0 ? { step: rawConstraints.step } : {}),
        ...(Number.isInteger(rawConstraints.precision) ? { precision: rawConstraints.precision } : {}),
        ...(typeof capability.unit === 'string' ? { unit: capability.unit.slice(0, 32) } : {}),
        ...(options.length ? { options } : {}),
      };
      controls.push({
        schemaVersion: 1,
        deviceId: String(device.id),
        surfaceId: String(surface.id || '') || null,
        controlId,
        label: String(source.name || source.original_name || surface.name || capability.semanticRole || 'Control').slice(0, 80),
        // Legacy device/room names may exceed the public descriptor bound.
        // Bound presentation metadata without dropping device identity or
        // any of its independently validated controls.
        group: String(surface.name || surface.domain || '').slice(0, 80) || null,
        sortOrder: controls.length,
        valueType,
        interactionKind,
        semanticRole: nativeRole,
        readable: capability.readable !== false,
        writable,
        automatable: capability.automatable === true && stepUpPolicy !== 'required',
        observable: capability.observable !== false,
        idempotency: capability.idempotency === 'invoke' ? 'invoke_once' : writable ? 'set_value' : 'none',
        confirmationPolicy: stepUpPolicy === 'required' ? 'step_up' : writable ? 'matching_observation' : 'none',
        riskLevel: stepUpPolicy === 'required' ? 'sensitive' : writable ? 'normal' : 'low',
        stepUpPolicy,
        ...(Object.keys(constraints).length ? { constraints } : {}),
        ...(capability.observable !== false ? { expectedReportingIntervalSeconds: Number.isInteger(capability.expectedReportingIntervalSeconds) ? capability.expectedReportingIntervalSeconds : 120, maxStateValiditySeconds: Number.isInteger(capability.maxStateValiditySeconds) ? capability.maxStateValiditySeconds : 420 } : {}),
        unsupportedReason: null,
        catalogRevision: revisionForControl,
      });
    }
  }
  const result = {
    id: String(device.id), homeId: String(homeId), managementClass, ownerMembershipId,
    lifecycle: device.retired === true ? 'retired' : ['ready','complete'].includes(String(device.setup?.status || '')) ? 'installed' : 'commissioning',
    technicalLabel: String(device.protocol || 'device').slice(0, 80),
    // Legacy/internal display names can predate the public 40-character
    // contract. Bound the projection rather than dropping the device DTO.
    customerLabel: truncateCodePoints(String(device.name || ''), 40) || null,
    areaIds: [areaId], controls, descriptorRevision,
  };
  return validateDevice(result, { homeId, homeMembershipId, role, areaIds }) ? result : null;
}
function makeEnvelope({ homeId, streamId, sequence, generatedAt, revision, data }) {
  const value = { schemaVersion: VERSION, homeId, streamId, sequence, generatedAt, revision, data };
  return validateEnvelope(value, homeId) ? value : null;
}
module.exports = { VERSION, validateEnvelope, validateMembership, validateArea, validateDevice, validateCommand, validateControlState, effectiveControlQuality, serializeDevice, makeEnvelope };
