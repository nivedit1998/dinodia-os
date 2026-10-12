const LOCAL_MATTER_SERVER_URL = "ws://127.0.0.1:5580/ws";

function resolveMatterServerUrl(configuredUrl, threadSettings = {}, runtimeConfig = {}) {
  const explicit = String(configuredUrl || "").trim();
  if (explicit) return explicit;
  const selectedThreadRcp = String(threadSettings?.rcpDevice || runtimeConfig?.threadRcpDevice || "").trim();
  return selectedThreadRcp ? LOCAL_MATTER_SERVER_URL : "";
}

module.exports = { LOCAL_MATTER_SERVER_URL, resolveMatterServerUrl };
