import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCandidate, CANONICAL_PLATFORM_ORIGIN } from "../scripts/install_pi_preflight.mjs";

const sourceDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function fixture(envExtra = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-install-preflight-"));
  const envFile = path.join(root, ".env");
  const identityDir = path.join(root, "identity");
  await fs.mkdir(identityDir, { recursive: true });
  await fs.writeFile(path.join(identityDir, "identity.json"), JSON.stringify({ serial: "din-home-test", generation: 1 }));
  await fs.writeFile(envFile, [
    "NODE_ENV=production",
    `DINODIA_PLATFORM_API_URL=${CANONICAL_PLATFORM_ORIGIN}`,
    "DINODIA_APP_PUBLIC_KEYS=test-public-key",
    "DINODIA_OPERATOR_PUBLIC_KEY=test-operator-key",
    "DINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS=test-root-key",
    envExtra,
    "",
  ].join("\n"));
  return { root, envFile, identityDir };
}

test("installer preflight accepts only the canonical Native V2 origin", async () => {
  const accepted = await fixture();
  const result = validateCandidate({ sourceDir, envFile: accepted.envFile, identityDir: accepted.identityDir });
  assert.match(result.buildId, /^native-v2-[a-f0-9]{24}$/);

  for (const origin of [
    "https://dinodia-platform-v2-br7u28kh8-dinodia-supabase.vercel.app",
    "https://app.dinodiasmartliving.com",
    "https://old-dinodia.example",
  ]) {
    const rejected = await fixture(`DINODIA_PLATFORM_API_URL=${origin}`);
    assert.throws(() => validateCandidate({ sourceDir, envFile: rejected.envFile, identityDir: rejected.identityDir }), /canonical V2 origin/);
  }
});

test("installer preflight rejects malformed multiline environment files before any install decision", async () => {
  const fixtureData = await fixture("DINODIA_OPERATOR_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nnot-an-assignment");
  const before = await fs.readFile(fixtureData.envFile);
  assert.throws(() => validateCandidate({ sourceDir, envFile: fixtureData.envFile, identityDir: fixtureData.identityDir }), /invalid environment assignment/);
  assert.deepEqual(await fs.readFile(fixtureData.envFile), before);
});

test("installer preflight rejects the legacy 0.5.0 package identity", async () => {
  const fixtureData = await fixture();
  const candidate = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-legacy-package-"));
  await fs.cp(sourceDir, candidate, { recursive: true, filter: (entry) => !entry.includes("node_modules") && !entry.includes(".git") });
  const packagePath = path.join(candidate, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  packageJson.version = "0.5.0";
  await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  assert.throws(() => validateCandidate({ sourceDir: candidate, envFile: fixtureData.envFile, identityDir: fixtureData.identityDir }), /legacy 0\.5\.0/);
});
