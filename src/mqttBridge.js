const mqtt = require("mqtt");
const crypto = require("node:crypto");
const path = require("node:path");
const { normalizeZigbeeDevice } = require("./integrations/zigbee/exposeNormalizer");
const { TRACKED_PROPERTIES, readObservationConfiguration, strictUtcTimestamp } = require("./integrations/zigbee/observationContract");
const { parseDiscovery, reconcileDiscovery } = require("./integrations/zigbee/discoveryRegistry");
const { ZigbeeEventNormalizer } = require("./integrations/zigbee/eventNormalizer");
const { ZigbeePairingSession } = require("./integrations/zigbee/pairingSession");
const { stableDeviceId } = require("./capabilities/identity");
const { nativeControlId } = require("./store");
const { isMachineName } = require("./deviceNaming");
const { sourceFingerprint } = require("./capabilities/devicePresentation");
const { buildPublicCommissioningCatalogue } = require("./commissioning/publicDeviceCatalogue");
const { validateCloudConfiguration } = require("./sync/cloudConfiguration");

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
  constructor({ url, baseTopic = "zigbee2mqtt", discoveryPrefix = "dinodia-ha", pairingSeconds = 120, eventDedupeMs = 1500, store, onDeviceChanged, onRemoteEvent, observationConfigPath, mqttConnect = mqtt.connect, clock = Date.now, logger = console }) {
    this.url = url;
    this.baseTopic = baseTopic.replace(/\/$/, "");
    this.discoveryPrefix = String(discoveryPrefix || "dinodia-ha").replace(/\/$/, "");
    this.store = store;
    this.observationConfigPath = String(observationConfigPath || path.join(process.env.DINODIA_DATA_DIR || path.join(process.cwd(), "data"), "zigbee2mqtt", "configuration.yaml"));
    this.mqttConnect = mqttConnect;
    this.clock = clock;
    this.onDeviceChanged = onDeviceChanged;
    this.onRemoteEvent = onRemoteEvent;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.lastMessageAt = null;
    this.connectionGeneration = 0;
    this.deviceInventory = null;
    this.rawDeviceInventory = null;
    this.permitJoinUntil = null;
    this.remoteEventWindow = new Map();
    this.pendingRemovals = new Map();
    // Hub-managed observation policy (src/observation/reconciler.js); set by the server.
    this.observationPolicy = null;
    this.discovery = {};
    this.events = new ZigbeeEventNormalizer({ logger, duplicateWindowMs: eventDedupeMs });
    this.pairingSession = new ZigbeePairingSession({ logger, ttlSeconds: pairingSeconds });
  }

  start() {
    if (!this.url) return;
    this.client = this.mqttConnect(this.url, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
    });
    this.client.on("connect", () => {
      this.connected = true;
      this.connectionGeneration += 1;
      // The retained bridge/devices snapshot is authoritative only after it
      // has been observed on this MQTT connection. Never carry an old
      // inventory across a broker outage and mistake it for current state.
      this.deviceInventory = null;
      this.rawDeviceInventory = null;
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
    this.client.on("message", (topic, payload, packet) => {
      this.handleMessage(topic, payload, packet).catch((error) => this.setError(error));
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

  deviceInventorySnapshot() {
    const snapshot = this.deviceInventory;
    if (!snapshot) return null;
    return {
      complete: snapshot.complete === true,
      current: this.connected === true && snapshot.connectionGeneration === this.connectionGeneration,
      observedAt: snapshot.observedAt,
      devices: snapshot.devices.map((device) => JSON.parse(JSON.stringify(device))),
    };
  }

  canonicalPropertyRestore(item, normalized, diagnostics = null) {
    const skip = (reason) => {
      if (diagnostics && typeof diagnostics === "object") diagnostics.reason = reason;
      return null;
    };
    const snapshot = this.deviceInventorySnapshot();
    if (!snapshot?.complete || snapshot.current !== true || !Array.isArray(snapshot.devices)) return skip("inventory_not_current");
    const identity = String(item?.ieee_address || item?.ieee || normalized?.protocolIdentity?.ieeeAddress || "").trim().toLowerCase();
    if (!identity || stableDeviceId("zigbee", { ieeeAddress: identity }) !== String(normalized?.id || "")) return skip("identity_mismatch");
    const observed = snapshot.devices.find((device) => String(device.id || "") === String(normalized.id)
      && String(device.protocol || "").toLowerCase() === "zigbee"
      && String(device.protocolIdentity?.ieeeAddress || "").trim().toLowerCase() === identity
      && device.infrastructure !== true);
    if (!observed) return skip("identity_not_in_snapshot");

    const platform = this.store.getPlatform?.() || {};
    const configuration = platform.cloudConfiguration;
    if (!configuration || Number(configuration.revision) !== Number(platform.cloudRevision)
      || String(configuration.checksum || "") !== String(platform.cloudConfigurationChecksum || "")
      || !validateCloudConfiguration(configuration, platform)) return skip("cloud_configuration_not_current");
    const cloudPolicies = Array.isArray(configuration.devicePolicies) ? configuration.devicePolicies : [];
    const matches = cloudPolicies.filter((policy) => String(policy.osDeviceId || "") === String(normalized.id));
    if (matches.length !== 1) return skip("no_unique_cloud_policy");
    const policy = matches[0];
    if (policy.managementClass !== "PROPERTY_DEVICE" || policy.ownerMembershipId !== null
      || !["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle || ""))
      || !Number.isSafeInteger(Number(policy.descriptorRevision)) || Number(policy.descriptorRevision) < 1
      || !/^[a-f0-9]{64}$/i.test(String(policy.descriptorDigest || ""))
      || !Array.isArray(policy.osAreaIds) || policy.osAreaIds.length !== 1) return skip("policy_not_installable");
    const hubAreaId = String(policy.osAreaIds[0]);
    const canonicalAreas = configuration.areas.filter((area) => String(area.osAreaId) === hubAreaId);
    const bindingMatches = (platform.areaBindings || []).filter((binding) => String(binding.hubAreaId) === hubAreaId
      && canonicalAreas.some((area) => String(area.id) === String(binding.areaId)));
    if (canonicalAreas.length !== 1 || bindingMatches.length !== 1 || !this.store.getArea?.(hubAreaId)) return skip("area_binding_unavailable");
    const canonicalArea = canonicalAreas[0];
    const policyForDevice = platform.devicePolicies?.[String(normalized.id)];
    if (policyForDevice?.managementClass !== "PROPERTY_DEVICE" || policyForDevice.ownerMembershipId != null
      || String(policyForDevice.lifecycle || "") !== String(policy.lifecycle)
      || Number(policyForDevice.descriptorRevision) !== Number(policy.descriptorRevision)
      || String(policyForDevice.descriptorDigest || "") !== String(policy.descriptorDigest)) return skip("policy_projection_mismatch");

    const name = String(policy.overrideName || policy.customerLabel || normalized.name || "Zigbee device").slice(0, 160);
    const metadata = { ...(normalized.metadata || {}), ...item, managementClass: "property_device" };
    // Discovery normalization produces adapter entities before Store's usual
    // upsert pipeline assigns their stable native control IDs. Rebuild that
    // exact ID projection here before comparing the reviewed public digest;
    // otherwise a valid previously commissioned device looks like a changed
    // catalogue after restart and is incorrectly left out of the registry.
    const entities = Object.fromEntries(Object.entries(normalized.entities || {}).map(([entityId, entity]) => {
      const stateKey = String(entity.stateKey || entityId.split(":").pop() || entityId);
      const endpointId = String(entity.endpointId || "0");
      const logicalKey = String(entity.logicalKey || stateKey);
      const capability = { ...(entity.capability || {}) };
      capability.controlId = nativeControlId(normalized.id, endpointId, logicalKey,
        capability.controlId || entity.controlId || "");
      return [entityId, { ...entity, stateKey, endpointId, logicalKey, capability }];
    }));
    const descriptorInput = {
      ...normalized,
      entities,
      protocolIdentity: { ieeeAddress: identity },
      name,
      areaId: String(canonicalArea.id),
      managementClass: "property_device",
      metadata,
      setup: { ...(normalized.setup || {}), status: "ready", viewOnly: policy.lifecycle === "VIEW_ONLY" },
    };
    descriptorInput.presentation = {
      descriptorRevision: Number(policy.descriptorRevision),
      sourceFingerprint: sourceFingerprint(descriptorInput),
    };
    const descriptor = buildPublicCommissioningCatalogue({
      device: descriptorInput,
      homeId: String(platform.homeId || ""),
      managementClass: "property_device",
      areaId: String(canonicalArea.id),
      name,
      customerLabel: policy.customerLabel || "",
    });
    if (!descriptor || Number(descriptor.descriptorRevision) !== Number(policy.descriptorRevision)
      || String(descriptor.descriptorDigest) !== String(policy.descriptorDigest)) {
      return skip("descriptor_mismatch");
    }

    const normalizedLabel = String(policy.customerLabel || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
    const label = normalizedLabel && typeof this.store.listLabels === "function"
      ? this.store.listLabels().find((row) => String(row.name || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB") === normalizedLabel)
      : null;
    return {
      policy,
      hubAreaId,
      name,
      originalName: String(normalized.name || "Zigbee device").slice(0, 160),
      labelIds: label?.id ? [String(label.id)] : [],
      metadata,
      viewOnly: policy.lifecycle === "VIEW_ONLY",
    };
  }

  async reconcileAuthorizedPropertyInventory() {
    const snapshot = this.deviceInventorySnapshot();
    if (!snapshot?.complete || snapshot.current !== true || !Array.isArray(this.rawDeviceInventory)) return false;
    const missingAuthorizedDevice = this.rawDeviceInventory.some((item) => {
      const normalized = normalizeZigbeeDevice(item);
      return !normalized.infrastructure && normalized.id && !this.store.getDevice(String(normalized.id))
        && Boolean(this.canonicalPropertyRestore(item, normalized));
    });
    if (!missingAuthorizedDevice) return false;
    await this.handleMessage(`${this.baseTopic}/bridge/devices`, Buffer.from(JSON.stringify(this.rawDeviceInventory)));
    return true;
  }

  async handleMessage(topic, payload, packet = null) {
    const receivedMs = Number(this.clock());
    const receivedAt = new Date(receivedMs).toISOString();
    this.lastMessageAt = receivedAt;
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
    if (relative === 'bridge/info' && value && typeof value === 'object') {
      // Keep only observation-related runtime options, never the full config
      // (which may include credentials). The documented bridge/info contract
      // exposes the effective config and restart_required independently.
      this.effectiveObservationOptions = {
        active: value.restart_required === false && value.config?.advanced?.last_seen === 'ISO_8601',
        devices: Object.fromEntries(Object.entries(value.config?.devices || {}).slice(0, 2000).map(([key, options]) => [key, {
          friendly_name: String(options?.friendly_name || ''), optimistic: options?.optimistic === false,
          filtered_cache: Array.isArray(options?.filtered_cache) ? options.filtered_cache.filter(property => /^[A-Za-z0-9_]+$/.test(property)).slice(0, 128) : [],
        }])),
      };
      return;
    }
    if (relative === "bridge/devices" && Array.isArray(value)) {
      if (this.store.saveConfigEntry) await this.store.saveConfigEntry({ entry_id: "ce_zigbee", domain: "zha", title: "Zigbee" });
      const normalizedInventory = value.map((item) => normalizeZigbeeDevice(item))
        .filter((device) => !device.infrastructure && device.id)
        .map((device) => ({ ...device, protocolIdentity: { ieeeAddress: String(device.metadata?.ieee_address || device.id) } }));
      // Zigbee2MQTT publishes this retained, complete inventory on connect
      // and republishes it when a device joins or leaves. It is kept in
      // memory for exact cleanup reconciliation only; it does not import
      // arbitrary inventory into the Dinodia registry or expose it via HTTP.
      this.deviceInventory = {
        complete: true,
        observedAt: this.lastMessageAt,
        connectionGeneration: this.connectionGeneration,
        devices: normalizedInventory,
      };
      this.rawDeviceInventory = value.map((item) => JSON.parse(JSON.stringify(item)));
      let stopPairingAfterSync = false;
      for (const item of value) {
        try {
        const normalized = normalizeZigbeeDevice(item);
        if (normalized.infrastructure) continue;
        const id = normalized.id;
        if (!id) continue;
        const existing = this.store.getDevice(String(id)) || this.store.listDevices().find((device) => String(device.metadata?.ieee_address || device.protocolIdentity?.ieeeAddress || "") === String(item.ieee_address || "") || String(device.metadata?.friendly_name || device.name || "") === String(item.friendly_name || ""));
        const pairingState = this.pairingSession.status();
        const identity = String(normalized.metadata?.ieee_address || normalized.metadata?.ieee || item.ieee_address || "").toLowerCase();
        const permitJoinOpen = Boolean(this.permitJoinUntil && Date.parse(this.permitJoinUntil) > Date.now());
        const pairingActive = pairingState.active && (permitJoinOpen || this.pairingSession.isCandidate(id));
        const canonicalRestore = !existing ? this.canonicalPropertyRestore(item, normalized) : null;
        // Zigbee2MQTT publishes its entire inventory on startup. Inventory is
        // not permission to pair a household device; only an explicit pairing
        // session may create a new registry record. The sole exception is an
        // exact live identity already named by the current cloud-owned
        // permanent-property policy and matching its reviewed descriptor.
        if (!existing && !canonicalRestore && !pairingActive) continue;
        const incoming = {
          ...(canonicalRestore ? {
            ...normalized,
            name: canonicalRestore.name,
            originalName: canonicalRestore.originalName,
            areaId: canonicalRestore.hubAreaId,
            managementClass: "property_device",
            labelIds: canonicalRestore.labelIds,
            labels: canonicalRestore.labelIds,
            setup: { status: "ready", assignmentMode: "device_inherited_v1", completedAt: null, viewOnly: canonicalRestore.viewOnly },
            metadata: canonicalRestore.metadata,
          } : normalized),
          name: canonicalRestore ? canonicalRestore.name
            : existing?.setup?.status === "ready" || (existing?.name && !isMachineName(existing.name)) ? existing.name : normalized.name,
          available: item.disabled_by !== "config" && item.supported !== false,
          metadata: canonicalRestore ? canonicalRestore.metadata : { ...normalized.metadata, ...item },
          protocolIdentity: { ieeeAddress: String(item.ieee_address || "") },
        };
        const updated = existing && existing.id !== id && typeof this.store.migrateDeviceIdentity === "function"
          ? await this.store.migrateDeviceIdentity(existing.id, id, incoming)
          : await this.store.upsertDevice(incoming, canonicalRestore ? {
            canonicalPropertyRestore: true,
            canonicalDescriptorRevision: Number(canonicalRestore.policy.descriptorRevision),
          } : {});
        const newForPairing = pairingActive && !canonicalRestore && this.pairingSession.isNew(updated.id, identity);
        if (!canonicalRestore) this.pairingSession.add(updated.id, {
          identity,
          stage: "needs_setup",
          manufacturer: updated.metadata?.manufacturer || updated.metadata?.manufacturer_name || "",
          model: updated.metadata?.model || updated.metadata?.model_id || "",
          name: updated.name,
          interviewStatus: updated.interviewStatus || "successful",
          surfacePreview: { count: Object.keys(updated.presentation?.surfaces || {}).length, types: Object.values(updated.presentation?.surfaces || {}).map((surface) => surface.inferredType || surface.domain) },
        });
        if (newForPairing && updated.interviewStatus === "successful" && !pairingState.id) stopPairingAfterSync = true;
        if (this.onDeviceChanged) await this.onDeviceChanged(updated, existing);
        } catch (error) {
          // One registry projection must not starve all policy discovery. The Store
          // rolls failed mutations back; reconciliation sees only registered devices.
          this.lastError = String(error?.code || "inventory_projection_failed");
          this.logger?.error?.(`[mqtt] inventory projection deferred (${this.lastError})`);
        }
      }
      await this.notifyObservationPolicy("onInventory", value);
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
    if ((relative === "bridge/response/device/reporting/read" || relative === "bridge/response/device/reporting/configure")
      && value && typeof value === "object") {
      await this.notifyObservationPolicy("onBridgeResponse", relative.endsWith("/read") ? "read" : "configure", value);
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
      await this.notifyObservationPolicy("onAvailability", id, String(availability).toLowerCase() === "online");
    } else if (parts.length === 1 && value && typeof value === "object" && !Array.isArray(value)) {
      const existing = this.store.getDevice(id);
      previous = existing;
      if (!existing && !this.pairingSession.status().active) return;
      const reportedState = { ...value };
      for (const metadataKey of ["last_seen", "elapsed", "endpoint", "endpoint_id", "action"]) delete reportedState[metadataKey];
      const sourceObservedAtByStateKey = {};
      const sourceReceivedAtByStateKey = {};
      const observedEndpointByStateKey = {};
      const sourceObservedAt = packet?.retain === false
        ? strictUtcTimestamp(value.last_seen, receivedMs)
        : null;
      let observationContract = { ok: false, reason: "retained_or_unspecified_mqtt_packet" };
      if (sourceObservedAt && existing) {
        observationContract = await readObservationConfiguration(this.observationConfigPath, {
          friendlyName: existing.metadata?.friendly_name || existing.metadata?.friendlyName || parts[0],
          ieeeAddress: existing.metadata?.ieee_address || existing.protocolIdentity?.ieeeAddress,
        }, { includeProperties: true, ...(this.observationPolicy?.selectedProperties?.(id)?.length
          ? { properties: this.observationPolicy.selectedProperties(id) } : {}) });
      }
      if (sourceObservedAt && observationContract.ok && existing) {
        const policy = this.store.getPlatform?.()?.devicePolicies?.[existing.id];
        if (policy?.analyticsInterval?.genericCollectionEnabled === true) {
          const options = this.effectiveObservationOptions;
          const ieee = existing.metadata?.ieee_address || existing.protocolIdentity?.ieeeAddress;
          const runtime = options?.devices?.[ieee] || Object.values(options?.devices || {}).find(item => item.friendly_name === parts[0]);
          const properties = this.observationPolicy?.selectedProperties?.(existing.id) || [];
          if (!options?.active || !runtime?.optimistic || !properties.length || properties.some(property => !runtime.filtered_cache.includes(property))) {
            observationContract = { ok: false, reason: 'effective_publisher_options_unverified' };
          } else observationContract.properties = (observationContract.properties || []).filter(property => runtime.filtered_cache.includes(property));
        }
      }
      if (sourceObservedAt && observationContract.ok && existing) {
        // Zigbee2MQTT's Home Assistant extension inserts null mock properties
        // for absent climate fields after composing the report. For properties
        // deliberately excluded from cache, null is not a physical reading or
        // an availability signal. Keep the previous observation with its ORIGINAL
        // finite validity; never clear or renew it from a publisher placeholder.
        // Explicit availability messages still independently revoke freshness.
        for (const property of observationContract.properties || []) {
          if (reportedState[property] === null) delete reportedState[property];
        }
        for (const property of observationContract.properties || []) {
          if (!Object.prototype.hasOwnProperty.call(reportedState, property)) continue;
          const matchingEntities = Object.values(existing.entities || {}).filter((entity) => String(entity.stateKey || entity.binding?.property || "") === property
            && entity.capability?.readable === true && entity.capability?.observable === true
            && (property !== "running_state" || entity.capability?.semanticRole === "active_heat_demand")
            && (property !== "local_temperature" || entity.capability?.semanticRole === "ambient_temperature"));
          const endpoint = String(value.endpoint ?? value.endpoint_id ?? "").trim();
          const matches = matchingEntities.length === 1 ? matchingEntities
            : endpoint ? matchingEntities.filter((entity) => String(entity.endpointId || entity.binding?.endpoint || entity.expose?.endpoint || "") === endpoint) : [];
          if (matches.length !== 1) continue;
          // A replay (cache republish or redelivery after the bridge is online) carries the same
          // or an older last_seen. Only a strictly newer last_seen is a new observation of this
          // value; an identical value re-reported with a newer last_seen does refresh it.
          const previousObservedMs = Date.parse(String(matches[0].sourceObservedAt || ""));
          if (Number.isFinite(previousObservedMs) && previousObservedMs >= Date.parse(sourceObservedAt)) continue;
          sourceObservedAtByStateKey[property] = sourceObservedAt;
          sourceReceivedAtByStateKey[property] = receivedAt;
          observedEndpointByStateKey[property] = String(matches[0].endpointId || matches[0].binding?.endpoint || matches[0].expose?.endpoint || "");
        }
      }
      const previousLastSeenAt = strictUtcTimestamp(existing?.lastSeenAt, receivedMs);
      const lastSeenAt = sourceObservedAt && observationContract.ok
        && (!previousLastSeenAt || Date.parse(sourceObservedAt) > Date.parse(previousLastSeenAt))
        ? sourceObservedAt : null;
      device = await this.store.updateDeviceState(id, reportedState, {
        protocol: "zigbee", available: true, name: existing?.name || id,
        reportedStateKeys: Object.keys(reportedState),
        nowMs: receivedMs,
        deferPersist: true,
        ...(lastSeenAt ? { lastSeenAt } : {}),
        sourceObservedAtByStateKey, sourceReceivedAtByStateKey,
        sourceLifetimeSecondsByStateKey: Object.fromEntries(Object.keys(sourceObservedAtByStateKey).map(property => [property,
          this.observationPolicy?.lifetimeFor?.(id, property, observedEndpointByStateKey[property]) ?? null])),
        reportedEndpointId: value.endpoint ?? value.endpoint_id,
      });
      for (const [property, observedAt] of Object.entries(sourceObservedAtByStateKey)) {
        await this.notifyObservationPolicy("onValueObserved", device.id, property, observedEndpointByStateKey[property], observedAt, reportedState[property]);
      }
    } else {
      return;
    }
    // The bounded local diagnostic event is deferred so ordinary adapter
    // reports can coalesce. updateDeviceState still persists immediately when
    // the report changes durable sync/analytics state; this option never
    // delays command, usage, or outbox durability.
    await this.store.addEvent({ type: "device_state", deviceId: device.id, protocol: device.protocol }, { deferPersist: true });
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

  /// Hands an event to the observation policy; its failures never interrupt device handling.
  async notifyObservationPolicy(method, ...args) {
    if (!this.observationPolicy || typeof this.observationPolicy[method] !== "function") return;
    try { await this.observationPolicy[method](...args); }
    catch (error) { this.logger?.warn?.(`[observation] ${method} deferred (${String(error?.code || error?.message || "error").slice(0, 80)})`); }
  }

  /// A Zigbee2MQTT bridge request (reporting read/configure only; see the observation policy).
  async bridgeRequest(requestPath, payload) {
    if (!["device/reporting/read", "device/reporting/configure"].includes(String(requestPath))) {
      throw Object.assign(new Error("Only reporting read/configure bridge requests are permitted"), { code: "bridge_request_not_permitted" });
    }
    if (!this.client || !this.connected) throw Object.assign(new Error("Zigbee2MQTT is not connected"), { code: "zigbee_unavailable" });
    const topic = `${this.baseTopic}/bridge/request/${requestPath}`;
    await new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(payload || {}), { qos: 0, retain: false }, (error) => error ? reject(error) : resolve());
    });
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

  async startPairing(seconds = 120, options = {}) {
    const bounded = Math.max(30, Math.min(Number(seconds) || 120, 254));
    await this.permitJoin(bounded);
    const knownIds = this.store?.listDevices ? this.store.listDevices().map((device) => ({ id: device.id, identity: String(device.protocolIdentity?.ieeeAddress || device.metadata?.ieee_address || device.metadata?.ieee || "").toLowerCase() })) : [];
    this.pairingSession.start(this.permitJoinUntil, bounded, knownIds, options);
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

  async removeCommissioningCandidate(deviceId) {
    const result = await this.remove(deviceId);
    if (result?.ok === false || result?.status === "error") throw new Error("Zigbee adapter did not confirm candidate removal");
    if (typeof this.store.removeDevice === "function") await this.store.removeDevice(deviceId);
    else if (typeof this.store.removeDeviceFromState === "function") await this.store.removeDeviceFromState(deviceId);
    this.pairingSession.forget(deviceId);
    return { acknowledged: true };
  }

  async remove(deviceId, force = false, options = {}) {
    if (!this.client || !this.connected) throw new Error("MQTT is not connected");
    const device = this.store.getDevice(deviceId);
    if (!device) throw new Error("Zigbee device is not registered");
    const topic = `${this.baseTopic}/bridge/request/device/remove`;
    const removalId = device.metadata?.friendly_name || device.metadata?.friendlyName || device.metadata?.ieee_address || device.protocolIdentity?.ieeeAddress || deviceId;
    const transaction = crypto.randomUUID();
    const payload = JSON.stringify({
      id: String(removalId),
      clear_cache: true,
      transaction,
      ...(force ? { force: true } : {}),
      ...(options.block ? { block: true } : {}),
    });
    const acknowledgement = await new Promise((resolve, reject) => {
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
    if (String(acknowledgement?.status || "").toLowerCase() !== "ok") {
      throw new Error("Zigbee2MQTT did not confirm device removal");
    }
    const confirmed = acknowledgement.data || {};
    if (String(confirmed.id || "") !== String(removalId)) {
      throw new Error("Zigbee2MQTT acknowledged a different device removal");
    }
    if (force && confirmed.force !== true) {
      throw new Error("Zigbee2MQTT did not confirm force removal; the device is still registered");
    }
    if (options.block && confirmed.block !== true) {
      throw new Error("Zigbee2MQTT did not confirm the rejoin block; the device is still registered");
    }
    await this.store.addEvent({ type: "zigbee_device_remove_requested", deviceId: String(deviceId) });
    return acknowledgement;
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
