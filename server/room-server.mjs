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
export async function createInternetServer({ directory, publicOrigin, createKey, maxRooms = 100, allowLoopbackHttp = false } = {}) {
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
    const store = new Store(filename(id));
    const meta = store.getMeta('internet:room');
    if (!meta || meta.id !== id) { store.close(); throw new Error('Fellesrommet finnes ikke.'); }
    const handler = createRoomHandler({ store, projectId: meta.projectId, secret: meta.secret, hostPresence: false });
    const room = { store, handler, meta }; rooms.set(id, room); return room;
  }
  const persisted = (await readdir(root)).filter(name => uuid.test(name.replace(/\.sqlite$/, '')) && name.endsWith('.sqlite'));
  const roomIds = new Set(persisted.map(name => name.slice(0, -7)));
  async function createRoom(request, response) {
    if (!equal(String(request.headers.authorization || '').replace(/^Bearer /, ''), createKey)) { json(response, 403, { error: 'Opprettelsesnøkkelen stemmer ikke.' }); return; }
    const ip = request.socket.remoteAddress || 'unknown', now = Date.now();
    const recent = (attempts.get(ip) || []).filter(time => time > now - 3600000);
    if (recent.length >= 12 || roomIds.size >= maxRooms) { json(response, 429, { error: 'Serveren har nådd grensen for nye fellesrom.' }); return; }
    recent.push(now); attempts.set(ip, recent);
    const input = await body(request);
    if (typeof input.user?.name !== 'string' || !input.user.name.trim() || input.user.name.length > 80 || typeof input.user?.id !== 'string' || input.user.id.length > 100) throw new Error('Ugyldig deltaker.');
    const id = randomUUID(), path = filename(id), store = new Store(path);
    let handler;
    try {
      const imported = store.importProject(input.project);
      store.saveProject({ ...imported, title: input.project.project.title });
      store.saveProfile({ name: input.user.name.trim() });
      const secret = randomBytes(32).toString('base64url');
      const meta = { id, projectId: imported.id, secret, createdAt: new Date().toISOString() };
      store.setMeta('internet:room', meta);
      handler = createRoomHandler({ store, projectId: imported.id, secret, hostPresence: false });
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
      rooms.clear();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createInternetServer({ directory: process.env.SAMMEN_DATA_DIR || './server-data', publicOrigin: process.env.SAMMEN_PUBLIC_ORIGIN, createKey: process.env.SAMMEN_CREATE_KEY, maxRooms: Number(process.env.SAMMEN_MAX_ROOMS) || 100 });
  await service.listen({ host: process.env.SAMMEN_BIND || '127.0.0.1', port: Number(process.env.PORT) || 8787 });
  console.log('Sammen fellesromserver er klar.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.close(); process.exit(0); });
}
