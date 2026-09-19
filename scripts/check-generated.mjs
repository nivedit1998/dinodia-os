import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "src", "generated", "matterCatalog.json");
const temporary = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-matter-catalog-")), "matterCatalog.json");
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "generate-matter-catalog.mjs")], { env: { ...process.env, MATTER_CATALOG_OUTPUT: temporary }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`catalogue generator exited with ${code}`)));
  });
  const [expected, actual] = await Promise.all([fs.readFile(source), fs.readFile(temporary)]);
  if (!expected.equals(actual)) throw new Error("src/generated/matterCatalog.json is stale; run npm run generate:matter-catalog");
  console.log("Matter catalogue is up to date.");
} finally {
  await fs.rm(path.dirname(temporary), { recursive: true, force: true });
}
