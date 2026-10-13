#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runCli } = require("../src/integrations/zigbee/observationConfigPatch");

try {
  runCli();
} catch (error) {
  process.stderr.write(`Radiator observation configuration refused: ${error.message}\n`);
  process.exitCode = 1;
}
