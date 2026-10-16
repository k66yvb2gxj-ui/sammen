import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createAdminService } from '../src/admin.mjs';

const secret = 'admin-secret-for-tests-at-least-24-characters';
const when = '2026-10-16T12:00:00.000Z';
const person = { id: 'student-id', name: 'Elev', avatar: { style: 'cat', color: 'lilac' } };
const room = '0b5b024b-99cc-47a3-97a4-2c7ff625db12';
const overview = () => ({ version: 1, generatedAt: when, counts: { brains: 1, users: 1, projects: 2, files: 3 }, users: [{ ...person, brainIds: [room], lastSeen: when }], brains: [{ id: room, name: 'Historiegruppen', visibility: 'invited', projectCount: 2, fileCount: 3, memberCount: 1, lastActiveAt: when, members: [{ ...person, userId: person.id, joinedAt: when, lastSeen: when }] }] });
const activity = () => ({ version: 1, events: [{ id: 'event-id', at: when, type: 'file.updated', brainId: room, actor: { ...person, avatar: { ...person.avatar } }, target: { id: 'file-id', title: 'Arbeidsnotat' } }] });
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function cryptoHooks() {
  const key = randomBytes(32);
  return {
    encrypt: value => {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decrypt: value => {
      const bytes = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sammen-admin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const requests = [];
  const hooks = cryptoHooks();
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return json(url.includes('/activity?') ? activity() : overview()); };
  const service = await createAdminService({ directory, ...hooks, fetchImpl, ...options });
  return { directory, service, requests, hooks, fetchImpl };
}

test('admin connect validates both read-only endpoints and returns a metadata allowlist without the key', async t => {
  const rawOverview = overview(), rawActivity = activity();
  rawOverview.key = secret; rawOverview.users[0].token = secret; rawOverview.brains[0].inviteCode = secret;
  rawOverview.brains[0].members[0].sessionToken = secret; rawActivity.events[0].target.content = 'private file body';
  rawActivity.events[0].actor.apiKey = secret;
  const calls = [];
  const { service } = await fixture(t, { fetchImpl: async (url, init) => { calls.push({ url, init }); return json(url.includes('/activity?') ? rawActivity : rawOverview); } });
  const state = await service.connect({ url: 'https://admin.example.org/', key: secret, remember: false });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname).sort(), ['/api/admin/activity', '/api/admin/overview']);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(state.status.connected, true); assert.equal(state.status.url, 'https://admin.example.org');
  assert.deepEqual(state.overview, overview()); assert.deepEqual(state.activity, activity());
  for (const text of [secret, 'private file body', 'sessionToken', 'inviteCode', 'apiKey']) assert.equal(JSON.stringify(state).includes(text), false);
  state.overview.users[0].name = 'Changed returned copy';
  assert.equal(service.getState().overview.users[0].name, person.name);
});

test('admin URLs reject paths, credentials, queries, insecure hosts and fragments before any request', async t => {
  const { service, requests } = await fixture(t);
  for (const url of ['http://admin.example.org', 'http://127.0.0.1:9000', 'https://user:pass@admin.example.org', 'https://admin.example.org/admin', 'https://admin.example.org/?key=secret', 'https://admin.example.org/#secret', 'file:///C:/secret', 'not a URL']) await assert.rejects(service.connect({ url, key: secret, remember: false }), /HTTPS/);
  assert.equal(requests.length, 0);
  assert.equal(service.status().configured, false);
  await assert.rejects(service.connect({ url: 'https://admin.example.org', key: 'short', remember: false }), /24 tegn/);
  await assert.rejects(service.connect({ url: 'https://admin.example.org', key: `${secret}\r\nInjected: yes`, remember: false }), /24 tegn/);
});

test('explicit test mode permits only loopback HTTP and still uses root-relative admin routes', async t => {
  const { service, requests } = await fixture(t, { allowLoopbackHttp: true });
  await service.connect({ url: 'http://127.0.0.1:9123', key: secret, remember: false });
  assert.equal(requests[0].url, 'http://127.0.0.1:9123/api/admin/overview');
  await assert.rejects(service.connect({ url: 'http://192.0.2.10:9123', key: secret, remember: false }), /HTTPS/);
});

test('remembered credentials are encrypted at rest, restored without network and revalidated at both endpoints', async t => {
  const { directory, service, hooks, requests, fetchImpl } = await fixture(t);
  await service.connect({ url: 'https://admin.example.org', key: secret });
  const disk = await fs.readFile(path.join(directory, 'admin-credentials.json'), 'utf8');
  assert.equal(disk.includes(secret), false); assert.equal(disk.includes('admin.example.org'), false);
  const wrapped = JSON.parse(disk);
  assert.equal(wrapped.version, 1); assert.equal(typeof wrapped.encrypted, 'string');
  assert.equal(disk.includes(Buffer.from(secret).toString('base64')), false);
  const before = requests.length;
  const restored = await createAdminService({ directory, ...hooks, fetchImpl });
  assert.equal(requests.length, before);
  assert.equal(restored.status().configured, true); assert.equal(restored.status().connected, false); assert.equal(restored.status().remembered, true);
  assert.equal(restored.getState().overview, null);
  const [loadedOverview, loadedActivity] = await Promise.all([restored.getOverview(), restored.getActivity()]);
  assert.deepEqual(loadedOverview, overview()); assert.deepEqual(loadedActivity, activity());
  assert.equal(requests.length, before + 2);
  assert.equal(restored.status().connected, true);
});

test('memory-only mode works without OS encryption and removes a previous remembered connection', async t => {
  const { service, directory, fetchImpl } = await fixture(t);
  await service.connect({ url: 'https://admin.example.org', key: secret });
  const memory = await createAdminService({ directory, canRemember: false, encrypt: () => { throw new Error(secret); }, decrypt: () => { throw new Error(secret); }, fetchImpl });
  assert.equal(memory.status().canRemember, false);
  await assert.rejects(memory.connect({ url: 'https://admin.example.org', key: secret }), /kryptere/);
  const state = await memory.connect({ url: 'https://admin.example.org', key: secret, remember: false });
  assert.equal(state.status.connected, true); assert.equal(state.status.remembered, false);
  await assert.rejects(fs.stat(path.join(directory, 'admin-credentials.json')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(state).includes(secret), false);
});

test('encryption failure is explicit, never falls back to plaintext and allows a memory-only retry', async t => {
  const { service, directory } = await fixture(t, { encrypt: () => { throw new Error(`failure with ${secret}`); } });
  await assert.rejects(service.connect({ url: 'https://admin.example.org', key: secret }), failure => /kryptere/.test(failure.message) && !failure.message.includes(secret));
  assert.equal(service.status().configured, false); assert.equal(service.status().canRemember, false);
  assert.deepEqual(await fs.readdir(directory), []);
  await service.connect({ url: 'https://admin.example.org', key: secret, remember: false });
  assert.equal(service.status().connected, true);
});

test('a failed second endpoint does not grant admin access or store credentials', async t => {
  const { service, directory } = await fixture(t, { fetchImpl: async url => url.includes('/activity?') ? new Response(JSON.stringify({ error: secret }), { status: 401 }) : json(overview()) });
  await assert.rejects(service.connect({ url: 'https://admin.example.org', key: secret }), failure => /ikke godkjent/.test(failure.message) && !failure.message.includes(secret));
  assert.equal(service.status().configured, false); assert.equal(service.status().connected, false);
  assert.equal(service.getState().overview, null);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(JSON.stringify(service.getState()).includes(secret), false);
});

test('disabled admin endpoints and transport errors expose only fixed safe messages', async t => {
  const { service } = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ error: secret }), { status: 404 }) });
  await assert.rejects(service.connect({ url: 'https://admin.example.org', key: secret, remember: false }), /ikke aktivert/);
  const { service: transport } = await fixture(t, { fetchImpl: async () => { throw new Error(`Admin upstream ${secret}`); } });
  await assert.rejects(transport.connect({ url: 'https://admin.example.org', key: secret, remember: false }), failure => !failure.message.includes(secret) && /sikker forbindelse/.test(failure.message));
});

test('malformed and oversized responses fail closed without returning metadata', async t => {
  const samples = [
    () => new Response('{not json', { status: 200 }),
    () => json({ ...overview(), counts: { ...overview().counts, files: -1 } }),
    () => new Response('{}', { status: 200, headers: { 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response(' '.repeat(1024 * 1024 + 1), { status: 200 }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`Admin reader ${secret}`)); } }), { status: 200 })
  ];
  for (const response of samples) {
    const { service } = await fixture(t, { fetchImpl: async url => url.includes('/activity?') ? json(activity()) : response() });
    await assert.rejects(service.connect({ url: 'https://admin.example.org', key: secret, remember: false }), failure => !failure.message.includes(secret));
    assert.equal(service.status().connected, false); assert.equal(service.getState().overview, null);
  }
});

test('activity limits are bounded and become a fixed numeric query rather than an arbitrary URL', async t => {
  const { service, requests } = await fixture(t);
  await service.connect({ url: 'https://admin.example.org', key: secret, remember: false });
  const before = requests.length;
  for (const limit of [0, -1, 201, 1.5, '50', NaN]) await assert.rejects(service.getActivity({ limit }), /1 og 200/);
  assert.equal(requests.length, before);
  await service.getActivity({ limit: 200 });
  assert.equal(requests.at(-1).url, 'https://admin.example.org/api/admin/activity?limit=200');
});

test('disconnect removes only its own encrypted file and forgets metadata and credentials', async t => {
  const { service, directory } = await fixture(t);
  await service.connect({ url: 'https://admin.example.org', key: secret });
  await fs.writeFile(path.join(directory, 'brain.sqlite'), 'leave this alone');
  const state = await service.disconnect();
  assert.equal(state.status.configured, false); assert.equal(state.status.connected, false); assert.equal(state.status.url, '');
  assert.equal(state.overview, null); assert.equal(state.activity, null);
  assert.equal(await fs.readFile(path.join(directory, 'brain.sqlite'), 'utf8'), 'leave this alone');
  await assert.rejects(fs.stat(path.join(directory, 'admin-credentials.json')), { code: 'ENOENT' });
  await assert.rejects(service.getOverview(), /Koble til/);
});

test('late responses cannot reconnect an admin service after disconnect', async t => {
  const pending = [];
  const { service, directory } = await fixture(t, { fetchImpl: (url, init) => new Promise(resolve => pending.push({ url, init, resolve })) });
  const connecting = service.connect({ url: 'https://admin.example.org', key: secret });
  assert.equal(pending.length, 2);
  await service.disconnect();
  for (const request of pending) request.resolve(json(request.url.includes('/activity?') ? activity() : overview()));
  await assert.rejects(connecting, /ble endret/);
  assert.equal(service.status().configured, false); assert.equal(service.status().connected, false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('disconnect during encryption cannot recreate remembered credentials afterward', async t => {
  let entered, finish;
  const encrypting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const { service, directory } = await fixture(t, { encrypt: async () => { entered(); await gate; return Buffer.from([1, 2, 3]); } });
  const connecting = service.connect({ url: 'https://admin.example.org', key: secret });
  await encrypting; await service.disconnect(); finish();
  await assert.rejects(connecting, /ble endret/);
  assert.equal(service.status().configured, false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('the real HTTP transport refuses redirects before forwarding an admin key to another route', async t => {
  let captured = 0;
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/admin/activity?')) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(activity())); return; }
    if (request.url === '/api/admin/overview') { response.writeHead(302, { Location: '/capture-key' }).end(); return; }
    captured++; response.writeHead(200).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { service } = await fixture(t, { fetchImpl: globalThis.fetch, allowLoopbackHttp: true });
  await assert.rejects(service.connect({ url: `http://127.0.0.1:${server.address().port}`, key: secret, remember: false }), /sikker forbindelse/);
  assert.equal(captured, 0); assert.equal(service.status().connected, false);
});

test('requests stop after the ten second deadline even when a custom transport ignores abort', async t => {
  const { service } = await fixture(t, { fetchImpl: () => new Promise(() => {}) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connecting = service.connect({ url: 'https://admin.example.org', key: secret, remember: false });
  const rejected = assert.rejects(connecting, /10 sekunder/);
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(service.status().configured, false); assert.equal(service.status().connected, false);
});
