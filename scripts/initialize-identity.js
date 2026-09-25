#!/usr/bin/env node
// Trusted imaging entry point. This runs as root on a freshly imaged hub;
// the application never creates or reads these private keys itself.
const { initializeIdentity } = require("../src/auth/identityBroker");

const serial = process.argv[2] || process.env.DINODIA_SERIAL;
const manufacturingSignature = process.env.DINODIA_MANUFACTURING_SIGNATURE || "";
if (!manufacturingSignature.trim()) {
  process.stderr.write("DINODIA_MANUFACTURING_SIGNATURE is required; identity imaging cannot self-certify a hub\n");
  process.exit(78);
}
initializeIdentity({ serial, directory: process.env.DINODIA_IDENTITY_DIR || "/etc/dinodia-os/identity", manufacturingSignature })
  .then((identity) => { process.stdout.write(JSON.stringify({ ok: true, serial: identity.serial, generation: identity.generation, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint }) + "\n"); })
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
