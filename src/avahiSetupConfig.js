function validateSetupIdentity(serial, interfaceName) {
  const normalizedSerial = String(serial || "").trim().toLowerCase();
  const normalizedInterface = String(interfaceName || "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedSerial)) throw new Error("Setup serial is invalid");
  if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(normalizedInterface)) throw new Error("Setup interface is invalid");
  return { serial: normalizedSerial, interfaceName: normalizedInterface };
}

function setSectionValues(source, sectionName, values) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const sectionPattern = new RegExp("^\\s*\\[" + sectionName.replace(/[.*+?^{}()|[\\]\\\\]/g, "\\\\$&") + "\\]\\s*(?:#.*)?$");
  let start = lines.findIndex((line) => sectionPattern.test(line));
  if (start < 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(`[${sectionName}]`);
    start = lines.length - 1;
  }
  let end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const retained = body.filter((line) => !Object.keys(values).some((key) => new RegExp("^\\s*#?\\s*" + key + "\\s*=").test(line)));
  lines.splice(start + 1, end - start - 1, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ...retained);
  return lines.join("\n");
}

function sectionCount(source, sectionName) {
  const pattern = new RegExp("^\\s*\\[" + sectionName + "\\]\\s*(?:#.*)?$", "gm");
  return [...String(source || "").matchAll(pattern)].length;
}

function configureSetupDiscovery(source, { serial, interfaceName }) {
  const identity = validateSetupIdentity(serial, interfaceName);
  for (const sectionName of ["server", "publish"]) {
    if (sectionCount(source, sectionName) > 1) throw new Error(`Avahi configuration has ambiguous [${sectionName}] sections`);
  }
  let result = setSectionValues(source, "server", {
    "allow-interfaces": identity.interfaceName,
  });
  result = setSectionValues(result, "publish", { "publish-addresses": "yes" });
  return result.endsWith("\n") ? result : `${result}\n`;
}

function avahiSetupConfigMatches(source, { serial, interfaceName }) {
  let identity;
  try { identity = validateSetupIdentity(serial, interfaceName); } catch { return false; }
  if (sectionCount(source, "server") !== 1 || sectionCount(source, "publish") !== 1) return false;
  const valuesFor = (sectionName) => {
    const lines = String(source || "").split(/\r?\n/);
    const sectionPattern = new RegExp("^\\s*\\[" + sectionName + "\\]\\s*(?:#.*)?$");
    const start = lines.findIndex((line) => sectionPattern.test(line));
    if (start < 0) return {};
    const end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]/.test(line));
    const body = lines.slice(start + 1, end < 0 ? lines.length : end);
    return Object.fromEntries(body.map((line) => line.match(/^\s*([A-Za-z0-9-]+)\s*=\s*([^#\s]+)\s*(?:#.*)?$/)).filter(Boolean).map((match) => [match[1], match[2]]));
  };
  return valuesFor("server")["allow-interfaces"] === identity.interfaceName
    && valuesFor("publish")["publish-addresses"] === "yes";
}

module.exports = { configureSetupDiscovery, validateSetupIdentity, avahiSetupConfigMatches };
