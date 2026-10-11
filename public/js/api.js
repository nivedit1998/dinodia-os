(function () {
  "use strict";
  const ADMIN_API_PREFIX = "/_dinodia/admin";
  function dashboardRoute(route) {
    const value = String(route || "");
    return value.startsWith("/api/") ? `${ADMIN_API_PREFIX}${value}` : value;
  }
  function request(route, options, token) {
    const requestStartedAt = performance.now();
    const selector = sessionStorage.getItem("dinodia.operatorSessionSelector") || String(location.pathname || "").match(/^\/_dinodia\/operator\/([A-Za-z0-9_-]{24,64})/)?.[1] || "";
    const operatorBinding = selector ? { "x-dinodia-operator-session": selector } : {};
    return fetch(dashboardRoute(route), { ...options, credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", authorization: `Bearer ${token || ""}`, ...operatorBinding, ...(options?.headers || {}) } }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.errorCode === "operator_authority_unavailable"
          ? "Dinodia OS cannot currently confirm this window’s authority. Protected actions are paused; keep this window open and retry when the connection recovers."
          : body.errorCode === "operator_session_expired"
          ? "Your Dinodia OS session expired or was revoked. Return to Company Portal and select Open secure Dinodia OS again."
          : body.error?.message || body.error || `HTTP ${response.status}`;
        const error = new Error(message);
        error.code = body.errorCode || body.error?.code || "http_error";
        error.status = response.status;
        if (error.code === "operator_authority_unavailable") document.dispatchEvent(new CustomEvent("dinodia-operator-authority", { detail: { state: "unavailable", message, retryable: true } }));
        else if (["operator_session_expired", "operator_session_revoked", "operator_session_hub_restart", "operator_session_selector_required"].includes(error.code)) {
          document.dispatchEvent(new CustomEvent("dinodia-operator-authority", { detail: { state: "ended", code: error.code, message, reason: body.reason || "" } }));
        }
        throw error;
      }
      if (String(route) === "/api/operator-session" && body?.ok === true) {
        const expiresAt = Date.parse(String(body.expiresAt || ""));
        const serverNow = Date.parse(String(body.serverNow || ""));
        const remainingMs = Number.isFinite(expiresAt) && Number.isFinite(serverNow)
          ? Math.max(0, expiresAt - serverNow - (performance.now() - requestStartedAt))
          : null;
        document.dispatchEvent(new CustomEvent("dinodia-operator-authority", { detail: { state: "active", expiresAt: body.expiresAt, serverNow: body.serverNow, authorityVerifiedAt: body.authorityVerifiedAt, remainingMs } }));
      }
      return body;
    });
  }
  window.DinodiaApi = { request };
}());
