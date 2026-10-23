'use strict';
// One semantics implementation for real accounting and the JS contract adapter.
// Callers select exactly one source; this never combines unrelated timestamps.
function activityFromSignals({ category, signals = {}, powerCapabilityPresent, brightnessMeaning }) {
  if (category === 'light') {
    const hasPower = powerCapabilityPresent ?? Object.hasOwn(signals, 'powerOn');
    if (hasPower) return typeof signals.powerOn === 'boolean' ? (signals.powerOn ? 'on' : 'off') : 'unknown';
    if (brightnessMeaning !== 'actual_output') return 'unknown';
    const value = signals.brightness;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? (value > 0 ? 'on' : 'off') : 'unknown';
  }
  const value = category === 'radiator' ? signals.activeHeatDemand : category === 'boiler' ? signals.activeHeatProduction : null;
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : 'unknown';
}
function projectActivity({ binding, sample, nowMs, authorityValid, clockTrusted, deviceAvailable }) {
  if (!authorityValid || !clockTrusted || deviceAvailable === false || binding?.status !== 'resolved') return 'unknown';
  const observed = Date.parse(sample?.observedAt), deadline = Date.parse(sample?.validUntil);
  if (!sample || sample.controlId !== binding.primaryControlId || sample.quality !== 'fresh' ||
      !Number.isFinite(observed) || !Number.isFinite(deadline) || observed > nowMs ||
      deadline <= nowMs || deadline <= observed) return 'unknown';
  const signals = binding.category === 'LIGHT'
    ? (binding.hasAuthoritativePower ? { powerOn: sample.value } : { brightness: sample.value })
    : binding.category === 'RADIATOR' ? { activeHeatDemand: sample.value } : { activeHeatProduction: sample.value };
  return activityFromSignals({ category: binding.category.toLowerCase(), signals,
    powerCapabilityPresent: binding.hasAuthoritativePower, brightnessMeaning: binding.brightnessMeaning });
}
module.exports = { activityFromSignals, projectActivity };
