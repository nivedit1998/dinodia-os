const test = require("node:test");
const assert = require("node:assert/strict");
const { manifestFromCapability, validateManifest, normalizeCapability, MAX_MANIFEST_BYTES } = require("../src/capabilities/schema");

test("capability manifests are bounded, typed, and safe", () => {
  const capability = normalizeCapability({ runtime: "dinodia_os", kind: "number", category: "control", writable: true, constraints: { min: 0, max: 100, step: 1 }, bindings: [{ serviceId: "number.set_value", operation: "set_value", parameter: { key: "value", type: "number", min: 0, max: 100 } }] });
  const manifest = manifestFromCapability(capability, { name: "Brightness" });
  assert.equal(manifest.runtime, "dinodia_os");
  assert.equal(validateManifest(manifest).ok, true);
  assert.equal(manifest.service.parameter.key, "value");
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) <= MAX_MANIFEST_BYTES);
});

test("invalid manifests are rejected instead of becoming writable controls", () => {
  assert.equal(validateManifest({ version: 1, runtime: "other", kind: "number" }).ok, false);
  assert.equal(validateManifest({ version: 1, runtime: "dinodia_os", kind: "number", services: [{ id: "mqtt.publish", parameter: { key: "topic", type: "string" } }] }).ok, false);
  assert.equal(validateManifest({ version: 1, runtime: "dinodia_os", kind: "number", service: { id: "number.set_value", parameter: { key: "value", type: "number" } }, constraints: { min: 20, max: 10 } }).ok, false);
});
