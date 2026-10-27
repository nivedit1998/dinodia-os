'use strict';
const { attribute } = require('./catalog');

function decodeMatterValue(clusterId, attributeId, value) {
  const cluster = String(clusterId), id = String(attributeId);
  if (value === null || value === undefined) return null;
  if (attribute(cluster, id)?.type === 'temperature')
    return Number.isInteger(value) && value >= -27315 && value <= 32767 ? value / 100 : null;
  if (cluster === '258' && ['8', '9', '11', '12', '14', '15'].includes(id)) {
    const scale = ['8', '9'].includes(id) ? 1 : 100;
    return Number.isInteger(value) && value >= 0 && value <= 100 * scale ? 100 - value / scale : null;
  }
  return value;
}

// Matter Server's native NodeData uses endpoint/cluster/attribute paths. Keep
// one representation authoritative rather than joining conflicting snapshots.
function endpointInventory(node) {
  if (node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes)) {
    const endpoints = {}; let count = 0;
    for (const key in node.attributes) {
      if (!Object.hasOwn(node.attributes, key)) continue;
      if (++count > 4096) return { endpoints: {}, incomplete: true };
      const match = /^(0|[1-9][0-9]{0,4})\/(0|[1-9][0-9]{0,9})\/(0|[1-9][0-9]{0,9})$/.exec(key);
      if (!match || Number(match[1]) > 65535 || Number(match[2]) > 0xffffffff || Number(match[3]) > 0xffffffff) continue;
      const [, endpoint, cluster, id] = match;
      const value = node.attributes[key];
      if (Array.isArray(value) && value.length > 128 || typeof value === 'string' && value.length > 512) return { endpoints: {}, incomplete: true };
      ((endpoints[endpoint] ||= { clusters: {} }).clusters[cluster] ||= { attributes: {} }).attributes[id] = value;
    }
    return { endpoints, incomplete: false };
  }
  return { endpoints: node.endpoints || node.endpoint_data || node.endpointData || {}, incomplete: false };
}

module.exports = { decodeMatterValue, endpointInventory };
