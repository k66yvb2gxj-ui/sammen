import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createSyncService } from '../src/sync.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('.');
const profile = resolve('../browser-smoke-profile-' + randomUUID());
const screenshots = resolve('../screenshots/browser');
const reportPath = resolve('../renderer-smoke-result.json');
await mkdir(profile, { recursive: true });
await mkdir(screenshots, { recursive: true });
const store = new Store(resolve(profile, 'brain.sqlite'));
store.saveProfile({ name: 'DEMO · Testelev' });
const projectId = store.snapshot().projects[0].id;
store.saveProject({ id: projectId, title: 'DEMO · Læringsrom', description: 'Isolerte testdata for grensesnittkontroll. Ingen ekte elevnotater.', color: '#647a64' });
const note = store.saveItem({ projectId, type: 'note', origin: 'human', status: 'draft', title: 'DEMO · Arbeidsnotat', content: 'DEMO: Dette er et lokalt testnotat.\n\nSpørsmål å utforske\n• Hvordan strukturerer vi research?\n• Hvordan kobler vi kilder til egne notater?\n• Hvordan lager vi et presist flashcard?\n\nInnholdet er laget kun for å kontrollere grensesnittet.' });
const source = store.saveItem({ projectId, type: 'source', origin: 'human', status: 'draft', title: 'DEMO · Eksempellenke', content: 'DEMO: Syntetisk testfixture for å kontrollere lenker og K5-henvisning. Ingen research er hentet.', sourceUrl: 'https://example.org/how-to', sourceName: 'DEMO · example.org' });
const map = store.saveItem({ projectId, type: 'mindmap', origin: 'human', status: 'draft', title: 'DEMO · Tankekart', content: '', mindmap: { nodes: [{ id: 'root', text: 'DEMO · Læring', parentId: null }, { id: 'research', text: 'Research', parentId: 'root' }, { id: 'notes', text: 'Notater', parentId: 'root' }, { id: 'practice', text: 'Repetisjon', parentId: 'root' }, { id: 'sources', text: 'Kilder', parentId: 'research' }] } });
const cardFixtures = [
  ['DEMO: Farge A?', 'Lilla'],
  ['DEMO: Farge B?', 'Blå'],
  ['DEMO: Farge C?', 'Grønn'],
  ['DEMO: Farge D?', 'Rosa'],
];
const seededCards = cardFixtures.map(([question, answer]) => store.saveCard({ projectId, question, answer, sourceIds: [note.id] }));
const answerFor = new Map(cardFixtures);

let page;
const errors = [];
const unexpectedCalls = [];
const dispatch = () => {
  if (!page || page.isClosed()) return;
  const latest = sync.state();
  page.evaluate(value => window.__sammenDispatchState?.(value), latest).catch(error => errors.push('State dispatch: ' + error.message));
};
const sync = createSyncService({ store, onChange: dispatch });
let aiSettings = { provider: 'chatgpt', model: 'gpt-6-luna', baseUrl: 'http://127.0.0.1:11434', chatgpt: { connected: false, enabled: false, email: null } };
async function bridge(method, input) {
  switch (method) {
    case 'getState': return sync.state();
    case 'saveProfile': store.saveProfile(input); dispatch(); return sync.state();
    case 'saveProject': case 'saveItem': case 'deleteItem': case 'saveCard': case 'createChat':
      await sync.mutate(method, input); return sync.state();
    case 'reviewCard': {
      const original = sync.state().flashcards.find(value => value.id === input.id);
      store.reviewPersonalCard(original, input.rating); dispatch(); return sync.state();
    }
    case 'getAiSettings': return aiSettings;
    case 'updateAiSettings': aiSettings = { ...aiSettings, ...input }; return aiSettings;
    case 'listModels': return [];
    case 'getSyncStatus': return sync.status();
    case 'getIntegrationInfo': return { oneNote: { available: false, description: 'DEMO: Ikke lest i renderer-QA.' }, remote: { available: false }, billing: { available: false } };
    case 'doctorOneNote': return { available: false, registered: false, checked: 'renderer-test-fixture', contentRead: false, message: 'DEMO: OneNote innhold leses ikke i denne testen.' };
    case 'searchSources': unexpectedCalls.push(method); throw new Error('Live research er utenfor den isolerte renderer-testen.');
    case 'connectChatGPT': case 'disconnectChatGPT': case 'chat': case 'listOneNotePages': case 'importOneNotePages':
    case 'startHosting': case 'stopHosting': case 'joinGroup': case 'leaveGroup': case 'importDocuments': case 'importProject': case 'exportProject': case 'openExternal': case 'openOriginal': case 'copyText':
      unexpectedCalls.push(method); throw new Error(`Ikke aktivert i isolert renderer-test: ${method}`);
    default: throw new Error('Ukjent testbro: ' + method);
  }
}

const files = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ...['app', 'brain', 'mindmap', 'study'].map(name => ['/' + name + '.js', [name + '.js', 'text/javascript']]), ...['styles', 'minimal', 'brain', 'mindmap', 'study'].map(name => ['/' + name + '.css', [name + '.css', 'text/css']])]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  const file = files.get(pathname);
  if (!file) { response.writeHead(404).end('Not found'); return; }
  try { response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(await readFile(resolve(root, 'src/ui', file[0]))); }
  catch { response.writeHead(500).end('Could not load test UI'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [];
const view = async name => { await page.locator(`#navigation button[title="${name}"]`).click(); await page.waitForTimeout(80); };
const screenshot = async name => {
  await page.locator('.toast').evaluateAll(toasts => toasts.forEach(toast => toast.querySelector('button')?.click()));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(screenshots, name + '.png'), fullPage: true });
};
try {
  browser = await chromium.launch({ headless: true, timeout: 30000, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, locale: 'nb-NO', acceptDownloads: false });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.exposeBinding('__sammenBridge', (_binding, method, input) => bridge(method, input));
  await page.addInitScript(() => {
    const listeners = new Set();
    const names = ['getState','saveProfile','saveProject','saveItem','deleteItem','saveCard','reviewCard','createChat','chat','getAiSettings','updateAiSettings','connectChatGPT','disconnectChatGPT','listModels','importDocuments','searchSources','addSource','exportProject','importProject','getSyncStatus','startHosting','stopHosting','joinGroup','leaveGroup','getIntegrationInfo','doctorOneNote','listOneNotePages','importOneNotePages','openExternal','openOriginal','copyText'];
    window.sammen = Object.fromEntries(names.map(method => [method, input => window.__sammenBridge(method, input)]));
    window.sammen.onState = callback => { listeners.add(callback); return () => listeners.delete(callback); };
    window.sammen.onChatDelta = () => () => {};
    window.__sammenDispatchState = value => listeners.forEach(callback => callback(value));
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#navigation button[title="Brain"]');
  checks.push('Fresh Chromium context, local test HTTP server, real Store/createSyncService adapter');
  assert.ok((await page.evaluate(() => window.sammen.getState())).items.every(item => item.originalAvailable === false));

  await view('Brain');
  await page.locator(`.brain-graph-node[aria-label="Åpne ${note.title}"]`).locator('circle').click();
  await page.locator('#editor-content').fill('DEMO: Notat lagret gjennom faktisk grensesnitt.');
  await page.locator('#save-editor').click();
  await page.waitForFunction(async noteId => (await window.sammen.getState()).items.find(item => item.id === noteId)?.content === 'DEMO: Notat lagret gjennom faktisk grensesnitt.', note.id);
  assert.equal(store.get('item', note.id).content, 'DEMO: Notat lagret gjennom faktisk grensesnitt.');
  checks.push('Note saved through UI and real SQLite storage');
  await screenshot('brain');

  await page.locator('#editor-content').fill('DEMO: Ulagret notatutkast som skal overleve synkronisering.');
  await page.evaluate(value => window.__sammenDispatchState(value), sync.state());
  assert.equal(await page.locator('#editor-content').inputValue(), 'DEMO: Ulagret notatutkast som skal overleve synkronisering.');
  checks.push('Unsaved note retained after state callback');
  await page.locator('#save-editor').click();
  await page.waitForFunction(async noteId => (await window.sammen.getState()).items.find(item => item.id === noteId)?.content.includes('Ulagret notatutkast'), note.id);

  await page.locator('#brain-back-to-graph').click();
  await page.locator(`.brain-graph-node[aria-label="Åpne ${map.title}"]`).locator('circle').click();
  await page.waitForSelector('.topic-map-svg');
  assert.equal(await page.locator('.topic-map-svg [data-topic]').count(), 5);
  await screenshot('mindmap');
  const newBranch = page.getByRole('button', { name: 'Underpunkt', exact: true });
  await newBranch.click();
  await page.getByRole('textbox', { name: 'Tekst i valgt punkt', exact: true }).fill('DEMO · Nytt underpunkt');
  await page.getByRole('textbox', { name: 'Tekst i valgt punkt', exact: true }).press('Enter');
  assert.equal(await page.locator('.topic-map-svg [data-topic]').count(), 6);
  await page.locator('#save-editor').click();
  await page.waitForFunction(async mapId => (await window.sammen.getState()).items.find(item => item.id === mapId)?.mindmap.nodes.some(node => node.text === 'DEMO · Nytt underpunkt'), map.id);
  assert.equal(store.get('item', map.id).mindmap.nodes.length, 6);
  checks.push('Mindmap renders SVG edges/nodes and saves a new branch');

  await view('Flashcards');
  await page.locator('#ss-mode-cards').click();
  const studiedQuestion = await page.locator('#ss-flip-card .ss-card-text').innerText();
  const reviewedCard = seededCards.find(card => card.question === studiedQuestion);
  assert.ok(reviewedCard, 'The visible card comes from the isolated fixture');
  await page.locator('#ss-flip-card').click();
  assert.equal(await page.locator('#ss-flip-card .ss-card-text').innerText(), reviewedCard.answer);
  await page.getByRole('button', { name: 'Kan dette', exact: true }).click();
  await page.waitForFunction(async cardId => (await window.sammen.getState()).flashcards.find(card => card.id === cardId)?.reviewCount === 1, reviewedCard.id);
  assert.equal(store.get('card', reviewedCard.id).reviewCount, 0);
  assert.equal(store.personalCard(store.get('card', reviewedCard.id)).reviewCount, 1);
  checks.push('Individual flashcard review updates personal metadata, shared card remains unchanged');

  await view('Research');
  assert.ok(await page.locator('#research-query').isVisible());
  assert.equal(await page.locator('.source-card').count(), 0);
  checks.push('Research empty screen renders without fabricated results or live requests');

  await view('Flashcards');
  await page.locator('#ss-mode-quiz').click();
  await page.locator('#ss-quiz-count').fill('3');
  for (const type of ['choice', 'written', 'truefalse']) assert.equal(await page.locator(`#ss-type-${type}`).isChecked(), true);
  await page.locator('#ss-start-quiz').click();
  assert.equal(await page.locator('.ss-question').count(), 3);
  assert.equal(await page.locator('.ss-question.choice').count(), 1);
  assert.equal(await page.locator('.ss-question.written').count(), 1);
  assert.equal(await page.locator('.ss-question.truefalse').count(), 1);
  let missedPrompt;
  for (let index = 0; index < 3; index++) {
    const question = page.locator(`#ss-test-${index}`);
    const prompt = await question.locator('.ss-question-prompt').innerText();
    const expected = answerFor.get(prompt);
    assert.ok(expected, 'Quiz prompt comes from the isolated fixture');
    if (await question.locator('textarea').count()) {
      await question.locator('textarea').fill(`  ${expected.toUpperCase()}  `);
    } else if (await question.locator('.ss-statement').count()) {
      const statement = await question.locator('.ss-statement').innerText();
      await question.getByRole('radio', { name: statement === expected ? 'Sant' : 'Usant', exact: true }).check();
    } else {
      const options = await question.locator('.ss-choice > span:last-child').allTextContents();
      const wrongIndex = options.findIndex(value => value !== expected);
      assert.ok(wrongIndex >= 0, 'Multiple choice includes a distractor');
      await question.getByRole('radio').nth(wrongIndex).check();
      missedPrompt = prompt;
    }
  }
  assert.equal(await page.locator('#ss-quiz-answered').innerText(), '3 / 3');
  await page.getByRole('button', { name: 'Lever quiz', exact: true }).click();
  assert.match(await page.locator('.ss-score').innerText(), /2 av 3 riktige/);
  assert.equal(await page.locator('.ss-question.correct').count(), 2);
  assert.equal(await page.locator('.ss-question.incorrect').count(), 1);
  assert.equal(await page.locator('.ss-question input:enabled, .ss-question textarea:enabled').count(), 0);
  await screenshot('quiz');
  checks.push('Three-question quiz covers multiple choice, normalized writing and true/false; score and feedback match submitted answers');

  await page.getByRole('button', { name: 'Øv på feilene', exact: true }).click();
  assert.equal(await page.locator('#ss-mode-learn').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.ss-learn .ss-question-prompt').innerText(), missedPrompt);
  assert.equal(await page.locator('.ss-learn .ss-question.written').count(), 1);
  await page.locator('.ss-learn textarea').fill('DEMO: bevisst feil svar');
  await page.getByRole('button', { name: 'Sjekk svar', exact: true }).click();
  assert.equal(await page.locator('.ss-learn-feedback.incorrect').count(), 1);
  await page.locator('#ss-learn-next').click();
  assert.equal(await page.locator('.ss-learn .ss-question-prompt').innerText(), missedPrompt);
  await page.locator('.ss-learn textarea').fill(answerFor.get(missedPrompt));
  await page.getByRole('button', { name: 'Sjekk svar', exact: true }).click();
  assert.equal(await page.locator('.ss-learn-feedback.correct').count(), 1);
  await page.locator('#ss-learn-next').click();
  await page.waitForSelector('.ss-learn-finished');
  assert.match(await page.locator('.ss-learn-finished').innerText(), /1 kort · 2 svar/);
  checks.push('Wrong-answer practice uses the missed card, retries an incorrect answer and finishes after a correct answer');

  for (const name of ['Oversikt', 'Brain', 'Research', 'Flashcards']) {
    await view(name);
    const layout = await page.evaluate(() => ({ width: innerWidth, bodyWidth: document.documentElement.scrollWidth, heading: document.querySelector('h1')?.textContent }));
    assert.ok(layout.heading, `${name} has a heading`);
    assert.ok(layout.bodyWidth <= layout.width, `${name} does not overflow viewport horizontally`);
  }
  checks.push('Every view renders with headings and no horizontal overflow at 1440 px');
  await page.setViewportSize({ width: 1000, height: 750 });
  await view('Brain');
  const compactLayout = await page.evaluate(() => ({ width: innerWidth, bodyWidth: document.documentElement.scrollWidth }));
  assert.ok(compactLayout.bodyWidth <= compactLayout.width);
  checks.push('Brain layout fits desktop minimum width of 1000 px');

  assert.deepEqual(unexpectedCalls, []);
  assert.deepEqual(errors, []);
  const typography = await page.locator('body').evaluate(node => ({ fontFamily: getComputedStyle(node).fontFamily, fontSize: getComputedStyle(node).fontSize }));
  const report = { passed: true, verificationScope: 'Renderer and local backend through controlled browser bridge; desktop/Electron startup, live AI login, real OneNote and LAN connections are not verified by this test.', profile, screenshots, typography, viewport: { width: 1440, height: 960 }, checks, errors, unexpectedCalls };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log('BROWSER_RENDERER_SMOKE_PASS');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: resolve(screenshots, 'browser-failure.png'), fullPage: true }); console.log((await page.locator('body').innerText()).slice(-2200)); }
  await writeFile(reportPath, JSON.stringify({ passed: false, verificationScope: 'isolated renderer QA', profile, checks, errors, unexpectedCalls, error: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await sync.leaveGroup();
  await sync.stopHosting();
  await new Promise(resolve => server.close(resolve));
  store.close();
}
