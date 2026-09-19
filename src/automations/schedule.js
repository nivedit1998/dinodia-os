const { occurrenceId } = require("./domain");

function dateParts(date = new Date(), timeZoneIdentifier = "UTC") {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid date");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZoneIdentifier,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = Number(map.year); const month = Number(map.month); const day = Number(map.day); const hour = Number(map.hour); const minute = Number(map.minute);
  const localDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Calculate ISO weekday from the already-normalized local calendar date.
  // `Intl.DateTimeFormat` does not support a numeric weekday option.
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const localWeekday = ((sundayZero + 6) % 7) + 1;
  return { year, month, day, hour, minute, minuteOfDay: hour * 60 + minute, localDate, weekday: localWeekday, iso: `${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function scheduleMatches(payload, date = new Date()) {
  const parts = dateParts(date, payload.timeZoneIdentifier);
  return parts.minuteOfDay === Number(payload.minuteOfDay) && (payload.weekdays || []).includes(parts.weekday);
}

function scheduledOccurrence(automation, trigger, date = new Date()) {
  const payload = trigger?.payload || {};
  const parts = dateParts(date, payload.timeZoneIdentifier);
  if (!scheduleMatches(payload, date)) return null;
  const id = occurrenceId(automation.id, automation.revision, parts.localDate, payload.minuteOfDay);
  return { id, automationId: automation.id, revision: automation.revision, scheduledFor: date instanceof Date ? date.toISOString() : new Date(date).toISOString(), localDate: parts.localDate, localTime: `${String(Math.floor(payload.minuteOfDay / 60)).padStart(2, "0")}:${String(payload.minuteOfDay % 60).padStart(2, "0")}`, timeZoneIdentifier: payload.timeZoneIdentifier };
}

function nextRunAt(automation, trigger, from = new Date(), horizonDays = 8) {
  const payload = trigger?.payload || {};
  const base = from instanceof Date ? new Date(from) : new Date(from);
  if (!Number.isFinite(base.getTime())) return null;
  const minute = Number(payload.minuteOfDay);
  if (!Number.isInteger(minute)) return null;
  for (let offset = 0; offset <= horizonDays * 24 * 60; offset += 1) {
    const candidate = new Date(base.getTime() + offset * 60 * 1000);
    const parts = dateParts(candidate, payload.timeZoneIdentifier);
    if ((payload.weekdays || []).includes(parts.weekday) && parts.minuteOfDay === minute && candidate.getTime() > base.getTime()) return candidate.toISOString();
  }
  return null;
}

module.exports = { dateParts, nextRunAt, scheduleMatches, scheduledOccurrence };
