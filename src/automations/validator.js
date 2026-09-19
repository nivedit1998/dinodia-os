const {
  LIMITS,
  NATIVE_AUTOMATION_SCHEMA_VERSION,
  HEALTH_STATES,
} = require("./constants");
const {
  clone,
  hasControlCharacters,
  makeActionId,
  makeAutomationId,
  makeTriggerId,
  normalizeName,
  normalizeOwner,
  normalizeTargetValue,
  normalizeTriggerInput,
} = require("./domain");

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function validationError(message, code = "validation_error", details = []) {
  return Object.assign(new Error(message), { statusCode: 422, code, details });
}

function validateTimeZone(value) {
  const timeZoneIdentifier = String(value || "").trim();
  if (!timeZoneIdentifier || timeZoneIdentifier.includes("/../") || /^UTC[+-]/i.test(timeZoneIdentifier)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timeZoneIdentifier }).format();
    return true;
  } catch {
    return false;
  }
}

function validateSchedule(payload) {
  const errors = [];
  const minute = Number(payload?.minuteOfDay);
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439) errors.push(issue("invalid_minute_of_day", "Choose a time between 00:00 and 23:59."));
  if (!Array.isArray(payload?.weekdays) || payload.weekdays.length === 0 || payload.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) errors.push(issue("invalid_weekdays", "Choose at least one weekday using ISO Monday-to-Sunday values."));
  if (!validateTimeZone(payload?.timeZoneIdentifier)) errors.push(issue("invalid_timezone", "Use a valid IANA time zone identifier."));
  return errors;
}

function structuralValidate({ input, homeId, owner, existing = null } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const errors = [];
  if (source.schemaVersion !== undefined && Number(source.schemaVersion) !== NATIVE_AUTOMATION_SCHEMA_VERSION) errors.push(issue("unsupported_schema", "Unsupported native automation schema version."));
  const name = normalizeName(source.name);
  if (!name) errors.push(issue("invalid_name", "Automation name is required."));
  if (hasControlCharacters(String(source.name || ""))) errors.push(issue("invalid_name", "Automation name contains a control character."));
  const schedule = normalizeTriggerInput(source.trigger || source.triggers?.[0] || {});
  if (schedule.type !== "schedule") errors.push(issue("unsupported_trigger", "Native V1 automations support one schedule trigger."));
  errors.push(...validateSchedule(schedule.payload));
  const actions = Array.isArray(source.actions) ? source.actions : [];
  if (actions.length === 0) errors.push(issue("missing_actions", "Add at least one device action."));
  if (actions.length > LIMITS.maxActionsPerAutomation) errors.push(issue("too_many_actions", `An automation can contain at most ${LIMITS.maxActionsPerAutomation} actions.`));
  const actionIds = new Set();
  const actionPairs = new Set();
  const normalizedActions = actions.map((item, index) => {
    const action = item && typeof item === "object" ? item : {};
    const actionId = String(action.id || "").trim() || makeActionId();
    if (actionIds.has(actionId)) errors.push(issue("duplicate_action_id", "Action IDs must be unique.", { actionId }));
    actionIds.add(actionId);
    const deviceId = String(action.deviceId || action.device_id || "").trim();
    const controlId = String(action.controlId || action.control_id || "").trim();
    if (!deviceId || !controlId) errors.push(issue("invalid_action_target", "Every action needs a device and control."));
    const pair = `${deviceId}\u0000${controlId}`;
    if (actionPairs.has(pair)) errors.push(issue("duplicate_action_target", "The same device control may only appear once in an automation.", { deviceId, controlId }));
    actionPairs.add(pair);
    return {
      schemaVersion: NATIVE_AUTOMATION_SCHEMA_VERSION,
      id: actionId,
      deviceId,
      controlId,
      targetValue: normalizeTargetValue(action.targetValue || action.target || action.value),
      sortOrder: index,
    };
  });
  const expectedOwner = normalizeOwner(owner, { type: "local_admin", subjectId: "local-admin" });
  const normalizedHomeId = String(homeId || "").trim();
  if (!normalizedHomeId) errors.push(issue("missing_home", "A trusted home context is required."));
  if (existing && existing.homeId && normalizedHomeId && existing.homeId !== normalizedHomeId) errors.push(issue("home_mismatch", "The automation belongs to another home."));
  return {
    errors,
    name,
    trigger: {
      schemaVersion: NATIVE_AUTOMATION_SCHEMA_VERSION,
      id: String(source.trigger?.id || source.triggers?.[0]?.id || "").trim() || makeTriggerId(),
      type: "schedule",
      payload: schedule.payload,
    },
    actions: normalizedActions,
    owner: expectedOwner,
    homeId: normalizedHomeId,
    enabled: source.enabled !== false,
  };
}

function validateAgainstCatalogue(definition, catalogue = [], { authorizedDeviceIds = null } = {}) {
  const errors = [];
  const allowed = authorizedDeviceIds ? new Set([...authorizedDeviceIds].map(String)) : null;
  const byDevice = new Map((catalogue || []).map((device) => [String(device.deviceId), device]));
  for (const action of definition.actions || []) {
    if (allowed && !allowed.has(String(action.deviceId))) errors.push(issue("forbidden_device", "This principal cannot automate that device.", { actionId: action.id, deviceId: action.deviceId }));
    const device = byDevice.get(String(action.deviceId));
    if (!device) {
      errors.push(issue("missing_device", "The selected device is no longer available.", { actionId: action.id, deviceId: action.deviceId }));
      continue;
    }
    if (!device.configured) errors.push(issue("unconfigured_device", "The device must be configured before it can be automated.", { actionId: action.id, deviceId: action.deviceId }));
    const control = (device.controls || []).find((candidate) => String(candidate.controlId) === String(action.controlId));
    if (!control) {
      errors.push(issue("missing_control", "The selected control is no longer available.", { actionId: action.id, controlId: action.controlId }));
      continue;
    }
    if (control.writable !== true || control.allowsAutomation !== true) errors.push(issue("control_not_automatable", "The selected control is not safe for automation.", { actionId: action.id, controlId: action.controlId }));
    const value = action.targetValue || {};
    if (value.type !== control.valueType) errors.push(issue("invalid_value_type", `${control.label || "This control"} expects a ${control.valueType} value.`, { actionId: action.id }));
    if (value.type === "number") {
      const number = Number(value.number);
      const constraints = control.constraints || {};
      if (!Number.isFinite(number)) errors.push(issue("invalid_number", "Numeric targets must be finite.", { actionId: action.id }));
      if (constraints.minimum !== undefined && number < Number(constraints.minimum)) errors.push(issue("number_below_minimum", "The numeric target is below the allowed minimum.", { actionId: action.id }));
      if (constraints.maximum !== undefined && number > Number(constraints.maximum)) errors.push(issue("number_above_maximum", "The numeric target is above the allowed maximum.", { actionId: action.id }));
      if (constraints.step && Number.isFinite(number) && Math.abs((number - Number(constraints.minimum || 0)) / Number(constraints.step) - Math.round((number - Number(constraints.minimum || 0)) / Number(constraints.step))) > 1e-8) errors.push(issue("number_wrong_step", "The numeric target does not match the control step.", { actionId: action.id }));
    }
    if (value.type === "option" && !(control.constraints?.options || []).map(String).includes(String(value.option))) errors.push(issue("invalid_option", "Choose one of the current control options.", { actionId: action.id }));
  }
  return errors;
}

function normalizeDefinition({ input, existing = null, homeId, owner } = {}) {
  const structural = structuralValidate({ input, existing, homeId, owner });
  if (structural.errors.length) throw validationError(structural.errors[0].message, structural.errors[0].code, structural.errors);
  const now = new Date().toISOString();
  const automation = {
    schemaVersion: NATIVE_AUTOMATION_SCHEMA_VERSION,
    id: existing?.id || String(input?.id || "").trim() || makeAutomationId(),
    homeId: structural.homeId,
    owner: structural.owner,
    name: structural.name,
    enabled: structural.enabled,
    revision: existing ? Number(existing.revision || 1) : 1,
    source: "native_v2",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const trigger = { ...structural.trigger, automationId: automation.id };
  const actions = structural.actions.map((action, index) => ({ ...action, automationId: automation.id, sortOrder: index }));
  return { automation, trigger, actions };
}

function healthFromIssues(issues = [], nextRunAt = null) {
  const list = Array.isArray(issues) ? issues : [];
  const state = list.some((item) => ["forbidden_device", "unauthorized_device"].includes(item.code)) ? "suspended" : list.length ? "needs_attention" : "ready";
  return { state: HEALTH_STATES.includes(state) ? state : "needs_attention", executable: list.length === 0, issues: clone(list), nextRunAt: nextRunAt || null, lastValidatedAt: new Date().toISOString() };
}

module.exports = { healthFromIssues, issue, normalizeDefinition, structuralValidate, validateAgainstCatalogue, validateSchedule, validateTimeZone, validationError };
