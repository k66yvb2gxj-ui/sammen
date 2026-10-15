const RELEASE_ENDPOINT = 'https://api.github.com/repos/k66yvb2gxj-ui/sammen/releases/latest';
const RELEASE_PAGE = 'https://github.com/k66yvb2gxj-ui/sammen/releases/tag/';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;

function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match?.[0] === value ? { text: match.slice(1).join('.'), parts: match.slice(1).map(BigInt) } : null;
}

function newerVersion(candidate, current) {
  for (let index = 0; index < 3; index++) {
    if (candidate.parts[index] !== current.parts[index]) return candidate.parts[index] > current.parts[index];
  }
  return false;
}

// This service only checks public release metadata. Downloading and starting a
// new version remains an explicit action in the user's external browser.
export function createUpdateService({ currentVersion, fetchImpl = globalThis.fetch, now = Date.now, onStatus = () => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const current = stableVersion(currentVersion);
  let state = { currentVersion, latestVersion: null, status: 'idle', releaseUrl: null, error: null, checkedAt: null };
  let pending = null, completedAt = null, activeController = null, disposed = false;
  const status = () => ({ ...state });
  function publish(next) {
    state = { ...state, ...next };
    try { onStatus(status()); } catch {}
    return status();
  }

  async function readRelease(signal) {
    if (!current) throw new Error('invalid-current-version');
    const response = await fetchImpl(RELEASE_ENDPOINT, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `Sammen/${current.text}` }
    });
    if (response?.status === 404) return { status: 'unpublished', latestVersion: null, releaseUrl: null };
    if (response?.ok !== true) throw new Error('release-request-failed');
    const release = await response.json();
    if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false) throw new Error('invalid-release');
    const latest = stableVersion(release.tag_name);
    if (!latest) throw new Error('invalid-release-version');
    const available = newerVersion(latest, current);
    return { status: available ? 'available' : 'current', latestVersion: latest.text, releaseUrl: available ? `${RELEASE_PAGE}${encodeURIComponent(release.tag_name)}` : null };
  }

  async function run() {
    if (disposed) return status();
    const controller = new AbortController(); activeController = controller;
    let timeout, timedOut = false, abort;
    const deadline = new Promise((_, reject) => {
      abort = () => reject(new Error('release-check-aborted'));
      controller.signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeoutImpl(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
      timeout?.unref?.();
    });
    try {
      const result = await Promise.race([readRelease(controller.signal), deadline]);
      if (disposed) return status();
      completedAt = now();
      return publish({ ...result, error: null, checkedAt: new Date(completedAt).toISOString() });
    } catch {
      if (disposed) return status();
      completedAt = now();
      return publish({ status: 'error', latestVersion: null, releaseUrl: null, error: timedOut ? 'Oppdateringssjekken tok for lang tid. Prøv igjen.' : 'Kunne ikke sjekke oppdateringer. Prøv igjen senere.', checkedAt: new Date(completedAt).toISOString() });
    } finally {
      clearTimeoutImpl(timeout);
      controller.signal.removeEventListener('abort', abort);
      if (activeController === controller) activeController = null;
    }
  }

  function check({ force = false } = {}) {
    if (disposed) return Promise.resolve(status());
    if (pending) return pending;
    const age = completedAt === null ? Infinity : now() - completedAt;
    if (!force && age >= 0 && age < CACHE_MS) return Promise.resolve(status());
    pending = Promise.resolve().then(run).finally(() => { pending = null; });
    publish({ status: 'checking', latestVersion: null, releaseUrl: null, error: null });
    return pending;
  }

  function dispose() {
    disposed = true;
    activeController?.abort();
  }
  return { status, check, dispose };
}
