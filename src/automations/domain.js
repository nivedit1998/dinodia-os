const crypto = require("node:crypto");
const { LIMITS, NATIVE_AUTOMATION_SCHEMA_VERSION } = require("./constants");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hasControlCharacters(value) {
  return String(value || "").split("").some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function normalizeName(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, LIMITS.maxNameLength);
}

function normalizeId(value, prefix = "id") {
  const raw = String(value || "").trim();
  if (!raw) return `${prefix}-${crypto.randomUUID().toLowerCase()}`;
  return raw.slice(0, 128);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(stableObject(value));
}

function checksum(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
}

function normalizeSchedulePayload(input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  const schedule = payload.schedule && typeof payload.schedule === "object" ? payload.schedule : payload;
  return {
    minuteOfDay: Number.isInteger(Number(schedule.minuteOfDay)) ? Number(schedule.minuteOfDay) : Number(schedule.minute_of_day),
    weekdays: normalizeWeekdays(schedule.weekdays),
    timeZoneIdentifier: String(schedule.timeZoneIdentifier || schedule.timezone || schedule.time_zone || "").trim(),
  };
}

function normalizeTriggerInput(input = {}) {
  const type = String(input.type || input.triggerType || "schedule").trim().toLowerCase();
  if (type !== "schedule") return { type, payload: clone(input.payload || input) };
  return { type: "schedule", payload: normalizeSchedulePayload(input) };
}

function normalizeTargetValue(input) {
  const value = input && typeof input === "object" ? input : {};
  const type = String(value.type || "").trim().toLowerCase();
  if (type === "boolean") return { type, boolean: Boolean(value.boolean ?? value.bool) };
  if (type === "number") return { type, number: Number(value.number) };
  if (type === "text") return { type, text: String(value.text ?? "").slice(0, LIMITS.maxValueLength) };
  if (type === "option") return { type, option: String(value.option ?? "").slice(0, LIMITS.maxValueLength) };
  if (type === "invoke") return { type };
  return { type };
}

function normalizeOwner(owner = {}, fallback = {}) {
  const source = owner && typeof owner === "object" ? owner : {};
  return {
    type: String(source.type || fallback.type || "local_admin").trim().slice(0, 32),
    subjectId: String(source.subjectId || source.subject_id || fallback.subjectId || "local-admin").trim().slice(0, 128),
  };
}

function makeAutomationId() { return `automation-${crypto.randomUUID().toLowerCase()}`; }
function makeTriggerId() { return `trigger-${crypto.randomUUID().toLowerCase()}`; }
function makeActionId() { return `action-${crypto.randomUUID().toLowerCase()}`; }

function occurrenceId(automationId, revision, localDate, minuteOfDay) {
  const hour = String(Math.floor(Number(minuteOfDay) / 60)).padStart(2, "0");
  const minute = String(Number(minuteOfDay) % 60).padStart(2, "0");
  return `${automationId}:${revision}:${localDate}:${hour}:${minute}`;
}

module.exports = {
  canonicalJson,
  checksum,
  clone,
  hasControlCharacters,
  makeActionId,
  makeAutomationId,
  makeTriggerId,
  normalizeId,
  normalizeName,
  normalizeOwner,
  normalizeSchedulePayload,
  normalizeTargetValue,
  normalizeTriggerInput,
  normalizeWeekdays,
  occurrenceId,
  stableObject,
  NATIVE_AUTOMATION_SCHEMA_VERSION,
};
