const fs = require("node:fs");
const path = require("node:path");

function prettyName(value) {
  return String(value || "")
    .replace(/^usb-/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/(if|interface) \d+$/i, "")
    .trim() || "USB serial adapter";
}

function adapterProfile(value) {
  const name = String(value || "").toLowerCase();
  if (/home[_ -]?assistant.*(zbt|connect)|skyconnect|nabu/.test(name)) return { adapterType: "ember", recommended: true, supported: true, reason: null };
  // SONOFF's MG21 and ZBDongle-E are Silicon Labs/EFR32 Ember adapters.
  // Match these before the older CC2652/ZBDongle-P family; a generic
  // "sonoff" match incorrectly classified the MG21 as zStack.
  if (/lmg21|dongle[-_ ]?lite.*mg21|efr32mg21|zbdongle[-_ ]?e|zigbee.*dongle.*plus.*v2/.test(name)) return { adapterType: "ember", recommended: true, supported: true, reason: null };
  if (/zbdongle[-_ ]?p|cc2652|znp|texas instruments|sonoff/.test(name)) return { adapterType: "zstack", recommended: true, supported: true, reason: null };
  if (/conbee|deconz/.test(name)) return { adapterType: "deconz", recommended: true, supported: true, reason: null };
  if (/silicon labs|ezsp|ember/.test(name)) return { adapterType: "ember", recommended: true, supported: true, reason: null };
  return { adapterType: "unknown", recommended: false, supported: false, reason: "This adapter is not in the tested Dinodia OS coordinator list." };
}

function usbDetails(value) {
  const raw = String(value || "").replace(/^usb-/i, "");
  const withoutInterface = raw.replace(/-if\d+.*$/i, "");
  const pieces = withoutInterface.split("_").filter(Boolean);
  const vendor = pieces.shift() || "";
  const serial = pieces.length > 1 && /^[a-z0-9]{6,}$/i.test(pieces[pieces.length - 1]) ? pieces.pop() : "";
  const product = pieces.join(" ").replace(/[-]+/g, " ").trim();
  return {
    usbId: raw,
    manufacturer: vendor.replace(/[-]+/g, " ").trim() || null,
    product: product || null,
    serialNumber: serial || null,
  };
}

async function entries(directory) {
  try { return await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return []; }
}

async function listSerialAdapters(root = "/dev") {
  const found = new Map();
  const byIdDirectory = path.join(root, "serial", "by-id");
  for (const entry of await entries(byIdDirectory)) {
    const adapterPath = path.join(byIdDirectory, entry.name);
    try {
      const target = await fs.promises.realpath(adapterPath);
      found.set(adapterPath, { path: adapterPath, target, name: prettyName(entry.name), source: "stable-id", connected: true, ...usbDetails(entry.name), ...adapterProfile(entry.name) });
    } catch {
      // In Docker the stable-id directory may be mounted without the target tty.
      // Keep the stable identifier visible; Zigbee2MQTT will perform the final open.
      if (entry.isSymbolicLink?.()) found.set(adapterPath, { path: adapterPath, target: "", name: prettyName(entry.name), source: "stable-id", connected: true, ...usbDetails(entry.name), ...adapterProfile(entry.name) });
    }
  }
  for (const entry of await entries(root)) {
    if (!entry.isFile() && !entry.isCharacterDevice?.()) continue;
    if (!/^tty(?:USB|ACM)\d+$/i.test(entry.name)) continue;
    const adapterPath = path.join(root, entry.name);
    if ([...found.values()].some((item) => item.target === adapterPath)) continue;
    if (!found.has(adapterPath)) found.set(adapterPath, { path: adapterPath, target: adapterPath, name: prettyName(entry.name), source: "device", connected: true, ...usbDetails(entry.name), ...adapterProfile(entry.name) });
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}

async function probeSerialAdapter(adapter, root = "/dev") {
  const requested = typeof adapter === "string" ? adapter : adapter?.path;
  const pathValue = String(requested || "");
  const candidates = await listSerialAdapters(root);
  const selected = candidates.find((item) => item.path === pathValue);
  if (!selected) return { ok: false, code: "not_connected", message: "The selected serial adapter is not connected." };
  if (!selected.supported) return { ok: false, code: "unsupported_adapter", message: selected.reason || "This adapter is not supported." };
  let readable = false;
  let writable = false;
  try { await fs.promises.access(pathValue, fs.constants.R_OK); readable = true; } catch {}
  try { await fs.promises.access(pathValue, fs.constants.W_OK); writable = true; } catch {}
  const stablePathVisibleButTargetIsContainerHidden = selected.source === "stable-id" && !selected.target;
  return {
    ok: (readable && writable) || stablePathVisibleButTargetIsContainerHidden,
    verified: readable && writable,
    path: selected.path,
    target: selected.target,
    name: selected.name,
    adapterType: selected.adapterType,
    permission: readable && writable ? "read-write" : stablePathVisibleButTargetIsContainerHidden ? "stable-id-visible" : readable ? "read-only" : "unavailable",
    message: readable && writable
      ? "The adapter is connected and readable. Zigbee2MQTT must confirm coordinator communication."
      : stablePathVisibleButTargetIsContainerHidden
        ? "The stable USB identity is visible. Zigbee2MQTT will verify coordinator communication when it opens the device."
      : "Dinodia OS cannot open this adapter with its current permissions.",
  };
}

module.exports = { listSerialAdapters, probeSerialAdapter, prettyName, adapterProfile, usbDetails };
