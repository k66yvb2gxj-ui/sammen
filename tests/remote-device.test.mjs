import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteDeviceService } from '../src/remote-device.mjs';

const agentName = '@wonderwhy-er/desktop-commander';
const agentEntry = 'agent/node_modules/@wonderwhy-er/desktop-commander/dist/index.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sammen-remote-device-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const runtimeDirectory = path.join(directory, 'bundle'), workDirectory = path.join(directory, 'own-user-work');
  await mkdir(path.join(runtimeDirectory, 'runtime'), { recursive: true });
  await mkdir(path.dirname(path.join(runtimeDirectory, agentEntry)), { recursive: true });
  await writeFile(path.join(runtimeDirectory, 'runtime/node.exe'), 'fixture, never executed');
  await writeFile(path.join(runtimeDirectory, agentEntry), 'fixture, never executed');
  const manifest = { runtime: { version: '22.23.0', entry: 'runtime/node.exe' }, agent: { name: agentName, version: '0.3.0', entry: agentEntry }, license: 'MIT' };
  await writeFile(path.join(runtimeDirectory, 'bundle.json'), JSON.stringify(manifest));
  await writeFile(path.join(runtimeDirectory, 'agent/node_modules/@wonderwhy-er/desktop-commander/package.json'), JSON.stringify({ name: agentName, version: '0.3.0', license: 'MIT' }));
  return { runtimeDirectory, workDirectory, manifest };
}

function fakeProcesses({ autoSpawn = true, killError = null, delayedKill = false } = {}) {
  const calls = [], children = [], killers = [];
  let nextPid = 43000;
  function child() {
    const process = new EventEmitter();
    process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.pid = nextPid++;
    process.kill = () => { queueMicrotask(() => process.emit('close', 0, 'SIGTERM')); return true; };
    return process;
  }
  function finishKill(killer) {
    if (killError) { killer.emit('error', new Error(killError)); return; }
    children.find(process => process.pid === Number(killer.ownedPid))?.emit('close', 0, null);
    killer.emit('close', 0);
  }
  function spawnImpl(executable, args, options) {
    calls.push({ executable, args, options });
    const process = child();
    if (path.basename(executable).toLowerCase() === 'taskkill.exe') {
      process.ownedPid = args[1]; killers.push(process);
      if (!delayedKill) queueMicrotask(() => finishKill(process));
    } else {
      children.push(process);
      if (autoSpawn) queueMicrotask(() => process.emit('spawn'));
    }
    return process;
  }
  return { calls, children, killers, spawnImpl, finishKill };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function startedProcess(service, processes) {
  const count = processes.children.length;
  const start = service.start();
  while (processes.children.length === count) await tick();
  return { start, child: processes.children.at(-1) };
}

test('probing a bundled runtime never downloads, enrolls, or starts a process', async t => {
  const f = await fixture(t), p = fakeProcesses();
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  assert.deepEqual(service.status(), { available: true, packagedRuntime: true, state: 'stopped', running: false, logs: [], dashboardUrl: 'https://mcp.desktopcommander.app/', documentationUrl: 'https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md' });
  assert.equal(p.calls.length, 0);
  assert.equal((await service.stop()).state, 'stopped');
  assert.equal(p.calls.length, 0);
  await rm(path.join(f.runtimeDirectory, 'runtime/node.exe'));
  assert.equal(service.status().available, false);
  assert.equal(service.status().packagedRuntime, false);
  assert.equal((await service.start()).state, 'error');
  assert.equal(p.calls.length, 0);
});

test('bundle manifests cannot select another executable or unpinned agent version', async t => {
  const f = await fixture(t), p = fakeProcesses();
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  for (const altered of [
    { ...f.manifest, runtime: { version: '22.11.0', entry: 'runtime/node.exe' } },
    { ...f.manifest, runtime: { version: '22.23.0', entry: '../../node.exe' } },
    { ...f.manifest, agent: { ...f.manifest.agent, version: 'latest' } },
    { ...f.manifest, agent: { ...f.manifest.agent, entry: '../../malicious.js' } },
  ]) {
    await writeFile(path.join(f.runtimeDirectory, 'bundle.json'), JSON.stringify(altered));
    assert.equal((await service.start()).available, false);
  }
  await writeFile(path.join(f.runtimeDirectory, 'bundle.json'), JSON.stringify(f.manifest));
  await writeFile(path.join(f.runtimeDirectory, 'agent/node_modules/@wonderwhy-er/desktop-commander/package.json'), JSON.stringify({ name: agentName, version: '0.4.0', license: 'MIT' }));
  assert.equal((await service.start()).available, false);
  assert.equal(p.calls.length, 0);
});

test('explicit start uses the fixed local runtime and one process, preserving own home and TLS trust', async t => {
  const f = await fixture(t), p = fakeProcesses(), snapshots = [];
  const previousOptions = process.env.NODE_OPTIONS, previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const previousServerUrl = process.env.MCP_SERVER_URL;
  process.env.NODE_OPTIONS = '--enable-source-maps --max-old-space-size=2048 --require=untrusted.js --tls-cipher-list=ALL';
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.MCP_SERVER_URL = 'https://example.invalid';
  try {
    const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32', onStatus: value => snapshots.push(value) });
    const results = await Promise.all([service.start(), service.start(), service.start()]);
    assert.equal(p.children.length, 1);
    assert.ok(results.every(result => result.state === 'running' && result.running));
    assert.equal(p.calls[0].executable, path.join(f.runtimeDirectory, 'runtime/node.exe'));
    assert.deepEqual(p.calls[0].args, [path.join(f.runtimeDirectory, agentEntry), 'remote']);
    const options = p.calls[0].options;
    assert.equal(options.cwd, f.workDirectory);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env.HOME, process.env.HOME); assert.equal(options.env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(options.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(options.env.NODE_USE_SYSTEM_CA, '1');
    assert.equal(options.env.MCP_SERVER_URL, 'https://mcp.desktopcommander.app');
    assert.equal(options.env.NODE_OPTIONS, '--enable-source-maps --max-old-space-size=2048');
    const pathValue = Object.entries(options.env).find(([key]) => key.toLowerCase() === 'path')[1];
    assert.ok(pathValue.startsWith(path.join(f.runtimeDirectory, 'runtime') + ';'));
    assert.deepEqual(snapshots.slice(0, 2).map(value => value.state), ['starting', 'running']);
    const snapshot = service.status(); snapshot.logs.push('cannot alter service');
    assert.deepEqual(service.status().logs, []);
    await service.stop();
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    if (previousServerUrl === undefined) delete process.env.MCP_SERVER_URL; else process.env.MCP_SERVER_URL = previousServerUrl;
  }
});

test('Windows stop terminates only the owned process tree and blocks a new start until finished', async t => {
  const f = await fixture(t), p = fakeProcesses({ delayedKill: true });
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  await service.start();
  const first = p.children[0], stopped = service.stop(), started = service.start();
  await tick();
  assert.equal(p.children.length, 1);
  assert.equal(p.killers.length, 1);
  assert.deepEqual(p.calls[1].args, ['/PID', String(first.pid), '/T', '/F']);
  assert.equal(p.calls[1].options.shell, false); assert.equal(p.calls[1].options.windowsHide, true);
  p.finishKill(p.killers[0]);
  assert.equal((await stopped).state, 'stopped');
  assert.equal((await started).state, 'running');
  assert.equal(p.children.length, 2);
  first.emit('error', new Error('stale old error')); first.emit('close', 9);
  first.stderr.write('stale log\n');
  assert.equal(service.status().state, 'running');
  assert.deepEqual(service.status().logs, []);
  const finalStop = service.stop(); p.finishKill(p.killers.at(-1)); await finalStop;
});

test('stop cancels a start still preparing its working directory and cannot accidentally launch it', async t => {
  const f = await fixture(t), p = fakeProcesses();
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  const start = service.start(), stop = service.stop();
  await Promise.all([start, stop]);
  assert.equal(service.status().state, 'stopped'); assert.equal(p.calls.length, 0);
});

test('stop also resolves a start whose native spawn event has not arrived', async t => {
  const f = await fixture(t), p = fakeProcesses({ autoSpawn: false });
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  const { start, child } = await startedProcess(service, p);
  await service.stop(); await start;
  child.emit('spawn');
  assert.equal(service.status().state, 'stopped'); assert.equal(service.status().running, false);
});

test('log buffers remove ANSI and secrets across chunks while retaining the own pairing code', async t => {
  const f = await fixture(t), p = fakeProcesses();
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  await service.start();
  const child = p.children[0];
  child.stdout.write('\x1b[32mPairing code: ABCD-1234\x1b[0m\nBearer partly');
  assert.deepEqual(service.status().logs, ['Pairing code: ABCD-1234']);
  child.stdout.write('split-access-value\n{"accessToken":"keep-secret-hidden", "refresh_token":"another-secret"}\n');
  child.stderr.write('password="this password has spaces"\nhttps://example.org/callback?access_token=secret-query&code=PAIR\n');
  child.stderr.write('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature\n');
  const joined = service.status().logs.join('\n');
  for (const secret of ['partly', 'split-access-value', 'keep-secret-hidden', 'another-secret', 'this password has spaces', 'secret-query', 'eyJhbGci']) assert.ok(!joined.includes(secret), secret);
  assert.ok(joined.includes('ABCD-1234')); assert.ok(joined.includes('code=PAIR'));
  child.stdout.write('A'.repeat(100000));
  child.stdout.write('continuation hidden\n');
  for (let i = 0; i < 200; i++) child.stdout.write(`Line ${i}\n`);
  assert.equal(service.status().logs.length, 120);
  assert.ok(service.status().logs.every(line => line.length <= 2000));
  assert.equal(service.status().logs.at(-1), 'Line 199');
  await service.stop();
});

test('a spawn error is contained and an unexpected exit can be retried without stale events', async t => {
  const f = await fixture(t), p = fakeProcesses({ autoSpawn: false });
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  const first = await startedProcess(service, p);
  first.child.emit('error', new Error('missing executable; token=do-not-display'));
  assert.equal((await first.start).state, 'error');
  assert.equal(service.status().running, false); assert.ok(!service.status().error.includes('do-not-display'));
  const second = await startedProcess(service, p);
  second.child.emit('spawn'); await second.start;
  assert.equal(service.status().state, 'running');
  first.child.emit('close', 7); first.child.emit('error', new Error('stale failure'));
  assert.equal(service.status().state, 'running');
  second.child.emit('close', 12);
  assert.equal(service.status().state, 'error'); assert.equal(service.status().running, false);
  assert.match(service.status().error, /12/);
  const third = await startedProcess(service, p); third.child.emit('spawn'); await third.start;
  await service.stop();
});

test('failed tree termination stays visible and cannot create a second agent', async t => {
  const f = await fixture(t), p = fakeProcesses({ killError: 'access denied' });
  const service = createRemoteDeviceService({ runtimeDirectory: f.runtimeDirectory, directory: f.workDirectory, spawnImpl: p.spawnImpl, platform: 'win32' });
  await service.start();
  const stopped = await service.stop();
  assert.equal(stopped.state, 'error'); assert.equal(stopped.running, true);
  assert.match(stopped.error, /access denied/);
  await service.start();
  assert.equal(p.children.length, 1);
  p.children[0].stdout.write('Agent still active after failed stop\n');
  assert.ok(service.status().logs.includes('Agent still active after failed stop'));
  p.children[0].emit('close', 0);
  assert.equal(service.status().running, false);
  assert.equal(service.status().state, 'stopped');
  assert.equal(service.status().error, undefined);
  await service.stop();
  assert.equal(service.status().state, 'stopped'); assert.equal(service.status().running, false);
});
