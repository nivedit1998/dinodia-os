(function () {
  "use strict";
  function activeSession(pairing) {
    return pairing && pairing.active && !Array.isArray(pairing.active) ? pairing : pairing?.active?.[0];
  }
  function setupCount(pairing) { return Array.isArray(pairing?.needsSetup) ? pairing.needsSetup.length : 0; }
  function summary(pairing) {
    const session = activeSession(pairing);
    const found = session?.found || [];
    const details = session?.foundDetails || {};
    const foundDevices = found.map((deviceId) => ({ deviceId, ...(details[deviceId] || {}) }));
    return { session, setupCount: setupCount(pairing), found, foundDevices, needsSetup: pairing?.needsSetup || [] };
  }
  function hiveSummary(status) {
    const value = status && typeof status === "object" ? status : {};
    const ignored = Array.isArray(value.ignoredDeviceIds) ? value.ignoredDeviceIds : [];
    return {
      configured: Boolean(value.configured),
      connected: value.status === "connected",
      status: String(value.status || "disconnected"),
      heatingDeviceCount: Number(value.heatingDeviceCount || 0),
      hotWaterDeviceCount: Number(value.hotWaterDeviceCount || 0),
      ignoredDeviceCount: ignored.length,
      needsReauth: Boolean(value.reauthRequired || value.status === "reauth_required"),
    };
  }
  window.DinodiaPairing = { activeSession, setupCount, summary, hiveSummary };
}());
