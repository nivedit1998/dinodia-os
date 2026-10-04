"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LanTlsIdentity, pinForCertificate } = require("../src/transport/lanTlsIdentity");

test("LAN identity is stable across restart and has a private P-256 certificate for its exact public host", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-lan-identity-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = new LanTlsIdentity({ dataDir });
  const report = await first.initialize();
  assert.match(report.publicHubId, /^[a-f0-9]{20}$/);
  assert.equal(report.host, `dinodia-${report.publicHubId}.local`);
  assert.equal(report.port, 8123);
  assert.match(report.currentSpkiPin, /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.equal(report.state, "CURRENT");
  const options = first.tlsOptions();
  const cert = new (require("node:crypto").X509Certificate)(options.cert);
  assert.equal(cert.checkHost(report.host), report.host);
  assert.equal(pinForCertificate(cert), report.currentSpkiPin);
  const keyPath = path.join(dataDir, "lan-tls", JSON.parse(fs.readFileSync(path.join(dataDir, "lan-tls", "identity.json"))).current.keyFile);
  assert.equal(fs.statSync(keyPath).mode & 0o077, 0);

  const restarted = new LanTlsIdentity({ dataDir });
  const after = await restarted.initialize();
  assert.equal(after.publicHubId, report.publicHubId);
  assert.equal(after.currentSpkiPin, report.currentSpkiPin);
  assert.equal(after.certificateGeneration, report.certificateGeneration);
});

test("malformed identity metadata fails closed instead of replacing the enrolled hostname", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-lan-identity-corrupt-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const manager = new LanTlsIdentity({ dataDir });
  await manager.initialize();
  const metadata = path.join(dataDir, "lan-tls", "identity.json");
  const state = JSON.parse(fs.readFileSync(metadata, "utf8"));
  state.publicHubId = "00000000000000000000";
  fs.writeFileSync(metadata, JSON.stringify(state));
  await assert.rejects(() => new LanTlsIdentity({ dataDir }).initialize(), /public identity does not match|identity is invalid/);
});
