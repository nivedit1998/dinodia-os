function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function humanize(value) {
  return text(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isMachineName(value) {
  const name = text(value);
  if (!name) return true;
  return /^(?:0x[0-9a-f]{6,}|[0-9a-f]{16,}|zigbee[: ]|matter[: ]|matter[- ]\d+$|unknown(?:[- ]device)?(?:[- ]\d+)?$)/i.test(name);
}

function uniqueParts(parts) {
  const result = [];
  for (const part of parts.map(text).filter(Boolean)) if (!result.some((item) => item.toLowerCase() === part.toLowerCase())) result.push(part);
  return result;
}

function zigbeeName(input = {}) {
  const definition = input.definition && typeof input.definition === "object" ? input.definition : {};
  const preferred = input.name || input.friendly_name;
  if (preferred && !isMachineName(preferred)) return text(preferred);
  const identity = uniqueParts([definition.vendor || input.manufacturer, definition.model || input.model_id]);
  if (identity.length) return identity.join(" ");
  const description = humanize(definition.description || input.description);
  if (description) return description;
  return "Zigbee device";
}

function matterName(node = {}) {
  const nodeId = node.node_id ?? node.nodeId ?? node.id;
  const preferred = node.name;
  if (preferred && !isMachineName(preferred) && !/^matter\s+\d+$/i.test(text(preferred))) return text(preferred);
  const identity = uniqueParts([node.vendor_name || node.vendorName, node.product_name || node.productName]);
  if (identity.length) return identity.join(" ");
  return nodeId === undefined || nodeId === "" ? "Matter device" : `Matter device ${nodeId}`;
}

module.exports = { humanize, isMachineName, matterName, zigbeeName };
