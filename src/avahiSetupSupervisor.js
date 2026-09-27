const { privateInterface } = require("./setupDiscovery");
const { configureSetupDiscovery, avahiSetupConfigMatches } = require("./avahiSetupConfig");

/**
 * Plan an Avahi rebind without performing privileged effects. Avahi's publisher
 * CLI has no per-process interface selector, so the daemon's allow-interfaces
 * must follow the exact currently selected physical private NIC.
 */
function planAvahiSetupReconciliation({ serial, interfaceName = "", interfaces, physicalCheck, configText = "", active = false }) {
  const selected = privateInterface(interfaceName, interfaces, physicalCheck);
  if (!selected) return { selected: null, configText: null, action: active ? "stop" : "none" };

  const nextConfig = configureSetupDiscovery(configText, { serial, interfaceName: selected.name });
  const currentMatches = avahiSetupConfigMatches(configText, { serial, interfaceName: selected.name });
  return {
    selected,
    configText: nextConfig,
    action: currentMatches && active ? "none" : "restart",
  };
}

module.exports = { planAvahiSetupReconciliation };
