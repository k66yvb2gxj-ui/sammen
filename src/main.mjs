import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { createSyncService } from './sync.mjs';
import { createAiService } from './ai.mjs';
import { importDocument } from './imports.mjs';
import { searchSources } from './research.mjs';
import { createLocalOneNoteService } from './onenote.mjs';
import { createRemoteDeviceService } from './remote-device.mjs';
import { createUpdateService } from './updates.mjs';
import { createAutoUpdateService } from './auto-updates.mjs';
import { createUpdatePreparation } from './update-preparation.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const uiPath = path.join(base, 'ui', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;
if (process.env.SAMMEN_TEST_DATA) app.setPath('userData', path.resolve(process.env.SAMMEN_TEST_DATA));
app.setName('Sammen');
if (!process.env.SAMMEN_TEST_DATA && !app.requestSingleInstanceLock()) app.quit();
let window, store, sync, ai, oneNote, remoteDevice, updates;
let quitting = false;
let restartAfterUpdate = false, installingUpdate = false, updateTimer;
const updatePreparation = createUpdatePreparation({ send: value => {
  if (!window || window.isDestroyed()) throw new Error('Vinduet er lukket.');
  window.webContents.send('sammen:prepare-update', value);
} });
const activeChats = new Map();
const notify = state => { if (window && !window.isDestroyed()) window.webContents.send('sammen:state', state); };
function trusted(event) { if (event.senderFrame?.url !== uiUrl || event.sender !== window?.webContents) throw new Error('Denne handlingen er ikke tilgjengelig her.'); }
function handle(method, callback) { ipcMain.handle(`sammen:${method}`, async (event, input) => { trusted(event); return callback(input); }); }
async function openExternal(value) {
  const url = new URL(value);
  if (!['https:', 'http:', 'onenote:'].includes(url.protocol) || url.username || url.password || value.length > 5000) throw new Error('Denne lenken kan ikke åpnes.');
  await shell.openExternal(value);
}
function projectSnapshot(projectId) {
  const state = sync.state();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) throw new Error('Prosjektet finnes ikke.');
  return { format: 'sammen-project', version: 1, exportedAt: new Date().toISOString(), project, items: state.items.filter(i => i.projectId === projectId), flashcards: state.flashcards.filter(i => i.projectId === projectId), chats: state.chats.filter(i => i.projectId === projectId) };
}
async function saveSource(projectId, source, origin = 'web') {
  return sync.mutate('saveItem', { projectId, type: 'source', title: String(source.title || 'Uten tittel').slice(0,200), content: String(source.content || source.abstract || source.snippet || '').slice(0,250000), origin, sourceUrl: source.url || source.sourceUrl || '', sourceName: source.filename || source.provider || '', status: 'draft' });
}
async function configureIpc(directory) {
  handle('getState', () => sync.state());
  handle('saveProfile', input => { store.saveProfile(input); const state = sync.state(); notify(state); return state; });
  for (const operation of ['saveProject','saveItem','deleteItem','saveCard','createChat']) {
    handle(operation, async input => { await sync.mutate(operation, input); return sync.state(); });
  }
  handle('reviewCard', ({id,rating}) => { const card = sync.state().flashcards.find(c=>c.id===id); if (!card) throw new Error('Kortet finnes ikke.'); store.reviewPersonalCard(card,rating); const state = sync.state(); notify(state); return state; });
  handle('getAiSettings', () => ai.getSettings());
  handle('updateAiSettings', input => ai.updateSettings(input));
  handle('connectChatGPT', () => ai.connectChatGPT());
  handle('disconnectChatGPT', () => ai.disconnectChatGPT());
  handle('listModels', () => ai.listModels());
  handle('openExternal', openExternal);
  handle('copyText', value => { if (typeof value !== 'string' || value.length > 10000) throw new Error('Ugyldig tekst.'); clipboard.writeText(value); return true; });
  handle('getUpdateStatus', () => updates.status());
  handle('checkForUpdates', () => updates.check({ force: true }));
  handle('completeUpdatePreparation', input => updatePreparation.complete(input));
  handle('installUpdate', () => {
    if (!updates.status().automatic || updates.status().status !== 'downloaded') throw new Error('Ingen ferdig nedlastet oppdatering.');
    restartAfterUpdate = true;
    app.quit();
    return updates.status();
  });
  handle('getRemoteDeviceStatus', () => remoteDevice.status());
  handle('startRemoteDevice', () => remoteDevice.start());
  handle('stopRemoteDevice', () => remoteDevice.stop());
  handle('getStartupOptions', () => ({ showDeviceSetup: app.isPackaged && !store.getMeta('deviceSetupShown') }));
  handle('acknowledgeDeviceSetup', () => { store.setMeta('deviceSetupShown', true); return true; });
  handle('getSyncStatus', () => sync.status());
  handle('openSharedFile', input => sync.openSharedFile(input));
  handle('updateSharedFile', input => sync.updateSharedFile(input));
  handle('closeSharedFile', input => sync.closeSharedFile(input));
  handle('startInternetRoom', input => sync.startInternetRoom(input));
  handle('startHosting', input => sync.startHosting(input));
  handle('stopHosting', () => sync.stopHosting());
  handle('joinGroup', input => { for (const c of activeChats.values()) c.abort(); return sync.joinGroup(input); });
  handle('leaveGroup', () => { for (const c of activeChats.values()) c.abort(); return sync.leaveGroup(); });
  handle('getIntegrationInfo', async () => ({ oneNote: { available: true, method: 'local-com', title: 'Lokal OneNote på Windows', description: 'Bruker samme OneNote.Application-henting som på din PC. Velg sider før de importeres. OneNote-notatene endres ikke.', requirements: 'OneNote desktop installert under din Windows-bruker.', url: 'https://learn.microsoft.com/en-us/office/client-developer/onenote/application-interface-onenote' }, remote: { available: (await remoteDevice.status()).available, title: 'Remote Desktop Commander', description: 'Kjøremotor og agent følger med. Start agenten under Profil → Denne PC-en, og bekreft paringskoden i nettleseren. Fjernkontoen og prosjektsamarbeidet er separate forbindelser.', url: 'https://github.com/desktop-commander/remote-desktop-commander' }, billing: { available: false, description: 'Betalt AI er ikke aktivert.' } }));
  handle('doctorOneNote', () => oneNote.doctor());
  handle('listOneNotePages', input => oneNote.listPages(input || {}));
  handle('importOneNotePages', async ({ projectId, pageIds }) => {
    if (!Array.isArray(pageIds) || !pageIds.length || pageIds.length > 20) throw new Error('Velg mellom 1 og 20 sider.');
    projectSnapshot(projectId);
    for (const pageId of [...new Set(pageIds)]) {
      const page = await oneNote.readPage({ pageId });
      const existing = sync.state().items.find(i => i.projectId === projectId && i.sourceName === `OneNote:${pageId}`);
      await sync.mutate('saveItem', { ...(existing || {}), projectId, type: 'source', title: page.title || page.route.split(' > ').at(-1), content: `${page.route}\n\n${page.content}${page.warnings?.length ? '\n\nImportmerknader: ' + page.warnings.join(' ') : ''}`.slice(0,250000), origin: 'import', sourceUrl: page.sourceUrl || '', sourceName: `OneNote:${pageId}`, status: 'draft' });
    }
    return sync.state();
  });
  handle('searchSources', ({ query, kind }) => searchSources(query, { kind }));
  handle('addSource', async ({ projectId, source }) => { await saveSource(projectId, source); return sync.state(); });
  handle('importDocuments', async ({ projectId }) => {
    projectSnapshot(projectId);
    const selected = await dialog.showOpenDialog(window, { title: 'Legg dokumenter i Brain', properties: ['openFile','multiSelections'], filters: [{ name: 'Dokumenter', extensions: ['docx','txt','md','html','htm'] }] });
    if (selected.canceled) return sync.state();
    const warnings = [];
    for (const filename of selected.filePaths.slice(0,20)) {
      try {
        const document = await importDocument(filename);
        const saved = await saveSource(projectId, document, 'import');
        if (sync.status().mode !== 'client') {
          const attachmentDirectory = path.join(directory, 'originals'); await fs.mkdir(attachmentDirectory, { recursive: true });
          const storedName = randomUUID() + path.extname(filename).toLowerCase();
          await fs.copyFile(filename, path.join(attachmentDirectory, storedName));
          store.setMeta(`original:${saved.id}`, { storedName, name: path.basename(filename) });
        }
        warnings.push(...document.warnings.map(w => `${document.filename}: ${w}`));
      } catch (error) { warnings.push(`${path.basename(filename)}: ${error.message}`); }
    }
    if (warnings.length) await dialog.showMessageBox(window, { type: 'info', title: 'Importmerknader', message: 'Dokumentimporten er avsluttet.', detail: warnings.join('\n').slice(0,5000) });
    return sync.state();
  });
  handle('openOriginal', async ({ id }) => {
    const original = store.getMeta(`original:${id}`);
    if (!original || !/^[a-f\d-]{36}\.(docx|txt|md|html|htm)$/.test(original.storedName)) throw new Error('Originalfilen er bare tilgjengelig på PC-en som importerte den.');
    const result = await shell.openPath(path.join(directory,'originals',original.storedName)); if (result) throw new Error(result); return true;
  });
  handle('exportProject', async ({ projectId }) => {
    const exported = projectSnapshot(projectId);
    const selected = await dialog.showSaveDialog(window, { title: 'Eksporter prosjekt', defaultPath: `${exported.project.title.replace(/[<>:"/\\|?*]/g,'_')}.sammen.json`, filters: [{ name: 'Sammen-prosjekt', extensions: ['json'] }] });
    if (selected.canceled) return { canceled: true };
    await fs.writeFile(selected.filePath, JSON.stringify(exported,null,2), 'utf8'); return { canceled: false, path: selected.filePath };
  });
  handle('importProject', async () => {
    if (sync.status().mode === 'client') throw new Error('Forlat gruppen før du importerer et helt prosjekt lokalt.');
    const selected = await dialog.showOpenDialog(window, { title: 'Importer Sammen-prosjekt', properties: ['openFile'], filters: [{ name: 'Sammen-prosjekt', extensions: ['json'] }] });
    if (selected.canceled) return sync.state();
    const file = selected.filePaths[0]; const stat = await fs.stat(file); if (stat.size > 20000000) throw new Error('Prosjektfilen er større enn 20 MB.');
    store.importProject(JSON.parse(await fs.readFile(file,'utf8'))); const state = sync.state(); notify(state); return state;
  });
  handle('cancelChat', ({ chatId }) => { activeChats.get(chatId)?.abort(); return true; });
  handle('chat', async ({ chatId, message, sourceIds = [] }) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 12000 || !Array.isArray(sourceIds) || sourceIds.length > 30) throw new Error('Skriv en kortere melding og velg opptil 30 kilder.');
    if (activeChats.has(chatId)) throw new Error('Vent til svaret er ferdig.');
    const before = sync.state(); const chat = before.chats.find(c => c.id === chatId); if (!chat) throw new Error('Samtalen finnes ikke.');
    const sources = [...new Set(sourceIds)].map(id => before.items.find(i => i.id === id && i.projectId === chat.projectId)).filter(Boolean).map(item => ({ id: item.id, title: `${item.origin === 'ai' ? '[KI-utkast] ' : ''}${item.title}`, content: item.type === 'mindmap' ? (item.mindmap?.nodes || []).map(n => n.text).join('\n') : item.content, url: item.sourceUrl }));
    const controller = new AbortController(); activeChats.set(chatId,controller);
    try {
      await sync.mutate('appendMessage', { chatId, message: { role: 'user', content: message.trim() } });
      const result = await ai.generate({ messages: [...chat.messages.slice(-18).map(m => ({role:m.role,content:m.content})), {role:'user',content:message.trim()}], sources, signal: controller.signal, onDelta: delta => { if (window && !window.isDestroyed()) window.webContents.send('sammen:chat-delta',{chatId,delta}); } });
      await sync.mutate('appendMessage', { chatId, message: { role:'assistant',content:result.text,citations:result.citations,provider:result.provider,model:result.model } });
      await sync.mutate('saveItem', { projectId:chat.projectId,type:'ai',origin:'ai',status:'draft',title:`KI: ${message.trim().slice(0,130)}`,content:result.text,citations:result.citations,sourceName:`${result.provider} · ${result.model}` });
      return { state:sync.state(),result };
    } finally { activeChats.delete(chatId); }
  });
}

app.whenReady().then(async () => {
// Windows enterprise roots are trusted without disabling TLS verification.
if (tls.setDefaultCACertificates && tls.getCACertificates) tls.setDefaultCACertificates([...tls.getCACertificates('bundled'),...tls.getCACertificates('system')]);
const directory = app.getPath('userData'); await fs.mkdir(directory,{recursive:true});
store = new Store(path.join(directory,'brain.sqlite'));
sync = createSyncService({store,onChange:notify,onCollaboration:value=>{ if (window && !window.isDestroyed()) window.webContents.send('sammen:file-collaboration', value); }});
ai = await createAiService({directory,encrypt:value=>{ if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows kan ikke beskytte innloggingen.'); return safeStorage.encryptString(value); },decrypt:value=>safeStorage.decryptString(Buffer.from(value)),openExternal,fetchImpl:(...args)=>net.fetch(...args)});
oneNote = createLocalOneNoteService({scriptPath:path.join(base.replace('app.asar','app.asar.unpacked'),'onenote-read.ps1')});
remoteDevice = createRemoteDeviceService({
  runtimeDirectory: app.isPackaged ? path.join(process.resourcesPath, 'remote-device') : path.resolve(base, '..', '..', 'remote-device-bundle'),
  directory: path.join(directory, 'remote-device'),
  onStatus: value => { if (window && !window.isDestroyed()) window.webContents.send('sammen:remote-device-status', value); }
});
const updateStatus = value => {
  if (window && !window.isDestroyed()) window.webContents.send('sammen:update-status', value);
  if (installingUpdate && value.status === 'error') { quitting = false; restartAfterUpdate = false; installingUpdate = false; }
};
const installed = app.isPackaged && process.platform === 'win32' && await fs.access(path.join(path.dirname(app.getPath('exe')), 'Uninstall Sammen.exe')).then(() => true, () => false);
if (installed) {
  const { default: electronUpdater } = await import('electron-updater');
  updates = createAutoUpdateService({ currentVersion: app.getVersion(), updater: electronUpdater.autoUpdater, onStatus: updateStatus });
} else {
  const reason = app.isPackaged ? 'Installer Sammen med .exe-filen én gang for å få automatiske oppdateringer.' : 'Automatisk installasjon er tilgjengelig i den installerte Windows-appen.';
  const decorate = value => ({ ...value, automatic: false, reason });
  const manual = createUpdateService({ currentVersion: app.getVersion(), onStatus: value => updateStatus(decorate(value)) });
  updates = { status: () => decorate(manual.status()), check: async options => decorate(await manual.check(options)), dispose: manual.dispose };
}
await configureIpc(directory);
window = new BrowserWindow({width:1440,height:960,minWidth:1000,minHeight:700,title:'Sammen',backgroundColor:'#f7f8f3',show:!process.env.SAMMEN_HEADLESS,webPreferences:{preload:path.join(base,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
window.on('close', event => {
  if (!quitting && (remoteDevice.status().running || updates.status().status === 'downloaded')) { event.preventDefault(); app.quit(); }
});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
window.webContents.on('will-navigate',event=>event.preventDefault());
window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
window.webContents.session.on('will-download',event=>event.preventDefault());
await window.loadURL(uiUrl);
void updates.check();
updateTimer = setInterval(() => { if (!quitting) void updates.check(); }, 4 * 60 * 60 * 1000);
updateTimer.unref();
if (!app.isPackaged && process.env.SAMMEN_SELF_CHECK && process.env.SAMMEN_TEST_DATA) {
  try {
    const testCode = await fs.readFile(path.join(base,'..','scripts','electron-selfcheck.js'),'utf8');
    const result = await window.webContents.executeJavaScript(testCode);
    await fs.mkdir(process.env.SAMMEN_SELF_CHECK,{recursive:true});
    await fs.writeFile(path.join(process.env.SAMMEN_SELF_CHECK,'electron-result.json'),JSON.stringify(result,null,2));
    const shot = await window.webContents.capturePage();
    await fs.writeFile(path.join(process.env.SAMMEN_SELF_CHECK,'electron-brain.png'),shot.toPNG());
    console.log('SAMMEN_ELECTRON_SELF_CHECK_PASS');
  } catch(error) { console.error('SAMMEN_ELECTRON_SELF_CHECK_FAIL',error.message); process.exitCode=1; }
  app.quit();
}
app.on('second-instance',()=>{window?.show();window?.focus();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  (async () => {
    const installOnQuit = updates?.status().status === 'downloaded';
    if (installOnQuit && !await updatePreparation.request()) {
      quitting = false; restartAfterUpdate = false;
      dialog.showErrorBox('Oppdateringen venter', 'Endringene kunne ikke lagres. Lagre notatet og prøv å lukke Sammen igjen.');
      return;
    }
    for (const controller of activeChats.values()) controller.abort();
    await Promise.allSettled([remoteDevice?.stop(), sync?.stopHosting(), sync?.leaveGroup()]);
    if (remoteDevice?.status().running) {
      quitting = false; restartAfterUpdate = false;
      dialog.showErrorBox('Agenten kjører fortsatt', 'PC-tilkoblingen kunne ikke stoppes. Prøv Stopp agenten under Profil → Denne PC-en før du lukker Sammen.');
      return;
    }
    if (installOnQuit && updates?.status().status === 'downloaded') {
      installingUpdate = true;
      const started = updates.install({ restart: restartAfterUpdate });
      if (!started || updates.status().status === 'error') {
        quitting = false; restartAfterUpdate = false;
        installingUpdate = false;
        dialog.showErrorBox('Oppdateringen kunne ikke installeres', 'Prøv igjen under Profil → Oppdateringer.');
      }
      return;
    }
    updates?.dispose();
    app.quit();
  })().catch(error => {
    quitting = false; restartAfterUpdate = false;
    dialog.showErrorBox('Sammen kunne ikke lukkes', error.message);
  });
});
app.on('will-quit', () => { clearInterval(updateTimer); updatePreparation.dispose(); updates?.dispose(); });
}).catch(error=>{ console.error('Sammen kunne ikke starte:',error.message); if(!process.env.SAMMEN_HEADLESS) dialog.showErrorBox('Sammen kunne ikke starte',error.message); app.quit(); });
