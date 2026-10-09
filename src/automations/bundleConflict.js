function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function scheduleWindow(automation) {
  const trigger = automation?.trigger;
  const payload = trigger?.payload || {};
  return {
    timezone: String(payload.timeZoneIdentifier || ""),
    minuteOfDay: Number(payload.minuteOfDay),
    weekdays: new Set(Array.isArray(payload.weekdays) ? payload.weekdays.map(Number) : []),
  };
}

function comparableOccurrencesOverlap(left, right) {
  if (!left.timezone || !right.timezone || left.timezone !== right.timezone) return true;
  if (!Number.isInteger(left.minuteOfDay) || !Number.isInteger(right.minuteOfDay)) return true;
  if (left.minuteOfDay !== right.minuteOfDay) return false;
  if (!left.weekdays.size || !right.weekdays.size) return true;
  return [...left.weekdays].some((day) => right.weekdays.has(day));
}

function findBundleConflict(automations, catalogue) {
  const active = (automations || []).filter((automation) => automation?.automation?.enabled === true);
  const byDevice = new Map((catalogue || []).map((device) => [String(device.deviceId), device]));
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const left = active[leftIndex];
    const leftWindow = scheduleWindow(left);
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const right = active[rightIndex];
      const rightWindow = scheduleWindow(right);
      if (!comparableOccurrencesOverlap(leftWindow, rightWindow)) continue;
      for (const leftAction of left.actions || []) {
        for (const rightAction of right.actions || []) {
          if (String(leftAction.deviceId) !== String(rightAction.deviceId)
            || String(leftAction.controlId) !== String(rightAction.controlId)) continue;
          const device = byDevice.get(String(leftAction.deviceId));
          const control = (device?.controls || []).find((item) => String(item.controlId) === String(leftAction.controlId));
          const identicalTarget = canonical(leftAction.targetValue) === canonical(rightAction.targetValue);
          const descriptorAllowsIdenticalSet = control?.allowsAutomation === true
            && control?.execution?.idempotency === "set_value"
            && control?.mutuallyExclusive !== true;
          if (identicalTarget && descriptorAllowsIdenticalSet) continue;
          return { code: "sync_automation_conflict" };
        }
      }
    }
  }
  return null;
}

module.exports = { findBundleConflict };
