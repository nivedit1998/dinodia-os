const config = require("../src/config");
const { createBackup } = require("../src/backup");

createBackup({ dataFile: config.dataFile, backupDir: config.backupDir, keyFile: require("node:path").join(config.dataDir, "machine.key"), vaultFile: require("node:path").join(config.dataDir, "vault.json") })
  .then((file) => console.log(file))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
