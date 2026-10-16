import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizePerson, contributionTime } from './people.mjs';

class AdminError extends Error {}
const maximumBody = 1024 * 1024;
const eventTypes = new Set(['room.created', 'member.joined', 'member.left', 'profile.updated', 'project.created', 'project.updated', 'file.created', 'file.updated', 'file.deleted']);
const clone = value => structuredClone(value);
const label = (value, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AdminError('Adminserveren returnerte ugyldige metadata.');
  return value;
};
const integer = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000) throw new AdminError('Adminserveren returnerte ugyldige metadata.');
  return value;
};
const array = (value, maximum = 5000) => {
  if (!Array.isArray(value) || value.length > maximum) throw new AdminError('Adminserveren returnerte ugyldige metadata.');
  return value;
};
const date = (value, nullable = false) => value === null && nullable ? null : contributionTime(value);
const brainId = value => label(value);
function overviewDto(value) {
  if (value?.version !== 1) throw new AdminError('Adminserveren bruker et ukjent oversiktsformat.');
  return { version: 1, generatedAt: date(value.generatedAt),
    counts: { brains: integer(value.counts?.brains), users: integer(value.counts?.users), projects: integer(value.counts?.projects), files: integer(value.counts?.files) },
    users: array(value.users).map(user => ({ ...normalizePerson(user), brainIds: array(user.brainIds, 1000).map(brainId), lastSeen: date(user.lastSeen, true) })),
    brains: array(value.brains, 1000).map(brain => {
      if (!['public', 'invited'].includes(brain.visibility)) throw new AdminError('Adminserveren returnerte ugyldig Brain-synlighet.');
      return { id: brainId(brain.id), name: label(brain.name, 120), visibility: brain.visibility,
        projectCount: integer(brain.projectCount), fileCount: integer(brain.fileCount), memberCount: integer(brain.memberCount), lastActiveAt: date(brain.lastActiveAt, true),
        members: array(brain.members).map(member => { const person = normalizePerson(member); return { ...person, userId: person.id, joinedAt: date(member.joinedAt), lastSeen: date(member.lastSeen) }; })
      };
    })
  };
}
function activityDto(value) {
  if (value?.version !== 1) throw new AdminError('Adminserveren bruker et ukjent aktivitetsformat.');
  return { version: 1, events: array(value.events, 200).map(event => {
    if (!eventTypes.has(event.type)) throw new AdminError('Adminserveren returnerte en ukjent aktivitetstype.');
    return { id: label(event.id), at: date(event.at), type: event.type, brainId: brainId(event.brainId), actor: normalizePerson(event.actor),
      ...(event.target === undefined ? {} : { target: { id: label(event.target?.id), title: label(event.target?.title, 200) } })
    };
  }) };
}
function serverUrl(value, allowLoopbackHttp) {
  try {
    const url = new URL(value);
    const localHttp = allowLoopbackHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (typeof value !== 'string' || value.length > 2000 || (!localHttp && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new AdminError();
    return url.origin;
  } catch { throw new AdminError('Bruk serverens HTTPS-hovedadresse uten sti eller innloggingsinformasjon.'); }
}
function adminKey(value) {
  if (typeof value !== 'string' || value.length < 24 || value.length > 1024 || /[\x00-\x20\x7f]/.test(value)) throw new AdminError('Adminnøkkelen må ha minst 24 tegn uten mellomrom.');
  return value;
}

// The key stays in this main-process closure. Every returned DTO is a metadata
// allowlist and every persisted credential goes through the OS encryption hook.
export async function createAdminService({ directory, encrypt, decrypt, fetchImpl = globalThis.fetch, allowLoopbackHttp = false, canRemember = true }) {
  if (typeof directory !== 'string' || !directory || typeof fetchImpl !== 'function') throw new AdminError('Adminoppsettet mangler.');
  const filename = path.join(directory, 'admin-credentials.json');
  let credentials = null, remembered = false, connected = false, overview = null, activity = null, error = '', checkedAt = null;
  let generation = 0, handshake = null, persistence = Promise.resolve();
  let rememberAvailable = Boolean(canRemember && typeof encrypt === 'function' && typeof decrypt === 'function');
  const requests = new Set();
  const status = () => ({ configured: Boolean(credentials), connected, url: credentials?.url || '', remembered, canRemember: rememberAvailable, ...(error ? { error } : {}), ...(checkedAt ? { checkedAt } : {}) });
  const getState = () => ({ status: status(), overview: clone(overview), activity: clone(activity) });
  const current = (ticket, candidate) => { if (ticket !== generation || (candidate && credentials !== candidate)) throw new AdminError('Admintilkoblingen ble endret. Prøv igjen.'); };
  function cancelRequests() { for (const controller of requests) controller.abort(); }
  function persist(callback) { const operation = persistence.then(callback); persistence = operation.catch(() => {}); return operation; }
  async function request(candidate, route, normalize) {
    const controller = new AbortController(); requests.add(controller);
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdminError('Adminserveren svarte ikke innen 10 sekunder.')); }, 10000); });
    const execute = async () => {
      let response;
      try { response = await fetchImpl(candidate.url + route, { method: 'GET', headers: { Authorization: `Bearer ${candidate.key}`, Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal }); }
      catch { throw new AdminError('Kunne ikke kontakte adminserveren over en sikker forbindelse.'); }
      if (!response?.ok || response.status < 200 || response.status >= 300) {
        if (response?.status === 401 || response?.status === 403) throw new AdminError('Adminnøkkelen ble ikke godkjent.');
        if (response?.status === 404) throw new AdminError('Adminoversikten er ikke aktivert på denne serveren.');
        throw new AdminError('Adminserveren kunne ikke hente oversikten.');
      }
      const length = Number(response.headers?.get('content-length'));
      if (Number.isFinite(length) && length > maximumBody) throw new AdminError('Adminsvaret er større enn 1 MB.');
      const reader = response.body?.getReader?.();
      if (!reader) throw new AdminError('Adminserveren returnerte et ugyldig svar.');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let raw = '', size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maximumBody) { void reader.cancel().catch(() => {}); throw new AdminError('Adminsvaret er større enn 1 MB.'); }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
        try { return normalize(JSON.parse(raw)); }
        catch { throw new AdminError('Adminserveren returnerte ugyldige metadata.'); }
      } finally { try { reader.releaseLock(); } catch { /* An aborted reader may already be released. */ } }
    };
    try { return await Promise.race([execute(), timeout]); }
    catch (failure) { throw failure instanceof AdminError ? failure : new AdminError('Adminserveren returnerte et ugyldig svar.'); }
    finally { clearTimeout(timer); controller.abort(); requests.delete(controller); }
  }
  const readBoth = async candidate => {
    const results = await Promise.all([request(candidate, '/api/admin/overview', overviewDto), request(candidate, '/api/admin/activity?limit=50', activityDto)]);
    return { overview: results[0], activity: results[1] };
  };
  function failed(failure, ticket) {
    if (ticket === generation) { connected = false; error = failure.message; checkedAt = new Date().toISOString(); }
    return failure;
  }
  async function ensureConnected() {
    if (!credentials) throw new AdminError('Koble til adminoversikten først.');
    if (connected) return;
    const candidate = credentials, ticket = generation;
    if (handshake?.candidate === candidate && handshake.ticket === ticket) return handshake.promise;
    const promise = (async () => {
      try {
        const data = await readBoth(candidate); current(ticket, candidate);
        overview = data.overview; activity = data.activity; connected = true; error = ''; checkedAt = new Date().toISOString();
      } catch (failure) { throw failed(failure, ticket); }
    })();
    const context = { candidate, ticket, promise }; handshake = context;
    try { await promise; } finally { if (handshake === context) handshake = null; }
  }
  async function connect(input) {
    const candidate = { url: serverUrl(input?.url, allowLoopbackHttp), key: adminKey(input?.key) };
    if (input?.remember !== undefined && typeof input.remember !== 'boolean') throw new AdminError('Velg om admininnloggingen skal huskes.');
    const remember = input?.remember !== false;
    if (remember && !rememberAvailable) throw new AdminError('Denne PC-en kan ikke kryptere admininnloggingen. Velg å bruke den bare til appen lukkes.');
    const ticket = ++generation; cancelRequests();
    try {
      const data = await readBoth(candidate); current(ticket);
      let encrypted;
      if (remember) {
        try {
          encrypted = await encrypt(JSON.stringify(candidate));
          if (!(encrypted instanceof Uint8Array) || !encrypted.byteLength || encrypted.byteLength > 65536) throw new AdminError();
        } catch {
          rememberAvailable = false;
          throw new AdminError('Denne PC-en kunne ikke kryptere admininnloggingen. Velg å bruke den bare til appen lukkes.');
        }
      }
      await persist(async () => {
        current(ticket);
        if (!remember) { await fs.rm(filename, { force: true }); return; }
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `admin-credentials-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 1, encrypted: Buffer.from(encrypted).toString('base64') }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, filename);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      current(ticket);
      credentials = candidate; remembered = remember; connected = true;
      overview = data.overview; activity = data.activity; error = ''; checkedAt = new Date().toISOString();
      return getState();
    } catch (failure) {
      if (ticket !== generation) throw new AdminError('Admintilkoblingen ble endret. Prøv igjen.');
      const safe = failure instanceof AdminError ? failure : new AdminError('Admininnloggingen kunne ikke lagres sikkert.');
      throw failed(safe, ticket);
    }
  }
  async function getOverview() {
    if (!connected) { await ensureConnected(); return clone(overview); }
    const candidate = credentials, ticket = generation;
    try { const value = await request(candidate, '/api/admin/overview', overviewDto); current(ticket, candidate); overview = value; error = ''; checkedAt = new Date().toISOString(); return clone(value); }
    catch (failure) { throw failed(failure, ticket); }
  }
  async function getActivity({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AdminError('Velg mellom 1 og 200 aktiviteter.');
    if (!connected) { await ensureConnected(); if (limit === 50) return clone(activity); }
    const candidate = credentials, ticket = generation;
    try { const value = await request(candidate, `/api/admin/activity?limit=${limit}`, activityDto); current(ticket, candidate); activity = value; error = ''; checkedAt = new Date().toISOString(); return clone(value); }
    catch (failure) { throw failed(failure, ticket); }
  }
  async function disconnect() {
    ++generation; cancelRequests(); handshake = null;
    credentials = null; remembered = false; connected = false; overview = null; activity = null; error = ''; checkedAt = null;
    try { await persist(() => fs.rm(filename, { force: true })); }
    catch { error = 'Den krypterte admininnloggingen kunne ikke fjernes fra denne PC-en.'; throw new AdminError(error); }
    return getState();
  }
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 100000 || !rememberAvailable) throw new AdminError();
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (saved.version !== 1 || typeof saved.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(saved.encrypted)) throw new AdminError();
    const decoded = await decrypt(Buffer.from(saved.encrypted, 'base64'));
    if (typeof decoded !== 'string' || decoded.length > 5000) throw new AdminError();
    const value = JSON.parse(decoded);
    credentials = { url: serverUrl(value.url, allowLoopbackHttp), key: adminKey(value.key) }; remembered = true;
  } catch (failure) {
    if (failure.code !== 'ENOENT') error = 'Den lagrede admininnloggingen kunne ikke åpnes sikkert. Koble til på nytt, eller glem den.';
  }
  return { status, getStatus: status, getState, connect, getOverview, getActivity, disconnect };
}
