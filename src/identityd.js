#!/usr/bin/env node
const { createIdentityBrokerServer } = require("./auth/identityBroker");
const config = require("./config");
const server = createIdentityBrokerServer({ socketPath: config.identitySocketPath, directory: config.identityDir, allowedGid: config.identityAllowedGid });
server.listen(config.identitySocketPath);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
