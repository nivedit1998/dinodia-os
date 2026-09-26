(function () {
  "use strict";
  const ADMIN_API_PREFIX = "/_dinodia/admin";
  function dashboardRoute(route) {
    const value = String(route || "");
    return value.startsWith("/api/") ? `${ADMIN_API_PREFIX}${value}` : value;
  }
  function request(route, options, token) {
    return fetch(dashboardRoute(route), { ...options, headers: { "content-type": "application/json", authorization: `Bearer ${token || ""}`, ...(options?.headers || {}) } }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.errorCode === "operator_session_expired"
          ? "Your Dinodia OS session expired or was revoked. Return to Company Portal and select Open secure Dinodia OS again."
          : body.error?.message || body.error || `HTTP ${response.status}`;
        const error = new Error(message);
        error.code = body.errorCode || body.error?.code || "http_error";
        error.status = response.status;
        throw error;
      }
      return body;
    });
  }
  window.DinodiaApi = { request };
}());
