const fs = require("node:fs/promises");

const TRACKED_PROPERTIES = Object.freeze(["running_state", "local_temperature"]);

function uncomment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "'" || character === '"') && (!quote || quote === character)) quote = quote ? "" : character;
    if (character === "#" && !quote && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

function scalar(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
  return text;
}

function parseYamlSections(contents) {
  const root = { advanced: {}, devices: [] };
  let section = "";
  let device = null;
  let inFilteredCache = false;
  const lines = String(contents || "").split(/\r?\n/);
  for (let rawLineIndex = 0; rawLineIndex < lines.length; rawLineIndex += 1) {
    const rawLine = lines[rawLineIndex];
    const line = uncomment(rawLine);
    if (!line.trim()) continue;
    const indent = (line.match(/^\s*/) || [""])[0].length;
    const body = line.trim();
    if (indent === 0 && /^(advanced|devices)\s*:\s*$/.test(body)) {
      section = body.slice(0, body.indexOf(":"));
      device = null;
      inFilteredCache = false;
      continue;
    }
    if (section === "advanced" && indent >= 2) {
      const match = body.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
      if (match && indent === 2) root.advanced[match[1]] = scalar(match[2]);
      continue;
    }
    if (section !== "devices") continue;
    if (indent === 2) {
      const match = body.match(/^(.+?)\s*:\s*(.*?)\s*$/);
      if (!match || match[2]) {
        device = null;
        continue;
      }
      device = { key: scalar(match[1]), values: {}, filteredCache: [], filteredCachePresent: false, lineIndex: rawLineIndex };
      root.devices.push(device);
      inFilteredCache = false;
      continue;
    }
    if (!device) continue;
    if (inFilteredCache && body.startsWith("- ")) {
      device.filteredCache.push(scalar(body.slice(2).split(/\s+#/)[0]));
      continue;
    }
    const match = body.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (indent === 4) {
      inFilteredCache = key === "filtered_cache";
      if (key === "filtered_cache") {
        device.filteredCachePresent = true;
        const inline = rawValue.trim();
        if (inline.startsWith("[") && inline.endsWith("]")) {
          device.filteredCache = inline.slice(1, -1).split(",").map(scalar).filter(Boolean);
        } else if (inline) {
          device.filteredCache = [scalar(inline)];
        }
      } else if (key === "optimistic") {
        device.values.optimistic = rawValue.trim().toLowerCase() === "true" ? true
          : rawValue.trim().toLowerCase() === "false" ? false : null;
      } else {
        device.values[key] = scalar(rawValue);
      }
    }
  }
  return root;
}

function strictUtcTimestamp(value, nowMs = Date.now()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > nowMs) return null;
  const date = new Date(time);
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!parts) return null;
  const expected = parts.slice(1).map(Number);
  const actual = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  return actual.every((part, index) => part === expected[index]) ? date.toISOString() : null;
}

function matchesDevice(entry, identity = {}) {
  const candidates = [entry.key, entry.values.friendly_name, entry.values.ieee_address, entry.values.ieee]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const requested = [identity.friendlyName, identity.ieeeAddress]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  return requested.some((value) => candidates.includes(value));
}

function validateObservationConfiguration(contents, identity = {}, properties = TRACKED_PROPERTIES) {
  const configuration = parseYamlSections(contents);
  const matching = configuration.devices.filter((entry) => matchesDevice(entry, identity));
  if (configuration.advanced.last_seen !== "ISO_8601") return { ok: false, reason: "utc_last_seen_not_enabled" };
  if (matching.length !== 1) return { ok: false, reason: matching.length ? "device_configuration_ambiguous" : "device_configuration_missing" };
  const [device] = matching;
  if (device.values.optimistic !== false) return { ok: false, reason: "optimistic_updates_not_disabled" };
  if (!properties.length || properties.some(property => !/^[A-Za-z0-9_]+$/.test(property)) || !properties.every((property) => device.filteredCache.includes(property))) return { ok: false, reason: "tracked_properties_not_filtered_from_cache" };
  return { ok: true, reason: null };
}

async function readObservationConfiguration(filePath, identity, { includeProperties = false, properties = TRACKED_PROPERTIES } = {}) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    const validated = validateObservationConfiguration(contents, identity, properties);
    if (!validated.ok || !includeProperties) return validated;
    const device = parseYamlSections(contents).devices.find(entry => matchesDevice(entry, identity));
    return { ...validated, properties: [...new Set(device.filteredCache)]
      .filter(property => /^[A-Za-z0-9_]+$/.test(property)) };
  } catch {
    return { ok: false, reason: "configuration_unavailable" };
  }
}

module.exports = { TRACKED_PROPERTIES, parseYamlSections, readObservationConfiguration, strictUtcTimestamp, validateObservationConfiguration };
