const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { FIXED_LABELS } = require("../src/labelCatalog");

test("every hub exposes the four fixed Dinodia labels", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-labels-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  assert.deepEqual(store.listLabels().filter((label) => FIXED_LABELS.some((fixed) => fixed.id === label.id)).map((label) => ({ id: label.id, name: label.name })).sort((a, b) => a.id.localeCompare(b.id)), FIXED_LABELS.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)));

  await fs.writeFile(path.join(directory, "dinodia.json"), JSON.stringify({ version: 3, labels: { legacy: { id: "legacy", name: "Legacy" } } }));
  const upgraded = new Store(path.join(directory, "dinodia.json"));
  assert.deepEqual(upgraded.listLabels().filter((label) => FIXED_LABELS.some((fixed) => fixed.id === label.id)).map((label) => ({ id: label.id, name: label.name })).sort((a, b) => a.id.localeCompare(b.id)), FIXED_LABELS.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(upgraded.getLabel("legacy").name, "Legacy");
});

test("Dinodia OS does not expose local area or label creation controls", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(html, /Areas are created during hub provisioning or by Home Support/);
  assert.match(html, /Available labels for devices and entities: Light, Boiler, Radiator and Tenant Device/);
  assert.doesNotMatch(html, /id="area-form"/);
  assert.doesNotMatch(html, /id="label-form"/);
  assert.doesNotMatch(app, /data-delete-area/);
  assert.doesNotMatch(app, /data-delete-label/);
  assert.doesNotMatch(app, /method:\s*["'](?:POST|PUT|DELETE)["'][^}]*\/api\/areas/);
  assert.doesNotMatch(app, /method:\s*["'](?:POST|PUT|DELETE)["'][^}]*\/api\/labels/);
  assert.match(app, /const FIXED_LABELS/);
});
