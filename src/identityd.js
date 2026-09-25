#!/usr/bin/env node
const { createIdentityBrokerServer } = require("./auth/identityBroker");
const config = require("./config");

// The identity broker is the only process allowed to unwrap the hub identity
// material.  A non-root process must never be able to start a look-alike
// broker on the configured socket, and a production broker must live under
// /run so its socket cannot be redirected into the application tree.
if (typeof process.getuid === "function" && process.getuid() !== 0) {
  console.error("[identityd] root privileges are required");
  process.exit(78);
}
if (!String(config.identitySocketPath).startsWith("/run/")) {
  console.error("[identityd] the identity socket must be under /run");
  process.exit(78);
}
const server = createIdentityBrokerServer({ socketPath: config.identitySocketPath, directory: config.identityDir, allowedGid: config.identityAllowedGid });
server.listen(config.identitySocketPath);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
