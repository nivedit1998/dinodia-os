const fs = require("node:fs");

function isCertifiedNativeOnly(manifest) {
  return Boolean(manifest)
    && manifest.mode === "native-v2"
    && manifest.nativeOnly === true
    && typeof manifest.buildId === "string"
    && /^native-v2-[a-f0-9]{24}$/.test(manifest.buildId);
}

function classifyManifestFile(filePath) {
  try {
    return isCertifiedNativeOnly(JSON.parse(fs.readFileSync(filePath, "utf8")))
      ? "native-only"
      : "unsafe";
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

module.exports = { isCertifiedNativeOnly, classifyManifestFile };
