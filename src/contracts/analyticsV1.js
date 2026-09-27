'use strict';

function classifyActivityV1(evidence, nowMs) {
  const deadline = Date.parse(evidence?.validUntil ?? '');
  if (evidence?.quality !== 'fresh' || !Number.isFinite(deadline) || deadline <= nowMs) return 'unknown';
  const signals = evidence.signals || {};
  if (evidence.category === 'light') {
    if (signals.powerOn === true || typeof signals.brightness === 'number' && Number.isFinite(signals.brightness) && signals.brightness > 0) return 'on';
    if (signals.powerOn === false || typeof signals.brightness === 'number' && Number.isFinite(signals.brightness) && signals.brightness === 0) return 'off';
    return 'unknown';
  }
  if (evidence.category === 'radiator') return typeof signals.activeHeatDemand === 'boolean' ? signals.activeHeatDemand ? 'on' : 'off' : 'unknown';
  if (evidence.category === 'boiler') return typeof signals.activeHeatProduction === 'boolean' ? signals.activeHeatProduction ? 'on' : 'off' : 'unknown';
  return 'unknown';
}

function validateSample(sample) {
  if (!sample || typeof sample.bucket !== 'string' || !sample.bucket || !['onMinutes', 'offMinutes', 'unknownMinutes'].every((key) => Number.isSafeInteger(sample[key]) && sample[key] >= 0)) throw new TypeError('Invalid analytics sample');
}

function averageContributingSamplesV1(samples) {
  const map = new Map();
  for (const sample of samples) {
    validateSample(sample);
    const value = map.get(sample.bucket) || { onMinutes: 0, offMinutes: 0, unknownMinutes: 0, count: 0 };
    for (const key of ['onMinutes', 'offMinutes', 'unknownMinutes']) value[key] += sample[key];
    value.count += 1;
    map.set(sample.bucket, value);
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, value]) => ({ bucket, onMinutes: Math.floor(value.onMinutes / value.count + 0.5), offMinutes: Math.floor(value.offMinutes / value.count + 0.5), unknownMinutes: Math.floor(value.unknownMinutes / value.count + 0.5) }));
}

function sumSelectedDevicesPerHourV1(samples) {
  const map = new Map();
  for (const sample of samples) {
    validateSample(sample);
    const value = map.get(sample.bucket) || { onMinutes: 0, offMinutes: 0, unknownMinutes: 0 };
    for (const key of ['onMinutes', 'offMinutes', 'unknownMinutes']) value[key] += sample[key];
    map.set(sample.bucket, value);
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, value]) => ({ bucket, ...value }));
}

function averageDisplayedBucketsV1(buckets) {
  if (!buckets.length) return { onMinutes: 0, offMinutes: 0, unknownMinutes: 0 };
  for (const bucket of buckets) validateSample({ bucket: 'displayed', ...bucket });
  return Object.fromEntries(['onMinutes', 'offMinutes', 'unknownMinutes'].map((key) => [key, Math.floor(buckets.reduce((sum, bucket) => sum + bucket[key], 0) / buckets.length + 0.5)]));
}

module.exports = { classifyActivityV1, averageContributingSamplesV1, sumSelectedDevicesPerHourV1, averageDisplayedBucketsV1 };
