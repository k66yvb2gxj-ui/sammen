import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executable = resolve(process.env.SAMMEN_PACKAGE_EXE || 'release-43/win-unpacked/Sammen.exe');
const profile = resolve('../package-smoke-profile-' + randomUUID());
const screenshots = resolve('../screenshots');
const resultFile = resolve('../package-smoke-result.json');
const helper = resolve(dirname(executable), 'resources/app.asar.unpacked/src/onenote-read.ps1');
const startedAt = Date.now();
const deadline = startedAt + 50000;
const checks = [];
const pageErrors = [];
let child, browser, page, browserSession, output = '', exitCode = null, diagnostic = null, noteId = null, cardId = null;
let failure = null;
let failureDiagnostics = null;
let ownedChildExitConfirmed = false, forcedShutdown = false;
let exitObservation = null;
const screenshotInfo = { captured: false, path: null, warning: null };
const environment = { ...process.env, SAMMEN_HEADLESS: '1', SAMMEN_TEST_DATA: profile };
delete environment.NODE_OPTIONS;
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.SAMMEN_SELF_CHECK;

function bounded(promise, label, maxMs = 12000, boundary = deadline) {
  const timeoutMs = Math.max(1, Math.min(maxMs, boundary - Date.now()));
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout etter ${timeoutMs} ms`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(filename) { try { await access(filename); return true; } catch { return false; } }
async function waitForExecutable() {
  const until = Math.min(deadline, Date.now() + 12000);
  while (!(await exists(executable)) && Date.now() < until) await delay(500);
  if (!(await exists(executable))) throw new Error('Den pakkede Windows-appen finnes ikke ennå: ' + executable);
}
function assertPublicSettings(settings) {
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, field] of Object.entries(value)) {
      assert.ok(!/(token|secret|password|credential|api.?key)/i.test(key), 'getAiSettings eksponerer et credential-felt');
      if (typeof field === 'string') assert.ok(!/^sk-[A-Za-z0-9_-]+$/.test(field) && !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(field), 'getAiSettings eksponerer en credential-verdi');
      else walk(field);
    }
  };
  walk(settings);
  assert.equal(typeof settings.provider, 'string');
  assert.equal(typeof settings.chatgpt.connected, 'boolean');
  assert.equal(settings.chatgpt.connected, false, 'Testprofilen må være uinnlogget');
}

await mkdir(profile, { recursive: true });
await mkdir(screenshots, { recursive: true });
try {
  await waitForExecutable();
  const [sourceMain, packedAsar] = await Promise.all([stat(resolve('src/main.mjs')), stat(resolve(dirname(executable), 'resources/app.asar'))]);
  assert.ok(packedAsar.mtimeMs >= sourceMain.mtimeMs, 'Windows-pakken er eldre enn gjeldende main.mjs. Rebuild før testing; appen startes ikke.');
  assert.ok(await exists(helper), 'OneNote PowerShell-helper mangler i app.asar.unpacked');
  const endpoint = new Promise((resolve, reject) => {
    let settled = false;
    child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--enable-logging=stderr'], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = chunk => {
      output = (output + chunk.toString()).slice(-16000);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(output);
      if (match && !settled) { settled = true; resolve(match[1]); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { if (!settled) { settled = true; reject(error); } });
    child.on('exit', code => { exitCode = code; if (!settled) { settled = true; reject(new Error(`Pakket app avsluttet før CDP-endepunktet (exit ${code}). ${output.slice(-1800)}`)); } });
  });
  const endpointUrl = await bounded(endpoint, 'Vanlig pakket oppstart / Chrome CDP', 15000);
  checks.push('Packaged Sammen.exe starts normally in owned isolated test profile');
  browser = await bounded(chromium.connectOverCDP(endpointUrl, { timeout: Math.max(1, Math.min(10000, deadline - Date.now())) }), 'Koble til Chrome CDP');
  const untilPage = Math.min(deadline, Date.now() + 5000);
  while (!page && Date.now() < untilPage) { page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html')); if (!page) await delay(100); }
  if (!page) throw new Error('CDP fant ikke renderer-vinduet i den pakkede appen.');
  page.setDefaultTimeout(Math.max(1, Math.min(8000, deadline - Date.now())));
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await bounded(page.waitForFunction(() => typeof window.sammen?.getState === 'function' && Boolean(document.querySelector('#navigation button[title="Brain"]'))), 'Renderer og preload');
  assert.match(page.url(), /app\.asar\/src\/ui\/index\.html$/);
  const isolation = await bounded(page.evaluate(() => ({ nodeRequire: typeof require, nodeProcess: typeof process, bridgeFrozen: Object.isFrozen(window.sammen), methods: ['getState','saveItem','reviewCard','doctorOneNote'].every(method => typeof window.sammen[method] === 'function') })), 'Kontroller preload-isolasjon');
  assert.equal(isolation.nodeRequire, 'undefined');
  assert.equal(isolation.nodeProcess, 'undefined');
  assert.equal(isolation.bridgeFrozen, true);
  assert.equal(isolation.methods, true);
  checks.push('Renderer loaded from app.asar; context-isolated frozen preload IPC is available; Node globals are absent');
  const settings = await bounded(page.evaluate(() => window.sammen.getAiSettings()), 'Offentlige KI-innstillinger');
  assertPublicSettings(settings);
  checks.push('getAiSettings returns public model/connection status without credential fields or values');
  const initial = await bounded(page.evaluate(() => window.sammen.getState()), 'Initial lokal state');
  assert.ok(await exists(resolve(profile, 'brain.sqlite')), 'Den pakkede appen bruker ikke den isolerte WORK-testprofilen; ingen fixtures skrives');
  assert.equal(initial.items.length, 0, 'Scratchprofilen skal ikke inneholde ekte notater');
  assert.equal(initial.sync.mode, 'local');
  const projectId = initial.projects[0].id;
  const fixture = await bounded(page.evaluate(async projectId => {
    await window.sammen.saveProfile({ name: 'DEMO · Pakket app-test' });
    await window.sammen.saveProject({ id: projectId, title: 'DEMO · Pakket Windows-app', description: 'Isolert test av ferdig Windows-pakke. Ingen ekte elevnotater.', color: '#647a64' });
    const withNote = await window.sammen.saveItem({ projectId, title: 'DEMO · Lokal lagring', type: 'note', origin: 'human', status: 'draft', content: 'DEMO: Dette notatet er opprettet via den ferdigpakkede appens faktiske preload og IPC. Det inneholder bare testdata.' });
    const noteId = withNote.items.find(item => item.title === 'DEMO · Lokal lagring').id;
    const withCard = await window.sammen.saveCard({ projectId, question: 'DEMO: Hva kontrolleres i denne testen?', answer: 'At Windows-pakken lagrer lokalt og holder elevens repetisjon separat fra det delte kortet.', sourceIds: [noteId] });
    return { noteId, cardId: withCard.flashcards[0].id };
  }, projectId), 'Opprett DEMO-fixtures gjennom ekte IPC');
  noteId = fixture.noteId; cardId = fixture.cardId;
  await bounded(page.locator('#navigation button[title="Brain"]').click(), 'Klikk #navigation Brain');
  await bounded(page.locator('.library-item').filter({ hasText: 'DEMO · Lokal lagring' }).click(), 'Velg DEMO library-item');
  await bounded(page.locator('#editor-content').fill('DEMO: Redigert og lagret gjennom grensesnittet i den pakkede Windows-appen.'), 'Fyll #editor-content');
  await bounded(page.locator('#save-editor').click(), 'Klikk #save-editor');
  await bounded(page.waitForFunction(async noteId => (await window.sammen.getState()).items.find(item => item.id === noteId)?.content === 'DEMO: Redigert og lagret gjennom grensesnittet i den pakkede Windows-appen.', noteId), 'Bekreft notatlagring');
  checks.push('Packaged renderer saves a note through actual UI → preload → IPC → SQLite');
  await bounded(page.locator('#navigation button[title="Flashcards"]').click(), 'Klikk #navigation Flashcards');
  await bounded(page.getByRole('button', { name: 'Vis svaret', exact: true }).click(), 'Klikk Vis svaret');
  await bounded(page.locator('[data-rating="good"]').click(), 'Klikk [data-rating=good]');
  await bounded(page.waitForFunction(async cardId => (await window.sammen.getState()).flashcards.find(card => card.id === cardId)?.reviewCount === 1, cardId), 'Bekreft elevens repetisjon');
  checks.push('Packaged UI performs individual flashcard review through actual IPC');
  diagnostic = await bounded(page.evaluate(() => window.sammen.doctorOneNote()), 'OneNote registry-only diagnose', 10000);
  assert.equal(diagnostic.checked, 'registration-only');
  assert.equal(diagnostic.contentRead, false);
  assert.ok(!('items' in diagnostic) && !('pages' in diagnostic) && !('content' in diagnostic));
  checks.push('Packaged asar.unpacked OneNote helper reports registration-only diagnosis; no titles or page content were read');
  if (process.env.SAMMEN_PACKAGE_CAPTURE === '1') {
    try {
      await bounded(page.locator('#navigation button[title="Brain"]').click(), 'Valgfri Brain for skjermbilde', 2000);
      await bounded(page.locator('.toast').evaluateAll(toasts => toasts.forEach(toast => toast.querySelector('button')?.click())), 'Valgfri toastlukking', 1000);
      await bounded(page.evaluate(() => window.scrollTo(0, 0)), 'Valgfri skjermbildeposisjon', 1000);
      await bounded(page.screenshot({ path: resolve(screenshots, 'packaged-brain.png'), fullPage: true, timeout: 2000 }), 'Valgfritt pakket skjermbilde', 2000);
      screenshotInfo.captured = true; screenshotInfo.path = resolve(screenshots, 'packaged-brain.png');
    } catch (error) { screenshotInfo.warning = 'Hidden-window CDP capture unavailable: ' + error.message; }
  } else screenshotInfo.warning = 'Skipped for hidden Electron window. Separate isolated browser renderer screenshots provide visual QA.';
  assert.deepEqual(pageErrors, []);
  checks.push('Packaged Brain rendered with explicit DEMO content; no renderer errors (hidden-window screenshot is optional)');
} catch (error) {
  failure = error;
  failureDiagnostics = { preCloseLogTail: output.slice(-3000), pageUrl: page?.url() || null };
  if (page && !page.isClosed()) {
    try {
      let timer;
      const snapshot = await Promise.race([page.evaluate(() => ({ title: document.title, bodyText: (document.body?.innerText || '').slice(0, 3500), html: document.documentElement.outerHTML.slice(0, 5000), hasBridge: typeof window.sammen?.getState === 'function', readyState: document.readyState })), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic snapshot timeout')), 1500); })]).finally(() => clearTimeout(timer));
      Object.assign(failureDiagnostics, snapshot);
    } catch (diagnosticError) { failureDiagnostics.snapshotError = diagnosticError.message; }
  }
  if (page && !page.isClosed()) { try { await bounded(page.screenshot({ path: resolve(screenshots, 'packaged-failure.png'), fullPage: true }), 'Feilskjermbilde', 2500); } catch {} }
} finally {
  const cleanupDeadline = Date.now() + 10000;
  let cleanupExitError = null;
  const waitForOwnedExit = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => child.once('exit', resolve));
  };
  if (browser?.isConnected()) {
    try { browserSession = await bounded(browser.newBrowserCDPSession(), 'CDP close-session', 500, cleanupDeadline); await bounded(browserSession.send('Browser.close'), 'Lukk eid app via CDP', 1000, cleanupDeadline); } catch { try { if (page && !page.isClosed()) await bounded(page.close(), 'Lukk eid app-vindu', 500, cleanupDeadline); } catch {} }
  }
  if (child) {
    try { await bounded(waitForOwnedExit(), 'Vent på eid app-exit', 1500, cleanupDeadline); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      try { forcedShutdown = true; child.kill('SIGTERM'); await bounded(waitForOwnedExit(), 'Bekreft exit av eksakt eid child-PID', 2000, cleanupDeadline); }
      catch (error) { cleanupExitError = error; }
    }
    ownedChildExitConfirmed = child.exitCode !== null || child.signalCode !== null;
    if (ownedChildExitConfirmed) exitObservation = 'node-child-exit';
    else if (child.pid) {
      try {
        const absent = await bounded((async () => {
          const until = Math.min(Date.now() + 3000, cleanupDeadline);
          do {
            try { process.kill(child.pid, 0); }
            catch (error) { if (error.code === 'ESRCH') return true; throw error; }
            if (Date.now() >= until) return false;
            await delay(100);
          } while (Date.now() < until);
          return false;
        })(), 'OS-fravær for eksakt eid child-PID', 3000, cleanupDeadline);
        if (absent) { ownedChildExitConfirmed = true; exitObservation = 'os-pid-absent'; }
      } catch (error) { cleanupExitError = error; }
    }
    if (!ownedChildExitConfirmed) failure ||= cleanupExitError || new Error('Den eide appprosessen er fortsatt aktiv etter cleanup; test kan ikke bestå.');
    else if (exitObservation === 'node-child-exit' && !forcedShutdown && child.exitCode !== 0) failure ||= new Error(`Pakket app avsluttet unormalt (exit ${child.exitCode}, signal ${child.signalCode}).`);
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  }
  try { if (browser?.isConnected()) await bounded(browser.close(), 'Koble fra CDP', 1000, cleanupDeadline); } catch {}
}

if (!failure) {
  try {
    const filename = resolve(profile, 'brain.sqlite');
    await access(filename);
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const savedNote = JSON.parse(db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('item', noteId).data);
      const sharedCard = JSON.parse(db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('card', cardId).data);
      const personalReview = JSON.parse(db.prepare('SELECT data FROM metadata WHERE key=?').get(`review:${cardId}`).data);
      assert.equal(savedNote.content, 'DEMO: Redigert og lagret gjennom grensesnittet i den pakkede Windows-appen.');
      assert.equal(sharedCard.reviewCount, 0);
      assert.equal(personalReview.reviewCount, 1);
      checks.push('Read-only inspection after app closure confirms persisted SQLite note and separate personal review metadata');
    } finally { db.close(); }
  } catch (error) { failure = error; }
}
const result = { passed: !failure, executable, profile, elapsedMs: Date.now() - startedAt, checks, oneNote: diagnostic, screenshot: screenshotInfo, errors: pageErrors, exitCode, ownedChildPid: child?.pid || null, ownedChildExitConfirmed, exitObservation, forcedShutdown, rendererUrl: page?.url() || null, liveApiUsed: false, autoHostingUsed: false, error: failure?.message || null, diagnostics: failureDiagnostics, logTail: failure ? output.slice(-2500) : null };
await writeFile(resultFile, JSON.stringify(result, null, 2));
console.log(failure ? 'PACKAGED_APP_SMOKE_FAIL' : 'PACKAGED_APP_SMOKE_PASS');
console.log(JSON.stringify(result, null, 2));
if (failure) process.exitCode = 1;
