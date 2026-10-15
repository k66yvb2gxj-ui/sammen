import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateService } from '../src/updates.mjs';

const endpoint = 'https://api.github.com/repos/k66yvb2gxj-ui/sammen/releases/latest';
const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  let time = Date.UTC(2026, 9, 15, 12), next = response(release('v0.4.0'));
  const calls = [], snapshots = [], timers = new Map(); let timerId = 0;
  const service = createUpdateService({
    currentVersion: '0.3.0', now: () => time,
    fetchImpl: (...args) => { calls.push(args); return typeof next === 'function' ? next(...args) : Promise.resolve(next); },
    onStatus: value => snapshots.push(value),
    setTimeoutImpl: (callback, duration) => { const timer = ++timerId; timers.set(timer, { callback, duration }); return timer; },
    clearTimeoutImpl: timer => timers.delete(timer),
    ...options
  });
  return { service, calls, snapshots, timers, setResponse: value => { next = value; }, advance: duration => { time += duration; } };
}

test('checks only the fixed public endpoint without credentials and constructs its own release URL', async () => {
  const f = fixture();
  assert.deepEqual(f.service.status(), { currentVersion: '0.3.0', latestVersion: null, status: 'idle', releaseUrl: null, error: null, checkedAt: null });
  f.setResponse(response(release('v0.4.0', { html_url: 'https://untrusted.invalid/download', assets: [{ browser_download_url: 'file:///program.exe' }] })));
  const result = await f.service.check();
  assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0];
  assert.equal(url, endpoint); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.authorization, undefined);
  assert.equal(options.headers['User-Agent'], 'Sammen/0.3.0');
  assert.equal(result.status, 'available'); assert.equal(result.latestVersion, '0.4.0');
  assert.equal(result.releaseUrl, 'https://github.com/k66yvb2gxj-ui/sammen/releases/tag/v0.4.0');
  assert.equal(result.checkedAt, '2026-10-15T12:00:00.000Z'); assert.equal(result.error, null);
  assert.deepEqual(f.snapshots.map(value => value.status), ['checking', 'available']); assert.equal(f.timers.size, 0);
  result.status = 'error'; assert.equal(f.service.status().status, 'available', 'returned state must be a snapshot');
});

test('404 is an unpublished release, and equal or older numeric triples are current', async () => {
  for (const [body, httpStatus, expected, latest] of [[null, 404, 'unpublished', null], [release('v0.3.0'), 200, 'current', '0.3.0'], [release('0.2.99'), 200, 'current', '0.2.99']]) {
    const f = fixture(); f.setResponse(response(body, httpStatus));
    const result = await f.service.check();
    assert.equal(result.status, expected); assert.equal(result.latestVersion, latest); assert.equal(result.releaseUrl, null); assert.equal(result.error, null);
  }
});

test('version comparison uses each complete numeric component rather than strings or decimals', async () => {
  for (const [currentVersion, tag, expected] of [
    ['0.9.9', '0.10.0', 'available'], ['0.10.0', '0.9.99', 'current'], ['1.0.0', '0.99.999', 'current'],
    ['1.2.9', '1.2.10', 'available'], ['1.2.10', '1.2.9', 'current'], ['9.99.99', '10.0.0', 'available'],
    ['0.3.0', '0.3.9007199254740993', 'available']
  ]) {
    const f = fixture({ currentVersion }); f.setResponse(response(release(tag)));
    assert.equal((await f.service.check()).status, expected, `${currentVersion} -> ${tag}`);
  }
});

test('malformed, draft, prerelease, nonstable and untrusted tags never produce a download URL', async () => {
  for (const body of [null, [], {}, { tag_name: 'v0.4.0' }, release('v0.4.0', { draft: true }), release('v0.4.0', { prerelease: true }),
    ...['v0.4.0-beta.1', '0.4.0+build', '01.4.0', '0.04.0', '0.4', 'latest', 'V0.4.0', 'https://example.com/0.4.0', '../v0.4.0', 'v0.4.0\n'].map(tag => release(tag))]) {
    const f = fixture(); f.setResponse(response(body)); const result = await f.service.check();
    assert.equal(result.status, 'error', JSON.stringify(body)); assert.equal(result.releaseUrl, null); assert.equal(result.latestVersion, null);
  }
});

test('network, redirect and HTTP errors are bounded public errors without response details', async () => {
  for (const next of [response({}, 403), response({}, 500), response({}, 302), async () => { throw new Error('private diagnostic'); }, { ok: true, status: 200, json: async () => { throw new Error('private body'); } }]) {
    const f = fixture(); f.setResponse(next); const result = await f.service.check();
    assert.equal(result.status, 'error'); assert.equal(result.error, 'Kunne ikke sjekke oppdateringer. Prøv igjen senere.'); assert.equal(result.releaseUrl, null); assert.equal(f.timers.size, 0);
  }
});

test('a ten second deadline aborts even a fetch implementation that never settles', async () => {
  const f = fixture(); f.setResponse(() => new Promise(() => {}));
  const pending = f.service.check(); await tick();
  assert.equal(f.service.status().status, 'checking');
  assert.equal([...f.timers.values()][0].duration, 10_000);
  [...f.timers.values()][0].callback();
  const result = await pending;
  assert.equal(f.calls[0][1].signal.aborted, true); assert.equal(result.status, 'error');
  assert.equal(result.error, 'Oppdateringssjekken tok for lang tid. Prøv igjen.'); assert.equal(f.timers.size, 0);
});

test('cache lasts ten minutes, manual forcing bypasses it, and concurrent checks share one promise', async () => {
  const f = fixture();
  let finish; f.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const first = f.service.check(), second = f.service.check({ force: true });
  assert.equal(first, second); await tick(); assert.equal(f.calls.length, 1);
  finish(response(release('0.4.0'))); await first;
  await f.service.check(); f.advance(599_999); await f.service.check(); assert.equal(f.calls.length, 1);
  f.setResponse(response(release('0.5.0'))); await f.service.check({ force: true }); assert.equal(f.calls.length, 2); assert.equal(f.service.status().latestVersion, '0.5.0');
  f.advance(600_000); await f.service.check(); assert.equal(f.calls.length, 3);
});

test('unpublished and failed checks are cached as well, while a backwards clock refreshes', async () => {
  for (const next of [response(null, 404), response({}, 503)]) {
    const f = fixture(); f.setResponse(next); await f.service.check(); await f.service.check(); assert.equal(f.calls.length, 1);
    f.advance(-1); await f.service.check(); assert.equal(f.calls.length, 2);
  }
});

test('dispose aborts in-flight work, clears its timeout and suppresses late events and further requests', async () => {
  const f = fixture(); f.setResponse(() => new Promise(() => {}));
  const pending = f.service.check(); await tick(); const count = f.snapshots.length;
  f.service.dispose(); await pending;
  assert.equal(f.calls[0][1].signal.aborted, true); assert.equal(f.timers.size, 0); assert.equal(f.snapshots.length, count);
  await f.service.check({ force: true }); assert.equal(f.calls.length, 1);
});

test('invalid current versions do not request a release or crash startup, and observer errors do not break checks', async () => {
  const invalid = fixture({ currentVersion: 'development' }); assert.equal((await invalid.service.check()).status, 'error'); assert.equal(invalid.calls.length, 0);
  const throwing = fixture({ onStatus() { throw new Error('UI is gone'); } }); assert.equal((await throwing.service.check()).status, 'available');
});
