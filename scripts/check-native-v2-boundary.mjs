import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
const pairing = fs.readFileSync(path.join(root, 'src/platformPairing.js'), 'utf8');
const failures = [];

if (/https:\/\/app\.dinodiasmartliving\.com/.test(config + pairing)) failures.push('old platform URL remains in active native configuration/pairing');
if (!/platformApiUrl: stringEnv\("DINODIA_PLATFORM_API_URL", ""\)/.test(config)) failures.push('native platform URL does not fail closed when absent');
if (!/apiUrl = ""/.test(pairing)) failures.push('pairing constructor has a legacy URL fallback');
if (!/A native V2 platform URL is required/.test(pairing)) failures.push('pairing does not fail closed without a V2 platform URL');

const probe = spawnSync(process.execPath, ['-e', 'const c=require("./src/config"); process.stdout.write(JSON.stringify({legacy:c.legacyCompatibilityEnabled,admin:c.adminToken,ha:c.haToken,bootstrap:c.platformBootstrapSecret,platform:c.platformApiUrl}));'], {
  cwd: root,
  encoding: 'utf8',
  env: { NODE_ENV: 'production', DINODIA_ADMIN_TOKEN: 'legacy', DINODIA_HA_TOKEN: 'legacy', DINODIA_PLATFORM_BOOTSTRAP_SECRET: 'legacy' },
});
if (probe.status !== 0) failures.push('production configuration probe failed');
else {
  try {
    const value = JSON.parse(probe.stdout);
    if (value.legacy !== false || value.admin !== '' || value.ha !== '' || value.bootstrap !== '' || value.platform !== '') failures.push('production configuration accepts legacy credentials or an implicit platform URL');
  } catch { failures.push('production configuration probe returned invalid output'); }
}

if (failures.length) {
  console.error('[check:native-v2] FAIL');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[check:native-v2] OK: V2 platform URL is explicit and production legacy credential/configuration fallbacks are disabled');
