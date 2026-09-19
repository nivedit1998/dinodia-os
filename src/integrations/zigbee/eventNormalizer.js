const ACTIONS = new Set(["single", "double", "triple", "quadruple", "hold", "release", "on", "off", "toggle", "arrow_left_click", "arrow_right_click", "brightness_move_up", "brightness_move_down"]);

function normalizeAction(action) {
  const value = String(action || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "on" || value.endsWith("_click")) return value === "on" ? "single" : value;
  return ACTIONS.has(value) ? value : value.slice(0, 64);
}

class ZigbeeEventNormalizer {
  constructor({ windowMs = 750, duplicateWindowMs = 100, logger = console } = {}) {
    this.windowMs = Math.max(100, Math.min(Number(windowMs) || 750, 3000));
    this.logger = logger;
    this.duplicateWindowMs = Math.max(50, Math.min(Number(duplicateWindowMs) || 100, this.windowMs));
    this.sequence = 0;
    this.recent = new Map();
  }

  normalize({ deviceId, endpointId = "0", payload = {}, timestamp = new Date().toISOString() } = {}) {
    const rawAction = payload && (payload.action || payload.click || payload.event);
    const action = normalizeAction(rawAction);
    if (!deviceId || !action) return null;
    const key = `${deviceId}:${endpointId}:${action}`;
    const now = Date.now();
    const previous = this.recent.get(key) || 0;
    for (const [candidate, at] of this.recent) if (now - at > this.windowMs) this.recent.delete(candidate);
    this.recent.set(key, now);
    return {
      eventType: "button",
      action,
      endpointId: String(endpointId),
      button: payload.button || payload.endpoint || null,
      rawAction: String(rawAction),
      sequence: ++this.sequence,
      duplicate: previous > 0 && now - previous < this.duplicateWindowMs,
      occurredAt: timestamp,
    };
  }
}

module.exports = { ZigbeeEventNormalizer, normalizeAction };
