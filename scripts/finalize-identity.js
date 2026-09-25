#!/usr/bin/env node

// Trusted imaging phase 2. The signature is produced by the offline
// manufacturing authority after reviewing phase-1 public material. The root
// private key is never present on this hub.
const fs = require("node:fs");
const { finalizeIdentity } = require("../src/auth/identityBroker");

const signatureFile = process.argv[2] || process.env.DINODIA_MANUFACTURING_SIGNATURE_FILE;
const rootPublicKeyFile = process.argv[3] || process.env.DINODIA_MANUFACTURING_ROOT_PUBLIC_KEY_FILE;
if (!signatureFile || !rootPublicKeyFile) {
  process.stderr.write("signature file and manufacturing-root public-key file are required\n");
  process.exit(78);
}

let manufacturingSignature;
let manufacturingRootPublicKeys;
try {
  manufacturingSignature = fs.readFileSync(signatureFile, "utf8").trim();
  manufacturingRootPublicKeys = fs.readFileSync(rootPublicKeyFile, "utf8");
} catch {
  process.stderr.write("identity ceremony input could not be read\n");
  process.exit(78);
}

finalizeIdentity({
  directory: process.env.DINODIA_IDENTITY_DIR || "/etc/dinodia-os/identity",
  manufacturingSignature,
  manufacturingRootPublicKeys,
})
  .then((identity) => process.stdout.write(`${JSON.stringify({ ok: true, serial: identity.serial, generation: identity.generation, publicKeyFingerprint: identity.publicKeyFingerprint, encryptionKeyFingerprint: identity.encryptionKeyFingerprint })}\n`))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
