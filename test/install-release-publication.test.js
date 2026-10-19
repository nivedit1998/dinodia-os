const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Execute the actual installer publication block, never the privileged installer.
// GNU mv options are the supported Pi/Linux contract, not macOS mv options.
for (const occupied of [false, true]) {
  test(`release publication ${occupied ? 'refuses an occupied target' : 'renames without duplicating dependency inodes'}`, { skip: process.platform !== 'linux' }, () => {
    const source = fs.readFileSync(process.env.DINODIA_INSTALLER_UNDER_TEST || path.join(__dirname, '../scripts/install-pi.sh'), 'utf8');
    const start = source.indexOf('# Both paths are under RELEASE_ROOT:');
    assert.ok(start >= 0);
    const end = source.indexOf('STAGE_DIR=""', start);
    assert.ok(end > start);
    const block = source.slice(start, end);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-publication-test-'));
    try {
      const stage = path.join(directory, 'stage'), release = path.join(directory, 'release');
      fs.mkdirSync(stage);
      fs.writeFileSync(path.join(stage, 'dependency'), 'reviewed bytes');
      const originalInode = fs.statSync(path.join(stage, 'dependency')).ino;
      if (occupied) { fs.mkdirSync(release); fs.writeFileSync(path.join(release, 'sentinel'), 'do not overwrite'); }
      const result = spawnSync('bash', ['-c', 'set -Eeuo pipefail\ndie(){ exit 29; }\n' + block], {
        env: { ...process.env, STAGE_DIR: stage, RELEASE_DIR: release }, encoding: 'utf8', timeout: 5000,
      });
      if (occupied) {
        assert.equal(result.status, 29);
        assert.equal(fs.readFileSync(path.join(release, 'sentinel'), 'utf8'), 'do not overwrite');
        assert.equal(fs.statSync(path.join(stage, 'dependency')).ino, originalInode);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(stage), false);
        assert.equal(fs.statSync(path.join(release, 'dependency')).ino, originalInode);
        assert.equal(fs.readFileSync(path.join(release, 'dependency'), 'utf8'), 'reviewed bytes');
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
