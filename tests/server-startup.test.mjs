import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';

const entrypoint = fileURLToPath(new URL('../server/room-server.mjs', import.meta.url));
const createKey = 'test-only-render-creation-key-123456789';

async function startup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-server-startup-'));
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, [entrypoint], {
    windowsHide: true,
    env: { ...process.env, SAMMEN_DATA_DIR: directory, SAMMEN_BIND: '127.0.0.1', PORT: String(port),
      SAMMEN_CREATE_KEY: createKey, SAMMEN_PUBLIC_BRAIN: '0', SAMMEN_ADMIN_KEY: '',
      SAMMEN_PUBLIC_ORIGIN: '', RENDER_EXTERNAL_URL: 'https://sammen-test.onrender.com', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    const target = resolve(directory), below = relative(resolve(tmpdir()), target);
    assert.ok(below && !below.startsWith('..' + sep) && below.startsWith('sammen-server-startup-'));
    await rm(target, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30_000;
  while (!output.includes('Sammen fellesromserver er klar.') && child.exitCode === null && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 20));
  }
  return { url: `http://127.0.0.1:${port}`, child, exited, output: () => output };
}

for (const [label, overrides, expectedOrigin] of [
  ['Render supplies the invitation origin', {}, 'https://sammen-test.onrender.com'],
  ['an explicit custom domain takes precedence', { SAMMEN_PUBLIC_ORIGIN: 'https://brain.example.org' }, 'https://brain.example.org']
]) {
  test(`server entrypoint: ${label}`, { timeout: 45_000 }, async t => {
    const service = await startup(t, overrides);
    assert.match(service.output(), /Sammen fellesromserver er klar\./);
    assert.equal((await fetch(`${service.url}/health`)).status, 200);
    const store = new Store();
    try {
      const projectId = store.snapshot().projects[0].id;
      const response = await fetch(`${service.url}/api/rooms`, {
        method: 'POST', headers: { Authorization: `Bearer ${createKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: store.exportProject(projectId), user: store.getMeta('user') })
      });
      assert.equal(response.status, 201);
      const created = await response.json();
      assert.equal(new URL(created.roomUrl).origin, expectedOrigin);
      assert.equal(JSON.parse(Buffer.from(created.inviteCode.slice(3), 'base64url')).url, created.roomUrl);
      assert.ok(!service.output().includes(createKey));
    } finally { store.close(); }
  });
}

test('server entrypoint rejects an insecure Render origin before listening', { timeout: 45_000 }, async t => {
  const service = await startup(t, { RENDER_EXTERNAL_URL: 'http://example.org' });
  const [code] = await service.exited;
  assert.notEqual(code, 0);
  assert.match(service.output(), /HTTPS/);
  assert.doesNotMatch(service.output(), /Sammen fellesromserver er klar\./);
});
