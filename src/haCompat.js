const http = require("node:http");
const { URL } = require("node:url");
const { WebSocketServer } = require("ws");

function json(res, status, body, headers = {}) {
  if (status === 204) {
    res.writeHead(status, headers);
    return res.end();
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(String(body || ""));
}

function html(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(String(body || ""));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : String(req.headers["x-dinodia-token"] || "").trim();
}

function errorBody(error) {
  return { error: { code: error.code || (Number(error.statusCode) === 404 ? "not_found" : "invalid_request"), message: error.message || "Request failed" } };
}

function parseIds(value) {
  if (Array.isArray(value)) return value.flatMap(parseIds);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueStates(states) {
  const byEntityId = new Map();
  for (const state of states || []) {
    const entityId = String(state?.entity_id || "").trim();
    if (!entityId) continue;
    const existing = byEntityId.get(entityId);
    if (!existing || Object.keys(state?.attributes || {}).length > Object.keys(existing.attributes || {}).length) {
      byEntityId.set(entityId, state);
    }
  }
  return [...byEntityId.values()];
}

function normalizeAutomation(input = {}) {
  const triggers = input.triggers || input.trigger || [];
  const trigger = Array.isArray(triggers) ? triggers[0] : triggers;
  const conditions = input.conditions || input.condition || [];
  const actions = Array.isArray(input.actions) ? input.actions : [];
  const convertedActions = actions.map((action) => {
    if (action && action.service) {
      const [domain, service] = String(action.service).split(".");
      return { service: action.service, domain, serviceName: service, target: action.target || {}, data: action.data || action.service_data || {} };
    }
    return action;
  });
  const first = trigger && typeof trigger === "object" ? { ...trigger } : {};
  if (first.entity_id && !first.deviceId) first.entityId = Array.isArray(first.entity_id) ? first.entity_id[0] : first.entity_id;
  return {
    name: String(input.alias || input.name || "Dinodia automation"),
    enabled: input.enabled !== false,
    trigger: first,
    conditions: Array.isArray(conditions) ? conditions : [conditions],
    actions: convertedActions,
    mode: input.mode || "single",
    cooldownMs: Number(input.cooldownMs || 2000),
  };
}

function automationEntity(automation) {
  return {
    entity_id: `automation.${String(automation.id).replace(/[^a-zA-Z0-9_]/g, "_")}`,
    state: automation.enabled === false ? "off" : "on",
    attributes: { friendly_name: automation.name, id: automation.id },
    last_changed: automation.updatedAt,
    last_updated: automation.updatedAt,
  };
}

function createCompatInterface({ port = 8123, host = "0.0.0.0", model, store, auth, wsAuth = auth, authorizeWsMessage, filterWsStates, filterWsEvent, eventBus, mqtt, syncStatus, logger = console, hubAgent = false, flowHandlers = {}, onRemoteEvent, onRegistryChange, onAuthenticated } = {}) {
  const flows = new Map();
  const subscriptions = new Map();

  function requireAuth(req) {
    if (typeof auth === "function" && auth(bearerToken(req))) return true;
    return false;
  }

  function listStates(principal = null) {
    const states = uniqueStates([...model.states(), ...store.listAutomations().map(automationEntity)]);
    return typeof filterWsStates === "function" ? filterWsStates(states, principal) : states;
  }

  function registryList(type) {
    if (type === "area") return model.areas();
    if (type === "label") return model.labels();
    if (type === "device") return model.deviceRegistry();
    if (type === "entity") return model.entityRegistry();
    if (type === "config_entry") return Object.values(store.getConfigEntries());
    return [];
  }

  async function serviceCall(domain, service, body) {
    if (domain === "dinodia_remote_manager") return handleRemoteService(service, body);
    if (domain === "zha" && service === "permit") {
      await mqtt.permitJoin(body.seconds || body.duration || 254);
      return { changed_states: [], service_response: { ok: true } };
    }
    const result = await model.callService(domain, service, body);
    return result;
  }

  function bindingSummary(binding) {
    if (!binding) return null;
    return {
      bindingId: String(binding.id || binding.binding_id || ""),
      remoteDeviceId: String(binding.sourceDeviceId || binding.remote_device_id || binding.device_id || ""),
      targetDeviceId: binding.targetDeviceId || binding.target_device_id || null,
      targetEntityId: binding.targetEntityId || binding.target_entity_id || null,
      targetKind: binding.targetKind || (binding.targetEntityId || binding.target_entity_id ? "entity" : "device"),
      bindingName: binding.bindingName || binding.name || null,
      enabled: binding.enabled !== false,
      createdAt: binding.createdAt || null,
      updatedAt: binding.updatedAt || null,
    };
  }

  function registryDeviceFor(device) {
    const identifier = String(device.metadata?.ieee_address || device.metadata?.node_id || device.id);
    return model.deviceRegistry().find((item) => item.identifiers?.some((pair) => String(pair?.[1]) === identifier))
      || model.deviceRegistry().find((item) => item.id === device.haDeviceId)
      || null;
  }

  function publicDeviceId(device) {
    return registryDeviceFor(device)?.id || String(device.haDeviceId || device.id);
  }

  function publicDeviceLabels(device) {
    return (device.labelIds || device.labels || []).map((id) => store.getLabel(String(id))?.name || String(id));
  }

  function targetSummary(item) {
    if (!item) return null;
    const registryDevice = registryDeviceFor(item.device);
    return {
      targetId: item.haId,
      deviceId: registryDevice?.id || item.device.haDeviceId || item.device.id,
      entityId: item.haId,
      name: item.entity.name,
      domain: item.domain,
      areaName: store.getArea(item.entity.areaId || item.device.areaId)?.name || null,
      labels: (item.entity.labelIds || item.entity.labels || []).map((id) => store.getLabel(String(id))?.name || String(id)),
    };
  }

  async function handleRemoteService(service, body = {}) {
    const bindings = store.listRemoteBindings();
    if (service === "list_bindings") return { changed_states: [], service_response: { bindings: bindings.map((binding) => ({ binding: bindingSummary(binding) })) } };
    if (service === "list_trigger_devices") return { changed_states: [], service_response: { devices: store.listDevices().filter((device) => device.protocol === "zigbee").map((device) => ({ device_id: publicDeviceId(device), name: device.name, area_id: device.areaId, labels: publicDeviceLabels(device) })) } };
    if (service === "list_trigger_device_dashboard") {
      const requested = String(body.remote_device_id || body.remoteDeviceId || body.device_id || "");
      const triggerDevices = store.listDevices().filter((device) => device.protocol === "zigbee").filter((device) => {
        if (!requested) return true;
        const publicId = publicDeviceId(device);
        return [device.id, device.haDeviceId, publicId].map(String).includes(requested);
      }).map((device) => {
        const registryDevice = registryDeviceFor(device);
        const deviceId = registryDevice?.id || publicDeviceId(device);
        const entityIds = model.entityRegistry().filter((entity) => entity.device_id === deviceId).map((entity) => entity.entity_id);
        const binding = bindings.find((candidate) => [candidate.sourceDeviceId, candidate.remote_device_id, candidate.device_id].some((value) => [device.id, deviceId].includes(String(value || ""))));
        const targetEntityId = binding?.targetEntityId || binding?.target_entity_id || null;
        const targetEntity = targetEntityId ? model.findEntity(targetEntityId) : null;
        return {
          device_id: deviceId,
          accepted: true,
          name: device.name,
          area_id: device.areaId || null,
          area_name: store.getArea(device.areaId)?.name || null,
          labels: publicDeviceLabels(device),
          source_entity_id: entityIds[0] || null,
          trigger_count: bindings.filter((candidate) => [candidate.sourceDeviceId, candidate.remote_device_id, candidate.device_id].some((value) => [device.id, deviceId].includes(String(value || "")))).length,
          entity_ids: entityIds,
          binding: bindingSummary(binding),
          capability: { targetKind: binding ? "entity" : "unbound", domain: targetEntity?.domain || "remote", supported: Boolean(binding), actions: ["toggle"], description: "Dinodia remote trigger", reason: null, targetDeviceId: binding?.targetDeviceId || binding?.target_device_id || null, targetEntityId, source: "dinodia_os" },
          target: targetSummary(targetEntity),
          resolution_state: binding ? "bound" : "unbound",
        };
      });
      return { changed_states: [], service_response: { trigger_devices: triggerDevices } };
    }
    if (["register_binding", "update_binding", "set_trigger_target"].includes(service)) {
      const sourceDeviceId = String(body.sourceDeviceId || body.remote_device_id || body.device_id || "");
      const targetEntityId = body.targetEntityId || body.target_entity_id || null;
      const targetDeviceId = body.targetDeviceId || body.target_device_id || null;
      const id = String(body.id || body.binding_id || `${sourceDeviceId || "remote"}:${Date.now()}`);
      const binding = await store.saveRemoteBinding({ ...body, id, sourceDeviceId, targetEntityId, targetDeviceId, ownerUserId: body.ownerUserId || body.owner_user_id || null, enabled: body.enabled !== false, updatedAt: new Date().toISOString() });
      const summary = bindingSummary(binding);
      return { changed_states: [], service_response: { ok: true, binding: summary, capability: { targetKind: summary.targetKind, domain: String(targetEntityId || "").split(".")[0] || "homeassistant", supported: Boolean(targetEntityId || targetDeviceId), actions: ["toggle"], description: "Dinodia remote target", reason: null, targetDeviceId: summary.targetDeviceId, targetEntityId: summary.targetEntityId, source: "dinodia_os" } } };
    }
    if (["unbind"].includes(service)) {
      const id = String(body.id || body.binding_id || "");
      return { changed_states: [], service_response: { ok: await store.deleteRemoteBinding(id) } };
    }
    if (["remove_tenant_bindings", "remove_trigger_bindings_for_devices"].includes(service)) {
      const requestedDeviceIds = parseIds(body.remote_device_ids || body.remoteDeviceIds || body.device_ids || body.device_id);
      const ownerUserId = body.owner_user_id === undefined ? body.ownerUserId : body.owner_user_id;
      let removed = 0;
      for (const binding of bindings) {
        const ownerMatches = ownerUserId === undefined || ownerUserId === null || String(binding.ownerUserId || binding.owner_user_id || "") === String(ownerUserId);
        const deviceMatches = requestedDeviceIds.length === 0 || requestedDeviceIds.some((id) => [binding.sourceDeviceId, binding.remote_device_id, binding.device_id, binding.targetDeviceId, binding.target_device_id].map(String).includes(String(id)));
        const shouldRemove = service === "remove_tenant_bindings" ? ownerMatches : ownerMatches && deviceMatches;
        if (shouldRemove && await store.deleteRemoteBinding(binding.id)) removed += 1;
      }
      return { changed_states: [], service_response: { ok: true, removed: { bindings: removed, configEntries: 0, listeners: 0 }, errors: [] } };
    }
    if (service === "resolve_binding") return { changed_states: [], service_response: { binding: bindingSummary(bindings.find((binding) => binding.id === body.id) || null) } };
    if (service === "simulate_remote_event") {
      const event = body.data && typeof body.data === "object" ? body.data : body;
      eventBus.emit("dinodia_remote_manager_event", { event_type: "remote_event", data: event });
      if (typeof onRemoteEvent === "function") await onRemoteEvent(event);
      return { changed_states: [], service_response: { ok: true } };
    }
    throw Object.assign(new Error(`Unknown remote manager service: ${service}`), { statusCode: 404, code: "unknown_command" });
  }

  async function handleRest(req, res, url) {
    const path = url.pathname;
    if (path === "/" && req.method === "GET") {
      if (!hubAgent) return json(res, 404, { message: "Not found" });
      return html(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dinodia Hub Agent</title></head><body><main><h1>Dinodia Hub Agent is online</h1><p>This address is reserved for the local Hub Agent compatibility interface.</p></main></body></html>`);
    }
    if (path === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, mode: hubAgent ? "hub-agent" : "ha", port });
    if (!requireAuth(req)) return json(res, 401, { message: "Unauthorized" });
    if (path === "/api/" && req.method === "GET") return json(res, 200, { message: "API running." });
    if (path === "/api/states" && req.method === "GET") return json(res, 200, listStates());
    if (path.startsWith("/api/states/") && req.method === "GET") {
      const state = model.state(decodeURIComponent(path.slice("/api/states/".length)));
      return state ? json(res, 200, state) : json(res, 404, { message: "Entity not found" });
    }
    if (path.startsWith("/api/services/") && req.method === "POST") {
      const parts = path.split("/").filter(Boolean);
      const body = await readBody(req);
      const result = await serviceCall(decodeURIComponent(parts[2] || ""), decodeURIComponent(parts[3] || ""), body);
      return json(res, 200, url.searchParams.has("return_response") || body.return_response ? result : result.changed_states);
    }
    if (path === "/api/template" && req.method === "POST") {
      const body = await readBody(req);
      return text(res, 200, model.renderTemplate(body.template));
    }
    if (path === "/api/config/area_registry" && req.method === "GET") return json(res, 200, registryList("area"));
    if (path === "/api/config/area_registry/list" && req.method === "GET") return json(res, 200, registryList("area"));
    if (path === "/api/config/label_registry/list" && req.method === "GET") return json(res, 200, registryList("label"));
    if (path === "/api/config/device_registry/list" && req.method === "GET") return json(res, 200, registryList("device"));
    if (path === "/api/config/entity_registry/list" && req.method === "GET") return json(res, 200, registryList("entity"));
    if (path === "/api/config/config_entries/entry/list" && req.method === "GET") return json(res, 200, registryList("config_entry"));
    if (path === "/api/config/label_registry/create" && req.method === "POST") return json(res, 200, await model.createLabel(await readBody(req)));
    if (path === "/api/config/area_registry/create" && req.method === "POST") {
      const body = await readBody(req);
      const previous = store.findAreaByName?.(body.name) || null;
      const ensured = await store.ensureAreaByName(body.name, { icon: body.icon, id: body.area_id || undefined });
      const area = ensured.area;
      await onRegistryChange?.({ source: "ha_compat", registry: "area", action: ensured.created ? "created" : "updated", previous, current: area });
      eventBus?.emit("registry_updated", { registry: "area", id: area.id });
      return json(res, 200, model.areas().find((item) => item.area_id === area.id));
    }
    if (path === "/api/config/area_registry/update" && req.method === "POST") {
      const body = await readBody(req);
      const previous = store.getArea(String(body.area_id || ""));
      if (!previous) return json(res, 404, { message: "Area not found" });
      const area = await store.saveArea(body, String(body.area_id));
      await onRegistryChange?.({ source: "ha_compat", registry: "area", action: "updated", previous, current: area });
      eventBus?.emit("registry_updated", { registry: "area", id: area.id });
      return json(res, 200, model.areas().find((item) => item.area_id === area.id));
    }
    if (path === "/api/config/area_registry/delete" && req.method === "POST") {
      const areaId = String((await readBody(req)).area_id || "");
      const removal = await store.removeArea(areaId);
      if (removal.removed) {
        await onRegistryChange?.({ source: "ha_compat", registry: "area", action: "removed", previous: { id: areaId, name: removal.areaName }, current: null });
        eventBus?.emit("registry_removed", { registry: "area", id: areaId });
      }
      return json(res, 200, { ok: removal.removed });
    }
    if (path === "/api/config/device_registry/update" && req.method === "POST") {
      const updated = await model.updateDeviceRegistry(await readBody(req));
      return updated ? json(res, 200, updated) : json(res, 404, { message: "Device not found" });
    }
    if (path === "/api/config/entity_registry/update" && req.method === "POST") {
      const updated = await model.updateEntityRegistry(await readBody(req));
      return updated ? json(res, 200, updated) : json(res, 404, { message: "Entity not found" });
    }
    if (path === "/api/config/device_registry/remove" && req.method === "POST") return json(res, 200, { ok: await model.removeDevice(await readBody(req)) });
    if (path === "/api/config/entity_registry/remove" && req.method === "POST") return json(res, 200, { ok: await model.removeEntity(await readBody(req)) });
    if (path === "/api/config/automation" && req.method === "GET") return json(res, 200, store.listAutomations());
    if (path.startsWith("/api/config/automation/config/") && req.method === "POST") {
      const id = decodeURIComponent(path.slice("/api/config/automation/config/".length));
      const automation = await store.saveAutomation(normalizeAutomation(await readBody(req)), id);
      return json(res, 200, automation);
    }
    if (path.startsWith("/api/config/automation/config/") && req.method === "DELETE") {
      return json(res, (await store.deleteAutomation(decodeURIComponent(path.slice("/api/config/automation/config/".length)))) ? 200 : 404, { ok: true });
    }
    if ((path === "/api/config/config_entries/flow" || path === "/api/config_entries/flow") && req.method === "POST") {
      const body = await readBody(req);
      const flowId = `${body.handler || "dinodia"}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      flows.set(flowId, { id: flowId, handler: String(body.handler || "dinodia"), data: body.data || {} });
      return json(res, 200, { flow_id: flowId, handler: String(body.handler || "dinodia"), type: "form", step_id: "user", data_schema: [] });
    }
    const flowPrefix = path.startsWith("/api/config/config_entries/flow/")
      ? "/api/config/config_entries/flow/"
      : path.startsWith("/api/config_entries/flow/")
        ? "/api/config_entries/flow/"
        : "";
    if (flowPrefix && req.method === "POST") {
      const flowId = decodeURIComponent(path.slice(flowPrefix.length));
      const flow = flows.get(flowId);
      if (!flow) return json(res, 404, { error: "flow_not_found" });
      const body = await readBody(req);
      const handler = flowHandlers[flow.handler];
      if (handler && typeof handler.configure === "function") {
        const result = await handler.configure(body.user_input || body.data || body || {});
        flows.delete(flowId);
        return json(res, 200, result);
      }
      flows.delete(flowId);
      return json(res, 200, { type: "create_entry", title: flow.handler, result: { ...(body || {}) } });
    }
    if (flowPrefix && req.method === "DELETE") {
      flows.delete(decodeURIComponent(path.slice(flowPrefix.length)));
      return json(res, 200, { ok: true });
    }
    if (path === "/_dinodia/zha/permit" && req.method === "POST") {
      const body = await readBody(req);
      const duration = Math.max(0, Math.min(Number(body.duration ?? body.seconds ?? 254) || 254, 254));
      await mqtt.permitJoin(duration);
      return json(res, 200, { ok: true, duration });
    }
    if (path === "/_dinodia/zha/devices" && req.method === "GET") {
      const devices = store.listDevices().filter((device) => device.protocol === "zigbee").map((device) => ({ ieee: device.metadata?.ieee_address || device.id, name: device.name, manufacturer: device.metadata?.manufacturer || device.metadata?.manufacturer_name || "", model: device.metadata?.model || device.metadata?.model_id || "", available: device.available !== false }));
      return json(res, 200, { devices });
    }
    if (path === "/_dinodia/zha/health" && req.method === "GET") return json(res, 200, { ok: true, coordinator: store.getZigbee ? store.getZigbee() : {}, mqtt: mqtt.status(), permitJoinUntil: mqtt.status().permitJoinUntil || null, sync: syncStatus ? syncStatus() : null });
    if (path === "/_dinodia/sync-status" && req.method === "GET") return json(res, 200, syncStatus ? syncStatus() : { configured: false });
    if (path.startsWith("/api/camera_proxy/") && req.method === "GET") return text(res, 404, "Camera not available");
    return json(res, 404, { message: "Not found" });
  }

  function dispatchWs(socket, message) {
    const principal = socket.__dinodiaPrincipal || null;
    const id = message.id;
    const result = (value) => socket.send(JSON.stringify({ id, type: "result", success: true, result: value }));
    const failure = (error) => socket.send(JSON.stringify({ id, type: "result", success: false, error: { code: error.code || "invalid_request", message: error.message || "Command failed" } }));
    (async () => {
      if (typeof authorizeWsMessage === "function" && !await authorizeWsMessage(message, principal, { model, store })) throw Object.assign(new Error("This WebSocket operation is not permitted"), { code: "insufficient_scope" });
      switch (message.type) {
        case "get_states": return result(listStates(principal));
        case "call_service": {
          const serviceResult = await serviceCall(message.domain, message.service, { ...(message.service_data || {}), ...(message.target || {}) });
          return result(message.return_response ? serviceResult : serviceResult.changed_states);
        }
        case "subscribe_events": {
          if (!subscriptions.has(socket)) subscriptions.set(socket, new Set());
          subscriptions.get(socket).add(String(message.event_type || "*"));
          return result(true);
        }
        case "unsubscribe_events": {
          subscriptions.get(socket)?.delete(String(message.event_type || "*"));
          return result(true);
        }
        case "config/area_registry/list": return result(model.areas());
        case "config/area_registry/create": {
          const ensured = await store.ensureAreaByName(message.name, { icon: message.icon, id: message.area_id || undefined });
          const area = ensured.area;
          eventBus?.emit("registry_updated", { registry: "area", id: area.id });
          return result(model.areas().find((item) => item.area_id === area.id));
        }
        case "config/area_registry/update": {
          const areaId = String(message.area_id || "");
          if (!store.getArea(areaId)) throw Object.assign(new Error("Area not found"), { code: "not_found" });
          const area = await store.saveArea({ name: message.name || store.getArea(areaId).name, icon: message.icon }, areaId);
          eventBus?.emit("registry_updated", { registry: "area", id: area.id });
          return result(area);
        }
        case "config/area_registry/delete": {
          const areaId = String(message.area_id || "");
          const removal = await store.removeArea(areaId);
          if (removal.removed) eventBus?.emit("registry_removed", { registry: "area", id: areaId });
          return result({ ok: removal.removed });
        }
        case "config/label_registry/list": return result(model.labels());
        case "config/label_registry/create": return result(await model.createLabel(message.name ? message : (message.label || message)));
        case "config/device_registry/list": return result(model.deviceRegistry());
        case "config/device_registry/update": {
          const updated = await model.updateDeviceRegistry(message);
          if (!updated) throw Object.assign(new Error("Device not found"), { code: "not_found" });
          return result(updated);
        }
        case "config/device_registry/remove": return result({ ok: await model.removeDevice(message) });
        case "config/entity_registry/list": return result(model.entityRegistry());
        case "config/entity_registry/update": {
          const updated = await model.updateEntityRegistry(message);
          if (!updated) throw Object.assign(new Error("Entity not found"), { code: "not_found" });
          return result(updated);
        }
        case "config/entity_registry/remove": return result({ ok: await model.removeEntity(message) });
        case "config/config_entries/entry/list": return result(Object.values(store.getConfigEntries()));
        case "get_services_for_target": return result(model.servicesForTarget(message.target || message));
        case "zha/devices": return result(store.listDevices().filter((device) => device.protocol === "zigbee").map((device) => ({ ieee: device.metadata?.ieee_address || device.id, name: device.name, manufacturer: device.metadata?.manufacturer || device.metadata?.manufacturer_name || null, model: device.metadata?.model || device.metadata?.model_id || null, available: device.available !== false })));
        case "zha/devices/permit": await mqtt.permitJoin(message.duration || message.seconds || 254); return result(true);
        case "device_automation/trigger/list": {
          const requested = String(message.device_id || "");
          return result(model.entities().filter((item) => item.device.protocol === "zigbee" && (!requested || publicDeviceId(item.device) === requested)).map((item) => ({ platform: "device", device_id: publicDeviceId(item.device), entity_id: item.haId, domain: item.domain, type: "action", subtype: "button" })));
        }
        case "automation/config": {
          const requested = String(message.entity_id || message.id || "").replace(/^automation\./, "");
          const automation = store.listAutomations().find((item) => item.id === requested || item.id.replace(/[^a-zA-Z0-9_]/g, "_") === requested || item.name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() === requested.toLowerCase());
          return result(automation ? { config: { id: automation.id, alias: automation.name, mode: automation.mode || "single", triggers: automation.triggers || [automation.trigger], conditions: automation.conditions || [], actions: automation.actions || [] } } : { config: {} });
        }
        case "config_entries/flow/progress": return result([...flows.values()].map((flow) => ({ flow_id: flow.id, handler: flow.handler, context: {}, title: flow.handler, description: "Dinodia compatibility flow" })));
        case "config_entries/flow/init": {
          const flowId = `${message.handler || "dinodia"}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          flows.set(flowId, { id: flowId, handler: message.handler || "dinodia", context: message.context || {}, data: message.data || {} });
          return result({ flow_id: flowId, handler: message.handler || "dinodia", type: "form", step_id: "user", data_schema: [] });
        }
        case "config_entries/flow/configure": {
          const flow = flows.get(message.flow_id);
          if (!flow) throw Object.assign(new Error("Flow not found"), { code: "not_found" });
          const handler = flowHandlers[flow.handler];
          const value = handler?.configure ? await handler.configure(message.user_input || message.data || {}) : { type: "create_entry", title: flow.handler, result: message.user_input || {} };
          flows.delete(message.flow_id);
          return result(value);
        }
        case "config_entries/flow/abort": flows.delete(message.flow_id); return result(true);
        default: throw Object.assign(new Error(`Unknown command: ${message.type}`), { code: "unknown_command" });
      }
    })().catch(failure);
  }

  async function handleHttp(req, res) {
    res.setHeader("x-dinodia-interface", hubAgent ? "hub-agent" : "home-assistant");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (req.method === "OPTIONS") return json(res, 204, null, { "access-control-allow-headers": "authorization, content-type, x-dinodia-token, x-dinodia-step-up-proof, x-dinodia-offline-challenge, x-dinodia-offline-signature, x-dinodia-offline-grant", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" });
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try { return await handleRest(req, res, url); } catch (error) {
      logger.error(`[${hubAgent ? "hub-agent" : "ha"}] ${req.method} ${url.pathname}: ${error.message}`);
      return json(res, Number(error.statusCode) || 500, errorBody(error));
    }
  }
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/websocket") return socket.destroy();
    websocket.handleUpgrade(req, socket, head, (client) => websocket.emit("connection", client, req));
  }
  websocket.on("connection", (socket) => {
    let authenticated = false;
    const authTimer = setTimeout(() => { if (!authenticated) socket.close(1008, "Authentication timeout"); }, 10000);
    authTimer.unref?.();
    subscriptions.set(socket, new Set());
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.8-dinodia" }));
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1007, "Invalid JSON"); return; }
      if (!authenticated) {
        const principal = message.type === "auth" && typeof wsAuth === "function" ? wsAuth(String(message.access_token || "")) : null;
        if (!principal) {
          socket.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
          return socket.close(1008, "Unauthorized");
        }
        authenticated = true;
        socket.__dinodiaPrincipal = principal;
        clearTimeout(authTimer);
        try { onAuthenticated?.(socket, principal); } catch (error) { logger.error(`[auth] websocket session tracking failed: ${error.message}`); }
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.8-dinodia", user: { id: "dinodia" } }));
        return;
      }
      if (!message || !Number.isInteger(message.id) || !message.type) return socket.close(1007, "Command id and type are required");
      dispatchWs(socket, message);
    });
    socket.on("close", () => { clearTimeout(authTimer); subscriptions.delete(socket); });
  });
  const onEvent = (eventType, data) => {
    for (const [socket, types] of subscriptions) {
      if (socket.readyState !== 1 || (!types.has(eventType) && !types.has("*"))) continue;
      const filtered = typeof filterWsEvent === "function" ? filterWsEvent(eventType, data, socket.__dinodiaPrincipal || null) : data;
      if (filtered == null) continue;
      socket.send(JSON.stringify({ id: 0, type: "event", event: { event_type: eventType, data: filtered } }));
    }
  };
  if (eventBus) {
    eventBus.on("state_changed", (data) => onEvent("state_changed", data));
    eventBus.on("dinodia_remote_manager_event", (data) => onEvent("dinodia_remote_manager_event", data));
    eventBus.on("dinodia_dashboard_updated", (data) => onEvent("dinodia_dashboard_updated", data));
    eventBus.on("dinodia_activity_created", (data) => onEvent("dinodia_activity_created", data));
    eventBus.on("registry_updated", (data) => onEvent("dinodia_dashboard_updated", { kind: "registry", ...data }));
    eventBus.on("registry_removed", (data) => onEvent("dinodia_dashboard_updated", { kind: "registry_removed", ...data }));
  }
  async function stop() {
    for (const client of websocket.clients) client.close();
    websocket.close();
  }
  return { handleHttp, handleUpgrade, stop, websocket, port, host, hubAgent };
}

function createCompatServer(options = {}) {
  const compat = createCompatInterface(options);
  const server = http.createServer((req, res) => compat.handleHttp(req, res));
  server.on("upgrade", compat.handleUpgrade);
  async function start() {
    await new Promise((resolve) => server.listen(compat.port, compat.host, resolve));
    return server;
  }
  async function stop() {
    await compat.stop();
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, start, stop, websocket: compat.websocket };
}

module.exports = { createCompatInterface, createCompatServer, normalizeAutomation, automationEntity };
