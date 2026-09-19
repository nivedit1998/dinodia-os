const { LIMITS } = require("./constants");
const { clone } = require("./domain");
const { scheduledOccurrence } = require("./schedule");

function dueMinuteCandidates(previous, now, intervalMs) {
  if (!(previous instanceof Date) || !Number.isFinite(previous.getTime())) return [now];
  const elapsed = now.getTime() - previous.getTime();
  if (elapsed < 0 || elapsed > LIMITS.missedRunGraceMs + intervalMs * 2) return [now];
  const start = new Date(previous);
  start.setSeconds(0, 0);
  const end = new Date(now);
  end.setSeconds(0, 0);
  const candidates = [];
  for (let cursor = start.getTime(); cursor <= end.getTime() && candidates.length <= 8; cursor += 60 * 1000) candidates.push(new Date(cursor));
  return candidates.length ? candidates : [now];
}

class AutomationScheduler {
  constructor({ store, service, executor, logger = console, now = () => new Date(), intervalMs = LIMITS.schedulerIntervalMs, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!store || !service || !executor) throw new Error("AutomationScheduler requires store, service and executor");
    this.store = store;
    this.service = service;
    this.executor = executor;
    this.logger = logger;
    this.now = now;
    this.intervalMs = intervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.tickInFlight = false;
    this.lastError = null;
  }

  status() {
    const runtime = this.store.state.automationRuntime || {};
    return { enabled: true, running: Boolean(this.timer), schedulerRunning: Boolean(this.timer), lastTickAt: runtime.lastTickAt || null, lastError: this.lastError || runtime.lastError || null, recoveredAt: runtime.recoveredAt || null };
  }

  async recover() {
    const now = this.now().toISOString();
    const recovered = [];
    await this.store.mutateNativeAutomation((state) => {
      let changed = false;
      for (const occurrence of Object.values(state.automationOccurrences || {})) {
        if (!["claimed", "running"].includes(occurrence.status)) continue;
        occurrence.status = "interrupted";
        occurrence.completedAt = now;
        occurrence.actionOutcomes = (occurrence.actionOutcomes || []).map((outcome) => ["pending", "running"].includes(outcome.status) ? { ...outcome, status: "uncertain", completedAt: now, errorCode: "process_interrupted", errorMessage: "Dinodia OS restarted before this action was confirmed." } : outcome);
        recovered.push(clone(occurrence));
        changed = true;
      }
      state.automationRuntime = { ...(state.automationRuntime || {}), recoveredAt: now, schedulerRunning: false };
      if (changed) {
        const summaries = recovered.map((item) => ({ occurrenceId: item.id, automationId: item.automationId, revision: item.revision, status: "interrupted", startedAt: item.startedAt || item.claimedAt, completedAt: item.completedAt, actionOutcomes: clone(item.actionOutcomes || []) }));
        state.automationExecutions = [...summaries, ...(state.automationExecutions || [])]
          .slice(0, LIMITS.maxExecutionHistory);
      }
    });
    for (const occurrence of recovered) {
      await this.service.activity?.record?.({ type: "automation_execution_interrupted", detail: "An automation was interrupted by a Dinodia OS restart.", change: { automationId: occurrence.automationId, revision: occurrence.revision, occurrenceId: occurrence.id } }).catch((error) => this.logger.error(`[activity] ${error.message}`));
    }
  }

  async claim(occurrence, actions) {
    return this.store.mutateNativeAutomation((state) => {
      if (state.automationOccurrences[occurrence.id]) return false;
      state.automationOccurrences[occurrence.id] = { ...occurrence, status: "claimed", claimedAt: this.now().toISOString(), completedAt: null, actionOutcomes: (actions || []).map((action) => ({ actionId: action.id, deviceId: action.deviceId, controlId: action.controlId, status: "pending", startedAt: null, completedAt: null, errorCode: null, errorMessage: null })) };
      const ids = Object.keys(state.automationOccurrences);
      const cutoff = Date.now() - LIMITS.maxExecutionAgeMs;
      for (const id of ids) {
        const item = state.automationOccurrences[id];
        if (Date.parse(item.claimedAt || "") < cutoff) delete state.automationOccurrences[id];
      }
      const retained = Object.keys(state.automationOccurrences);
      if (retained.length > LIMITS.maxOccurrences) for (const id of retained.slice(0, retained.length - LIMITS.maxOccurrences)) delete state.automationOccurrences[id];
      return true;
    });
  }

  async tick(now = this.now()) {
    if (this.tickInFlight) return { skipped: true, reason: "tick_in_flight" };
    this.tickInFlight = true;
    const due = [];
    try {
      const previous = this.store.state.automationRuntime?.lastTickAt ? new Date(this.store.state.automationRuntime.lastTickAt) : null;
      for (const item of this.store.listNativeAutomations()) {
        if (!item.enabled) continue;
        const stored = this.store.getNativeAutomation(item.id);
        if (!stored?.trigger) continue;
        const projected = this.service.projected(item.id);
        if (!projected?.health?.executable) continue;
        const candidates = dueMinuteCandidates(previous, now, this.intervalMs);
        for (const date of candidates) {
          const occurrence = scheduledOccurrence(stored.automation, stored.trigger, date);
          if (!occurrence) continue;
          if (await this.claim(occurrence, stored.actions)) due.push({ occurrence, stored });
        }
      }
      await this.store.mutateNativeAutomation((state) => { state.automationRuntime = { ...(state.automationRuntime || {}), schedulerRunning: Boolean(this.timer), lastTickAt: now.toISOString(), lastError: null }; });
      for (const item of due) await this.executor.executeOccurrence(item.occurrence, item.stored.automation, item.stored.trigger, item.stored.actions);
      return { claimed: due.length };
    } catch (error) {
      this.lastError = String(error.message || error);
      await this.store.mutateNativeAutomation((state) => { state.automationRuntime = { ...(state.automationRuntime || {}), lastTickAt: now.toISOString(), lastError: this.lastError }; }).catch(() => {});
      this.logger.error(`[native-automation] scheduler tick failed: ${this.lastError}`);
      throw error;
    } finally { this.tickInFlight = false; }
  }

  async start() {
    if (this.timer) return;
    await this.recover();
    this.timer = this.setIntervalFn(() => this.tick().catch(() => {}), this.intervalMs);
    this.timer?.unref?.();
    await this.store.mutateNativeAutomation((state) => { state.automationRuntime = { ...(state.automationRuntime || {}), schedulerRunning: true }; });
  }

  async stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    await this.store.mutateNativeAutomation((state) => { state.automationRuntime = { ...(state.automationRuntime || {}), schedulerRunning: false }; });
  }
}

module.exports = { AutomationScheduler };
