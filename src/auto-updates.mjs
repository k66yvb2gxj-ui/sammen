const RELEASE_PAGE = 'https://github.com/k66yvb2gxj-ui/sammen/releases/tag/';

function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match?.[0] === value ? { text: match.slice(1).join('.'), parts: match.slice(1).map(BigInt) } : null;
}

function newerVersion(candidate, current) {
  if (!candidate || !current) return false;
  for (let index = 0; index < 3; index++) {
    if (candidate.parts[index] !== current.parts[index]) return candidate.parts[index] > current.parts[index];
  }
  return false;
}

function unpublished(error) {
  return error?.statusCode === 404 || error?.status === 404
    || ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'].includes(error?.code);
}

// The updater's packaged app-update.yml selects the public release provider.
// This adapter never changes feed URLs, request credentials or verification.
// The caller must save drafts and stop its services before calling install().
export function createAutoUpdateService({ updater, currentVersion, onStatus = () => {}, now = Date.now } = {}) {
  const current = stableVersion(currentVersion);
  let state = { currentVersion, latestVersion: null, status: 'idle', releaseUrl: null, error: null, checkedAt: null, automatic: true, progress: null };
  let pending = null, download = null, cancellation = null, candidate = null, downloaded = null, disposed = false;
  const listeners = new Map();
  const status = () => ({ ...state });
  const releaseUrl = version => `${RELEASE_PAGE}v${encodeURIComponent(version.text)}`;
  const keepDownloaded = () => Boolean(downloaded) && state.status !== 'installing';

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;

  function publish(next) {
    if (disposed) return status();
    const updated = { ...state, ...next };
    if (Object.keys(updated).every(key => updated[key] === state[key])) return status();
    state = updated;
    try { onStatus(status()); } catch {}
    return status();
  }

  function fail(error, phase = candidate ? 'download' : 'check') {
    if (disposed || keepDownloaded()) return status();
    const missing = phase === 'check' && unpublished(error);
    const nextStatus = missing ? 'unpublished' : 'error';
    const message = missing ? null : phase === 'install' ? 'Oppdateringen kunne ikke installeres. Prøv igjen.'
      : phase === 'download' ? 'Oppdateringen kunne ikke lastes ned. Prøv igjen.' : 'Kunne ikke sjekke oppdateringer. Prøv igjen senere.';
    if (state.status === nextStatus && state.error === message) return status();
    return publish({ status: nextStatus, error: message, progress: null, checkedAt: new Date(now()).toISOString(),
      latestVersion: missing ? null : candidate?.text || null, releaseUrl: missing || !candidate ? null : releaseUrl(candidate) });
  }

  function validInfo(info) {
    if (info?.draft === true || info?.prerelease === true) return null;
    return stableVersion(info?.version);
  }

  function available(info) {
    if (disposed || downloaded || state.status === 'installing') return false;
    const version = validInfo(info);
    if (!newerVersion(version, current)) { candidate = null; fail(new Error('invalid-update-version'), 'check'); return false; }
    const same = candidate?.text === version.text;
    candidate = version;
    if (!same || !['available', 'downloading'].includes(state.status)) publish({ status: 'available', latestVersion: version.text,
      releaseUrl: releaseUrl(version), progress: null, error: null, checkedAt: new Date(now()).toISOString() });
    return true;
  }

  function notAvailable(info) {
    if (disposed || downloaded || state.status === 'installing') return;
    const version = validInfo(info);
    if (!current || !version) { candidate = null; fail(new Error('invalid-update-version'), 'check'); return; }
    candidate = null;
    publish({ status: 'current', latestVersion: version.text, releaseUrl: null, progress: null, error: null, checkedAt: new Date(now()).toISOString() });
  }

  function downloadedUpdate(info) {
    if (disposed || state.status === 'installing') return;
    const version = validInfo(info);
    if (!newerVersion(version, current) || (candidate && candidate.text !== version.text)) { fail(new Error('invalid-downloaded-version'), 'download'); return; }
    candidate = downloaded = version; cancellation = null;
    publish({ status: 'downloaded', latestVersion: version.text, releaseUrl: releaseUrl(version), progress: 100, error: null, checkedAt: new Date(now()).toISOString() });
  }

  function supervise(result) {
    const promise = result?.downloadPromise;
    if (!promise || typeof promise.then !== 'function') return;
    cancellation = result.cancellationToken || null;
    const supervised = Promise.resolve(promise).catch(error => { fail(error, 'download'); }).finally(() => {
      if (download === supervised) { download = null; cancellation = null; }
    });
    download = supervised;
  }

  function listen(event, callback) { listeners.set(event, callback); updater.on(event, callback); }
  listen('checking-for-update', () => {
    if (downloaded || download || state.status === 'installing') return;
    publish({ status: 'checking', latestVersion: null, releaseUrl: null, error: null, progress: null });
  });
  listen('update-available', available);
  listen('update-not-available', notAvailable);
  listen('download-progress', progress => {
    if (!candidate || downloaded || state.status === 'installing' || !Number.isFinite(progress?.percent)) return;
    publish({ status: 'downloading', progress: Math.max(0, Math.min(100, progress.percent)), error: null });
  });
  listen('update-downloaded', downloadedUpdate);
  listen('update-cancelled', error => fail(error, 'download'));
  listen('error', error => fail(error, state.status === 'installing' ? 'install' : candidate ? 'download' : 'check'));

  function check() {
    if (!disposed && downloaded && state.status === 'error') publish({ status: 'downloaded', progress: 100, error: null });
    if (disposed || downloaded || state.status === 'installing') return Promise.resolve(status());
    if (pending) return pending;
    if (download) return Promise.resolve(status());
    candidate = null;
    pending = Promise.resolve().then(async () => {
      if (disposed) return status();
      try {
        if (!current) return fail(new Error('invalid-current-version'), 'check');
        const result = await updater.checkForUpdates();
        // Even an invalid/late result may contain an already-rejected download.
        // Observe it before inspecting metadata so it cannot escape unhandled.
        supervise(result);
        if (disposed) { cancellation?.cancel?.(); return status(); }
        if (!result || typeof result.isUpdateAvailable !== 'boolean') return fail(new Error('invalid-update-result'), 'check');
        if (!result.isUpdateAvailable) notAvailable(result.updateInfo);
        else if (!downloaded && available(result.updateInfo)) {
          if (download && state.status === 'available') publish({ status: 'downloading', progress: 0 });
        } else if (!downloaded) cancellation?.cancel?.();
        return status();
      } catch (error) { return fail(error, candidate ? 'download' : 'check'); }
    }).finally(() => { pending = null; });
    publish({ status: 'checking', latestVersion: null, releaseUrl: null, error: null, progress: null });
    return pending;
  }

  function install({ restart = true } = {}) {
    if (disposed || !downloaded || state.status === 'installing') return false;
    publish({ status: 'installing', progress: 100, error: null });
    try {
      updater.quitAndInstall(true, restart === true);
      return state.status === 'installing';
    } catch (error) { fail(error, 'install'); return false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!downloaded) { try { cancellation?.cancel?.(); } catch {} }
    for (const [event, callback] of listeners) updater.removeListener(event, callback);
    listeners.clear();
  }
  return { status, check, install, dispose };
}
