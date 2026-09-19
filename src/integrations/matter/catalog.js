const catalog = require("../../generated/matterCatalog.json");

function cluster(value) {
  const id = String(value?.id ?? value?.clusterId ?? value ?? "");
  return { id, ...(catalog.clusters[id] || { name: `Cluster ${id}`, attributes: {}, commands: [] }) };
}

function attribute(clusterId, attributeId) {
  return catalog.clusters[String(clusterId)]?.attributes?.[String(attributeId)] || null;
}

function deviceType(value) {
  return catalog.deviceTypes[String(value)] || `Device type ${value}`;
}

function sourceVersion() {
  return `${catalog.sourceVersions?.model || "unknown"}+${catalog.sourceVersions?.types || "unknown"}`;
}

module.exports = { catalog, cluster, attribute, deviceType, sourceVersion };
