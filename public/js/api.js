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
        const error = new Error(body.error?.message || body.error || `HTTP ${response.status}`);
        error.code = body.errorCode || body.error?.code || "http_error";
        error.status = response.status;
        throw error;
      }
      return body;
    });
  }
  window.DinodiaApi = { request };
}());
