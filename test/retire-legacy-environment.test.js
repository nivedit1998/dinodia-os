const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("retired environment migration backs up secrets privately and removes only exact legacy assignments", async (t) => {
  const { retireLegacyEnvironmentFile, RETIRED_ENVIRONMENT_NAMES } = await import("../scripts/retire-legacy-environment.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-env-retire-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, ".env");
  const backupDirectory = path.join(root, "backups");
  const original = [
    "NODE_ENV=production",
    "DINODIA_PLATFORM_API_URL=https://dinodia-platform-v2.vercel.app",
    "DINODIA_HA_PORT=8123",
    "export STAGE1_INTERNAL_OPERATOR_DAY_SESSION=true",
    "PLATFORM_DATA_ENCRYPTION_KEY=do-not-print-this-value",
    "# DINODIA_HA_TOKEN=comment-is-not-a-setting",
    "DINODIA_NATIVE_API_PORT=8123",
    "",
  ].join("\n");
  fs.writeFileSync(envPath, original, { mode: 0o640 });

  const result = retireLegacyEnvironmentFile({ envPath, backupDirectory, backupName: "original.env" });

  assert.deepEqual(result.removedNames, ["DINODIA_HA_PORT", "STAGE1_INTERNAL_OPERATOR_DAY_SESSION"]);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(envPath, "utf8"), [
    "NODE_ENV=production",
    "DINODIA_PLATFORM_API_URL=https://dinodia-platform-v2.vercel.app",
    "PLATFORM_DATA_ENCRYPTION_KEY=do-not-print-this-value",
    "# DINODIA_HA_TOKEN=comment-is-not-a-setting",
    "DINODIA_NATIVE_API_PORT=8123",
    "",
  ].join("\n"));
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o640);
  assert.ok(RETIRED_ENVIRONMENT_NAMES.includes("DINODIA_HUB_AGENT_PORT"));
});

test("retired environment migration is idempotent when all old keys are already absent", async (t) => {
  const { retireLegacyEnvironmentFile } = await import("../scripts/retire-legacy-environment.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-env-retire-empty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, ".env");
  fs.writeFileSync(envPath, "NODE_ENV=production\nDINODIA_NATIVE_API_PORT=8123\n", { mode: 0o600 });

  const result = retireLegacyEnvironmentFile({ envPath, backupDirectory: path.join(root, "backups"), backupName: "unused.env" });

  assert.deepEqual(result, { backupPath: null, removedNames: [] });
  assert.equal(fs.readFileSync(envPath, "utf8"), "NODE_ENV=production\nDINODIA_NATIVE_API_PORT=8123\n");
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});
