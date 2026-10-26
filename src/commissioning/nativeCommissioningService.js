const crypto = require("node:crypto");
const { isDeepStrictEqual } = require('node:util');
const { QrPairingCodeCodec, isValidPasscode, MATTER_QR_CODE_SINGLE_PAYLOAD_MAX_LENGTH } = require("@matter/types");
const { buildPublicCommissioningCatalogue } = require("./publicDeviceCatalogue");
const { buildLogicalCommissioningProposal } = require('./logicalDeviceCatalogue');
const digest = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

const SESSION_MS = 15 * 60 * 1000;
const RECOVERABLE_PAIRING_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECOVERABLE_PAIRING_SESSIONS = 32;
const MAX_CANDIDATES = 32;
const MAX_TOTAL_CANDIDATES = 256;
const TERMINAL = new Set(["completed", "completed_cleanup_pending", "cancelled", "expired", "failed", "cancelled_cleanup_pending", "expired_cleanup_pending", "failed_cleanup_pending"]);
const SAFE_ERROR = Object.freeze({ invalid: "commissioning_request_invalid", denied: "commissioning_authority_denied", busy: "commissioning_radio_busy", unavailable: "commissioning_radio_unavailable", expired: "commissioning_session_expired", conflict: "commissioning_revision_conflict" });

function fail(code, statusCode = 409, message = "This commissioning operation is unavailable", reason = null) {
  throw Object.assign(new Error(message), { statusCode, code, ...(typeof reason === "string" && /^[a-z0-9_]{1,64}$/i.test(reason) ? { reason } : {}) });
}
function hasCurrentCanonicalDevicePolicy(policy) {
  const managementClass = String(policy?.managementClass || "").toUpperCase();
  const lifecycle = String(policy?.lifecycle || "").toUpperCase();
  return ["INSTALLED", "VIEW_ONLY"].includes(lifecycle)
    && ((managementClass === "PROPERTY_DEVICE" && policy.ownerMembershipId == null)
      || (managementClass === "TENANT_DEVICE" && Boolean(String(policy.ownerMembershipId || ""))));
}
function text(value, max) {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function fixedSession(session, afterCandidateRef = null) {
  const statuses = new Set(["requested", "advertising", "awaiting_payload", "commissioning", "searching", "reviewing_existing", "interrupted", "selected", "completed", "completed_cleanup_pending", "cancelled", "expired", "failed", "cancelled_cleanup_pending", "expired_cleanup_pending"]);
  const candidates = Array.isArray(session.candidates) ? session.candidates : [];
  const cursorIndex = afterCandidateRef == null ? -1 : candidates.findIndex((candidate) => candidate.candidateRef === afterCandidateRef);
  if (afterCandidateRef != null && cursorIndex < 0) fail(SAFE_ERROR.conflict, 409, "The candidate page changed; refresh the discovery list", "candidate_page_changed");
  const start = cursorIndex + 1;
  const page = candidates.slice(start, start + MAX_CANDIDATES);
  return {
    sessionId: String(session.sessionId), protocol: String(session.protocol), operationKind: String(session.operationKind || "PAIR_NEW"),
    status: statuses.has(String(session.status)) || String(session.status).endsWith("_cleanup_pending") ? session.status : "failed",
    createdAt: String(session.createdAt), updatedAt: String(session.updatedAt || session.createdAt), expiresAt: String(session.expiresAt),
    revision: Number(session.revision) || 1,
    candidates: page.map(({ candidateRef, name, manufacturer, model, stage, interviewStatus, observedAt }) => ({ candidateRef, name, manufacturer, model, stage, interviewStatus, observedAt })),
    nextCandidateCursor: start + page.length < candidates.length ? page.at(-1)?.candidateRef || null : null,
    selectedCandidateRef: session.selectedCandidateRef || null, selectedAreaId: session.selectedAreaId || null,
    selectedName: session.selectedName || null, selectedCustomerLabel: session.selectedCustomerLabel || null,
    selectedAnalyticsCategory: session.selectedCandidateRef ? (session.selectedAnalyticsCategory || "NONE") : null,
    catalogueStatus: session.selectedCatalogue?.capabilityStatus || null,
    catalogueUsefulReadings: session.selectedCatalogue?.usefulReadings === true,
    selectedControls: (session.selectedCatalogue?.controls || []).slice(0, 64).map((control) => ({
      name: String(control.name || control.semanticRole || control.kind || "Control").slice(0, 100),
      semanticRole: String(control.semanticRole || "unknown").slice(0, 80),
      kind: String(control.valueType || control.kind || "unknown").slice(0, 40),
      readable: control.readable === true, writable: control.writable === true,
    })),
    localSyncState: ["pending", "acknowledged", "unknown"].includes(String(session.localSyncState || "")) ? session.localSyncState : "unknown",
    finalDisposition: session.finalDisposition || null,
    finalDeviceId: session.finalDeviceId || null,
    cleanup: { state: String(session.cleanup?.state || "NONE"), pendingCount: (Array.isArray(session.cleanup?.pendingIds) ? session.cleanup.pendingIds.length : 0) + (session.radioOperationInFlight || session.radioOperationUncertain ? 1 : 0) },
    events: (Array.isArray(session.events) ? session.events : []).slice(-40).map(({ sequence, type, at, count, protocol, cleanupState }) => ({ sequence, type, at, ...(count === undefined ? {} : { count }), ...(protocol ? { protocol } : {}), ...(cleanupState ? { cleanupState } : {}) })),
  };
}

class NativeCommissioningService {
  constructor({ store, mqtt, matter, pairing, vault, eventBus, commissioningCapabilities = {}, logicalDevicesEnabled = false, identityBrokerRequired = false, clock = () => Date.now(), logger = console } = {}) {
    this.store = store; this.mqtt = mqtt; this.matter = matter; this.pairing = pairing; this.vault = vault; this.eventBus = eventBus;
    this.identityBrokerRequired = identityBrokerRequired === true;
    this.logicalDevicesEnabled = logicalDevicesEnabled === true;
    this.commissioningCapabilities = commissioningCapabilities;
    this.clock = clock; this.logger = logger; this.lock = Promise.resolve(); this.stopped = false;
    this.adoptionCandidates = new Map();
    this.expiryTimer = setInterval(() => { this.reconcileExpired().catch(() => {}); }, 5000);
    this.expiryTimer.unref?.();
    this.recover().catch(() => {});
  }

  async exclusive(work) {
    const previous = this.lock; let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  sessions() { return this.store.getSecurity?.()?.nativeCommissioningSessions || {}; }
  async save(session) {
    const rows = { ...this.sessions(), [session.sessionId]: session };
    const active = Object.values(rows).filter((row) => !TERMINAL.has(row.status));
    if (active.length > 4) fail(SAFE_ERROR.busy, 409, "The hub already has the maximum active commissioning sessions", "active_session_limit");
    const completed = Object.entries(rows).filter(([, row]) => TERMINAL.has(row.status)).sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt)).slice(0, 24);
    const recoverable = Object.entries(rows).filter(([, row]) => TERMINAL.has(row.status)
      && (row.candidates || []).some((candidate) => candidate.registrationProvenance?.kind === "expired_staff_pairing_v1"
        && Date.parse(candidate.registrationProvenance.expiresAt) > this.clock()))
      .sort((a, b) => Date.parse(b[1].updatedAt || b[1].createdAt) - Date.parse(a[1].updatedAt || a[1].createdAt))
      .slice(0, MAX_RECOVERABLE_PAIRING_SESSIONS);
    const retained = new Map([...completed, ...recoverable]);
    const keep = Object.fromEntries([...Object.entries(rows).filter(([, row]) => !TERMINAL.has(row.status)), ...retained]);
    await this.store.saveSecurity({ nativeCommissioningSessions: keep });
    this.eventBus?.emit?.("dinodia_dashboard_updated", { kind: "commissioning", sessionId: session.sessionId, at: new Date(this.clock()).toISOString() });
    return session;
  }

  async currentIdentity() {
    // Production identity is owned by the isolated broker, not the legacy
    // JSON Store. The Store copy can legitimately have generation 0 even
    // while the paired signing identity is healthy and current.
    if (typeof this.pairing?.getPublicIdentity === "function") {
      try {
        const current = await this.pairing.getPublicIdentity();
        const generation = Number(current?.generation || 0);
        const serial = String(current?.serial || "");
        if (serial && Number.isSafeInteger(generation) && generation > 0) return { serial, generation };
      } catch { if (this.identityBrokerRequired) return null; }
      if (this.identityBrokerRequired) return null;
    }
    const stored = this.store.getIdentity?.() || {};
    const generation = Number(stored.generation || 0);
    const serial = String(stored.serial || "");
    return serial && Number.isSafeInteger(generation) && generation > 0 ? { serial, generation } : null;
  }

  async principal(principal, identity = null) {
    const platform = this.store.getPlatform?.() || {};
    const currentIdentity = identity || await this.currentIdentity();
    const staff = principal?.principalType === "operator" && Array.isArray(principal.scope)
      && principal.scope.length === 1 && principal.scope[0] === "os:permanent-installation";
    if (staff) {
      const areaOptions = Array.isArray(principal.areaOptions) ? principal.areaOptions.filter((row) => row && typeof row === "object" && /^[0-9a-f-]{36}$/i.test(String(row.id || "")) && typeof row.name === "string" && row.name.trim().length > 0 && row.name.length <= 120).slice(0, 64) : [];
      const authorizedAreas = [...new Set((principal.areaIds || []).map(String))].filter(Boolean).sort();
      const denialReasons = [];
      if (!principal.sub || !principal.sid || !principal.jti || !principal.handoffId || !principal.workflow || !principal.requestId || !principal.employeeSessionId
        || !Number.isSafeInteger(Number(principal.workRevision)) || Number(principal.workRevision) < 1) denialReasons.push("required_scoped_work_claim_missing");
      if (!principal.homeId || !platform.hubInstallId || String(platform.homeId || "") !== String(principal.homeId)) denialReasons.push("home_binding_mismatch");
      if (!platform.hubInstallId || !principal.verifiedHubInstallationId
        || String(platform.hubInstallId || "") !== String(principal.verifiedHubInstallationId)) denialReasons.push("hub_installation_binding_mismatch");
      if (!currentIdentity) denialReasons.push("current_paired_identity_unavailable");
      else {
        if (String(principal.hubId || "") !== currentIdentity.serial) denialReasons.push("hub_serial_mismatch");
        if (currentIdentity.generation !== Number(principal.identityGeneration)) denialReasons.push("identity_generation_mismatch");
      }
      if (authorizedAreas.length === 0 || authorizedAreas.length !== areaOptions.length || authorizedAreas.some((id) => !areaOptions.some((area) => area.id === id))) denialReasons.push("authorized_area_claim_mismatch");
      // Log only fixed reason codes; never include Home, device, employee, or credential identifiers.
      if (denialReasons.length) { try { this.logger.warn?.(`[commissioning] assigned_principal_denied reasons=${denialReasons.join(",")}`); } catch {} }
      if (!principal.sub || !principal.sid || !principal.jti || !principal.handoffId || !principal.workflow || !principal.requestId || !principal.employeeSessionId
        || !Number.isSafeInteger(Number(principal.workRevision)) || Number(principal.workRevision) < 1 || !principal.homeId || !platform.hubInstallId
        || String(platform.homeId || "") !== String(principal.homeId) || !principal.verifiedHubInstallationId
        || String(platform.hubInstallId || "") !== String(principal.verifiedHubInstallationId)
        || !currentIdentity || String(principal.hubId || "") !== currentIdentity.serial || currentIdentity.generation !== Number(principal.identityGeneration)
        || authorizedAreas.length === 0 || authorizedAreas.length !== areaOptions.length || authorizedAreas.some((id) => !areaOptions.some((area) => area.id === id))) {
        fail(SAFE_ERROR.denied, 403, "A current assigned permanent-installation authority is required");
      }
      // The signed staff grant can contain Areas which are active in Platform
      // but no longer exist on this hub (for example after an interrupted
      // migration). Keep the grant's authority check above exact, then reduce
      // usable scope to one-to-one mappings onto current, same-named hub Areas.
      const bindings = Array.isArray(platform.areaBindings) ? platform.areaBindings : [];
      const localAreas = new Map((this.store.listAreas?.() || []).map((area) => [String(area.id || ""), area]));
      const usableAreaOptions = areaOptions.filter((option) => {
        const matches = bindings.filter((binding) => String(binding.areaId || "") === option.id);
        if (matches.length !== 1 || !matches[0].hubAreaId) return false;
        const localArea = localAreas.get(String(matches[0].hubAreaId));
        if (!localArea) return false;
        const canonicalName = String(option.name || "").normalize("NFC").trim();
        const hubName = String(localArea.name || "").normalize("NFC").trim();
        return canonicalName.length > 0 && canonicalName === hubName;
      });
      if (!usableAreaOptions.length) fail(SAFE_ERROR.denied, 403, "No active original Area is currently mapped to a matching Area on this hub");
      return { actorType: "STAFF_INSTALLER", employeeId: String(principal.sub), employeeSessionId: String(principal.employeeSessionId), operatorHandoffId: String(principal.handoffId),
        operatorJti: String(principal.jti), workItemId: String(principal.workflow), workRevision: Number(principal.workRevision), requestId: String(principal.requestId),
        tokenId: String(principal.jti), tokenHash: digest(String(principal.jti)), membershipId: null, accountId: null, customerSessionId: null, trustedDeviceId: null,
        accessTokenHash: null, homeId: String(principal.homeId), hubInstallationId: String(principal.verifiedHubInstallationId), identityGeneration: currentIdentity.generation,
        areaIds: usableAreaOptions.map((area) => area.id), areaOptions: usableAreaOptions };
    }
    if (!principal || principal.principalType !== "app" || principal.householdRole !== "TENANT" || !principal.scope?.includes("tenant:device-command")
      || !principal.sub || !principal.sid || !principal.jti || !principal.trustedDeviceId || !principal.membershipId || !principal.homeId || !principal.hubInstallId || !/^[a-f0-9]{64}$/i.test(String(principal.accessTokenHash || ""))) fail(SAFE_ERROR.denied, 403, "A current selected tenant session is required");
    if (String(platform.homeId || "") !== String(principal.homeId) || String(platform.hubInstallId || "") !== String(principal.hubInstallId)
      || !currentIdentity || String(currentIdentity.generation) !== String(principal.identityGeneration || currentIdentity.generation)) fail(SAFE_ERROR.denied, 403, "The selected tenant session does not match this enrolled Home and hub");
    const authorizedAreas = [...new Set((principal.areaIds || []).map(String))].filter(Boolean).sort();
    if (!authorizedAreas.length) fail(SAFE_ERROR.denied, 403, "No active original Area is available to this membership");
    return { actorType: "TENANT", accountId: String(principal.sub), customerSessionId: String(principal.sid), tokenId: String(principal.jti), trustedDeviceId: String(principal.trustedDeviceId), membershipId: String(principal.membershipId), homeId: String(principal.homeId), hubInstallationId: String(principal.hubInstallId), accessTokenHash: String(principal.accessTokenHash), identityGeneration: currentIdentity.generation, areaIds: authorizedAreas };
  }

  actorBinding(actor) {
    return digest(JSON.stringify({ actorType: actor.actorType, employeeId: actor.employeeId || null, employeeSessionId: actor.employeeSessionId || null,
      operatorHandoffId: actor.operatorHandoffId || null, operatorJti: actor.operatorJti || null, workItemId: actor.workItemId || null,
      workRevision: actor.workRevision || null, requestId: actor.requestId || null, accountId: actor.accountId || null,
      customerSessionId: actor.customerSessionId || null, membershipId: actor.membershipId || null, homeId: actor.homeId,
      hubInstallationId: actor.hubInstallationId, identityGeneration: actor.identityGeneration, areaIds: [...actor.areaIds].sort() }));
  }

  protocolIdentity(device) {
    const protocol = String(device?.protocol || "").toLowerCase();
    if (protocol === "zigbee") {
      const identity = String(device?.protocolIdentity?.ieeeAddress || device?.metadata?.ieee_address || device?.metadata?.ieee || "").trim().toLowerCase();
      return identity ? { identity, hash: digest(`zigbee\n${identity}`) } : null;
    }
    if (protocol === "matter") {
      const nodeId = String(device?.protocolIdentity?.nodeId || device?.metadata?.node_id || "").trim().toLowerCase();
      const fabricId = String(device?.protocolIdentity?.fabricId || device?.metadata?.fabric_id || "default").trim().toLowerCase();
      if (!nodeId || !fabricId) return null;
      const identity = `${fabricId}\n${nodeId}`;
      return { identity, hash: digest(`matter\n${identity}`) };
    }
    return null;
  }

  candidateIdentityHash(device) {
    return digest(String(device?.protocolIdentity?.ieeeAddress || device?.protocolIdentity?.nodeId
      || device?.metadata?.ieee_address || device?.id || ""));
  }

  adoptionProvenance(actor, device) {
    if (actor.actorType !== "STAFF_INSTALLER" || !device || device.infrastructure === true) return null;
    const protocol = String(device.protocol || "").toLowerCase();
    if (!(["zigbee", "matter"].includes(protocol)) || device.available === false) return null;
    const policy = this.store.getPlatform?.()?.devicePolicies?.[String(device.id || "")];
    const ownerMembershipId = String(device.tenantOwnerMembershipId || device.metadata?.tenantOwnerMembershipId || "");
    const managementClass = String(policy?.managementClass || device.managementClass || device.metadata?.managementClass || "").trim().toUpperCase();
    // Any retained tenant marker or canonical policy is a hard exclusion. Do
    // not turn a departed tenant's stale local record into property inventory.
    if (policy || ownerMembershipId || managementClass === "TENANT_DEVICE") return null;
    const priorTenantRegistration = (this.store.listEvents?.(500) || []).some((event) => event
      && event.type === "tenant_device_commissioned" && String(event.deviceId || "") === String(device.id));
    if (priorTenantRegistration) return null;
    const protocolIdentity = this.protocolIdentity(device);
    if (!protocolIdentity || device.interviewStatus !== "successful") return null;
    const bindings = this.store.getPlatform?.()?.areaBindings || [];
    const areaBinding = bindings.find((row) => String(row.hubAreaId || "") === String(device.areaId || "") && actor.areaIds.includes(String(row.areaId || "")));
    const events = this.store.listEvents?.(500) || [];
    const setupEvent = events.find((event) => event && event.type === "device_setup_completed"
      && String(event.deviceId || "") === String(device.id) && String(event.areaId || "") === String(device.areaId || ""));
    // A mutable setup.status is not ownership evidence. Require the retained
    // full-dashboard setup event plus live protocol identity/interview.
    if (setupEvent && areaBinding && Object.keys(device.entities || {}).length
      && ["ready", "complete"].includes(String(device.setup?.status || "").toLowerCase())) {
      return { protocolIdentityHash: protocolIdentity.hash, areaId: String(areaBinding.areaId), hubAreaId: String(areaBinding.hubAreaId), setupEventAt: String(setupEvent.timestamp || "") };
    }

    // A natural timeout of a tracked staff PAIR_NEW operation is not an
    // operator cancellation. Only the exact new-to-session candidate may be
    // recovered, and only after the join window was confirmed closed and its
    // durable local record still matches the identity captured at discovery.
    const recoverable = Object.values(this.sessions()).some((session) => {
      if (session.operationKind !== "PAIR_NEW" || session.actorType !== "STAFF_INSTALLER"
        || String(session.protocol || "").toLowerCase() !== protocol || session.expiryReviewPending === true
        || !["expired", "expired_cleanup_pending"].includes(String(session.status || ""))
        || String(session.homeId || "") !== String(actor.homeId || "")
        || String(session.hubInstallationId || "") !== String(actor.hubInstallationId || "")
        || Number(session.identityGeneration) !== Number(actor.identityGeneration)) return false;
      return (session.candidates || []).some((candidate) => String(candidate.deviceId || "") === String(device.id || "")
        && candidate.registrationProvenance?.kind === "expired_staff_pairing_v1"
        && Number(candidate.registrationProvenance.identityGeneration) === Number(actor.identityGeneration)
        && Date.parse(candidate.registrationProvenance.expiresAt) > this.clock()
        && String(candidate.identityHash || "") === this.candidateIdentityHash(device)
        && !this.isBaselineDevice(session, device));
    });
    if (!recoverable || (device.areaId && !areaBinding)) return null;
    return { protocolIdentityHash: protocolIdentity.hash, areaId: String(areaBinding?.areaId || ""), hubAreaId: String(areaBinding?.hubAreaId || ""), setupEventAt: "" };
  }

  canRetainExpiredStaffCandidate(session, candidate, device) {
    if (session.operationKind !== "PAIR_NEW" || session.actorType !== "STAFF_INSTALLER"
      || String(session.protocol || "").toLowerCase() !== "zigbee" || !candidate || !device
      || String(candidate.deviceId || "") !== String(device.id || "")
      || String(device.protocol || "").toLowerCase() !== "zigbee" || device.available === false
      || device.interviewStatus !== "successful" || !this.protocolIdentity(device)
      || this.candidateIdentityHash(device) !== String(candidate.identityHash || "")
      || this.isBaselineDevice(session, device)) return false;
    const policy = this.store.getPlatform?.()?.devicePolicies?.[String(device.id || "")];
    const ownerMembershipId = String(device.tenantOwnerMembershipId || device.metadata?.tenantOwnerMembershipId || "");
    const managementClass = String(policy?.managementClass || device.managementClass || device.metadata?.managementClass || "").trim().toUpperCase();
    if (policy || ownerMembershipId || managementClass || device.metadata?.cloudDeviceId) return false;
    if ((this.store.listEvents?.(500) || []).some((event) => event?.type === "tenant_device_commissioned" && String(event.deviceId || "") === String(device.id))) return false;
    return true;
  }

  async finishExpiredStaffZigbeeReview(session) {
    if (session.expiryReviewPending !== true || session.radioOperationInFlight || session.radioOperationUncertain) return this.publicStatus(session);
    if (this.mqtt?.pairingStatus?.().active === true) {
      await this.mqtt.stopPairing?.().catch(() => {});
      if (this.mqtt?.pairingStatus?.().active === true) return this.publicStatus(session);
    }
    const pending = new Set(session.cleanup?.pendingIds || []);
    let retainedCount = 0;
    for (const candidate of session.candidates || []) {
      const device = this.store.getDevice(candidate.deviceId);
      if (this.canRetainExpiredStaffCandidate(session, candidate, device)) {
        candidate.registrationProvenance = { kind: "expired_staff_pairing_v1", identityHash: String(candidate.identityHash),
          identityGeneration: Number(session.identityGeneration), expiresAt: new Date(this.clock() + RECOVERABLE_PAIRING_MS).toISOString() };
        pending.delete(String(candidate.deviceId));
        retainedCount += 1;
      } else {
        pending.add(String(candidate.deviceId));
      }
    }
    session.expiryReviewPending = false;
    session.cleanup = { state: pending.size ? "PENDING" : retainedCount ? "PRESERVED_FOR_REVIEW" : "COMPLETE",
      pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0) };
    session.status = pending.size ? "expired_cleanup_pending" : "expired";
    this.append(session, retainedCount ? "expired_candidate_retained_for_registration" : "expired_candidate_cleanup_reconciled",
      { count: retainedCount, cleanupState: session.cleanup.state });
    await this.save(session);
    if (pending.size) {
      const inventoryResult = await this.reconcileMissingZigbeeCleanupFromInventory(session);
      if (inventoryResult === "continue_cleanup" || inventoryResult === "not_applicable") {
        session.cleanup.attempts = Number(session.cleanup.attempts || 0) + 1;
        await this.reconcileCleanupCandidates(session);
      }
    }
    return this.publicStatus(session);
  }

  pruneAdoptionCandidates() {
    const now = this.clock();
    for (const [ref, item] of this.adoptionCandidates) if (now >= item.expiresAt) this.adoptionCandidates.delete(ref);
    while (this.adoptionCandidates.size >= 256) this.adoptionCandidates.delete(this.adoptionCandidates.keys().next().value);
  }

  async listAdoptableDevices(principal) {
    const actor = await this.principal(principal);
    if (actor.actorType !== "STAFF_INSTALLER") fail(SAFE_ERROR.denied, 403, "Only current assigned installation staff can inspect unregistered property devices");
    return this.exclusive(async () => {
      this.pruneAdoptionCandidates();
      const actorHash = this.actorBinding(actor);
      const devices = [];
      for (const device of this.store.listDevices()) {
        const provenance = this.adoptionProvenance(actor, device);
        if (!provenance) continue;
        const candidateRef = crypto.randomUUID();
        this.adoptionCandidates.set(candidateRef, { actorHash, expiresAt: this.clock() + 5 * 60 * 1000, deviceId: String(device.id),
          protocol: String(device.protocol).toLowerCase(), protocolIdentityHash: provenance.protocolIdentityHash, originalAreaId: provenance.areaId,
          hubAreaId: provenance.hubAreaId, setupEventAt: provenance.setupEventAt });
        const area = actor.areaOptions.find((row) => String(row.id) === provenance.areaId);
        devices.push({ candidateRef, protocol: String(device.protocol).toLowerCase(), name: String(device.originalName || device.name || "Unidentified device").slice(0, 100),
          manufacturer: String(device.metadata?.manufacturer || device.metadata?.manufacturer_name || "").slice(0, 80),
          model: String(device.metadata?.model || device.metadata?.model_id || "").slice(0, 80),
          status: "not_registered", interviewStatus: "verified", originalAreaId: provenance.areaId, originalAreaName: String(area?.name || (provenance.areaId ? "Current authorized Area" : "Not assigned on this hub")),
          availableAreas: actor.areaOptions.map(({ id, name }) => ({ id, name })) });
      }
      return { schemaVersion: "dinodia.v1", operationKind: "REGISTER_EXISTING", devices: devices.slice(0, 100),
        completedDevices: this.completedPropertyDevices(actor), registrationEnabled: this.commissioningCapabilities.nativeStaffDeviceRegistrationV1 !== false };
    });
  }

  async listDashboardUnregisteredDevices(principal) {
    const platform = this.store.getPlatform?.() || {};
    const identity = await this.currentIdentity();
    if (!principal || principal.principalType !== "operator" || principal.scope?.length !== 1 || principal.scope[0] !== "os:admin"
      || !principal.sub || !principal.sid || !principal.jti || !principal.handoffId || !principal.workflow
      || !principal.employeeSessionId || !Number.isSafeInteger(Number(principal.workRevision)) || Number(principal.workRevision) < 1
      || !principal.homeId || String(platform.homeId || "") !== String(principal.homeId) || !platform.hubInstallId
      || !identity || !principal.hubId || String(principal.hubId) !== identity.serial
      || identity.generation !== Number(principal.identityGeneration)) {
      fail(SAFE_ERROR.denied, 403, "A current assigned full-dashboard authority is required");
    }
    const areas = this.store.listAreas?.() || [];
    const bindings = Array.isArray(platform.areaBindings) ? platform.areaBindings : [];
    const areaOptions = bindings.flatMap((binding) => {
      const area = areas.find((candidate) => String(candidate.id) === String(binding.hubAreaId));
      return area && /^[0-9a-f-]{36}$/i.test(String(binding.areaId || ""))
        ? [{ id: String(binding.areaId), name: String(area.name || "").slice(0, 120) }] : [];
    }).filter((area) => area.name);
    const actor = { actorType: "STAFF_INSTALLER", areaIds: areaOptions.map((area) => area.id) };
    const devices = [];
    for (const device of this.store.listDevices()) {
      const provenance = this.adoptionProvenance(actor, device);
      if (!provenance) continue;
      const area = areaOptions.find((row) => row.id === provenance.areaId);
      devices.push({ protocol: String(device.protocol).toLowerCase(), name: String(device.originalName || device.name || "Unidentified device").slice(0, 100),
        manufacturer: String(device.metadata?.manufacturer || device.metadata?.manufacturer_name || "").slice(0, 80),
        model: String(device.metadata?.model || device.metadata?.model_id || "").slice(0, 80),
        status: "not_registered", areaName: area?.name || "Current Home Area", available: device.available !== false,
        controls: Object.values(device.entities || {}).flatMap((entity) => {
          const capability = entity?.capability || {};
          return capability.category === "control" && (capability.readable === true || capability.writable === true)
            ? [{ name: String(capability.name || capability.semanticRole || entity.name || "Control").slice(0, 80), readable: capability.readable === true, writable: capability.writable === true }]
            : [];
        }).slice(0, 24) });
    }
    return { schemaVersion: "dinodia.v1", devices: devices.slice(0, 100) };
  }

  completedPropertyDevices(actor) {
    const platform = this.store.getPlatform?.() || {};
    const policies = platform.devicePolicies && typeof platform.devicePolicies === "object" ? platform.devicePolicies : {};
    const pendingPolicies = platform.pendingPropertyDevicePolicies && typeof platform.pendingPropertyDevicePolicies === "object" ? platform.pendingPropertyDevicePolicies : {};
    const outbox = this.store.getSyncOutbox?.() || {};
    const ack = Number(outbox.acknowledgedSequence || 0);
    const pendingEvents = [...(Array.isArray(outbox.events) ? outbox.events : []), ...(Array.isArray(outbox.inFlight?.events) ? outbox.inFlight.events : [])];
    const result = [];
    for (const [osDeviceId, policy] of Object.entries(policies)) {
      if (policy?.managementClass !== "PROPERTY_DEVICE" || String(policy.installationRequestId || "") !== actor.requestId
        || !/^[a-f0-9-]{36}$/i.test(String(policy.platformDeviceId || ""))
        || !["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle || ""))) continue;
      const device = this.store.getDevice(osDeviceId);
      if (!device || String(device.metadata?.cloudDeviceId || "") !== String(policy.platformDeviceId)) continue;
      const areaId = Array.isArray(policy.canonicalAreaIds) ? String(policy.canonicalAreaIds[0] || "") : "";
      const area = actor.areaOptions.find((row) => String(row.id) === areaId);
      const hasPendingEvent = pendingEvents.some((event) => Number(event.sequence) > ack
        && ["device.upsert", "control.catalog.upsert"].includes(String(event.type)) && String(event.aggregateId || "") === osDeviceId);
      const syncState = pendingPolicies[osDeviceId] || hasPendingEvent ? "pending" : "acknowledged";
      result.push({ name: String(policy.overrideName || policy.customerLabel || device.name || "Permanent device").slice(0, 80),
        model: String(device.metadata?.model || device.metadata?.model_id || "").slice(0, 80),
        protocol: String(device.protocol || "").toUpperCase(), areaName: String(area?.name || "Authorized Area"),
        lifecycle: String(policy.lifecycle), catalogueStatus: String(policy.catalogueStatus || "unknown"), analyticsCategory: String(policy.analyticsCategory || "NONE"), sync: syncState,
        analyticsReadiness: require('../analytics/readiness').analyticsReadiness(this.store, device, policy),
        completedAt: String(device.updatedAt || "") });
    }
    return result.slice(0, 100);
  }

  async updateAnalyticsCategory(principal, input) {
    const selectionKeys = ['selectedControlId', 'expectedSelectedControlId'].filter(key => Object.hasOwn(input || {}, key));
    if (selectionKeys.length && (selectionKeys.length !== 2 || selectionKeys.some(key => input[key] !== null && !/^[A-Za-z0-9:_./-]{1,160}$/.test(String(input[key]))))) {
      fail(SAFE_ERROR.invalid, 400, 'Choose one exact analytics source and its current revision');
    }
    const platform = this.store.getPlatform?.() || {};
    const identity = await this.currentIdentity();
    const osDeviceId = String(input?.osDeviceId || "");
    const analyticsCategory = String(input?.analyticsCategory || "");
    const expectedAnalyticsCategory = String(input?.expectedAnalyticsCategory || "");
    const expectedManagementRevision = Number(input?.expectedManagementRevision);
    const expectedInventoryRevision = input?.expectedInventoryRevision === undefined ? null : Number(input.expectedInventoryRevision);
    const operationId = String(input?.operationId || "");
    if (!principal || principal.principalType !== "operator" || principal.scope?.length !== 1 || principal.scope[0] !== "os:admin"
      || !principal.sub || !principal.sid || !principal.jti || !principal.handoffId || !principal.workflow || !principal.employeeSessionId
      || !Number.isSafeInteger(Number(principal.workRevision)) || Number(principal.workRevision) < 1
      || !principal.homeId || !identity || String(principal.hubId || "") !== identity.serial
      || Number(principal.identityGeneration) !== identity.generation || String(platform.homeId || "") !== String(principal.homeId)
      || !platform.hubInstallId || String(principal.verifiedHubInstallationId || "") !== String(platform.hubInstallId)
      || !/^[A-Za-z0-9:_-]{1,160}$/.test(osDeviceId)
      || !new Set(["NONE", "LIGHT", "BOILER", "RADIATOR"]).has(analyticsCategory)
      || !new Set(["NONE", "LIGHT", "BOILER", "RADIATOR"]).has(expectedAnalyticsCategory)
      || !Number.isSafeInteger(expectedManagementRevision) || expectedManagementRevision < 1
      || !Number.isSafeInteger(Number(platform.cloudRevision))
      || ![expectedManagementRevision, expectedManagementRevision + 1].includes(Number(platform.cloudRevision))
      || expectedInventoryRevision !== null && (!Number.isSafeInteger(expectedInventoryRevision) || expectedInventoryRevision < 1)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      fail(SAFE_ERROR.denied, 403, "Current assigned full-Home authority and the latest signed device policy are required");
    }
    const policy = platform.devicePolicies?.[osDeviceId];
    if (policy?.managementClass !== "PROPERTY_DEVICE" || policy.ownerMembershipId != null
      || !["INSTALLED", "VIEW_ONLY"].includes(String(policy.lifecycle || ""))
      || !Array.isArray(policy.canonicalAreaIds) || !policy.canonicalAreaIds.length) {
      fail(SAFE_ERROR.denied, 404, "Analytics categories can only be set for a current permanent property device");
    }
    const signedCategory = String(policy.analyticsCategory || "NONE");
    const signedInventoryRevision = Number(policy.inventoryRevision);
    const replayAfterSignedRefresh = Number(platform.cloudRevision) === expectedManagementRevision + 1 && signedCategory === analyticsCategory
      && (expectedInventoryRevision === null || Number.isSafeInteger(signedInventoryRevision) && signedInventoryRevision === expectedInventoryRevision + 1);
    const requestStillCurrent = Number(platform.cloudRevision) === expectedManagementRevision && signedCategory === expectedAnalyticsCategory
      && (expectedInventoryRevision === null || Number.isSafeInteger(signedInventoryRevision) && signedInventoryRevision === expectedInventoryRevision);
    if (!requestStillCurrent && !replayAfterSignedRefresh) {
      console.warn("[commissioning] analytics_category_revision_conflict", JSON.stringify({
        expectedManagementRevision, currentManagementRevision: Number(platform.cloudRevision),
        expectedAnalyticsCategory, currentAnalyticsCategory: signedCategory,
        expectedInventoryRevision, currentInventoryRevision: Number.isSafeInteger(signedInventoryRevision) ? signedInventoryRevision : null,
        replayAfterSignedRefresh,
      }));
      fail(SAFE_ERROR.conflict, 409, "The Home or device changed. Refresh its signed policy and review the category again");
    }
    if (!this.pairing?.requestWithHubIdentity) fail(SAFE_ERROR.unavailable, 503, "The enrolled Platform connection is unavailable");
    let result;
    try {
      result = await this.pairing.requestWithHubIdentity("/api/hub-agent/v2/permanent-device-analytics-category", {
        accessScope: "os:admin", homeId: String(platform.homeId), hubInstallationId: String(platform.hubInstallId), identityGeneration: identity.generation,
        employeeId: String(principal.sub), employeeSessionId: String(principal.employeeSessionId), operatorHandoffId: String(principal.handoffId),
        operatorJti: String(principal.jti), workItemId: String(principal.workflow), workRevision: Number(principal.workRevision),
        osDeviceId, expectedManagementRevision,
        ...(expectedInventoryRevision === null ? {} : { expectedInventoryRevision }),
        expectedAnalyticsCategory, analyticsCategory, operationId,
        ...(selectionKeys.length ? { selectedControlId: input.selectedControlId, expectedSelectedControlId: input.expectedSelectedControlId } : {}),
      });
    } catch (error) {
      // A conflict means the signed Home snapshot was stale. Refresh it before
      // the dashboard's follow-up GET, while preserving the original conflict
      // and exact operation payload for the operator to review/retry.
      if (error?.statusCode === 409 && error?.code === "analytics_category_revision_conflict") {
        if (typeof this.pairing.syncNow === "function") await this.pairing.syncNow().catch(() => {});
      }
      throw error;
    }
    if (!result?.ok || result.analyticsCategory !== analyticsCategory || !Number.isSafeInteger(Number(result.managementRevision))) {
      fail(SAFE_ERROR.unavailable, 503, "Platform did not confirm the requested category for this permanent property device");
    }
    // The first successful Platform response is not enough to claim that the
    // hub has applied the new signed device policy. On an exact retry after a
    // fresh signed snapshot, however, replayAfterSignedRefresh proves that
    // this operation's category and inventory revision are now in the hub's
    // current policy; do not leave the UI stuck in a permanent pending state.
    return { ...result, signedConfigurationPending: !replayAfterSignedRefresh };
  }

  async platform(action, session, extra = {}) {
    if (!this.pairing?.requestWithHubIdentity) fail(SAFE_ERROR.unavailable, 503, "The enrolled Platform connection is unavailable");
    const actor = session.actorType === "STAFF_INSTALLER" ? {
      actorType: "STAFF_INSTALLER", employeeId: session.employeeId, employeeSessionId: session.employeeSessionId,
      operatorHandoffId: session.operatorHandoffId, operatorJti: session.operatorJti, workItemId: session.workItemId,
      workRevision: session.workRevision, requestId: session.requestId,
    } : {
      membershipId: session.ownerMembershipId, accountId: session.requesterAccountId, customerSessionId: session.requesterSessionId,
      trustedDeviceId: session.requesterTrustedDeviceId, accessTokenHash: session.requesterTokenHash,
    };
    const result = await this.pairing.requestWithHubIdentity("/api/hub-agent/v2/commissioning-sessions", {
      action, sessionId: session.sessionId, homeId: session.homeId, hubInstallationId: session.hubInstallationId, ...actor,
      identityGeneration: session.identityGeneration, protocol: session.protocol, expiresAt: session.expiresAt,
      operationKind: session.operationKind || "PAIR_NEW",
      ...(session.operationKind === "REGISTER_EXISTING" ? { candidateRef: session.targetCandidateRef, targetOsDeviceId: session.targetDeviceId,
        targetIdentityHash: session.targetIdentityHash } : {}),
      expectedRevision: session.expectedPlatformRevision || 1, ...extra,
    });
    if (Number.isInteger(Number(result?.revision))) session.expectedPlatformRevision = Number(result.revision);
    return result;
  }

  append(session, type, detail = {}) {
    session.revision += 1; session.updatedAt = new Date(this.clock()).toISOString();
    session.events.push({ sequence: session.events.length + 1, type, at: session.updatedAt, ...detail });
    session.events = session.events.slice(-80);
  }

  publicStatus(session, afterCandidateRef = null) {
    const safe = { schemaVersion: "dinodia.v1", ...fixedSession(session, afterCandidateRef) };
    if (session.protocol === "zigbee" && session.operationKind !== "REGISTER_EXISTING") {
      const pairing = this.mqtt?.pairingStatus?.() || {};
      safe.joinWindowOpen = pairing.permitJoinOpen === true;
      if (Number.isFinite(Date.parse(String(pairing.permitJoinExpiresAt || "")))) safe.permitJoinExpiresAt = String(pairing.permitJoinExpiresAt);
    }
    return safe;
  }

  async reconcileClosedEmptyAssignedZigbeeSessions(actor) {
    if (actor.actorType !== "STAFF_INSTALLER") return;
    const radio = this.mqtt?.pairingStatus?.() || {};
    const deadlinePassed = Number.isFinite(Date.parse(String(radio.permitJoinExpiresAt || "")))
      && Date.parse(radio.permitJoinExpiresAt) <= this.clock();
    if (radio.permitJoinOpen !== false || !deadlinePassed) return;
    const currentAreas = [...new Set(actor.areaIds || [])].map(String).sort();
    for (const session of Object.values(this.sessions())) {
      if (session.actorType !== "STAFF_INSTALLER" || session.operationKind !== "PAIR_NEW" || session.protocol !== "zigbee"
        || !["searching", "advertising"].includes(String(session.status || ""))
        || String(session.employeeId || "") !== String(actor.employeeId || "")
        || String(session.workItemId || "") !== String(actor.workItemId || "")
        || String(session.requestId || "") !== String(actor.requestId || "")
        || Number(session.workRevision) !== Number(actor.workRevision)
        || String(session.homeId || "") !== String(actor.homeId || "")
        || String(session.hubInstallationId || "") !== String(actor.hubInstallationId || "")
        || Number(session.identityGeneration) !== Number(actor.identityGeneration)
        || JSON.stringify([...(session.allowedAreaIds || [])].map(String).sort()) !== JSON.stringify(currentAreas)
        || session.radioOperationInFlight || session.radioOperationUncertain
        || session.cleanup?.pendingIds?.length || ["AWAITING_RADIO_SETTLEMENT", "REQUIRES_RADIO_RECONCILIATION"].includes(String(session.cleanup?.state || ""))) continue;
      // Pull only this work item's baseline-protected candidates into its own
      // record before deciding whether an empty expired attempt can be closed.
      await this.refreshCandidates(session, actor);
      if ((session.candidates || []).length) continue;
      await this.expire(session);
    }
  }

  async start(principal, input, idempotencyKey) {
    const actor = await this.principal(principal);
    if (!input || !["zigbee", "matter"].includes(String(input.protocol))) fail(SAFE_ERROR.invalid, 400, "Choose a supported native commissioning protocol");
    const operationKind = input.operationKind || "PAIR_NEW";
    if (!["PAIR_NEW", "REGISTER_EXISTING"].includes(operationKind)) fail(SAFE_ERROR.invalid, 400, "Choose a supported permanent-device operation");
    if (operationKind === "REGISTER_EXISTING" && actor.actorType !== "STAFF_INSTALLER") fail(SAFE_ERROR.denied, 403, "Existing radio devices are visible only to current assigned installation staff");
    const candidateRef = operationKind === "REGISTER_EXISTING" ? String(input.candidateRef || "") : "";
    if (operationKind === "REGISTER_EXISTING" && !/^[0-9a-f-]{36}$/i.test(candidateRef)) fail(SAFE_ERROR.invalid, 400, "Refresh the assigned local-device list before registration");
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(String(idempotencyKey || ""))) fail(SAFE_ERROR.invalid, 400, "A valid commissioning operation key is required");
    const bodyHash = digest(JSON.stringify({ operationKind, protocol: input.protocol, ...(operationKind === "REGISTER_EXISTING" ? { candidateRef } : {}) }));
    const keyHash = digest(`${actor.actorType}\n${actor.accountId || actor.employeeId}\n${actor.customerSessionId || actor.employeeSessionId}\n${actor.membershipId || actor.operatorHandoffId}\n${idempotencyKey}`);
    return this.exclusive(async () => {
      const prior = Object.values(this.sessions()).find((row) => row.idempotencyHash === keyHash);
      if (prior) {
        if (prior.requestHash !== bodyHash || prior.operationKind !== operationKind || prior.actorType !== actor.actorType || prior.requesterAccountId !== actor.accountId || prior.ownerMembershipId !== actor.membershipId
          || prior.employeeId !== actor.employeeId || prior.operatorHandoffId !== actor.operatorHandoffId || prior.requestId !== actor.requestId) fail(SAFE_ERROR.conflict, 409, "This operation key was already used for another commissioning request", "idempotency_key_reused");
        if (prior.status === "creating" && prior.platformCreatePending === true) await this.establishPlatformSession(prior);
        if (Date.parse(prior.expiresAt) <= this.clock() && !TERMINAL.has(prior.status)) await this.expire(prior);
        return this.publicStatus(this.sessions()[prior.sessionId] || prior);
      }
      if (actor.actorType === "STAFF_INSTALLER" && this.commissioningCapabilities.nativeStaffDeviceRegistrationV1 !== true) {
        fail(SAFE_ERROR.unavailable, 503, "Permanent-device registration is held by the current staff maintenance policy");
      }
      const capability = actor.actorType === "STAFF_INSTALLER"
        ? input.protocol === "zigbee" ? "nativeStaffZigbeeCommissioningV1" : "nativeStaffMatterCommissioningV1"
        : input.protocol === "zigbee" ? "nativeZigbeeCommissioningV1" : "nativeMatterCommissioningV1";
      if (operationKind === "PAIR_NEW" && this.commissioningCapabilities[capability] !== true) {
        fail(SAFE_ERROR.unavailable, 503, "This protocol is disabled for this hub by its current operational configuration");
      }
      if (operationKind === "PAIR_NEW" && input.protocol === "zigbee") await this.reconcileClosedEmptyAssignedZigbeeSessions(actor);
      let adoption = null;
      if (operationKind === "REGISTER_EXISTING") {
        this.pruneAdoptionCandidates();
        adoption = this.adoptionCandidates.get(candidateRef) || null;
        if (!adoption || adoption.actorHash !== this.actorBinding(actor) || adoption.protocol !== input.protocol) fail(SAFE_ERROR.denied, 404, "This local device review has expired; refresh the device list");
        const device = this.store.getDevice(adoption.deviceId);
        const provenance = this.adoptionProvenance(actor, device);
        if (!provenance || provenance.protocolIdentityHash !== adoption.protocolIdentityHash || provenance.areaId !== adoption.originalAreaId) {
          fail(SAFE_ERROR.conflict, 409, "This local device or its current ownership/interview evidence changed; refresh before continuing", "adoption_evidence_changed");
        }
      }
      const priorSessions = Object.values(this.sessions());
      if (priorSessions.some((row) => row.cleanup?.pendingIds?.length)) {
        fail(SAFE_ERROR.busy, 409, "The hub is reconciling a previous radio cleanup against the current adapter inventory. No new search was started; wait briefly and retry.", "radio_cleanup_pending");
      }
      if (priorSessions.some((row) => this.blocksRadioOperation(row))) {
        fail(SAFE_ERROR.busy, 409, "Another radio commissioning operation is still active on this hub", "radio_operation_active");
      }
      if (operationKind === "PAIR_NEW" && this.mqtt?.pairingStatus?.().active === true) {
        fail(SAFE_ERROR.busy, 409, "A Zigbee join window is still active on this hub; no second radio operation was started", "zigbee_join_window_active");
      }
      if (operationKind === "PAIR_NEW" && input.protocol === "zigbee") {
        if (!this.mqtt?.status?.().connected || !this.store.getZigbee?.().adapterPath) fail(SAFE_ERROR.unavailable, 503, "The enrolled Zigbee coordinator is not ready; no join was opened");
        if (this.mqtt.pairingStatus?.().active) fail(SAFE_ERROR.busy, 409, "Another Zigbee pairing session is already active on this hub", "zigbee_join_window_active");
      } else if (operationKind === "PAIR_NEW" && !this.matter?.status?.().connected) fail(SAFE_ERROR.unavailable, 503, "The enrolled Matter commissioning controller is unavailable; no setup payload was accepted");
      const now = this.clock(); const sessionId = crypto.randomUUID();
      const existingDevice = adoption ? this.store.getDevice(adoption.deviceId) : null;
      const platformRequest = { operationKind, protocol: input.protocol, ...(adoption ? { candidateRef, targetOsDeviceId: adoption.deviceId, targetIdentityHash: adoption.protocolIdentityHash } : {}) };
      const session = {
        sessionId, protocol: input.protocol, operationKind, actorType: actor.actorType, requesterAccountId: actor.accountId, requesterSessionId: actor.customerSessionId,
        requesterTokenId: actor.tokenId, requesterTrustedDeviceId: actor.trustedDeviceId, requesterTokenHash: actor.accessTokenHash,
        ownerMembershipId: actor.membershipId, homeId: actor.homeId, hubInstallationId: actor.hubInstallationId,
        ...(actor.actorType === "STAFF_INSTALLER" ? { employeeId: actor.employeeId, employeeSessionId: actor.employeeSessionId, operatorHandoffId: actor.operatorHandoffId, operatorJti: actor.operatorJti, workItemId: actor.workItemId, workRevision: actor.workRevision, requestId: actor.requestId, areaOptions: actor.areaOptions } : {}),
        identityGeneration: actor.identityGeneration, allowedAreaIds: actor.areaIds,
        status: "creating", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(),
        revision: 1, expectedPlatformRevision: 1, idempotencyHash: keyHash, requestHash: bodyHash, platformRequestHash: digest(JSON.stringify(platformRequest)), platformCreatePending: true,
        baselineDeviceIds: this.store.listDevices().map((device) => String(device.id)),
        baselineIdentityHashes: this.store.listDevices().map((device) => digest(String(device.protocolIdentity?.ieeeAddress || device.protocolIdentity?.nodeId || device.metadata?.ieee_address || device.id))),
        ...(adoption ? { targetCandidateRef: candidateRef, targetDeviceId: adoption.deviceId, targetIdentityHash: adoption.protocolIdentityHash,
          targetDescriptorRevision: Number(existingDevice?.presentation?.descriptorRevision || 0), targetDescriptorDigest: digest(JSON.stringify(existingDevice?.entities || {})),
          targetOriginalAreaId: adoption.originalAreaId, targetSetupEventAt: adoption.setupEventAt } : {}),
        candidates: adoption ? [{ candidateRef, deviceId: adoption.deviceId, identityHash: adoption.protocolIdentityHash,
          name: String(existingDevice?.originalName || existingDevice?.name || "Device").slice(0, 80),
          manufacturer: String(existingDevice?.metadata?.manufacturer || existingDevice?.metadata?.manufacturer_name || "").slice(0, 80),
          model: String(existingDevice?.metadata?.model || existingDevice?.metadata?.model_id || "").slice(0, 80), stage: "existing_interview_verified", observedAt: new Date(now).toISOString() }] : [],
        selectedCandidateRef: null, finalDeviceId: null, cleanup: { state: "NONE", pendingIds: [], attempts: 0 }, events: [], createdByToken: actor.tokenId,
      };
      await this.save(session);
      if (adoption) this.adoptionCandidates.delete(candidateRef);
      return this.publicStatus(await this.establishPlatformSession(session));
    });
  }

  async establishPlatformSession(session) {
    if (!session.platformCreatePending) return session;
    try {
      const cloud = await this.platform("create", session, { idempotencyHash: session.idempotencyHash, requestHash: session.platformRequestHash });
      if (!/^[0-9a-f-]{36}$/i.test(String(cloud.sessionId || "")) || !Number.isFinite(Date.parse(String(cloud.expiresAt || "")))) fail(SAFE_ERROR.unavailable, 503, "Platform did not confirm the commissioning session");
      if (String(cloud.sessionId) !== String(session.sessionId)) {
        if (Object.values(this.sessions()).some((row) => row.sessionId === String(cloud.sessionId))) fail(SAFE_ERROR.conflict, 409, "The Platform session is already bound to another local operation", "platform_session_collision");
        const sessions = { ...this.sessions() }; delete sessions[session.sessionId];
        session.sessionId = String(cloud.sessionId);
        await this.store.saveSecurity({ nativeCommissioningSessions: { ...sessions, [session.sessionId]: session } });
      }
      session.expiresAt = String(cloud.expiresAt);
      session.expectedPlatformRevision = Number(cloud.revision || 1);
      session.platformCreatePending = false;
      session.platformCreated = true;
      await this.save(session);
      if (session.operationKind === "REGISTER_EXISTING") {
        session.status = "reviewing_existing";
        this.append(session, "existing_device_review_started", { protocol: session.protocol });
        await this.save(session);
        return session;
      }
      if (session.protocol === "zigbee") {
        await this.mqtt.startPairing(254, { sessionId: session.sessionId, sessionExpiresAt: session.expiresAt });
        session.status = "searching";
      } else {
        session.status = "awaiting_payload";
      }
      this.append(session, "session_started", { protocol: session.protocol });
      await this.save(session);
      if (session.protocol === "zigbee") {
        await this.platform("transition", session, { status: "ADVERTISING" });
        // Store snapshots are detached: the cloud revision changed by the
        // acknowledgement must survive the next browser request/restart.
        await this.save(session);
      }
      return session;
    } catch (error) {
      // Keep the exact operation and fixed expiry so an identical retry can
      // reconcile a lost Platform response without issuing a second join.
      if (!session.platformCreated) {
        session.platformCreatePending = true;
        session.status = "creating";
        session.failureCode = "platform_confirmation_pending";
        await this.save(session).catch(() => {});
      } else {
        session.failureCode = "commissioning_radio_start_failed";
        await this.closeSession(session, "failed").catch(() => {});
      }
      throw error;
    }
  }

  async requireSession(sessionId, principal) {
    const actor = await this.principal(principal);
    const session = this.sessions()[String(sessionId)];
    const tenantBinding = actor.actorType === "TENANT" && session?.actorType !== "STAFF_INSTALLER"
      && session?.requesterAccountId === actor.accountId && session?.requesterSessionId === actor.customerSessionId
      && session?.requesterTrustedDeviceId === actor.trustedDeviceId && session?.ownerMembershipId === actor.membershipId;
    const staffBinding = actor.actorType === "STAFF_INSTALLER" && session?.actorType === "STAFF_INSTALLER"
      && session?.employeeId === actor.employeeId && session?.employeeSessionId === actor.employeeSessionId && session?.operatorHandoffId === actor.operatorHandoffId
      && session?.operatorJti === actor.operatorJti && session?.workItemId === actor.workItemId && session?.workRevision === actor.workRevision && session?.requestId === actor.requestId;
    if (!session || !(tenantBinding || staffBinding) || session.homeId !== actor.homeId || session.hubInstallationId !== actor.hubInstallationId) fail(SAFE_ERROR.denied, 404, "The commissioning session is not available to this current authority");
    if (!TERMINAL.has(session.status) && Date.parse(session.expiresAt) <= this.clock()) {
      await this.expire(session);
      fail(SAFE_ERROR.expired, 410, "This commissioning session expired and its cleanup is being reconciled");
    }
    return { actor, session };
  }

  async status(sessionId, principal, afterSequence = 0, afterCandidateRef = null) {
    return this.exclusive(async () => {
      const { session, actor } = await this.requireSession(sessionId, principal);
      await this.refreshCandidates(session, actor);
      const radio = session.protocol === "zigbee" ? this.mqtt?.pairingStatus?.() || {} : {};
      const joinDeadlinePassed = Number.isFinite(Date.parse(String(radio.permitJoinExpiresAt || "")))
        && Date.parse(radio.permitJoinExpiresAt) <= this.clock();
      // The radio's short join window and the tracked commissioning record
      // have different lifetimes. Close only this exact, empty assigned
      // operation after Zigbee2MQTT confirms joining is closed; candidates
      // remain in their existing review session and uncertain writes block.
      if (actor.actorType === "STAFF_INSTALLER" && session.operationKind === "PAIR_NEW" && session.protocol === "zigbee"
        && session.status === "searching" && radio.permitJoinOpen === false && joinDeadlinePassed
        && !(session.candidates || []).length && !session.radioOperationInFlight && !session.radioOperationUncertain) {
        await this.expire(session);
      }
      const safe = this.publicStatus(session, afterCandidateRef);
      safe.events = safe.events.filter((event) => Number(event.sequence) > Number(afterSequence)).slice(0, 40);
      return safe;
    });
  }

  async refreshCandidates(session, actor = null) {
    if (TERMINAL.has(session.status)) return;
    if (session.operationKind === "REGISTER_EXISTING") {
      const device = this.store.getDevice(session.targetDeviceId);
      if (!actor || !this.isCompleteRadioDevice(session, device, actor)) fail(SAFE_ERROR.conflict, 409, "The existing device changed or is no longer eligible; return to the assigned device list", "adoption_candidate_changed");
      return;
    }
    const devices = session.protocol === "zigbee"
      ? (this.mqtt.pairingStatus?.().found || []).map((id) => this.store.getDevice(String(id))).filter(Boolean)
      : this.store.listDevices().filter((device) => device.protocol === "matter" && !this.isBaselineDevice(session, device));
    let changed = false;
    for (const device of devices) {
      if (this.isBaselineDevice(session, device)) continue;
      const existing = session.candidates.find((item) => item.deviceId === String(device.id));
      const current = {
        name: String(device.originalName || device.name || "New device").slice(0, 80),
        manufacturer: String(device.metadata?.manufacturer || device.metadata?.manufacturer_name || "").slice(0, 80),
        model: String(device.metadata?.model || device.metadata?.model_id || "").slice(0, 80),
        stage: String(device.setup?.status || "interviewing").slice(0, 40),
        interviewStatus: String(device.interviewStatus || "").slice(0, 40),
      };
      if (existing) {
        for (const [key, value] of Object.entries(current)) {
          if (existing[key] !== value) { existing[key] = value; changed = true; }
        }
        continue;
      }
      if (session.candidates.length >= MAX_TOTAL_CANDIDATES) break;
      session.candidates.push({ candidateRef: crypto.randomUUID(), deviceId: String(device.id), identityHash: this.candidateIdentityHash(device), ...current, observedAt: new Date(this.clock()).toISOString() });
      changed = true;
    }
    if (changed) {
      this.append(session, "candidate_discovered", { count: session.candidates.length });
      await this.save(session);
    }
  }

  isQuarantinedDevice(deviceId) {
    const id = String(deviceId || "");
    const device = this.store.getDevice(id);
    const policy = this.store.getPlatform?.()?.devicePolicies?.[id] || null;
    return Object.values(this.sessions()).some((session) => {
      if (session.operationKind === "REGISTER_EXISTING") return false;
      const exactCandidate = (session.candidates || []).find((candidate) => String(candidate.deviceId) === id);
      const isExactCandidate = Boolean(exactCandidate);
      const isPending = (session.cleanup?.pendingIds || []).some((pendingId) => String(pendingId) === id);
      if (exactCandidate?.registrationProvenance?.kind === "expired_staff_pairing_v1"
        && Date.parse(exactCandidate.registrationProvenance.expiresAt) > this.clock()) return !hasCurrentCanonicalDevicePolicy(policy);
      if (session.cleanup?.state === "PRESERVED_FOR_REVIEW" && isExactCandidate) return !hasCurrentCanonicalDevicePolicy(policy);
      return session.status !== "completed" && (isExactCandidate || isPending
        || (device && String(device.protocol || "").toLowerCase() === session.protocol && !this.isBaselineDevice(session, device)));
    });
  }

  isBaselineDevice(session, device) {
    const id = String(device?.id || "");
    const identityHash = this.candidateIdentityHash(device);
    return (session.baselineDeviceIds || []).map(String).includes(id) || (session.baselineIdentityHashes || []).includes(identityHash);
  }

  canonicalArea(actor, areaId) {
    const requested = String(areaId || "");
    if (!actor.areaIds.includes(requested)) fail(SAFE_ERROR.denied, 403, "Choose an Area currently granted to this tenant");
    const matches = (this.store.getPlatform?.()?.areaBindings || []).filter((row) => String(row.areaId || "") === requested);
    if (matches.length !== 1 || !matches[0].hubAreaId) fail(SAFE_ERROR.denied, 403, "The selected Area is not mapped to this enrolled hub");
    if (actor.actorType === "STAFF_INSTALLER") {
      const localArea = (this.store.listAreas?.() || []).find((area) => String(area.id || "") === String(matches[0].hubAreaId));
      const canonicalAreaName = actor.areaOptions?.find((area) => String(area.id) === requested)?.name;
      if (!localArea || !canonicalAreaName || String(localArea.name || "").normalize("NFC").trim() !== String(canonicalAreaName).normalize("NFC").trim()) {
        fail(SAFE_ERROR.denied, 403, "The selected original Area is not mapped to a matching current Area on this hub");
      }
    }
    return { areaId: requested, hubAreaId: String(matches[0].hubAreaId) };
  }

  async matterPayload(sessionId, principal, encoded) {
    return this.exclusive(async () => {
      const { session } = await this.requireSession(sessionId, principal);
      if (session.protocol !== "matter" || !["awaiting_payload", "interrupted"].includes(session.status) || session.matterPayloadSubmittedAt) fail(SAFE_ERROR.conflict, 409, "This Matter attempt already has setup material; cancel it and start a new session to recover", "matter_payload_already_submitted");
      if (typeof encoded !== "string" || encoded.length < 20 || encoded.length > MATTER_QR_CODE_SINGLE_PAYLOAD_MAX_LENGTH || !/^MT:[0-9A-Z.*-]+$/iu.test(encoded)) fail(SAFE_ERROR.invalid, 400, "Scan a valid Matter setup QR code");
      let decoded;
      try { decoded = QrPairingCodeCodec.decode(encoded, true); } catch { fail(SAFE_ERROR.invalid, 400, "This QR code is not a valid Matter commissioning code"); }
      if (!Array.isArray(decoded) || decoded.length !== 1 || !isValidPasscode(Number(decoded[0]?.passcode))
        || !Number.isInteger(Number(decoded[0]?.discriminator)) || Number(decoded[0].discriminator) < 0 || Number(decoded[0].discriminator) > 4095) fail(SAFE_ERROR.invalid, 400, "This QR code does not contain one supported Matter setup payload");
      await this.vault.set(`commissioning.matter.${session.sessionId}`, encoded);
      session.matterPayloadSubmittedAt = new Date(this.clock()).toISOString();
      session.radioOperationInFlight = true;
      session.status = "commissioning"; this.append(session, "matter_payload_accepted"); await this.save(session);
      await this.platform("transition", session, { status: "ADVERTISING" });
      await this.save(session);
      this.runMatterCommissioning(session.sessionId).catch(() => {});
      return this.publicStatus(session);
    });
  }

  async runMatterCommissioning(sessionId) {
    const first = this.sessions()[String(sessionId)];
    if (!first || first.protocol !== "matter" || first.status !== "commissioning") return;
    if (Date.parse(first.expiresAt) <= this.clock()) {
      await this.exclusive(async () => {
        const current = this.sessions()[String(sessionId)];
        if (current) { current.radioOperationInFlight = false; await this.expire(current); }
      });
      return;
    }
    const payload = this.vault.get(`commissioning.matter.${first.sessionId}`);
    if (!payload) {
      await this.exclusive(async () => { const current = this.sessions()[first.sessionId]; if (current) { current.radioOperationInFlight = false; await this.markInterrupted(current, "setup_payload_unavailable"); } });
      return;
    }
    try {
      await this.matter.commission(payload, false);
      await this.matter.refresh?.({ allowNew: true });
      await this.exclusive(async () => {
        const session = this.sessions()[first.sessionId];
        if (!session) return;
        session.radioOperationInFlight = false;
        if (TERMINAL.has(session.status)) {
          await this.collectMatterCleanupCandidates(session);
          await this.reconcileCleanupCandidates(session);
          return;
        }
        if (Date.parse(session.expiresAt) <= this.clock()) {
          await this.expire(session);
          await this.collectMatterCleanupCandidates(session);
          await this.reconcileCleanupCandidates(session);
          return;
        }
        session.status = "searching"; this.append(session, "radio_commissioning_observed");
        await this.refreshCandidates(session); await this.save(session);
      });
    } catch {
      await this.exclusive(async () => {
        const session = this.sessions()[first.sessionId]; if (!session) return;
        session.radioOperationInFlight = false;
        await this.matter.refresh?.({ allowNew: true }).catch(() => {});
        if (TERMINAL.has(session.status)) {
          await this.collectMatterCleanupCandidates(session);
          await this.reconcileCleanupCandidates(session);
          return;
        }
        session.failureCode = "matter_commissioning_failed";
        await this.collectMatterCleanupCandidates(session);
        await this.closeSession(session, "failed").catch(() => {});
      });
      await this.vault.delete(`commissioning.matter.${first.sessionId}`).catch(() => {});
    }
  }

  async select(sessionId, principal, input) {
    return this.exclusive(async () => {
      const { session, actor } = await this.requireSession(sessionId, principal);
      const requiredKeys = ["areaId", "candidateRef", "customerLabel", "expectedRevision", "name", "schemaVersion"];
      const keys = Object.keys(input || {}).sort().join("\n");
      const legacyKeys = [...requiredKeys].sort().join("\n");
      const categoryKeys = [...requiredKeys, "analyticsCategory"].sort().join("\n");
      if (!input || ![legacyKeys, categoryKeys].includes(keys) || input.schemaVersion !== "dinodia.v1" || Number(input.expectedRevision) !== Number(session.revision)) fail(SAFE_ERROR.conflict, 409, "The discovered device list changed; refresh and select again", "candidate_list_revision_changed");
      const candidate = session.candidates.find((row) => row.candidateRef === input.candidateRef);
      if (!candidate) fail(SAFE_ERROR.denied, 404, "This discovered device is no longer available in this session");
      const area = this.canonicalArea(actor, input.areaId);
      const name = String(input.name || "").normalize("NFC").trim();
      const label = input.customerLabel == null || input.customerLabel === "" ? null : String(input.customerLabel).normalize("NFC").trim();
      const analyticsCategory = input.analyticsCategory === undefined ? "NONE" : String(input.analyticsCategory);
      if (!new Set(["NONE", "LIGHT", "BOILER", "RADIATOR"]).has(analyticsCategory)
        || actor.actorType !== "STAFF_INSTALLER" && analyticsCategory !== "NONE") fail(SAFE_ERROR.invalid, 400, "Choose an optional analytics category for a permanent property device");
      if (!text(name, 80) || label === null || !text(label, 40) || !label) fail(SAFE_ERROR.invalid, 400, "Enter a customer label between 1 and 40 characters");
      const device = this.store.getDevice(candidate.deviceId);
      if (!this.isCompleteRadioDevice(session, device, actor)) fail(SAFE_ERROR.unavailable, 409, "The hub has not completed the device interview or ownership review yet", "candidate_interview_incomplete");
      const catalogue = buildPublicCommissioningCatalogue({ device, homeId: actor.homeId, membershipId: actor.membershipId, managementClass: actor.actorType === "STAFF_INSTALLER" ? "property_device" : "tenant_device", areaId: area.areaId,
        name: name || undefined, customerLabel: label, now: this.clock() });
      if (!catalogue) fail(SAFE_ERROR.unavailable, 409, "The hub could not produce a safe device catalogue", "candidate_catalogue_unavailable");
      const reviewed = { ...session, events: [...session.events], selectedCandidateRef: candidate.candidateRef, selectedDeviceId: device.id, selectedAreaId: area.areaId,
        selectedHubAreaId: area.hubAreaId, selectedName: name, selectedCustomerLabel: label, selectedCatalogue: catalogue,
        selectedAnalyticsCategory: actor.actorType === "STAFF_INSTALLER" ? analyticsCategory : "NONE",
        selectedDescriptorRevision: catalogue.descriptorRevision, selectedDescriptorDigest: catalogue.descriptorDigest, status: "selected" };
      await this.confirmSelectedReview(reviewed);
      this.append(reviewed, "device_selected"); await this.save(reviewed);
      return this.publicStatus(reviewed);
    });
  }

  async confirmSelectedReview(session) {
    const catalogue = session.selectedCatalogue;
    const expectedRevision = session.expectedPlatformRevision || 1;
    const result = await this.platform('transition', session, { status: 'READY', selectedAreaId: session.selectedAreaId,
      candidateRef: session.selectedCandidateRef, osDeviceId: String(session.selectedDeviceId), requestedName: session.selectedName || null,
      customerLabel: session.selectedCustomerLabel,
      ...(session.actorType === 'STAFF_INSTALLER' ? { analyticsCategory: session.selectedAnalyticsCategory || 'NONE' } : {}),
      catalogueStatus: catalogue.capabilityStatus, catalogueRevision: session.selectedDescriptorRevision,
      descriptorDigest: session.selectedDescriptorDigest, operationKind: session.operationKind || 'PAIR_NEW',
      targetIdentityHash: session.operationKind === 'REGISTER_EXISTING' ? session.targetIdentityHash : undefined });
    if (result?.ok !== true || result.state !== 'READY' || result.sessionId !== session.sessionId
      || result.revision !== expectedRevision + 1) fail(SAFE_ERROR.unavailable, 503, 'Platform has not confirmed this device review; review it again before installing', 'review_acknowledgement_required');
    session.selectedPlatformReady = true;
  }

  isCompleteRadioDevice(session, device, actor = null) {
    if (!device || String(device.protocol || "").toLowerCase() !== session.protocol || device.available === false) return false;
    const id = String(device.id || "");
    const protocolIdentity = this.protocolIdentity(device);
    const setup = String(device.setup?.status || "").toLowerCase();
    const interviewComplete = String(device.setup?.status || "").toLowerCase() === "ready"
      || String(device.setup?.status || "").toLowerCase() === "complete"
      || device.interviewStatus === "successful";
    if (!id || !protocolIdentity || !interviewComplete || !session.candidates.some((row) => row.deviceId === id)) return false;
    if (session.operationKind === "REGISTER_EXISTING") {
      const policy = this.store.getPlatform?.()?.devicePolicies?.[id];
      const reconciledByThisWork = policy?.managementClass === "PROPERTY_DEVICE" && String(policy.installationRequestId || "") === String(session.requestId || "")
        && String(policy.platformDeviceId || "") === String(device.metadata?.cloudDeviceId || "") && Boolean(policy.platformDeviceId)
        && protocolIdentity.hash === session.targetIdentityHash;
      if (reconciledByThisWork) return true;
      const platformFinalization = session.platformFinalization;
      if (platformFinalization && actor?.actorType === "STAFF_INSTALLER" && id === String(session.targetDeviceId || "")
        && protocolIdentity.hash === session.targetIdentityHash && platformFinalization.actorBinding === this.actorBinding(actor)
        && platformFinalization.requestId === session.requestId && platformFinalization.homeId === session.homeId
        && platformFinalization.protocolIdentityHash === session.targetIdentityHash) return true;
      const provenance = actor && this.adoptionProvenance(actor, device);
      return Boolean(actor?.actorType === "STAFF_INSTALLER" && id === String(session.targetDeviceId || "")
        && protocolIdentity.hash === session.targetIdentityHash && provenance?.protocolIdentityHash === session.targetIdentityHash
        && provenance.areaId === session.targetOriginalAreaId && session.candidates.some((row) => row.candidateRef === session.targetCandidateRef));
    }
    return Boolean(!this.isBaselineDevice(session, device));
  }

  async complete(sessionId, principal, disposition = "install") {
    return this.exclusive(async () => {
      const { session, actor } = await this.requireSession(sessionId, principal);
      if (session.status === "completed" || session.status === "completed_cleanup_pending") return this.publicStatus(session);
      if (session.status !== "selected" || !session.selectedDeviceId || !session.selectedAreaId || !session.selectedCatalogue) fail(SAFE_ERROR.conflict, 409, "Select a discovered device and permitted Area before completing", "device_review_required");
      const device = this.store.getDevice(session.selectedDeviceId);
      if (!this.isCompleteRadioDevice(session, device, actor)) fail(SAFE_ERROR.unavailable, 409, "The selected device is not fully discovered, currently owned, and usable yet", "candidate_not_ready");
      const catalogue = session.selectedCatalogue;
      const currentCatalogue = buildPublicCommissioningCatalogue({ device, homeId: actor.homeId, membershipId: actor.membershipId,
        managementClass: actor.actorType === "STAFF_INSTALLER" ? "property_device" : "tenant_device", areaId: session.selectedAreaId,
        name: session.selectedName || undefined, customerLabel: session.selectedCustomerLabel, now: this.clock() });
      if (!currentCatalogue || currentCatalogue.descriptorRevision !== session.selectedDescriptorRevision
        || currentCatalogue.descriptorDigest !== session.selectedDescriptorDigest) fail(SAFE_ERROR.conflict, 409, "The device descriptor changed after review; refresh and review it again", "device_descriptor_changed_after_review");
      // Older Hub versions could persist selection before cloud READY, or
      // lose its revision. Never guess a canonical revision or replay READY
      // with an ambiguous expectation. Retain the paired candidate; assigned
      // staff can use the guarded existing-device recovery after expiry.
      if (session.selectedPlatformReady !== true) {
        fail(SAFE_ERROR.conflict, 409, 'This earlier device review needs a fresh assigned registration session. Keep the device paired; reopen its retained candidate after this session expires.', 'legacy_review_recovery_required');
      }
      if (catalogue.capabilityStatus === "ready" ? disposition !== "install"
        : catalogue.capabilityStatus === "no_safe_controls"
          ? disposition !== "remove" && (disposition !== "view_only" || catalogue.usefulReadings !== true)
          : catalogue.capabilityStatus === "unsupported"
            ? !["remove", "retain_unsupported"].includes(disposition)
            : true) {
        fail(SAFE_ERROR.conflict, 409, "Review the discovered device result and choose a permitted keep or remove action", "disposition_not_compatible_with_device");
      }
      if (disposition === "remove") {
        if (session.operationKind === "REGISTER_EXISTING") fail(SAFE_ERROR.denied, 403, "An already-paired local device is never removed as part of property adoption; cancel registration to leave it unchanged");
        const cleaned = await this.reconcileCleanupCandidates(session, new Set([String(device.id)]));
        const pending = cleaned.cleanup.pendingCount > 0;
        const platform = await this.platform("transition", session, { status: "COMPLETED", result: "REMOVED" });
        if (platform?.state !== "COMPLETED") fail(SAFE_ERROR.unavailable, 503, "Platform did not confirm the removed-device result");
        Object.assign(session, { status: pending ? "completed_cleanup_pending" : "completed", finalDisposition: "remove", finalDeviceId: null,
          cleanup: pending ? session.cleanup : { state: "COMPLETE", pendingIds: [], attempts: 0 } });
        this.append(session, pending ? "candidate_removed_cleanup_pending" : "candidate_removed"); await this.save(session);
        await this.vault.delete(`commissioning.matter.${session.sessionId}`).catch(() => {});
        return this.publicStatus(session);
      }
      const controls = catalogue.controls.map((control) => ({ controlId: String(control.controlId), kind: String(control.valueType),
        readable: control.readable === true, writable: control.writable === true, domain: String(control.semanticRole || "unknown") }));
      const deviceProjection = { osDeviceId: catalogue.osDeviceId, originalName: catalogue.originalName, technicalLabel: catalogue.technicalLabel,
        deviceType: catalogue.deviceType, manufacturer: catalogue.manufacturer, model: catalogue.model, protocol: catalogue.protocol,
        protocolIdentityHash: this.protocolIdentity(device)?.hash || null,
        descriptorRevision: catalogue.descriptorRevision, descriptorDigest: catalogue.descriptorDigest, capabilitySummary: { controls },
        catalogueStatus: catalogue.capabilityStatus, usefulReadings: catalogue.usefulReadings,
        areaId: session.selectedAreaId, name: session.selectedName || null, customerLabel: session.selectedCustomerLabel,
        ...(actor.actorType === "STAFF_INSTALLER" ? { analyticsCategory: session.selectedAnalyticsCategory || "NONE" } : {}) };
      const logicalProposal = this.logicalDevicesEnabled && session.operationKind !== 'REGISTER_EXISTING' && disposition === 'install'
        ? buildLogicalCommissioningProposal({ device, homeId: actor.homeId, membershipId: actor.membershipId,
          managementClass: actor.actorType === 'STAFF_INSTALLER' ? 'property_device' : 'tenant_device',
          areaId: session.selectedAreaId, hubAreaId: session.selectedHubAreaId, name: session.selectedName,
          customerLabel: session.selectedCustomerLabel, labels: this.store.listLabels(), now: this.clock(),
          retirementEvidence: this.store.snapshot(), allowRecommission: session.operationKind === 'PAIR_NEW' }) : null;
      if (logicalProposal) deviceProjection.channels = logicalProposal.channels;
      const platformDisposition = disposition === "retain_unsupported" ? "view_only" : disposition;
      const cloud = await this.platform("finalize", session, { candidateRef: session.selectedCandidateRef, disposition: platformDisposition, device: deviceProjection });
      const expectedLifecycle = platformDisposition === "view_only" ? "VIEW_ONLY" : "INSTALLED";
      const expectedClass = actor.actorType === "STAFF_INSTALLER" ? "PROPERTY_DEVICE" : "TENANT_DEVICE";
      const expectedAnalyticsCategory = actor.actorType === "STAFF_INSTALLER" ? (session.selectedAnalyticsCategory || "NONE") : "NONE";
      if (!cloud?.ok || !cloud.device?.id || cloud.device.managementClass !== expectedClass || (cloud.device.ownerMembershipId ?? null) !== actor.membershipId
        || cloud.device.lifecycle !== expectedLifecycle || cloud.device.analyticsCategory !== expectedAnalyticsCategory) fail(SAFE_ERROR.unavailable, 503, "Platform did not confirm the correctly scoped canonical device record, analytics category and catalogue result");
      if (session.operationKind === "REGISTER_EXISTING") {
        session.platformFinalization = { platformDeviceId: String(cloud.device.id), actorBinding: this.actorBinding(actor), requestId: actor.requestId,
          homeId: actor.homeId, protocolIdentityHash: this.protocolIdentity(device)?.hash || null, confirmedAt: new Date(this.clock()).toISOString() };
        await this.save(session);
      }
      if (session.operationKind !== "REGISTER_EXISTING") await this.mqtt.stopPairing?.().catch(() => {});
      const propertyDevice = actor.actorType === "STAFF_INSTALLER";
      const policy = {
        managementClass: expectedClass, ownerMembershipId: actor.membershipId, lifecycle: expectedLifecycle, catalogueStatus: catalogue.capabilityStatus, usefulReadings: catalogue.usefulReadings,
        descriptorRevision: catalogue.descriptorRevision, descriptorDigest: catalogue.descriptorDigest, customerLabel: session.selectedCustomerLabel,
        canonicalAreaIds: [session.selectedAreaId], platformDeviceId: cloud.device.id, overrideName: session.selectedName || null,
        ...(propertyDevice ? { installationRequestId: actor.requestId, analyticsCategory: session.selectedAnalyticsCategory || "NONE",
          ...(Number.isSafeInteger(Number(cloud.device.inventoryRevision)) && Number(cloud.device.inventoryRevision) > 0 ? { inventoryRevision: Number(cloud.device.inventoryRevision) } : {}) } : {}),
      };
      const normalizedLabel = String(session.selectedCustomerLabel || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
      const matchedLabel = normalizedLabel && typeof this.store.listLabels === "function"
        ? this.store.listLabels().find((label) => String(label.name || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB") === normalizedLabel)
        : null;
      const currentLabelIds = Array.isArray(device.labelIds) ? device.labelIds : Array.isArray(device.labels) ? device.labels : [];
      const labelIds = [...new Set([...currentLabelIds.map(String), ...(matchedLabel?.id ? [String(matchedLabel.id)] : [])])];
      let updated;
      if (logicalProposal) {
        if (!Array.isArray(cloud.logicalDevices) || cloud.logicalDevices.length !== logicalProposal.channels.length)
          fail(SAFE_ERROR.unavailable, 503, 'Platform did not confirm every independent channel');
        const policies = {};
        for (const expected of logicalProposal.channels) {
          const row = cloud.logicalDevices.find(candidate => candidate.osDeviceId === expected.catalogue.osDeviceId);
          if (!row || row.managementClass !== expectedClass || row.ownerMembershipId !== actor.membershipId
            || row.lifecycle !== expectedLifecycle || row.analyticsCategory !== expectedAnalyticsCategory
            || row.descriptorDigest !== expected.catalogue.descriptorDigest
            || !isDeepStrictEqual(row.binding, expected.binding))
            fail(SAFE_ERROR.unavailable, 503, 'Platform returned a mismatched channel ownership or source binding');
          policies[row.osDeviceId] = { ...policy, platformDeviceId: row.id, overrideName: expected.catalogue.name,
            descriptorRevision: row.descriptorRevision, descriptorDigest: row.descriptorDigest,
            logicalBinding: row.binding, osAreaIds: [session.selectedHubAreaId] };
        }
        await this.store.upsertDevice({ ...device, areaId: null, labelIds, labels: labelIds,
          managementClass: propertyDevice ? 'property_device' : 'tenant_device',
          tenantOwnerMembershipId: propertyDevice ? undefined : actor.membershipId,
          setup: { ...(device.setup || {}), status: 'needs_setup', reason: 'logical_channels_managed_separately' } });
        await this.store.activateLogicalDevicePolicies(policies);
        updated = this.store.getManagedDevice(cloud.device.osDeviceId);
        if (!updated) fail(SAFE_ERROR.unavailable, 503, 'The acknowledged logical device is not locally available');
      } else updated = await this.store.upsertDevice({ ...device, name: session.selectedName || device.originalName || device.name, areaId: session.selectedHubAreaId,
        labelIds, labels: labelIds,
        managementClass: propertyDevice ? "property_device" : "tenant_device", tenantOwnerMembershipId: propertyDevice ? undefined : actor.membershipId,
        setup: { ...(device.setup || {}), status: "ready", viewOnly: platformDisposition === "view_only", unsupported: catalogue.capabilityStatus === "unsupported", commissionedAt: new Date(this.clock()).toISOString() },
        metadata: { ...(device.metadata || {}), managementClass: propertyDevice ? "property_device" : "tenant_device", ...(propertyDevice ? { tenantOwnerMembershipId: undefined, installationRequestId: actor.requestId } : { tenantOwnerMembershipId: actor.membershipId }), cloudDeviceId: cloud.device.id } }, { devicePolicy: policy });
      const outbox = this.store.getSyncOutbox?.();
      session.localSyncState = outbox && Array.isArray(outbox.events)
        ? (outbox.events.some((event) => Number(event.sequence) > Number(outbox.acknowledgedSequence || 0)
          && ["device.upsert", "control.catalog.upsert"].includes(String(event.type)) && String(event.aggregateId || "") === String(updated.id)) ? "pending" : "acknowledged")
        : "unknown";
      Object.assign(session, { status: "completed", finalDisposition: disposition, finalDeviceId: cloud.device.id, completedAt: new Date(this.clock()).toISOString(), cleanup: { state: "COMPLETE", pendingIds: [], attempts: 0 } });
      this.append(session, "commissioning_completed"); await this.save(session);
      await this.store.addEvent({ type: propertyDevice ? (session.operationKind === "REGISTER_EXISTING" ? "property_device_adopted" : "property_device_commissioned") : "tenant_device_commissioned", deviceId: updated.id, protocol: session.protocol, areaId: session.selectedAreaId }).catch(() => {});
      await this.vault.delete(`commissioning.matter.${session.sessionId}`).catch(() => {});
      return this.publicStatus(session);
    });
  }

  async resume(sessionId, principal) {
    return this.exclusive(async () => {
      const { session } = await this.requireSession(sessionId, principal);
      if (session.status !== "interrupted") return this.publicStatus(session);
      if (Object.values(this.sessions()).some((row) => row.sessionId !== session.sessionId && this.blocksRadioOperation(row))) {
        fail(SAFE_ERROR.busy, 409, "Another radio commissioning operation is still active on this hub", "radio_operation_active");
      }
      if (session.operationKind === "REGISTER_EXISTING") {
        const device = this.store.getDevice(session.targetDeviceId);
        const actor = await this.principal(principal);
        if (!this.isCompleteRadioDevice(session, device, actor)) fail(SAFE_ERROR.conflict, 409, "The existing local device changed while installation was interrupted; refresh its review", "adoption_candidate_changed_on_resume");
        session.status = "reviewing_existing";
        this.append(session, "existing_device_review_resumed");
        await this.save(session);
        return this.publicStatus(session);
      }
      if (session.protocol === "matter" && session.matterPayloadSubmittedAt) fail(SAFE_ERROR.conflict, 409, "This Matter attempt was interrupted after code submission; cancel it and scan again in a new session", "matter_payload_requires_new_session");
      if (session.protocol === "zigbee") {
        if (this.mqtt?.pairingStatus?.().active === true) fail(SAFE_ERROR.busy, 409, "A Zigbee join window is still active on this hub", "zigbee_join_window_active");
        await this.mqtt.startPairing(254, { sessionId: session.sessionId, sessionExpiresAt: session.expiresAt });
      }
      session.status = session.protocol === "zigbee" ? "searching" : "awaiting_payload";
      this.append(session, "commissioning_resumed"); await this.save(session); return this.publicStatus(session);
    });
  }

  blocksRadioOperation(session) {
    const cleanupState = String(session?.cleanup?.state || "");
    if (session?.expiryReviewPending || session?.radioOperationInFlight || session?.radioOperationUncertain
      || (Array.isArray(session?.cleanup?.pendingIds) && session.cleanup.pendingIds.length > 0)
      || ["AWAITING_RADIO_SETTLEMENT", "REQUIRES_RADIO_RECONCILIATION"].includes(cleanupState)) return true;
    // Hub recovery stops the old join window and marks its session interrupted.
    // With no pending cleanup or uncertain radio write, that persisted status
    // is history—not an active global lock. The old session's authority still
    // governs whether it can be resumed or reviewed.
    if (session?.status === "interrupted") return false;
    return !TERMINAL.has(String(session?.status || "")) && Date.parse(session?.expiresAt) > this.clock();
  }

  async cancel(sessionId, principal) {
    return this.exclusive(async () => {
      const { session } = await this.requireSession(sessionId, principal);
      if (session.status === "completed") fail(SAFE_ERROR.conflict, 409, "A completed device cannot be cancelled as a commissioning session", "session_already_completed");
      return this.closeSession(session, "cancelled");
    });
  }

  async closeSession(session, terminal) {
    const preserveAssignedZigbeeExpiry = terminal === "expired" && session.operationKind !== "REGISTER_EXISTING"
      && session.actorType === "STAFF_INSTALLER" && String(session.protocol || "").toLowerCase() === "zigbee";
    if (preserveAssignedZigbeeExpiry) {
      await this.mqtt.stopPairing?.().catch(() => {});
      const pending = new Set(session.cleanup?.pendingIds || []);
      for (const candidate of session.candidates || []) pending.add(String(candidate.deviceId));
      const waitingForRadio = session.radioOperationInFlight || session.radioOperationUncertain || this.mqtt?.pairingStatus?.().active === true;
      session.expiryReviewPending = true;
      session.status = "expired_cleanup_pending";
      session.cleanup = { state: waitingForRadio ? "AWAITING_RADIO_SETTLEMENT" : pending.size ? "PENDING" : "COMPLETE",
        pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0) };
      this.append(session, "session_expiry_waiting_for_radio_settlement", { cleanupState: session.cleanup.state });
      await this.save(session);
      if (!waitingForRadio) await this.finishExpiredStaffZigbeeReview(session);
      await this.vault.delete(`commissioning.matter.${session.sessionId}`).catch(() => {});
      await this.platform("transition", session, { status: "EXPIRED" }).catch(() => {});
      return this.publicStatus(session);
    }
    const pending = new Set(session.cleanup?.pendingIds || []);
    if (session.operationKind !== "REGISTER_EXISTING") for (const candidate of session.candidates || []) pending.add(String(candidate.deviceId));
    if (session.operationKind !== "REGISTER_EXISTING" && session.protocol === "zigbee") await this.mqtt.stopPairing?.().catch(() => {});
    const waitingForRadio = session.radioOperationInFlight || session.radioOperationUncertain;
    if (session.operationKind === "REGISTER_EXISTING") session.cleanup = { state: "NONE", pendingIds: [], attempts: Number(session.cleanup?.attempts || 0) };
    else if (!waitingForRadio) await this.reconcileCleanupCandidates(session, pending);
    else session.cleanup = { state: session.radioOperationUncertain ? "REQUIRES_RADIO_RECONCILIATION" : "AWAITING_RADIO_SETTLEMENT", pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0) };
    session.status = (pending.size || waitingForRadio) ? `${terminal}_cleanup_pending` : terminal;
    this.append(session, terminal === "expired" ? "session_expired" : terminal === "failed" ? "commissioning_failed" : "session_cancelled", { cleanupState: session.cleanup.state }); await this.save(session);
    await this.vault.delete(`commissioning.matter.${session.sessionId}`).catch(() => {});
    await this.platform("transition", session, { status: terminal === "expired" ? "EXPIRED" : terminal === "failed" ? "FAILED" : "CANCELLED" }).catch(() => {});
    return this.publicStatus(session);
  }

  async collectMatterCleanupCandidates(session) {
    const pending = new Set(session.cleanup?.pendingIds || []);
    const baseline = new Set((session.baselineDeviceIds || []).map(String));
    const knownIdentities = new Set((session.baselineIdentityHashes || []).map(String));
    for (const device of this.store.listDevices()) {
      if (String(device.protocol || "").toLowerCase() !== "matter") continue;
      const identity = digest(String(device.protocolIdentity?.ieeeAddress || device.protocolIdentity?.nodeId || device.metadata?.ieee_address || device.id));
      if (!baseline.has(String(device.id)) && !knownIdentities.has(identity)) pending.add(String(device.id));
    }
    session.cleanup = { state: pending.size ? "PENDING" : session.radioOperationUncertain ? "REQUIRES_RADIO_RECONCILIATION" : "COMPLETE", pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0) };
    await this.save(session);
  }

  async reconcileCleanupCandidates(session, candidateIds = new Set(session.cleanup?.pendingIds || [])) {
    if (session.operationKind === "REGISTER_EXISTING") return this.publicStatus(session);
    const pending = new Set(candidateIds);
    let preservedCanonical = false;
    for (const id of [...pending]) {
      const devicePolicy = this.store.getPlatform?.()?.devicePolicies?.[String(id)] || null;
      if (hasCurrentCanonicalDevicePolicy(devicePolicy)) {
        // A cancelled/stale commissioning session must never remove a device
        // that already has a current canonical owner in Platform.
        pending.delete(id);
        preservedCanonical = true;
        continue;
      }
      try {
        if (session.protocol === "zigbee") await this.mqtt.removeCommissioningCandidate(id);
        else { await this.matter.remove(id); await this.store.removeDevice?.(id); }
        pending.delete(id);
      } catch (error) {
        // Keep the identity quarantined, but log only a fixed reason code.
        // Adapter error strings can contain device identifiers or payloads.
        const reason = /^[A-Z0-9_]{1,48}$/.test(String(error?.code || "")) ? String(error.code) : "ADAPTER_CLEANUP_UNCONFIRMED";
        try { this.logger.warn?.(`[commissioning] cleanup_retry_pending protocol=${session.protocol} reason=${reason}`); } catch {}
      }
    }
    const retainedForRegistration = (session.candidates || []).some((candidate) => candidate.registrationProvenance?.kind === "expired_staff_pairing_v1"
      && Date.parse(candidate.registrationProvenance.expiresAt) > this.clock());
    session.cleanup = { state: pending.size ? "PENDING" : preservedCanonical || retainedForRegistration ? "PRESERVED_FOR_REVIEW" : session.radioOperationUncertain ? "REQUIRES_RADIO_RECONCILIATION" : "COMPLETE", pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0) };
    if (!pending.size && !session.radioOperationInFlight && !session.radioOperationUncertain && session.status.endsWith("_cleanup_pending")) session.status = session.status.replace("_cleanup_pending", "");
    await this.save(session);
    return this.publicStatus(session);
  }

  async reconcileMissingZigbeeCleanupFromInventory(session) {
    if (String(session.protocol || "").toLowerCase() !== "zigbee") return "not_applicable";
    const pendingIds = [...new Set((session.cleanup?.pendingIds || []).map(String))];
    if (!pendingIds.length) return "not_applicable";
    const snapshot = this.mqtt?.deviceInventorySnapshot?.();
    const missingIds = pendingIds.filter((id) => !this.store.getDevice(id));
    if (!snapshot?.complete || snapshot.current !== true || !Array.isArray(snapshot.devices)) {
      return missingIds.length ? "wait_for_authoritative_inventory" : "not_applicable";
    }

    const pending = new Set(pendingIds);
    let preservedForReview = (session.candidates || []).some((candidate) => candidate.registrationProvenance?.kind === "expired_staff_pairing_v1"
      && Date.parse(candidate.registrationProvenance.expiresAt) > this.clock() && Boolean(this.store.getDevice(candidate.deviceId)));
    let confirmedAbsent = 0;
    let unresolvedMissing = false;
    for (const id of pendingIds) {
      const candidate = (session.candidates || []).find((row) => String(row.deviceId) === id);
      const localDevice = this.store.getDevice(id);
      if (!candidate) {
        if (!localDevice) unresolvedMissing = true;
        continue;
      }
      const observed = snapshot.devices.find((row) => String(row?.id || "") === id && String(row?.protocol || "").toLowerCase() === "zigbee");
      if (observed) {
        const identity = String(observed.protocolIdentity?.ieeeAddress || observed.metadata?.ieee_address || observed.metadata?.ieee || "").trim().toLowerCase();
        if (!identity || digest(identity) !== String(candidate.identityHash || "") || observed.infrastructure === true) {
          return "wait_for_authoritative_inventory";
        }
        const existingPolicy = this.store.getPlatform?.()?.devicePolicies?.[id] || null;
        if (hasCurrentCanonicalDevicePolicy(existingPolicy) && localDevice) {
          pending.delete(id);
          preservedForReview = true;
          continue;
        }
        if (localDevice) {
          const localIdentity = String(localDevice.protocolIdentity?.ieeeAddress || localDevice.metadata?.ieee_address || localDevice.metadata?.ieee || "").trim().toLowerCase();
          if (!localIdentity || digest(localIdentity) !== String(candidate.identityHash || "")) return "wait_for_authoritative_inventory";
          // This is still a physically paired, locally registered candidate.
          // Preserve normal explicit-cancel cleanup semantics by retrying the
          // adapter removal and requiring its acknowledgement below.
          continue;
        }
        const restored = {
          ...observed,
          protocolIdentity: { ieeeAddress: identity },
          setup: { status: "needs_setup", assignmentMode: "device_inherited_v1", completedAt: null,
            updatedAt: new Date(this.clock()).toISOString(), reason: "area_and_label_required" },
          ...(String(existingPolicy?.managementClass || "").toUpperCase() === "PROPERTY_DEVICE" ? {
            name: String(existingPolicy.overrideName || observed.name || candidate.name || "Zigbee device"),
            managementClass: "property_device",
            metadata: { ...(observed.metadata || {}), managementClass: "property_device", cloudDeviceId: existingPolicy.platformDeviceId || undefined },
          } : String(existingPolicy?.managementClass || "").toUpperCase() === "TENANT_DEVICE" ? {
            managementClass: "tenant_device", tenantOwnerMembershipId: existingPolicy.ownerMembershipId,
            metadata: { ...(observed.metadata || {}), managementClass: "tenant_device", tenantOwnerMembershipId: existingPolicy.ownerMembershipId },
          } : {}),
        };
        await this.store.upsertDevice(restored);
        pending.delete(id);
        preservedForReview = true;
      } else {
        // Only a current, complete inventory from this live MQTT connection
        // can prove that the exact session candidate is no longer paired.
        const existingPolicy = this.store.getPlatform?.()?.devicePolicies?.[id] || null;
        if (hasCurrentCanonicalDevicePolicy(existingPolicy)) {
          pending.delete(id);
          preservedForReview = true;
          continue;
        }
        if (localDevice && (String(localDevice.managementClass || localDevice.metadata?.managementClass || "").toLowerCase() === "tenant_device"
          || Boolean(localDevice.tenantOwnerMembershipId || localDevice.metadata?.tenantOwnerMembershipId))) {
          unresolvedMissing = true;
          continue;
        }
        if (localDevice) await this.store.removeDevice?.(id);
        pending.delete(id);
        confirmedAbsent += 1;
      }
    }

    session.cleanup = {
      state: pending.size ? "PENDING" : preservedForReview ? "PRESERVED_FOR_REVIEW"
        : session.radioOperationUncertain ? "REQUIRES_RADIO_RECONCILIATION" : "COMPLETE",
      pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0),
    };
    if (!pending.size && !session.radioOperationInFlight && !session.radioOperationUncertain && session.status.endsWith("_cleanup_pending")) {
      session.status = session.status.replace("_cleanup_pending", "");
    }
    if (preservedForReview) this.append(session, "cleanup_candidate_preserved_for_review", { protocol: "zigbee", cleanupState: "PRESERVED_FOR_REVIEW" });
    if (confirmedAbsent) this.append(session, "cleanup_candidate_confirmed_absent", { protocol: "zigbee", count: confirmedAbsent, cleanupState: session.cleanup.state });
    await this.save(session);
    if (unresolvedMissing) return "wait_for_authoritative_inventory";
    return pending.size ? "continue_cleanup" : "resolved";
  }

  async expire(session) { return this.closeSession(session, "expired"); }

  async reconcileExpired() {
    if (this.stopped) return;
    await this.exclusive(async () => {
      for (const session of Object.values(this.sessions())) {
        if (session.expiryReviewPending === true) { await this.finishExpiredStaffZigbeeReview(session); continue; }
        if (!TERMINAL.has(session.status) && Date.parse(session.expiresAt) <= this.clock()) { await this.expire(session); continue; }
        if (session.radioOperationInFlight) continue;
        if (session.radioOperationUncertain && session.protocol === "matter" && this.matter?.status?.().connected) {
          await this.matter.refresh?.({ allowNew: true }).catch(() => {});
          await this.collectMatterCleanupCandidates(session);
        }
        if (!session.cleanup?.pendingIds?.length) continue;
        const inventoryResult = await this.reconcileMissingZigbeeCleanupFromInventory(session);
        if (inventoryResult === "wait_for_authoritative_inventory" || inventoryResult === "resolved") continue;
        if (inventoryResult === "continue_cleanup" && !session.cleanup.pendingIds.length) continue;
        session.cleanup.attempts = Number(session.cleanup.attempts || 0) + 1;
        await this.reconcileCleanupCandidates(session);
      }
    });
  }

  async markInterrupted(session, reason) { session.status = "interrupted"; session.interruptionCode = reason; this.append(session, "commissioning_interrupted"); await this.save(session); }

  async recover() {
    await this.exclusive(async () => {
      const sessions = Object.values(this.sessions());
      // REGISTER_EXISTING is a metadata/ownership operation, not a radio
      // operation. Do not close a live permit-join window merely because the
      // service recovered while such a session (or no session) was stored.
      const hasRecoverableZigbeePairing = sessions.some((session) => session.operationKind !== "REGISTER_EXISTING"
        && session.protocol === "zigbee" && !TERMINAL.has(session.status));
      if (hasRecoverableZigbeePairing) await this.mqtt.stopPairing?.().catch(() => {});
      for (const session of sessions) {
        if (session.expiryReviewPending === true) { await this.finishExpiredStaffZigbeeReview(session); continue; }
        if (TERMINAL.has(session.status)) {
          if (session.radioOperationInFlight && session.protocol === "matter") {
            session.radioOperationInFlight = false; session.radioOperationUncertain = true;
            session.cleanup = { state: "REQUIRES_RADIO_RECONCILIATION", pendingIds: session.cleanup?.pendingIds || [], attempts: Number(session.cleanup?.attempts || 0) };
            await this.save(session);
          }
          continue;
        }
        if (Date.parse(session.expiresAt) <= this.clock()) await this.expire(session);
        else {
          if (session.protocol === "matter" && session.matterPayloadSubmittedAt && session.radioOperationInFlight) {
            session.radioOperationInFlight = false;
            session.radioOperationUncertain = true;
            session.cleanup = { state: "REQUIRES_RADIO_RECONCILIATION", pendingIds: session.cleanup?.pendingIds || [], attempts: Number(session.cleanup?.attempts || 0) };
          }
          await this.markInterrupted(session, "hub_restarted");
        }
      }
    });
  }

  async close() {
    this.stopped = true; clearInterval(this.expiryTimer);
    const hasActiveZigbeePairing = Object.values(this.sessions()).some((session) => session.operationKind !== "REGISTER_EXISTING"
      && session.protocol === "zigbee" && !TERMINAL.has(session.status));
    if (hasActiveZigbeePairing) await this.mqtt.stopPairing?.().catch(() => {});
  }
}

module.exports = { NativeCommissioningService, SESSION_MS, MAX_CANDIDATES, MAX_TOTAL_CANDIDATES, fixedSession };
