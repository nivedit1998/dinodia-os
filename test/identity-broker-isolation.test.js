const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

// Identity files must be exercised under the same root-owned filesystem rules
// used by identityd on Linux. Run the real broker code in a disposable,
// network-isolated container; the repository is mounted read-only and all
// generated identity material stays in the container's temporary filesystem.
test("identity broker enforces root-owned storage, context binding, replacement and broker allow-list in Linux", () => {
  const repository = path.resolve(__dirname, "..");
  const linuxTest = String.raw`
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { prepareIdentity, finalizeIdentity, loadIdentity, stableManufacturingIdentityPayload, createIdentityBrokerServer } = require('/repo/src/auth/identityBroker');
const { createBackup, decryptBackup } = require('/repo/src/backup');

(async () => {
  assert.equal(process.getuid(), 0, 'isolated Linux test must run as root');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-identity-stage1-'));
  const identityDir = path.join(root, 'identity');
  const manufacturing = crypto.generateKeyPairSync('ed25519');
  const certify = (identity) => crypto.sign(null, Buffer.from(stableManufacturingIdentityPayload(identity)), manufacturing.privateKey).toString('base64url');
  const first = await prepareIdentity({ directory: identityDir, serial: 'DINODIA-IDENTITY-TEST', generation: 1 });
  const signing = crypto.createPublicKey(first.signingPublicKeyPem);
  const encryption = crypto.createPublicKey(first.encryptionPublicKeyPem);
  assert.equal(signing.asymmetricKeyType, 'ed25519');
  assert.equal(encryption.asymmetricKeyType, 'x25519');
  const keyBeforeRetry = await fs.readFile(path.join(identityDir, 'identity.key'));
  const resumed = await prepareIdentity({ directory: identityDir, serial: first.serial, generation: 1 });
  assert.equal(resumed.publicKeyFingerprint, first.publicKeyFingerprint, 'interrupted preparation must reuse the pending identity');
  assert.deepEqual(await fs.readFile(path.join(identityDir, 'identity.key')), keyBeforeRetry);
  const wrongRoot = crypto.generateKeyPairSync('ed25519');
  await assert.rejects(finalizeIdentity({ directory: identityDir, manufacturingSignature: crypto.sign(null, Buffer.from(first.certificatePayload), wrongRoot.privateKey).toString('base64url'), manufacturingRootPublicKeys: [manufacturing.publicKey.export({ type: 'spki', format: 'pem' }).toString()] }), /manufacturing-root identity certificate rejected/);
  assert.equal((await fs.stat(path.join(identityDir, 'identity.pending.json'))).isFile(), true, 'failed certification must leave resumable pending state');
  await finalizeIdentity({ directory: identityDir, manufacturingSignature: certify(first), manufacturingRootPublicKeys: [manufacturing.publicKey.export({ type: 'spki', format: 'pem' }).toString()] });
  const firstLoaded = loadIdentity(identityDir);
  assert.equal(firstLoaded.generation, 1);
  for (const file of ['identity.key', 'signing-private.enc', 'encryption-private.enc']) {
    const stat = await fs.stat(path.join(identityDir, file));
    assert.equal(stat.uid, 0);
    assert.equal(stat.gid, 0);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(identityDir)).mode & 0o777, 0o700);

  const swappedDir = path.join(root, 'swapped');
  await fs.cp(identityDir, swappedDir, { recursive: true });
  await fs.copyFile(path.join(swappedDir, 'signing-private.enc'), path.join(swappedDir, 'encryption-private.enc'));
  await fs.chmod(path.join(swappedDir, 'encryption-private.enc'), 0o600);
  await assert.rejects(async () => loadIdentity(swappedDir), /context mismatch|Unsupported state|unable to authenticate/i, 'a copied signing blob cannot be used as the encryption key');

  const tamperedDir = path.join(root, 'tampered');
  await fs.cp(identityDir, tamperedDir, { recursive: true });
  const encryptedPath = path.join(tamperedDir, 'signing-private.enc');
  const encrypted = JSON.parse(await fs.readFile(encryptedPath, 'utf8'));
  encrypted.ciphertext = Buffer.from('tampered-material').toString('base64');
  await fs.writeFile(encryptedPath, JSON.stringify(encrypted), { mode: 0o600 });
  await fs.chmod(encryptedPath, 0o600);
  await assert.rejects(async () => loadIdentity(tamperedDir), /Unsupported state|unable to authenticate|bad decrypt/i);

  const symlinkPath = path.join(root, 'identity-link');
  await fs.symlink(identityDir, symlinkPath);
  assert.throws(() => loadIdentity(symlinkPath), /symlink is forbidden/);

  const oldCiphertext = await fs.readFile(path.join(identityDir, 'signing-private.enc'));
  const second = await prepareIdentity({ directory: identityDir, serial: first.serial, generation: 1 });
  assert.equal(second.generation, 2, 'replacement must monotonically advance the identity generation');
  assert.notEqual(second.publicKeyFingerprint, first.publicKeyFingerprint);
  await finalizeIdentity({ directory: identityDir, manufacturingSignature: certify(second), manufacturingRootPublicKeys: [manufacturing.publicKey.export({ type: 'spki', format: 'pem' }).toString()] });
  const current = loadIdentity(identityDir);
  assert.equal(current.generation, 2);
  assert.notDeepEqual(await fs.readFile(path.join(identityDir, 'signing-private.enc')), oldCiphertext);

  const socketPath = path.join(root, 'identityd.sock');
  const broker = createIdentityBrokerServer({ socketPath, directory: identityDir, allowedGid: 0, logger: { warn() {} } });
  await new Promise((resolve) => broker.listen(socketPath, resolve));
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let text = '';
    socket.on('data', (chunk) => { text += chunk; if (text.includes('\n')) { socket.destroy(); resolve(JSON.parse(text)); } });
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify({ version: 1, id: 'test-unsupported', operation: 'exportPrivateKey', input: {} }) + '\n'));
  });
  assert.deepEqual(response, { ok: false, error: 'identity broker request is not authorised' });
  await new Promise((resolve) => broker.close(resolve));

  const dataFile = path.join(root, 'dinodia.json');
  const vaultFile = path.join(root, 'vault.json');
  await fs.writeFile(dataFile, JSON.stringify({ safe: true }));
  await fs.writeFile(vaultFile, '{}');
  const backup = await createBackup({ dataFile, backupDir: path.join(root, 'backups'), keyFile: path.join(root, 'machine.key'), vaultFile });
  const backupPayload = decryptBackup(JSON.parse(await fs.readFile(backup, 'utf8')), await fs.readFile(path.join(root, 'machine.key')));
  assert.equal(JSON.stringify(backupPayload).includes('identity.key'), false);
  assert.equal(JSON.stringify(backupPayload).includes('signing-private.enc'), false);
  assert.equal(JSON.stringify(backupPayload).includes('encryption-private.enc'), false);
  await fs.rm(root, { recursive: true, force: true });
  process.stdout.write('isolated identity broker filesystem matrix passed\n');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
`;

  const output = execFileSync("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repository},dst=/repo,readonly`,
    "node:20-bookworm", "node", "-e", linuxTest,
  ], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.match(output, /isolated identity broker filesystem matrix passed/);
});
