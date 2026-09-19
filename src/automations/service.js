const { LIMITS } = require("./constants");
const { checksum, clone, makeAutomationId, normalizeName, normalizeOwner } = require("./domain");
const { buildControlCatalog, publicCatalog } = require("./controlCatalog");
const { nextRunAt } = require("./schedule");
const { projectAutomation } = require("./health");
const { normalizeDefinition, validateAgainstCatalogue, validationError } = require("./validator");

function serviceError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function requestContext(context = {}) {
  return {
    homeId: String(context.homeId || "local-home"),
    owner: normalizeOwner(context.owner, { type: "local_admin", subjectId: "local-admin" }),
    canManageAutomations: context.canManageAutomations !== false,
    authorizedDeviceIds: context.authorizedDeviceIds ? new Set([...context.authorizedDeviceIds].map(String)) : null,
  };
}

class AutomationService {
  constructor({ store, getDevices, getAreas, getLabels, logger = console, activity, homeId, now = () => new Date() } = {}) {
    if (!store) throw new Error("AutomationService requires a store");
    this.store = store;
    this.getDevices = getDevices || (() => store.listDevices());
    this.getAreas = getAreas || (() => store.listAreas?.() || []);
    this.getLabels = getLabels || (() => store.listLabels?.() || []);
    this.logger = logger;
    this.activity = activity;
    this.homeId = homeId || (() => store.getIdentity?.()?.instanceId || store.getIdentity?.()?.serial || "local-home");
    this.now = now;
  }

  context(context = {}) {
    return requestContext({ ...context, homeId: context.homeId || (typeof this.homeId === "function" ? this.homeId() : this.homeId) });
  }

  internalCatalogue(context = {}) {
    const areas = new Map((this.getAreas() || []).map((area) => [String(area.id), area]));
    const labels = new Map((this.getLabels() || []).map((label) => [String(label.id), label]));
    let catalogue = buildControlCatalog({ devices: this.getDevices() || [], getArea: (id) => areas.get(String(id)), getLabel: (id) => labels.get(String(id)) });
    const allowed = context.authorizedDeviceIds;
    if (allowed) catalogue = catalogue.filter((device) => allowed.has(String(device.deviceId)));
    return catalogue;
  }

  catalogue(context = {}) {
    return publicCatalog(this.internalCatalogue(this.context(context)));
  }

  catalog(context = {}) { return this.catalogue(context); }

  stored(id) { return this.store.getNativeAutomation(String(id || "")); }

  projected(id, context = {}, record = null) {
    const value = record || this.stored(id);
    if (!value) return null;
    const ctx = this.context(context);
    if (value.automation.homeId && value.automation.homeId !== ctx.homeId) return null;
    const next = value.automation.enabled ? nextRunAt(value.automation, value.trigger, this.now()) : null;
    const projection = projectAutomation({ ...value, catalogue: this.internalCatalogue(ctx), authorizedDeviceIds: ctx.authorizedDeviceIds, nextRunAt: next });
    const lastExecution = (this.store.state.automationExecutions || []).find((execution) => execution.automationId === value.automation.id);
    return { ...projection, lastExecution: lastExecution ? clone(lastExecution) : null };
  }

  list(context = {}) {
    const ctx = this.context(context);
    const native = this.store.listNativeAutomations().map((automation) => this.projected(automation.id, ctx)).filter(Boolean);
    const triggers = native.map((item) => item.trigger).filter(Boolean);
    const actions = native.flatMap((item) => item.actions || []);
    const projections = native.map((item) => ({ automationId: item.id, triggerSummary: item.trigger?.payload ? `At ${String(Math.floor(item.trigger.payload.minuteOfDay / 60)).padStart(2, "0")}:${String(item.trigger.payload.minuteOfDay % 60).padStart(2, "0")}` : "Schedule", actionSummary: `${item.actions?.length || 0} action${item.actions?.length === 1 ? "" : "s"} · ${new Set((item.actions || []).map((action) => action.deviceId)).size} device${new Set((item.actions || []).map((action) => action.deviceId)).size === 1 ? "" : "s"}`, nextRunAt: item.health?.nextRunAt || null, health: item.health, lastExecution: (this.store.state.automationExecutions || []).find((execution) => execution.automationId === item.id) || null }));
    return { schemaVersion: 1, automations: native, triggers, actions, projections, legacyAutomations: this.store.listAutomations(), mode: "native_v2" };
  }

  detail(id, context = {}) {
    const result = this.projected(id, context);
    if (!result) throw serviceError("Automation not found", 404, "not_found");
    return result;
  }

  assertCanManage(context) {
    if (!context.canManageAutomations) throw serviceError("This principal cannot manage automations", 403, "forbidden");
  }

  async create(input, context = {}, { idempotencyKey = "" } = {}) {
    const ctx = this.context(context);
    this.assertCanManage(ctx);
    const key = String(idempotencyKey || "").trim().slice(0, 128);
    const idempotencyId = key ? `${ctx.homeId}:${ctx.owner.type}:${ctx.owner.subjectId}:${key}` : "";
    const requestChecksum = checksum(input || {});
    if (idempotencyId && this.store.state.automationIdempotency?.[idempotencyId]) {
      const cached = this.store.state.automationIdempotency[idempotencyId];
      if (cached.requestChecksum !== requestChecksum) throw serviceError("This idempotency key was already used for another automation", 409, "idempotency_conflict");
      return clone({ ...(cached.body || {}), idempotent: true });
    }
    const catalogue = this.internalCatalogue(ctx);
    const normalized = normalizeDefinition({ input, homeId: ctx.homeId, owner: ctx.owner });
    const capabilityErrors = validateAgainstCatalogue(normalized, catalogue, { authorizedDeviceIds: ctx.authorizedDeviceIds });
    if (capabilityErrors.length) throw validationError(capabilityErrors[0].message, capabilityErrors[0].code, capabilityErrors);
    if (this.store.listNativeAutomations().length >= LIMITS.maxAutomations) throw serviceError(`A home can contain at most ${LIMITS.maxAutomations} native automations`, 400, "too_many_automations");
    const response = await this.store.mutateNativeAutomation((state) => {
      const id = normalized.automation.id || makeAutomationId();
      normalized.automation.id = id;
      normalized.trigger.automationId = id;
      normalized.actions = normalized.actions.map((action, index) => ({ ...action, automationId: id, sortOrder: index }));
      state.automations[id] = normalized.automation;
      state.automationTriggers[normalized.trigger.id] = normalized.trigger;
      for (const action of normalized.actions) state.automationActions[action.id] = action;
      const saved = { automation: normalized.automation, trigger: normalized.trigger, actions: normalized.actions };
      const projected = this.projected(id, ctx, saved);
      if (idempotencyId) {
        state.automationIdempotency[idempotencyId] = { status: 201, requestChecksum, body: projected, createdAt: this.now().toISOString() };
        const ids = Object.keys(state.automationIdempotency);
        for (const old of ids.slice(0, Math.max(0, ids.length - LIMITS.maxIdempotencyEntries))) delete state.automationIdempotency[old];
      }
      return projected;
    });
    await this.activity?.record?.({ type: "automation_created", detail: `${response.name} was created.`, change: { automationId: response.id, revision: response.revision, actionCount: response.actions.length } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    return response;
  }

  async update(id, input, context = {}, { expectedRevision } = {}) {
    const ctx = this.context(context);
    this.assertCanManage(ctx);
    const current = this.stored(id);
    if (!current) throw serviceError("Automation not found", 404, "not_found");
    const expected = expectedRevision === undefined || expectedRevision === null || expectedRevision === "" ? null : Number(expectedRevision);
    if (expected === null) throw serviceError("An expected revision is required", 428, "revision_required");
    if (!Number.isInteger(expected) || expected < 1) throw serviceError("An expected revision is invalid", 400, "invalid_revision");
    if (expected !== null && expected !== Number(current.automation.revision)) throw serviceError("The automation changed; reload it before saving", 409, "revision_conflict");
    if (current.automation.homeId !== ctx.homeId) throw serviceError("The automation belongs to another home", 403, "forbidden");
    const merged = { ...current.automation, ...clone(input || {}), trigger: input?.trigger || current.trigger, actions: input?.actions || current.actions, name: input?.name === undefined ? current.automation.name : input.name, enabled: input?.enabled === undefined ? current.automation.enabled : input.enabled };
    const normalized = normalizeDefinition({ input: merged, existing: current.automation, homeId: ctx.homeId, owner: ctx.owner });
    const errors = validateAgainstCatalogue(normalized, this.internalCatalogue(ctx), { authorizedDeviceIds: ctx.authorizedDeviceIds });
    if (errors.length) throw validationError(errors[0].message, errors[0].code, errors);
    normalized.automation.revision = Number(current.automation.revision || 1) + 1;
    normalized.actions = normalized.actions.map((action, index) => {
      const old = current.actions.find((candidate) => candidate.deviceId === action.deviceId && candidate.controlId === action.controlId);
      return { ...action, id: old?.id || action.id, automationId: normalized.automation.id, sortOrder: index };
    });
    const response = await this.store.mutateNativeAutomation((state) => {
      if (state.automations[id]?.revision !== current.automation.revision) throw serviceError("The automation changed; reload it before saving", 409, "revision_conflict");
      for (const trigger of Object.values(state.automationTriggers)) if (trigger.automationId === id) delete state.automationTriggers[trigger.id];
      for (const action of Object.values(state.automationActions)) if (action.automationId === id) delete state.automationActions[action.id];
      state.automations[id] = normalized.automation;
      state.automationTriggers[normalized.trigger.id] = normalized.trigger;
      for (const action of normalized.actions) state.automationActions[action.id] = action;
      return this.projected(id, ctx, normalized);
    });
    await this.activity?.record?.({ type: "automation_updated", detail: `${response.name} was updated.`, change: { automationId: response.id, revision: response.revision, actionCount: response.actions.length } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    return response;
  }

  async setEnabled(id, enabled, context = {}, options = {}) {
    const current = this.stored(id);
    if (!current) throw serviceError("Automation not found", 404, "not_found");
    const response = await this.update(id, { enabled: Boolean(enabled) }, context, options);
    await this.activity?.record?.({ type: response.enabled ? "automation_enabled" : "automation_disabled", detail: `${response.name} was ${response.enabled ? "enabled" : "disabled"}.`, change: { automationId: response.id, revision: response.revision } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    return response;
  }

  async duplicate(id, context = {}, { name } = {}) {
    const current = this.stored(id);
    if (!current) throw serviceError("Automation not found", 404, "not_found");
    const ctx = this.context(context);
    if (current.automation.homeId !== ctx.homeId) throw serviceError("The automation belongs to another home", 404, "not_found");
    return this.create({ name: normalizeName(name) || `${current.automation.name} copy`, enabled: false, trigger: { type: current.trigger.type, payload: current.trigger.payload }, actions: current.actions.map((action) => ({ deviceId: action.deviceId, controlId: action.controlId, targetValue: action.targetValue })) }, ctx);
  }

  async remove(id, context = {}, { expectedRevision } = {}) {
    const ctx = this.context(context);
    this.assertCanManage(ctx);
    const current = this.stored(id);
    if (!current) return false;
    if (current.automation.homeId !== ctx.homeId) throw serviceError("The automation belongs to another home", 403, "forbidden");
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") throw serviceError("An expected revision is required", 428, "revision_required");
    if (Number(expectedRevision) !== Number(current.automation.revision)) throw serviceError("The automation changed; reload it before deleting", 409, "revision_conflict");
    await this.store.mutateNativeAutomation((state) => {
      if (state.automations[id]?.revision !== current.automation.revision) throw serviceError("The automation changed; reload it before deleting", 409, "revision_conflict");
      for (const execution of state.automationExecutions || []) if (execution.automationId === id && !execution.definitionSnapshot) execution.definitionSnapshot = { id, name: current.automation.name, revision: current.automation.revision };
      delete state.automations[id];
      for (const trigger of Object.values(state.automationTriggers)) if (trigger.automationId === id) delete state.automationTriggers[trigger.id];
      for (const action of Object.values(state.automationActions)) if (action.automationId === id) delete state.automationActions[action.id];
    });
    await this.activity?.record?.({ type: "automation_deleted", detail: `${current.automation.name} was deleted.`, change: { automationId: id, revision: current.automation.revision } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    return true;
  }

  history(id, context = {}) {
    const current = this.stored(id);
    if (!current) throw serviceError("Automation not found", 404, "not_found");
    const ctx = this.context(context);
    if (current.automation.homeId !== ctx.homeId) throw serviceError("Automation not found", 404, "not_found");
    const executions = (this.store.state.automationExecutions || []).filter((item) => item.automationId === id).map(clone);
    return { automationId: id, executions, occurrences: Object.values(this.store.state.automationOccurrences || {}).filter((item) => item.automationId === id).map(clone).sort((a, b) => String(b.claimedAt || "").localeCompare(String(a.claimedAt || ""))) };
  }
}

module.exports = { AutomationService, requestContext, serviceError };
