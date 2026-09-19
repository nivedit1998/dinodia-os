const mqtt = require("mqtt");
const crypto = require("node:crypto");
const { normalizeZigbeeDevice } = require("./integrations/zigbee/exposeNormalizer");
const { parseDiscovery, reconcileDiscovery } = require("./integrations/zigbee/discoveryRegistry");
const { ZigbeeEventNormalizer } = require("./integrations/zigbee/eventNormalizer");
const { ZigbeePairingSession } = require("./integrations/zigbee/pairingSession");
const { stableDeviceId } = require("./capabilities/identity");
const { isMachineName } = require("./deviceNaming");

function topicPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function exposeEntities(exposes, deviceId, output = {}, parentDomain = "") {
  for (const expose of Array.isArray(exposes) ? exposes : []) {
    if (!expose || typeof expose !== "object") continue;
    const domain = ["light", "switch", "cover", "climate", "fan", "lock", "vacuum", "humidifier", "camera", "button", "binary_sensor", "sensor"].includes(String(expose.type || ""))
      ? String(expose.type)
      : parentDomain;
    if (Array.isArray(expose.features)) exposeEntities(expose.features, deviceId, output, domain);
    const stateKey = expose.property || expose.name;
    if (!stateKey || expose.type === "text" && !expose.property) continue;
    const entityId = `${deviceId}:${String(stateKey)}`;
    output[entityId] = {
      id: entityId,
      deviceId: String(deviceId),
      stateKey: String(stateKey),
      domain: domain || undefined,
      name: String(expose.name || stateKey).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      expose: {
        type: expose.type,
        access: expose.access,
        unit: expose.unit,
        device_class: expose.device_class,
        values: expose.values,
        value_min: expose.value_min,
        value_max: expose.value_max,
      },
    };
  }
  return output;
}

class MqttBridge {
  constructor({ url, baseTopic = "zigbee2mqtt", discoveryPrefix = "dinodia-ha", pairingSeconds = 120, eventDedupeMs = 1500, store, onDeviceChanged, onRemoteEvent, logger = console }) {
    this.url = url;
    this.baseTopic = baseTopic.replace(/\/$/, "");
    this.discoveryPrefix = String(discoveryPrefix || "dinodia-ha").replace(/\/$/, "");
    this.store = store;
    this.onDeviceChanged = onDeviceChanged;
    this.onRemoteEvent = onRemoteEvent;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.lastMessageAt = null;
    this.permitJoinUntil = null;
    this.remoteEventWindow = new Map();
    this.pendingRemovals = new Map();
    this.discovery = {};
    this.events = new ZigbeeEventNormalizer({ logger, duplicateWindowMs: eventDedupeMs });
    this.pairingSession = new ZigbeePairingSession({ logger, ttlSeconds: pairingSeconds });
  }

  start() {
    if (!this.url) return;
    this.client = mqtt.connect(this.url, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
    });
    this.client.on("connect", () => {
      this.connected = true;
      this.lastError = null;
      this.client.subscribe(`${this.baseTopic}/#`, (error) => {
        if (error) this.setError(error);
      });
      this.client.subscribe(`${this.discoveryPrefix}/#`, (error) => {
        if (error) this.setError(error);
      });
      this.logger.log(`[mqtt] connected to ${this.url.replace(/:\/\/.*@/, "://***@")}`);
    });
    this.client.on("reconnect", () => {
      this.connected = false;
    });
    this.client.on("close", () => {
      this.connected = false;
    });
    this.client.on("error", (error) => this.setError(error));
    this.client.on("message", (topic, payload) => {
      this.handleMessage(topic, payload).catch((error) => this.setError(error));
    });
  }

  setError(error) {
    this.lastError = String(error && error.message ? error.message : error);
    this.logger.error(`[mqtt] ${this.lastError}`);
  }

  status() {
    return {
      configured: Boolean(this.url),
      connected: this.connected,
      url: this.url ? this.url.replace(/:\/\/.*@/, "://***@") : "",
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      permitJoinUntil: this.permitJoinUntil,
    };
  }

  async handleMessage(topic, payload) {
    this.lastMessageAt = new Date().toISOString();
    const text = payload.toString("utf8");
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Availability and simple status topics are intentionally plain text.
    }
    if (topic.startsWith(`${this.discoveryPrefix}/`)) {
      const parsed = parseDiscovery(topic, value, this.discoveryPrefix);
      if (parsed) {
        this.discovery = reconcileDiscovery(this.discovery, parsed);
        this.logger.log(`[mqtt] discovery received for ${parsed.uniqueId}`);
      }
      return;
    }
    const relative = topic.startsWith(`${this.baseTopic}/`) ? topic.slice(this.baseTopic.length + 1) : topic;
    if (relative === "bridge/devices" && Array.isArray(value)) {
      if (this.store.saveConfigEntry) await this.store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
      let stopPairingAfterSync = false;
      for (const item of value) {
        const normalized = normalizeZigbeeDevice(item);
        if (normalized.infrastructure) continue;
        const id = normalized.id;
        if (!id) continue;
        const existing = this.store.getDevice(String(id)) || this.store.listDevices().find((device) => String(device.metadata?.ieee_address || device.protocolIdentity?.ieeeAddress || "") === String(item.ieee_address || "") || String(device.metadata?.friendly_name || device.name || "") === String(item.friendly_name || ""));
        const pairingActive = this.pairingSession.status().active;
        // Zigbee2MQTT publishes its entire inventory on startup. Inventory is
        // not permission to pair a household device; only an explicit pairing
        // session may create a new registry record.
        if (!existing && !pairingActive) continue;
        const incoming = {
          ...normalized,
          name: existing?.setup?.status === "ready" || (existing?.name && !isMachineName(existing.name)) ? existing.name : normalized.name,
          available: item.disabled_by !== "config" && item.supported !== false,
          metadata: { ...normalized.metadata, ...item },
          protocolIdentity: { ieeeAddress: String(item.ieee_address || "") },
        };
        const updated = existing && existing.id !== id && typeof this.store.migrateDeviceIdentity === "function"
          ? await this.store.migrateDeviceIdentity(existing.id, id, incoming)
          : await this.store.upsertDevice(incoming);
        const newForPairing = pairingActive && this.pairingSession.isNew(updated.id);
        this.pairingSession.add(updated.id, {
          stage: "needs_setup",
          manufacturer: updated.metadata?.manufacturer || updated.metadata?.manufacturer_name || "",
          model: updated.metadata?.model || updated.metadata?.model_id || "",
          name: updated.name,
          interviewStatus: updated.interviewStatus || "successful",
          surfacePreview: { count: Object.keys(updated.presentation?.surfaces || {}).length, types: Object.values(updated.presentation?.surfaces || {}).map((surface) => surface.inferredType || surface.domain) },
        });
        if (newForPairing && updated.interviewStatus === "successful") stopPairingAfterSync = true;
        if (this.onDeviceChanged) await this.onDeviceChanged(updated, existing);
      }
      if (stopPairingAfterSync && this.pairingSession.status().active) {
        if (this.client && this.connected) await this.permitJoin(0);
        this.pairingSession.stop();
      }
      return;
    }
    if (relative === "bridge/event" && value && typeof value === "object") {
      const eventType = String(value.type || "");
      const data = value.data && typeof value.data === "object" ? value.data : value;
      const id = this.resolveDeviceId(data.friendly_name || data.ieee_address || data.id);
      if (this.pairingSession.status().active && id && /join|interview|device_added|device_joined/i.test(eventType)) {
        this.pairingSession.add(id, { stage: /fail|error/i.test(eventType) ? "interview_failed" : /interview/i.test(eventType) ? "interviewing" : "joined" });
      }
      if (id) {
        await this.store.addEvent({ type: `zigbee_${eventType || "bridge_event"}`, deviceId: String(id), protocol: "zigbee" });
      }
      return;
    }
    if (relative === "bridge/response/device/remove" && value && typeof value === "object") {
      const transaction = String(value.transaction || "");
      const removal = (transaction && this.pendingRemovals.get(transaction)) || [...this.pendingRemovals.values()].find((pending) => pending.id === String(value.data?.id || ""));
      if (removal) {
        clearTimeout(removal.timer);
        this.pendingRemovals.delete(removal.transaction);
        if (String(value.status || "").toLowerCase() === "error") removal.reject(new Error(value.error || "Zigbee2MQTT could not remove the device"));
        else removal.resolve(value);
      }
      return;
    }
    if (relative.startsWith("bridge/")) return;
    const parts = relative.split("/");
    if (!parts[0]) return;
    if (this.store.saveConfigEntry) await this.store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
    const id = this.resolveDeviceId(parts[0]);
    let device;
    let previous;
    if (parts[1] === "availability") {
      const availability = value && typeof value === "object" ? value.state : value;
      previous = this.store.getDevice(id);
      const existing = this.store.getDevice(id);
      if (!existing && !this.pairingSession.status().active) return;
      device = await this.store.upsertDevice({
        id,
        name: existing?.name || id,
        protocol: "zigbee",
        available: String(availability).toLowerCase() === "online",
      });
    } else if (parts.length === 1 && value && typeof value === "object" && !Array.isArray(value)) {
      const existing = this.store.getDevice(id);
      previous = existing;
      if (!existing && !this.pairingSession.status().active) return;
      device = await this.store.updateDeviceState(id, value, { protocol: "zigbee", available: true, name: existing?.name || id });
    } else {
      return;
    }
    await this.store.addEvent({ type: "device_state", deviceId: device.id, protocol: device.protocol });
    if (value && typeof value === "object" && value.action && this.onRemoteEvent) {
      const event = this.events.normalize({ deviceId: device.id, endpointId: value.endpoint || value.endpoint_id || "0", payload: value });
      if (event && !event.duplicate) await this.onRemoteEvent({ deviceId: device.id, action: event.action, payload: value, normalized: event, timestamp: event.occurredAt });
    }
    if (this.onDeviceChanged) await this.onDeviceChanged(device, previous);
  }

  async command(deviceId, command) {
    if (!this.client || !this.connected) throw new Error("MQTT is not connected");
    const device = this.store.getDevice(deviceId);
    const topicName = device?.metadata?.friendly_name || device?.metadata?.friendlyName || device?.legacyIds?.[0] || deviceId;
    const topic = `${this.baseTopic}/${topicPart(topicName)}/set`;
    const payload = JSON.stringify(command || {});
    await new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 0, retain: false }, (error) => error ? reject(error) : resolve());
    });
    await this.store.addEvent({ type: "device_command", deviceId: String(deviceId), protocol: "zigbee" });
  }

  resolveDeviceId(value) {
    const requested = String(value || "");
    const direct = this.store.getDevice(requested);
    if (direct) return direct.id;
    const found = this.store.listDevices().find((device) => String(device.metadata?.friendly_name || "") === requested || String(device.metadata?.ieee_address || "") === requested || String(device.protocolIdentity?.ieeeAddress || "") === requested);
    return found ? found.id : requested;
  }

  async permitJoin(time = 254) {
    if (!this.client || !this.connected) throw new Error("MQTT is not connected");
    const topic = `${this.baseTopic}/bridge/request/permit_join`;
    const bounded = Math.max(0, Math.min(Number(time) || 254, 254));
    await new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify({ time: bounded }), { qos: 0, retain: false }, (error) => error ? reject(error) : resolve());
    });
    this.permitJoinUntil = bounded > 0 ? new Date(Date.now() + bounded * 1000).toISOString() : null;
    await this.store.addEvent({ type: "zigbee_permit_join", seconds: bounded });
  }

  async startPairing(seconds = 120) {
    const bounded = Math.max(30, Math.min(Number(seconds) || 120, 254));
    await this.permitJoin(bounded);
    const knownIds = this.store?.listDevices ? this.store.listDevices().map((device) => device.id) : [];
    this.pairingSession.start(this.permitJoinUntil, bounded, knownIds);
    return this.pairingStatus();
  }

  async stopPairing() {
    await this.permitJoin(0);
    this.pairingSession.stop();
    return this.pairingStatus();
  }

  pairingStatus() {
    return this.pairingSession.status();
  }

  async remove(deviceId, force = false) {
    if (!this.client || !this.connected) throw new Error("MQTT is not connected");
    const device = this.store.getDevice(deviceId);
    if (!device) throw new Error("Zigbee device is not registered");
    const topic = `${this.baseTopic}/bridge/request/device/remove`;
    const removalId = device.metadata?.friendly_name || device.metadata?.friendlyName || device.metadata?.ieee_address || device.protocolIdentity?.ieeeAddress || deviceId;
    const transaction = crypto.randomUUID();
    const payload = JSON.stringify({ id: String(removalId), clear_cache: true, transaction, ...(force ? { force: true } : {}) });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRemovals.delete(transaction);
        reject(new Error("Timed out waiting for Zigbee2MQTT to remove the device"));
      }, 15000);
      this.pendingRemovals.set(transaction, { transaction, id: String(removalId), timer, resolve, reject });
      this.client.publish(topic, payload, { qos: 0, retain: false }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingRemovals.delete(transaction);
        reject(error);
      });
    });
    await this.store.addEvent({ type: "zigbee_device_remove_requested", deviceId: String(deviceId) });
  }

  forgetDevice(deviceId) {
    const requested = String(deviceId || "");
    const device = this.store.getDevice(requested);
    const identifiers = new Set([requested, device?.id, device?.metadata?.friendly_name, device?.metadata?.ieee_address, ...(device?.legacyIds || [])].filter(Boolean).map(String));
    for (const id of Object.keys(this.discovery || {})) if (identifiers.has(String(id))) delete this.discovery[id];
    if (this.pairingSession.forget) this.pairingSession.forget(requested);
  }

  close() {
    if (this.client) this.client.end(true);
  }
}

module.exports = { MqttBridge };
