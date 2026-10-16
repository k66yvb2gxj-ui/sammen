import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { createRoomHandler } from '../src/sync.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(String(value || '')).digest();
const equal = (left, right) => timingSafeEqual(digest(left), digest(right));
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}
async function body(request, maxBytes = 8_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw new Error('Prosjektet er for stort for denne serveren.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function origin(value, allowLoopbackHttp) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Serveren trenger en offentlig HTTPS-adresse.');
  return url.origin;
}

// Place this HTTP service behind a TLS reverse proxy. Desktop requests verify TLS.
export async function createInternetServer({ directory, publicOrigin, createKey, maxRooms = 100, publicBrain = false, allowLoopbackHttp = false } = {}) {
  if (typeof createKey !== 'string' || createKey.length < 24) throw new Error('Sett en privat opprettelsesnøkkel med minst 24 tegn.');
  const address = origin(publicOrigin, allowLoopbackHttp);
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const rooms = new Map(), attempts = new Map();
  function filename(id) {
    if (!uuid.test(id)) throw new Error('Ugyldig rom-ID.');
    const path = join(root, `${id}.sqlite`);
    if (dirname(path) !== root) throw new Error('Ugyldig romsti.');
    return path;
  }
  function loadRoom(id) {
    if (rooms.has(id)) return rooms.get(id);
    const store = new Store(filename(id), { seedDefaultProject: false });
    const meta = store.getMeta('internet:room');
    if (!meta || meta.id !== id) { store.close(); throw new Error('Fellesrommet finnes ikke.'); }
    const handler = createRoomHandler({ store, projectId: meta.projectId, scope: meta.scope || 'project', secret: meta.secret, hostPresence: false });
    const room = { store, handler, meta }; rooms.set(id, room); return room;
  }
  const persisted = (await readdir(root)).filter(name => uuid.test(name.replace(/\.sqlite$/, '')) && name.endsWith('.sqlite'));
  const roomIds = new Set(persisted.map(name => name.slice(0, -7)));
  let publicRoom;
  function getPublicRoom() {
    if (!publicBrain) throw new Error('Offentlig Brain er ikke slått på på denne serveren.');
    if (publicRoom) return publicRoom;
    const store = new Store(join(root, 'public-brain.sqlite'), { seedDefaultProject: false });
    let meta = store.getMeta('internet:public-brain');
    if (!meta) {
      meta = { scope: 'brain', secret: randomBytes(32).toString('base64url') };
      store.setMeta('internet:public-brain', meta);
    }
    const handler = createRoomHandler({ store, scope: 'brain', secret: meta.secret, publicJoin: true, hostPresence: false });
    publicRoom = { store, handler }; return publicRoom;
  }
  function validateProject(data) {
    if (data?.format !== 'sammen-project' || data.version !== 1 || typeof data.project?.id !== 'string' || !Array.isArray(data.items) || !Array.isArray(data.flashcards) || !Array.isArray(data.chats)) throw new Error('Ugyldig prosjekt i Brain.');
    const ids = new Set(data.items.map(item => item?.id));
    if (ids.size !== data.items.length || [...ids].some(id => typeof id !== 'string' || !id || id.length > 100)) throw new Error('Ugyldige fil-ID-er i Brain.');
    const checkCitations = citations => {
      if (citations !== undefined && !Array.isArray(citations)) throw new Error('Ugyldig kildeliste i Brain.');
      for (const citation of citations || []) if (citation?.sourceId && !ids.has(citation.sourceId)) throw new Error('Kilden må finnes i det delte prosjektet.');
    };
    for (const item of data.items) { if (item.projectId !== data.project.id) throw new Error('Filen tilhører et annet prosjekt.'); checkCitations(item.citations); }
    for (const card of data.flashcards) {
      if (card.projectId !== data.project.id || !Array.isArray(card.sourceIds) || card.sourceIds.some(id => !ids.has(id))) throw new Error('Kortets kilde må finnes i det delte prosjektet.');
    }
    for (const chat of data.chats) {
      if (chat.projectId !== data.project.id || !Array.isArray(chat.messages)) throw new Error('Samtalen tilhører et annet prosjekt.');
      for (const message of chat.messages) checkCitations(message.citations);
    }
  }
  function importScope(store, input) {
    if (input.scope !== undefined && !['project', 'brain'].includes(input.scope)) throw new Error('Ugyldig delingsområde.');
    if (input.scope === 'brain') {
      const brain = input.brain;
      if (brain?.format !== 'sammen-brain' || brain.version !== 1 || !Array.isArray(brain.projects) || brain.projects.length > 100 || new Set(brain.projects.map(data => data?.project?.id)).size !== brain.projects.length) throw new Error('Ugyldig Sammen-Brain.');
      for (const data of brain.projects) validateProject(data);
      for (const data of brain.projects) { const imported = store.importProject(data); store.saveProject({ ...imported, title: data.project.title }); }
      return { scope: 'brain' };
    }
    validateProject(input.project);
    const imported = store.importProject(input.project);
    store.saveProject({ ...imported, title: input.project.project.title });
    return { scope: 'project', projectId: imported.id };
  }
  async function createRoom(request, response) {
    if (!equal(String(request.headers.authorization || '').replace(/^Bearer /, ''), createKey)) { json(response, 403, { error: 'Opprettelsesnøkkelen stemmer ikke.' }); return; }
    const ip = request.socket.remoteAddress || 'unknown', now = Date.now();
    const recent = (attempts.get(ip) || []).filter(time => time > now - 3600000);
    if (recent.length >= 12 || roomIds.size >= maxRooms) { json(response, 429, { error: 'Serveren har nådd grensen for nye fellesrom.' }); return; }
    recent.push(now); attempts.set(ip, recent);
    const input = await body(request);
    if (typeof input.user?.name !== 'string' || !input.user.name.trim() || input.user.name.length > 80 || typeof input.user?.id !== 'string' || input.user.id.length > 100) throw new Error('Ugyldig deltaker.');
    const id = randomUUID(), path = filename(id), store = new Store(path, { seedDefaultProject: false });
    let handler;
    try {
      const shared = importScope(store, input);
      store.saveProfile({ name: input.user.name.trim() });
      const secret = randomBytes(32).toString('base64url');
      const meta = { id, ...shared, secret, createdAt: new Date().toISOString() };
      store.setMeta('internet:room', meta);
      handler = createRoomHandler({ store, projectId: shared.projectId, scope: shared.scope, secret, hostPresence: false });
      const joined = handler.join({ secret, name: input.user.name, userId: input.user.id });
      rooms.set(id, { store, handler, meta }); roomIds.add(id);
      const roomUrl = `${address}/rooms/${id}`;
      const inviteCode = `S2.${Buffer.from(JSON.stringify({ version: 2, secret, url: roomUrl })).toString('base64url')}`;
      json(response, 201, { ...joined, roomUrl, url: roomUrl, inviteCode });
    } catch (error) {
      handler?.close(); store.close();
      for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
      throw error;
    }
  }
  const server = createServer({ requestTimeout: 20000, headersTimeout: 15000 }, async (request, response) => {
    try {
      if (request.headers.origin) { json(response, 403, { error: 'Bruk Sammen-appen for å koble til.' }); return; }
      const url = new URL(request.url, address);
      if (request.method === 'GET' && url.pathname === '/health' && !url.search) { json(response, 200, { ok: true, service: 'sammen-rooms' }); return; }
      if (request.method === 'POST' && url.pathname === '/api/rooms' && !url.search) { await createRoom(request, response); return; }
      const publicRoute = /^\/api\/public-brain\/(join|leave|state|mutate|files\/(?:open|update|close))$/.exec(url.pathname);
      if (publicBrain && publicRoute && !url.search) {
        request.url = `/api/${publicRoute[1]}`;
        await getPublicRoom().handler.handle(request, response); return;
      }
      const route = /^\/rooms\/([a-f0-9-]{36})(\/api\/(?:join|leave|state|mutate|files\/(?:open|update|close)))$/.exec(url.pathname);
      if (!route || !roomIds.has(route[1]) || url.search) { json(response, 404, { error: 'Fellesrommet finnes ikke.' }); return; }
      request.url = route[2];
      await loadRoom(route[1]).handler.handle(request, response);
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.destroy(); }
  });
  return {
    server,
    async listen({ port = 8787, host = '127.0.0.1' } = {}) { await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); }); return server.address(); },
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise(done => server.close(done));
      for (const { handler, store } of rooms.values()) { handler.close(); store.close(); }
      if (publicRoom) { publicRoom.handler.close(); publicRoom.store.close(); publicRoom = null; }
      rooms.clear();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createInternetServer({ directory: process.env.SAMMEN_DATA_DIR || './server-data', publicOrigin: process.env.SAMMEN_PUBLIC_ORIGIN, createKey: process.env.SAMMEN_CREATE_KEY, maxRooms: Number(process.env.SAMMEN_MAX_ROOMS) || 100, publicBrain: process.env.SAMMEN_PUBLIC_BRAIN === '1' });
  await service.listen({ host: process.env.SAMMEN_BIND || '127.0.0.1', port: Number(process.env.PORT) || 8787 });
  console.log('Sammen fellesromserver er klar.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.close(); process.exit(0); });
}
