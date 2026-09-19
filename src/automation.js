function readTriggerValue(device, field) {
  if (field === "id" || field === "name" || field === "protocol" || field === "available") return device[field];
  return device.state ? device.state[field] : undefined;
}

function entityForTrigger(trigger, device) {
  if (!trigger || !device) return null;
  if (trigger.entity_id || trigger.entityId) {
    const wantedIds = Array.isArray(trigger.entity_id || trigger.entityId)
      ? (trigger.entity_id || trigger.entityId).map(String)
      : [String(trigger.entity_id || trigger.entityId)];
    return Object.values(device.entities || {}).find((entity) =>
      wantedIds.includes(String(entity.haEntityId || entity.entityId || entity.id || "")) ||
      wantedIds.some((wanted) => wanted.includes(String(device.id)))
    ) || null;
  }
  return null;
}

function readEntityValue(device, entity, field = "state") {
  if (!device) return undefined;
  if (!entity) return readTriggerValue(device, field);
  if (field === "state") return entity.state !== undefined ? entity.state : device.state?.[entity.stateKey];
  return device.state?.[field] ?? entity[field];
}

function triggerMatches(trigger, device, previous = null) {
  if (!trigger || !device) return false;
  if (trigger.deviceId && String(trigger.deviceId) !== String(device.id)) return false;
  if (trigger.protocol && String(trigger.protocol) !== String(device.protocol)) return false;
  if (trigger.entity_id || trigger.entityId) {
    const matchedEntity = entityForTrigger(trigger, device);
    if (!matchedEntity) return false;
    const previousEntity = previous ? entityForTrigger(trigger, previous) : null;
    const actualEntityState = readEntityValue(device, matchedEntity);
    const previousEntityState = readEntityValue(previous, previousEntity);
    if (trigger.to !== undefined) {
      if (String(actualEntityState).toLowerCase() !== String(trigger.to).toLowerCase()) return false;
    }
    if (trigger.from !== undefined) {
      if (String(previousEntityState).toLowerCase() !== String(trigger.from).toLowerCase()) return false;
    }
    if (trigger.attribute) {
      const actualAttribute = readEntityValue(device, matchedEntity, trigger.attribute);
      const previousAttribute = readEntityValue(previous, previousEntity, trigger.attribute);
      if (trigger.to !== undefined && String(actualAttribute).toLowerCase() !== String(trigger.to).toLowerCase()) return false;
      if (trigger.from !== undefined && String(previousAttribute).toLowerCase() !== String(trigger.from).toLowerCase()) return false;
    }
  }
  const actual = readTriggerValue(device, trigger.field || "state");
  if (Object.prototype.hasOwnProperty.call(trigger, "equals") && String(actual) !== String(trigger.equals)) return false;
  if (Object.prototype.hasOwnProperty.call(trigger, "notEquals") && String(actual) === String(trigger.notEquals)) return false;
  if (trigger.greaterThan !== undefined && !(Number(actual) > Number(trigger.greaterThan))) return false;
  if (trigger.lessThan !== undefined && !(Number(actual) < Number(trigger.lessThan))) return false;
  if (trigger.truthy === true && !actual) return false;
  return true;
}

// Native iOS V2 schedule automations deliberately do not pass through this
// legacy state-trigger evaluator. `src/automations/` owns the typed,
// capability-driven scheduler; this class remains the compatibility engine
// for rules written against the original Home Assistant-shaped payload.

class AutomationEngine {
  constructor({ store, executeAction, logger = console }) {
    this.store = store;
    this.executeAction = executeAction;
    this.logger = logger;
    this.lastRun = new Map();
    this.timer = null;
    this.lastTimeKey = new Map();
  }

  async onDeviceChanged(device, previous = null) {
    for (const automation of this.store.listAutomations()) {
      const triggers = Array.isArray(automation.triggers) && automation.triggers.length ? automation.triggers : [automation.trigger];
      if (!automation.enabled || !triggers.some((trigger) => triggerMatches(trigger, device, previous)) || !this.conditionsMatch(automation.conditions, device, previous)) continue;
      await this.runAutomation(automation, device);
    }
  }

  conditionsMatch(conditions, device, previous = null) {
    for (const condition of Array.isArray(conditions) ? conditions : []) {
      if (!condition || typeof condition !== "object") continue;
      if (condition.condition === "state" || condition.deviceId || condition.entity_id) {
        if (!triggerMatches({ ...condition, equals: condition.state ?? condition.equals }, device, previous)) return false;
      }
      if (condition.condition === "time" && !this.timeMatches(condition)) return false;
      if (condition.condition === "template" && typeof condition.value_template === "string") {
        const match = condition.value_template.match(/states\[['"]([^'"]+)['"]\]\.state\s*==\s*['"]([^'"]+)['"]/i);
        if (match && String(readTriggerValue(device, match[1])) !== match[2]) return false;
        const delta = condition.value_template.match(/trigger\.to_state\.attributes\[['"]([^'"]+)['"]\][^\n]*-\s*\(?(?:trigger\.from_state\.attributes\[['"]\1['"]\]|trigger\.from_state\.attributes\[['"]([^'"]+)['"]\])[^\n]*\)\s*>=\s*([0-9.]+)/i);
        if (delta) {
          const attribute = delta[1];
          const current = Number(device.state?.[attribute] ?? Object.values(device.entities || {}).find((entity) => entity.stateKey === attribute)?.state);
          const before = Number(previous?.state?.[attribute] ?? Object.values(previous?.entities || {}).find((entity) => entity.stateKey === attribute)?.state);
          if (!Number.isFinite(current) || !Number.isFinite(before) || current - before < Number(delta[3] || delta[2])) return false;
        }
        const reverseDelta = condition.value_template.match(/trigger\.from_state\.attributes\[['"]([^'"]+)['"]\][^\n]*-\s*\(?(?:trigger\.to_state\.attributes\[['"]\1['"]\]|trigger\.to_state\.attributes\[['"]([^'"]+)['"]\])[^\n]*\)\s*>=\s*([0-9.]+)/i);
        if (reverseDelta) {
          const attribute = reverseDelta[1];
          const before = Number(previous?.state?.[attribute] ?? Object.values(previous?.entities || {}).find((entity) => entity.stateKey === attribute)?.state);
          const current = Number(device.state?.[attribute] ?? Object.values(device.entities || {}).find((entity) => entity.stateKey === attribute)?.state);
          if (!Number.isFinite(current) || !Number.isFinite(before) || before - current < Number(reverseDelta[3] || reverseDelta[2])) return false;
        }
      }
    }
    return true;
  }

  timeMatches(condition, now = new Date()) {
    const weekday = Array.isArray(condition.weekday) ? condition.weekday.map((day) => String(day).toLowerCase()) : [];
    if (weekday.length && !weekday.includes(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][now.getDay()])) return false;
    const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (condition.after && current < String(condition.after).slice(0, 5)) return false;
    if (condition.before && current > String(condition.before).slice(0, 5)) return false;
    if (condition.at && current !== String(condition.at).slice(0, 5)) return false;
    return true;
  }

  async runAutomation(automation, device = { id: "time" }) {
      const last = this.lastRun.get(automation.id) || 0;
      if (Date.now() - last < automation.cooldownMs) return false;
      this.lastRun.set(automation.id, Date.now());
      let completed = 0;
      for (const action of automation.actions) {
        try {
          await this.executeAction(action);
          completed += 1;
        } catch (error) {
          this.logger.error(`[automation] ${automation.name}: ${error.message}`);
        }
      }
      await this.store.addEvent({
        type: "automation_triggered",
        automationId: automation.id,
        automationName: automation.name,
        deviceId: device.id,
        completedActions: completed,
        totalActions: automation.actions.length,
      });
  }

  async tick(now = new Date()) {
    for (const automation of this.store.listAutomations()) {
      if (!automation.enabled) continue;
      const triggers = Array.isArray(automation.triggers) && automation.triggers.length ? automation.triggers : [automation.trigger];
      const timeTrigger = triggers.find((trigger) => trigger && (trigger.platform === "time" || trigger.trigger === "time" || trigger.at));
      if (!timeTrigger || !this.timeMatches(timeTrigger, now)) continue;
      const key = `${automation.id}:${now.toISOString().slice(0, 16)}`;
      if (this.lastTimeKey.has(automation.id) && this.lastTimeKey.get(automation.id) === key) continue;
      this.lastTimeKey.set(automation.id, key);
      await this.runAutomation(automation, { id: "time", protocol: "virtual", state: {} });
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error(`[automation] ${error.message}`)), 10000);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { AutomationEngine, LegacyAutomationEngine: AutomationEngine, triggerMatches };
