const { LIMITS } = require("./constants");
const { clone } = require("./domain");

function resultError(error) {
  return {
    errorCode: String(error?.code || "execution_failed").slice(0, 64),
    errorMessage: String(error?.message || "The device action failed").slice(0, 256),
    uncertain: Boolean(error?.uncertain),
  };
}

class AutomationExecutor {
  constructor({ store, executeControl, activity, logger = console, now = () => new Date() } = {}) {
    if (!store || typeof executeControl !== "function") throw new Error("AutomationExecutor requires store and executeControl");
    this.store = store;
    this.executeControl = executeControl;
    this.activity = activity;
    this.logger = logger;
    this.now = now;
  }

  async markOccurrence(occurrenceId, patch) {
    return this.store.mutateNativeAutomation((state) => {
      const current = state.automationOccurrences[occurrenceId];
      if (!current) return null;
      Object.assign(current, clone(patch));
      return current;
    });
  }

  async executeOccurrence(occurrence, automation, trigger, actions) {
    const occurrenceId = occurrence.id;
    const startedAt = this.now().toISOString();
    const outcomes = (actions || []).slice().sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder)).map((action) => ({ actionId: action.id, deviceId: action.deviceId, controlId: action.controlId, status: "pending", startedAt: null, completedAt: null, errorCode: null, errorMessage: null }));
    await this.markOccurrence(occurrenceId, { status: "running", startedAt, actionOutcomes: outcomes });
    await this.activity?.record?.({ type: "automation_execution_started", detail: `${automation.name} started.`, change: { automationId: automation.id, revision: automation.revision, occurrenceId, actionCount: actions.length } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    let failed = 0;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      await this.markOccurrence(occurrenceId, { actionOutcomes: outcomes.map((item, itemIndex) => itemIndex === index ? { ...item, status: "running", startedAt: this.now().toISOString() } : item) });
      try {
        await this.executeControl({ automation: clone(automation), trigger: clone(trigger), action: clone(action), occurrence: clone(occurrence) });
        outcomes[index] = { ...outcomes[index], status: "applied", completedAt: this.now().toISOString() };
      } catch (error) {
        failed += 1;
        const details = resultError(error);
        outcomes[index] = { ...outcomes[index], status: details.uncertain ? "uncertain" : "failed", completedAt: this.now().toISOString(), errorCode: details.errorCode, errorMessage: details.errorMessage };
        this.logger.error(`[native-automation] ${automation.name} action ${action.id}: ${details.errorMessage}`);
      }
      await this.markOccurrence(occurrenceId, { actionOutcomes: outcomes });
    }
    const status = failed === 0 ? "succeeded" : failed === actions.length ? "failed" : "partial";
    const completedAt = this.now().toISOString();
    const execution = { occurrenceId, automationId: automation.id, revision: automation.revision, status, startedAt, completedAt, actionOutcomes: clone(outcomes) };
    await this.store.mutateNativeAutomation((state) => {
      const current = state.automationOccurrences[occurrenceId];
      if (current) Object.assign(current, { status, completedAt, actionOutcomes: clone(outcomes) });
      state.automationExecutions = [execution, ...(state.automationExecutions || []).filter((item) => item.occurrenceId !== occurrenceId)].slice(0, LIMITS.maxExecutionHistory);
      const cutoff = Date.now() - LIMITS.maxExecutionAgeMs;
      state.automationExecutions = state.automationExecutions.filter((item) => !item.completedAt || Date.parse(item.completedAt) >= cutoff);
    });
    await this.activity?.record?.({ type: `automation_execution_${status}`, detail: `${automation.name} ${status}.`, change: { automationId: automation.id, revision: automation.revision, occurrenceId, actionCount: actions.length, failedActions: failed } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    return execution;
  }
}

module.exports = { AutomationExecutor, resultError };
