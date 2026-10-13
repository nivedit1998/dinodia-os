const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TRACKED_PROPERTIES, parseYamlSections, validateObservationConfiguration } = require("./observationContract");

function splitComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "'" || character === '"') && (!quote || quote === character)) quote = quote ? "" : character;
    if (character === "#" && !quote && (index === 0 || /\s/.test(line[index - 1]))) {
      return { value: line.slice(0, index).trimEnd(), comment: line.slice(index) };
    }
  }
  return { value: line, comment: "" };
}

function lineIndent(line) {
  return (String(line || "").match(/^\s*/) || [""])[0].length;
}

function rootBlockRange(lines, sectionName) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const body = splitComment(lines[index]).value.trim();
    if (lineIndent(lines[index]) === 0 && body === `${sectionName}:`) starts.push(index);
  }
  if (starts.length !== 1) throw new Error(`Expected exactly one top-level ${sectionName} section`);
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!splitComment(lines[index]).value.trim()) continue;
    if (lineIndent(lines[index]) === 0) { end = index; break; }
  }
  return { start, end };
}

function replaceScalarLine(line, key, value) {
  const { value: uncommented, comment } = splitComment(line);
  const match = uncommented.match(/^(\s*[A-Za-z0-9_-]+\s*:\s*).*$/);
  if (!match || match[1].trim().replace(/\s*:\s*$/, "") !== key) throw new Error(`Unexpected ${key} configuration line`);
  return `${match[1]}${value}${comment ? ` ${comment}` : ""}`;
}

function targetDeviceRange(lines, identity) {
  const parsed = parseYamlSections(lines.join("\n"));
  const matches = parsed.devices.filter((entry) => {
    const candidates = [entry.key, entry.values.friendly_name, entry.values.ieee_address, entry.values.ieee]
      .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    return [identity.friendlyName, identity.ieeeAddress].map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean).some((value) => candidates.includes(value));
  });
  if (matches.length !== 1) throw new Error(matches.length ? "Target device configuration is ambiguous" : "Target device configuration is missing");
  const target = matches[0];
  const deviceSection = rootBlockRange(lines, "devices");
  let end = deviceSection.end;
  for (let index = target.lineIndex + 1; index < deviceSection.end; index += 1) {
    const body = splitComment(lines[index]).value;
    if (body.trim() && lineIndent(body) === 2) { end = index; break; }
  }
  return { target, start: target.lineIndex, end };
}

function ensureUtcLastSeen(lines) {
  const { start, end } = rootBlockRange(lines, "advanced");
  const fields = [];
  for (let index = start + 1; index < end; index += 1) {
    const body = splitComment(lines[index]).value;
    if (lineIndent(body) !== 2) continue;
    if (/^\s*last_seen\s*:/.test(body)) fields.push(index);
  }
  if (fields.length > 1) throw new Error("Duplicate advanced.last_seen keys are unsafe to reconcile");
  if (fields.length === 1) lines[fields[0]] = replaceScalarLine(lines[fields[0]], "last_seen", "ISO_8601");
  else lines.splice(start + 1, 0, "  last_seen: ISO_8601");
}

function ensurePerDeviceObservationSettings(lines, identity) {
  let { start, end } = targetDeviceRange(lines, identity);
  const directFields = new Map();
  for (let index = start + 1; index < end; index += 1) {
    const body = splitComment(lines[index]).value;
    if (lineIndent(body) !== 4) continue;
    const match = body.trim().match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match) continue;
    directFields.set(match[1], [...(directFields.get(match[1]) || []), index]);
  }
  const optimisticRows = directFields.get("optimistic") || [];
  if (optimisticRows.length > 1) throw new Error("Duplicate target optimistic keys are unsafe to reconcile");
  if (optimisticRows.length === 1) lines[optimisticRows[0]] = replaceScalarLine(lines[optimisticRows[0]], "optimistic", "false");
  else lines.splice(start + 1, 0, "    optimistic: false");

  ({ start, end } = targetDeviceRange(lines, identity));
  const cacheRows = [];
  for (let index = start + 1; index < end; index += 1) {
    const body = splitComment(lines[index]).value;
    if (lineIndent(body) === 4 && /^filtered_cache\s*:/.test(body.trim())) cacheRows.push(index);
  }
  if (cacheRows.length > 1) throw new Error("Duplicate target filtered_cache keys are unsafe to reconcile");
  if (cacheRows.length === 0) {
    let insertionIndex = end;
    while (insertionIndex > start + 1 && !splitComment(lines[insertionIndex - 1]).value.trim()) insertionIndex -= 1;
    lines.splice(insertionIndex, 0, "    filtered_cache:", ...TRACKED_PROPERTIES.map((property) => `      - ${property}`));
    return;
  }

  const cacheIndex = cacheRows[0];
  const { value: cacheLine } = splitComment(lines[cacheIndex]);
  const colon = cacheLine.indexOf(":");
  const rawValue = cacheLine.slice(colon + 1).trim();
  let cachedProperties;
  if (!rawValue) {
    cachedProperties = [];
    let cursor = cacheIndex + 1;
    for (; cursor < end; cursor += 1) {
      const body = splitComment(lines[cursor]).value;
      if (!body.trim() || lineIndent(body) > 4) {
        if (!body.trim()) continue;
        if (lineIndent(body) !== 6 || !/^\s*-\s*[A-Za-z0-9_-]+\s*$/.test(body)) {
          throw new Error("Existing target filtered_cache is not a simple supported YAML list");
        }
        cachedProperties.push(body.trim().replace(/^-\s*/, ""));
        continue;
      }
      break;
    }
    const missing = TRACKED_PROPERTIES.filter((property) => !cachedProperties.includes(property));
    if (missing.length) lines.splice(cursor, 0, ...missing.map((property) => `      - ${property}`));
  } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    cachedProperties = rawValue.slice(1, -1).split(",").map((value) => value.trim().replace(/^(['"])(.*)\1$/, "$2")).filter(Boolean);
    if (cachedProperties.some((property) => !/^[A-Za-z0-9_-]+$/.test(property))) throw new Error("Existing inline filtered_cache contains unsupported YAML values");
    const merged = [...cachedProperties];
    for (const property of TRACKED_PROPERTIES) if (!merged.includes(property)) merged.push(property);
    lines[cacheIndex] = replaceScalarLine(lines[cacheIndex], "filtered_cache", `[${merged.join(", ")}]`);
  } else {
    throw new Error("Existing target filtered_cache is not a supported list");
  }
}

function mergeObservationConfiguration(contents, identity) {
  const newline = String(contents).includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /(?:\r?\n)$/.test(String(contents));
  const lines = String(contents).split(/\r?\n/);
  if (trailingNewline && lines.at(-1) === "") lines.pop();
  ensureUtcLastSeen(lines);
  ensurePerDeviceObservationSettings(lines, identity);
  const result = `${lines.join(newline)}${trailingNewline ? newline : ""}`;
  const verified = validateObservationConfiguration(result, identity);
  if (!verified.ok) throw new Error(`Merged publisher configuration failed contract validation: ${verified.reason}`);
  return result;
}

function clearStaleTrackedState(contents, ieeeAddress) {
  const state = JSON.parse(String(contents));
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Zigbee2MQTT state.json must be a device-keyed object");
  const normalizeIeee = (value) => String(value || "").trim().toLowerCase().replace(/^0x/, "");
  const expected = normalizeIeee(ieeeAddress);
  if (!/^[0-9a-f]{16}$/.test(expected)) throw new Error("A valid exact IEEE address is required for state cleanup");
  const matches = Object.keys(state).filter((key) => normalizeIeee(key) === expected);
  if (matches.length !== 1 || !state[matches[0]] || typeof state[matches[0]] !== "object" || Array.isArray(state[matches[0]])) {
    throw new Error("Exact target device state entry is missing or ambiguous");
  }
  const target = { ...state[matches[0]] };
  const removed = TRACKED_PROPERTIES.filter((property) => Object.hasOwn(target, property));
  for (const property of TRACKED_PROPERTIES) delete target[property];
  return { contents: `${JSON.stringify({ ...state, [matches[0]]: target }, null, 2)}\n`, removed };
}

function writeAtomic(filePath, contents) {
  const absolute = path.resolve(filePath);
  const metadata = fs.statSync(absolute);
  const tempPath = `${absolute}.dinodia-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents, { mode: metadata.mode & 0o777, flag: "wx" });
    fs.chmodSync(tempPath, metadata.mode & 0o777);
    fs.chownSync(tempPath, metadata.uid, metadata.gid);
    fs.renameSync(tempPath, absolute);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function prepareObservationConfiguration({ configPath, statePath, identity }) {
  const previousConfig = fs.readFileSync(configPath, "utf8");
  const previousState = fs.readFileSync(statePath, "utf8");
  const nextConfig = mergeObservationConfiguration(previousConfig, identity);
  const nextState = clearStaleTrackedState(previousState, identity.ieeeAddress);
  const nextStateObject = JSON.parse(nextState.contents);
  const targetKey = Object.keys(nextStateObject).find((key) => key.toLowerCase().replace(/^0x/, "") === identity.ieeeAddress.toLowerCase().replace(/^0x/, ""));
  const remainingTargetState = nextStateObject[targetKey] || {};
  const summary = {
    configurationContractValid: true,
    configurationChanged: nextConfig !== previousConfig,
    targetStatePropertiesRemoved: nextState.removed,
    targetStatePropertiesRemaining: TRACKED_PROPERTIES.filter((property) => Object.hasOwn(remainingTargetState, property)),
  };
  return { configPath, statePath, previousConfig, nextConfig, nextState: nextState.contents, summary };
}

function applyPreparedObservationConfiguration(prepared, write = writeAtomic) {
  const { configPath, statePath, previousConfig, nextConfig, nextState, summary } = prepared;
  write(configPath, nextConfig);
  try {
    write(statePath, nextState);
  } catch (error) {
    // A failure while clearing the stale cache must not leave only half of
    // the observation contract applied. Restore just the exact config bytes.
    try { write(configPath, previousConfig); }
    catch (rollbackError) {
      throw new Error(`State-cache update failed and exact configuration rollback also failed: ${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
  return summary;
}

function applyObservationConfiguration(options) {
  return applyPreparedObservationConfiguration(prepareObservationConfiguration(options), options.write || writeAtomic);
}

function runCli(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--apply", "--dry-run"].includes(flag)) args.set(flag, true);
    else if (flag.startsWith("--")) args.set(flag, argv[++index]);
  }
  const configPath = args.get("--config");
  const statePath = args.get("--state");
  const identity = { friendlyName: args.get("--friendly-name"), ieeeAddress: args.get("--ieee-address") };
  if (!configPath || !statePath || !identity.friendlyName || !identity.ieeeAddress || Boolean(args.get("--apply")) === Boolean(args.get("--dry-run"))) {
    throw new Error("Usage: node scripts/radiatorObservationConfig.mjs (--apply|--dry-run) --config PATH --state PATH --friendly-name NAME --ieee-address IEEE");
  }
  const prepared = prepareObservationConfiguration({ configPath, statePath, identity });
  const summary = args.has("--apply") ? applyPreparedObservationConfiguration(prepared) : prepared.summary;
  process.stdout.write(`${JSON.stringify({ ok: true, applied: args.has("--apply"), ...summary })}\n`);
}

if (require.main === module) {
  try { runCli(); }
  catch (error) {
    process.stderr.write(`Radiator observation configuration refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { applyObservationConfiguration, clearStaleTrackedState, mergeObservationConfiguration, prepareObservationConfiguration, runCli };
