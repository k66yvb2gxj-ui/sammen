import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importDocument } from './imports.mjs';

const executeFile = promisify(execFile);
const helperFilename = fileURLToPath(new URL('./onenote-read.ps1', import.meta.url))
  .replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
const powershellFilename = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function validatePageId(pageId) {
  if (typeof pageId !== 'string' || pageId.startsWith('-') || !/^[a-z0-9{}._:-]{1,256}$/i.test(pageId)) {
    throw new Error('Velg én gyldig side-ID fra OneNote-listen.');
  }
  return pageId;
}

export function createLocalOneNoteService({ scriptPath = helperFilename, runHelper = executeFile } = {}) {
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) throw new Error('OneNote-hjelperen må ha en absolutt filbane.');

  async function run(mode, parameters = []) {
    if (process.platform !== 'win32') throw new Error('Lokal OneNote-tilgang krever Windows og installert OneNote desktop.');
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Sta', '-File', scriptPath, '-Mode', mode, ...parameters];
    let response;
    try {
      response = await runHelper(powershellFilename, args, { encoding: 'utf8', windowsHide: true, timeout: 25_000, maxBuffer: 3 * 1024 * 1024, killSignal: 'SIGTERM' });
    } catch (error) {
      if (error.killed || error.code === 'ETIMEDOUT' || error.signal) throw new Error('OneNote svarte ikke innen 25 sekunder. Bare hjelpeprosessen ble avsluttet; prøv igjen etter at OneNote er klar.');
      const details = String(error.stderr || error.message || '').trim().slice(0, 700);
      throw new Error(`OneNote kunne ikke leses. Kontroller at OneNote desktop er installert og at notatbøkene er åpne i samme Windows-konto.${details ? ` ${details}` : ''}`);
    }
    if (Buffer.byteLength(response.stdout || '', 'utf8') > 3 * 1024 * 1024) throw new Error('OneNote-hjelperen returnerte for mye data.');
    let result;
    try { result = JSON.parse(String(response.stdout || '').replace(/^\uFEFF/, '').trim()); }
    catch { throw new Error('OneNote-hjelperen returnerte ugyldige data.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('OneNote-hjelperen returnerte ugyldige data.');
    return result;
  }

  async function doctor() {
    const result = await run('doctor');
    if (typeof result.available !== 'boolean') throw new Error('OneNote-diagnosen returnerte ugyldige data.');
    return result;
  }

  async function listPages({ query = '', offset = 0, limit = 60 } = {}) {
    if (typeof query !== 'string' || query.length > 500 || /[\u0000-\u001f]/.test(query)) throw new Error('OneNote-søket må være tekst på opptil 500 tegn uten kontrolltegn.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('Ugyldig startpunkt i sidelisten.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Velg mellom 1 og 200 sider per henting.');
    const result = await run('list', ['-QueryBase64', Buffer.from(query, 'utf8').toString('base64'), '-Offset', String(offset), '-Limit', String(limit)]);
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.items.length > limit) throw new Error('OneNote-sidelisten returnerte ugyldige data.');
    for (const item of result.items) {
      validatePageId(item.id);
      if (typeof item.title !== 'string' || typeof item.route !== 'string' || Object.hasOwn(item, 'content')) throw new Error('OneNote-sidelisten inneholder uventede data.');
    }
    return { items: result.items, total: result.total, offset, truncated: Boolean(result.truncated) };
  }

  async function readPage({ pageId } = {}) {
    validatePageId(pageId);
    const result = await run('read', ['-PageID', pageId]);
    if (result.id !== pageId || typeof result.title !== 'string' || typeof result.route !== 'string' || typeof result.content !== 'string'
        || result.content.length > 200_000 || !Array.isArray(result.warnings) || typeof result.revision !== 'string'
        || !/^[a-f\d]{64}$/i.test(result.revision) || typeof result.sourceUrl !== 'string'
        || result.sourceUrl && !/^onenote:/i.test(result.sourceUrl) || result.warnings.some(value => typeof value !== 'string')) {
      throw new Error('OneNote-siden returnerte ugyldige data.');
    }
    return result;
  }

  async function openPage({ pageId } = {}) {
    validatePageId(pageId);
    const result = await run('open', ['-PageID', pageId]);
    if (result.id !== pageId || result.opened !== true) throw new Error('OneNote-siden kunne ikke åpnes.');
    return result;
  }
  return { doctor, listPages, readPage, openPage };
}

export async function importOneNoteHtml(selectedPath) {
  if (typeof selectedPath !== 'string' || !['.html', '.htm'].includes(path.extname(selectedPath).toLowerCase())) {
    throw new Error('Velg en OneNote-side som er eksportert til HTML.');
  }
  const result = await importDocument(selectedPath);
  return {
    ...result,
    warnings: [...result.warnings, 'Dette er en lokal kopi av eksportert tekst. Endringer i OneNote synkroniseres ikke.'],
  };
}

export function getCapabilities() {
  return {
    liveIntegrationAvailable: process.platform === 'win32',
    localIntegrationImplemented: true,
    method: 'OneNote.Application COM',
    requiresClientRegistration: false,
    requiresOneNoteDesktop: true,
    importFormats: ['html', 'htm'],
    supportedAccountsWhenConfigured: ['notebooks-open-in-local-onenote'],
    authentication: 'current-windows-session',
    permissionsForRead: [],
    notes: [
      'Bruker det lokale OneNote.Application-grensesnittet: GetHierarchy og GetPageContent.',
      'Krever Windows og OneNote desktop, med notatbøkene åpne i samme Windows-brukersesjon.',
      'Diagnose kontrollerer COM-registrering og leser ingen sider.',
      'Søket leser sidetitler og ruter. Sideinnhold leses først etter at eleven velger en bestemt side.',
      'Tilgangen er kun for lesing. Ingen OneNote-sider endres, slettes eller deles.',
      'Tekst og tabeller importeres. OCR kan følge med, men bilder og håndskrift importeres ikke som binærdata.',
      'Importerte sider er kopier; endringer i OneNote synkroniseres ikke automatisk.',
      'HTML-import henter tekst. Bilder, håndskrift og vedlegg blir ikke importert.',
    ],
    setupLinks: [
      { title: 'OneNote Application-grensesnittet', url: 'https://learn.microsoft.com/en-us/office/client-developer/onenote/application-interface-onenote' },
    ],
  };
}
