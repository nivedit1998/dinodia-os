(function () {
  "use strict";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const rangeValue = (value, parameter) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    const step = Number(parameter?.step);
    const decimals = Number.isFinite(step) && String(step).includes(".") ? String(step).split(".")[1].length : 0;
    return numeric.toFixed(Math.min(decimals, 4)).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  };
  function rangeMarkup({ label, parameter, value, serviceId, entityId, parameterKey, buttonLabel = "Set" } = {}) {
    const min = parameter?.min ?? 0;
    const max = parameter?.max ?? 100;
    const step = parameter?.step ?? 1;
    const current = value ?? min;
    return `<label class="surface-parameter"><span>${escapeHtml(label)}</span><span class="range-input-wrap"><input class="entity-control range-control" type="range" min="${escapeHtml(min)}" max="${escapeHtml(max)}" step="${escapeHtml(step)}" value="${escapeHtml(current)}" data-service="${escapeHtml(serviceId)}" data-entity="${escapeHtml(entityId)}" data-parameter="${escapeHtml(parameterKey || parameter?.key || "value")}" aria-label="${escapeHtml(label)}"><output class="range-value" aria-live="polite">${escapeHtml(rangeValue(current, parameter))}</output></span><button type="button" class="entity-control secondary" data-submit-control="true" data-service="${escapeHtml(serviceId)}" data-entity="${escapeHtml(entityId)}">${escapeHtml(buttonLabel)}</button></label>`;
  }
  function control(entity) {
    const capability = entity && entity.capability;
    if (!capability || !capability.writable || !Array.isArray(capability.bindings) || !capability.bindings.length) return `<span class="read-only-state">${escapeHtml(entity?.state ?? "—")}</span>`;
    const binding = capability.bindings[0];
    const parameter = binding.parameter;
    if (capability.kind === "binary") return `<button type="button" class="entity-control secondary" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">${String(entity.state).toLowerCase() === "on" ? "Turn off" : "Turn on"}</button>`;
    if (capability.kind === "button") return `<button type="button" class="entity-control secondary" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">Run</button>`;
    const parameterAttribute = parameter?.key ? ` data-parameter="${escapeHtml(parameter.key)}"` : "";
    if (capability.kind === "enum" && parameter) return `<select class="entity-control" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}"${parameterAttribute}>${(parameter.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select><button type="button" class="entity-control secondary" data-submit-control="true" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">Apply</button>`;
    if (capability.kind === "number" && parameter) return rangeMarkup({ label: entity.name || "Value", parameter, value: entity.state, serviceId: binding.serviceId, entityId: entity.id, parameterKey: parameter.key, buttonLabel: "Apply" });
    if (capability.kind === "text" && parameter) return `<input class="entity-control" type="text" maxlength="128" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}"${parameterAttribute}><button type="button" class="entity-control secondary" data-submit-control="true" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">Apply</button>`;
    return `<span class="read-only-state">${escapeHtml(entity?.state ?? "—")}</span>`;
  }
  function controls(entity) {
    const capability = entity?.capability || {};
    if (capability.kind !== "composite") return control(entity);
    const bindings = Array.isArray(capability.bindings) ? capability.bindings : [];
    const output = [];
    const binary = bindings.find((binding) => /\.(turn_on|turn_off|toggle)$/.test(binding.serviceId));
    if (binary) output.push(`<button type="button" class="entity-control secondary" data-service="${escapeHtml(binary.serviceId)}" data-entity="${escapeHtml(entity.id)}">${String(entity.state).toLowerCase() === "on" ? "Turn off" : "Turn on"}</button>`);
    for (const action of ["open_cover", "close_cover", "stop_cover"]) {
      const binding = bindings.find((candidate) => candidate.serviceId === `cover.${action}`);
      if (binding) output.push(`<button type="button" class="entity-control secondary" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">${escapeHtml(action.replaceAll("_", " "))}</button>`);
    }
    const renderedBindings = new Set();
    for (const binding of bindings) {
      const parameter = binding.parameter;
      if (binding.serviceId === "light.turn_on" && parameter?.key === "brightness") { output.push(rangeMarkup({ label: "Brightness", parameter, value: entity.attributes?.brightness, serviceId: binding.serviceId, entityId: entity.id, parameterKey: "brightness" })); renderedBindings.add(binding); }
      if (binding.serviceId === "light.turn_on" && parameter?.key === "color_temp") { output.push(rangeMarkup({ label: "Colour temperature", parameter, value: entity.attributes?.color_temp, serviceId: binding.serviceId, entityId: entity.id, parameterKey: "color_temp" })); renderedBindings.add(binding); }
      if (binding.serviceId.endsWith(".set_temperature") && parameter) { output.push(rangeMarkup({ label: "Temperature", parameter, value: entity.attributes?.temperature, serviceId: binding.serviceId, entityId: entity.id, parameterKey: parameter.key })); renderedBindings.add(binding); }
      if (binding.serviceId.endsWith(".set_hvac_mode") && parameter) { output.push(`<label class="surface-parameter"><span>Mode</span><select class="entity-control" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}" data-parameter="${escapeHtml(parameter.key)}">${(parameter.options || entity.attributes?.hvac_modes || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select><button type="button" class="entity-control secondary" data-submit-control="true" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">Set</button></label>`); renderedBindings.add(binding); }
      if (binding.serviceId === "cover.set_cover_position" && parameter) { output.push(rangeMarkup({ label: "Position", parameter, value: entity.attributes?.current_position, serviceId: binding.serviceId, entityId: entity.id, parameterKey: parameter.key })); renderedBindings.add(binding); }
      if (binding.serviceId === "fan.set_percentage" && parameter) { output.push(rangeMarkup({ label: "Speed", parameter, value: entity.attributes?.percentage, serviceId: binding.serviceId, entityId: entity.id, parameterKey: parameter.key })); renderedBindings.add(binding); }
      if (binding.serviceId === "fan.set_preset_mode" && parameter) { output.push(`<label class="surface-parameter"><span>Mode</span><select class="entity-control" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}" data-parameter="${escapeHtml(parameter.key)}">${(parameter.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select><button type="button" class="entity-control secondary" data-submit-control="true" data-service="${escapeHtml(binding.serviceId)}" data-entity="${escapeHtml(entity.id)}">Set</button></label>`); renderedBindings.add(binding); }
      if (!renderedBindings.has(binding) && parameter?.type === "number") {
        const label = String(parameter.key || "Value").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
        output.push(rangeMarkup({ label, parameter, value: entity.attributes?.[parameter.key] ?? entity.state, serviceId: binding.serviceId, entityId: entity.id, parameterKey: parameter.key }));
        renderedBindings.add(binding);
      }
    }
    return output.length ? output.join("") : `<span class="read-only-state">${escapeHtml(entity?.state ?? "—")}</span>`;
  }
  window.DinodiaCapabilityControls = { control, controls };
}());
