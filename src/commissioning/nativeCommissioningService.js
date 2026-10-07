const crypto = require("node:crypto");
const { QrPairingCodeCodec, isValidPasscode, MATTER_QR_CODE_SINGLE_PAYLOAD_MAX_LENGTH } = require("@matter/types");
const { buildPublicCommissioningCatalogue } = require("./publicDeviceCatalogue");
const digest = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

const SESSION_MS = 15 * 60 * 1000;
const MAX_CANDIDATES = 32;
const MAX_TOTAL_CANDIDATES = 256;
const TERMINAL = new Set(["completed", "completed_cleanup_pending", "cancelled", "expired", "failed", "cancelled_cleanup_pending", "expired_cleanup_pending", "failed_cleanup_pending"]);
const SAFE_ERROR = Object.freeze({ invalid: "commissioning_request_invalid", denied: "commissioning_authority_denied", busy: "commissioning_radio_busy", unavailable: "commissioning_radio_unavailable", expired: "commissioning_session_expired", conflict: "commissioning_revision_conflict" });

function fail(code, statusCode = 409, message = "This commissioning operation is unavailable") {
  throw Object.assign(new Error(message), { statusCode, code });
}
function text(value, max) {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function fixedSession(session, afterCandidateRef = null) {
  const statuses = new Set(["requested", "advertising", "awaiting_payload", "commissioning", "searching", "interrupted", "selected", "completed", "completed_cleanup_pending", "cancelled", "expired", "failed", "cancelled_cleanup_pending", "expired_cleanup_pending"]);
  const candidates = Array.isArray(session.candidates) ? session.candidates : [];
  const cursorIndex = afterCandidateRef == null ? -1 : candidates.findIndex((candidate) => candidate.candidateRef === afterCandidateRef);
  if (afterCandidateRef != null && cursorIndex < 0) fail(SAFE_ERROR.conflict, 409, "The candidate page changed; refresh the discovery list");
  const start = cursorIndex + 1;
  const page = candidates.slice(start, start + MAX_CANDIDATES);
  return {
    sessionId: String(session.sessionId), protocol: String(session.protocol),
    status: statuses.has(String(session.status)) || String(session.status).endsWith("_cleanup_pending") ? session.status : "failed",
    createdAt: String(session.createdAt), updatedAt: String(session.updatedAt || session.createdAt), expiresAt: String(session.expiresAt),
    revision: Number(session.revision) || 1,
    candidates: page.map(({ candidateRef, name, manufacturer, model, stage, observedAt }) => ({ candidateRef, name, manufacturer, model, stage, observedAt })),
    nextCandidateCursor: start + page.length < candidates.length ? page.at(-1)?.candidateRef || null : null,
    selectedCandidateRef: session.selectedCandidateRef || null, selectedAreaId: session.selectedAreaId || null,
    selectedName: session.selectedName || null, selectedCustomerLabel: session.selectedCustomerLabel || null,
    catalogueStatus: session.selectedCatalogue?.capabilityStatus || null,
    catalogueUsefulReadings: session.selectedCatalogue?.usefulReadings === true,
    finalDisposition: session.finalDisposition || null,
    finalDeviceId: session.finalDeviceId || null,
    cleanup: { state: String(session.cleanup?.state || "NONE"), pendingCount: (Array.isArray(session.cleanup?.pendingIds) ? session.cleanup.pendingIds.length : 0) + (session.radioOperationInFlight || session.radioOperationUncertain ? 1 : 0) },
    events: (Array.isArray(session.events) ? session.events : []).slice(-40).map(({ sequence, type, at, count, protocol, cleanupState }) => ({ sequence, type, at, ...(count === undefined ? {} : { count }), ...(protocol ? { protocol } : {}), ...(cleanupState ? { cleanupState } : {}) })),
  };
}

class NativeCommissioningService {
  constructor({ store, mqtt, matter, pairing, vault, eventBus, commissioningCapabilities = {}, clock = () => Date.now(), logger = console } = {}) {
    this.store = store; this.mqtt = mqtt; this.matter = matter; this.pairing = pairing; this.vault = vault; this.eventBus = eventBus;
    this.commissioningCapabilities = commissioningCapabilities;
    this.clock = clock; this.logger = logger; this.lock = Promise.resolve(); this.stopped = false;
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
    if (active.length > 4) fail(SAFE_ERROR.busy, 409, "The hub already has the maximum active commissioning sessions");
    const completed = Object.entries(rows).filter(([, row]) => TERMINAL.has(row.status)).sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt)).slice(0, 24);
    const keep = Object.fromEntries([...Object.entries(rows).filter(([, row]) => !TERMINAL.has(row.status)), ...completed]);
    await this.store.saveSecurity({ nativeCommissioningSessions: keep });
    this.eventBus?.emit?.("dinodia_dashboard_updated", { kind: "commissioning", sessionId: session.sessionId, at: new Date(this.clock()).toISOString() });
    return session;
  }

  principal(principal) {
    const platform = this.store.getPlatform?.() || {};
    const identity = this.store.getIdentity?.() || {};
    const staff = principal?.principalType === "operator" && Array.isArray(principal.scope)
      && principal.scope.length === 1 && principal.scope[0] === "os:permanent-installation";
    if (staff) {
      const areaOptions = Array.isArray(principal.areaOptions) ? principal.areaOptions.filter((row) => row && typeof row === "object" && /^[0-9a-f-]{36}$/i.test(String(row.id || "")) && typeof row.name === "string" && row.name.trim().length > 0 && row.name.length <= 120).slice(0, 64) : [];
      const authorizedAreas = [...new Set((principal.areaIds || []).map(String))].filter(Boolean).sort();
      if (!principal.sub || !principal.sid || !principal.jti || !principal.handoffId || !principal.workflow || !principal.requestId || !principal.employeeSessionId
        || !Number.isSafeInteger(Number(principal.workRevision)) || Number(principal.workRevision) < 1 || !principal.homeId || !platform.hubInstallId
        || String(platform.homeId || "") !== String(principal.homeId) || String(principal.hubInstallId || "") !== String(platform.hubInstallId)
        || Number(identity.generation || 0) < 1 || Number(identity.generation) !== Number(principal.identityGeneration)
        || authorizedAreas.length === 0 || authorizedAreas.length !== areaOptions.length || authorizedAreas.some((id) => !areaOptions.some((area) => area.id === id))) {
        fail(SAFE_ERROR.denied, 403, "A current assigned permanent-installation authority is required");
      }
      return { actorType: "STAFF_INSTALLER", employeeId: String(principal.sub), employeeSessionId: String(principal.employeeSessionId), operatorHandoffId: String(principal.handoffId),
        operatorJti: String(principal.jti), workItemId: String(principal.workflow), workRevision: Number(principal.workRevision), requestId: String(principal.requestId),
        tokenId: String(principal.jti), tokenHash: digest(String(principal.jti)), membershipId: null, accountId: null, customerSessionId: null, trustedDeviceId: null,
        accessTokenHash: null, homeId: String(principal.homeId), hubInstallationId: String(platform.hubInstallId), identityGeneration: Number(identity.generation),
        areaIds: authorizedAreas, areaOptions };
    }
    if (!principal || principal.principalType !== "app" || principal.householdRole !== "TENANT" || !principal.scope?.includes("tenant:device-command")
      || !principal.sub || !principal.sid || !principal.jti || !principal.trustedDeviceId || !principal.membershipId || !principal.homeId || !principal.hubInstallId || !/^[a-f0-9]{64}$/i.test(String(principal.accessTokenHash || ""))) fail(SAFE_ERROR.denied, 403, "A current selected tenant session is required");
    if (String(platform.homeId || "") !== String(principal.homeId) || String(platform.hubInstallId || "") !== String(principal.hubInstallId)
      || Number(identity.generation || 0) < 1 || String(identity.generation) !== String(principal.identityGeneration || identity.generation)) fail(SAFE_ERROR.denied, 403, "The selected tenant session does not match this enrolled Home and hub");
    const authorizedAreas = [...new Set((principal.areaIds || []).map(String))].filter(Boolean).sort();
    if (!authorizedAreas.length) fail(SAFE_ERROR.denied, 403, "No active original Area is available to this membership");
    return { actorType: "TENANT", accountId: String(principal.sub), customerSessionId: String(principal.sid), tokenId: String(principal.jti), trustedDeviceId: String(principal.trustedDeviceId), membershipId: String(principal.membershipId), homeId: String(principal.homeId), hubInstallationId: String(principal.hubInstallId), accessTokenHash: String(principal.accessTokenHash), identityGeneration: Number(identity.generation), areaIds: authorizedAreas };
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
    return { schemaVersion: "dinodia.v1", ...fixedSession(session, afterCandidateRef) };
  }

  async start(principal, input, idempotencyKey) {
    const actor = this.principal(principal);
    if (!input || !["zigbee", "matter"].includes(String(input.protocol))) fail(SAFE_ERROR.invalid, 400, "Choose a supported native commissioning protocol");
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(String(idempotencyKey || ""))) fail(SAFE_ERROR.invalid, 400, "A valid commissioning operation key is required");
    const bodyHash = digest(JSON.stringify({ protocol: input.protocol }));
    const keyHash = digest(`${actor.actorType}\n${actor.accountId || actor.employeeId}\n${actor.customerSessionId || actor.employeeSessionId}\n${actor.membershipId || actor.operatorHandoffId}\n${idempotencyKey}`);
    return this.exclusive(async () => {
      const prior = Object.values(this.sessions()).find((row) => row.idempotencyHash === keyHash);
      if (prior) {
        if (prior.requestHash !== bodyHash || prior.actorType !== actor.actorType || prior.requesterAccountId !== actor.accountId || prior.ownerMembershipId !== actor.membershipId
          || prior.employeeId !== actor.employeeId || prior.operatorHandoffId !== actor.operatorHandoffId || prior.requestId !== actor.requestId) fail(SAFE_ERROR.conflict, 409, "This operation key was already used for another commissioning request");
        if (prior.status === "creating" && prior.platformCreatePending === true) await this.establishPlatformSession(prior);
        if (Date.parse(prior.expiresAt) <= this.clock() && !TERMINAL.has(prior.status)) await this.expire(prior);
        return this.publicStatus(this.sessions()[prior.sessionId] || prior);
      }
      const capability = input.protocol === "zigbee" ? "nativeZigbeeCommissioningV1" : "nativeMatterCommissioningV1";
      if (this.commissioningCapabilities[capability] !== true
        || this.commissioningCapabilities.nativeCommissioningCatalogueVersion !== "DINODIA-NATIVE-COMMISSIONING-V1") {
        fail(SAFE_ERROR.unavailable, 503, "This protocol is not enabled for the enrolled hub because its supported-device catalogue is not approved");
      }
      if (Object.values(this.sessions()).some((row) => (!TERMINAL.has(row.status) && Date.parse(row.expiresAt) > this.clock()) || row.radioOperationInFlight || row.radioOperationUncertain || row.cleanup?.pendingIds?.length)) fail(SAFE_ERROR.busy, 409, "Another radio commissioning operation or cleanup is still active on this hub");
      if (input.protocol === "zigbee") {
        if (!this.mqtt?.status?.().connected || !this.store.getZigbee?.().adapterPath) fail(SAFE_ERROR.unavailable, 503, "The enrolled Zigbee coordinator is not ready; no join was opened");
        if (this.mqtt.pairingStatus?.().active) fail(SAFE_ERROR.busy, 409, "Another Zigbee pairing session is already active on this hub");
      } else if (!this.matter?.status?.().connected || !this.store.getThread?.().configured) fail(SAFE_ERROR.unavailable, 503, "The enrolled Matter-over-Thread controller is not ready; no setup payload was accepted");
      const now = this.clock(); const sessionId = crypto.randomUUID();
      const session = {
        sessionId, protocol: input.protocol, actorType: actor.actorType, requesterAccountId: actor.accountId, requesterSessionId: actor.customerSessionId,
        requesterTokenId: actor.tokenId, requesterTrustedDeviceId: actor.trustedDeviceId, requesterTokenHash: actor.accessTokenHash,
        ownerMembershipId: actor.membershipId, homeId: actor.homeId, hubInstallationId: actor.hubInstallationId,
        ...(actor.actorType === "STAFF_INSTALLER" ? { employeeId: actor.employeeId, employeeSessionId: actor.employeeSessionId, operatorHandoffId: actor.operatorHandoffId, operatorJti: actor.operatorJti, workItemId: actor.workItemId, workRevision: actor.workRevision, requestId: actor.requestId, areaOptions: actor.areaOptions } : {}),
        identityGeneration: actor.identityGeneration, allowedAreaIds: actor.areaIds,
        status: "creating", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(),
        revision: 1, expectedPlatformRevision: 1, idempotencyHash: keyHash, requestHash: bodyHash, platformCreatePending: true,
        baselineDeviceIds: this.store.listDevices().map((device) => String(device.id)),
        baselineIdentityHashes: this.store.listDevices().map((device) => digest(String(device.protocolIdentity?.ieeeAddress || device.protocolIdentity?.nodeId || device.metadata?.ieee_address || device.id))),
        candidates: [], selectedCandidateRef: null, finalDeviceId: null, cleanup: { state: "NONE", pendingIds: [], attempts: 0 }, events: [], createdByToken: actor.tokenId,
      };
      await this.save(session);
      return this.publicStatus(await this.establishPlatformSession(session));
    });
  }

  async establishPlatformSession(session) {
    if (!session.platformCreatePending) return session;
    try {
      const cloud = await this.platform("create", session, { idempotencyHash: session.idempotencyHash, requestHash: session.requestHash });
      if (!/^[0-9a-f-]{36}$/i.test(String(cloud.sessionId || "")) || !Number.isFinite(Date.parse(String(cloud.expiresAt || "")))) fail(SAFE_ERROR.unavailable, 503, "Platform did not confirm the commissioning session");
      if (String(cloud.sessionId) !== String(session.sessionId)) {
        if (Object.values(this.sessions()).some((row) => row.sessionId === String(cloud.sessionId))) fail(SAFE_ERROR.conflict, 409, "The Platform session is already bound to another local operation");
        const sessions = { ...this.sessions() }; delete sessions[session.sessionId];
        session.sessionId = String(cloud.sessionId);
        await this.store.saveSecurity({ nativeCommissioningSessions: { ...sessions, [session.sessionId]: session } });
      }
      session.expiresAt = String(cloud.expiresAt);
      session.expectedPlatformRevision = Number(cloud.revision || 1);
      session.platformCreatePending = false;
      session.platformCreated = true;
      await this.save(session);
      if (session.protocol === "zigbee") {
        await this.mqtt.startPairing(254, { sessionId: session.sessionId, sessionExpiresAt: session.expiresAt });
        session.status = "searching";
      } else {
        session.status = "awaiting_payload";
      }
      this.append(session, "session_started", { protocol: session.protocol });
      await this.save(session);
      if (session.protocol === "zigbee") await this.platform("transition", session, { status: "ADVERTISING" });
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
    const actor = this.principal(principal);
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
      const { session } = await this.requireSession(sessionId, principal);
      await this.refreshCandidates(session);
      const safe = this.publicStatus(session, afterCandidateRef);
      safe.events = safe.events.filter((event) => Number(event.sequence) > Number(afterSequence)).slice(0, 40);
      return safe;
    });
  }

  async refreshCandidates(session) {
    if (TERMINAL.has(session.status)) return;
    const devices = session.protocol === "zigbee"
      ? (this.mqtt.pairingStatus?.().found || []).map((id) => this.store.getDevice(String(id))).filter(Boolean)
      : this.store.listDevices().filter((device) => device.protocol === "matter" && !this.isBaselineDevice(session, device));
    let changed = false;
    for (const device of devices) {
      if (session.candidates.length >= MAX_TOTAL_CANDIDATES) break;
      if (this.isBaselineDevice(session, device) || session.candidates.some((item) => item.deviceId === String(device.id))) continue;
      session.candidates.push({ candidateRef: crypto.randomUUID(), deviceId: String(device.id), identityHash: digest(String(device.protocolIdentity?.ieeeAddress || device.protocolIdentity?.nodeId || device.metadata?.ieee_address || device.id)), name: String(device.originalName || device.name || "New device").slice(0, 80), manufacturer: String(device.metadata?.manufacturer || device.metadata?.manufacturer_name || "").slice(0, 80), model: String(device.metadata?.model || device.metadata?.model_id || "").slice(0, 80), stage: String(device.setup?.status || "interviewing").slice(0, 40), observedAt: new Date(this.clock()).toISOString() });
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
    return Object.values(this.sessions()).some((session) => session.status !== "completed"
      && ((session.candidates || []).some((candidate) => String(candidate.deviceId) === id)
        || (session.cleanup?.pendingIds || []).some((pendingId) => String(pendingId) === id)
        || (device && String(device.protocol || "").toLowerCase() === session.protocol && !this.isBaselineDevice(session, device))));
  }

  isBaselineDevice(session, device) {
    const id = String(device?.id || "");
    const identityHash = digest(String(device?.protocolIdentity?.ieeeAddress || device?.protocolIdentity?.nodeId || device?.metadata?.ieee_address || id));
    return (session.baselineDeviceIds || []).map(String).includes(id) || (session.baselineIdentityHashes || []).includes(identityHash);
  }

  canonicalArea(actor, areaId) {
    const requested = String(areaId || "");
    if (!actor.areaIds.includes(requested)) fail(SAFE_ERROR.denied, 403, "Choose an Area currently granted to this tenant");
    const matches = (this.store.getPlatform?.()?.areaBindings || []).filter((row) => String(row.areaId || "") === requested);
    if (matches.length !== 1 || !matches[0].hubAreaId) fail(SAFE_ERROR.denied, 403, "The selected Area is not mapped to this enrolled hub");
    return { areaId: requested, hubAreaId: String(matches[0].hubAreaId) };
  }

  async matterPayload(sessionId, principal, encoded) {
    return this.exclusive(async () => {
      const { session } = await this.requireSession(sessionId, principal);
      if (session.protocol !== "matter" || !["awaiting_payload", "interrupted"].includes(session.status) || session.matterPayloadSubmittedAt) fail(SAFE_ERROR.conflict, 409, "This Matter attempt already has setup material; cancel it and start a new session to recover");
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
      const keys = ["areaId", "candidateRef", "customerLabel", "expectedRevision", "name", "schemaVersion"].sort().join("\n");
      if (!input || Object.keys(input).sort().join("\n") !== keys || input.schemaVersion !== "dinodia.v1" || Number(input.expectedRevision) !== Number(session.revision)) fail(SAFE_ERROR.conflict, 409, "The discovered device list changed; refresh and select again");
      const candidate = session.candidates.find((row) => row.candidateRef === input.candidateRef);
      if (!candidate) fail(SAFE_ERROR.denied, 404, "This discovered device is no longer available in this session");
      const area = this.canonicalArea(actor, input.areaId);
      const name = String(input.name || "").normalize("NFC").trim();
      const label = input.customerLabel == null || input.customerLabel === "" ? null : String(input.customerLabel).normalize("NFC").trim();
      if (!text(name, 80) || label === null || !text(label, 40) || !label) fail(SAFE_ERROR.invalid, 400, "Enter a customer label between 1 and 40 characters");
      const device = this.store.getDevice(candidate.deviceId);
      if (!this.isCompleteRadioDevice(session, device)) fail(SAFE_ERROR.unavailable, 409, "The hub has not completed the device interview yet");
      const catalogue = buildPublicCommissioningCatalogue({ device, homeId: actor.homeId, membershipId: actor.membershipId, managementClass: actor.actorType === "STAFF_INSTALLER" ? "property_device" : "tenant_device", areaId: area.areaId,
        name: name || undefined, customerLabel: label, now: this.clock() });
      if (!catalogue) fail(SAFE_ERROR.unavailable, 409, "The hub could not produce a safe device catalogue");
      Object.assign(session, { selectedCandidateRef: candidate.candidateRef, selectedDeviceId: device.id, selectedAreaId: area.areaId,
        selectedHubAreaId: area.hubAreaId, selectedName: name, selectedCustomerLabel: label, selectedCatalogue: catalogue, status: "selected" });
      this.append(session, "device_selected"); await this.save(session);
      await this.platform("transition", session, { status: "READY", selectedAreaId: area.areaId, candidateRef: candidate.candidateRef,
        osDeviceId: String(device.id), requestedName: name || null, customerLabel: label,
        catalogueStatus: catalogue.capabilityStatus, catalogueRevision: catalogue.descriptorRevision, descriptorDigest: catalogue.descriptorDigest }); await this.save(session);
      return this.publicStatus(session);
    });
  }

  isCompleteRadioDevice(session, device) {
    if (!device || String(device.protocol || "").toLowerCase() !== session.protocol || device.available === false) return false;
    const id = String(device.id || "");
    const identity = String(device.protocolIdentity?.ieeeAddress || device.protocolIdentity?.nodeId || device.metadata?.ieee_address || "");
    const setup = String(device.setup?.status || "").toLowerCase();
    const interviewComplete = String(device.setup?.status || "").toLowerCase() === "ready"
      || String(device.setup?.status || "").toLowerCase() === "complete"
      || device.interviewStatus === "successful";
    return Boolean(id && identity && !this.isBaselineDevice(session, device) && session.candidates.some((row) => row.deviceId === id)
      && interviewComplete);
  }

  async complete(sessionId, principal, disposition = "install") {
    return this.exclusive(async () => {
      const { session, actor } = await this.requireSession(sessionId, principal);
      if (session.status === "completed" || session.status === "completed_cleanup_pending") return this.publicStatus(session);
      if (session.status !== "selected" || !session.selectedDeviceId || !session.selectedAreaId || !session.selectedCatalogue) fail(SAFE_ERROR.conflict, 409, "Select a discovered device and permitted Area before completing");
      const device = this.store.getDevice(session.selectedDeviceId);
      if (!this.isCompleteRadioDevice(session, device)) fail(SAFE_ERROR.unavailable, 409, "The selected device is not fully discovered and usable yet");
      const catalogue = session.selectedCatalogue;
      if (catalogue.capabilityStatus === "ready" ? disposition !== "install"
        : !["no_safe_controls", "unsupported"].includes(catalogue.capabilityStatus)
          || disposition !== "remove" && (disposition !== "view_only" || catalogue.usefulReadings !== true)) {
        fail(SAFE_ERROR.conflict, 409, "Review the discovered device result and choose a permitted keep or remove action");
      }
      if (disposition === "remove") {
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
        descriptorRevision: catalogue.descriptorRevision, descriptorDigest: catalogue.descriptorDigest, capabilitySummary: { controls },
        catalogueStatus: catalogue.capabilityStatus, usefulReadings: catalogue.usefulReadings,
        areaId: session.selectedAreaId, name: session.selectedName || null, customerLabel: session.selectedCustomerLabel };
      const cloud = await this.platform("finalize", session, { candidateRef: session.selectedCandidateRef, disposition, device: deviceProjection });
      const expectedLifecycle = disposition === "view_only" ? "VIEW_ONLY" : "INSTALLED";
      const expectedClass = actor.actorType === "STAFF_INSTALLER" ? "PROPERTY_DEVICE" : "TENANT_DEVICE";
      if (!cloud?.ok || !cloud.device?.id || cloud.device.managementClass !== expectedClass || (cloud.device.ownerMembershipId ?? null) !== actor.membershipId || cloud.device.lifecycle !== expectedLifecycle) fail(SAFE_ERROR.unavailable, 503, "Platform did not confirm the correctly scoped canonical device record and catalogue result");
      await this.mqtt.stopPairing?.().catch(() => {});
      const propertyDevice = actor.actorType === "STAFF_INSTALLER";
      const updated = await this.store.upsertDevice({ ...device, name: session.selectedName || device.originalName || device.name, areaId: session.selectedHubAreaId,
        managementClass: propertyDevice ? "property_device" : "tenant_device", tenantOwnerMembershipId: propertyDevice ? undefined : actor.membershipId,
        setup: { ...(device.setup || {}), status: "ready", viewOnly: disposition === "view_only", commissionedAt: new Date(this.clock()).toISOString() },
        metadata: { ...(device.metadata || {}), managementClass: propertyDevice ? "property_device" : "tenant_device", ...(propertyDevice ? { tenantOwnerMembershipId: undefined, installationRequestId: actor.requestId } : { tenantOwnerMembershipId: actor.membershipId }), cloudDeviceId: cloud.device.id } });
      const platform = this.store.getPlatform?.() || {};
      await this.store.savePlatform({ devicePolicies: { ...(platform.devicePolicies || {}), [updated.id]: {
        managementClass: expectedClass, ownerMembershipId: actor.membershipId, lifecycle: expectedLifecycle, customerLabel: session.selectedCustomerLabel,
        canonicalAreaIds: [session.selectedAreaId], platformDeviceId: cloud.device.id, overrideName: session.selectedName || null,
        ...(propertyDevice ? { installationRequestId: actor.requestId } : {}),
      } } });
      await this.store.addEvent({ type: propertyDevice ? "property_device_commissioned" : "tenant_device_commissioned", deviceId: updated.id, protocol: session.protocol, areaId: session.selectedAreaId });
      Object.assign(session, { status: "completed", finalDisposition: disposition, finalDeviceId: cloud.device.id, completedAt: new Date(this.clock()).toISOString(), cleanup: { state: "COMPLETE", pendingIds: [], attempts: 0 } });
      this.append(session, "commissioning_completed"); await this.save(session);
      await this.vault.delete(`commissioning.matter.${session.sessionId}`).catch(() => {});
      return this.publicStatus(session);
    });
  }

  async resume(sessionId, principal) {
    return this.exclusive(async () => {
      const { session } = await this.requireSession(sessionId, principal);
      if (session.status !== "interrupted") return this.publicStatus(session);
      if (session.protocol === "matter" && session.matterPayloadSubmittedAt) fail(SAFE_ERROR.conflict, 409, "This Matter attempt was interrupted after code submission; cancel it and scan again in a new session");
      if (session.protocol === "zigbee") await this.mqtt.startPairing(254, { sessionId: session.sessionId, sessionExpiresAt: session.expiresAt });
      session.status = session.protocol === "zigbee" ? "searching" : "awaiting_payload";
      this.append(session, "commissioning_resumed"); await this.save(session); return this.publicStatus(session);
    });
  }

  async cancel(sessionId, principal) {
    return this.exclusive(async () => {
      const { session } = await this.requireSession(sessionId, principal);
      if (session.status === "completed") fail(SAFE_ERROR.conflict, 409, "A completed device cannot be cancelled as a commissioning session");
      return this.closeSession(session, "cancelled");
    });
  }

  async closeSession(session, terminal) {
    const pending = new Set(session.cleanup?.pendingIds || []);
    for (const candidate of session.candidates || []) pending.add(String(candidate.deviceId));
    if (session.protocol === "zigbee") await this.mqtt.stopPairing?.().catch(() => {});
    const waitingForRadio = session.radioOperationInFlight || session.radioOperationUncertain;
    if (!waitingForRadio) await this.reconcileCleanupCandidates(session, pending);
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
    const pending = new Set(candidateIds);
    for (const id of [...pending]) {
      try {
        if (session.protocol === "zigbee") await this.mqtt.removeCommissioningCandidate(id);
        else { await this.matter.remove(id); await this.store.removeDevice?.(id); }
        pending.delete(id);
      } catch { /* keep the id quarantined until adapter acknowledgement */ }
    }
    session.cleanup = { state: pending.size ? "PENDING" : session.radioOperationUncertain ? "REQUIRES_RADIO_RECONCILIATION" : "COMPLETE", pendingIds: [...pending], attempts: Number(session.cleanup?.attempts || 0) };
    if (!pending.size && !session.radioOperationInFlight && !session.radioOperationUncertain && session.status.endsWith("_cleanup_pending")) session.status = session.status.replace("_cleanup_pending", "");
    await this.save(session);
    return this.publicStatus(session);
  }

  async expire(session) { return this.closeSession(session, "expired"); }

  async reconcileExpired() {
    if (this.stopped) return;
    await this.exclusive(async () => {
      for (const session of Object.values(this.sessions())) {
        if (!TERMINAL.has(session.status) && Date.parse(session.expiresAt) <= this.clock()) { await this.expire(session); continue; }
        if (session.radioOperationInFlight) continue;
        if (session.radioOperationUncertain && session.protocol === "matter" && this.matter?.status?.().connected) {
          await this.matter.refresh?.({ allowNew: true }).catch(() => {});
          await this.collectMatterCleanupCandidates(session);
        }
        if (!session.cleanup?.pendingIds?.length) continue;
        session.cleanup.attempts = Number(session.cleanup.attempts || 0) + 1;
        await this.reconcileCleanupCandidates(session);
      }
    });
  }

  async markInterrupted(session, reason) { session.status = "interrupted"; session.interruptionCode = reason; this.append(session, "commissioning_interrupted"); await this.save(session); }

  async recover() {
    await this.exclusive(async () => {
      await this.mqtt.stopPairing?.().catch(() => {});
      for (const session of Object.values(this.sessions())) {
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

  async close() { this.stopped = true; clearInterval(this.expiryTimer); await this.mqtt.stopPairing?.().catch(() => {}); }
}

module.exports = { NativeCommissioningService, SESSION_MS, MAX_CANDIDATES, MAX_TOTAL_CANDIDATES, fixedSession };
