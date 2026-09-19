const crypto = require("node:crypto");
const WebSocket = require("ws");
const { normalizeMatterNode } = require("./integrations/matter/nodeNormalizer");
const { matterName, isMachineName } = require("./deviceNaming");
const { stableDeviceId } = require("./capabilities/identity");
const { sourceVersion } = require("./integrations/matter/catalog");

function matterAttributeParts(pathValue) {
  if (pathValue && typeof pathValue === "object") {
    return {
      endpointId: String(pathValue.endpoint_id ?? pathValue.endpointId ?? pathValue.endpoint ?? ""),
      clusterId: String(pathValue.cluster_id ?? pathValue.clusterId ?? pathValue.cluster ?? ""),
      attributeId: String(pathValue.attribute_id ?? pathValue.attributeId ?? pathValue.attribute ?? ""),
    };
  }
  const parts = String(pathValue || "").split(/[/:.]/).filter(Boolean);
  return { endpointId: parts[0] || "", clusterId: parts[1] || "", attributeId: parts[2] || "" };
}

class MatterBridge {
  constructor({ url, store, onDeviceChanged, onDeviceIngested, logger = console }) {
    this.url = url;
    this.store = store;
    this.onDeviceChanged = onDeviceChanged;
    this.onDeviceIngested = onDeviceIngested;
    this.logger = logger;
    this.socket = null;
    this.connected = false;
    this.lastError = null;
    this.pending = new Map();
    this.stopped = false;
    this.allowNewNodes = false;
  }

  start() {
    if (!this.url) return;
    this.stopped = false;
    this.connect();
  }

  setUrl(url) {
    const nextUrl = String(url || "").trim();
    if (nextUrl === this.url && (nextUrl ? this.connected || this.socket : true)) return;
    this.close();
    this.url = nextUrl;
    if (this.url) this.start();
  }

  connect() {
    this.socket = new WebSocket(this.url);
    this.socket.on("open", () => {
      this.connected = true;
      this.lastError = null;
      this.logger.log(`[matter] connected to ${this.url}`);
      this.refresh().catch((error) => this.setError(error));
    });
    this.socket.on("message", (data) => {
      this.handleMessage(data.toString()).catch((error) => this.setError(error));
    });
    this.socket.on("close", () => {
      this.connected = false;
      for (const pending of this.pending.values()) pending.reject(new Error("Matter Server disconnected"));
      this.pending.clear();
      setTimeout(() => {
        if (!this.stopped && !this.connected && this.url) this.connect();
      }, 5000).unref();
    });
    this.socket.on("error", (error) => this.setError(error));
  }

  setError(error) {
    this.lastError = String(error && error.message ? error.message : error);
    this.logger.error(`[matter] ${this.lastError}`);
  }

  status() {
    return { configured: Boolean(this.url), connected: this.connected, url: this.url, lastError: this.lastError, modelVersion: sourceVersion() };
  }

  request(command, args = {}, timeoutMs = 15000) {
    if (!this.socket || !this.connected || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Matter Server is not connected"));
    }
    const messageId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Matter command timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(messageId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ message_id: messageId, command, args }));
    });
  }

  async handleMessage(text) {
    const message = JSON.parse(text);
    if (message.message_id && this.pending.has(message.message_id)) {
      const pending = this.pending.get(message.message_id);
      clearTimeout(pending.timer);
      this.pending.delete(message.message_id);
      if (message.error_code !== undefined || message.error) pending.reject(new Error(message.details || message.error || "Matter command failed"));
      else pending.resolve(message.result);
      return;
    }
    if (Array.isArray(message.result)) await this.ingestNodes(message.result, { allowNew: this.allowNewNodes });
    if (message.event === "node_added" || message.event === "node_updated") {
      await this.ingestNodeEvent(message.data || {});
    } else if (message.event === "node_removed") {
      const nodeId = typeof message.data === "object" ? message.data.node_id || message.data.nodeId || message.data.id : message.data;
      const device = this.findDevice(nodeId);
      if (device) await this.store.deleteDevice(device.id);
    } else if (message.event === "attribute_updated" && Array.isArray(message.data)) {
      const [nodeId, attributePath, value] = message.data;
      const deviceId = this.findDevice(nodeId)?.id || stableDeviceId("matter", { nodeId, fabricId: "default" });
      const previous = this.store.getDevice(deviceId);
      const parts = matterAttributeParts(attributePath);
      const target = previous && Object.values(previous.entities || {}).find((entity) => String(entity.binding?.endpointId || entity.endpointId || "") === parts.endpointId && String(entity.binding?.clusterId || "") === parts.clusterId && String(entity.binding?.attributeId || "") === parts.attributeId);
      let device;
      if (target) {
        await this.store.updateEntity(deviceId, target.id, { state: value, available: true });
        device = this.store.getDevice(deviceId);
      } else if (previous || this.allowNewNodes) {
        device = await this.store.updateDeviceState(deviceId, {
          [`attribute_${String(attributePath).replace(/[^a-zA-Z0-9_]/g, "_")}`]: value,
        }, { protocol: "matter", available: true, name: previous?.name && !isMachineName(previous.name) ? previous.name : matterName({ node_id: nodeId }), legacyIds: [`matter-${nodeId}`], protocolIdentity: { nodeId: String(nodeId), fabricId: previous?.protocolIdentity?.fabricId || "default" } });
      }
      if (device && this.onDeviceChanged) await this.onDeviceChanged(device, previous);
    } else if (message.event === "node_event" && message.data) {
      const data = message.data;
      const nodeId = data.node_id || data.nodeId;
      const existing = this.findDevice(nodeId);
      if (!existing && !this.allowNewNodes) return;
      const device = await this.store.updateDeviceState(existing?.id || stableDeviceId("matter", { nodeId, fabricId: "default" }), {
        [`event_${data.endpoint_id}_${data.cluster_id}_${data.event_id}`]: data.data,
      }, { protocol: "matter", available: true, name: existing?.name && !isMachineName(existing.name) ? existing.name : matterName({ node_id: nodeId }), legacyIds: [`matter-${nodeId}`], protocolIdentity: { nodeId: String(nodeId), fabricId: existing?.protocolIdentity?.fabricId || "default" } });
      if (this.onDeviceChanged) await this.onDeviceChanged(device);
    }
  }

  async ingestNodes(nodes, { allowNew = false } = {}) {
    if (this.store.saveConfigEntry && Array.isArray(nodes) && nodes.length) await this.store.saveConfigEntry({ entry_id: "ce_matter", domain: "matter", title: "Matter" });
    for (const node of nodes) {
      const normalized = normalizeMatterNode(node);
      if (!normalized.protocolIdentity.nodeId) continue;
      const previous = this.findDevice(normalized.protocolIdentity.nodeId) || this.store.getDevice(normalized.id);
      if (!previous && !allowNew && !this.allowNewNodes) continue;
      const incoming = { ...normalized, name: previous?.setup?.status === "ready" || (previous?.name && !isMachineName(previous.name)) ? previous.name : normalized.name };
      const device = previous && previous.id !== normalized.id && typeof this.store.migrateDeviceIdentity === "function"
        ? await this.store.migrateDeviceIdentity(previous.id, normalized.id, incoming)
        : await this.store.upsertDevice(incoming);
      if (this.onDeviceIngested) await this.onDeviceIngested(device, previous);
      if (this.onDeviceChanged) await this.onDeviceChanged(device, previous);
    }
  }

  async ingestNodeEvent(data) {
    const node = data.node || data;
    const id = String(node.node_id || node.id || data.node_id || "");
    if (!id) return;
    const normalized = normalizeMatterNode({ ...node, node_id: id, state: data.state || node.state || {} });
    const previous = this.findDevice(id) || this.store.getDevice(normalized.id);
    if (!previous && !this.allowNewNodes) return;
    const incoming = { ...normalized,
      id: previous?.id || normalized.id,
      name: previous?.setup?.status === "ready" || (previous?.name && !isMachineName(previous.name)) ? previous.name : normalized.name,
      protocol: "matter",
      available: data.available !== false && node.available !== false,
    };
    const device = previous && previous.id !== normalized.id && typeof this.store.migrateDeviceIdentity === "function"
      ? await this.store.migrateDeviceIdentity(previous.id, normalized.id, { ...incoming, id: normalized.id })
      : await this.store.upsertDevice(incoming);
    if (this.onDeviceIngested) await this.onDeviceIngested(device, previous);
    if (this.onDeviceChanged) await this.onDeviceChanged(device, previous);
  }

  async refresh(options = {}) {
    return this.refreshWithOptions(options);
  }

  async refreshWithOptions(options = {}) {
    if (!this.connected) return [];
    const result = await this.request("start_listening", {});
    const nodes = Array.isArray(result) ? result : (result && Array.isArray(result.nodes) ? result.nodes : []);
    await this.ingestNodes(nodes, options);
    return nodes;
  }

  async command(deviceId, request) {
    const device = this.store.getDevice(deviceId);
    const nodeId = String(device?.protocolIdentity?.nodeId || String(deviceId).replace(/^matter(?::[^:]+)?:|^matter-/, ""));
    let result;
    if (request && request.command) {
      result = await this.request(request.command, request.args || {});
    } else {
      result = await this.request("device_command", {
        node_id: Number(nodeId),
        ...(request || {}),
      });
    }
    await this.store.addEvent({ type: "device_command", deviceId: String(deviceId), protocol: "matter" });
    return result;
  }

  findDevice(nodeId) {
    const requested = String(nodeId ?? "");
    return this.store.listDevices().find((device) => device.protocol === "matter" && (String(device.protocolIdentity?.nodeId || "") === requested || (device.legacyIds || []).map(String).includes(`matter-${requested}`) || device.id === requested)) || null;
  }

  async commission(code, networkOnly = false) {
    this.allowNewNodes = true;
    try {
      return await this.request("commission_with_code", { code: String(code), network_only: Boolean(networkOnly) }, 300000);
    } finally {
      this.allowNewNodes = false;
    }
  }

  async remove(deviceId) {
    const device = this.store.getDevice(deviceId);
    if (!device) throw new Error("Matter device is not registered");
    const nodeId = device.protocolIdentity?.nodeId || String(device.id).replace(/^matter(?::[^:]+)?:|^matter-/, "");
    const result = await this.request("remove_node", { node_id: Number(nodeId) });
    await this.store.addEvent({ type: "matter_device_remove_requested", deviceId: String(device.id), protocol: "matter" });
    return result;
  }

  forgetDevice(deviceId) {
    return undefined;
  }

  async setWifiCredentials(ssid, credentials, id) {
    return this.request("set_wifi_credentials", { ssid: String(ssid), credentials: String(credentials), ...(id ? { id: String(id) } : {}) });
  }

  async setThreadDataset(dataset, id) {
    return this.request("set_thread_dataset", { dataset: String(dataset), ...(id ? { id: String(id) } : {}) });
  }

  close() {
    this.stopped = true;
    if (this.socket) this.socket.close();
  }
}

module.exports = { MatterBridge };
