import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAutoUpdateService } from '../src/auto-updates.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const info = (version = '0.5.0', extra = {}) => ({ version, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(options = {}) {
  const updater = new EventEmitter(), snapshots = [], installs = [];
  let calls = 0, next = { isUpdateAvailable: false, updateInfo: info('0.4.0') };
  // electron-updater keeps its own logging listener; this fixture does too.
  const internalError = () => {}; updater.on('error', internalError);
  updater.checkForUpdates = async () => { calls++; return typeof next === 'function' ? next() : next; };
  updater.quitAndInstall = (...args) => { installs.push(args); };
  updater.verifyUpdateCodeSignature = true;
  const service = createAutoUpdateService({ updater, currentVersion: '0.4.0', now: () => Date.UTC(2026, 9, 15, 14), onStatus: value => snapshots.push(value), ...options });
  return { updater, service, snapshots, installs, internalError, calls: () => calls, setResult: value => { next = value; } };
}

test('configures automatic download but preserves caller-controlled installation and provider verification', () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, true); assert.equal(f.updater.autoInstallOnAppQuit, false); assert.equal(f.updater.autoRunAppAfterInstall, false);
  assert.equal(f.updater.allowPrerelease, false); assert.equal(f.updater.allowDowngrade, false); assert.equal(f.updater.verifyUpdateCodeSignature, true);
  assert.equal(f.updater.setFeedURL, undefined); assert.equal(f.updater.requestHeaders, undefined);
  assert.deepEqual(f.service.status(), { currentVersion: '0.4.0', latestVersion: null, status: 'idle', releaseUrl: null, error: null, checkedAt: null, automatic: true, progress: null });
  assert.equal(f.service.install(), false); assert.equal(f.installs.length, 0);
});

test('checks current version and emits safe state snapshots', async () => {
  const f = fixture(); const value = await f.service.check();
  assert.equal(value.status, 'current'); assert.equal(value.latestVersion, '0.4.0'); assert.equal(value.releaseUrl, null);
  assert.equal(value.checkedAt, '2026-10-15T14:00:00.000Z'); assert.equal(f.calls(), 1);
  value.status = 'downloaded'; assert.equal(f.service.status().status, 'current');
  assert.deepEqual(f.snapshots.map(value => value.status), ['checking', 'current']);
});

test('a check settles after metadata while download progress continues, and only downloaded event enables installation', async () => {
  const f = fixture(), download = deferred();
  f.setResult(() => {
    f.updater.emit('checking-for-update'); f.updater.emit('update-available', info());
    return { isUpdateAvailable: true, updateInfo: info(), downloadPromise: download.promise };
  });
  assert.equal((await f.service.check()).status, 'downloading'); assert.equal(f.service.status().progress, 0); assert.equal(f.service.install(), false);
  f.updater.emit('download-progress', { percent: 48.5 }); assert.equal(f.service.status().progress, 48.5);
  f.updater.emit('update-downloaded', info()); download.resolve(['only-an-updater-fixture.exe']); await tick();
  assert.equal(f.service.status().status, 'downloaded'); assert.equal(f.service.status().progress, 100); assert.equal(f.installs.length, 0);
  assert.equal(f.service.install({ restart: true }), true); assert.deepEqual(f.installs, [[true, true]]); assert.equal(f.service.status().status, 'installing');
  assert.equal(f.service.install(), false); assert.equal(f.installs.length, 1);
});

test('regular-quit installation uses silent mode without relaunching', () => {
  const f = fixture(); f.updater.emit('update-available', info()); f.updater.emit('update-downloaded', info());
  assert.equal(f.service.install({ restart: false }), true); assert.deepEqual(f.installs, [[true, false]]);
});

test('downloaded state survives subsequent checks and unrelated metadata/error events', async () => {
  const f = fixture(); f.updater.emit('update-downloaded', info()); const ready = f.service.status();
  assert.equal((await f.service.check()).status, 'downloaded'); assert.equal(f.calls(), 0);
  f.updater.emit('checking-for-update'); f.updater.emit('update-not-available', info('0.4.0')); f.updater.emit('error', new Error('late check error'));
  assert.deepEqual(f.service.status(), ready);
});

test('concurrent checks share one promise and a pending download does not start another check', async () => {
  const f = fixture(), metadata = deferred(), download = deferred(); f.setResult(() => metadata.promise);
  const one = f.service.check(), two = f.service.check(); assert.equal(one, two); await tick(); assert.equal(f.calls(), 1);
  metadata.resolve({ isUpdateAvailable: true, updateInfo: info(), downloadPromise: download.promise }); await one;
  await f.service.check(); assert.equal(f.calls(), 1);
  f.updater.emit('update-downloaded', info()); download.resolve([]); await tick();
});

test('failed metadata checks can be retried and classify missing public releases without leaking diagnostics', async () => {
  for (const error of [Object.assign(new Error('sensitive missing URL'), { statusCode: 404 }), Object.assign(new Error('private'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }), Object.assign(new Error('private'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })]) {
    const f = fixture(); f.setResult(() => { throw error; });
    const missing = await f.service.check(); assert.equal(missing.status, 'unpublished'); assert.equal(missing.error, null); assert.equal(missing.releaseUrl, null);
    f.setResult({ isUpdateAvailable: false, updateInfo: info('0.4.0') }); assert.equal((await f.service.check()).status, 'current'); assert.equal(f.calls(), 2);
  }
  const f = fixture(); f.setResult(() => { throw new Error('token=private'); });
  assert.equal((await f.service.check()).error, 'Kunne ikke sjekke oppdateringer. Prøv igjen senere.');
});

test('download promise rejections are observed once, stay errors for asset 404s, and permit retry', async () => {
  const f = fixture(), download = deferred();
  f.setResult({ isUpdateAvailable: true, updateInfo: info(), downloadPromise: download.promise }); await f.service.check();
  const error = Object.assign(new Error('private download address'), { statusCode: 404 });
  f.updater.emit('error', error); download.reject(error); await tick();
  assert.equal(f.service.status().status, 'error'); assert.equal(f.service.status().error, 'Oppdateringen kunne ikke lastes ned. Prøv igjen.');
  assert.equal(f.snapshots.filter(value => value.status === 'error').length, 1);
  f.setResult({ isUpdateAvailable: false, updateInfo: info('0.4.0') }); assert.equal((await f.service.check()).status, 'current'); assert.equal(f.calls(), 2);
});

test('invalid, prerelease, downgrade and mismatched downloaded versions cannot be installed', async () => {
  for (const value of ['0.4.0', '0.3.99', '0.5.0-beta.1', '0.5.0+build', '00.5.0', '0.5', '0.5.0\n', 'https://bad.invalid/0.5.0']) {
    const f = fixture(); f.updater.emit('update-available', info(value)); f.updater.emit('update-downloaded', info(value));
    assert.equal(f.service.status().status, 'error', value); assert.equal(f.service.install(), false); assert.equal(f.installs.length, 0);
  }
  for (const extra of [{ prerelease: true }, { draft: true }]) {
    const f = fixture(); f.setResult({ isUpdateAvailable: true, updateInfo: info('0.5.0', extra) });
    assert.equal((await f.service.check()).status, 'error'); assert.equal(f.service.install(), false);
  }
  const f = fixture(); f.updater.emit('update-available', info('0.6.0')); f.updater.emit('update-downloaded', info('0.5.0'));
  assert.equal(f.service.status().status, 'error'); assert.equal(f.service.install(), false);
});

test('numeric triples compare correctly and rollout decisions are honored', async () => {
  for (const [currentVersion, version] of [['0.9.9', '0.10.0'], ['1.2.9', '1.2.10'], ['9.99.99', '10.0.0']]) {
    const f = fixture({ currentVersion }); f.setResult({ isUpdateAvailable: true, updateInfo: info(version) });
    assert.equal((await f.service.check()).status, 'available'); assert.equal(f.service.status().latestVersion, version);
    assert.equal(f.service.status().releaseUrl, `https://github.com/k66yvb2gxj-ui/sammen/releases/tag/v${version}`);
  }
  const f = fixture(); f.setResult({ isUpdateAvailable: false, updateInfo: info('0.5.0') });
  assert.equal((await f.service.check()).status, 'current'); assert.equal(f.service.install(), false);
});

test('malformed check results never make a release installable, and invalid download promises are still observed', async () => {
  for (const result of [null, {}, { isUpdateAvailable: 'yes', updateInfo: info() }, { isUpdateAvailable: true, updateInfo: null }]) {
    const f = fixture(); f.setResult(result); assert.equal((await f.service.check()).status, 'error'); assert.equal(f.service.install(), false);
  }
  const f = fixture(), download = deferred(); let cancelled = 0;
  f.setResult({ isUpdateAvailable: true, updateInfo: info('0.1.0'), downloadPromise: download.promise, cancellationToken: { cancel() { cancelled++; } } });
  await f.service.check(); download.reject(new Error('cancelled')); await tick();
  assert.equal(f.service.install(), false); assert.equal(cancelled, 1);
});

test('progress is bounded, nonfinite values are ignored, and cancellation can be retried', async () => {
  const f = fixture(); f.updater.emit('update-available', info());
  for (const [percent, expected] of [[-5, 0], [500, 100], [25.25, 25.25]]) { f.updater.emit('download-progress', { percent }); assert.equal(f.service.status().progress, expected); }
  for (const percent of [NaN, Infinity, undefined, '70']) f.updater.emit('download-progress', { percent });
  assert.equal(f.service.status().progress, 25.25);
  f.updater.emit('update-cancelled', info()); assert.equal(f.service.status().status, 'error');
  assert.equal((await f.service.check()).status, 'current');
});

test('installation exceptions and updater install errors are sanitized and allow retry through the UI check', async () => {
  for (const emits of [false, true]) {
    const f = fixture(); f.updater.emit('update-downloaded', info());
    f.updater.quitAndInstall = () => { if (emits) f.updater.emit('error', new Error('private installer path')); else throw new Error('private path'); };
    assert.equal(f.service.install(), false); assert.equal(f.service.status().status, 'error');
    assert.equal(f.service.status().error, 'Oppdateringen kunne ikke installeres. Prøv igjen.');
    assert.equal((await f.service.check()).status, 'downloaded');
    assert.equal(f.calls(), 0);
    f.updater.quitAndInstall = (...args) => f.installs.push(args); assert.equal(f.service.install(), true);
  }
});

test('dispose cancels pending downloads, removes only owned listeners and suppresses late promises', async () => {
  const f = fixture(), download = deferred(); let cancelled = 0;
  f.setResult({ isUpdateAvailable: true, updateInfo: info(), downloadPromise: download.promise, cancellationToken: { cancel() { cancelled++; } } });
  await f.service.check(); const count = f.snapshots.length; f.service.dispose(); f.service.dispose();
  assert.equal(cancelled, 1); assert.deepEqual(f.updater.listeners('error'), [f.internalError]);
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'update-cancelled']) assert.equal(f.updater.listenerCount(event), 0);
  download.reject(new Error('late')); await tick(); f.updater.emit('update-downloaded', info());
  assert.equal(f.snapshots.length, count); assert.equal(f.service.install(), false); await f.service.check(); assert.equal(f.calls(), 1);
});

test('disposed in-flight metadata is observed and its eventual download is cancelled', async () => {
  const f = fixture(), metadata = deferred(), download = deferred(); let cancelled = 0; f.setResult(() => metadata.promise);
  const pending = f.service.check(); await tick(); f.service.dispose(); const count = f.snapshots.length;
  metadata.resolve({ isUpdateAvailable: true, updateInfo: info(), downloadPromise: download.promise, cancellationToken: { cancel() { cancelled++; } } });
  await pending; download.reject(new Error('late')); await tick(); assert.equal(cancelled, 1); assert.equal(f.snapshots.length, count);
});

test('invalid current versions do not check and status-observer failures do not break updating', async () => {
  const invalid = fixture({ currentVersion: 'development' }); assert.equal((await invalid.service.check()).status, 'error'); assert.equal(invalid.calls(), 0);
  const f = fixture({ onStatus() { throw new Error('UI gone'); } }); assert.equal((await f.service.check()).status, 'current');
});
