const crypto = require("node:crypto");
const { clone, normalizeTargetValue, normalizeTriggerInput } = require("./domain");
const { NATIVE_AUTOMATION_SCHEMA_VERSION } = require("./constants");

function deterministicId(prefix, value) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function nativeCandidate(legacy, homeId = "local-home") {
  if (!legacy || typeof legacy !== "object" || legacy.schemaVersion !== NATIVE_AUTOMATION_SCHEMA_VERSION) return null;
  const triggerSource = legacy.trigger || (Array.isArray(legacy.triggers) ? legacy.triggers[0] : null);
  const trigger = normalizeTriggerInput(triggerSource || {});
  if (trigger.type !== "schedule") return null;
  const actions = Array.isArray(legacy.actions) ? legacy.actions : [];
  if (!actions.length || actions.some((action) => !action?.deviceId || !action?.controlId || !action?.targetValue)) return null;
  const id = deterministicId("automation", legacy.id || legacy.name || legacy);
  const triggerId = deterministicId("trigger", `${id}:${JSON.stringify(trigger.payload)}`);
  const automation = {
    schemaVersion: 1,
    id,
    homeId: String(legacy.homeId || homeId),
    owner: clone(legacy.owner || { type: "local_admin", subjectId: "migration" }),
    name: String(legacy.name || "Migrated automation").trim().slice(0, 60),
    enabled: legacy.enabled !== false,
    revision: Number(legacy.revision || 1),
    source: "native_v2_migrated",
    createdAt: legacy.createdAt || legacy.updatedAt || new Date(0).toISOString(),
    updatedAt: legacy.updatedAt || new Date(0).toISOString(),
  };
  const normalizedTrigger = { schemaVersion: 1, id: triggerId, automationId: id, type: "schedule", payload: clone(trigger.payload) };
  const normalizedActions = actions.map((action, index) => ({
    schemaVersion: 1,
    id: deterministicId("action", `${id}:${action.id || index}:${action.deviceId}:${action.controlId}`),
    automationId: id,
    deviceId: String(action.deviceId),
    controlId: String(action.controlId),
    targetValue: normalizeTargetValue(action.targetValue),
    sortOrder: index,
  }));
  return { automation, trigger: normalizedTrigger, actions: normalizedActions };
}

function migrateLegacyAutomations(legacyMap = {}, homeId = "local-home") {
  const native = { automations: {}, automationTriggers: {}, automationActions: {}, legacyAutomations: {}, report: { native: 0, legacy: 0, rejected: 0 } };
  for (const [legacyId, value] of Object.entries(legacyMap || {})) {
    const candidate = nativeCandidate(value, homeId);
    if (!candidate) {
      native.legacyAutomations[legacyId] = clone(value);
      native.report.legacy += 1;
      if (value && typeof value === "object" && Number(value.schemaVersion) === NATIVE_AUTOMATION_SCHEMA_VERSION) native.report.rejected += 1;
      continue;
    }
    const { automation, trigger, actions } = candidate;
    native.automations[automation.id] = automation;
    native.automationTriggers[trigger.id] = trigger;
    for (const action of actions) native.automationActions[action.id] = action;
    native.report.native += 1;
  }
  return native;
}

module.exports = { deterministicId, migrateLegacyAutomations, nativeCandidate };
