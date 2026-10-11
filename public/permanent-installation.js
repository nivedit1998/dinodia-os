(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { context: null, session: null, selected: null, existingDevices: [], completedDevices: [], authorityVerified: false, busy: false, poll: null, sessionDeadlineMono: null, sessionClockTimer: null, lastAuthorityVerifiedAt: null };
  const key = (suffix) => `dinodia-installation:${state.context?.requestId || "unknown"}:${suffix}`;
  const operatorSessionHeaders = () => {
    const selector = sessionStorage.getItem("dinodia.operatorSessionSelector") || String(location.pathname || "").match(/^\/_dinodia\/operator\/([A-Za-z0-9_-]{24,64})/)?.[1] || "";
    return selector ? { "x-dinodia-operator-session": selector } : {};
  };
  const post = async (path, body, idempotencyKey = null) => {
    const headers = { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf"), ...operatorSessionHeaders() };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(value?.error?.message || value?.error || "The hub rejected this installation action"); error.statusCode = response.status; if ([401, 403].includes(response.status)) clearProtectedScope(error); throw error; }
    return value;
  };
  const get = async (path) => {
    const requestStartedAt = performance.now();
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: operatorSessionHeaders() });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(value?.error?.message || value?.error || "The assigned installation session is no longer available"); error.statusCode = response.status;
      if ([401, 403].includes(response.status)) clearProtectedScope(error);
      else if (response.status === 503) {
        state.authorityVerified = false;
        updateButtons();
        const last = state.lastAuthorityVerifiedAt ? ` Last verified ${new Date(state.lastAuthorityVerifiedAt).toLocaleTimeString()}.` : "";
        $("summary").textContent = `Authority is temporarily unavailable. This OS session has not been declared expired; protected actions are paused.${last}`;
        $("status").textContent = "Waiting to recheck the same assigned session. Do not sign in or launch a replacement because of a temporary connection failure.";
      }
      throw error;
    }
    if (value && typeof value === "object") Object.defineProperty(value, "__responseRttMs", { value: Math.max(0, performance.now() - requestStartedAt), enumerable: false });
    return value;
  };
  function cookie(name) {
    return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
  }
  function showError(error) { $("error").textContent = error instanceof Error ? error.message : "The action could not be completed"; $("error").hidden = false; }
  function clearError() { $("error").hidden = true; $("error").textContent = ""; }
  const terminal = new Set(["completed", "cancelled", "expired", "failed"]);
  function clearProtectedScope(error) {
    const prefix = "dinodia-installation:";
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const savedKey = sessionStorage.key(index);
      if (savedKey?.startsWith(prefix)) sessionStorage.removeItem(savedKey);
    }
    if (state.poll) clearInterval(state.poll);
    state.poll = null; state.context = null; state.session = null; state.selected = null;
    state.existingDevices = []; state.completedDevices = []; state.authorityVerified = false; state.busy = false;
    $("summary").textContent = "This assigned installation authority is no longer current. Close this window and reopen the work from Company Portal.";
    $("area").replaceChildren(new Option("No current Area access", ""));
    $("device-result").hidden = true; $("candidates").hidden = true; $("existing-devices").hidden = true; $("completed-devices").hidden = true;
    $("matter-entry").hidden = true; $("matter-entry-row").hidden = true;
    $("candidate-list").replaceChildren(); $("existing-device-list").replaceChildren(); $("completed-device-list").replaceChildren();
    for (const id of ["label", "name", "matter-payload", "selected-controls"]) if ($(id)) $(id).value = "";
    $("status").textContent = "No protected installation scope is retained in this window.";
    $("zigbee-readiness").textContent = "Assigned installation authority must be refreshed before any action.";
    $("matter-readiness").textContent = "Assigned installation authority must be refreshed before any action.";
    if (error) showError(error);
    updateButtons();
  }
  function setBusy(value) { state.busy = value; for (const id of ["start-zigbee", "start-matter", "refresh", "refresh-existing", "cancel", "submit-matter", "select", "install", "view-only", "retain-unsupported", "remove", "add-next", "finish-installation"]) if ($(id)) $(id).disabled = value; }
  function canStart(protocol) { const entry = state.context?.protocols?.[protocol]; return state.authorityVerified && state.context?.protocols?.registrationEnabled === true && entry?.enabled === true && entry?.adapterReady === true && (!state.session || terminal.has(state.session.status)); }
  function updateButtons() {
    const authorized = state.authorityVerified && Boolean(state.context);
    $("start-zigbee").disabled = state.busy || !canStart("zigbee");
    $("start-matter").disabled = state.busy || !canStart("matter");
    $("refresh").disabled = state.busy;
    $("refresh-existing").disabled = state.busy || !authorized;
    $("cancel").disabled = state.busy || !authorized || !state.session || ["completed", "cancelled", "expired", "failed"].includes(state.session.status);
    for (const id of ["submit-matter", "select", "install", "view-only", "retain-unsupported", "remove", "add-next", "finish-installation", "end-session"]) if ($(id)) $(id).disabled = state.busy || !authorized;
    $("area").disabled = !authorized;
    for (const id of ["label", "name"]) if ($(id)) $(id).disabled = !authorized;
    const selected = state.session?.status === "selected";
    $("select").hidden = !state.selected || selected;
    $("install").hidden = !selected || state.session?.catalogueStatus !== "ready";
    $("view-only").hidden = !selected || state.session?.catalogueStatus !== "no_safe_controls" || state.session?.catalogueUsefulReadings !== true;
    $("retain-unsupported").hidden = !selected || state.session?.catalogueStatus !== "unsupported";
    $("remove").hidden = state.session?.operationKind === "REGISTER_EXISTING" || !selected || !["unsupported", "no_safe_controls"].includes(state.session?.catalogueStatus);
    if (state.session?.operationKind === "REGISTER_EXISTING" && state.session?.catalogueStatus === "unsupported") $("retain-unsupported").textContent = "Register as view-only";
    else $("retain-unsupported").textContent = "Keep visible without controls";
    $("add-next").hidden = !state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0;
    $("finish-installation").hidden = !state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0;
    $("finish-installation-help").hidden = $("finish-installation").hidden;
    $("select").textContent = state.session?.operationKind === "REGISTER_EXISTING" ? "Review device and Area" : "Review this device";
    $("install").textContent = state.session?.operationKind === "REGISTER_EXISTING" ? "Register as permanent device" : "Install and sync";
  }
  function renderSessionDeadline(context) {
    if (!context?.sessionExpiresAt || !context?.serverNow || !window.performance?.now) return;
    const deadline = Date.parse(context.sessionExpiresAt); const serverNow = Date.parse(context.serverNow);
    if (!Number.isFinite(deadline) || !Number.isFinite(serverNow)) return;
    state.sessionDeadlineMono = performance.now() + Math.max(0, deadline - serverNow - Number(context.__responseRttMs || 0));
    state.lastAuthorityVerifiedAt = context.authorityVerifiedAt || context.serverNow;
    const render = () => {
      const remainingMs = Math.max(0, state.sessionDeadlineMono - performance.now());
      const remaining = Math.ceil(remainingMs / 1000);
      const minutes = Math.floor(remaining / 60); const seconds = remaining % 60;
      $("operator-session-status").textContent = remaining > 0
        ? `This assigned OS session ends at ${new Date(deadline).toLocaleTimeString()} (${minutes}m ${String(seconds).padStart(2, "0")}s remaining). Refreshing or opening another window does not extend it.`
        : "This assigned OS session has reached its absolute deadline. Return to Company Portal to deliberately open a new session.";
      if (remaining === 0) { state.authorityVerified = false; updateButtons(); }
    };
    render();
    if (state.sessionClockTimer) clearInterval(state.sessionClockTimer);
    state.sessionClockTimer = setInterval(render, 1000);
  }
  function render(session) {
    state.session = session;
    if (session.operationKind === "REGISTER_EXISTING" && !state.selected) state.selected = (session.candidates || [])[0] || null;
    sessionStorage.setItem(key("session"), session.sessionId);
    $("status").textContent = `${session.protocol.toUpperCase()} · ${session.status.replaceAll("_", " ")} · updated ${new Date(session.updatedAt).toLocaleTimeString()}`;
    $("matter-entry").hidden = session.protocol !== "matter" || !["awaiting_payload", "interrupted"].includes(session.status);
    $("matter-entry-row").hidden = $("matter-entry").hidden;
    $("device-result").hidden = !session.selectedCandidateRef;
    const controls = Array.isArray(session.selectedControls) ? session.selectedControls : [];
    $("selected-controls").textContent = controls.length ? `Detected controls: ${controls.map((control) => `${control.name}${control.readable ? " · reading" : ""}${control.writable ? " · control" : ""}`).join("; ")}`
      : session.selectedCandidateRef ? `Control/readings status: ${session.catalogueStatus === "unsupported" ? "not understood yet; no controls are being invented" : session.catalogueStatus === "no_safe_controls" ? "no safe control was detected" : "no current control descriptor is available"}` : "";
    if (session.operationKind === "REGISTER_EXISTING") {
      $("review-heading").textContent = "Review already-paired device";
      $("review-instructions").textContent = "Confirm its current Area, name, customer label and detected controls. Registration does not open pairing, stop joining, remove or re-pair this device.";
    }
    updateButtons();
    if (session.nextCandidateCursor) void loadCandidatePages(session.nextCandidateCursor);
  }
  async function loadCandidatePages(cursor) {
    const known = new Set((state.session?.candidates || []).map((candidate) => candidate.candidateRef));
    let next = cursor; let pages = 0;
    while (next && pages++ < 8) {
      const page = await get(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}?candidateAfter=${encodeURIComponent(next)}`);
      for (const candidate of page.candidates || []) if (!known.has(candidate.candidateRef)) { state.session.candidates.push(candidate); known.add(candidate.candidateRef); }
      next = page.nextCandidateCursor || null;
    }
    renderCandidates();
  }
  function renderCandidates() {
    const rows = state.session?.candidates || [];
    $("candidates").hidden = rows.length === 0;
    const list = $("candidate-list"); list.replaceChildren();
    for (const candidate of rows) {
      const item = document.createElement("div"); item.className = "candidate";
      const title = document.createElement("strong"); title.textContent = candidate.name || "Unidentified device";
      const detail = document.createElement("p"); detail.className = "muted"; detail.textContent = [candidate.manufacturer, candidate.model, candidate.stage].filter(Boolean).join(" · ") || "The hub is interviewing this device";
      const choose = document.createElement("button"); choose.type = "button"; choose.textContent = state.session?.operationKind === "REGISTER_EXISTING" ? "Review existing device" : "Review candidate"; choose.disabled = state.busy;
      choose.addEventListener("click", () => { state.selected = candidate; $("device-result").hidden = false; $("label").value = candidate.name || "New device"; $("name").value = candidate.name || "New device"; clearError(); updateButtons(); });
      item.append(title, detail, choose); list.append(item);
    }
  }
  function renderCompleted() {
    const rows = state.completedDevices; const section = $("completed-devices"); const list = $("completed-device-list");
    section.hidden = rows.length === 0; list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("li");
      const sync = row.sync === "pending" ? "Home sync pending" : row.sync === "acknowledged" ? "Home sync acknowledged" : "Home sync not verified";
      item.textContent = `${row.name}${row.model ? ` · ${row.model}` : ""} · ${row.protocol || "device"} · ${row.areaName || "Area unavailable"} · ${row.lifecycle === "VIEW_ONLY" ? "view-only" : "permanent"} · ${sync}`;
      list.append(item);
    }
  }
  function scheduleSessionRefresh(delayMs) {
    if (state.poll) clearTimeout(state.poll);
    state.poll = setTimeout(() => { state.poll = null; void refresh(); }, delayMs);
  }
  async function refreshExistingDevices() {
    if (!state.context?.protocols?.registrationEnabled) { state.existingDevices = []; state.completedDevices = []; state.authorityVerified = true; renderExistingDevices(); renderCompleted(); updateButtons(); return; }
    const result = await get("/_dinodia/installer/commissioning/devices");
    state.existingDevices = Array.isArray(result.devices) ? result.devices : [];
    state.completedDevices = Array.isArray(result.completedDevices) ? result.completedDevices : [];
    state.authorityVerified = true;
    renderExistingDevices();
    renderCompleted();
    updateButtons();
  }
  function renderExistingDevices() {
    const section = $("existing-devices"); const list = $("existing-device-list"); const held = state.context?.protocols?.registrationEnabled !== true;
    section.hidden = false;
    $("existing-device-hold").hidden = !held;
    list.replaceChildren();
    for (const device of held ? [] : state.existingDevices) {
      const item = document.createElement("article"); item.className = "candidate";
      const title = document.createElement("strong"); title.textContent = device.name || "Unidentified local device";
      const detail = document.createElement("p"); detail.className = "muted";
      detail.textContent = [device.protocol?.toUpperCase(), device.manufacturer, device.model, `Currently in ${device.originalAreaName || "an authorized Area"}`].filter(Boolean).join(" · ");
      const badge = document.createElement("p"); badge.className = "muted"; badge.textContent = "Not registered to this property yet. Review its live descriptor and choose the correct property Area before registering.";
      const choose = document.createElement("button"); choose.type = "button"; choose.textContent = "Review and register"; choose.disabled = state.busy || Boolean(state.session && !terminal.has(state.session.status));
      choose.addEventListener("click", () => startExisting(device));
      item.append(title, detail, badge, choose); list.append(item);
    }
    $("existing-device-empty").hidden = held || state.existingDevices.length > 0;
  }
  async function start(protocol) {
    if (!canStart(protocol)) return;
    setBusy(true); clearError();
    try {
      const session = await post("/_dinodia/installer/commissioning/sessions", { schemaVersion: "dinodia.v1", operationKind: "PAIR_NEW", protocol }, `install-start-${crypto.randomUUID()}`);
      render(session); renderCandidates();
      if (state.poll) clearInterval(state.poll);
      scheduleSessionRefresh(3000);
    } catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  async function startExisting(device) {
    if (state.busy || !state.authorityVerified || !state.context?.protocols?.registrationEnabled || state.session && !terminal.has(state.session.status)) return;
    setBusy(true); clearError(); state.selected = device;
    try {
      const session = await post("/_dinodia/installer/commissioning/sessions", { schemaVersion: "dinodia.v1", operationKind: "REGISTER_EXISTING", protocol: device.protocol, candidateRef: device.candidateRef }, `install-adopt-${crypto.randomUUID()}`);
      render(session); renderCandidates();
      $("device-result").hidden = false;
      $("review-heading").textContent = "Review already-paired device";
      $("review-instructions").textContent = "Confirm its current Area, name, customer label and detected controls. Registering does not open pairing, stop joining, remove or re-pair this device.";
      $("label").value = device.name || "Device"; $("name").value = device.name || "Device";
      const area = $("area"); if (device.availableAreas?.some((row) => row.id === device.originalAreaId)) area.value = device.originalAreaId;
      if (state.poll) clearInterval(state.poll);
      scheduleSessionRefresh(3000);
    } catch (error) { state.selected = null; showError(error); await refreshExistingDevices().catch(() => {}); }
    finally { setBusy(false); updateButtons(); }
  }
  async function refresh() {
    if (state.busy) { if (state.session) scheduleSessionRefresh(1000); return; }
    clearError();
    setBusy(true);
    let nextPollDelay = null;
    try {
      await refreshContext();
      await refreshExistingDevices();
      if (!state.session) return;
      const session = await get(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}`);
      render(session); renderCandidates();
      if (terminal.has(session.status) || session.status.endsWith("_cleanup_pending")) { if (state.poll) clearTimeout(state.poll); state.poll = null; }
      else nextPollDelay = 3000;
    } catch (error) {
      showError(error);
      if (state.context && ![401, 403].includes(Number(error?.statusCode))) nextPollDelay = 15000;
    }
    finally { setBusy(false); updateButtons(); if (nextPollDelay !== null) scheduleSessionRefresh(nextPollDelay); }
  }
  async function refreshContext() {
    state.authorityVerified = false; updateButtons();
    state.context = await get("/_dinodia/installer/commissioning");
    renderSessionDeadline(state.context);
    $("summary").textContent = `Assigned installation work · ${state.context.areas.length} permitted original Area${state.context.areas.length === 1 ? "" : "s"}`;
    const select = $("area"); const previous = select.value; select.replaceChildren(new Option("Choose an Area", ""));
    for (const area of state.context.areas) select.add(new Option(area.name, area.id));
    if (state.context.areas.some((area) => area.id === previous)) select.value = previous;
    for (const protocol of ["zigbee", "matter"]) {
      const entry = state.context.protocols?.[protocol];
      const title = protocol === "zigbee" ? "Zigbee coordinator" : "Matter controller";
      const reason = state.context.protocols?.registrationEnabled !== true ? "Permanent-device registration is held by the current staff maintenance policy. No pairing or adoption action is available."
        : !entry?.enabled ? `${title} commissioning is held by this hub's operational configuration.`
        : !entry?.adapterReady ? entry?.readinessMessage || `The ${title.toLowerCase()} is not ready; no commissioning action can start.`
          : protocol === "matter" ? (entry.readinessMessage || `${title} is connected.`)
            : `${title} is ready for a user-started device search/setup.`;
      $(`${protocol}-readiness`).textContent = reason;
    }
    if (!state.session) $("status").textContent = "No active commissioning session. Start a search only when the relevant radio is ready.";
  }
  async function chooseCandidate() {
    if (!state.authorityVerified || !state.session || !state.selected) return;
    const areaId = $("area").value; const customerLabel = $("label").value.trim(); const name = $("name").value.trim();
    if (!areaId || !customerLabel || !name) { showError(new Error("Choose an active original Area and enter a device name and customer label.")); return; }
    setBusy(true); clearError();
    try {
      render(await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/select`, {
        schemaVersion: "dinodia.v1", expectedRevision: state.session.revision, candidateRef: state.selected.candidateRef, areaId, name, customerLabel,
      }));
    } catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  async function complete(disposition) {
    if (!state.authorityVerified || !state.session) return;
    setBusy(true); clearError();
    try {
      const candidate = state.selected || (state.session.candidates || []).find((row) => row.candidateRef === state.session.selectedCandidateRef) || (state.session.candidates || [])[0];
      const result = await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/complete`, { schemaVersion: "dinodia.v1", disposition });
      render(result); renderCandidates();
      $("status").textContent = result.status === "completed_cleanup_pending" ? "The device result is recorded; cleanup is still being confirmed by the hub." : result.localSyncState === "pending" ? "Registered by the hub and Platform. Home sync is still pending acknowledgement." : result.localSyncState === "acknowledged" ? "Registered by the hub and Platform; the Home sync was acknowledged." : "Registered by the hub and Platform. Home sync acknowledgement is not verified.";
      await refreshExistingDevices().catch(() => {});
    } catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  async function cancel() {
    if (!state.authorityVerified || !state.session || !window.confirm("Cancel this commissioning attempt? The hub will close joining and reconcile any partially added device.")) return;
    setBusy(true); clearError();
    try { render(await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/cancel`, { schemaVersion: "dinodia.v1" })); }
    catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  $("start-zigbee").addEventListener("click", () => start("zigbee"));
  $("start-matter").addEventListener("click", () => start("matter"));
  $("refresh").addEventListener("click", () => refresh());
  $("refresh-existing").addEventListener("click", () => refreshExistingDevices().catch(showError));
  $("cancel").addEventListener("click", () => cancel());
  $("select").addEventListener("click", () => chooseCandidate());
  $("install").addEventListener("click", () => complete("install"));
  $("view-only").addEventListener("click", () => complete("view_only"));
  $("retain-unsupported").addEventListener("click", () => complete("retain_unsupported"));
  $("remove").addEventListener("click", () => complete("remove"));
  $("add-next").addEventListener("click", async () => {
    if (!state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0) return;
    sessionStorage.removeItem(key("session")); state.session = null; state.selected = null;
    $("device-result").hidden = true; $("candidates").hidden = true;
    $("review-heading").textContent = "Review discovered device";
    $("review-instructions").textContent = "Review the device interview, select an authorized original Area, and confirm its current controls before registration.";
    state.selected = null;
    await refresh().catch(showError); updateButtons();
  });
  $("finish-installation").addEventListener("click", async () => {
    if (state.session && !terminal.has(state.session.status)) return;
    await fetch("/_dinodia/operator-session/end", { method: "POST", credentials: "same-origin", headers: { "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf"), ...operatorSessionHeaders() } }).catch(() => {});
    if (window.opener && !window.opener.closed) { window.close(); return; }
    location.replace("/support-access");
  });
  $("submit-matter").addEventListener("click", async () => {
    if (location.protocol !== "https:") { showError(new Error("Matter setup codes are accepted only through the verified secure Dinodia OS address. Reopen this assigned work using secure access.")); return; }
    if (!state.authorityVerified || !state.session) return;
    setBusy(true); clearError();
    try {
      const session = await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/matter-payload`, { schemaVersion: "dinodia.v1", setupPayload: $("matter-payload").value });
      $("matter-payload").value = ""; render(session);
    } catch (error) { $("matter-payload").value = ""; showError(error); }
    finally { setBusy(false); updateButtons(); }
  });
  $("end-session").addEventListener("click", async () => {
    if (state.session && !["completed", "cancelled", "expired", "failed"].includes(state.session.status)) await cancel();
    await fetch("/_dinodia/operator-session/end", { method: "POST", credentials: "same-origin", headers: { "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf"), ...operatorSessionHeaders() } }).catch(() => {});
    location.replace("/support-access");
  });
  async function init() {
    try {
      await refreshContext();
      await refreshExistingDevices();
      const saved = sessionStorage.getItem(key("session"));
      if (saved && /^[0-9a-f-]{36}$/i.test(saved)) { state.session = { sessionId: saved }; await refresh(); }
      updateButtons();
    renderCompleted();
    } catch (error) {
      if (![401, 403].includes(error?.statusCode) && !(error?.statusCode === 503 && /temporarily unavailable/i.test($("summary").textContent))) {
        $("summary").textContent = state.context ? "Authority or hub status could not be refreshed; actions remain disabled until it is revalidated." : "This assigned work is unavailable.";
      }
      showError(error); updateButtons();
      if (![401, 403].includes(Number(error?.statusCode))) scheduleSessionRefresh(15000);
    }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh().catch(showError); });
  void init();
})();
