(function () {
  "use strict";
  function optionLabel(adapter) {
    return `${adapter.name} · ${adapter.path}${adapter.recommended ? " · recommended" : ""}`;
  }
  function adapterKey(adapter) {
    return String(adapter?.path || adapter?.target || adapter?.name || "radio");
  }
  function connectionStatus(adapter, selectedPath, integration = {}) {
    if (adapter.supported === false) return { key: "unsupported", label: "Unsupported", detail: adapter.reason || "This coordinator is not supported by Dinodia OS.", online: false };
    if (adapterKey(adapter) !== String(selectedPath || "")) return { key: "not-selected", label: "Not selected", detail: "Select this coordinator to use its network.", online: false };
    if (!adapter.connected) return { key: "offline", label: "Offline", detail: "The USB coordinator is not connected.", online: false };
    if (!integration.connected) return { key: "offline", label: "Offline", detail: "The coordinator is connected, but Zigbee2MQTT is not connected.", online: false };
    if (!integration.service?.running) return { key: "starting", label: "Starting", detail: "Zigbee2MQTT is not running yet.", online: false };
    return { key: "online", label: "Online", detail: "Coordinator and Zigbee network are working.", online: true };
  }
  function threadConnectionStatus(adapter, selectedPath, integration = {}) {
    if (adapter.supported === false) return { key: "unsupported", label: "Unsupported", detail: adapter.reason || "This Thread radio is not supported by Dinodia OS.", online: false };
    if (adapterKey(adapter) !== String(selectedPath || "")) return { key: "not-selected", label: "Not selected", detail: "Select this dongle as the Thread Border Router to use its network.", online: false };
    if (!adapter.connected) return { key: "offline", label: "Offline", detail: "The USB Thread RCP is not connected.", online: false };
    if (!integration.service?.running) return { key: "starting", label: "Starting", detail: "OpenThread Border Router is not running yet.", online: false };
    const activeStates = ["leader", "router", "child", "detached"];
    if (!integration.reachable || (integration.state && !activeStates.includes(String(integration.state).toLowerCase()))) return { key: "offline", label: "Offline", detail: "The Thread Border Router is connected, but its network is not ready.", online: false };
    return { key: "online", label: "Online", detail: "Thread Border Router and Thread network are working.", online: true };
  }
  window.DinodiaRadios = { optionLabel, adapterKey, connectionStatus, threadConnectionStatus };
}());
