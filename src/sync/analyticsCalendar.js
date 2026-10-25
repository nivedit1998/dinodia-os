function validTimezone(timezone) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return typeof timezone === 'string'; } catch { return false; }
}
const formatters = new Map(), boundaries = new Map();
function localParts(time, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) { if (formatters.size >= 64) formatters.clear(); formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }); formatters.set(timezone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(new Date(time)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return p;
}
function midnight(year, month, day, timezone) {
  const key = `${timezone}|${year}-${month}-${day}`;
  if (boundaries.has(key)) return boundaries.get(key);
  const target = Date.UTC(year, month - 1, day);
  let low = target - 36 * 3600000, high = target + 36 * 3600000;
  // First instant of the local date: midnight may be skipped or repeated.
  while (low < high) {
    const mid = Math.floor((low + high) / 2), p = localParts(mid, timezone);
    if (Date.UTC(p.year, p.month - 1, p.day) < target) low = mid + 1; else high = mid;
  }
  if (boundaries.size >= 512) boundaries.clear(); boundaries.set(key, low);
  return low;
}
function calendarDay(time, timezone) {
  if (!Number.isFinite(Number(time)) || !validTimezone(timezone)) throw new Error('Invalid analytics calendar');
  const p = localParts(time, timezone); const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return { date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    start: midnight(p.year, p.month, p.day, timezone), end: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone) };
}
function calendarWeek(time, timezone) {
  const p = localParts(time, timezone); const first = new Date(Date.UTC(p.year, p.month - 1, p.day));
  first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
  const next = new Date(first); next.setUTCDate(next.getUTCDate() + 7);
  return { start: midnight(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), timezone),
    end: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone) };
}
function annualDayCutoff(time, timezone) {
  const p = localParts(time, timezone); const last = new Date(Date.UTC(p.year - 1, p.month, 0)).getUTCDate();
  return midnight(p.year - 1, p.month, Math.min(p.day, last), timezone);
}
module.exports = { validTimezone, calendarDay, calendarWeek, annualDayCutoff };
