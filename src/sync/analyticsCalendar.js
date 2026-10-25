function validTimezone(timezone) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return typeof timezone === 'string'; } catch { return false; }
}
function localParts(time, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(time)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return p;
}
function midnight(year, month, day, timezone) {
  const target = Date.UTC(year, month - 1, day); let guess = target;
  for (let i = 0; i < 6; i++) {
    const p = localParts(guess, timezone);
    const delta = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!delta) return guess; guess += delta;
  }
  throw new Error('Unresolvable analytics calendar boundary');
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
