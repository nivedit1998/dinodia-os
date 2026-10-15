const crypto = require("node:crypto");

const SYNC_OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SYNC_OUTBOX_MAX_EVENTS = 100_000;
const SYNC_OUTBOX_MAX_BYTES = 256 * 1024 * 1024;
// Keep the serializable cloud ingestion transaction comfortably below its
// bounded execution window, even when a durable queue has accumulated a lot
// of history while offline. A server-side explicit rejection safely narrows
// legacy in-flight batches without acknowledging or dropping any event.
const SYNC_BATCH_MAX_EVENTS = 40;
const SYNC_BATCH_MAX_BYTES = 512 * 1024;
const CRITICAL_TYPES = new Set(["area.tombstone", "device.tombstone", "control.catalog.upsert", "control.catalog.tombstone", "incident.transition", "automation.outcome", "update.status"]);
const COALESCIBLE_TYPES = new Set(["area.upsert", "device.upsert", "control.catalog.upsert", "usage.bucket", "device.state"]);
const PROPERTY_DEVICE_BOUND_TYPES = new Set(["device.upsert", "control.catalog.upsert", "control.catalog.tombstone", "device.state", "usage.bucket", "temperature.sample"]);

function initialSyncOutbox() {
  return {
    schemaVersion: 1,
    streamId: crypto.randomUUID(),
    nextSequence: 1,
    acknowledgedSequence: 0,
    cloudRevision: 0,
    configurationAppliedRevision: 0,
    snapshotCreatedAt: null,
    snapshotDeviceIds: [],
    events: [],
    inFlight: null,
    lastAttemptAt: null,
    lastSuccessfulSyncAt: null,
    lastErrorCode: null,
    gapDetected: false,
    criticalBacklog: false,
    telemetryPaused: false,
    droppedTelemetryCount: 0,
    acknowledgedAutomationOccurrences: [],
  };
}

function normalizeSyncOutbox(value) {
  const base = initialSyncOutbox();
  const input = value && typeof value === "object" ? value : {};
  const events = Array.isArray(input.events) ? input.events
    .filter((event) => event && typeof event === "object" && Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.payload && typeof event.payload === "object")
    .map((event) => ({ ...event, id: String(event.id || crypto.randomUUID()), type: String(event.type || ""), aggregateId: String(event.aggregateId || ""), critical: event.critical === true }))
    .sort((left, right) => left.sequence - right.sequence) : [];
  const maxSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
  return {
    ...base,
    ...input,
    schemaVersion: 1,
    streamId: typeof input.streamId === "string" && input.streamId.length >= 16 && input.streamId.length <= 80 ? input.streamId : base.streamId,
    nextSequence: Math.max(1, Number(input.nextSequence) || 1, maxSequence + 1),
    acknowledgedSequence: Math.max(0, Number(input.acknowledgedSequence) || 0),
    cloudRevision: Math.max(0, Number(input.cloudRevision) || 0),
    configurationAppliedRevision: Math.max(0, Number(input.configurationAppliedRevision) || 0),
    snapshotCreatedAt: input.snapshotCreatedAt || null,
    snapshotDeviceIds: Array.isArray(input.snapshotDeviceIds) ? [...new Set(input.snapshotDeviceIds.map(String))].slice(0, 100000) : [],
    events,
    inFlight: input.inFlight && typeof input.inFlight === "object" ? input.inFlight : null,
    gapDetected: input.gapDetected === true,
    criticalBacklog: input.criticalBacklog === true,
    telemetryPaused: input.telemetryPaused === true,
    droppedTelemetryCount: Math.max(0, Number(input.droppedTelemetryCount) || 0),
    acknowledgedAutomationOccurrences: Array.isArray(input.acknowledgedAutomationOccurrences)
      ? [...new Set(input.acknowledgedAutomationOccurrences.map(String))].slice(-500) : [],
  };
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function compactSuperseded(outbox, type, aggregateId) {
  if (!COALESCIBLE_TYPES.has(type) || outbox.inFlight) return false;
  const previous = [...outbox.events].reverse().find((event) => event.type === type && event.aggregateId === aggregateId && event.sequence > outbox.acknowledgedSequence);
  if (!previous) return false;
  // Preserve the contiguous sequence while compacting only superseded metadata.
  previous.type = "sync.compacted";
  previous.aggregateId = "";
  previous.payload = { supersededBy: outbox.nextSequence };
  previous.critical = false;
  return true;
}

function compactUnregisteredPropertyDeviceEvents(outbox, currentPropertyDeviceIds) {
  const current = currentPropertyDeviceIds instanceof Set ? currentPropertyDeviceIds : new Set();
  const inFlightSequences = new Set((outbox.inFlight?.events || []).map((event) => Number(event.sequence)));
  let compacted = 0;
  for (const event of outbox.events) {
    if (Number(event.sequence) <= Number(outbox.acknowledgedSequence || 0) || inFlightSequences.has(Number(event.sequence))
      || !PROPERTY_DEVICE_BOUND_TYPES.has(String(event.type)) || !event.payload?.osDeviceId
      || current.has(String(event.payload.osDeviceId))) continue;
    // A policy snapshot is the current authority for property projections. If
    // that authority is gone, stale unsent device data must not block the
    // contiguous stream or be replayed into another management class. Keep the
    // sequence with the same redacted marker used for safe metadata compaction.
    event.type = "sync.compacted";
    event.aggregateId = "";
    event.payload = { supersededBy: outbox.nextSequence };
    event.critical = false;
    compacted += 1;
  }
  return compacted;
}

function enqueueSyncEventInState(state, type, aggregateId, payload, options = {}) {
  const outbox = state.syncOutbox = normalizeSyncOutbox(state.syncOutbox);
  const critical = options.critical === true || CRITICAL_TYPES.has(type);
  if (!type || typeof type !== "string" || !aggregateId || typeof aggregateId !== "string" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid native sync event");
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid native sync event time");
  if (options.dedupeRevision !== undefined) {
    const revision = Number(options.dedupeRevision);
    const existing = [...outbox.events, ...(outbox.inFlight?.events || [])].find((entry) => entry.type === type
      && entry.aggregateId === aggregateId && Number(entry.payload?.revision) === revision);
    if (existing) return JSON.parse(JSON.stringify(existing));
  }
  compactSuperseded(outbox, type, aggregateId);
  const event = {
    id: crypto.randomUUID(),
    sequence: outbox.nextSequence,
    type,
    aggregateId,
    occurredAt: now.toISOString(),
    critical,
    payload: JSON.parse(JSON.stringify(payload)),
  };
  const projectedBytes = encodedBytes([...outbox.events, event]);
  // Never delete an expired event from the middle of the stream: that would
  // manufacture a sequence gap and make later durable events unacknowledgeable.
  // Old unsuperseded events remain visible as backlog until a snapshot/reset
  // protocol can safely replace them.
  const expired = outbox.events.some((entry) => now.getTime() - Date.parse(entry.occurredAt) > SYNC_OUTBOX_MAX_AGE_MS);
  if (expired) outbox.gapDetected = true;
  const overLimit = outbox.events.length >= SYNC_OUTBOX_MAX_EVENTS || projectedBytes > SYNC_OUTBOX_MAX_BYTES;
  if (overLimit && !critical) {
    outbox.telemetryPaused = true;
    outbox.gapDetected = true;
    outbox.droppedTelemetryCount += 1;
    return null;
  }
  if (overLimit && critical) {
    outbox.criticalBacklog = true;
    throw Object.assign(new Error("Critical native sync backlog is at its durable limit"), { code: "sync_critical_backlog_full" });
  }
  outbox.events.push(event);
  outbox.nextSequence += 1;
  // Queueing another event does not recover a previously rejected in-flight
  // batch. Keep its delivery error until a real sync/configuration receipt
  // clears it; descriptor reconciliation depends on this durable signal.
  return JSON.parse(JSON.stringify(event));
}

function nextSyncBatch(outboxValue, options = {}) {
  const outbox = normalizeSyncOutbox(outboxValue);
  if (outbox.inFlight) return JSON.parse(JSON.stringify(outbox.inFlight));
  const pending = outbox.events.filter((event) => event.sequence > outbox.acknowledgedSequence);
  if (!pending.length) return null;
  const allowedTypesPrefix = Array.isArray(options.allowedTypesPrefix) ? new Set(options.allowedTypesPrefix.map(String)) : null;
  const events = [];
  for (const event of pending.slice(0, SYNC_BATCH_MAX_EVENTS)) {
    if (allowedTypesPrefix && !allowedTypesPrefix.has(event.type)) break;
    if (typeof options.allowedEventPrefix === "function" && !options.allowedEventPrefix(event)) break;
    events.push(event);
  }
  if (!events.length) return null;
  const selected = [];
  for (const event of events) {
    const next = [...selected, event];
    if (selected.length && encodedBytes(next) > SYNC_BATCH_MAX_BYTES) break;
    if (encodedBytes(next) > SYNC_BATCH_MAX_BYTES) throw new Error("A single native sync event exceeds the batch limit");
    selected.push(event);
  }
  const envelope = {
    schemaVersion: 1,
    hubInstallationId: String(options.hubInstallationId || ""),
    streamId: outbox.streamId,
    fromSequence: selected[0].sequence,
    toSequence: selected[selected.length - 1].sequence,
    events: selected,
    queueDepth: pending.length,
    acknowledgedCloudRevision: outbox.cloudRevision,
    runtime: options.runtime || { kind: "dinodia_os", version: "0.0.0", capabilities: {} },
    sentAt: new Date(options.now || Date.now()).toISOString(),
  };
  if (!envelope.hubInstallationId) throw new Error("Native sync requires the enrolled hub installation ID");
  return envelope;
}

module.exports = {
  SYNC_BATCH_MAX_BYTES,
  SYNC_BATCH_MAX_EVENTS,
  SYNC_OUTBOX_MAX_AGE_MS,
  SYNC_OUTBOX_MAX_BYTES,
  SYNC_OUTBOX_MAX_EVENTS,
  enqueueSyncEventInState,
  compactUnregisteredPropertyDeviceEvents,
  initialSyncOutbox,
  nextSyncBatch,
  normalizeSyncOutbox,
};
