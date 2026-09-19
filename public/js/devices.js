(function () {
  "use strict";
  function surfaces(device) {
    return device?.presentation?.status === "ready" && device.presentation.surfaces && typeof device.presentation.surfaces === "object"
      ? Object.values(device.presentation.surfaces)
      : [];
  }
  function countEntities(device) {
    const visible = surfaces(device);
    return visible.length || Object.keys(device?.entities || {}).length;
  }
  function diagnosticCount(device) {
    const visible = surfaces(device);
    if (!visible.length) return Object.keys(device?.entities || {}).length;
    const sourceIds = new Set(visible.flatMap((surface) => surface.sourceEntityIds || []));
    return Object.values(device.entities || {}).filter((entity) => !sourceIds.has(entity.id)).length;
  }
  function isInfrastructureDevice(device) {
    if (!device || typeof device !== "object") return false;
    if (device.infrastructure === true) return true;
    const protocol = String(device.protocol || "").toLowerCase();
    if (protocol === "hive") return [device.type, device.role, device.metadata?.type, device.metadata?.role].some((value) => /^(hub|bridge|receiver|gateway|account|service)$/i.test(String(value || "").trim()));
    if (!["zigbee", "matter"].includes(protocol)) return false;
    const roles = [device.type, device.role, device.metadata?.type, device.metadata?.role, device.metadata?.device_type]
      .map((value) => String(value || "").trim().toLowerCase());
    if (roles.some((value) => ["coordinator", "controller", "border_router", "border-router"].includes(value))) return true;
    return protocol === "zigbee" && String(device.name || "").trim().toLowerCase() === "coordinator" && countEntities(device) === 0;
  }
  function isControllable(entity) {
    const capability = entity?.capability || {};
    return Boolean(capability.writable && Array.isArray(capability.bindings) && capability.bindings.length);
  }
  function hasLabels(entity) {
    const labels = entity?.labelIds || entity?.labels || [];
    return Array.isArray(labels) && labels.some((label) => String(label || "").trim());
  }
  function sortEntities(device) {
    const visible = surfaces(device);
    const source = visible.length ? visible : Object.values(device?.entities || {});
    return source
      .map((entity, index) => ({ entity, index }))
      .sort((left, right) => {
        const leftControllable = isControllable(left.entity);
        const rightControllable = isControllable(right.entity);
        if (leftControllable !== rightControllable) return leftControllable ? -1 : 1;
        const leftLabeled = hasLabels(left.entity);
        const rightLabeled = hasLabels(right.entity);
        if (leftLabeled !== rightLabeled) return leftLabeled ? -1 : 1;
        const nameOrder = String(left.entity.name || left.entity.id || "").localeCompare(String(right.entity.name || right.entity.id || ""), undefined, { sensitivity: "base" });
        return nameOrder || left.index - right.index;
      })
      .map(({ entity }) => entity);
  }
  function effectiveAreaIds(device) {
    return device?.areaId ? [String(device.areaId)] : [];
  }
  function areaSummary(device, areas = []) {
    const names = effectiveAreaIds(device)
      .map((id) => areas.find((area) => String(area.id) === id)?.name)
      .filter(Boolean);
    return names.length > 1 ? "Multiple areas" : names[0] || "Unassigned";
  }
  window.DinodiaDevices = { countEntities, diagnosticCount, surfaces, isInfrastructureDevice, isControllable, hasLabels, sortEntities, effectiveAreaIds, areaSummary };
}());
