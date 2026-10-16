import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import tls from 'node:tls';
import { Store } from '../src/store.mjs';
import { createBrainSpaces } from '../src/brain-spaces.mjs';
import { createBrainCommands } from '../src/brain-commands.mjs';
import { createUpdateService } from '../src/updates.mjs';

if (tls.setDefaultCACertificates && tls.getCACertificates) tls.setDefaultCACertificates([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')]);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const updates = createUpdateService({ currentVersion: JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version });
const updateStatus = value => ({ ...value, automatic: false, reason: 'Automatisk installasjon er tilgjengelig i den installerte Windows-appen.' });
const profile = process.env.SAMMEN_PREVIEW_PROFILE || join(dirname(project), 'sandbox-preview-profile');
await mkdir(profile, { recursive: true });
const baseStore = new Store(join(profile, 'brain.sqlite'));
let store = baseStore;
if (!store.getMeta('sandboxSeeded')) {
  store.saveProfile({ name: 'DEMO · Din profil' });
  const projectId = store.snapshot().projects[0].id;
  store.saveProject({ id: projectId, title: 'DEMO · Felles læringsrom', description: 'Testrom for å finpusse Sammen.', color: '#647a64' });
  const note = store.saveItem({ projectId, type: 'note', title: 'DEMO · Arbeidsnotat', origin: 'human', status: 'draft', content: 'Dette er demonstrasjonsdata i sandboxen. Du kan endre og lagre teksten.\n\nSpørsmål til arbeidsrommet\n• Hvordan skal vi organisere fag og prosjekter?\n• Hva trenger vi fra kildene våre?\n• Hvordan vil vi repetere det vi lærer?' });
  store.saveItem({ projectId, type: 'mindmap', title: 'DEMO · Tankekart', origin: 'human', content: '', mindmap: { nodes: [{ id: 'root', text: 'Felles læring', parentId: null }, { id: 'research', text: 'Research', parentId: 'root' }, { id: 'notes', text: 'Notater', parentId: 'root' }, { id: 'practice', text: 'Repetisjon', parentId: 'root' }, { id: 'sources', text: 'Kilder', parentId: 'research' }] } });
  const source = store.saveItem({ projectId, type: 'source', title: 'DEMO · Eksempel på kilde', origin: 'human', content: 'Dette er et manuelt eksempel for å vise plassering av kilder og henvisninger i grensesnittet.', sourceName: 'DEMO · Presentasjonsdata', sourceUrl: '' });
  store.saveCard({ projectId, question: 'DEMO: Hva gjør et flashcard nyttig?', answer: 'Et tydelig spørsmål og et kort svar som du kan hente frem fra hukommelsen.', sourceIds: [note.id] });
  const chat = store.createChat({ projectId });
  store.appendMessage({ chatId: chat.id, message: { role: 'user', content: 'DEMO: Hvordan kan en samtale med kilder se ut?' } });
  store.appendMessage({ chatId: chat.id, message: { role: 'assistant', content: 'DEMO · Manuelt eksempel: Her vises et svar med en henvisning til materiale fra Brain [K1]. Denne teksten er skrevet for forhåndsvisningen og er ikke generert av KI.', provider: 'demo', model: 'Manuelt eksempel', citations: [{ id: 'K1', sourceId: source.id, title: source.title, url: '', excerpt: source.content }] } });
  store.setMeta('sandboxSeeded', true);
}
if (!store.getMeta('sandboxStudySeeded')) {
  const projectId = store.snapshot().projects[0].id;
  for (const [question, answer] of [
    ['DEMO · Hva kalles oversikten med ideer og grener?', 'Tankekart'],
    ['DEMO · Hva kalles et kort med spørsmål og svar?', 'Flashcard'],
    ['DEMO · Hva viser hvor en opplysning kommer fra?', 'Kildehenvisning'],
    ['DEMO · Hva kalles det å hente et svar fra hukommelsen?', 'Gjenhenting']
  ]) store.saveCard({ projectId, question, answer, origin: 'human', sourceIds: [] });
  store.setMeta('sandboxStudySeeded', true);
}
if (!store.getMeta('sandboxProjectsSeeded')) {
  const biology = store.saveProject({ title: 'DEMO · Biologi', description: '', color: '#829ab5' });
  store.saveItem({ projectId: biology.id, type: 'note', title: 'DEMO · Cellen', content: 'DEMO · Et arbeidsnotat om celler.\n\nSamle begreper, egne forklaringer og kilder her.', citations: [{ id: 'biology-demo-source', title: 'OpenStax · Biology 2e', url: 'https://openstax.org/details/books/biology-2e', sourceId: '', excerpt: 'Eksempel på en kildehenvisning i filen. Ingen tekst er hentet automatisk.' }] });
  store.saveItem({ projectId: biology.id, type: 'note', title: 'DEMO · Spørsmål', content: 'DEMO · Hva skal vi undersøke?\n\n• Hva gjør de ulike delene i en celle?\n• Hvordan kan vi forklare dem med egne ord?' });
  store.saveItem({ projectId: biology.id, type: 'mindmap', title: 'DEMO · Begreper', content: '', mindmap: { nodes: [{ id: 'root', parentId: null, text: 'Celler' }, { id: 'function', parentId: 'root', text: 'Funksjon' }, { id: 'parts', parentId: 'root', text: 'Deler' }] } });
  store.setMeta('sandboxProjectsSeeded', true);
}
if (process.env.SAMMEN_PREVIEW_NAME) store.saveProfile({ name: process.env.SAMMEN_PREVIEW_NAME });
const fileEvents = [];
const spaces = createBrainSpaces({ baseStore, directory: profile, syncOptions: { listenHost: '127.0.0.1' }, onCollaboration: payload => { fileEvents.push(payload); if (fileEvents.length > 300) fileEvents.shift(); } });
store = spaces.store;
const sync = spaces.sync;
const brainCommands = createBrainCommands({ spaces, publicUrl: () => process.env.SAMMEN_PUBLIC_BRAIN_URL || '' });
const snapshot = () => {
  const state = brainCommands.state();
  return { ...state, items: state.items.map(item => ({ ...item, originalAvailable: false })) };
};
let settings = baseStore.getMeta('sandboxAiSettings') || { provider: 'chatgpt', model: 'gpt-6-luna', baseUrl: 'http://127.0.0.1:11434', chatgpt: { connected: false, enabled: false, email: null } };
const blocked = () => { throw new Error('Denne funksjonen brukes i Windows-appen. Sandboxen er et separat rom for å finpusse grensesnittet.'); };
const scopedMethods = new Set(['saveProfile','saveProject','saveItem','deleteItem','saveCard','reviewCard','createChat','startHosting','stopHosting','joinGroup','leaveGroup','startInternetRoom','openSharedFile','updateSharedFile','closeSharedFile']);
const writingMethods = new Set(['saveProject','saveItem','deleteItem','saveCard','createChat','updateSharedFile']);
async function invoke(method, input) {
  if (Object.hasOwn(brainCommands.methods, method)) { const result = await brainCommands.methods[method](input); fileEvents.length = 0; return result; }
  return scopedMethods.has(method) ? brainCommands.runScoped(() => dispatch(method, input), { write: writingMethods.has(method) }) : dispatch(method, input);
}
async function dispatch(method, input) {
  switch (method) {
    case 'getState': return snapshot();
    case 'saveProfile': store.saveProfile(input); return snapshot();
    case 'saveProject': case 'saveItem': case 'deleteItem': case 'saveCard': case 'createChat': await sync.mutate(method, input); return snapshot();
    case 'reviewCard': {
      const card = sync.state().flashcards.find(card => card.id === input.id);
      if (!card) throw new Error('Kortet finnes ikke.');
      store.reviewPersonalCard(card, input.rating); return snapshot();
    }
    case 'getAiSettings': return settings;
    case 'getUpdateStatus': return updateStatus(updates.status());
    case 'checkForUpdates': return updateStatus(await updates.check({ force: true }));
    case 'updateAiSettings': {
      if (!['chatgpt', 'ollama'].includes(input?.provider)) throw new Error('Velg en KI-forbindelse.');
      settings = { provider: input.provider, model: String(input.model || '').slice(0, 180), baseUrl: String(input.baseUrl || settings.baseUrl).slice(0, 500), chatgpt: { connected: false, enabled: false, email: null } };
      baseStore.setMeta('sandboxAiSettings', settings); return settings;
    }
    case 'listModels': return [];
    case 'getSyncStatus': return sync.status();
    case 'startHosting': case 'stopHosting': case 'joinGroup': case 'leaveGroup': case 'startInternetRoom': return sync[method](input);
    case 'openSharedFile': case 'updateSharedFile': case 'closeSharedFile': return sync[method](input);
    case 'getFileEvents': return fileEvents.splice(0);
    case 'getIntegrationInfo': return { oneNote: { available: false }, remote: { available: false }, billing: { available: false } };
    case 'getRemoteDeviceStatus': return { available: false, packagedRuntime: false, state: 'stopped', running: false, logs: [], dashboardUrl: 'https://mcp.desktopcommander.app/', documentationUrl: 'https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md' };
    case 'doctorOneNote': return { available: false, registered: false, checked: 'sandbox', contentRead: false, message: 'OneNote-import brukes i Windows-appen. Denne sandboxen har egne demonstrasjonsdata.' };
    case 'cancelChat': return true;
    default: return blocked();
  }
}
const token = randomBytes(24).toString('hex');
let port;
const bridge = () => `
'use strict';
(() => {
  const token = ${JSON.stringify(token)};
  const listeners = new Set(), fileListeners = new Set();
  const names = ['getState','getBrainSpaces','switchBrain','createBrain','joinBrain','connectPublicBrain','startBrainHosting','startInternetBrain','saveProfile','saveProject','saveItem','deleteItem','saveCard','reviewCard','createChat','chat','cancelChat','getAiSettings','getUpdateStatus','checkForUpdates','installUpdate','updateAiSettings','connectChatGPT','disconnectChatGPT','listModels','importDocuments','searchSources','addSource','exportProject','importProject','getSyncStatus','startHosting','stopHosting','joinGroup','leaveGroup','startInternetRoom','openSharedFile','updateSharedFile','closeSharedFile','getIntegrationInfo','doctorOneNote','listOneNotePages','importOneNotePages','openOriginal','getRemoteDeviceStatus','startRemoteDevice','stopRemoteDevice'];
  let lastState = '';
  let polling = false;
  async function call(method, input) {
    const response = await fetch('/__sammen', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sammen-Preview': token }, body: JSON.stringify({ method, input }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sandboxen kunne ikke utføre handlingen.');
    return data.result;
  }
  const api = Object.fromEntries(names.map(name => [name, input => call(name, input)]));
  api.onState = callback => { listeners.add(callback); return () => listeners.delete(callback); };
  api.onChatDelta = () => () => {};
  api.onRemoteDeviceStatus = () => () => {};
  api.onUpdateStatus = () => () => {};
  api.onPrepareForUpdate = () => () => {};
  api.onFileCollaboration = callback => { fileListeners.add(callback); return () => fileListeners.delete(callback); };
  api.copyText = value => navigator.clipboard.writeText(value).then(() => true);
  api.openExternal = async value => { const url = new URL(value); if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('Denne lenken åpnes i Windows-appen.'); window.open(url.href, '_blank', 'noopener,noreferrer'); return true; };
  window.sammen = Object.freeze(api);
  setInterval(async () => {
    if (polling || (!listeners.size && !fileListeners.size)) return;
    polling = true;
    try {
      const state = await call('getState'); const signature = JSON.stringify(state); if (signature !== lastState) { lastState = signature; listeners.forEach(callback => callback(state)); }
      if (fileListeners.size) for (const payload of await call('getFileEvents')) fileListeners.forEach(callback => callback(payload));
    } catch {} finally { polling = false; }
  }, 700);
})();
`;
const files = new Map([['/', ['index.html','text/html']], ['/index.html', ['index.html','text/html']], ...['app', 'brain-physics', 'brain-spaces', 'brain', 'mindmap', 'study', 'file-sources', 'sharing', 'live-file', 'collaboration-model','device-setup','sidechat','updates'].map(name => ['/' + name + '.js', [name + '.js', 'text/javascript']]), ...['styles', 'minimal', 'brain-spaces', 'brain', 'mindmap', 'study', 'file-sources', 'sharing', 'live-file','device-setup','sidechat','updates'].map(name => ['/' + name + '.css', [name + '.css', 'text/css']])]);
const server = createServer(async (request, response) => {
  if (request.headers.host !== '127.0.0.1:' + port) { response.writeHead(403).end(); return; }
  const url = new URL(request.url, 'http://127.0.0.1:' + port);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.method === 'GET' && url.pathname === '/sandbox-bridge.js') { response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(bridge()); return; }
  if (request.method === 'POST' && url.pathname === '/__sammen') {
    if (request.headers['x-sammen-preview'] !== token || (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:' + port)) { response.writeHead(403).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 1000000) throw new Error('Innholdet er for stort.'); }
      const { method, input } = JSON.parse(raw);
      const result = await invoke(method, input);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ result }));
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message })); }
    return;
  }
  const file = files.get(url.pathname);
  if (request.method !== 'GET' || !file) { response.writeHead(404).end('Not found'); return; }
  try {
    let body = await readFile(join(project, 'src', 'ui', file[0]), 'utf8');
    if (file[0] === 'index.html') body = body.replace('<script src="app.js" defer></script>', '<script src="sandbox-bridge.js" defer></script>\n  <script src="app.js" defer></script>').replace('FORHÅNDSVERSJON', 'SANDBOX').replace('<body>', '<body class="sandbox">').replace('<title>Sammen – lær med hverandre</title>', '<title>Sammen · Sandbox</title>');
    response.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }).end(body);
  } catch { response.writeHead(500).end('Sandboxen kunne ikke laste grensesnittet.'); }
});
await new Promise(resolve => server.listen(Number(process.env.SAMMEN_PREVIEW_PORT) || 0, '127.0.0.1', resolve));
port = server.address().port;
console.log('SAMMEN_SANDBOX_READY ' + JSON.stringify({ url: 'http://127.0.0.1:' + port, profile, projectId: store.snapshot().projects[0]?.id || null }));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => { server.closeAllConnections(); await spaces.close(); server.close(() => process.exit(0)); });
