'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHub } = require('../src/server');

const mock = () => ({ start() {}, close() {}, status: () => ({ configured: false, connected: false }) });
function signedToken(claims, key) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'EdDSA', typ: 'DNO-OPS-1' })}.${encode({ iss: 'dinodia-platform',
    aud: `dinodia-os:${claims.hubId}`, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1800, recentAuthAt: Date.now(), credentialVersion: 0, ...claims })}`;
  return `dno1.${input}.${crypto.sign(null, Buffer.from(input), key).toString('base64url')}`;
}

for (const scope of ['os:admin', 'os:permanent-installation']) {
  test(`physical listener routes exact Area deletion workflow through ${scope} authority`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dinodia-local-area-delete-'));
    const keys = crypto.generateKeyPairSync('ed25519'), hubId = 'local-area-route-hub';
    const homeId = crypto.randomUUID(), hubInstallId = crypto.randomUUID(), handoffId = crypto.randomUUID();
    const assignedArea = crypto.randomUUID();
    const claims = { sub: crypto.randomUUID(), sid: crypto.randomUUID(), jti: crypto.randomUUID(),
      hubId, scope: [scope], handoffId, homeId, workflow: crypto.randomUUID(), requestId: crypto.randomUUID(),
      employeeSessionId: crypto.randomUUID(), workRevision: 1, identityGeneration: 1,
      areaIds: [assignedArea], areaOptions: [{ id: assignedArea, name: 'Room 2' }] };
    const token = signedToken(claims, keys.privateKey), canonical = 'https://dinodia-platform-v2.vercel.app';
    const originalFetch = global.fetch;
    global.fetch = async (input, options = {}) => {
      if (!String(input).startsWith(canonical)) return originalFetch(input, options);
      const body = JSON.parse(String(options.body || '{}'));
      return new Response(JSON.stringify(body.phase === 'prepare' ? { handoffSecretEnvelope: '{}' }
        : { sessionGrant: { version: 1, envelope: '{}' }, expiresAt: new Date(Date.now() + 1800000).toISOString() }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const hub = createHub({ config: { nodeEnv: 'production', v2Environment: 'test', hubId,
      platformApiUrl: canonical, nativeLogicalDevicesEnabled: true,
      operatorPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      port: 0, nativeApiPort: 0, dataDir: directory, dataFile: path.join(directory, 'store.json'),
      backupDir: path.join(directory, 'backups'), staticDir: path.join(__dirname, '..', 'public'), otbrUrl: '' },
    mqttBridge: mock(), matterBridge: mock(), platformSync: { start() {}, stop() {}, status: () => ({}) },
    cloudflareTunnel: { start() {}, async stop() {}, status: () => ({ configured: false, running: false, connected: false }) },
    logger: { log() {}, warn() {}, error() {} } });
    t.after(async () => { await hub.stop(); global.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
    for (const id of ['empty-a', 'empty-b']) await hub.store.saveArea({ name: 'Room 2' }, id);
    await hub.store.savePlatform({ homeId, hubInstallId, paired: true,
      areaBindings: ['empty-a', 'empty-b'].map(id => ({ hubAreaId: id, areaId: crypto.randomUUID() })) });
    hub.pairing.getPublicIdentity = async () => ({ serial: hubId, generation: 1 });
    hub.pairing.start = () => {};
    hub.pairing.signPlatformRequest = async () => 'synthetic-signature';
    hub.pairing.decryptCredentialDelivery = async (_delivery, purpose) => purpose === 'operator-handoff' ? 'synthetic-handoff' : token;
    const effects = [];
    hub.pairing.requestWithHubIdentity = async (route, body) => {
      if (route.endsWith('/operator-session/attempt')) return { setupAttemptId: body.setupAttemptId, expiresAt: new Date(Date.now() + 60000).toISOString() };
      if (route.endsWith('/operator-session/revalidate')) return { active: true, homeId, hubInstallationId: hubInstallId };
      if (route.endsWith('/area-deletion')) {
        effects.push(body.action);
        if (body.action === 'preview') return { osAreaId: 'empty-a', osDeviceIds: [], digest: 'a'.repeat(64) };
        return { state: { reserve: 'RESERVED', commit: 'WAITING_HUB', finish: 'COMPLETE' }[body.action] };
      }
      return { ok: true };
    };
    await hub.start();
    await new Promise(resolve => hub.setupServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${hub.setupServer.address().port}`;
    const page = await fetch(`${base}/support-access`);
    const cookies = page.headers.getSetCookie().map(value => value.split(';', 1)[0]);
    const headers = { cookie: cookies.join('; '), origin: base, 'content-type': 'application/json',
      'x-dinodia-setup-csrf': cookies.find(value => value.startsWith('dinodia_setup_csrf='))?.split('=')[1] };
    assert.equal((await fetch(`${base}/_dinodia/setup/operator-attempt`, { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/_dinodia/setup/operator-session`, { method: 'POST', headers, body: JSON.stringify({ handoffId }) })).status, 202);
    let established;
    for (let n = 0; n < 40; n++) {
      const response = await fetch(`${base}/_dinodia/setup/operator-session`, { method: 'POST', headers, body: '{"action":"status"}' });
      if (response.status === 200) { established = response; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(established);
    const selected = await established.json();
    const sessionCookie = established.headers.getSetCookie().map(value => value.split(';', 1)[0]).find(value => value.startsWith('dinodia_os_operator_session_'));
    const auth = { ...headers, cookie: `${headers.cookie}; ${sessionCookie}`, 'x-dinodia-operator-session': selected.sessionSelector };
    const route = '/_dinodia/admin/api/areas/empty-a/deletion';
    const list = await fetch(`${base}/_dinodia/admin/api/areas/deletion-operations`, { headers: auth });
    assert.equal(list.status, scope === 'os:admin' ? 200 : 403, 'local listener must reach shared scope enforcement, not return404');
    const previewResponse = await fetch(`${base}${route}/preview`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(previewResponse.status, scope === 'os:admin' ? 200 : 403);
    assert.equal((await fetch(`${base}${route}/preview`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}${route}/preview`, { method: 'GET', headers: auth })).status, 404, 'wrong method is not exposed by the local allow-list');
    assert.equal((await fetch(`${base}/_dinodia/admin/api/areas/empty-a`, { method: 'DELETE', headers: auth })).status, 404, 'legacy DELETE cannot bypass confirmation');
    if (scope !== 'os:admin') { assert.deepEqual(effects, []); return; }
    const preview = await previewResponse.json();
    assert.equal(preview.deviceCount, 0);
    assert.equal(hub.store.listAreas().length, 2, 'preview never deletes');
    const confirm = await fetch(`${base}${route}/confirm`, { method: 'POST', headers: auth,
      body: JSON.stringify({ operationId: preview.operationId, digest: preview.digest, confirmationName: 'Room 2' }) });
    assert.equal(confirm.status, 200, await confirm.clone().text());
    assert.equal((await confirm.json()).state, 'COMPLETE');
    assert.equal(hub.store.getArea('empty-a'), null);
    assert.ok(hub.store.getArea('empty-b'), 'same-name sibling room survives exact-ID deletion');
    const status = await fetch(`${base}${route}/status?operationId=${preview.operationId}`, { headers: auth });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, 'COMPLETE');
    assert.deepEqual(effects, ['preview', 'reserve', 'commit', 'finish']);
  });
}
