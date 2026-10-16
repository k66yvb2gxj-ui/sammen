import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { generate } from 'selfsigned';
import { mutateStore } from './store.mjs';
import { createFileCollaboration } from './collaboration.mjs';
import { createModel } from './collaboration-model.mjs';

const equal = (a, b) => { const aa = Buffer.from(a || ''), bb = Buffer.from(b || ''); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const fingerprint = raw => createHash('sha256').update(raw).digest('hex');
const privateIpv4 = host => isIP(host) === 4 && (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
export function groupUrl(value, { allowLoopbackHttp = false } = {}) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !/^\/(?:rooms\/[a-zA-Z0-9-]+\/?|api\/public-brain\/?|)$/.test(url.pathname)) throw new Error('Bruk en gyldig HTTPS-adresse til gruppens server.');
  return url.origin + url.pathname.replace(/\/$/, '');
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1500000) throw new Error('Forespørselen er for stor.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }

export function transportRequest(origin, route, { method = 'GET', token, data, fingerprint: pin, ca, allowLoopbackHttp = false } = {}) {
  return new Promise((resolve, reject) => {
    const base = groupUrl(origin, { allowLoopbackHttp });
    const publicBrain = new URL(base).pathname === '/api/public-brain';
    const target = new URL(`${base}${publicBrain && route.startsWith('/api/') ? route.slice(4) : route}`);
    if (pin && (!privateIpv4(target.hostname) || target.protocol !== 'https:')) { reject(new Error('Lokale invitasjoner må brukes på et privat nettverk.')); return; }
    const agent = target.protocol === 'https:' ? new https.Agent(ca ? { ca } : {}) : new http.Agent();
    if (pin) agent.createConnection = (options, callback) => {
      const socket = tls.connect({ ...options, rejectUnauthorized: false });
      socket.once('error', callback);
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate();
        if (!certificate.raw || !equal(fingerprint(certificate.raw), pin)) { socket.destroy(); callback(new Error('Vertens sertifikat stemmer ikke med invitasjonen.')); return; }
        callback(null, socket);
      });
    };
    const body = data === undefined ? null : JSON.stringify(data);
    const library = target.protocol === 'https:' ? https : http;
    const req = library.request(target, { method, agent, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 20000000) { req.destroy(new Error('Prosjektet er for stort for nettverkssynkronisering.')); return; } chunks.push(chunk); });
      res.on('end', () => {
        agent.destroy();
        try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.statusCode >= 400) { const error = new Error(result.error || 'Synkronisering mislyktes.'); error.statusCode = res.statusCode; reject(error); } else resolve(result); } catch { reject(new Error('Verten returnerte et ugyldig svar.')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Serveren svarer ikke. Endringer beholdes lokalt og sendes når tilkoblingen er tilbake.')));
    req.once('error', error => { agent.destroy(); reject(error); });
    if (body) req.write(body); req.end();
  });
}
export function pinnedRequest(origin, expectedFingerprint, route, options = {}) { return transportRequest(origin, route, { ...options, fingerprint: expectedFingerprint }); }

export function exportBrain(store) {
  return { format: 'sammen-brain', version: 1, projects: store.list('project').map(project => store.exportProject(project.id)) };
}

export function createRoomHandler({ store, projectId, scope = 'project', secret, publicJoin = false, maxSessions = publicJoin ? 300 : 30, onChange = () => {}, onCollaboration = () => {}, hostPresence = true }) {
  if (!['project', 'brain'].includes(scope) || (publicJoin && scope !== 'brain')) throw new Error('Ugyldig delingsområde.');
  if (scope === 'project') store.project(projectId);
  const scopedProject = scope === 'brain' ? undefined : projectId;
  const snapshot = () => ({ ...store.snapshot(scopedProject), scope });
  const sessionScope = createHash('sha256').update(`${scope}:${scopedProject || ''}:${secret}:${publicJoin}`).digest('hex');
  const savedSessions = store.getMeta('room:sessions');
  const sessions = new Map((savedSessions?.scope === sessionScope ? savedSessions.sessions : []).filter(([, s]) => Date.now() - s.lastSeen < 8 * 3600000));
  const collaboration = createFileCollaboration({ store, projectId: scopedProject });
  let hostFile = null, hostSeen = 0;
  const persistSessions = () => store.setMeta('room:sessions', { scope: sessionScope, sessions: [...sessions] });
  const actor = () => ({ id: `host:${store.getMeta('user').id}`, userId: store.getMeta('user').id, name: store.getMeta('user').name, editingItemId: Date.now() - hostSeen < 15000 ? hostFile : null, lastSeen: Date.now() });
  const members = () => [...(hostPresence ? [actor()] : []), ...[...sessions.values()].filter(s => Date.now() - s.lastSeen < 15000).map(s => ({ id: s.id, userId: s.userId || s.id, name: s.name, editingItemId: s.editingItemId || null, lastSeen: s.lastSeen }))];
  const status = () => ({ members: members(), memberCount: members().length });
  function presence(id, session) { if (session) { session.editingItemId = id; session.lastSeen = Date.now(); } else { hostFile = id; hostSeen = Date.now(); } }
  function openFile(input, session) { presence(input.id, session); return { ...collaboration.response(input.id, input.stateVector), members: members().filter(m => m.editingItemId === input.id), active: true }; }
  function updateFile(input, session) {
    const result = collaboration.update(input, session?.name || store.getMeta('user').name);
    presence(input.id, session); onChange(snapshot());
    const response = { ...result, members: members().filter(m => m.editingItemId === input.id), active: true };
    onCollaboration(response); return response;
  }
  function closeFile({ id }, session) { if (session?.editingItemId === id) session.editingItemId = null; else if (!session && hostFile === id) hostFile = null; return { ok: true }; }
  function mutate(operation, input, author = store.getMeta('user').name) {
    const targetProject = operation === 'appendMessage' ? store.get('chat', input.chatId)?.projectId : input.projectId;
    const citations = operation === 'appendMessage' ? input.message?.citations : operation === 'saveItem' ? input.citations : [];
    if (Array.isArray(citations)) for (const citation of citations) {
      if (citation?.sourceId && store.get('item', citation.sourceId)?.projectId !== targetProject) throw new Error('Kilden må finnes i det delte prosjektet.');
    }
    const result = mutateStore(store, operation, input, { projectId: scopedProject, author });
    if (operation === 'saveItem') collaboration.reconcile(result);
    onChange(snapshot()); return result;
  }
  function join(body) {
    for (const [token, session] of sessions) if (Date.now() - session.lastSeen > 8 * 3600000) sessions.delete(token);
    if (sessions.size >= maxSessions) throw new Error('Gruppen har nådd grensen for tilkoblinger.');
    if (!publicJoin && !equal(body.secret, secret)) throw new Error('Invitasjonskoden stemmer ikke.');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new Error('Skriv et gyldig navn.');
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { id: randomUUID(), userId: typeof body.userId === 'string' && body.userId.length <= 100 ? body.userId : randomUUID(), name: body.name.trim(), lastSeen: Date.now(), editingItemId: null }); persistSessions();
    return { token, state: snapshot(), scope, ...status() };
  }
  async function handle(req, res) {
    try {
      if (req.headers.origin) { json(res, 403, { error: 'Nettleserforespørsler er ikke støttet.' }); return; }
      if (req.method === 'POST' && req.url === '/api/join') { const result = join(await readBody(req)); json(res, 200, result); onChange(snapshot()); return; }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, ''), session = sessions.get(token);
      if (!session || Date.now() - session.lastSeen > 8 * 3600000) { sessions.delete(token); json(res, 401, { error: 'Tilkoblingen er utløpt. Bli med i gruppen igjen.' }); return; }
      session.lastSeen = Date.now();
      if (req.method === 'GET' && req.url === '/api/state') { json(res, 200, { ...snapshot(), ...status() }); return; }
      if (req.method === 'POST' && req.url === '/api/leave') { sessions.delete(token); persistSessions(); json(res, 200, { ok: true }); onChange(snapshot()); return; }
      if (req.method === 'POST' && req.url === '/api/mutate') { const body = await readBody(req); const result = mutate(body.operation, body.input, session.name); json(res, 200, { result, state: snapshot(), ...status() }); return; }
      if (req.method === 'POST' && ['/api/files/open', '/api/files/update', '/api/files/close'].includes(req.url)) {
        const body = await readBody(req);
        const result = req.url.endsWith('/open') ? openFile(body, session) : req.url.endsWith('/update') ? updateFile(body, session) : closeFile(body, session);
        persistSessions(); json(res, 200, result); return;
      }
      json(res, 404, { error: 'Denne forespørselen støttes ikke.' });
    } catch (error) { if (!res.headersSent) json(res, /Invitasjonskoden/.test(error.message) ? 403 : 400, { error: error.message }); else res.destroy(); }
  }
  return { handle, status, mutate, openFile, updateFile, closeFile, join, close: () => { persistSessions(); collaboration.close(); } };
}

export function createSyncService({ store, onChange = () => {}, onCollaboration = () => {}, ca, allowLoopbackHttp = false, listenHost = '0.0.0.0' }) {
  if (!['0.0.0.0', '127.0.0.1'].includes(listenHost)) throw new Error('Ugyldig lytteadresse.');
  let server = null, host = null, room = null, client = null, poll = null, remote = null, polling = false, problem = '';
  const localFiles = createFileCollaboration({ store });
  const activeFiles = new Map();
  const status = () => client ? { mode: 'client', scope: client.scope || 'project', public: Boolean(client.public), isPublic: Boolean(client.public), projectId: client.scope === 'brain' ? undefined : remote?.projects[0]?.id, url: client.origin, inviteCode: client.inviteCode, transport: client.fingerprint ? 'local' : 'internet', connected: !problem, error: problem, members: remote?.members || [], memberCount: remote?.memberCount || 1 } : host ? { mode: 'host', scope: host.scope, isPublic: false, projectId: host.projectId, urls: host.urls, inviteCode: host.inviteCode, transport: 'local', ...room.status() } : { mode: 'local', isPublic: false, members: [], memberCount: 1 };
  const state = () => { const result = client && remote ? remote : store.snapshot(); return { ...result, items: result.items.map(item => ({ ...item, originalAvailable: Boolean(store.getMeta(`original:${item.id}`)) })), flashcards: result.flashcards.map(card => store.personalCard(card)), user: store.getMeta('user'), sync: status() }; };
  // Session credentials stay in this Brain's own database, never in an exported Brain.
  const rememberConnection = () => { if (client && remote) store.setMeta('sync:client', { version: 1, connection: client, state: remote }); };
  const notify = () => onChange(state());
  const request = (connection, route, options) => transportRequest(connection.origin, route, { ...options, token: connection.token, fingerprint: connection.fingerprint, ca, allowLoopbackHttp });
  function clientKey(id, connection = client) { return `collaboration-client:${createHash('sha256').update(connection.origin).digest('hex')}:${id}`; }
  function remember(id, value) { if (client) store.setMeta(clientKey(id), { update: value.model.encode(), item: value.item, vector: value.acknowledged, pending: value.pending }); }
  async function sendFile(id, value) {
    if (!client) return;
    const connection = client;
    const submittedVector = value.model.vector();
    const sequence = value.sequence;
    const data = await request(connection, '/api/files/update', { method: 'POST', data: { id, update: value.model.encode(value.acknowledged), stateVector: submittedVector, editing: true } });
    if (connection !== client) throw new Error('Gruppen ble byttet mens endringen ble lagret.');
    // Keystrokes added while the request is in flight remain beyond this vector.
    value.acknowledged = data.stateVector || submittedVector;
    value.pending = value.sequence !== sequence;
    value.model.apply(data.update); if (data.item.revision >= value.item.revision) value.item = data.item; remember(id, value);
    const merged = value.model.read(value.item);
    if (remote) remote.items = remote.items.map(item => item.id === id ? merged : item);
    rememberConnection();
    const result = { ...data, item: merged, pending: value.pending }; onCollaboration(result); return result;
  }
  async function pollFile(id, value) {
    if (value.pending) return sendFile(id, value);
    const connection = client;
    const data = await request(connection, '/api/files/open', { method: 'POST', data: { id, stateVector: value.model.vector() } });
    if (connection !== client) return;
    const changed = value.model.apply(data.update);
    if (data.item.revision >= value.item.revision) value.item = data.item;
    value.acknowledged = data.stateVector || value.acknowledged;
    if (changed) remember(id, value);
    const merged = value.model.read(value.item);
    if (remote) remote.items = remote.items.map(item => item.id === id ? merged : item);
    rememberConnection();
    const result = { ...data, item: merged, pending: value.pending }; onCollaboration(result); return result;
  }
  let pendingRefresh = null;
  const refresh = () => pendingRefresh || (pendingRefresh = performRefresh().finally(() => { pendingRefresh = null; }));
  const performRefresh = async () => {
    if (polling) return; polling = true;
    const connection = client;
    try {
      if (connection) {
        const updated = await request(connection, '/api/state');
        if (client !== connection) return;
        remote = updated;
        for (const [id, value] of activeFiles) await pollFile(id, value);
        problem = ''; rememberConnection(); notify();
      } else if (host) {
        for (const id of activeFiles.keys()) onCollaboration(room.openFile({ id }));
      }
    } catch (error) { if (client === connection) { problem = error.message; notify(); } }
    finally { polling = false; }
  };
  function startPoll() { if (!poll) { poll = setInterval(refresh, 1000); poll.unref(); } }
  function clearFiles() { for (const value of activeFiles.values()) value.model?.destroy(); activeFiles.clear(); }
  async function attachClient(connection, joined) { client = { ...connection, scope: joined.scope || joined.state?.scope || 'project' }; remote = joined.state; remote.members = joined.members || []; remote.memberCount = joined.memberCount || 1; problem = ''; rememberConnection(); startPoll(); notify(); return status(); }
  const service = {
    status, state, refresh,
    async startHosting({ projectId, scope = 'project' }) {
      if (client) throw new Error('Forlat gruppen før du blir vert.');
      if (host) return status();
      if (!['project', 'brain'].includes(scope)) throw new Error('Ugyldig delingsområde.');
      if (scope === 'project') store.project(projectId); else projectId = undefined;
      const cert = await generate([{ name: 'commonName', value: 'Sammen lokalt samarbeid' }], { keySize: 2048, days: 7, algorithm: 'sha256' });
      const raw = Buffer.from(cert.cert.replace(/-----[^-]+-----|\s/g, ''), 'base64');
      const secret = randomBytes(32).toString('base64url'), fp = fingerprint(raw);
      const inviteCode = `S1.${Buffer.from(JSON.stringify({ version: 1, secret, fingerprint: fp })).toString('base64url')}`;
      room = createRoomHandler({ store, projectId, scope, secret, onChange: notify, onCollaboration });
      server = https.createServer({ key: cert.private, cert: cert.cert, requestTimeout: 12000, headersTimeout: 10000 }, room.handle);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, listenHost, resolve); });
      const port = server.address().port;
      const addresses = Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal && privateIpv4(a.address)).map(a => a.address);
      host = { projectId, scope, urls: listenHost === '127.0.0.1' ? [`https://127.0.0.1:${port}`] : [...new Set(addresses)].map(a => `https://${a}:${port}`), inviteCode };
      if (!host.urls.length) host.urls.push(`https://127.0.0.1:${port}`); startPoll(); notify(); return status();
    },
    async stopHosting() {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      server = null; host = null; room?.close(); room = null; clearFiles();
      if (!client && poll) { clearInterval(poll); poll = null; } notify(); return status();
    },
    async startInternetRoom({ url, projectId, createKey, scope = 'project' }) {
      if (host || client) throw new Error('Forlat den aktive gruppen før du oppretter en ny.');
      const origin = groupUrl(url, { allowLoopbackHttp });
      if (new URL(origin).pathname !== '/') throw new Error('Bruk serverens hovedadresse.');
      if (typeof createKey !== 'string' || createKey.length < 24 || createKey.length > 500) throw new Error('Oppgi serverens opprettingsnøkkel med minst 24 tegn.');
      if (!['project', 'brain'].includes(scope)) throw new Error('Ugyldig delingsområde.');
      const payload = scope === 'brain' ? { scope, brain: exportBrain(store) } : { project: store.exportProject(projectId) };
      const created = await transportRequest(origin, '/api/rooms', { method: 'POST', token: createKey, data: { ...payload, user: store.getMeta('user') }, ca, allowLoopbackHttp });
      const roomUrl = groupUrl(created.roomUrl || created.url, { allowLoopbackHttp });
      if (new URL(roomUrl).origin !== new URL(origin).origin) throw new Error('Serveren returnerte en annen adresse.');
      return attachClient({ origin: roomUrl, token: created.token, inviteCode: created.inviteCode }, created);
    },
    async joinPublicBrain({ url }) {
      if (host || client) throw new Error('Forlat den aktive gruppen først.');
      const origin = groupUrl(url, { allowLoopbackHttp });
      if (new URL(origin).pathname !== '/') throw new Error('Bruk serverens hovedadresse.');
      const connection = { origin: `${origin}/api/public-brain`, public: true, scope: 'brain' };
      const joined = await request(connection, '/api/join', { method: 'POST', data: { name: store.getMeta('user').name, userId: store.getMeta('user').id } });
      connection.token = joined.token;
      return attachClient(connection, joined);
    },
    async joinGroup({ url, inviteCode }) {
      if (host) throw new Error('Stopp vertskapet før du blir med i en annen gruppe.');
      if (client) throw new Error('Forlat den aktive gruppen først.');
      const origin = groupUrl(url, { allowLoopbackHttp }); let code;
      try { if (!/^S[12]\./.test(inviteCode) || inviteCode.length > 2000) throw new Error(); code = JSON.parse(Buffer.from(inviteCode.slice(3), 'base64url').toString('utf8')); } catch { throw new Error('Ugyldig invitasjonskode.'); }
      if (!/^[\w-]{43}$/.test(code.secret) || ![1, 2].includes(code.version) || (code.version === 1 && (!/^[a-f0-9]{64}$/.test(code.fingerprint) || !inviteCode.startsWith('S1.'))) || (code.version === 2 && !inviteCode.startsWith('S2.'))) throw new Error('Ugyldig invitasjonskode.');
      if (code.version === 2 && (!code.url || groupUrl(code.url, { allowLoopbackHttp }) !== origin)) throw new Error('Adressen stemmer ikke med internettinvitasjonen.');
      const connection = { origin, fingerprint: code.version === 1 ? code.fingerprint : undefined, inviteCode };
      const joined = await request(connection, '/api/join', { method: 'POST', data: { secret: code.secret, name: store.getMeta('user').name, userId: store.getMeta('user').id } });
      connection.token = joined.token; return attachClient(connection, joined);
    },
    async leaveGroup({ preserveClient = false } = {}) {
      if (poll) clearInterval(poll); poll = null;
      if (client) {
        for (const id of [...activeFiles.keys()]) await service.closeSharedFile({ id });
        if (preserveClient) rememberConnection();
        else { try { await request(client, '/api/leave', { method: 'POST', data: {} }); } catch { /* Disconnection succeeds when the host is offline. */ } store.setMeta('sync:client', null); }
      }
      client = null; remote = null; problem = ''; clearFiles(); notify(); return status();
    },
    async pause() {
      if (poll) clearInterval(poll); poll = null;
      if (pendingRefresh) await pendingRefresh;
      for (const id of [...activeFiles.keys()]) await service.closeSharedFile({ id });
      rememberConnection();
    },
    resume() { if (client || host) startPoll(); return status(); },
    async shutdown() {
      await service.pause();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      server = null; host = null; room?.close(); room = null;
      clearFiles(); localFiles.close();
    },
    async openSharedFile({ id, stateVector }) {
      if (client) {
        const opened = await request(client, '/api/files/open', { method: 'POST', data: { id } });
        const cached = store.getMeta(clientKey(id));
        const value = { item: opened.item, model: createModel({ item: opened.item, update: cached?.update || opened.update }), acknowledged: opened.stateVector || cached?.vector || null, pending: cached ? (cached.pending ?? true) : false, sequence: 0 };
        value.model.apply(opened.update); activeFiles.get(id)?.model?.destroy(); activeFiles.set(id, value); remember(id, value);
        return { ...opened, item: value.model.read(opened.item), update: value.model.encode(), pending: value.pending };
      }
      activeFiles.set(id, {});
      return host && (host.scope === 'brain' || store.get('item', id)?.projectId === host.projectId) ? room.openFile({ id, stateVector }) : { ...localFiles.response(id, stateVector), members: [], active: false };
    },
    async updateSharedFile(input) {
      if (client) {
        let value = activeFiles.get(input.id);
        if (!value) { await service.openSharedFile({ id: input.id }); value = activeFiles.get(input.id); }
        if (value.model.apply(input.update)) { value.pending = true; value.sequence++; }
        remember(input.id, value);
        try { const result = await sendFile(input.id, value); problem = ''; notify(); return result; }
        catch (error) { if (error.statusCode === 400 || error.statusCode === 403) throw error; problem = error.message; notify(); return { id: input.id, item: value.model.read(value.item), update: value.model.encode(input.stateVector), members: [], active: true, pending: true, error: problem }; }
      }
      const result = host && (host.scope === 'brain' || store.get('item', input.id)?.projectId === host.projectId) ? room.updateFile(input) : { ...localFiles.update(input, store.getMeta('user').name), members: [], active: false };
      notify(); return result;
    },
    async closeSharedFile({ id }) {
      const value = activeFiles.get(id);
      if (client && value) { remember(id, value); try { if (value.pending) await sendFile(id, value); await request(client, '/api/files/close', { method: 'POST', data: { id } }); } catch { /* The durable outbox remains until the file is opened again. */ } }
      else if (host) room.closeFile({ id });
      value?.model?.destroy(); activeFiles.delete(id); return { ok: true };
    },
    async mutate(operation, input) {
      if (client) {
        const connection = client;
        const response = await request(connection, '/api/mutate', { method: 'POST', data: { operation, input } });
        if (client !== connection) throw new Error('Gruppen ble byttet mens endringen ble lagret.');
        remote = { ...response.state, members: response.members, memberCount: response.memberCount }; problem = ''; rememberConnection(); notify(); return response.result;
      }
      const result = host && (host.scope === 'brain' || input.projectId === host.projectId || input.id && store.get('item', input.id)?.projectId === host.projectId) ? room.mutate(operation, input) : mutateStore(store, operation, input, { author: store.getMeta('user').name });
      if (operation === 'saveItem') localFiles.reconcile(result); notify(); return result;
    }
  };
  const savedClient = store.getMeta('sync:client');
  if (savedClient?.version === 1 && typeof savedClient.connection?.token === 'string' && savedClient.connection.token.length >= 32 && Array.isArray(savedClient.state?.projects) && Array.isArray(savedClient.state?.items) && Array.isArray(savedClient.state?.flashcards) && Array.isArray(savedClient.state?.chats)) {
    try {
      groupUrl(savedClient.connection.origin, { allowLoopbackHttp });
      client = savedClient.connection; remote = savedClient.state;
      problem = 'Kobler til igjen …'; startPoll();
    } catch { /* Invalid or unsupported saved endpoints are never contacted. */ }
  }
  return service;
}
