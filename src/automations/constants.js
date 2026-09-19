const NATIVE_AUTOMATION_SCHEMA_VERSION = 1;
const NATIVE_AUTOMATION_STORE_VERSION = 10;

const LIMITS = Object.freeze({
  maxAutomations: 100,
  maxActionsPerAutomation: 32,
  maxNameLength: 60,
  maxValueLength: 128,
  maxOccurrences: 500,
  maxExecutionHistory: 500,
  maxExecutionAgeMs: 90 * 24 * 60 * 60 * 1000,
  maxIdempotencyEntries: 100,
  missedRunGraceMs: 5 * 60 * 1000,
  schedulerIntervalMs: 10 * 1000,
});

const OUTCOME_STATES = Object.freeze([
  "pending", "claimed", "running", "accepted", "applied", "succeeded",
  "partial", "failed", "uncertain", "interrupted", "skipped",
]);

const HEALTH_STATES = Object.freeze(["ready", "needs_attention", "suspended"]);

const ISSUE_CODES = Object.freeze([
  "invalid_database", "invalid_ownership", "duplicate_id", "missing_trigger",
  "invalid_action", "duplicate_action", "missing_device", "unconfigured_device",
  "unauthorized_device", "missing_control", "non_automatable_control",
  "invalid_value", "invalid_schedule", "invalid_name", "unsupported_trigger",
  "revision_conflict", "automation_not_found", "idempotency_conflict",
]);

const AUTOMATABLE_SERVICES = Object.freeze(new Set([
  "light.turn_on", "light.turn_off",
  "switch.turn_on", "switch.turn_off",
  "climate.turn_on", "climate.turn_off",
  "climate.set_temperature", "climate.set_hvac_mode",
  "fan.turn_on", "fan.turn_off", "fan.set_percentage", "fan.set_preset_mode",
  "cover.open_cover", "cover.close_cover", "cover.stop_cover", "cover.set_cover_position",
  "lock.lock",
  "number.set_value", "select.select_option", "button.press",
]));

const FORBIDDEN_AUTOMATION_SERVICES = Object.freeze(new Set([
  "light.toggle", "switch.toggle", "fan.toggle",
  "lock.unlock", "homeassistant.reload_config_entry",
  "device.remove", "device.reset", "pairing.start", "config.write",
]));

module.exports = {
  AUTOMATABLE_SERVICES,
  FORBIDDEN_AUTOMATION_SERVICES,
  HEALTH_STATES,
  ISSUE_CODES,
  LIMITS,
  NATIVE_AUTOMATION_SCHEMA_VERSION,
  NATIVE_AUTOMATION_STORE_VERSION,
  OUTCOME_STATES,
};
