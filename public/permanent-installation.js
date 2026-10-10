(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { context: null, session: null, selected: null, busy: false, poll: null };
  const key = (suffix) => `dinodia-installation:${state.context?.requestId || "unknown"}:${suffix}`;
  const post = async (path, body, idempotencyKey = null) => {
    const headers = { "content-type": "application/json", "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error?.message || value?.error || "The hub rejected this installation action");
    return value;
  };
  const get = async (path) => {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(value?.error?.message || value?.error || "The assigned installation session is no longer available"); error.statusCode = response.status; throw error; }
    return value;
  };
  function cookie(name) {
    return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
  }
  function showError(error) { $("error").textContent = error instanceof Error ? error.message : "The action could not be completed"; $("error").hidden = false; }
  function clearError() { $("error").hidden = true; $("error").textContent = ""; }
  const terminal = new Set(["completed", "cancelled", "expired", "failed"]);
  function setBusy(value) { state.busy = value; for (const id of ["start-zigbee", "start-matter", "refresh", "cancel", "submit-matter", "select", "install", "view-only", "retain-unsupported", "remove", "add-next"]) $(id).disabled = value; }
  function canStart(protocol) { const entry = state.context?.protocols?.[protocol]; return entry?.enabled === true && entry?.adapterReady === true && (!state.session || terminal.has(state.session.status)); }
  function updateButtons() {
    $("start-zigbee").disabled = state.busy || !canStart("zigbee");
    $("start-matter").disabled = state.busy || !canStart("matter");
    $("refresh").disabled = state.busy;
    $("cancel").disabled = state.busy || !state.session || ["completed", "cancelled", "expired", "failed"].includes(state.session.status);
    const selected = state.session?.status === "selected";
    $("select").hidden = !state.selected || selected;
    $("install").hidden = !selected || state.session?.catalogueStatus !== "ready";
    $("view-only").hidden = !selected || state.session?.catalogueStatus !== "no_safe_controls" || state.session?.catalogueUsefulReadings !== true;
    $("retain-unsupported").hidden = !selected || state.session?.catalogueStatus !== "unsupported";
    $("remove").hidden = !selected || !["unsupported", "no_safe_controls"].includes(state.session?.catalogueStatus);
    $("add-next").hidden = !state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0;
  }
  function render(session) {
    state.session = session;
    sessionStorage.setItem(key("session"), session.sessionId);
    $("status").textContent = `${session.protocol.toUpperCase()} · ${session.status.replaceAll("_", " ")} · updated ${new Date(session.updatedAt).toLocaleTimeString()}`;
    $("matter-entry").hidden = session.protocol !== "matter" || !["awaiting_payload", "interrupted"].includes(session.status);
    $("matter-entry-row").hidden = $("matter-entry").hidden;
    $("device-result").hidden = !session.selectedCandidateRef;
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
      const choose = document.createElement("button"); choose.type = "button"; choose.textContent = "Review candidate"; choose.disabled = state.busy;
      choose.addEventListener("click", () => { state.selected = candidate; $("device-result").hidden = false; $("label").value = candidate.name || "New device"; $("name").value = candidate.name || "New device"; clearError(); updateButtons(); });
      item.append(title, detail, choose); list.append(item);
    }
  }
  async function start(protocol) {
    if (!canStart(protocol)) return;
    setBusy(true); clearError();
    try {
      const session = await post("/_dinodia/installer/commissioning/sessions", { schemaVersion: "dinodia.v1", protocol }, `install-start-${crypto.randomUUID()}`);
      render(session); renderCandidates();
      if (state.poll) clearInterval(state.poll);
      state.poll = setInterval(() => refresh().catch(showError), 3000);
    } catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  async function refresh() {
    if (state.busy) return;
    clearError();
    setBusy(true);
    try {
      await refreshContext();
      if (!state.session) return;
      const session = await get(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}`);
      render(session); renderCandidates();
      if (terminal.has(session.status) || session.status.endsWith("_cleanup_pending")) { clearInterval(state.poll); state.poll = null; }
    } catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  async function refreshContext() {
    try { state.context = await get("/_dinodia/installer/commissioning"); }
    catch (error) {
      if ([401, 403].includes(error?.statusCode)) {
        sessionStorage.removeItem(key("session"));
        if (state.poll) clearInterval(state.poll);
        state.poll = null; state.context = null; state.session = null; state.selected = null;
        $("summary").textContent = "This assigned installation authority is no longer current. Close this window and reopen the work from Company Portal.";
        $("area").replaceChildren(new Option("No current Area access", ""));
        $("device-result").hidden = true; $("candidates").hidden = true;
        $("status").textContent = "No protected installation scope is retained in this window.";
      }
      throw error;
    }
    $("summary").textContent = `Assigned installation work · ${state.context.areas.length} permitted original Area${state.context.areas.length === 1 ? "" : "s"}`;
    const select = $("area"); const previous = select.value; select.replaceChildren(new Option("Choose an Area", ""));
    for (const area of state.context.areas) select.add(new Option(area.name, area.id));
    if (state.context.areas.some((area) => area.id === previous)) select.value = previous;
    for (const protocol of ["zigbee", "matter"]) {
      const entry = state.context.protocols?.[protocol];
      const title = protocol === "zigbee" ? "Zigbee coordinator" : "Matter controller";
      const reason = !entry?.enabled ? `${title} commissioning is held by this hub's operational configuration.`
        : !entry?.adapterReady ? entry?.readinessMessage || `The ${title.toLowerCase()} is not ready; no commissioning action can start.`
          : protocol === "matter" ? (entry.readinessMessage || `${title} is connected.`)
            : `${title} is ready for a user-started device search/setup.`;
      $(`${protocol}-readiness`).textContent = reason;
      $(`start-${protocol}`).disabled = state.busy || !entry?.enabled || !entry?.adapterReady || Boolean(state.session && !terminal.has(state.session.status));
    }
    if (!state.session) $("status").textContent = "No active commissioning session. Start a search only when the relevant radio is ready.";
  }
  async function chooseCandidate() {
    if (!state.session || !state.selected) return;
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
    if (!state.session) return;
    setBusy(true); clearError();
    try {
      const result = await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/complete`, { schemaVersion: "dinodia.v1", disposition });
      render(result); renderCandidates();
      $("status").textContent = result.status === "completed_cleanup_pending" ? "The device result is recorded; cleanup is still being confirmed by the hub." : "The device result is recorded by the hub and Platform.";
    } catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  async function cancel() {
    if (!state.session || !window.confirm("Cancel this commissioning attempt? The hub will close joining and reconcile any partially added device.")) return;
    setBusy(true); clearError();
    try { render(await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/cancel`, { schemaVersion: "dinodia.v1" })); }
    catch (error) { showError(error); }
    finally { setBusy(false); updateButtons(); }
  }
  $("start-zigbee").addEventListener("click", () => start("zigbee"));
  $("start-matter").addEventListener("click", () => start("matter"));
  $("refresh").addEventListener("click", () => refresh());
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
    await refresh().catch(showError); updateButtons();
  });
  $("submit-matter").addEventListener("click", async () => {
    if (location.protocol !== "https:") { showError(new Error("Matter setup codes are accepted only through the verified secure Dinodia OS address. Reopen this assigned work using secure access.")); return; }
    if (!state.session) return;
    setBusy(true); clearError();
    try {
      const session = await post(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}/matter-payload`, { schemaVersion: "dinodia.v1", setupPayload: $("matter-payload").value });
      $("matter-payload").value = ""; render(session);
    } catch (error) { $("matter-payload").value = ""; showError(error); }
    finally { setBusy(false); updateButtons(); }
  });
  $("end-session").addEventListener("click", async () => {
    if (state.session && !["completed", "cancelled", "expired", "failed"].includes(state.session.status)) await cancel();
    await fetch("/_dinodia/operator-session/end", { method: "POST", credentials: "same-origin", headers: { "x-dinodia-setup-csrf": cookie("dinodia_setup_csrf") } }).catch(() => {});
    location.replace("/support-access");
  });
  async function init() {
    try {
      await refreshContext();
      const saved = sessionStorage.getItem(key("session"));
      if (saved && /^[0-9a-f-]{36}$/i.test(saved)) { state.session = { sessionId: saved }; await refresh(); }
      updateButtons();
    } catch (error) { $("summary").textContent = "This assigned work is unavailable."; showError(error); }
  }
  void init();
})();
