const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classifyManifestFile, isCertifiedNativeOnly } = require("../scripts/native-rollback-policy");

test("legacy Native V2 manifests without an explicit native-only marker are never rollback targets", () => {
  assert.equal(isCertifiedNativeOnly({
    buildId: "native-v2-92ecee193965d44fe8942de7",
    mode: "native-v2",
  }), false);
  assert.equal(isCertifiedNativeOnly({
    buildId: "native-v2-92ecee193965d44fe8942de7",
    mode: "native-v2",
    nativeOnly: false,
  }), false);
  assert.equal(isCertifiedNativeOnly({
    buildId: "native-v2-92ecee193965d44fe8942de7",
    mode: "home-assistant",
    nativeOnly: true,
  }), false);
});

test("only a valid, explicitly native-only release manifest can be reactivated", () => {
  assert.equal(isCertifiedNativeOnly({
    buildId: "native-v2-b055b4350a22cf68b481bcfc",
    mode: "native-v2",
    nativeOnly: true,
  }), true);
  assert.equal(isCertifiedNativeOnly({
    buildId: "native-v2-7e65d78e21538a79367309f6",
    mode: "native-v2",
    nativeOnly: true,
  }), false, "a known startup-failing Native V2 release is not a safe rollback target");
});

test("installer policy classifies a real old manifest file fail-closed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-native-rollback-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = path.join(directory, "BUILD.json");
  fs.writeFileSync(manifest, JSON.stringify({
    buildId: "native-v2-92ecee193965d44fe8942de7",
    mode: "native-v2",
    storeSchemaVersion: 10,
  }));
  assert.equal(classifyManifestFile(manifest), "unsafe");
  fs.writeFileSync(manifest, JSON.stringify({
    buildId: "native-v2-b055b4350a22cf68b481bcfc",
    mode: "native-v2",
    nativeOnly: true,
    storeSchemaVersion: 10,
  }));
  assert.equal(classifyManifestFile(manifest), "native-only");
  fs.writeFileSync(manifest, "not-json");
  assert.equal(classifyManifestFile(manifest), "unsafe");
});

test("a failed first native-only install cannot reactivate an uncertified legacy predecessor", () => {
  const installer = fs.readFileSync(path.join(__dirname, "../scripts/install-pi.sh"), "utf8");
  assert.match(installer, /native-rollback-policy\.js" --manifest/);
  assert.match(installer, /nativeOnly":true/);
  assert.match(installer, /if \[\[ "\$OLD_RELEASE_ROLLBACK_SAFE" -eq 1 \]\]/);
  assert.match(installer, /systemctl disable --now dinodia-os dinodia-identityd/);
  assert.match(installer, /previous release is preserved but is not certified as a healthy native-only recovery target, so it remains inactive/);
  assert.match(installer, /if \[\[ "\$SWITCHED" -eq 1 \]\]; then\s+if \[\[ "\$FAIL_CLOSED_CANDIDATE" -eq 0 \]\]/);
});
