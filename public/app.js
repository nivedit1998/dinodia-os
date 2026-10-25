const FIXED_LABELS = [{ id: "light", name: "Light" }, { id: "boiler", name: "Boiler" }, { id: "radiator", name: "Radiator" }, { id: "tenant_device", name: "Tenant Device" }];
const state = { token: "", areas: [], labels: [], devices: [], provisioning: null, status: null, alexa: null, hive: null, googleNest: null, heatingDemandController: null, heatingDemandDraft: null, analyticsCategoryDrafts: new Map(), hiveAuth: { sessionId: "", action: "connect" }, googleNestAuth: { sessionId: "", popup: null, timer: null }, googleNestConfigEditing: false, selectedArea: "all", expandedDevices: new Set(), expandedRadios: new Set(), radioInventory: { zigbee: null, thread: null }, activity: { records: [], nextCursor: null, hasMore: false, deviceId: "", category: "", expanded: false } };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

function showNotice(message, kind = "info") { const notice = $("#notice"); notice.textContent = message || ""; notice.dataset.kind = kind; notice.classList.toggle("hidden", !message); }
function operatorAuthorityPaused() { return document.body.classList.contains("operator-authority-unavailable") || document.body.classList.contains("operator-authority-ended"); }
function api(route, options = {}) { return window.DinodiaApi.request(route, options, state.token); }
window.DinodiaAutomations?.configure({ api, notice: showNotice, escapeHtml });
function areaName(id) { return state.areas.find((area) => area.id === id)?.name || "Unassigned"; }
function entityCount(device) { return window.DinodiaDevices.countEntities(device); }
function deviceAreaIds(device) { return window.DinodiaDevices.effectiveAreaIds(device); }
function deviceAreaSummary(device) { return window.DinodiaDevices.areaSummary(device, state.areas); }
function graphLabel(value, limit) { const text = String(value ?? ""); return escapeHtml(text.length > limit ? `${text.slice(0, limit - 1)}…` : text); }
function networkGraphSvg(adapter, marker, title, devices) {
  const positions = devices.map((device, index) => {
    const angle = devices.length === 1 ? 0 : -90 + index * (360 / devices.length);
    const radians = angle * Math.PI / 180;
    return { device, x: Math.round(500 + Math.cos(radians) * 320), y: Math.round(250 + Math.sin(radians) * 170) };
  });
  const edges = positions.map(({ x, y }) => `<line x1="500" y1="250" x2="${x}" y2="${y}" />`).join("");
  const nodes = positions.map(({ device, x, y }) => `<g class="network-graph-node" transform="translate(${x} ${y})"><rect x="-90" y="-32" width="180" height="64" rx="14" /><text class="network-graph-node-name" x="0" y="-5" text-anchor="middle">${graphLabel(device.name, 24)}</text><text class="network-graph-node-meta" x="0" y="16" text-anchor="middle">${graphLabel(`${deviceAreaSummary(device)} · ${device.available !== false ? "Online" : "Offline"}`, 29)}</text></g>`).join("");
  return `<svg class="network-graph-svg" viewBox="0 0 1000 500" role="img" aria-label="${escapeHtml(adapter.name || title)} network graph"><g class="network-graph-edges" aria-hidden="true">${edges}</g><g class="network-graph-core"><rect x="375" y="188" width="250" height="124" rx="24" /><rect class="network-graph-core-icon" x="480" y="207" width="40" height="40" rx="12" /><text class="network-graph-core-marker" x="500" y="234" text-anchor="middle">${marker}</text><text class="network-graph-core-name" x="500" y="274" text-anchor="middle">${graphLabel(adapter.name || title, 25)}</text><text class="network-graph-core-meta" x="500" y="296" text-anchor="middle">${graphLabel(title, 27)}</text></g>${nodes}</svg>`;
}
function optionList(items, selected = "") { return `<option value="">Unassigned</option>${items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}`; }
function fixedLabels() { return FIXED_LABELS.map((fixed) => state.labels.find((label) => label.id === fixed.id) || state.labels.find((label) => label.name === fixed.name)).filter(Boolean); }
const NONE_LABEL_VALUE = "__none__";
function labelOptions(selected = []) {
  const selectedLabels = new Set(selected);
  const selectedLabel = fixedLabels().find((label) => selectedLabels.has(label.id))?.id || "";
  return `<option value="${NONE_LABEL_VALUE}" ${selectedLabel ? "" : "selected"}>None</option>${fixedLabels().map((label) => `<option value="${escapeHtml(label.id)}" ${label.id === selectedLabel ? "selected" : ""}>${escapeHtml(label.name)}</option>`).join("")}`;
}
function selectedLabelIds(select) {
  const selected = select.value;
  return !selected || selected === NONE_LABEL_VALUE ? [] : [selected];
}

function renderAreasDashboard() {
  const groups = [...state.areas.map((area) => ({ ...area, devices: state.devices.filter((device) => deviceAreaIds(device).includes(String(area.id))) })), { id: "", name: "Unassigned", devices: state.devices.filter((device) => deviceAreaIds(device).length === 0) }];
  $("#areas-dashboard").innerHTML = state.areas.length || state.devices.length ? groups.map((area) => `<button class="area-card ${state.selectedArea === area.id ? "selected" : ""}" data-filter-area="${escapeHtml(area.id)}"><span class="area-icon">${area.id ? "⌂" : "＋"}</span><span class="area-copy"><strong>${escapeHtml(area.name)}</strong><small>${area.devices.length} device${area.devices.length === 1 ? "" : "s"}</small></span><span class="area-online">${area.devices.filter((device) => device.available !== false).length} online</span><span class="area-arrow">→</span></button>`).join("") : `<div class="empty-state">No provisioned areas yet.</div>`;
  document.querySelectorAll("[data-filter-area]").forEach((button) => button.addEventListener("click", () => { state.selectedArea = button.dataset.filterArea; $("#device-filter").value = state.selectedArea || "unassigned"; renderAreasDashboard(); renderDevices(); $("#devices-section").scrollIntoView({ behavior: "smooth", block: "start" }); }));
}
function renderAreaControls() { const filter = $("#device-filter"); const current = filter.value; filter.innerHTML = `<option value="all">All devices</option>${state.areas.map((area) => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join("")}<option value="unassigned">Unassigned</option>`; filter.value = [...state.areas.map((area) => area.id), "unassigned", "all"].includes(current) ? current : "all"; state.selectedArea = filter.value === "unassigned" ? "" : filter.value; filter.onchange = () => { state.selectedArea = filter.value === "unassigned" ? "" : filter.value; renderAreasDashboard(); renderDevices(); }; }
function renderAreas() { $("#areas").innerHTML = state.areas.length ? state.areas.map((area) => `<span class="chip">${escapeHtml(area.name)}${state.status?.features?.areaDeletion ? `<button type="button" class="chip-delete" data-delete-area="${escapeHtml(area.id)}" aria-label="Delete room ${escapeHtml(area.name)}">✕</button>` : ""}</span>`).join("") : `<p class="subtle small">No areas have been provisioned yet.</p>`; document.querySelectorAll("[data-delete-area]").forEach((button) => button.addEventListener("click", () => openAreaDeletion(button.dataset.deleteArea))); renderPendingAreaDeletions(); }
function areaDeletionDialog() { let dialog = $("#area-deletion-dialog"); if (!dialog) { dialog = document.createElement("dialog"); dialog.id = "area-deletion-dialog"; dialog.className = "area-deletion-dialog"; document.body.append(dialog); } return dialog; }
async function openAreaDeletion(areaId) {
  const area = state.areas.find((row) => String(row.id) === String(areaId)); if (!area) return;
  const dialog = areaDeletionDialog(); const path = `/api/areas/${encodeURIComponent(areaId)}/deletion`;
  dialog.setAttribute("aria-label", `Delete room ${area.name}`);
  dialog.innerHTML = `<h2>Delete ${escapeHtml(area.name)}?</h2><p class="subtle">Preparing a deletion preview…</p>`; dialog.showModal();
  let preview; try { preview = await api(`${path}/preview`, { method: "POST", body: "{}" }); }
  catch (error) { dialog.innerHTML = `<h2>Cannot delete ${escapeHtml(area.name)}</h2><p class="error-text">${escapeHtml(error.message)}</p><div class="dialog-actions"><button type="button" data-close>Close</button></div>`; dialog.querySelector("[data-close]").onclick = () => dialog.close(); return; }
  dialog.innerHTML = `<h2>Delete ${escapeHtml(preview.areaName)}?</h2><p>${escapeHtml(preview.warning)}</p><ul><li>${preview.deviceCount} device${preview.deviceCount === 1 ? "" : "s"} will be removed</li>${preview.sharedHardwarePreserved ? `<li>${preview.sharedHardwarePreserved} shared switch${preview.sharedHardwarePreserved === 1 ? "" : "es"} stay paired for other rooms</li>` : ""}${preview.providerDetachments ? `<li>${preview.providerDetachments} provider-linked device${preview.providerDetachments === 1 ? "" : "s"} will be detached from Dinodia only. Their provider account is unchanged.</li>` : ""}</ul><label>Type <strong>${escapeHtml(preview.areaName)}</strong> to confirm<input id="area-delete-name" autocomplete="off"></label><p class="error-text" id="area-delete-error" role="alert"></p><div class="dialog-actions"><button type="button" data-close>Cancel</button><button type="button" class="danger" id="area-delete-confirm" disabled>Delete room permanently</button></div>`;
  const input = dialog.querySelector("#area-delete-name"), confirm = dialog.querySelector("#area-delete-confirm");
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  input.oninput = () => { confirm.disabled = input.value !== preview.areaName; };
  confirm.onclick = async () => { confirm.disabled = true; confirm.textContent = "Deleting…";
    try { let result = await api(`${path}/confirm`, { method: "POST", body: JSON.stringify({ operationId: preview.operationId, digest: preview.digest, confirmationName: input.value }) });
      dialog.innerHTML = `<h2>${result.state === "COMPLETE" ? "Room deleted" : "Deletion in progress"}</h2><p class="subtle">${result.state === "COMPLETE" ? "The room and its data were removed." : "Access is fenced. Cleanup is not yet complete; use Resume room cleanup to retry."}${result.providerDetachments ? " Provider-linked devices were detached from Dinodia; they remain in the provider account." : ""}</p><div class="dialog-actions"><button type="button" data-close>Done</button></div>`;
      dialog.querySelector("[data-close]").onclick = () => { dialog.close(); loadDashboard(); };
    } catch (error) { dialog.querySelector("#area-delete-error").textContent = `${error.message}. Deletion may already be fenced. Retry this operation; do not create a second request.`; confirm.textContent = "Retry deletion"; confirm.disabled = input.value !== preview.areaName; } };
}

async function renderPendingAreaDeletions() {
  if (!state.status?.features?.areaDeletion && !state.status?.features?.areaDeletionRecovery) return;
  try {
    const response = await api("/api/areas/deletion-operations");
    const pending = response.operations || [];
    for (const operation of pending) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Resume room cleanup · ${operation.areaName || "Deleted room"}`;
      button.onclick = async () => {
        button.disabled = true;
        try {
          const result = await api(`/api/areas/${encodeURIComponent(operation.areaId)}/deletion/confirm`, {
            method: "POST", body: JSON.stringify({ operationId: operation.operationId,
              digest: operation.digest, confirmationName: operation.areaName }) });
          showNotice(result.state === "COMPLETE" ? "Room cleanup completed." : "Cleanup remains pending.", "info");
          await loadDashboard();
        } catch (error) { button.disabled = false; showNotice(error.message, "error"); }
      };
      $("#areas").append(button);
    }
    const conversions = await api("/api/devices/logical-conversion-operations");
    for (const operation of conversions.operations || []) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = "Resume channel conversion";
      button.onclick = () => openLogicalConversion(operation.physicalId, { ...operation,
        warning: "This previously confirmed conversion is fenced and not yet complete. Retry resumes the same operation; it never pairs or switches hardware." });
      $("#areas").append(button);
    }
  } catch (error) { showNotice(`Cannot check pending room cleanup: ${error.message}`, "error"); }
}

let pendingAreaCreateOperation = null;
async function openLogicalConversion(id, retainedPreview = null) {
  const dialog = areaDeletionDialog();
  dialog.setAttribute("aria-label", "Separate device channels");
  dialog.innerHTML = '<h2>Separate device channels</h2><p>Checking the current channel mapping…</p>';
  dialog.showModal();
  try {
    const path = `/api/devices/${encodeURIComponent(id)}/logical-conversion`;
    const preview = retainedPreview || await api(`${path}/preview`, { method: 'POST', body: '{}' });
    dialog.innerHTML = `<h2>Separate ${preview.channelCount} channels?</h2><p>${escapeHtml(preview.warning)}</p><p>Each channel can then have its own room, label and analytics category.</p><label>Type ${escapeHtml(preview.confirmationName)}<input autocomplete="off"></label><p data-error role="alert"></p><div class="dialog-actions"><button data-close>Cancel</button><button data-confirm disabled>Separate channels</button></div>`;
    const input = dialog.querySelector('input'), button = dialog.querySelector('[data-confirm]');
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    input.oninput = () => { button.disabled = input.value !== preview.confirmationName; };
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`${path}/confirm`, { method: 'POST', body: JSON.stringify({
          operationId: preview.operationId, digest: preview.digest, confirmationName: input.value }) });
        dialog.close(); await loadDashboard(); showNotice('Channels separated. Existing history remains with the original device.');
      } catch (error) {
        dialog.querySelector('[data-error]').textContent = `${error.message}. Conversion may be pending; retry this same operation.`;
        button.textContent = 'Retry conversion'; button.disabled = false;
      }
    };
  } catch (error) {
    dialog.innerHTML = `<h2>Cannot separate channels</h2><p role="alert">${escapeHtml(error.message)}</p><button data-close>Close</button>`;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
  }
}
function createAreaOperationId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID is restricted to secure contexts, while getRandomValues is
  // available to the authenticated installer UI on a private HTTP LAN.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function readPendingAreaCreate() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("dinodia.os.pending-area-create.v1") || "null");
    if (saved && /^[0-9a-f-]{36}$/i.test(saved.id || "") && typeof saved.name === "string") pendingAreaCreateOperation = saved;
  } catch { /* Private browsing/storage-disabled mode retains the request in memory. */ }
  return pendingAreaCreateOperation;
}
function writePendingAreaCreate(operation) {
  pendingAreaCreateOperation = operation;
  try { sessionStorage.setItem("dinodia.os.pending-area-create.v1", JSON.stringify(operation)); } catch { /* Same-page retry remains idempotent. */ }
}
function clearPendingAreaCreate() {
  pendingAreaCreateOperation = null;
  try { sessionStorage.removeItem("dinodia.os.pending-area-create.v1"); } catch { /* Nothing else to clear. */ }
}

$("#area-create-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const nameInput = $("#area-create-name");
  const submit = $("#area-create-submit");
  const status = $("#area-create-status");
  const name = String(nameInput?.value || "").normalize("NFKC").trim();
  if (!name || [...name].length > 80) {
    status.textContent = "Enter an Area name of 1–80 characters.";
    nameInput?.focus();
    return;
  }
  const saved = readPendingAreaCreate();
  const operation = saved?.name === name ? saved : { id: createAreaOperationId(), name };
  writePendingAreaCreate(operation);
  if (submit) submit.disabled = true;
  status.textContent = "Saving this Area on the selected hub…";
  try {
    const area = await api("/api/areas", { method: "POST", body: JSON.stringify({ id: operation.id, name: operation.name, icon: "room" }) });
    clearPendingAreaCreate();
    state.areas = [...state.areas.filter((entry) => entry.id !== area.id), area];
    renderAreaControls();
    renderAreasDashboard();
    renderAreas();
    $("#area-count").textContent = String(state.areas.length);
    form.reset();
    status.textContent = "Area saved on this hub. Platform sync is pending; refresh the assigned-work status in Company Portal to confirm its acknowledgement.";
  } catch (error) {
    status.textContent = `${error.message}. If the response was interrupted, retrying this same submission will not create a duplicate Area.`;
  } finally { if (submit) submit.disabled = false; }
});
function renderLabels() { $("#labels").innerHTML = fixedLabels().map((label) => `<span class="chip label-chip">${escapeHtml(label.name)}</span>`).join(""); }

function serviceParameter(serviceId, input) { if (input?.dataset?.parameter) return input.dataset.parameter; const suffix = String(serviceId).split(".").pop(); return suffix === "select_option" ? "option" : suffix === "set_value" ? "value" : suffix === "set_temperature" ? "temperature" : suffix === "set_hvac_mode" ? "hvac_mode" : suffix === "set_preset_mode" ? "preset_mode" : "value"; }
function entityControl(entity) { return window.DinodiaCapabilityControls?.controls?.(entity) || window.DinodiaCapabilityControls?.control?.(entity) || `<span class="read-only-state">${escapeHtml(entity.state ?? "—")}</span>`; }
function surfaceRows(device) {
  const surfaces = window.DinodiaDevices.surfaces(device);
  return surfaces.map((surface) => `<div class="surface-row"><div class="surface-info"><strong>${escapeHtml(surface.name)}</strong><small>${escapeHtml(surface.domain || "control")} · ${escapeHtml(String(surface.state ?? "unknown"))}</small><span class="capability-pill">Shown in apps</span></div><div class="surface-controls">${entityControl(surface)}</div></div>`).join("");
}
const ANALYTICS_CATEGORIES = ["NONE", "LIGHT", "BOILER", "RADIATOR"];
const ANALYTICS_CATEGORY_LABELS = { NONE: "None", LIGHT: "Light", BOILER: "Boiler", RADIATOR: "Radiator" };
function analyticsCategoryPendingKey(deviceId) { return `dinodia.os.pending-analytics-category.v1:${deviceId}`; }
function readAnalyticsCategoryPending(deviceId) {
  try {
    const value = JSON.parse(sessionStorage.getItem(analyticsCategoryPendingKey(deviceId)) || "null");
    return value?.body && typeof value.body === "object" && /^[0-9a-f-]{36}$/i.test(value.body.operationId || "") ? value : null;
  } catch { return null; }
}
function writeAnalyticsCategoryPending(deviceId, value) {
  try { sessionStorage.setItem(analyticsCategoryPendingKey(deviceId), JSON.stringify(value)); } catch { /* Same-page retries retain the exact operation in memory below. */ }
  memoryAnalyticsCategoryOperations.set(deviceId, value);
}
const memoryAnalyticsCategoryOperations = new Map();
function pendingAnalyticsCategory(deviceId) { return readAnalyticsCategoryPending(deviceId) || memoryAnalyticsCategoryOperations.get(deviceId) || null; }
function clearAnalyticsCategoryPending(deviceId) {
  memoryAnalyticsCategoryOperations.delete(deviceId);
  try { sessionStorage.removeItem(analyticsCategoryPendingKey(deviceId)); } catch { /* Nothing else to clear. */ }
}
function analyticsCategoryEditor(device) {
  if (!Object.hasOwn(device, "analyticsCategory") || !Number.isSafeInteger(Number(device.analyticsManagementRevision))) return "";
  const current = ANALYTICS_CATEGORIES.includes(device.analyticsCategory) ? device.analyticsCategory : "NONE";
  const pending = pendingAnalyticsCategory(device.id);
  if (pending?.managementRevision && pending.body.analyticsCategory === current && Number(device.analyticsManagementRevision) >= Number(pending.managementRevision)) {
    clearAnalyticsCategoryPending(device.id);
    state.analyticsCategoryDrafts.delete(device.id);
  }
  const activePending = pendingAnalyticsCategory(device.id);
  const selected = ANALYTICS_CATEGORIES.includes(state.analyticsCategoryDrafts.get(device.id)) ? state.analyticsCategoryDrafts.get(device.id) : current;
  const disabled = Boolean(activePending);
  const status = activePending
    ? activePending.managementRevision
      ? "Platform accepted this category. Waiting for the hub's next signed configuration. Retry reuses the same safe operation."
      : "This category update is awaiting confirmation. Retry reuses the same operation; do not submit a different category yet."
    : "Optional reporting metadata only; category does not create readings. Radiator Usage represents observed heat-demand activity, not gas volume or cost.";
  const readiness = device.analyticsReadiness;
  const sources = readiness?.candidates?.flatMap(group => group.controls) || [];
  const sourceEditor = sources.length > 1 ? `<label><span>Analytics source (one channel)</span><select data-analytics-source="${escapeHtml(device.id)}" ${disabled ? 'disabled' : ''}><option value="">Automatic only when unambiguous</option>${sources.map(control => `<option value="${escapeHtml(control.controlId)}" ${readiness.selectedControlId === control.controlId ? 'selected' : ''}>${escapeHtml(control.label)}</option>`).join('')}</select></label>` : '';
  return `<section class="analytics-category-editor" data-analytics-editor="${escapeHtml(device.id)}"><label><span>Analytics category (optional)</span><select data-analytics-category="${escapeHtml(device.id)}" aria-label="Analytics category" ${disabled ? "disabled" : ""}>${ANALYTICS_CATEGORIES.map((category) => `<option value="${category}" ${selected === category ? "selected" : ""}>${ANALYTICS_CATEGORY_LABELS[category]}</option>`).join("")}</select></label>${sourceEditor}<button class="secondary" data-save-analytics-category="${escapeHtml(device.id)}" type="button">${activePending ? "Retry category update" : "Save category"}</button><small data-analytics-category-status="${escapeHtml(device.id)}">${escapeHtml(status)}</small>${readiness ? `<small>Analytics ${escapeHtml(readiness.state)}${readiness.reason ? ` · ${escapeHtml(readiness.reason.replaceAll('_', ' '))}` : ''}</small>` : ''}</section>`;
}
function setupForm(device) {
  const id = escapeHtml(device.id);
  const selectedLabel = (device.labelIds || device.labels || [])[0] || "";
  const suggestedLabel = !selectedLabel && ["hive", "google_nest"].includes(device.protocol) && device.definition?.kind === "heating" ? (device.definition?.suggestedLabelId || "boiler") : "";
  const previewCount = window.DinodiaDevices.surfaces(device).length;
  return `<div class="device-setup-form" data-device-setup="${id}"><div class="setup-form-intro"><strong>${device.setup?.status === "ready" ? "Device assignment" : "Finish setting up this device"}</strong><span>${device.setup?.status === "ready" ? "One area and one label apply to all of this device's controls." : "Choose these once. Dinodia OS will derive the useful controls automatically."}</span></div><span class="setup-preview" data-device-preview="${id}">${previewCount ? `${previewCount} control${previewCount === 1 ? "" : "s"} will appear in the Dinodia apps.` : "Choose an area and label to preview the app-facing controls."}</span><div class="device-edit"><label><span>Name (optional)</span><input data-device-name="${id}" value="${escapeHtml(device.name)}" aria-label="Device name"></label><label><span>Area</span><select data-device-area="${id}" aria-label="Device area" required>${optionList(state.areas, device.areaId || "")}</select></label><label><span>Label</span><select data-device-labels="${id}" aria-label="Device label" required>${labelOptions(selectedLabel ? [selectedLabel] : [suggestedLabel])}</select></label><button class="primary" data-save-device="${id}" type="button">${device.setup?.status === "ready" ? "Save assignment" : "Save and show controls"}</button></div>${analyticsCategoryEditor(device)}${state.status?.features?.areaDeletion && device.logicalConversionAvailable ? `<button type="button" class="secondary" data-convert-device="${id}">Separate channels</button>` : ""}${!device.physicalDeviceId ? `<button class="danger device-remove-button" data-remove-device="${id}" type="button">Remove paired device</button>` : `<p class="subtle">This is one channel on shared hardware. Room deletion preserves channels assigned elsewhere.</p>`}</div>`;
}
async function sendEntityControl(control, serviceId, entityId) {
  const row = control.closest(".surface-row");
  const input = [...row.querySelectorAll(`.entity-control[data-service="${CSS.escape(serviceId)}"]`)].find((candidate) => !candidate.dataset.submitControl);
  const value = input?.type === "range" ? Number(input.value) : input?.value;
  const data = value === undefined ? {} : { [serviceParameter(serviceId, input)]: value };
  try { await api(`/api/entities/${encodeURIComponent(entityId)}/service`, { method: "POST", body: JSON.stringify({ serviceId, data }) }); await load(); } catch (error) { showNotice(error.message, "error"); }
}
function renderDevices() {
  const filter = $("#device-filter")?.value || "all";
  const devices = state.devices.filter((device) => filter === "all" || (filter === "unassigned" ? deviceAreaIds(device).length === 0 : deviceAreaIds(device).includes(filter))).map((device) => device.protocol === "google_nest" ? { ...device, protocolIdentity: {} } : device);
  $("#devices").innerHTML = devices.length ? devices.map((device) => {
    const editorId = `device-editor-${encodeURIComponent(device.id)}`;
    const expanded = state.expandedDevices.has(device.id);
    const protocolMark = device.protocol === "zigbee" ? "Z" : device.protocol === "matter" ? "M" : device.protocol === "hive" ? "H" : device.protocol === "google_nest" ? "N" : "•";
    const visible = window.DinodiaDevices.surfaces(device);
    const controls = visible.length;
    const diagnosticCount = window.DinodiaDevices.diagnosticCount(device);
    const setupStatus = device.setup?.status || "needs_setup";
    const statusLabel = setupStatus === "ready" ? (device.available !== false ? "Online" : "Offline") : "Needs setup";
    const statusClass = setupStatus === "ready" && device.available !== false ? "tile-status-online" : "tile-status-offline";
    const details = setupStatus === "ready" ? `<div class="entity-heading"><div><strong>Controls shown in apps</strong><span class="subtle small">${controls} control surface${controls === 1 ? "" : "s"} · all technical entities stay behind diagnostics</span></div></div><div class="surface-list">${surfaceRows(device) || `<p class="subtle small">No safe household controls were identified for this device.</p>`}</div>` : `<div class="needs-setup-callout"><strong>Choose the area and label to continue.</strong><span>After saving, only the useful controls will appear here and in the Dinodia apps.</span></div>`;
    return `<article class="device-card ${expanded ? "expanded" : ""}" data-device-card="${escapeHtml(device.id)}"><button class="device-tile" data-toggle-device="${escapeHtml(device.id)}" type="button" aria-expanded="${expanded}" aria-controls="${editorId}"><span class="device-orb ${device.available !== false ? "online-orb" : "offline-orb"}">${protocolMark}</span><span class="device-tile-copy"><span class="device-tile-area">${escapeHtml(deviceAreaSummary(device))}</span><strong class="device-tile-name">${escapeHtml(device.name)}</strong><span class="device-tile-meta"><span>${controls} control${controls === 1 ? "" : "s"}</span><span class="tile-status ${statusClass}">${statusLabel}</span></span></span><span class="device-tile-action"><span>${expanded ? "Close" : "Manage"}</span><span class="device-tile-chevron" aria-hidden="true">⌄</span></span></button><div class="device-editor" id="${editorId}" ${expanded ? "" : "inert"}><div class="device-editor-head"><div><strong>${setupStatus === "ready" ? "Manage device" : "Device setup"}</strong><span>${escapeHtml(device.protocol)} · ${diagnosticCount} technical entr${diagnosticCount === 1 ? "y" : "ies"} hidden</span></div><button class="text-button" data-collapse-device type="button">Done</button></div>${setupForm(device)}${details}<details class="device-diagnostics"><summary>Show technical diagnostics (${diagnosticCount})</summary><pre>${escapeHtml(JSON.stringify({ presentation: device.presentation, definition: { source: device.definition?.source, model: device.definition?.model, supported: device.definition?.supported }, identity: device.protocolIdentity }, null, 2))}</pre></details></div></article>`;
  }).join("") : `<div class="empty-state">No devices in this view. Use Add devices above.</div>`;
  document.querySelectorAll("[data-toggle-device]").forEach((button) => button.addEventListener("click", () => { const card = button.closest("[data-device-card]"); const editor = card.querySelector(".device-editor"); const expanded = !card.classList.contains("expanded"); card.classList.toggle("expanded", expanded); button.setAttribute("aria-expanded", String(expanded)); button.querySelector(".device-tile-action > span:first-child").textContent = expanded ? "Close" : "Manage"; editor.inert = !expanded; if (expanded) state.expandedDevices.add(card.dataset.deviceCard); else state.expandedDevices.delete(card.dataset.deviceCard); }));
  document.querySelectorAll("[data-collapse-device]").forEach((button) => button.addEventListener("click", () => button.closest("[data-device-card]").querySelector("[data-toggle-device]").click()));
  document.querySelectorAll("[data-convert-device]").forEach(button => button.addEventListener("click", () => openLogicalConversion(button.dataset.convertDevice)));
  document.querySelectorAll("[data-save-device]").forEach((button) => button.addEventListener("click", async () => { const id = button.dataset.saveDevice; const card = button.closest(".device-card"); const name = card.querySelector(`[data-device-name="${CSS.escape(id)}"]`).value; const areaId = card.querySelector(`[data-device-area="${CSS.escape(id)}"]`).value; const labels = selectedLabelIds(card.querySelector(`[data-device-labels="${CSS.escape(id)}"]`)); if (!areaId) return showNotice("Choose an area before saving the device.", "error"); if (!labels.length) return showNotice("Choose one device label before saving the device.", "error"); button.disabled = true; try { await api(`/api/devices/${encodeURIComponent(id)}/setup`, { method: "PUT", body: JSON.stringify({ name, areaId, labelId: labels[0], ...(state.devices.find(row => row.id === id)?.physicalDeviceId ? { operationId: button.dataset.operationId ||= createAreaOperationId() } : {}) }) }); await load(); showNotice("Device setup saved. Its app-facing controls are ready."); } catch (error) { button.disabled = false; showNotice(error.message, "error"); } }));
  document.querySelectorAll("[data-analytics-category]").forEach((select) => select.addEventListener("change", () => state.analyticsCategoryDrafts.set(select.dataset.analyticsCategory, select.value)));
  document.querySelectorAll("[data-save-analytics-category]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.saveAnalyticsCategory;
    const device = state.devices.find((candidate) => String(candidate.id) === id);
    const status = button.closest("[data-analytics-editor]")?.querySelector(`[data-analytics-category-status="${CSS.escape(id)}"]`);
    let pending = pendingAnalyticsCategory(id);
    if (!pending) {
      const analyticsCategory = state.analyticsCategoryDrafts.get(id) || device?.analyticsCategory || "NONE";
      if (!device || !Object.hasOwn(device, "analyticsCategory") || !Number.isSafeInteger(Number(device.analyticsManagementRevision))) {
        if (status) status.textContent = "Only a permanent property device with a current signed policy can be changed.";
        return;
      }
      const sourceSelect = button.closest('[data-analytics-editor]')?.querySelector('[data-analytics-source]');
      const selectedControlId = sourceSelect ? sourceSelect.value || null : device.analyticsReadiness?.selectedControlId ?? null;
      if (analyticsCategory === device.analyticsCategory && selectedControlId === (device.analyticsReadiness?.selectedControlId ?? null)) {
        if (status) status.textContent = "No category change to save.";
        return;
      }
      pending = { body: { analyticsCategory, expectedAnalyticsCategory: device.analyticsCategory, expectedManagementRevision: Number(device.analyticsManagementRevision),
        ...(sourceSelect ? { selectedControlId, expectedSelectedControlId: device.analyticsReadiness?.selectedControlId ?? null } : {}),
        ...(Number.isSafeInteger(Number(device.analyticsInventoryRevision)) && Number(device.analyticsInventoryRevision) > 0 ? { expectedInventoryRevision: Number(device.analyticsInventoryRevision) } : {}),
        operationId: createAreaOperationId() }, managementRevision: null };
      writeAnalyticsCategoryPending(id, pending);
      state.analyticsCategoryDrafts.delete(id);
    }
    button.disabled = true;
    if (status) status.textContent = "Saving category to the assigned Home's canonical record…";
    try {
      const result = await api(`/api/devices/${encodeURIComponent(id)}/analytics-category`, { method: "PATCH", body: JSON.stringify(pending.body) });
      pending = { ...pending, managementRevision: Number(result.managementRevision) };
      writeAnalyticsCategoryPending(id, pending);
      if (status) status.textContent = "Platform accepted the change. Waiting for the hub to receive and verify its next signed configuration; readings were not created.";
      await load();
      showNotice("Analytics category saved in the canonical Home record. Signed hub configuration sync is pending; no readings or gas usage were fabricated.");
    } catch (error) {
      if (error.status === 409 && String(error.code || "").toLowerCase() === "analytics_category_revision_conflict") {
        clearAnalyticsCategoryPending(id);
        state.analyticsCategoryDrafts.delete(id);
        if (status) status.textContent = "The Home or this device changed since it was loaded. Refreshing its signed category; review and save your choice again.";
        button.disabled = true;
        try { await load(); showNotice("The Home configuration changed. Review the refreshed category and save again; the rejected update made no change.", "error"); }
        catch { button.disabled = false; }
        return;
      }
      if (status) status.textContent = `${error.message}. Retry uses the same operation ID and exact request.`;
      button.disabled = false;
    }
  }));
  document.querySelectorAll("[data-remove-device]").forEach((button) => button.addEventListener("click", async () => { const id = button.dataset.removeDevice; const device = state.devices.find((candidate) => candidate.id === id); const zigbee = String(device?.protocol || "").toLowerCase() === "zigbee"; const warning = zigbee ? " The hub will forget and block this Zigbee device; if it reconnects later, Zigbee2MQTT will ask it to leave. This cannot erase network credentials stored inside a powered-off device; factory-reset it if you need those credentials erased." : " This unpairs it and deletes its household controls, history, automations, and remote bindings."; if (!confirm(`Remove ${device?.name || "this device"} completely from Dinodia OS? This deletes its local household controls, history, automations, and remote bindings.${warning}`)) return; button.disabled = true; try { await api(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ force: false }) }); state.expandedDevices.delete(id); await load(); showNotice(zigbee ? "Zigbee device removed and blocked. The hub will request that it leave if it reconnects; factory reset is needed to erase credentials stored on the device." : "Device completely removed. Pair it again if you want to add it back."); } catch (error) { button.disabled = false; showNotice(error.message, "error"); } }));
  document.querySelectorAll("[data-device-setup]").forEach((form) => { const id = form.dataset.deviceSetup; const area = form.querySelector(`[data-device-area="${CSS.escape(id)}"]`); const label = form.querySelector(`[data-device-labels="${CSS.escape(id)}"]`); const preview = form.querySelector(`[data-device-preview="${CSS.escape(id)}"]`); const refreshPreview = async () => { if (!area.value || !label.value || label.value === NONE_LABEL_VALUE) { preview.textContent = "Choose an area and label to preview the app-facing controls."; return; } try { const result = await api(`/api/devices/${encodeURIComponent(id)}/setup?areaId=${encodeURIComponent(area.value)}&labelId=${encodeURIComponent(label.value)}`); const surfaces = result.surfacePreview?.surfaces || []; preview.textContent = surfaces.length ? `${surfaces.length} control${surfaces.length === 1 ? "" : "s"} will appear in the Dinodia apps.` : "No safe household controls were identified yet."; } catch { preview.textContent = "Preview unavailable until discovery is complete."; } }; area.addEventListener("change", refreshPreview); label.addEventListener("change", refreshPreview); });
  document.querySelectorAll(".entity-control[data-service]").forEach((control) => {
    if (control.dataset.submitControl) return;
    if (control.type === "range") control.addEventListener("change", () => sendEntityControl(control, control.dataset.service, control.dataset.entity));
    else if (control.tagName === "BUTTON") control.addEventListener("click", () => sendEntityControl(control, control.dataset.service, control.dataset.entity));
  });
  document.querySelectorAll("[data-submit-control]").forEach((button) => button.addEventListener("click", () => sendEntityControl(button, button.dataset.service, button.dataset.entity)));
}

document.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "range") return;
  const output = input.parentElement?.querySelector(".range-value");
  if (output) output.value = output.textContent = input.value;
});

function setRadioSetup(kind, result = {}) {
  const selected = Boolean(result.selected?.path);
  const prefix = kind === "zigbee" ? "zigbee" : "thread";
  $(`#${prefix}-radio-setup`)?.classList.toggle("hidden", selected);
  $(`#${prefix}-connected-row`)?.classList.toggle("hidden", !selected);
  const detail = kind === "zigbee"
    ? `${result.selected?.name || "Selected coordinator"} · ${state.status?.integrations?.zigbee?.connected ? "Zigbee2MQTT online" : "Zigbee2MQTT starting"}`
    : `${result.selected?.name || "Selected Thread RCP"} · OTBR ${state.status?.integrations?.otbr?.reachable ? "online" : "starting"} · ${result.baudRate || 460800} baud · Ethernet ${result.infraIf || "eth0"}`;
  $(`#${prefix}-connected-detail`).textContent = detail;
}

function radioEntries() {
  const zigbee = state.radioInventory.zigbee || {};
  const thread = state.radioInventory.thread || {};
  return window.DinodiaRadios.inventoryEntries(zigbee, thread);
}

function renderRadioTiles() {
  const zigbee = state.radioInventory.zigbee || {};
  const thread = state.radioInventory.thread || {};
  const zigbeePath = zigbee.selected?.path || "";
  const threadPath = thread.selected?.path || "";
  const zigbeeIntegration = state.status?.integrations?.zigbee || {};
  const threadIntegration = state.status?.integrations?.otbr || {};
  const entries = radioEntries();
  const onlineCount = entries.filter(({ adapter, kind, selected }) => selected && (kind === "zigbee"
    ? window.DinodiaRadios.connectionStatus(adapter, zigbeePath, zigbeeIntegration).online
    : window.DinodiaRadios.threadConnectionStatus(adapter, threadPath, threadIntegration).online)).length;
  $("#radio-status-badge").textContent = onlineCount === 2 ? "2 radios online" : onlineCount === 1 ? "1 radio online" : entries.length ? "Setup required" : "No dongles";
  $("#radio-tiles").innerHTML = entries.length ? entries.map(({ adapter, kind, selected }) => {
    const key = window.DinodiaRadios.adapterKey(adapter);
    const detailsId = `radio-details-${encodeURIComponent(key)}`;
    const expanded = state.expandedRadios.has(key);
    const status = kind === "zigbee"
      ? window.DinodiaRadios.connectionStatus(adapter, zigbeePath, zigbeeIntegration)
      : window.DinodiaRadios.threadConnectionStatus(adapter, threadPath, threadIntegration);
    const devices = state.devices.filter((device) => !window.DinodiaDevices.isInfrastructureDevice(device) && (kind === "zigbee" ? device.protocol === "zigbee" : device.protocol === "matter"));
    const networkDevices = selected && status.online ? devices : [];
    const protocolName = kind === "zigbee" ? "Zigbee" : "Thread";
    const title = kind === "zigbee" ? "Zigbee coordinator" : "Thread Border Router";
    const marker = kind === "zigbee" ? "Z" : "T";
    const networkContent = !selected
      ? `<div class="network-empty"><strong>Not assigned yet</strong><span>Choose this dongle above to create its ${protocolName} network.</span></div>`
      : status.online
        ? networkDevices.length ? networkGraphSvg(adapter, marker, title, networkDevices) : `<div class="network-empty"><strong>No paired devices yet</strong><span>The ${protocolName} network is online and ready for devices.</span></div>`
        : `<div class="network-empty"><strong>Network unavailable</strong><span>${escapeHtml(status.detail)}</span></div>`;
    const removeWarning = kind === "zigbee" ? "Zigbee2MQTT will stop and the coordinator selection will be cleared." : "OpenThread Border Router and Matter-over-Thread will stop and the Thread selection will be cleared.";
    const removeAction = selected ? `<button class="danger" data-remove-radio="${escapeHtml(key)}" data-radio-kind="${kind}" data-radio-name="${escapeHtml(adapter.name || title)}" data-remove-warning="${escapeHtml(removeWarning)}" type="button">Remove dongle</button>` : `<span class="radio-unassigned-note">Assign this dongle above</span>`;
    return `<article class="radio-tile ${expanded ? "expanded" : ""}" data-radio-tile="${escapeHtml(key)}"><button class="radio-tile-summary" data-toggle-radio="${escapeHtml(key)}" type="button" aria-expanded="${expanded}" aria-controls="${escapeHtml(detailsId)}"><span class="radio-tile-icon ${status.online ? "radio-tile-icon-online" : ""}">${marker}</span><span class="radio-tile-copy"><span class="radio-tile-type">${protocolName}${selected ? " · selected" : " · available"}</span><strong>${escapeHtml(adapter.name || title)}</strong><span class="radio-tile-meta"><span class="radio-status ${status.online ? "radio-status-online" : "radio-status-offline"}">${escapeHtml(status.label)}</span><span>${selected ? `${networkDevices.length || devices.length} ${protocolName} device${(networkDevices.length || devices.length) === 1 ? "" : "s"}` : "Ready to assign"}</span></span></span><span class="radio-tile-action"><span>${expanded ? "Close" : "Details"}</span><span class="radio-tile-chevron" aria-hidden="true">⌄</span></span></button><div class="radio-tile-details" id="${escapeHtml(detailsId)}" ${expanded ? "" : "inert"}><div class="radio-detail-head"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(status.detail)}</span></div><div class="radio-detail-actions">${removeAction}<button class="text-button" data-collapse-radio title="Close the dongle details; this does not remove or change the dongle" type="button">Close details</button></div></div><div class="radio-detail-grid"><div><span>USB path</span><strong>${escapeHtml(adapter.path || "—")}</strong></div><div><span>Connection</span><strong>${adapter.connected ? "Connected" : "Disconnected"}</strong></div><div><span>Role</span><strong>${protocolName}</strong></div><div><span>Network devices</span><strong>${selected ? devices.length : "—"}</strong></div></div><div class="network-diagram-heading"><div><strong>${protocolName} network</strong><span>The ${protocolName} radio sits at the centre of this local device network.</span></div><span class="network-health ${status.online ? "network-health-online" : "network-health-offline"}">${status.online ? "Network online" : "Network offline"}</span></div><div class="network-map" aria-label="${escapeHtml(adapter.name || title)} ${protocolName} network diagram">${networkContent}</div></div></article>`;
  }).join("") : `<div class="empty-state">No USB radios detected. Connect a dongle, then scan again.</div>`;
  document.querySelectorAll("[data-toggle-radio]").forEach((button) => button.addEventListener("click", () => {
    const tile = button.closest("[data-radio-tile]");
    const details = tile.querySelector(".radio-tile-details");
    const expanded = !tile.classList.contains("expanded");
    tile.classList.toggle("expanded", expanded);
    button.setAttribute("aria-expanded", String(expanded));
    button.querySelector(".radio-tile-action > span:first-child").textContent = expanded ? "Close" : "Details";
    details.inert = !expanded;
    if (expanded) state.expandedRadios.add(tile.dataset.radioTile); else state.expandedRadios.delete(tile.dataset.radioTile);
  }));
  document.querySelectorAll("[data-collapse-radio]").forEach((button) => button.addEventListener("click", () => button.closest("[data-radio-tile]").querySelector("[data-toggle-radio]").click()));
  document.querySelectorAll("[data-remove-radio]").forEach((button) => button.addEventListener("click", async () => {
    const kind = button.dataset.radioKind || "zigbee";
    const name = button.dataset.radioName || "this dongle";
    if (!confirm(`Remove ${name} from Dinodia OS? ${button.dataset.removeWarning || "Household devices and assignments will be kept."} Household devices and assignments will be kept.`)) return;
    button.disabled = true;
    try {
      await api(`/api/integrations/${kind}/adapter`, { method: "DELETE", body: JSON.stringify({ path: button.dataset.removeRadio }) });
      state.expandedRadios.delete(button.dataset.removeRadio);
      showNotice(`${name} was removed. It is back in the scan list while it remains connected.`);
      await load();
    } catch (error) {
      button.disabled = false;
      showNotice(error.message, "error");
    }
  }));
}
function renderStatus(status, readiness) { state.status = status; const mqtt = status.integrations.zigbee || status.integrations.mqtt || {}; $("#hub-id").textContent = status.hubId; $("#footer-hub").textContent = status.hubId; $("#side-hub-id").textContent = status.hubId; $("#version").textContent = status.version; $("#device-count").textContent = state.devices.length; $("#online-count").textContent = state.devices.filter((device) => device.available !== false).length; $("#area-count").textContent = state.areas.length; $("#automation-count").textContent = Number(status.automations?.nativeCount || status.nativeAutomations?.count || 0); $("#hub-health").textContent = readiness?.status === "ready" ? "Ready for local and cloud control" : readiness?.status === "degraded" ? "Connected with setup still to finish" : "Local setup required";   const matter = status.integrations.matter || {}; const otbr = status.integrations.otbr || {}; $("#matter-status").textContent = matter.connected ? "Matter Server connected" : matter.configured ? "Matter Server offline" : "Wi-Fi/Thread setup pending"; $("#thread-status").textContent = otbr.reachable ? "Border Router reachable" : otbr.configured ? "Border Router offline" : "Use an existing Border Router or configure a Thread adapter"; $("#radio-status-badge").textContent = mqtt.connected ? "Connected" : mqtt.configured ? "Offline" : "Not configured"; renderCloudflare(status.integrations.cloudflare); }
async function loadAdapters() { try { const result = await api("/api/integrations/zigbee/adapters"); state.radioInventory.zigbee = result; const select = $("#adapter-select"); select.innerHTML = result.adapters.length ? result.adapters.map((adapter) => `<option value="${escapeHtml(adapter.path)}" ${!adapter.supported ? "disabled" : ""} ${result.selected?.path === adapter.path ? "selected" : ""}>${escapeHtml(window.DinodiaRadios.optionLabel(adapter))}${adapter.supported ? "" : " · unsupported"}</option>`).join("") : `<option value="">No USB dongles detected</option>`; $("#adapter-status").textContent = result.selected ? `${result.selected.name} is assigned to Zigbee.` : result.adapters.length ? "Choose the dongle flashed for Zigbee." : "Connect the Zigbee dongle, then scan again."; setRadioSetup("zigbee", result); renderRadioTiles(); } catch (error) { $("#adapter-status").textContent = error.message; state.radioInventory.zigbee = null; setRadioSetup("zigbee"); renderRadioTiles(); } }
async function loadThreadAdapters() { try { const result = await api("/api/integrations/thread/adapters"); state.radioInventory.thread = result; const select = $("#thread-adapter-select"); select.innerHTML = result.adapters.length ? result.adapters.map((adapter) => `<option value="${escapeHtml(adapter.path)}" ${result.selected?.path === adapter.path ? "selected" : ""}>${escapeHtml(window.DinodiaRadios.optionLabel(adapter))}</option>`).join("") : `<option value="">No USB serial radios detected</option>`; $("#thread-adapter-status").textContent = result.selected ? `${result.selected.name} is assigned to Thread.` : result.adapters.length ? "Choose the MG21 flashed for OpenThread." : "Connect the Thread dongle, then scan again."; setRadioSetup("thread", result); renderRadioTiles(); } catch (error) { $("#thread-adapter-status").textContent = error.message; state.radioInventory.thread = null; setRadioSetup("thread"); renderRadioTiles(); } }
function renderCloudflare(cloudflare = {}) { const localConnected = Boolean(cloudflare.connected); const verified = Boolean(cloudflare.secureAccessVerified || cloudflare.platformVerification?.state === "PLATFORM_VERIFIED"); const setupAllowed = cloudflare.setupAllowed !== false; const recoveryState = String(cloudflare.recoveryState || "UNAVAILABLE"); const platformState = String(cloudflare.platformVerification?.state || (localConnected ? "LOCAL_TUNNEL_CONNECTED" : "")); const label = verified ? "Secure access verified" : localConnected ? "Tunnel connected locally" : cloudflare.configured ? "Starting" : recoveryState === "RECONNECT_REQUIRED" ? "Reconnect required" : recoveryState === "HELD" ? "Maintenance hold" : "Not configured"; const setup = cloudflare.setup || {}; $("#cloudflare-setup-badge").textContent = label; const resultText = platformState === "PLATFORM_REPORT_FAILED" ? `Platform verification failed: ${cloudflare.platformVerification?.error || "retry required"}` : platformState === "PLATFORM_REPORT_PENDING" || (localConnected && !verified) ? "The tunnel is connected locally. Platform verification must succeed before secure access is enabled." : cloudflare.publicUrl ? `<a href="${escapeHtml(cloudflare.publicUrl)}" target="_blank" rel="noopener">${escapeHtml(cloudflare.publicUrl)}</a>` : escapeHtml(cloudflare.lastError || "Cloudflare is not connected."); $("#cloudflare-result").innerHTML = resultText; $("#cloudflare-result").classList.toggle("hidden", verified); $("#cloudflare-setup-form").classList.toggle("hidden", localConnected || !setupAllowed || ["RECONNECT_REQUIRED", "RECONNECTING", "HELD"].includes(recoveryState)); $("#disconnect-cloudflare").classList.toggle("hidden", localConnected || !cloudflare.configured); $("#cloudflare-reverify").classList.toggle("hidden", !(verified && localConnected)); const progress = $("#cloudflare-setup-progress"); const active = !verified && (localConnected || (setup.state && !["idle"].includes(setup.state))); progress.classList.toggle("hidden", !active || !setupAllowed); $("#cloudflare-setup-message").textContent = platformState === "PLATFORM_REPORT_FAILED" ? "The local tunnel is still available. Retry the signed Platform verification." : platformState === "PLATFORM_REPORT_PENDING" ? "Waiting for Platform to verify the signed CloudURL report…" : setup.error || (setup.state === "authorized" ? "Cloudflare authorization complete. Finish creating the tunnel on this Pi." : setup.authUrl ? "Cloudflare authorization is ready. Open the authorization link below." : "The tunnel is connected locally; finish secure Platform verification."); const link = $("#cloudflare-auth-link"); link.classList.toggle("hidden", !setup.authUrl || verified || !setupAllowed); link.href = setup.authUrl || "#"; $("#cloudflare-finish").classList.toggle("hidden", !setupAllowed || verified || !(setup.state === "authorized" || localConnected)); $("#cloudflare-finish").textContent = localConnected ? "Retry secure verification" : "Finish tunnel setup"; const complete = $("#cloudflare-connected-row"); complete.classList.toggle("hidden", !verified); $("#cloudflare-connected-detail").textContent = cloudflare.hostname || cloudflare.publicUrl || "Cloudflare is protecting this hub."; }
function renderProvisioning(value) { state.provisioning = value; const paired = Boolean(value?.platform?.paired); const pairing = value?.pairing || {}; $("#provisioning-badge").textContent = paired ? "Platform paired" : pairing.state === "active" ? "Code active" : "Locked"; $("#provisioning-status").textContent = paired ? `Paired with ${value.platform.apiUrl || "Dinodia platform"}. The machine credential is held by this hub and is never shown here.` : `Hub serial: ${value?.identity?.serial || "pending"}. Open the private /setup page to generate a 15-minute code, then redeem it from the authenticated Company Portal.`; $("#provisioning-status").classList.remove("hidden"); $("#provisioning-values").classList.add("hidden"); $("#pair-form").classList.toggle("hidden", paired); const complete = $("#provisioning-complete-row"); complete.classList.toggle("hidden", !paired); $("#provisioning-complete-detail").textContent = paired ? `Connected to ${value.platform.apiUrl || "the Dinodia platform"}.` : "No machine credential or household data is exposed on this locked surface."; $("#permit-join").disabled = !paired; $("#commission-matter").disabled = !paired; $("#zigbee-help").textContent = paired ? "Hub provisioned. Select a Zigbee coordinator, then open pairing." : "Complete the authenticated Company Portal pairing before adding devices."; }
function renderAlexa(value = state.alexa || {}) { state.alexa = value; const enabled = value.enabled !== false; const linked = Boolean(value.linked); const available = value.available !== false && enabled; const linkingUrl = value.connectUrl || value.skillUrl; const status = linked ? "Linked" : available ? "Not linked" : "Available after pairing"; $("#alexa-status-badge").textContent = status; $("#alexa-status-message").textContent = linked ? "Alexa is connected to this home." : available ? "Connect Alexa to control Dinodia devices by voice." : "Pair this hub with Dinodia platform to enable Alexa."; $("#alexa-connected-detail").textContent = value.errorCode ? `Last sync issue: ${value.errorCode}. Refresh after the hub is paired.` : linked ? "Only live, safe capabilities from Dinodia OS are published." : "No Alexa credentials are stored on the hub; account linking is completed in the Dinodia Alexa skill."; $("#alexa-endpoint-count").textContent = Number(value.endpointCount || 0); $("#alexa-connect").classList.toggle("hidden", !available || linked); $("#alexa-open-skill").classList.toggle("hidden", !linkingUrl); $("#alexa-refresh").disabled = !available; $("#alexa-disconnect").classList.toggle("hidden", !linked); $("#alexa-result").textContent = linked ? "Alexa will receive catalogue updates as devices and capabilities change." : (value.paired ? "Ready to start Alexa account linking." : "Alexa is waiting for this hub to be paired with Dinodia platform."); $("#alexa-connected-row").classList.toggle("hidden", !linked); $("#alexa-last-sync").textContent = value.lastSuccessfulSyncAt ? `Last catalogue sync: ${new Date(value.lastSuccessfulSyncAt).toLocaleString()}` : "Device catalogue will appear after linking."; const openSkill = $("#alexa-open-skill"); openSkill.onclick = () => { if (linkingUrl) window.open(linkingUrl, "_blank", "noopener"); }; }
async function loadAlexaStatus() { try { renderAlexa(await api("/api/integrations/alexa")); } catch { renderAlexa({ available: false, enabled: false, status: "unavailable", linked: false, endpointCount: 0 }); } }
function activityDevice(record) { return record.device?.name || record.device?.id || record.deviceId || "Hub"; }
function activityRecordDeviceId(record) { return String(record.device?.id || record.deviceId || "hub"); }
function activityArea(record) { return record.area?.name || record.device?.areaName || "—"; }
function activityTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" }); }
function activityIntegrationName(value) { const key = String(value || "integration").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"); const names = { zigbee2mqtt: "Zigbee services", zigbee: "Zigbee services", matter: "Matter services", thread: "Thread services", otbr: "Thread Border Router services", hive: "Hive services", google_nest: "Google Nest services", cloudflare: "Secure access services", platform: "Dinodia platform services", ethernet: "Ethernet services" }; if (names[key]) return names[key]; return `${key.split("_").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Integration"} services`; }
function activityDuration(firstObservedAt, lastObservedAt) { const first = Date.parse(firstObservedAt || ""); const last = Date.parse(lastObservedAt || ""); if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return "an extended period"; const minutes = Math.max(1, Math.floor((last - first) / 60000)); if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`; const hours = Math.floor(minutes / 60); const remainingMinutes = minutes % 60; return `${hours} hour${hours === 1 ? "" : "s"}${remainingMinutes ? ` ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}` : ""}`; }
function friendlyActivityRecord(record) { const details = record.incident?.details && typeof record.incident.details === "object" ? record.incident.details : {}; const integration = record.integration || record.change?.integration || details.integration || "integration"; const service = activityIntegrationName(integration); const first = record.incident?.firstObservedAt || record.occurredAt; const last = record.incident?.lastObservedAt || record.updatedAt || record.occurredAt; const duration = activityDuration(first, last); const oldIntegration = String(record.summary || "").trim().toLowerCase() === "integration has stayed offline"; if (record.type === "integration_offline" || oldIntegration) return { summary: `${service} have been offline for over ${duration}`, detail: `${service} have been offline for over ${duration}. Dinodia OS is reporting this because the service has not recovered.` }; if (record.type === "device_offline_incident" || String(record.summary || "").trim().toLowerCase() === "device has stayed offline") { const device = activityDevice(record); return { summary: `${device} has been offline for over ${duration}`, detail: `${device} has been offline for over ${duration}. Check that it has power and can reach the ${record.device?.protocol || "smart home"} network.` }; } if (String(record.summary || "").trim().toLowerCase() === "device removal failed") return { summary: "Could not remove device", detail: `Dinodia OS could not completely remove ${activityDevice(record)}. Try removing it again from Devices & entities.` }; return { summary: record.summary || String(record.type || "Activity").replaceAll("_", " "), detail: record.detail || "" }; }
function activityChange(record) {
  const change = record.change;
  if (!change) return "—";
  if (typeof change === "string") return change;
  if (change.field && Object.prototype.hasOwnProperty.call(change, "before")) return `${change.field}: ${change.before ?? "—"} → ${change.after ?? "—"}`;
  if (change.fields && Array.isArray(change.fields)) return change.fields.map((item) => `${item.field}: ${item.before ?? "—"} → ${item.after ?? "—"}`).join(" · ");
  if (Array.isArray(change)) return change.map((item) => item.field || item.entityId || "change").join(", ");
  if (change.integration) return `${activityIntegrationName(change.integration)}: ${change.state === "offline" ? "offline" : change.state === "online" ? "online" : "changed"}`;
  return Object.keys(change).slice(0, 3).join(", ") || "Updated";
}
function renderActivity(records = state.activity.records) {
  const rows = $("#activity-rows");
  if (!rows) return;
  const visibleRecords = state.activity.expanded ? records : records.slice(0, 10);
  rows.innerHTML = visibleRecords.length ? visibleRecords.map((record) => {
    const severity = escapeHtml(record.severity || "info");
    const status = escapeHtml(record.statusLabel || record.severity || "info");
    const protocol = record.device?.protocol ? ` · ${record.device.protocol}` : "";
    const friendly = friendlyActivityRecord(record);
    return `<tr data-severity="${severity}"><td class="activity-time">${escapeHtml(activityTime(record.occurredAt || record.timestamp))}</td><td><span class="activity-status activity-status-${severity}">${status}</span></td><td class="activity-device"><strong>${escapeHtml(activityDevice(record))}</strong><small>${escapeHtml(protocol.replace(/^ · /, ""))}</small></td><td class="activity-area">${escapeHtml(activityArea(record))}</td><td class="activity-summary"><strong>${escapeHtml(friendly.summary)}</strong><small>${escapeHtml(friendly.detail)}</small></td><td class="activity-change" title="${escapeHtml(activityChange(record))}">${escapeHtml(activityChange(record))}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="activity-empty">Your hub activity will appear here.</td></tr>`;
  $("#activity-count").textContent = state.activity.expanded ? `${records.length} record${records.length === 1 ? "" : "s"}` : `${visibleRecords.length}${records.length > visibleRecords.length ? ` of ${records.length}` : ""} record${visibleRecords.length === 1 ? "" : "s"}`;
  $("#activity-expand").classList.toggle("hidden", !state.activity.expanded && !state.activity.hasMore && records.length <= 10);
  $("#activity-expand").textContent = state.activity.expanded ? "Show latest 10" : "Show all activity";
  $("#activity-load-older").classList.toggle("hidden", !state.activity.expanded || !state.activity.hasMore);
}
function renderActivityFilters(filters = {}) {
  const select = $("#activity-device-filter");
  if (!select) return;
  const current = state.activity.deviceId;
  select.innerHTML = `<option value="">All devices and hub</option>${(filters.devices || []).map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name || device.id)}</option>`).join("")}`;
  select.value = [...(filters.devices || []).map((device) => device.id), ""].includes(current) ? current : "";
}
async function loadActivity({ reset = true } = {}) {
  const params = new URLSearchParams({ limit: state.activity.expanded ? "50" : "10" });
  if (!reset && state.activity.nextCursor) params.set("before", state.activity.nextCursor);
  if (state.activity.deviceId) params.set("deviceId", state.activity.deviceId);
  if (state.activity.category) params.set("category", state.activity.category);
  const result = await api(`/api/activity?${params.toString()}`);
  if (reset) state.activity.records = result.records || [];
  else state.activity.records = [...state.activity.records, ...(result.records || [])];
  state.activity.nextCursor = result.nextCursor || null;
  state.activity.hasMore = Boolean(result.hasMore);
  renderActivityFilters(result.filters || {});
  renderActivity();
}
async function toggleActivityExpanded() {
  state.activity.expanded = !state.activity.expanded;
  if (state.activity.expanded && state.activity.records.length <= 10 && state.activity.hasMore) await loadActivity({ reset: true });
  else renderActivity();
}
function activityMatches(record) { return (!state.activity.deviceId || activityRecordDeviceId(record) === state.activity.deviceId) && (!state.activity.category || String(record.category || "") === state.activity.category); }
function setActivityLiveStatus(online) { const status = $("#activity-live-status"); if (!status) return; status.textContent = online ? "Live" : "Reconnecting"; status.classList.toggle("offline", !online); }
let pairingRefreshTimer;
function renderPairingStatus(pairing = {}) {
  const summary = window.DinodiaPairing.summary(pairing);
  const session = summary.session;
  const deviceLine = (device) => `<span>${escapeHtml(device.name || device.deviceId)}${device.manufacturer || device.model ? ` · ${escapeHtml([device.manufacturer, device.model].filter(Boolean).join(" "))}` : ""}</span>`;
  const found = summary.foundDevices.map(deviceLine).join("");
  const setup = summary.needsSetup.map(deviceLine).join("");
  const joinWindowOpen = session ? session.permitJoinOpen !== false : false;
  $("#pairing-badge").textContent = session ? joinWindowOpen ? "Pairing active" : "Join window closed" : summary.setupCount ? `${summary.setupCount} device${summary.setupCount === 1 ? "" : "s"} to set up` : "Ready when provisioned";
  $("#stop-pairing").classList.toggle("hidden", !session);
  $("#zigbee-pairing-progress").classList.toggle("hidden", !session && !summary.setupCount);
  if (session || summary.setupCount) $("#zigbee-pairing-progress").innerHTML = `${session ? `<strong>${joinWindowOpen ? "Pairing is open" : "The Zigbee join window is closed"}</strong><span>${joinWindowOpen ? `Found ${(session.found || []).length} new device(s). Keep the device nearby while it joins.` : `Found ${(session.found || []).length} new device(s). The radio is no longer accepting new joins; any device already joining remains tracked for review.`}</span>${found ? `<div class="pairing-devices"><strong>Discovered</strong>${found}</div>` : ""}` : ""}${summary.setupCount ? `<strong>${summary.setupCount} device${summary.setupCount === 1 ? "" : "s"} ready for assignment</strong><span>Open Devices & entities below to choose one area and one label.</span>${setup ? `<div class="pairing-devices"><strong>Ready</strong>${setup}</div>` : ""}` : ""}`;
  if (session && !pairingRefreshTimer) pairingRefreshTimer = setInterval(load, 2000);
  if (!session && pairingRefreshTimer) { clearInterval(pairingRefreshTimer); pairingRefreshTimer = null; }
}
function hiveErrorMessage(error) {
  const messages = {
    invalid_username: "Hive did not recognise that account email.",
    invalid_password: "Hive did not accept that password.",
    invalid_mfa_code: "That Hive verification code was not accepted.",
    internet_unavailable: "Hive could not be reached. Check the hub internet connection and try again.",
    authentication_rate_limited: "Hive sign-in is temporarily paused after failed attempts. Try again later.",
    reauth_required: "Hive needs the account to be connected again.",
    setup_session_expired: "The Hive setup session expired. Start the connection again.",
    account_already_connected: "Disconnect the current Hive account before connecting a different account.",
    secure_transport_required: "Use the secure Cloudflare dashboard for Hive credentials.",
    disconnect_failed: "Hive could not confirm remote removal. Confirm local removal only if you want to continue.",
  };
  return messages[error?.code] || error?.message || "Hive could not complete that request.";
}
function hiveAuthDialog(showMfa = false, action = "connect") {
  const dialog = $("#hive-auth-dialog");
  if (!dialog) return;
  state.hiveAuth.action = action;
  $("#hive-auth-title").textContent = action === "reauthenticate" ? "Reconnect Hive account" : showMfa ? "Verify Hive account" : "Connect Hive account";
  $("#hive-auth-copy").textContent = showMfa ? "Enter the one-time SMS code sent by Hive." : "Use the homeowner's Hive account owner credentials.";
  $("#hive-credentials-form").classList.toggle("hidden", showMfa);
  $("#hive-mfa-form").classList.toggle("hidden", !showMfa);
  $("#hive-auth-error").classList.add("hidden");
  if (!dialog.open) dialog.showModal();
  (showMfa ? $("#hive-mfa-code") : $("#hive-email")).focus();
}
function clearHiveAuthInputs() { $("#hive-email").value = ""; $("#hive-password").value = ""; $("#hive-mfa-code").value = ""; }
function showHiveAuthError(error) { const output = $("#hive-auth-error"); output.textContent = hiveErrorMessage(error); output.classList.remove("hidden"); }
async function cancelHiveAuth() {
  const sessionId = state.hiveAuth.sessionId;
  state.hiveAuth.sessionId = "";
  clearHiveAuthInputs();
  if (sessionId) await api(`/api/integrations/hive/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
  $("#hive-auth-dialog").close();
  await loadHiveStatus();
}
function renderHive(status = state.hive || {}) {
  state.hive = status || {};
  const configured = Boolean(status.configured);
  const connected = configured && status.status === "connected";
  const needsReauth = status.status === "reauth_required" || status.reauthRequired;
  $("#hive-disconnected-state")?.classList.toggle("hidden", configured && !needsReauth);
  $("#hive-connected-row")?.classList.toggle("hidden", !configured);
  $("#hive-connected-details")?.classList.toggle("hidden", !configured);
  const statusMessage = $("#hive-status-message");
  const statusText = needsReauth ? "Hive needs account reauthentication." : status.status === "degraded" ? "Hive is temporarily unavailable; retrying is bounded." : status.status === "mfa_required" ? "Hive is waiting for SMS verification." : "";
  statusMessage.textContent = statusText;
  statusMessage.classList.toggle("hidden", !statusText);
  $("#hive-connected-state").textContent = connected ? "Connected" : needsReauth ? "Action needed" : String(status.status || "Starting").replaceAll("_", " ");
  $("#hive-connected-detail").textContent = connected ? `${Number(status.heatingDeviceCount || 0)} heating zone${Number(status.heatingDeviceCount || 0) === 1 ? "" : "s"} found · Last updated ${activityTime(status.lastSuccessfulPollAt)}` : needsReauth ? "Reconnect the Hive owner account to restore controls." : "Hive account is configured but not currently connected.";
  $("#hive-account-name").textContent = status.maskedUsername || "Connected Hive owner";
  $("#hive-heating-count").textContent = String(status.heatingDeviceCount || 0);
  $("#hive-hot-water-count").textContent = String(status.hotWaterDeviceCount || 0);
  $("#hive-last-update").textContent = activityTime(status.lastSuccessfulPollAt);
  $("#hive-unsupported").textContent = Number(status.unsupportedProductCount || 0) ? `${status.unsupportedProductCount} other Hive product${Number(status.unsupportedProductCount) === 1 ? "" : "s"} were discovered but kept out of household controls.` : "Hot-water channels are recorded for support but are not published to the current app contract.";
  const ignored = Array.isArray(status.ignoredDeviceSummaries) ? status.ignoredDeviceSummaries : [];
  $("#hive-ignored").innerHTML = ignored.length ? `<strong>Hidden Hive devices</strong>${ignored.map((item) => `<div class="hive-ignored-row"><span>${escapeHtml(item.name || "Hive device")}</span><button class="text-button" data-hive-restore="${escapeHtml(item.cloudId)}" type="button">Restore</button></div>`).join("")}` : "";
  $("#hive-refresh").disabled = !connected;
  $("#hive-reauthenticate").classList.toggle("hidden", !configured);
  $("#hive-disconnect").disabled = !configured;
  document.querySelectorAll("[data-hive-restore]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { await api(`/api/integrations/hive/ignored/${encodeURIComponent(button.dataset.hiveRestore)}`, { method: "DELETE" }); await loadHiveStatus(); await refreshDevices(); } catch (error) { button.disabled = false; showNotice(hiveErrorMessage(error), "error"); } }));
}
async function loadHiveStatus() { try { renderHive(await api("/api/integrations/hive")); } catch { /* Hive is optional and never blocks the rest of the dashboard. */ } }
function ensureGoogleNestUi() {
  const tabs = document.querySelector(".pairing-tabs");
  if (!tabs || document.querySelector("[data-pairing-tab=google-nest]")) return;
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.dataset.pairingTab = "google-nest";
  tab.type = "button";
  tab.textContent = "Google Nest";
  tabs.appendChild(tab);
  const pane = document.createElement("div");
  pane.id = "google-nest-pairing";
  pane.className = "pairing-pane hidden";
  pane.innerHTML = `<div id="google-nest-operator-config" class="google-nest-config"><div><strong>Operator setup</strong><p class="helper">Complete the Google setup below, then enter the three values once. The client secret is sent only over this secure dashboard and saved in the Pi's encrypted vault.</p></div><div class="google-nest-setup-guide" aria-label="Google Nest setup instructions"><strong>Set up Google Nest in four steps</strong><ol><li><strong>Step 1 — Start a Device Access project.</strong> Open the <a href="https://console.nest.google.com/device-access/project-list" target="_blank" rel="noopener noreferrer">Google Device Access project list</a>. Register with the correct consumer Google account, accept the Sandbox terms and complete Google's registration. Keep this page open while you create the OAuth credentials.</li><li><strong>Step 2 — Create OAuth credentials.</strong> Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud credentials</a>. Select the Google Cloud project used for Smart Device Management, enable the Smart Device Management API if needed, then create an <em>OAuth 2.0 Client ID → Web application</em>. Add the exact callback shown below as an authorised redirect URI. Copy the client ID and client secret, and download the credentials JSON. Do not use an API key or service-account secret.</li><li><strong>Step 3 — Finish the Device Access project.</strong> Return to the Device Access project list, choose <strong>Create project</strong> or open the project you started, attach the OAuth client ID from Step 2, and copy the UUID-style <strong>Device Access project ID</strong>. It is different from the Google Cloud project ID.</li><li><strong>Step 4 — Save the values here.</strong> Enter the Device Access project UUID, the OAuth client ID ending in <code>.apps.googleusercontent.com</code>, and the client secret below. Never send the secret in chat or store it in source control.</li></ol><p class="helper">The same Google account must own the Device Access project and the Nest home. Google may require a one-time Device Access registration fee before a project can be created.</p></div><form id="google-nest-config-form" class="google-nest-config-form"><label><span>Device Access project ID</span><input id="google-nest-device-access-project" name="deviceAccessProjectId" autocomplete="off" spellcheck="false" required></label><label><span>OAuth client ID</span><input id="google-nest-oauth-client-id" name="oauthClientId" autocomplete="off" spellcheck="false" placeholder="…apps.googleusercontent.com" required></label><label><span>OAuth client secret</span><input id="google-nest-oauth-client-secret" name="oauthClientSecret" type="password" autocomplete="new-password" required></label><p class="helper google-nest-callback-copy">Authorised redirect URI: <code id="google-nest-callback-uri">Configure the Cloudflare hostname first</code></p><div class="google-nest-config-actions"><button id="google-nest-config-save" class="primary" type="submit">Save encrypted credentials</button></div><p id="google-nest-config-message" class="helper hidden" role="status"></p></form></div><div id="google-nest-disconnected-state" class="hive-intro google-nest-intro"><div><strong>Connect the homeowner's Google Nest account</strong><p class="helper">Use Google's secure sign-in to grant Dinodia OS access to the home's Nest thermostats. Google Home, schedules, and the physical thermostat stay in place.</p><p class="helper">No Google password, model number, radio dongle, or thermostat reset is required. This pilot supports thermostat heating controls only.</p></div><button id="google-nest-connect" class="primary" type="button">Connect Google Nest account</button></div><div id="google-nest-status-message" class="pairing-progress hidden" role="status"></div><div id="google-nest-auth-fallback" class="google-nest-auth-fallback hidden"><span>Waiting for Google authorization…</span><a id="google-nest-auth-link" href="#" target="_blank" rel="noopener noreferrer">Open Google authorization</a><button id="google-nest-auth-cancel" class="text-button" type="button">Cancel</button></div><div id="google-nest-connected-row" class="setup-complete-row google-nest-connected-row hidden" role="status"><span class="setup-complete-icon">N</span><span class="setup-complete-copy"><strong>Google Nest connected</strong><small id="google-nest-connected-detail">Thermostats are being discovered.</small></span><span id="google-nest-connected-state" class="setup-complete-state">Connected</span></div><details id="google-nest-connected-details" class="hive-details hidden"><summary>Google Nest account details</summary><div class="hive-detail-grid"><div><span>Thermostats</span><strong id="google-nest-thermostat-count">0</strong></div><div><span>Unsupported devices</span><strong id="google-nest-unsupported-count">0</strong></div><div><span>Hidden thermostats</span><strong id="google-nest-ignored-count">0</strong></div><div><span>Last update</span><strong id="google-nest-last-update">—</strong></div></div><p id="google-nest-release" class="helper"></p><div id="google-nest-ignored" class="hive-ignored"></div><div class="hive-actions"><button id="google-nest-refresh" class="secondary" type="button">Refresh Google Nest</button><button id="google-nest-reauthenticate" class="secondary" type="button">Reconnect account</button><button id="google-nest-disconnect" class="danger" type="button">Disconnect Google Nest</button></div></details><p id="google-nest-help" class="helper">Google Nest is an official SDM cloud connection. The hub must use the secure Cloudflare hostname and the Dinodia operator must have enabled the Sandbox beta credentials.</p></div>`;
  const hive = document.querySelector("#hive-pairing");
  (hive?.parentElement || document.querySelector("#pairing-section"))?.insertBefore(pane, hive?.nextSibling || null);
}
function googleNestErrorMessage(error) {
  const messages = { google_nest_not_configured: "Google Nest is not enabled on this hub yet.", google_nest_config_invalid: "Check the Device Access project ID, OAuth client ID, and client secret.", secure_cloudflare_required: "Open the Dinodia OS dashboard through its secure Cloudflare hostname before configuring or connecting Google Nest.", account_already_connected: "Disconnect the current Google Nest account before changing operator credentials.", oauth_state_invalid: "The Google authorization expired or was already used. Start again.", oauth_access_denied: "Google Nest authorization was cancelled.", reauth_required: "Google Nest authorization needs to be reconnected.", google_nest_api_unavailable: "Google Nest is temporarily unavailable. Try again shortly.", disconnect_failed: "Google Nest could not confirm remote access removal. Choose local-only removal only if you understand the account may still be authorized." };
  return messages[error?.code] || error?.message || "Google Nest setup failed.";
}
function stopGoogleNestAuth() { if (state.googleNestAuth.timer) clearInterval(state.googleNestAuth.timer); state.googleNestAuth.timer = null; state.googleNestAuth.sessionId = ""; state.googleNestAuth.popup = null; }
function renderGoogleNest(status = state.googleNest || {}) {
  state.googleNest = status || {};
  const configured = Boolean(status.configured);
  const operatorConfigured = Boolean(status.operatorConfigured);
  const connected = configured && status.status === "connected";
  const needsReauth = configured && (status.status === "reauth_required" || status.reauthRequired);
  const button = $("#google-nest-connect");
  if (!button) return;
  $("#google-nest-operator-config")?.classList.toggle("hidden", operatorConfigured && !state.googleNestConfigEditing);
  const callbackUri = status.callbackUri || "Configure the Cloudflare hostname first";
  $("#google-nest-callback-uri").textContent = callbackUri;
  $("#google-nest-disconnected-state")?.classList.toggle("hidden", !operatorConfigured || connected);
  $("#google-nest-connected-row")?.classList.toggle("hidden", !configured);
  $("#google-nest-connected-details")?.classList.toggle("hidden", !configured);
  $("#google-nest-connected-state").textContent = connected ? "Connected" : needsReauth ? "Action needed" : String(status.status || "Starting").replaceAll("_", " ");
  $("#google-nest-connected-detail").textContent = connected ? `${Number(status.thermostatDeviceCount || 0)} thermostat${Number(status.thermostatDeviceCount || 0) === 1 ? "" : "s"} found · Last updated ${activityTime(status.lastSuccessfulPollAt)}` : needsReauth ? "Reconnect the Google owner account to restore controls." : "Google Nest is configured but is not currently connected.";
  $("#google-nest-thermostat-count").textContent = String(status.thermostatDeviceCount || 0);
  $("#google-nest-unsupported-count").textContent = String(status.unsupportedDeviceCount || 0);
  $("#google-nest-ignored-count").textContent = String(status.ignoredDeviceCount || 0);
  $("#google-nest-last-update").textContent = activityTime(status.lastSuccessfulPollAt);
  $("#google-nest-release").textContent = `Release channel: ${String(status.releaseChannel || "sandbox_beta").replaceAll("_", " ")}. Unsupported products are ignored and no camera or media access is requested.`;
  const message = $("#google-nest-status-message");
  const explanation = !operatorConfigured ? "Google Nest is unavailable until the Dinodia operator configures the encrypted Sandbox credentials." : needsReauth ? "Google Nest needs authorization again." : "";
  message.textContent = explanation;
  message.classList.toggle("hidden", !explanation);
  button.textContent = needsReauth ? "Reconnect Google Nest account" : "Connect Google Nest account";
  button.disabled = !operatorConfigured || (configured && connected);
  $("#google-nest-reauthenticate").classList.toggle("hidden", !configured);
  $("#google-nest-refresh").disabled = !connected;
  $("#google-nest-disconnect").disabled = !configured;
  const ignored = Array.isArray(status.ignoredDevices) ? status.ignoredDevices : [];
  $("#google-nest-ignored").innerHTML = ignored.length ? `<strong>Hidden Google Nest thermostats</strong>${ignored.map((item) => `<div class="hive-ignored-row"><span>${escapeHtml(item.name || "Google Nest thermostat")}</span><button class="text-button" data-google-nest-restore="${escapeHtml(item.identityHash)}" type="button">Restore</button></div>`).join("")}` : "";
  document.querySelectorAll("[data-google-nest-restore]").forEach((restore) => restore.addEventListener("click", async () => { restore.disabled = true; try { await api(`/api/integrations/google-nest/ignored/${encodeURIComponent(restore.dataset.googleNestRestore)}`, { method: "DELETE" }); await loadDashboard(); } catch (error) { restore.disabled = false; showNotice(googleNestErrorMessage(error), "error"); } }));
}
async function loadGoogleNestStatus() { try { renderGoogleNest(await api("/api/integrations/google-nest")); } catch { /* Google Nest is optional and must not block the core dashboard. */ } }
async function submitGoogleNestConfig(event) {
  event.preventDefault();
  const projectId = $("#google-nest-device-access-project").value.trim();
  const clientId = $("#google-nest-oauth-client-id").value.trim();
  const clientSecret = $("#google-nest-oauth-client-secret").value;
  const save = $("#google-nest-config-save");
  const message = $("#google-nest-config-message");
  save.disabled = true;
  message.textContent = "Saving encrypted credentials…";
  message.classList.remove("hidden");
  try {
    await api("/api/integrations/google-nest/configure", { method: "POST", body: JSON.stringify({ deviceAccessProjectId: projectId, oauthClientId: clientId, oauthClientSecret: clientSecret }) });
    state.googleNestConfigEditing = false;
    $("#google-nest-oauth-client-secret").value = "";
    await loadGoogleNestStatus();
    showNotice("Google Nest Sandbox credentials saved securely. Connect the homeowner account next.");
  } catch (error) {
    message.textContent = googleNestErrorMessage(error);
    showNotice(googleNestErrorMessage(error), "error");
  } finally {
    $("#google-nest-oauth-client-secret").value = "";
    save.disabled = false;
  }
}
async function startGoogleNestAuth() {
  const popup = window.open("about:blank", "dinodia-google-nest");
  try {
    const result = await api("/api/integrations/google-nest/connect", { method: "POST", body: "{}" });
    state.googleNestAuth.sessionId = result.sessionId;
    state.googleNestAuth.popup = popup;
    $("#google-nest-auth-fallback").classList.remove("hidden");
    $("#google-nest-auth-link").href = result.authorizationUrl;
    if (popup && !popup.closed) popup.location.href = result.authorizationUrl;
    state.googleNestAuth.timer = setInterval(async () => { await loadGoogleNestStatus(); if (state.googleNest?.status === "connected" || state.googleNest?.status === "reauth_required") stopGoogleNestAuth(); }, 2000);
    renderGoogleNest({ ...(state.googleNest || {}), status: "authorization_pending" });
  } catch (error) { try { popup?.close(); } catch {} showNotice(googleNestErrorMessage(error), "error"); }
}
async function cancelGoogleNestAuth() { const sessionId = state.googleNestAuth.sessionId; stopGoogleNestAuth(); $("#google-nest-auth-fallback")?.classList.add("hidden"); if (sessionId) await api(`/api/integrations/google-nest/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: "{}" }).catch(() => {}); await loadGoogleNestStatus(); }
async function disconnectGoogleNest() {
  const count = Number(state.googleNest?.thermostatDeviceCount || 0);
  if (!confirm(`Disconnect Google Nest and remove ${count} local thermostat${count === 1 ? "" : "s"} from Dinodia OS? The physical Google Nest devices and Google Home account will not be deleted.`)) return;
  try { await api("/api/integrations/google-nest/account", { method: "DELETE", body: "{}" }); await loadDashboard(); showNotice("Google Nest was disconnected from Dinodia OS."); } catch (error) {
    if (error.code === "disconnect_failed" && confirm("Remote Google access could not be confirmed. Remove the account locally anyway?")) { try { await api("/api/integrations/google-nest/account", { method: "DELETE", body: JSON.stringify({ allowLocalOnly: true }) }); await loadDashboard(); showNotice("Google Nest was removed locally. Check Google Partner Connections Manager if remote access still appears."); } catch (localError) { showNotice(googleNestErrorMessage(localError), "error"); } } else showNotice(googleNestErrorMessage(error), "error");
  }
}
async function submitHiveCredentials(event) {
  event.preventDefault();
  const username = $("#hive-email").value.trim();
  const password = $("#hive-password").value;
  const route = state.hiveAuth.action === "reauthenticate" ? "/api/integrations/hive/reauthenticate" : "/api/integrations/hive/connect";
  clearHiveAuthInputs();
  try {
    const result = await api(route, { method: "POST", body: JSON.stringify({ username, password }) });
    if (result.status === "mfa_required") { state.hiveAuth.sessionId = result.sessionId; hiveAuthDialog(true, state.hiveAuth.action); return; }
    $("#hive-auth-dialog").close();
    await load();
    showNotice("Hive account connected. Discovered heating zones are ready for area and Boiler-label setup.");
  } catch (error) { showHiveAuthError(error); }
}
async function submitHiveMfa(event) {
  event.preventDefault();
  const code = $("#hive-mfa-code").value.trim();
  const sessionId = state.hiveAuth.sessionId;
  $("#hive-mfa-code").value = "";
  if (!sessionId) return showHiveAuthError({ code: "setup_session_expired" });
  try { await api(`/api/integrations/hive/sessions/${encodeURIComponent(sessionId)}/mfa`, { method: "POST", body: JSON.stringify({ code }) }); state.hiveAuth.sessionId = ""; $("#hive-auth-dialog").close(); await load(); showNotice("Hive account verified and heating zones discovered. Finish each device setup card."); } catch (error) { showHiveAuthError(error); }
}
async function disconnectHive() {
  const localCount = state.devices.filter((device) => device.protocol === "hive").length || Number(state.hive?.heatingDeviceCount || 0);
  if (!confirm(`Disconnect Hive from Dinodia OS? This removes ${localCount} local Hive device${localCount === 1 ? "" : "s"}, controls, and secrets but does not reset the physical Hive system or its schedules.`)) return;
  try { await api("/api/integrations/hive/account", { method: "DELETE", body: "{}" }); await load(); showNotice("Hive was disconnected from Dinodia OS."); } catch (error) {
    if (error.code === "disconnect_failed" && confirm("Hive remote removal could not be confirmed. Continue with local-only removal?")) { try { await api("/api/integrations/hive/account", { method: "DELETE", body: JSON.stringify({ allowLocalOnly: true }) }); await load(); showNotice("Hive was removed locally. The Hive account and physical devices were not reset."); } catch (localError) { showNotice(hiveErrorMessage(localError), "error"); } }
    else showNotice(hiveErrorMessage(error), "error");
  }
}
function controllerDeviceOption(device, selected = false) {
  return `<option value="${escapeHtml(device.id)}" ${selected ? "selected" : ""}>${escapeHtml(device.name || device.id)} · ${escapeHtml(areaName(device.areaId))} · ${escapeHtml(device.protocol || "device")}</option>`;
}
function controllerStatusTone(model) {
  const tone = String(model?.statusTone || "amber").toLowerCase();
  return ["green", "red", "amber"].includes(tone) ? tone : "amber";
}
function controllerDemandLabel(value) {
  return { calling: "Calling for heat", satisfied: "Satisfied", off: "Off", unknown: "Unknown", unavailable: "Unavailable" }[value] || "Awaiting state";
}
function renderHeatingDemandVerification(verification) {
  if (!verification) return `<div class="controller-verification-empty">Run read-only verification whenever you want to check mappings, provider health and command routes. It never changes a temperature or heating mode.</div>`;
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  return `<div class="controller-verification"><div class="controller-verification-head"><strong>Read-only verification: ${escapeHtml(verification.result || "degraded")}</strong><span>${escapeHtml(verification.checkedAt ? new Date(verification.checkedAt).toLocaleString() : "just now")}</span></div><div class="controller-check-list">${checks.map((check) => `<div class="controller-check controller-check-${escapeHtml(check.result || "warn")}"><span>${check.result === "pass" ? "✓" : check.result === "warn" ? "!" : "×"}</span><div><strong>${escapeHtml(String(check.name || "check").replaceAll("_", " "))}</strong><small>${escapeHtml(check.detail || "")}</small></div></div>`).join("")}</div><p class="subtle small">Writes attempted: <strong>${Number(verification.writesAttempted || 0)}</strong>. Physical actuation verified: <strong>${verification.physicalActuationVerified ? "Yes" : "No"}</strong>.</p></div>`;
}
async function loadHeatingDemandController(model) {
  const result = model || await api("/api/heating-demand-controller");
  state.heatingDemandController = result;
  renderHeatingDemandController(result);
  return result;
}
function heatingDemandFormIsFocused() { return Boolean(document.querySelector("#heating-demand-form")?.matches(":focus-within")); }
function heatingDemandDraftFromForm(form) {
  const values = new FormData(form);
  return {
    enabled: values.get("enabled") === "on",
    boilerDeviceId: String(values.get("boilerDeviceId") || ""),
    radiatorDeviceIds: values.getAll("radiatorDeviceIds").map(String),
    deadbandCelsius: form.elements.deadbandCelsius?.value ?? "",
    requestTemperatureEnabled: values.get("requestTemperatureEnabled") === "on",
    requestTemperatureCelsius: form.elements.requestTemperatureCelsius?.value ?? "",
    radiatorPickerOpen: Boolean(form.querySelector("#heating-demand-radiator-picker")?.open),
  };
}
function rememberHeatingDemandDraft(form) { if (form) state.heatingDemandDraft = heatingDemandDraftFromForm(form); }
function controllerFormConfig(config, candidates) {
  const draft = state.heatingDemandDraft;
  if (!draft) return config;
  const boilerIds = new Set((candidates.boilers || []).map((device) => String(device.id)));
  const radiatorIds = new Set((candidates.radiators || []).map((device) => String(device.id)));
  return {
    ...config,
    enabled: draft.enabled,
    boilerDeviceId: boilerIds.has(draft.boilerDeviceId) ? draft.boilerDeviceId : "",
    radiatorDeviceIds: draft.radiatorDeviceIds.filter((id) => radiatorIds.has(String(id))),
    deadbandCelsius: draft.deadbandCelsius,
    requestTemperatureEnabled: draft.requestTemperatureEnabled,
    requestTemperatureCelsius: draft.requestTemperatureCelsius,
  };
}
function controllerStatusReason(model) {
  const reasons = {
    controller_disabled: "Devices are linked and automatic boiler control is currently off.",
    boiler_or_radiator_mapping_required: "Select one Boiler and at least one Radiator to build the controller mapping.",
    controller_loop_not_running: "The controller loop is starting; automatic decisions are paused until it is running.",
    provider_or_device_unavailable: "A mapped device or its integration is offline, so automatic boiler writes are paused safely.",
    evaluation_failed: "The latest evaluation failed; the controller will retry without changing state blindly.",
    command_retry_backoff: "A boiler command failed, so Dinodia OS is waiting before its next bounded retry.",
    waiting_for_devices: "A ready Boiler and at least one ready Radiator are required.",
    radiator_state_unknown: "Radiator state is not yet readable; the controller will not start the boiler from unknown data.",
    radiator_calling_for_heat: "At least one mapped radiator is requesting heat.",
    no_radiator_calling: "Mapped radiator states are satisfied or off; there is no current heat demand.",
  };
  return reasons[model?.statusReason] || "The controller is monitoring its mapped devices and safety checks.";
}
function controllerHealthNote(model) {
  if (model?.status === "degraded") return "Degraded means a safety check is temporarily holding automatic boiler writes — for example, a provider is offline, state is stale, or a failed command is in its retry window. It does not by itself mean the heating devices are broken.";
  if (model?.status === "error") return "The controller encountered an evaluation error. Automatic writes are paused until a healthy evaluation succeeds.";
  if (model?.status === "linked") return "The devices are linked and readable. Automatic boiler control remains off until you explicitly enable it.";
  if (model?.status === "heating_active") return "A mapped radiator is calling for heat and the controller is following that demand.";
  if (model?.status === "no_demand") return "The controller is healthy and has no current radiator demand.";
  return "Readiness describes the controller safety state; it is separate from whether a physical boiler has been actuation-tested.";
}
function controllerRadiatorSummary(devices) {
  if (!devices.length) return `<span class="controller-selection-empty">No radiators selected</span>`;
  const visible = devices.slice(0, 3).map((device) => `<span class="controller-selection-chip">${escapeHtml(device.name || device.id)}</span>`).join("");
  const more = devices.length > 3 ? `<span class="controller-selection-more">+${devices.length - 3} more</span>` : "";
  return `${visible}${more}`;
}
async function saveHeatingDemandControllerConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  rememberHeatingDemandDraft(form);
  const values = new FormData(form);
  const enabled = values.get("enabled") === "on";
  if (enabled && !confirm("Enable automatic heating control? Dinodia OS may send heat/off commands to the mapped boiler when radiator demand changes.")) return;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/heating-demand-controller/config", { method: "PUT", body: JSON.stringify({ enabled, boilerDeviceId: values.get("boilerDeviceId") || null, radiatorDeviceIds: values.getAll("radiatorDeviceIds"), deadbandCelsius: Number(values.get("deadbandCelsius")), requestTemperatureEnabled: values.get("requestTemperatureEnabled") === "on", requestTemperatureCelsius: Number(values.get("requestTemperatureCelsius")) }) });
    state.heatingDemandDraft = null;
    renderHeatingDemandController(result, true);
    await load();
    showNotice(enabled ? "Heating demand controller enabled." : "Heating demand controller saved and disabled.");
  } catch (error) { button.disabled = false; showNotice(error.message, "error"); }
}
async function runHeatingDemandReadOnlyVerification(event) {
  event.currentTarget.disabled = true;
  try { await api("/api/heating-demand-controller/verify", { method: "POST", body: "{}" }); await load(); renderHeatingDemandController(state.heatingDemandController, true); showNotice("Read-only verification completed. No climate commands were sent."); } catch (error) { event.currentTarget.disabled = false; showNotice(error.message, "error"); }
}
async function runHeatingDemandEvaluation(event) {
  if (!confirm("Evaluate now and allow the controller to apply its current heat/off decision to the mapped boiler?")) return;
  event.currentTarget.disabled = true;
  try { await api("/api/heating-demand-controller/evaluate", { method: "POST", body: JSON.stringify({ execute: true }) }); await load(); renderHeatingDemandController(state.heatingDemandController, true); showNotice("Heating demand was evaluated."); } catch (error) { event.currentTarget.disabled = false; showNotice(error.message, "error"); }
}
function renderHeatingDemandController(model = state.heatingDemandController || {}, force = false) {
  const target = $("#heating-demand-controller");
  const badge = $("#heating-demand-status");
  if (!target) return;
  state.heatingDemandController = model;
  const statusLabel = model.statusLabel || "Waiting for devices";
  if (badge) { badge.textContent = statusLabel; badge.className = `controller-status-badge controller-status-${controllerStatusTone(model)}`; }
  if (heatingDemandFormIsFocused() && !force) return;
  const candidates = model.candidates || { boilers: [], radiators: [] };
  const config = controllerFormConfig(model.config || {}, candidates);
  const selectedRadiators = new Set((config.radiatorDeviceIds || []).map(String));
  const radiatorStates = new Map((model.radiators || []).map((item) => [String(item.id), item]));
  const boiler = model.boiler;
  const verification = model.verification;
  const selectedRadiatorDevices = candidates.radiators.filter((device) => selectedRadiators.has(String(device.id)));
  const pickerOpen = Boolean(state.heatingDemandDraft?.radiatorPickerOpen);
  const mappedCalling = (model.radiators || []).filter((item) => item.demand === "calling").length;
  const mappedUnknown = (model.radiators || []).filter((item) => ["unknown", "unavailable"].includes(item.demand)).length;
  const unsaved = Boolean(state.heatingDemandDraft);
  target.innerHTML = `<div class="controller-status-line"><div><strong>${escapeHtml(statusLabel)}</strong><span>${escapeHtml(controllerStatusReason(model))}</span></div><span class="controller-demand-pill">${escapeHtml(model.runtime?.currentDemand === "not_configured" ? "Not configured" : controllerDemandLabel(model.runtime?.currentDemand))}</span></div><div class="controller-health-note controller-health-${controllerStatusTone(model)}"><strong>Controller health</strong><span>${escapeHtml(controllerHealthNote(model))}</span></div><form id="heating-demand-form" class="controller-form" autocomplete="off"><div class="controller-mapping-grid"><label><span>Boiler</span><select name="boilerDeviceId" ${candidates.boilers.length ? "" : "disabled"}><option value="">Choose a Boiler</option>${candidates.boilers.map((device) => controllerDeviceOption(device, String(config.boilerDeviceId || "") === String(device.id))).join("")}</select><small>One device with the Boiler label and a climate control surface.</small></label><fieldset class="controller-radiator-fieldset"><legend>Radiators <em>${selectedRadiatorDevices.length} selected · ${candidates.radiators.length} available</em></legend><div class="controller-selection-summary">${controllerRadiatorSummary(selectedRadiatorDevices)}</div><details id="heating-demand-radiator-picker" class="controller-radiator-picker" ${pickerOpen ? "open" : ""}><summary>Choose radiators <span>${selectedRadiatorDevices.length ? "Change selection" : "Select devices"}</span></summary><div class="controller-radiator-list">${candidates.radiators.length ? candidates.radiators.map((device) => { const item = radiatorStates.get(String(device.id)); return `<label class="controller-radiator-option"><input type="checkbox" name="radiatorDeviceIds" value="${escapeHtml(device.id)}" ${selectedRadiators.has(String(device.id)) ? "checked" : ""}><span><strong>${escapeHtml(device.name || device.id)}</strong><small>${escapeHtml(areaName(device.areaId))} · ${escapeHtml(item ? controllerDemandLabel(item.demand) : "Awaiting evaluation")}</small></span></label>`; }).join("") : `<span class="subtle small">No ready climate devices labelled Radiator.</span>`}</div></details><small>Keep the picker collapsed for a compact view. It scrolls internally when a home has many radiators.</small></fieldset></div><div class="controller-settings-grid"><label class="controller-switch"><input type="checkbox" name="enabled" ${config.enabled ? "checked" : ""}><span><strong>Enable automatic boiler control</strong><small>When enabled, a calling radiator requests heat and satisfied demand releases it.</small></span></label><label><span>Deadband (°C)</span><input name="deadbandCelsius" type="number" min="0.1" max="2" step="0.1" value="${escapeHtml(config.deadbandCelsius ?? 0.3)}"><small>Heat starts when target is at least this far above current.</small></label><label><span>Request boiler temperature (°C)</span><input name="requestTemperatureCelsius" type="number" min="5" max="35" step="0.5" value="${escapeHtml(config.requestTemperatureCelsius ?? 30)}"><small>Applied only when “Set request temperature” is enabled.</small></label><label class="controller-switch"><input type="checkbox" name="requestTemperatureEnabled" ${config.requestTemperatureEnabled !== false ? "checked" : ""}><span><strong>Set request temperature</strong><small>Keep the boiler request target at the configured value.</small></span></label></div><div class="controller-actions"><button class="primary" type="submit">${unsaved ? "Save changes" : "Save controller"}</button><button class="secondary" id="heating-demand-verify" type="button">Verify read-only</button><button class="text-button" id="heating-demand-evaluate" type="button">Evaluate and control</button></div></form><div class="controller-live-grid"><div><span>Mapped boiler</span><strong>${escapeHtml(boiler?.name || "Not selected")}</strong><small>${escapeHtml(boiler ? `${boiler.mode || "unknown"} · ${boiler.available === false ? "Offline" : "Online"}` : "")}</small></div><div><span>Radiator demand</span><strong>${mappedCalling} calling</strong><small>${(model.radiators || []).length} mapped${mappedUnknown ? ` · ${mappedUnknown} unknown` : ""}</small></div><div><span>Last evaluation</span><strong>${escapeHtml(model.runtime?.lastEvaluationAt ? new Date(model.runtime.lastEvaluationAt).toLocaleString() : "Not evaluated")}</strong><small>${escapeHtml(model.runtime?.lastEvaluationError || "No error")}</small></div></div><details class="controller-verification-details"><summary>Verification and controller diagnostics</summary>${renderHeatingDemandVerification(verification)}</details><p class="controller-safety-note">Read-only verification never sends climate commands. The “Evaluate and control” action is the only manual control action here.</p>`;
  const form = $("#heating-demand-form");
  const requestTargetLabel = form ? [...form.querySelectorAll("label")].find((label) => label.querySelector("input[name=requestTemperatureCelsius]")) : null;
  const requestTargetText = requestTargetLabel?.querySelector(":scope > span");
  const requestTargetHelp = requestTargetLabel?.querySelector("small");
  if (requestTargetText) requestTargetText.textContent = "Target temperature during heat demand (°C)";
  if (requestTargetHelp) requestTargetHelp.textContent = "For Google Nest this is the room target, not boiler water-flow temperature.";
  const requestToggle = form?.querySelector("input[name=requestTemperatureEnabled]")?.closest(".controller-switch");
  const requestToggleTitle = requestToggle?.querySelector("strong");
  const requestToggleHelp = requestToggle?.querySelector("small");
  if (requestToggleTitle) requestToggleTitle.textContent = "Set thermostat target during heat demand";
  if (requestToggleHelp) requestToggleHelp.textContent = "On: set the value below during heat demand. Off: only manage heat/off mode.";
  form?.addEventListener("submit", saveHeatingDemandControllerConfig);
  form?.addEventListener("input", () => rememberHeatingDemandDraft(form));
  form?.addEventListener("change", () => rememberHeatingDemandDraft(form));
  $("#heating-demand-radiator-picker")?.addEventListener("toggle", () => { if (state.heatingDemandDraft) state.heatingDemandDraft.radiatorPickerOpen = $("#heating-demand-radiator-picker").open; });
  $("#heating-demand-verify")?.addEventListener("click", runHeatingDemandReadOnlyVerification);
  $("#heating-demand-evaluate")?.addEventListener("click", runHeatingDemandEvaluation);
}
async function loadDashboard() { try { const [status, devices, areas, labels, provisioning, readiness, pairing, heatingDemandController] = await Promise.all([api("/api/status"), api("/api/devices"), api("/api/areas"), api("/api/labels"), api("/api/provisioning"), api("/api/readiness"), api("/api/integrations/zigbee/pairing"), api("/api/heating-demand-controller")]); window.DinodiaStore.reconcile(state, { devices: devices.devices.filter((device) => !window.DinodiaDevices.isInfrastructureDevice(device)), areas: areas.areas, labels: labels.labels }); renderStatus(status, readiness); renderProvisioning(provisioning); await loadAlexaStatus(); renderAreaControls(); renderAreasDashboard(); renderAreas(); renderLabels(); renderDevices(); await loadUnregisteredPropertyDevices(); window.DinodiaAutomations?.load(); await loadHeatingDemandController(heatingDemandController); await loadActivity({ reset: true }); renderPairingStatus(pairing); await loadMatterPairingStatus(); await loadHiveStatus(); await loadGoogleNestStatus(); await loadAdapters(); await loadThreadAdapters(); showNotice(""); } catch (error) { showNotice(`${error.message}. Open the authenticated Company Portal session and try again.`, "error"); } }
async function loadUnregisteredPropertyDevices() {
  const status = $("#unregistered-property-device-status"); const list = $("#unregistered-property-device-list");
  if (!status || !list) return;
  status.textContent = "Checking eligible local devices…"; list.replaceChildren();
  try {
    const result = await api("/api/commissioning/unregistered-devices");
    const devices = Array.isArray(result.devices) ? result.devices : [];
    if (!devices.length) { status.textContent = "No eligible paired-but-unregistered devices were found in the current Home Areas."; return; }
    status.textContent = `${devices.length} local device${devices.length === 1 ? " is" : "s are"} not registered to this property yet.`;
    for (const device of devices) {
      const card = document.createElement("article"); card.className = "candidate";
      const title = document.createElement("strong"); title.textContent = device.name || "Unidentified local device";
      const detail = document.createElement("p"); detail.className = "muted";
      detail.textContent = [String(device.protocol || "device").toUpperCase(), device.manufacturer, device.model, `Area: ${device.areaName || "Current Home Area"}`, device.available ? "Available" : "Offline"].filter(Boolean).join(" · ");
      const marker = document.createElement("p"); marker.className = "muted"; marker.textContent = "Not registered to this property yet. Confirm the device and its current Area in the assigned installation workflow before adoption.";
      const controls = Array.isArray(device.controls) ? device.controls : [];
      const descriptor = document.createElement("p"); descriptor.className = "muted";
      descriptor.textContent = controls.length ? `Current descriptor: ${controls.map((control) => `${control.name}${control.readable ? " · reading" : ""}${control.writable ? " · control" : " · read-only"}`).join("; ")}` : "No current safe control descriptor is available; registration review will show the truthful device capability status.";
      card.append(title, detail, marker, descriptor); list.append(card);
    }
  } catch (error) {
    status.textContent = error.status === 401 || error.status === 403
      ? "Current assigned Company Portal authority is required to view this Home’s unregistered devices."
      : "The local device list is temporarily unavailable. Refresh after the hub and Company Portal connection recover.";
  }
}
async function loadMatterPairingStatus() { try { const pairing = await api("/api/integrations/matter/pairing"); const needsSetup = Array.isArray(pairing.needsSetup) ? pairing.needsSetup : []; const active = Array.isArray(pairing.active) ? pairing.active : []; const progress = $("#matter-pairing-progress"); if (!active.length && !needsSetup.length) return progress.classList.add("hidden"); progress.classList.remove("hidden"); const line = (device) => `<span>${escapeHtml(device.name || device.deviceId || "Matter device")}${device.manufacturer || device.model ? ` · ${escapeHtml([device.manufacturer, device.model].filter(Boolean).join(" "))}` : ""}</span>`; progress.innerHTML = `${active.length ? `<strong>Matter pairing is active</strong><span>Commissioning is in progress.</span>` : ""}${needsSetup.length ? `<strong>${needsSetup.length} Matter device${needsSetup.length === 1 ? "" : "s"} ready for assignment</strong><span>Open Devices & entities below to choose a name, area and label.</span><div class="pairing-devices">${needsSetup.map(line).join("")}</div>` : ""}`; } catch { /* The main dashboard remains usable if Matter pairing status is unavailable. */ } }
let loadInFlight = null;
let loadQueued = false;
function load() {
  if (operatorAuthorityPaused()) return Promise.resolve();
  if (loadInFlight) { loadQueued = true; return loadInFlight; }
  loadInFlight = loadDashboard().finally(() => {
    const rerun = loadQueued;
    loadQueued = false;
    loadInFlight = null;
    if (rerun) load();
  });
  return loadInFlight;
}
let operatorSessionDeadlineMono = null;
let operatorSessionDeadlineWall = null;
let operatorSessionClockTimer = null;
let operatorSessionPollTimer = null;
let operatorSessionPollInFlight = false;
function renderOperatorSessionDeadline() {
  const banner = $("#operator-session-status");
  if (!banner || operatorSessionDeadlineMono === null) return;
  const remainingSeconds = Math.max(0, Math.ceil((operatorSessionDeadlineMono - performance.now()) / 1000));
  if (remainingSeconds === 0) {
    document.body.classList.remove("operator-authority-unavailable");
    document.body.classList.add("operator-authority-ended");
    banner.dataset.state = "ended";
    banner.textContent = "This Dinodia OS session reached its original 30-minute deadline. Your Company Portal sign-in is separate; deliberately open a new OS session there when you are ready.";
    return;
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  banner.dataset.state = "active";
  banner.textContent = `This OS session ends at ${new Date(operatorSessionDeadlineWall).toLocaleTimeString()} (${minutes}m ${String(seconds).padStart(2, "0")}s remaining). Rechecking authority does not extend it.`;
}
document.addEventListener("dinodia-operator-authority", (event) => {
  const detail = event.detail || {};
  const banner = $("#operator-session-status");
  if (!banner) return;
  banner.classList.remove("hidden");
  if (detail.state === "unavailable") {
    document.body.classList.remove("operator-authority-ended");
    document.body.classList.add("operator-authority-unavailable");
    banner.dataset.state = "unavailable";
    banner.textContent = "Remote authority verification is temporarily unavailable. Protected Home data and actions are hidden/paused; this is not a sign-out or proof that the 30-minute session expired. Keep this window open; Dinodia will retry the same session.";
    return;
  }
  if (detail.state === "ended") {
    document.body.classList.remove("operator-authority-unavailable");
    document.body.classList.add("operator-authority-ended");
    banner.dataset.state = "ended";
    banner.textContent = detail.code === "operator_session_hub_restart"
      ? "The hub restarted and cleared its in-memory operator session. No access is retained; return to Company Portal and deliberately open a new session."
      : detail.code === "operator_session_revoked"
      ? "This OS session was explicitly revoked or its assigned authority changed. Return to Company Portal and review the current assigned work."
      : "This Dinodia OS session ended or was revoked. Your Company Portal sign-in is separate; return there to deliberately open a new OS session if the work is still assigned.";
    if (operatorSessionPollTimer) clearInterval(operatorSessionPollTimer);
    operatorSessionPollTimer = null;
    return;
  }
  if (detail.state !== "active") return;
  const expiresAt = Date.parse(detail.expiresAt);
  const serverNow = Date.parse(detail.serverNow);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(serverNow)) return;
  const wasAuthorityPaused = operatorAuthorityPaused();
  document.body.classList.remove("operator-authority-unavailable", "operator-authority-ended");
  operatorSessionDeadlineWall = expiresAt;
  const remainingMs = Number.isFinite(detail.remainingMs) ? Math.max(0, detail.remainingMs) : Math.max(0, expiresAt - serverNow);
  operatorSessionDeadlineMono = performance.now() + remainingMs;
  banner.classList.remove("hidden");
  renderOperatorSessionDeadline();
  if (operatorSessionClockTimer) clearInterval(operatorSessionClockTimer);
  operatorSessionClockTimer = setInterval(renderOperatorSessionDeadline, 1000);
  if (wasAuthorityPaused) void load();
});
async function refreshOperatorSessionStatus() {
  if (operatorSessionPollInFlight || document.body.classList.contains("operator-authority-ended")) return;
  operatorSessionPollInFlight = true;
  try { await api("/api/operator-session"); } catch { /* The shared API wrapper preserves outage vs terminal state. */ }
  finally { operatorSessionPollInFlight = false; }
}
function startOperatorSessionStatusRefresh() {
  void refreshOperatorSessionStatus();
  if (!operatorSessionPollTimer) operatorSessionPollTimer = setInterval(refreshOperatorSessionStatus, 15000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refreshOperatorSessionStatus(); });
let deviceRefreshInFlight = null;
function deviceEditorHasFocus() { return Boolean(document.activeElement?.closest("#devices .device-editor")); }
function refreshDevices() {
  if (operatorAuthorityPaused()) return Promise.resolve();
  if (deviceEditorHasFocus()) return Promise.resolve();
  if (deviceRefreshInFlight) return deviceRefreshInFlight;
  deviceRefreshInFlight = api("/api/devices").then((devices) => {
    window.DinodiaStore.reconcile(state, { devices: devices.devices.filter((device) => !window.DinodiaDevices.isInfrastructureDevice(device)) });
    renderAreasDashboard();
    renderDevices();
  }).catch(() => {}).finally(() => { deviceRefreshInFlight = null; });
  return deviceRefreshInFlight;
}
let dashboardSocket = null;
let dashboardSocketReconnectTimer = null;
let dashboardSocketAttempt = 0;
function dashboardWebSocketUrl() {
  const selector = sessionStorage.getItem("dinodia.operatorSessionSelector") || location.pathname.match(/^\/_dinodia\/operator\/([A-Za-z0-9_-]{24,64})/)?.[1] || "";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/_dinodia/admin/events/${encodeURIComponent(selector)}`;
}
function scheduleDashboardSocketReconnect() {
  if (dashboardSocketReconnectTimer) return;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(dashboardSocketAttempt, 5)));
  dashboardSocketAttempt += 1;
  dashboardSocketReconnectTimer = setTimeout(() => { dashboardSocketReconnectTimer = null; connectDashboardSocket(); }, delay);
}
function connectDashboardSocket(force = false) {
  if (!window.WebSocket) return;
  if (force && dashboardSocket) { dashboardSocket.close(); dashboardSocket = null; }
  if (dashboardSocket || dashboardSocketReconnectTimer) return;
  let socket;
  try { socket = new WebSocket(dashboardWebSocketUrl()); } catch { scheduleDashboardSocketReconnect(); return; }
  dashboardSocket = socket;
  socket.addEventListener("open", () => { dashboardSocketAttempt = 0; setActivityLiveStatus(true); });
  socket.addEventListener("message", (message) => {
    let value;
    try { value = JSON.parse(message.data); } catch { return; }
    if (value.schemaVersion !== "dinodia.v1" || value.type !== "refresh") return;
    if (value.resource === "devices") refreshDevices();
    else if (value.resource === "activity") loadActivity({ reset: true }).catch(() => {});
    else if (value.resource === "dashboard") load();
  });
  socket.addEventListener("close", (event) => {
    if (dashboardSocket !== socket) return;
    dashboardSocket = null;
    setActivityLiveStatus(false);
    if (event.code === 4401) {
      if (dashboardSocketReconnectTimer) clearTimeout(dashboardSocketReconnectTimer);
      dashboardSocketReconnectTimer = null;
      showNotice("Your Dinodia OS session expired or was revoked. Return to Company Portal and select Open secure Dinodia OS again.", "error");
      return;
    }
    if (event.code === 1013) showNotice("Live updates are paused while Dinodia OS rechecks this window. The session remains open; updates will reconnect automatically.", "warning");
    scheduleDashboardSocketReconnect();
  });
  socket.addEventListener("error", () => { setActivityLiveStatus(false); if (dashboardSocket === socket) socket.close(); });
}
setInterval(refreshDevices, 10000);

$("#end-session")?.addEventListener("click", async () => {
  const button = $("#end-session");
  if (button) button.disabled = true;
  try {
    const selector = sessionStorage.getItem("dinodia.operatorSessionSelector") || location.pathname.match(/^\/_dinodia\/operator\/([A-Za-z0-9_-]{24,64})/)?.[1] || "";
    const response = await fetch("/_dinodia/operator-session/end", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...(selector ? { "x-dinodia-operator-session": selector } : {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The Dinodia OS session could not be ended");
    state.token = "";
    dashboardSocket?.close();
    window.location.replace("/setup");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "The Dinodia OS session could not be ended", "error");
    if (button) button.disabled = false;
  }
});
$("#refresh").addEventListener("click", load);
$("#activity-refresh").addEventListener("click", () => loadActivity({ reset: true }).catch((error) => showNotice(error.message, "error")));
$("#activity-expand").addEventListener("click", () => toggleActivityExpanded().catch((error) => showNotice(error.message, "error")));
$("#activity-load-older").addEventListener("click", () => loadActivity({ reset: false }).catch((error) => showNotice(error.message, "error")));
$("#activity-device-filter").addEventListener("change", (event) => { state.activity.deviceId = event.currentTarget.value; state.activity.nextCursor = null; state.activity.expanded = false; loadActivity({ reset: true }).catch((error) => showNotice(error.message, "error")); });
$("#activity-category-filter").addEventListener("change", (event) => { state.activity.category = event.currentTarget.value; state.activity.nextCursor = null; state.activity.expanded = false; loadActivity({ reset: true }).catch((error) => showNotice(error.message, "error")); });
$("#scan-adapters").addEventListener("click", loadAdapters);
$("#scan-adapters").addEventListener("click", loadThreadAdapters);
$("#save-adapter").addEventListener("click", async () => { const adapterPath = $("#adapter-select").value; if (!adapterPath) return showNotice("Choose a connected dongle first.", "error"); try { const probe = await api("/api/integrations/zigbee/probe", { method: "POST", body: JSON.stringify({ path: adapterPath }) }); if (!probe.ok) return showNotice(probe.message || "The selected dongle could not be opened.", "error"); await api("/api/integrations/zigbee/adapter", { method: "POST", body: JSON.stringify({ path: adapterPath }) }); showNotice("Coordinator selected. Restart Zigbee2MQTT if requested, then open pairing."); await load(); } catch (error) { showNotice(error.message, "error"); } });
$("#save-thread-adapter").addEventListener("click", async () => { const adapterPath = $("#thread-adapter-select").value; if (!adapterPath) return showNotice("Choose the connected Thread RCP first.", "error"); try { await api("/api/integrations/thread/adapter", { method: "POST", body: JSON.stringify({ path: adapterPath }) }); showNotice("Thread RCP selected. OpenThread Border Router is starting."); await load(); } catch (error) { showNotice(error.message, "error"); } });
function openAssignedInstallation() { window.open("https://dinodia-platform-v2.vercel.app/installer", "_blank", "noopener,noreferrer"); showNotice("Continue in Company Portal: choose the current assigned Home installation, then select Open assigned device installation. Pairing and property registration are handled together there."); }
$("#refresh-unregistered-property-devices")?.addEventListener("click", () => loadUnregisteredPropertyDevices());
function showTrackedCommissioningHandoff() {
  const section = $("#pairing-section");
  if (!section) return;
  const intro = section.querySelector(".section-heading .subtle");
  if (intro) intro.textContent = "For permanent Zigbee and Matter devices, use the current assigned Company Portal installation. It links radio discovery, device review, Area selection and property registration in one tracked operation.";
  for (const [protocol, message] of [["zigbee", "Open the current assigned installation in Company Portal to start a tracked Zigbee search."], ["matter", "Open the current assigned installation in Company Portal to start tracked Matter setup. Matter setup codes are entered only in that secure scoped workspace."]]) {
    const pane = $(`#${protocol}-pairing`);
    if (!pane) continue;
    const oldRow = pane.querySelector(".pair-row"); if (oldRow) oldRow.hidden = true;
    const helper = pane.querySelector(".helper"); if (helper) helper.textContent = message;
    if (!pane.querySelector(".assigned-installation-link")) {
      const link = document.createElement("a"); link.className = "primary assigned-installation-link"; link.href = "https://dinodia-platform-v2.vercel.app/installer";
      link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open Company Portal assigned work";
      pane.append(link);
    }
  }
}
showTrackedCommissioningHandoff();
$("#permit-join")?.addEventListener("click", (event) => { event.preventDefault(); openAssignedInstallation(); });
$("#stop-pairing").addEventListener("click", async () => { try { await api("/api/integrations/zigbee/pairing/stop", { method: "POST", body: "{}" }); if (pairingRefreshTimer) { clearInterval(pairingRefreshTimer); pairingRefreshTimer = null; } renderPairingStatus({}); showNotice("Zigbee pairing closed."); } catch (error) { showNotice(error.message, "error"); } });
ensureGoogleNestUi();
document.querySelectorAll("[data-pairing-tab]").forEach((tab) => tab.addEventListener("click", () => { document.querySelectorAll("[data-pairing-tab]").forEach((item) => item.classList.toggle("active", item === tab)); document.querySelectorAll(".pairing-pane").forEach((pane) => pane.classList.toggle("hidden", pane.id !== `${tab.dataset.pairingTab}-pairing`)); }));
$("#commission-matter")?.addEventListener("click", (event) => { event.preventDefault(); openAssignedInstallation(); });
$("#hive-connect-open").addEventListener("click", () => hiveAuthDialog(false, "connect"));
$("#hive-reauthenticate").addEventListener("click", () => hiveAuthDialog(false, "reauthenticate"));
$("#hive-auth-close").addEventListener("click", cancelHiveAuth);
$("#hive-auth-dialog").addEventListener("cancel", (event) => { event.preventDefault(); cancelHiveAuth(); });
$("#hive-auth-cancel").addEventListener("click", cancelHiveAuth);
$("#hive-mfa-cancel").addEventListener("click", cancelHiveAuth);
$("#hive-credentials-form").addEventListener("submit", submitHiveCredentials);
$("#hive-mfa-form").addEventListener("submit", submitHiveMfa);
$("#hive-refresh").addEventListener("click", async () => { try { await api("/api/integrations/hive/refresh", { method: "POST", body: "{}" }); await load(); showNotice("Hive devices refreshed."); } catch (error) { showNotice(hiveErrorMessage(error), "error"); } });
$("#hive-disconnect").addEventListener("click", disconnectHive);
$("#google-nest-connect").addEventListener("click", startGoogleNestAuth);
$("#google-nest-config-form").addEventListener("submit", submitGoogleNestConfig);
$("#google-nest-auth-cancel").addEventListener("click", cancelGoogleNestAuth);
$("#google-nest-refresh").addEventListener("click", async () => { try { await api("/api/integrations/google-nest/refresh", { method: "POST", body: "{}" }); await load(); showNotice("Google Nest thermostats refreshed."); } catch (error) { showNotice(googleNestErrorMessage(error), "error"); } });
$("#google-nest-reauthenticate").addEventListener("click", startGoogleNestAuth);
$("#google-nest-disconnect").addEventListener("click", disconnectGoogleNest);
$("#alexa-connect").addEventListener("click", async () => { const button = $("#alexa-connect"); button.disabled = true; try { const result = await api("/api/integrations/alexa/connect", { method: "POST", body: "{}" }); const linkingUrl = result.connectUrl || result.skillUrl; if (linkingUrl) { state.alexa = { ...(state.alexa || {}), connectUrl: result.connectUrl, skillUrl: result.skillUrl }; renderAlexa(state.alexa); window.open(linkingUrl, "_blank", "noopener"); } else showNotice("Alexa linking is ready. Open the Dinodia skill in the Alexa app to finish."); await loadAlexaStatus(); } catch (error) { showNotice(error.message, "error"); } finally { button.disabled = false; } });
$("#alexa-refresh").addEventListener("click", async () => { const button = $("#alexa-refresh"); button.disabled = true; try { await api("/api/integrations/alexa/refresh", { method: "POST", body: "{}" }); await loadAlexaStatus(); showNotice("Alexa device catalogue refreshed."); } catch (error) { showNotice(error.message, "error"); } finally { button.disabled = false; } });
$("#alexa-disconnect").addEventListener("click", async () => { if (!confirm("Disconnect Alexa from this home?")) return; try { await api("/api/integrations/alexa/account", { method: "DELETE", body: JSON.stringify({ confirm: true }) }); await loadAlexaStatus(); showNotice("Alexa was disconnected from this home."); } catch (error) { showNotice(error.message, "error"); } });
$("#pair-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/provisioning/pair", { method: "POST", body: JSON.stringify({ pairingCode: form.get("pairingCode"), serial: state.provisioning?.identity?.serial }) }); event.currentTarget.reset(); showNotice("Pairing presentation accepted. The hub is completing its authenticated outbound exchange…"); await load(); } catch (error) { showNotice(error.message, "error"); } });
let cloudflareSetupTimer;
function mountCloudflareRecoveryPanel() {
  const section = $("#cloudflare-section");
  if (!section || $("#cloudflare-recovery-panel")) return;
  const panel = document.createElement("div");
  panel.id = "cloudflare-recovery-panel";
  panel.className = "integration-result subtle";
  const title = document.createElement("strong");
  title.textContent = "Remote access status";
  const message = document.createElement("p");
  message.id = "cloudflare-recovery-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const button = document.createElement("button");
  button.id = "cloudflare-recovery-action";
  button.className = "primary hidden";
  button.type = "button";
  button.addEventListener("click", async () => {
    const state = button.dataset.recoveryState;
    const action = state === "RECONNECT_REQUIRED" ? "reconnect-existing" : "retry-recovery";
    button.disabled = true;
    try {
      await api("/api/integrations/cloudflare", { method: "POST", body: JSON.stringify({ action }) });
      await refreshCloudflareRecoveryPanel();
    } catch (error) {
      message.textContent = error?.message || "The existing tunnel could not be confirmed. No replacement was created.";
    } finally { button.disabled = false; }
  });
  panel.append(title, message, button);
  section.insertBefore(panel, section.firstChild);
}
async function refreshCloudflareRecoveryPanel() {
  mountCloudflareRecoveryPanel();
  const message = $("#cloudflare-recovery-message");
  const button = $("#cloudflare-recovery-action");
  if (!message || !button) return;
  try {
    const status = await api("/api/integrations/cloudflare");
    const state = String(status.recoveryState || "UNAVAILABLE");
    const messages = {
      READY: "Remote access is connected and its current signed verification is valid.",
      RECONNECTING: "Remote access is reconnecting. Valid local access remains available on the trusted home network.",
      RECONNECT_REQUIRED: "The saved settings need an explicit check against this hub’s current signed reservation. No tunnel will be created or selected by guessing.",
      HELD: "Remote access is deliberately disabled and will stay off until the authorized maintenance hold is changed.",
      UNCONFIGURED: "No existing secure tunnel is configured for this hub.",
      UNAVAILABLE: "Remote access status is not available yet. Local hub access may still work on the trusted home network."
    };
    message.textContent = messages[state] || "Remote access status is unknown.";
    button.dataset.recoveryState = state;
    button.textContent = state === "RECONNECT_REQUIRED" ? "Reconnect existing tunnel" : "Retry recovery";
    button.classList.toggle("hidden", !["RECONNECT_REQUIRED", "RECONNECTING"].includes(state));
  } catch {
    message.textContent = "Remote tunnel status could not be refreshed. This does not disable valid local access.";
    button.classList.add("hidden");
  }
}
mountCloudflareRecoveryPanel();
refreshCloudflareRecoveryPanel();
setInterval(() => { if (document.visibilityState === "visible") refreshCloudflareRecoveryPanel(); }, 60000);
$("#cloudflare-setup-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const authWindow = window.open("about:blank", "_blank"); try { const result = await api("/api/integrations/cloudflare", { method: "POST", body: JSON.stringify({ action: "setup", tunnelName: form.get("tunnelName"), hostname: form.get("hostname") }) }); renderCloudflare(result); if (result.setup?.authUrl && authWindow) { authWindow.location.href = result.setup.authUrl; authWindow.opener = null; } else if (authWindow) authWindow.close(); clearInterval(cloudflareSetupTimer); cloudflareSetupTimer = setInterval(load, 1500); } catch (error) { if (authWindow) authWindow.close(); showNotice(error.message, "error"); } });
$("#cloudflare-finish").addEventListener("click", async () => { try { await api("/api/integrations/cloudflare", { method: "POST", body: JSON.stringify({ action: "finish" }) }); clearInterval(cloudflareSetupTimer); await load(); } catch (error) { showNotice(error.message, "error"); } });
$("#cloudflare-reverify").addEventListener("click", async () => { const button = $("#cloudflare-reverify"); button.disabled = true; button.textContent = "Verifying…"; try { await api("/api/integrations/cloudflare", { method: "POST", body: JSON.stringify({ action: "reverify" }) }); await load(); } catch (error) { showNotice(error.message, "error"); await load().catch(() => {}); } finally { button.disabled = false; button.textContent = "Verify secure access again"; } });
$("#disconnect-cloudflare").addEventListener("click", async () => { try { await api("/api/integrations/cloudflare", { method: "POST", body: JSON.stringify({ action: "disconnect" }) }); await load(); } catch (error) { showNotice(error.message, "error"); } });
load();
startOperatorSessionStatusRefresh();
connectDashboardSocket();
