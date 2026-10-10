const fs = require("node:fs");

// This release is Native V2-only but cannot boot because its default MQTT
// composition references the retired HA remote-event handler. Never reactivate
// this known-bad predecessor after a failed forward install.
const KNOWN_UNHEALTHY_BUILDS = new Set([
  "native-v2-7e65d78e21538a79367309f6",
]);

function classifyManifest(manifest) {
  if (manifest && KNOWN_UNHEALTHY_BUILDS.has(String(manifest.buildId || ""))) return "known-unhealthy";
  return Boolean(manifest)
    && manifest.mode === "native-v2"
    && manifest.nativeOnly === true
    && typeof manifest.buildId === "string"
    && /^native-v2-[a-f0-9]{24}$/.test(manifest.buildId)
    ? "native-only"
    : "unsafe";
}

function isCertifiedNativeOnly(manifest) {
  return classifyManifest(manifest) === "native-only";
}

function classifyManifestFile(filePath) {
  try {
    return classifyManifest(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return "unsafe";
  }
}

if (require.main === module) {
  const manifestIndex = process.argv.indexOf("--manifest");
  if (manifestIndex < 0 || !process.argv[manifestIndex + 1]) {
    process.stdout.write("unsafe\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${classifyManifestFile(process.argv[manifestIndex + 1])}\n`);
  }
}

module.exports = { isCertifiedNativeOnly, classifyManifest, classifyManifestFile };
