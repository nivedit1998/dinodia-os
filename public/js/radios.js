(function () {
  "use strict";
  function optionLabel(adapter) {
    return `${adapter.name} · ${adapter.path}${adapter.recommended ? " · recommended" : ""}`;
  }
  function adapterKey(adapter) {
    return String(adapter?.path || adapter?.target || adapter?.name || "radio");
  }
  function identityValues(adapter) {
    if (adapter && typeof adapter === "object") {
      return [adapter.path, adapter.target, adapter.usbId].map((value) => String(value || "").trim()).filter(Boolean);
    }
    const value = String(adapter || "").trim();
    return value ? [value] : [];
  }
  function sameAdapter(left, right) {
    const rightValues = new Set(identityValues(right));
    return identityValues(left).some((value) => rightValues.has(value));
  }
  function connectionStatus(adapter, selectedPath, integration = {}) {
    if (adapter.supported === false) return { key: "unsupported", label: "Unsupported", detail: adapter.reason || "This coordinator is not supported by Dinodia OS.", online: false };
    if (!sameAdapter(adapter, selectedPath)) return { key: "not-selected", label: "Not selected", detail: "Select this coordinator to use its network.", online: false };
    if (!adapter.connected) return { key: "offline", label: "Offline", detail: "The USB coordinator is not connected.", online: false };
    if (!integration.connected) return { key: "offline", label: "Offline", detail: "The coordinator is connected, but Zigbee2MQTT is not connected.", online: false };
    if (!integration.service?.running) return { key: "starting", label: "Starting", detail: "Zigbee2MQTT is not running yet.", online: false };
    return { key: "online", label: "Online", detail: "Coordinator and Zigbee network are working.", online: true };
  }
  function threadConnectionStatus(adapter, selectedPath, integration = {}) {
    if (adapter.supported === false) return { key: "unsupported", label: "Unsupported", detail: adapter.reason || "This Thread radio is not supported by Dinodia OS.", online: false };
    if (!sameAdapter(adapter, selectedPath)) return { key: "not-selected", label: "Not selected", detail: "Select this dongle as the Thread Border Router to use its network.", online: false };
    if (!adapter.connected) return { key: "offline", label: "Offline", detail: "The USB Thread RCP is not connected.", online: false };
    if (!integration.service?.running) return { key: "starting", label: "Starting", detail: "OpenThread Border Router is not running yet.", online: false };
    const activeStates = ["leader", "router", "child", "detached"];
    if (!integration.reachable || (integration.state && !activeStates.includes(String(integration.state).toLowerCase()))) return { key: "offline", label: "Offline", detail: "The Thread Border Router is connected, but its network is not ready.", online: false };
    return { key: "online", label: "Online", detail: "Thread Border Router and Thread network are working.", online: true };
  }
  function inventoryEntries(zigbee = {}, thread = {}) {
    const entries = [];
    const add = (adapter, kind, selected) => {
      if (!adapter?.path || entries.some((entry) => sameAdapter(entry.adapter, adapter))) return;
      entries.push({ adapter, kind, selected: sameAdapter(adapter, selected) });
    };
    // Emit the explicitly selected role records first. If a stale inventory
    // includes the opposite role's dongle, suppress it there rather than
    // displaying one physical radio twice under conflicting protocols.
    const threadSelected = thread.selected || null;
    const zigbeeSelected = zigbee.selected || null;
    const findInventoryRecord = (inventory, selected) => (inventory.adapters || []).find((adapter) => sameAdapter(adapter, selected)) || selected;
    if (threadSelected?.path) add(findInventoryRecord(thread, threadSelected), "thread", threadSelected);
    if (zigbeeSelected?.path) add(findInventoryRecord(zigbee, zigbeeSelected), "zigbee", zigbeeSelected);
    (thread.adapters || []).forEach((adapter) => {
      if (zigbeeSelected && sameAdapter(adapter, zigbeeSelected)) return;
      add(adapter, "thread", threadSelected);
    });
    (zigbee.adapters || []).forEach((adapter) => {
      if (threadSelected && sameAdapter(adapter, threadSelected)) return;
      add(adapter, "zigbee", zigbeeSelected);
    });
    if (threadSelected?.path) add({ ...threadSelected, connected: false, supported: true }, "thread", threadSelected);
    if (zigbeeSelected?.path) add({ ...zigbeeSelected, connected: false, supported: true }, "zigbee", zigbeeSelected);
    return entries;
  }
  window.DinodiaRadios = { optionLabel, adapterKey, connectionStatus, threadConnectionStatus, inventoryEntries };
}());
