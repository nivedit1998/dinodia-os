#!/usr/bin/env node

// Trusted imaging phase 1. Keys are generated and encrypted locally on the
// hub. Only public certificate material is printed so the offline authority
// can sign it. The runtime cannot load a pending identity.
const { prepareIdentity } = require("../src/auth/identityBroker");

const serial = process.argv[2] || process.env.DINODIA_SERIAL;
prepareIdentity({ serial, directory: process.env.DINODIA_IDENTITY_DIR || "/etc/dinodia-os/identity" })
  .then((identity) => process.stdout.write(`${JSON.stringify({ ok: true, serial: identity.serial, generation: identity.generation, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint, certificatePayload: identity.certificatePayload })}\n`))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
