(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { context: null, session: null, selected: null, existingDevices: [], completedDevices: [], authorityVerified: false, busy: false, poll: null, sessionDeadlineMono: null, sessionClockTimer: null, lastAuthorityVerifiedAt: null, reviewStale: false, editing: false };
  // Only touch the page when something actually changed, so a background refresh never moves, blinks or interrupts anything.
  const setText = (element, text) => { if (element && element.textContent !== text) element.textContent = text; };
  const setHidden = (element, value) => { if (element && element.hidden !== value) element.hidden = value; };
  const setDisabled = (element, value) => { if (element && element.disabled !== value) element.disabled = value; };
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
    if (!response.ok) { const envelope = value?.error && typeof value.error === "object" ? value.error : value; const error = new Error(envelope?.message || envelope || "The hub rejected this installation action"); error.statusCode = response.status; error.code = envelope?.code || null; error.reason = envelope?.reason || null; if ([401, 403].includes(response.status)) clearProtectedScope(error); throw error; }
    return value;
  };
  const get = async (path) => {
    const requestStartedAt = performance.now();
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: operatorSessionHeaders() });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const envelope = value?.error && typeof value.error === "object" ? value.error : value;
      const error = new Error(envelope?.message || envelope || "The assigned installation session is no longer available"); error.statusCode = response.status; error.code = envelope?.code || null; error.reason = envelope?.reason || null;
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
  function operationId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // randomUUID is secure-context-only; getRandomValues remains available on
    // the authenticated private-LAN HTTP page. Keep idempotency keys random.
    if (typeof crypto.getRandomValues !== "function") throw new Error("This browser cannot securely create an installation request key. Reopen the hub using its secure address.");
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    state.reviewStale = false;
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
  // A new device is often named only by its radio address or the generic "Automatically Generated Definition": show what it is instead.
  function isMachineName(name) { return !name || /^0x[0-9a-f]{8,}$/i.test(String(name).trim()) || /^automatically generated definition$/i.test(String(name).trim()) || /^(zigbee:|matter-)/i.test(String(name).trim()); }
  function friendlyDeviceName(candidate) {
    if (!isMachineName(candidate?.name)) return candidate.name;
    return [candidate?.manufacturer, candidate?.model].filter(Boolean).join(" ").slice(0, 40) || "New device";
  }
  function openCandidate(candidate) {
    state.selected = candidate; $("device-result").hidden = false;
    const name = friendlyDeviceName(candidate).slice(0, 40);
    $("label").value = name; $("name").value = name; state.defaultName = name;
    $("analytics-category").value = state.session?.selectedCandidateRef === candidate.candidateRef ? (state.session.selectedAnalyticsCategory || "NONE") : "NONE";
    // One permitted room needs no choosing.
    if (!$("area").value && state.context?.areas?.length === 1) $("area").value = state.context.areas[0].id;
    state.editing = false; $("device-type").value = ""; state.lastSuggestion = ""; $("type-choices").dataset.signature = ""; renderSuggestions(); clearError(); updateButtons();
  }
  // What kind of device it is decides its heading in the app (all Lights together) and its usage charts, so it is chosen, never typed.
  const TYPES = [["Light", "LIGHT", "💡"], ["Radiator", "RADIATOR", "♨"], ["Boiler", "BOILER", "🔥"], ["Other", "NONE", "•"]];
  // A name the installer has not written themselves: empty, the device's own default, a code, or the last suggestion we filled in.
  function nameIsAutomatic(value, lastSuggestion) { const text = String(value || "").trim(); return !text || text === state.defaultName || text === lastSuggestion || isMachineName(text); }
  function suggestedName() {
    const area = (state.context?.areas || []).find((row) => row.id === $("area").value);
    const type = $("device-type").value;
    return area && type ? `${area.name} ${type === "Other" ? "Device" : type}`.slice(0, 40) : "";
  }
  function renderSuggestions() {
    const box = $("type-choices"); if (!box || typeof box.replaceChildren !== "function") return;
    const chosen = $("device-type").value;
    const signature = `built:${chosen}`;
    if (box.dataset.signature === signature) return;
    box.dataset.signature = signature; box.replaceChildren();
    for (const [label, category, icon] of TYPES) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = `${icon} ${label === "Other" ? "Something else" : label}`;
      button.setAttribute?.("role", "radio"); button.setAttribute?.("aria-checked", String(label === chosen));
      button.addEventListener("click", () => {
        const previousSuggestion = suggestedName(); $("device-type").value = label; $("analytics-category").value = category;
        // Fill the name for them unless they have written their own.
        if (nameIsAutomatic($("label").value, previousSuggestion)) { $("label").value = suggestedName(); $("name").value = $("label").value; }
        state.lastSuggestion = suggestedName(); box.dataset.signature = ""; renderSuggestions(); clearError(); updateButtons();
      });
      box.append(button);
    }
  }
  // The "are you sure" step: say back exactly what will be added, in plain words.
  function renderReviewSummary() {
    const box = $("review-summary"); if (!box) return;
    const selected = state.session?.status === "selected" && !state.reviewStale && !state.editing;
    if (!selected) { setHidden(box, true); return; }
    const area = (state.context?.areas || []).find((row) => row.id === $("area").value);
    const category = $("analytics-category").value || "NONE";
    const rows = [["Name", $("label").value.trim()], ["Room", area?.name || "—"], ["Usage charts", category === "NONE" ? "Not shown" : category.charAt(0) + category.slice(1).toLowerCase()]];
    const signature = JSON.stringify(rows);
    if (box.dataset.signature !== signature) {
      box.dataset.signature = signature; box.replaceChildren();
      const heading = document.createElement("h3"); heading.textContent = "Is this right?";
      const list = document.createElement("dl");
      for (const [term, value] of rows) { const dt = document.createElement("dt"); dt.textContent = term; const dd = document.createElement("dd"); dd.textContent = value; list.append(dt, dd); }
      const note = document.createElement("p"); note.className = "hint"; note.textContent = "Check the name and room carefully. If anything is wrong, change it before adding.";
      box.append(heading, list, note);
    }
    const wasHidden = box.hidden; setHidden(box, false);
    // Bring the question into view once, so the installer sees what they are confirming without hunting for it.
    if (wasHidden && typeof box.scrollIntoView === "function") box.scrollIntoView({ block: "center", behavior: "auto" });
  }
  function describeStatus(session, sessionState) {
    const found = (session.candidates || []).length;
    if (session.status === "completed") return session.localSyncState === "acknowledged" ? "Done. The device was added and the Home has confirmed it."
      : session.localSyncState === "pending" ? "Done. The device was added. Home sync is still pending acknowledgement, so it may take a minute to appear in the app."
      : "Done. The device was added. Home sync acknowledgement is not verified yet.";
    if (session.status === "completed_cleanup_pending") return "The device was recorded. The hub is still tidying up; this takes a moment.";
    if (session.status === "cancelled") return "Search stopped. Press a search button to start again.";
    if (session.status === "expired") return "The search timed out. Press a search button to try again.";
    if (session.status === "failed") return "That did not work. Press a search button to try again.";
    if (session.operationKind === "PAIR_NEW" && session.status === "searching" && found && state.selected) return "Found your device. Now choose its room and name.";
    if (session.operationKind === "PAIR_NEW" && session.status === "searching") {
      return found ? `Found ${found === 1 ? "a device" : found + " devices"}. Choose it below.`
        : session.joinWindowOpen === false ? "Checking for devices that are still joining…"
        : "Searching now. Put your device in pairing mode, then wait a few seconds.";
    }
    return `${session.protocol.toUpperCase()} · ${sessionState} · updated ${new Date(session.updatedAt).toLocaleTimeString()}`;
  }
  function setBusy(value) { state.busy = value; updateButtons(); }
  function canStart(protocol) { const entry = state.context?.protocols?.[protocol]; return state.authorityVerified && state.context?.protocols?.registrationEnabled === true && entry?.enabled === true && entry?.adapterReady === true && (!state.session || terminal.has(state.session.status)); }
  function updateButtons() {
    const authorized = state.authorityVerified && Boolean(state.context);
    $("start-zigbee").disabled = state.busy || !canStart("zigbee");
    $("start-matter").disabled = state.busy || !canStart("matter");
    $("refresh").disabled = state.busy;
    $("refresh-existing").disabled = state.busy || !authorized;
    $("cancel").disabled = state.busy || !authorized || !state.session || ["completed", "cancelled", "expired", "failed"].includes(state.session.status);
    for (const id of ["submit-matter", "select", "install", "view-only", "retain-unsupported", "remove", "add-next", "finish-installation", "change-details"]) setDisabled($(id), state.busy || !authorized);
    setDisabled($("end-session"), state.busy);
    // The details are locked once checked (so what you confirm is what is added) and open again with "Change name or room".
    // They never switch off during a refresh, so typing is never interrupted.
    const locked = state.session?.status === "selected" && !state.reviewStale && !state.editing;
    const fieldsOff = !state.context || locked || (state.session ? terminal.has(state.session.status) : false);
    for (const id of ["area", "label", "analytics-category"]) setDisabled($(id), fieldsOff);
    for (const button of document.querySelectorAll("[data-review-candidate]")) button.disabled = state.busy || !authorized;
    for (const button of document.querySelectorAll("[data-review-existing]")) button.disabled = state.busy || !authorized || Boolean(state.session && !terminal.has(state.session.status));
    const selected = state.session?.status === "selected";
    const needsReview = selected && state.reviewStale;
    setHidden($("select"), !state.selected || (selected && !needsReview && !state.editing));
    setHidden($("change-details"), !(selected && !needsReview && !state.editing));
    setHidden($("install"), !selected || needsReview || state.editing || state.session?.catalogueStatus !== "ready");
    $("view-only").hidden = !selected || needsReview || state.session?.catalogueStatus !== "no_safe_controls" || state.session?.catalogueUsefulReadings !== true;
    $("retain-unsupported").hidden = !selected || needsReview || state.session?.catalogueStatus !== "unsupported";
    $("remove").hidden = state.session?.operationKind === "REGISTER_EXISTING" || !selected || needsReview || !["unsupported", "no_safe_controls"].includes(state.session?.catalogueStatus);
    if (state.session?.operationKind === "REGISTER_EXISTING" && state.session?.catalogueStatus === "unsupported") $("retain-unsupported").textContent = "Register as view-only";
    else $("retain-unsupported").textContent = "Keep visible without controls";
    $("add-next").hidden = !state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0;
    $("finish-installation").hidden = !state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0;
    $("finish-installation-help").hidden = $("finish-installation").hidden;
    setText($("select"), needsReview ? "Check the updated device" : state.editing ? "Check these changes" : state.session?.operationKind === "REGISTER_EXISTING" ? "Check device and room" : "Check details");
    setText($("install"), state.session?.operationKind === "REGISTER_EXISTING" ? "Yes, register this device" : "Yes, add this device");
    renderReviewSummary();
    renderSteps();
  }
  // Where the installer is in the job: search, choose, name and room, done.
  function currentStep() {
    const session = state.session;
    if (session?.status === "completed") return 4;
    if (!$("device-result").hidden || state.selected) return 3;
    if (session && !terminal.has(session.status) && (session.candidates || []).length) return 2;
    return 1;
  }
  function renderSteps() {
    const step = currentStep();
    const root = $("installer");
    if (root) {
      const searchingNow = Boolean(state.session && !terminal.has(state.session.status) && state.session.operationKind === "PAIR_NEW");
      if (root.dataset.step !== String(step) || state.wasSearching !== searchingNow) {
        state.wasSearching = searchingNow;
        root.dataset.step = String(step);
        // A new step starts at the top, once; refreshes never scroll the page.
        if (state.stepShown !== undefined && typeof window.scrollTo === "function") window.scrollTo(0, 0);
      }
      state.stepShown = step;
    }
    for (let index = 1; index <= 4; index += 1) {
      const item = $(`step-${index}`);
      if (item) item.className = index < step ? "done" : index === step ? "current" : "";
    }
    const searching = state.session?.status === "searching" && !(state.session.candidates || []).length && state.session.joinWindowOpen !== false;
    if ($("status").className !== (searching ? "banner waiting" : "banner")) $("status").className = searching ? "banner waiting" : "banner";
    if ($("installer")) $("installer").dataset.searching = String(Boolean(state.session && !terminal.has(state.session.status) && state.session.operationKind === "PAIR_NEW"));
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
    if (session.selectedCandidateRef && state.appliedCategoryRef !== session.selectedCandidateRef
        && ["NONE", "LIGHT", "BOILER", "RADIATOR"].includes(String(session.selectedAnalyticsCategory || "NONE"))) {
      $("analytics-category").value = session.selectedAnalyticsCategory || "NONE"; state.appliedCategoryRef = session.selectedCandidateRef;
    }
    if (!session.selectedCandidateRef) state.appliedCategoryRef = null;
    if (session.selectedCandidateRef) {
      state.selected = (session.candidates || []).find((candidate) => candidate.candidateRef === session.selectedCandidateRef) || state.selected;
    } else if (terminal.has(session.status)) state.selected = null;
    else if (state.selected?.candidateRef) state.selected = (session.candidates || []).find((candidate) => candidate.candidateRef === state.selected.candidateRef) || state.selected;
    if (session.operationKind === "REGISTER_EXISTING" && !state.selected) state.selected = (session.candidates || [])[0] || null;
    sessionStorage.setItem(key("session"), session.sessionId);
    const sessionState = session.protocol === "zigbee" && session.operationKind === "PAIR_NEW" && session.status === "searching" && session.joinWindowOpen === false
      ? `join window closed · ${(session.candidates || []).length ? "review discovered device" : "checking devices already joining"}`
      : session.status.replaceAll("_", " ");
    setText($("status"), describeStatus(session, sessionState));
    $("matter-entry").hidden = session.protocol !== "matter" || !["awaiting_payload", "interrupted"].includes(session.status);
    $("matter-entry-row").hidden = $("matter-entry").hidden;
    // Preserve an in-progress review of a newly discovered candidate across
    // status polls. The selection is only a local review draft until the
    // separate server-side "Review this device" action succeeds.
    setHidden($("device-result"), !session.selectedCandidateRef && !state.selected);
    const controls = Array.isArray(session.selectedControls) ? session.selectedControls : [];
    $("selected-controls").textContent = controls.length ? `Detected controls: ${controls.filter((control) => String(control.name || "").toLowerCase() !== "unknown").map((control) => `${control.name}${control.readable ? " · reading" : ""}${control.writable ? " · control" : ""}`).join("; ")}`
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
    const signature = JSON.stringify([state.session?.operationKind, rows.map((row) => [row.candidateRef, row.name, row.manufacturer, row.model, row.stage, row.interviewStatus])]);
    const list = $("candidate-list");
    if (list.dataset.signature === signature) { autoOpenSingleCandidate(rows); return; }
    list.dataset.signature = signature; list.replaceChildren();
    for (const candidate of rows) {
      const item = document.createElement("div"); item.className = "candidate";
      const title = document.createElement("strong"); title.textContent = friendlyDeviceName(candidate);
      const detail = document.createElement("p"); detail.className = "muted";
      // Plain words: either it is ready to be named and placed, or it is still connecting.
      const ready = candidate.interviewStatus === "successful";
      const progress = ready ? (candidate.stage === "needs_setup" ? "Ready to set up" : candidate.stage) : "Still connecting. Keep it close to the hub.";
      detail.textContent = [candidate.manufacturer, candidate.model, progress].filter(Boolean).join(" · ") || "The hub is connecting to this device";
      const choose = document.createElement("button"); choose.type = "button"; choose.dataset.reviewCandidate = "true"; choose.textContent = state.session?.operationKind === "REGISTER_EXISTING" ? "Review existing device" : "Choose this device"; choose.disabled = state.busy || !state.authorityVerified;
      choose.addEventListener("click", () => openCandidate(candidate));
      item.append(title, detail, choose); list.append(item);
    }
    autoOpenSingleCandidate(rows);
  }
  // Exactly one fully interviewed new device: open it for review straight away, once.
  function autoOpenSingleCandidate(rows) {
    if (state.session?.operationKind === "PAIR_NEW" && rows.length === 1 && rows[0].interviewStatus === "successful" && !state.selected && !state.session.selectedCandidateRef
        && state.autoOpenedRef !== rows[0].candidateRef) {
      state.autoOpenedRef = rows[0].candidateRef; openCandidate(rows[0]);
    }
  }
  function renderCompleted() {
    const rows = state.completedDevices; const section = $("completed-devices"); const list = $("completed-device-list");
    setHidden(section, rows.length === 0);
    const lines = rows.map((row) => {
      const sync = row.sync === "pending" ? "syncing to the Home" : row.sync === "acknowledged" ? "synced to the Home" : "sync not confirmed yet";
      let line = `${row.name}${row.model ? ` · ${row.model}` : ""} · ${row.areaName || "room unavailable"} · ${row.lifecycle === "VIEW_ONLY" ? "view-only" : "added"} · ${row.analyticsCategory && row.analyticsCategory !== "NONE" ? `${String(row.analyticsCategory).toLowerCase()} usage charts · ` : ""}${sync}`;
      if (row.analyticsReadiness) line += ` · Analytics ${row.analyticsReadiness.state}${row.analyticsReadiness.reason ? `: ${row.analyticsReadiness.reason.replaceAll("_", " ")}` : ""}`;
      return line;
    });
    const signature = JSON.stringify(lines);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature; list.replaceChildren();
    for (const line of lines) { const item = document.createElement("li"); item.textContent = line; list.append(item); }
  }
  function scheduleSessionRefresh(delayMs) {
    if (state.poll) clearTimeout(state.poll);
    state.poll = setTimeout(() => { state.poll = null; void refresh({ background: true }); }, delayMs);
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
    setHidden(section, false);
    setHidden($("existing-device-hold"), !held);
    // Redrawn only when the list changes, so a background refresh never makes it blink.
    const signature = JSON.stringify([held, (held ? [] : state.existingDevices).map((device) => [device.candidateRef || device.id, device.name, device.model, device.originalAreaName])]);
    if (list.dataset.signature === signature) { $("existing-device-empty").hidden = held || state.existingDevices.length > 0; return; }
    list.dataset.signature = signature; list.replaceChildren();
    for (const device of held ? [] : state.existingDevices) {
      const item = document.createElement("article"); item.className = "candidate";
      const title = document.createElement("strong"); title.textContent = device.name || "Unidentified local device";
      const detail = document.createElement("p"); detail.className = "muted";
      detail.textContent = [device.protocol?.toUpperCase(), device.manufacturer, device.model, `Currently in ${device.originalAreaName || "an authorized Area"}`].filter(Boolean).join(" · ");
      const badge = document.createElement("p"); badge.className = "muted"; badge.textContent = "Not registered to this property yet. Review its live descriptor and choose the correct property Area before registering.";
      const choose = document.createElement("button"); choose.type = "button"; choose.dataset.reviewExisting = "true"; choose.textContent = "Review and register"; choose.disabled = state.busy || Boolean(state.session && !terminal.has(state.session.status));
      choose.addEventListener("click", () => startExisting(device));
      item.append(title, detail, badge, choose); list.append(item);
    }
    $("existing-device-empty").hidden = held || state.existingDevices.length > 0;
  }
  async function start(protocol) {
    if (!canStart(protocol)) return;
    setBusy(true); clearError();
    try {
      const session = await post("/_dinodia/installer/commissioning/sessions", { schemaVersion: "dinodia.v1", operationKind: "PAIR_NEW", protocol }, `install-start-${operationId()}`);
      state.selected = null; state.reviewStale = false;
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
      const session = await post("/_dinodia/installer/commissioning/sessions", { schemaVersion: "dinodia.v1", operationKind: "REGISTER_EXISTING", protocol: device.protocol, candidateRef: device.candidateRef }, `install-adopt-${operationId()}`);
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
  async function refresh({ background = false } = {}) {
    if (state.busy) { if (state.session) scheduleSessionRefresh(1000); return; }
    if (!background) clearError();
    if (!background) setBusy(true);
    let nextPollDelay = null;
    const requestedSessionId = state.session?.sessionId;
    try {
      await refreshContext({ preserveAuthority: background });
      await refreshExistingDevices();
      if (!requestedSessionId || state.session?.sessionId !== requestedSessionId) return;
      const session = await get(`/_dinodia/installer/commissioning/sessions/${encodeURIComponent(requestedSessionId)}`);
      if (state.session?.sessionId !== requestedSessionId) return;
      render(session); renderCandidates();
      if (terminal.has(session.status) || session.status.endsWith("_cleanup_pending")) { if (state.poll) clearTimeout(state.poll); state.poll = null; }
      else nextPollDelay = 3000;
    } catch (error) {
      showError(error);
      if (state.context && ![401, 403].includes(Number(error?.statusCode))) nextPollDelay = 15000;
    }
    finally { if (!background) setBusy(false); updateButtons(); if (nextPollDelay !== null) scheduleSessionRefresh(nextPollDelay); }
  }
  async function refreshContext({ preserveAuthority = false } = {}) {
    if (!preserveAuthority) state.authorityVerified = false;
    updateButtons();
    state.context = await get("/_dinodia/installer/commissioning");
    renderSessionDeadline(state.context);
    setText($("summary"), `Assigned installation work · ${state.context.areas.length} room${state.context.areas.length === 1 ? "" : "s"} you can add devices to`);
    // Rebuilt only when the rooms actually change, so an open dropdown or a chosen room is never disturbed by a background refresh.
    const select = $("area"); const areaSignature = state.context.areas.map((area) => `${area.id}:${area.name}`).join("|");
    if (select.dataset.signature !== areaSignature) {
      const previous = select.value; select.replaceChildren(new Option("Choose a room", ""));
      for (const area of state.context.areas) select.add(new Option(area.name, area.id));
      if (state.context.areas.some((area) => area.id === previous)) select.value = previous;
      select.dataset.signature = areaSignature;
    }
    for (const protocol of ["zigbee", "matter"]) {
      const entry = state.context.protocols?.[protocol];
      const title = protocol === "zigbee" ? "Zigbee coordinator" : "Matter controller";
      const reason = state.context.protocols?.registrationEnabled !== true ? "Permanent-device registration is held by the current staff maintenance policy. No pairing or adoption action is available."
        : !entry?.enabled ? `${title} commissioning is held by this hub's operational configuration.`
        : !entry?.adapterReady ? entry?.readinessMessage || `The ${title.toLowerCase()} is not ready; no commissioning action can start.`
          : protocol === "matter" ? (entry.readinessMessage || `${title} is connected.`)
            : `${title} is ready for a user-started device search/setup.`;
      setText($(`${protocol}-readiness`), reason);
    }
    if (!state.session) setText($("status"), "Ready. Press a search button above, then put your device in pairing mode.");
  }
  async function chooseCandidate() {
    if (!state.authorityVerified || !state.session || !state.selected) return;
    const areaId = $("area").value; const typeLabel = $("device-type").value; const name = ($("name").value.trim() || $("label").value.trim()); const customerLabel = typeLabel;
    if (!areaId) { showError(new Error("Choose which room this device is in.")); return; }
    if (!typeLabel) { showError(new Error("Choose what kind of device it is.")); return; }
    if (name.length < 2) { showError(new Error("Give the device a name, for example “Room 2 Light”.")); return; }
    if (isMachineName(name)) { showError(new Error("That name is a technical code. Give it a name the customer will recognise, for example “Room 2 Light”.")); return; }
    setBusy(true); clearError();
    try {
      const path = `/_dinodia/installer/commissioning/sessions/${encodeURIComponent(state.session.sessionId)}`;
      const candidateRef = state.selected.candidateRef;
    const analyticsCategory = $("analytics-category").value || "NONE";
    if (!["NONE", "LIGHT", "BOILER", "RADIATOR"].includes(analyticsCategory)) { showError(new Error("Choose a valid optional analytics category.")); return; }
    const body = { schemaVersion: "dinodia.v1", expectedRevision: state.session.revision, candidateRef, areaId, name, customerLabel, analyticsCategory };
      let result;
      try { result = await post(`${path}/select`, body); }
      catch (error) {
        if (error.reason !== "candidate_list_revision_changed") throw error;
        const refreshed = await get(path);
        const sameCandidate = (refreshed.candidates || []).find((candidate) => candidate.candidateRef === candidateRef);
        const interviewReady = refreshed.operationKind === "REGISTER_EXISTING"
          ? sameCandidate?.stage === "existing_interview_verified"
          : sameCandidate?.interviewStatus === "successful";
        if (!sameCandidate || !interviewReady || !["searching", "reviewing_existing", "selected"].includes(refreshed.status)) throw error;
        render(refreshed); renderCandidates();
        result = await post(`${path}/select`, { ...body, expectedRevision: refreshed.revision });
      }
      state.reviewStale = false; state.editing = false;
      render(result);
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
    } catch (error) {
      if (error.reason === "device_descriptor_changed_after_review") {
        state.reviewStale = true;
        $("selected-controls").textContent = "The live device descriptor changed after review. Re-review the updated controls before registering; no property registration was confirmed.";
        updateButtons();
      }
      showError(error);
    }
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
  $("label").addEventListener("input", () => { $("name").value = $("label").value; });
  $("area").addEventListener("change", () => {
    const old = $("label").value; const typeNow = $("device-type").value;
    if (typeNow && nameIsAutomatic(old, state.lastSuggestion)) { $("label").value = suggestedName(); $("name").value = $("label").value; }
    state.lastSuggestion = suggestedName(); renderSuggestions(); clearError(); updateButtons();
  });
  $("change-details").addEventListener("click", () => { state.editing = true; clearError(); updateButtons(); });
  $("view-only").addEventListener("click", () => complete("view_only"));
  $("retain-unsupported").addEventListener("click", () => complete("retain_unsupported"));
  $("remove").addEventListener("click", () => complete("remove"));
  $("add-next").addEventListener("click", async () => {
    if (!state.session || !terminal.has(state.session.status) || (state.session.cleanup?.pendingCount || 0) > 0) return;
    sessionStorage.removeItem(key("session")); state.session = null; state.selected = null; state.editing = false; state.autoOpenedRef = null;
    $("label").value = ""; $("name").value = ""; $("analytics-category").value = "NONE";
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
    if (typeof window.confirm === "function" && !window.confirm("End this installation session? You will need to open it again from Company Portal to add more devices.")) return;
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
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh({ background: true }).catch(showError); });
  void init();
})();
