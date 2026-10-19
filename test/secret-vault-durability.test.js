const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { SecretVault } = require("../src/secretVault");

test("first-run vault key and empty vault are durably initialized as private regular files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-vault-first-run-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const vault = new SecretVault({ dataDir: directory });
  const key = await fs.stat(path.join(directory, "machine.key"));
  const vaultStat = await fs.stat(path.join(directory, "vault.json"));
  assert.equal(key.size, 32);
  assert.equal(key.mode & 0o777, 0o600);
  assert.equal(vaultStat.mode & 0o777, 0o600);
  assert.deepEqual(vault.records, {});
  assert.equal(store.snapshot().version, 10);
});

test("enrolled Store refuses a missing machine key instead of replacing enrolled secrets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-vault-enrolled-key-"));
  const store = new Store(path.join(directory, "dinodia.json"));
  const vault = new SecretVault({ dataDir: directory });
  await vault.set("platform.machineCredential", "keep-existing-credential");
  await store.savePlatform({ paired: true, homeId: "home-preserve", hubInstallId: "hub-preserve" });
  await fs.unlink(path.join(directory, "machine.key"));
  assert.throws(() => new SecretVault({ dataDir: directory }), { code: "secret_key_missing" });
  await assert.rejects(fs.stat(path.join(directory, "machine.key")), { code: "ENOENT" });
});

test("missing or malformed vault never becomes an empty vault when an established key exists", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-vault-missing-file-"));
  new SecretVault({ dataDir: directory });
  await fs.unlink(path.join(directory, "vault.json"));
  assert.throws(() => new SecretVault({ dataDir: directory }), { code: "secret_vault_missing" });
  await fs.writeFile(path.join(directory, "vault.json"), "{broken", { mode: 0o600 });
  assert.throws(() => new SecretVault({ dataDir: directory }), { code: "secret_vault_invalid" });
});

test("vault refuses symlinked and non-private machine-key files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-vault-key-type-"));
  const outside = path.join(directory, "outside.key");
  await fs.writeFile(outside, Buffer.alloc(32, 7), { mode: 0o600 });
  await fs.symlink(outside, path.join(directory, "machine.key"));
  assert.throws(() => new SecretVault({ dataDir: directory }), { code: "secret_file_type_invalid" });

  await fs.unlink(path.join(directory, "machine.key"));
  await fs.writeFile(path.join(directory, "machine.key"), Buffer.alloc(32, 8), { mode: 0o644 });
  assert.throws(() => new SecretVault({ dataDir: directory }), { code: "secret_key_permissions_invalid" });
});
