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

test("Dinodia OS exposes assigned Area creation but keeps labels fixed", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(html, /id="area-create-form"/);
  assert.match(html, /id="area-create-name"/);
  assert.match(html, /Available labels for devices and entities: Light, Boiler, Radiator and Tenant Device/);
  assert.doesNotMatch(html, /id="area-form"/);
  assert.doesNotMatch(html, /id="label-form"/);
  // Area deletion exists only through the reviewed preview/typed-name workflow, never a direct DELETE.
  assert.match(app, /data-delete-area[^\n]*openAreaDeletion/);
  assert.doesNotMatch(app, /\/api\/areas\/[^`"]*`, \{ method: "DELETE"/);
  assert.doesNotMatch(app, /data-delete-label/);
  assert.match(app, /api\("\/api\/areas",\s*\{\s*method:\s*"POST"/);
  assert.doesNotMatch(app, /method:\s*["'](?:POST|PUT|DELETE)["'][^}]*\/api\/labels/);
  assert.match(app, /const FIXED_LABELS/);
});
