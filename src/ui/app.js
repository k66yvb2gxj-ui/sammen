'use strict';

const api = window.sammen;
const navViews = [
  ['overview', 'Oversikt', 'overview'], ['brain', 'Brain', 'brain'],
  ['flashcards', 'Flashcards', 'cards']
];
const typeNames = { note: 'Notat', source: 'Kilde', mindmap: 'Tankekart', ai: 'KI-svar' };
const colors = ['green', 'blue', 'pink', 'yellow', 'purple'];
const colorHex = { green: '#647a64', blue: '#829ab5', pink: '#b18b83', yellow: '#b6a456', purple: '#a196b5' };
function colorName(value) { return colors.includes(value) ? value : Object.entries(colorHex).find(([, hex]) => hex === value?.toLowerCase())?.[0] || 'green'; }
let state = { user: {}, projects: [], items: [], flashcards: [], chats: [], sync: { mode: 'local' } };
const ui = {
  view: 'brain', projectId: null, itemId: null, brainFilter: 'all', brainQuery: '',
  researchKind: 'wikipedia', researchQuery: '', researchResults: [], researchBusy: false, researchSearched: false,
  cardMode: 'due', cardId: null, answerVisible: false, chatId: null, chatDraft: '',
  sourceIds: new Set(), chatBusy: false, pendingMessage: '', stream: '',
  settings: null, models: [], sync: null, integrations: null, settingsDrafts: {}
};
let editor = null;
let modalEscape = null;
let toastTimerId = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || (value === false && !key.startsWith('aria-'))) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'required') node[key] = Boolean(value);
    else if (key === 'value') continue;
    else if (key.startsWith('aria-')) node.setAttribute(key, String(value));
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (attrs.value !== undefined && attrs.value !== null) node.value = attrs.value;
  return node;
}

const paths = {
  overview: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  brain: ['M9 4a3 3 0 0 0-5 2 3 3 0 0 0-1 5 3 3 0 0 0 1 5 3 3 0 0 0 5 3V4Z', 'M15 4a3 3 0 0 1 5 2 3 3 0 0 1 1 5 3 3 0 0 1-1 5 3 3 0 0 1-5 3V4Z', 'M4 7h3M3 12h4M5 16h4M20 7h-3M21 12h-4M19 16h-4'],
  search: ['M19 19l-4-4', 'M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'],
  cards: ['M5 8h14v13H5z', 'M8 5h14v13', 'M11 2h12v13', 'M9 13h6M9 17h4'],
  chat: ['M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0Z', 'M7 10h10M7 14h6'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M9 3h6l1 3 3 1 2 3v4l-2 3-3 1-1 3H9l-1-3-3-1-2-3v-4l2-3 3-1 1-3Z'],
  add: ['M12 5v14M5 12h14'],
  file: ['M14 2H5v20h14V7l-5-5Z', 'M14 2v5h5M8 12h8M8 16h6'],
  globe: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z'],
  map: ['M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6z', 'M12 8v4M5 16v-4h14v4'],
  sparkle: ['M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z'],
  import: ['M12 3v12M7 10l5 5 5-5', 'M4 15v6h16v-6'],
  arrow: ['M5 12h14M13 6l6 6-6 6'],
  chevron: ['M9 5l7 7-7 7'],
  check: ['M5 12l4 4L19 6'],
  trash: ['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
  download: ['M12 3v12M7 10l5 5 5-5M3 18v3h18v-3'],
  link: ['M9 15l6-6', 'M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0', 'M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'],
  external: ['M14 3h7v7M21 3l-9 9', 'M10 3H3v18h18v-7'],
  book: ['M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1ZM12 5v16'],
  users: ['M10 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM1 21v-3a5 5 0 0 1 10 0v3', 'M16 5a4 4 0 0 1 0 8M15 16a5 5 0 0 1 7 5'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l4 2'],
  close: ['M6 6l12 12M6 18 18 6'],
  upload: ['M12 16V3M7 8l5-5 5 5M3 16v5h18v-5'],
  lock: ['M5 10h14v12H5zM8 10V6a4 4 0 0 1 8 0v4M12 14v4'],
  profile: ['M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 22v-3a8 8 0 0 1 16 0v3'],
  refresh: ['M21 3v6h-6M3 21v-6h6', 'M20 9a8 8 0 0 0-14-4L3 9M4 15a8 8 0 0 0 14 4l3-4'],
  cloud: ['M7 18H5a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 2 10h-2', 'M12 12v10M8 16l4-4 4 4']
};
function icon(name, size = 17) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' };
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  (paths[name] || paths.file).forEach(d => { const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', d); node.append(path); });
  return node;
}
function btn(label, handler, className = '', iconName = null, attrs = {}) {
  return el('button', { type: 'button', class: `button ${className}`, onclick: handler, ...attrs }, iconName ? icon(iconName, 14) : null, label);
}
function id() { return window.crypto.randomUUID(); }
function currentProject() { return state.projects.find(p => p.id === ui.projectId); }
function projectTitle(projectId) { return state.projects.find(p => p.id === projectId)?.title || 'Prosjekt'; }
function itemsForProject() { return state.items.filter(item => !ui.projectId || item.projectId === ui.projectId); }
function cardsForProject() { return state.flashcards.filter(card => !ui.projectId || card.projectId === ui.projectId); }
function chatsForProject() { return state.chats.filter(chat => !ui.projectId || chat.projectId === ui.projectId); }
function dateText(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
}
function relativeDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 1) return 'I dag';
  if (days === 1) return 'I går';
  if (days < 7) return `${days} dager siden`;
  return dateText(value);
}
function isAi(item) { return item.origin === 'ai' || item.type === 'ai'; }
function itemIcon(item) { return el('span', { class: `item-icon ${isAi(item) ? 'ai' : item.type}` }, icon(isAi(item) ? 'sparkle' : item.type === 'source' ? 'globe' : item.type === 'mindmap' ? 'map' : 'file', 15)); }
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:', 'onenote:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function externalLink(label, url, className = '') {
  const safe = safeUrl(url);
  if (!safe) return el('span', { class: className }, label);
  return el('a', { href: safe, class: className, onclick: event => { event.preventDefault(); invoke('openExternal', safe).catch(showError); } }, label, icon('external', 11));
}
function toast(message, error = false) {
  const node = el('div', { class: `toast${error ? ' error' : ''}` }, icon(error ? 'close' : 'check', 15), el('span', {}, message), el('button', { 'aria-label': 'Lukk melding', onclick: () => node.remove() }, '×'));
  document.getElementById('toast-region').append(node);
  setTimeout(() => node.remove(), error ? 12000 : 5500);
  toastTimerId++;
}
function showError(error) { console.error(error); toast(error?.message || String(error) || 'Noe gikk galt.', true); }
async function invoke(method, args) {
  if (!api || typeof api[method] !== 'function') throw new Error('Denne funksjonen er ikke tilgjengelig. Åpne appen gjennom Sammen-installasjonen.');
  return args === undefined ? api[method]() : api[method](args);
}
function normalizeState(value) {
  const next = value?.state || value;
  if (!next || !Array.isArray(next.projects) || !Array.isArray(next.items)) return null;
  return { ...next, user: next.user || {}, flashcards: next.flashcards || [], chats: next.chats || [], sync: next.sync || { mode: 'local' } };
}
function applyState(value, options = {}) {
  const next = normalizeState(value);
  if (!next) return;
  state = next;
  if (state.sync) ui.sync = state.sync;
  if (ui.projectId && !state.projects.some(p => p.id === ui.projectId)) ui.projectId = null;
  for (const sourceId of ui.sourceIds) if (!state.items.some(item => item.id === sourceId)) ui.sourceIds.delete(sourceId);
  renderShell();
  if (editor && ui.view === 'brain' && window.SammenLiveFile?.isActive?.(editor) && !options.force) return;
  if (ui.view === 'settings' && Object.keys(ui.settingsDrafts).length && !options.force) return;
  if (editor?.dirty && ui.view === 'brain' && !options.force) {
    const current = state.items.find(item => item.id === editor.id);
    const status = document.getElementById('editor-save-state');
    if (status && current?.revision !== editor.revision) status.textContent = 'Ny versjon finnes. Utkastet ditt er bevart.';
    return;
  }
  renderMain();
}
function preserveFocus(callback) {
  const focused = document.activeElement;
  const saved = focused?.id ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
  callback();
  if (saved) {
    const next = document.getElementById(saved.id);
    if (next) { next.focus({ preventScroll: true }); if (typeof next.setSelectionRange === 'function' && saved.start !== null) { try { next.setSelectionRange(saved.start, saved.end); } catch {} } }
  }
}
function go(view, projectId = ui.projectId, itemId = null) {
  if (window.SammenSharing?.isBusy?.()) return;
  if (!navViews.some(([key]) => key === view)) return;
  const proceed = () => {
    if (editor?.id !== itemId || view !== 'brain' || projectId !== ui.projectId) window.SammenLiveFile?.detach?.();
    ui.view = view;
    ui.projectId = projectId;
    ui.itemId = itemId;
    if (view === 'brain') ui.brainMode = itemId ? 'document' : 'graph';
    if (editor?.id !== itemId || view !== 'brain') editor = null;
    ui.answerVisible = false;
    renderShell(); renderMain();
    document.getElementById('main-content').scrollTop = 0;
  };
  if (editor?.dirty && (view !== 'brain' || itemId !== editor.id || projectId !== ui.projectId)) {
    confirmModal('Beholde eller forkaste utkastet?', 'Du har endringer som ikke er lagret i Brain.', 'Forkast og fortsett', proceed, { secondaryLabel: 'Lagre og fortsett', secondary: async () => { if (await saveEditor()) proceed(); } });
  } else proceed();
}

function renderShell() {
  const navigation = document.getElementById('navigation');
  navigation.setAttribute('role', 'tablist');
  navigation.replaceChildren(...navViews.map(([key, title, iconName], index) => el('button', { id: `app-tab-${key}`, class: `nav-item${ui.view === key ? ' active' : ''}`, title, role: 'tab', 'aria-selected': ui.view === key, 'aria-controls': 'main-content', tabindex: ui.view === key ? 0 : -1, onclick: () => go(key), onkeydown: event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % navViews.length : event.key === 'ArrowLeft' ? (index + navViews.length - 1) % navViews.length : event.key === 'Home' ? 0 : event.key === 'End' ? navViews.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    go(navViews[next][0]);
    if (ui.view === navViews[next][0]) document.getElementById(`app-tab-${ui.view}`)?.focus();
  } }, icon(iconName), el('span', {}, key === 'chat' ? 'Chat' : title))));
  document.getElementById('project-navigation').replaceChildren(...(state.projects.length ? state.projects.map(project => el('button', { class: `project-nav${ui.projectId === project.id ? ' active' : ''}`, onclick: () => go('brain', project.id) }, el('span', { class: 'project-dot', 'data-color': colorName(project.color) }), el('span', {}, project.title))) : [el('p', { class: 'sidebar-empty' }, 'Samle et fag eller en oppgave i ditt første prosjekt.')]));
  const projectSelect = document.getElementById('project-select');
  projectSelect.replaceChildren(el('option', { value: '' }, 'Alle prosjekter'), ...state.projects.map(project => el('option', { value: project.id }, project.title)));
  projectSelect.value = ui.projectId || '';
  document.getElementById('view-label').textContent = navViews.find(([key]) => key === ui.view)?.[1] || 'Oversikt';
  const name = state.user.name || 'Din profil';
  document.getElementById('profile-name').textContent = name;
  document.getElementById('profile-avatar').textContent = name.charAt(0).toUpperCase();
  const sync = ui.sync || state.sync;
  window.SammenSharing?.update?.(sync);
  document.getElementById('sidebar-mode').textContent = sync.mode === 'host' ? 'Deler' : sync.mode === 'client' ? sync.error ? 'Frakoblet' : 'Tilkoblet' : 'Lokalt';
  document.getElementById('sidebar-storage').textContent = sync.mode === 'host' ? 'Deler' : sync.mode === 'client' ? sync.error ? 'Frakoblet' : 'Felles' : 'Lokalt';
  document.getElementById('profile-button').title = name;
  document.getElementById('profile-button').setAttribute('aria-label', `Profil: ${name}`);
  document.getElementById('sidebar-add-project').disabled = sync.mode === 'client';
  document.getElementById('sidebar-add-project').title = sync.mode === 'client' ? 'Forlat gruppen for å åpne dine egne prosjekter.' : 'Nytt prosjekt';
  const clientTitle = document.getElementById('client-sync-title');
  if (clientTitle && sync.mode === 'client') clientTitle.textContent = sync.error ? 'Forbindelsen til verten er brutt' : 'Du er med i et felles prosjekt';
  const clientError = document.getElementById('sync-connection-error');
  if (clientError) { clientError.textContent = sync.error || ''; clientError.hidden = !sync.error; }
  const hostCount = document.getElementById('host-member-count');
  if (hostCount && sync.mode === 'host') hostCount.textContent = `${sync.memberCount} tilkoblet`;
  window.SammenSidechat?.update?.();
}
function pageHeading(eyebrow, title, subtitle, actions = []) {
  return el('div', { class: 'page-heading' }, el('h1', {}, title), actions.length ? el('div', { class: 'heading-actions' }, actions) : null);
}
function empty(title, copy, action = null, iconName = 'book', className = '') {
  return el('div', { class: `empty-state ${className}` }, el('span', { class: 'empty-icon' }, icon(iconName, 23)), el('h3', {}, title), action);
}
function renderMain() {
  document.body.classList.toggle('brain-view', ui.view === 'brain');
  document.getElementById('main-content').setAttribute('role', 'tabpanel');
  document.getElementById('main-content').setAttribute('aria-labelledby', `app-tab-${ui.view}`);
  preserveFocus(() => {
    const views = { overview: renderOverview, brain: () => window.SammenBrain ? window.SammenBrain.render() : renderBrain(), flashcards: () => window.SammenStudy ? window.SammenStudy.render() : renderFlashcards() };
    document.getElementById('main-content').replaceChildren((views[ui.view] || renderOverview)());
    if (ui.view === 'settings') for (const [fieldId, value] of Object.entries(ui.settingsDrafts)) {
      const input = document.getElementById(fieldId);
      if (input) input.value = value;
    }
  });
}

function renderOverview() {
  const project = currentProject();
  const items = itemsForProject();
  const cards = cardsForProject();
  const due = cards.filter(card => !card.dueAt || new Date(card.dueAt) <= new Date());
  const page = el('div', { class: 'page overview-page' });
  page.append(el('div', { class: 'overview-hero' }, el('div', {}, el('h1', {}, project ? project.title : 'Oversikt'), project?.description ? el('p', { class: 'subtitle' }, project.description) : null)));
  const stats = [[project ? 1 : state.projects.length, 'Prosjekter', 'map', ''], [items.length, 'Brain', 'brain', `${items.filter(item => item.type === 'source').length} kilder`], [cards.length, 'Flashcards', 'cards', `${due.length} klare`]];
  const statCards = stats.map(([count, label, iconName, note]) => el('div', { class: 'stat-card' },
    el('div', {}, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-number' }, count)),
    el('div', { class: 'stat-aside' }, el('span', { class: 'stat-icon' }, icon(iconName, 18)), note)
  ));
  page.append(el('div', { class: 'stats-row' }, statCards));
  page.append(el('div', { class: 'section-heading' }, el('h2', {}, 'Prosjekter'), btn('Nytt prosjekt', newProjectModal, 'button-text', 'add', { disabled: (ui.sync || state.sync).mode === 'client' })));
  const projects = project ? [project] : state.projects;
  const projectCards = projects.map(p => {
    const count = state.items.filter(item => item.projectId === p.id).length;
    return el('button', { class: 'project-card', 'data-color': colorName(p.color), onclick: () => go('brain', p.id) }, el('span', { class: 'project-arrow' }, '↗'), el('span', { class: 'project-card-icon' }, icon('book', 17)), el('h3', {}, p.title), p.description ? el('p', {}, p.description) : null, el('div', { class: 'project-card-footer' }, el('span', {}, `${count} ${count === 1 ? 'element' : 'elementer'}`), el('span', {}, relativeDate(p.updatedAt))));
  });
  if (projects.length < 3 && (ui.sync || state.sync).mode !== 'client') projectCards.push(el('button', { class: 'project-card project-add-card', onclick: newProjectModal }, icon('add', 25), el('span', {}, 'Opprett prosjekt')));
  page.append(el('div', { class: 'projects-grid' }, projectCards));
  const recent = [...items].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5);
  const recentPanel = el('section', {}, el('div', { class: 'section-heading' }, el('h2', {}, 'Sist i Brain'), btn('Åpne Brain', () => go('brain'), 'button-text', 'arrow')),
    el('div', { class: 'panel recent-list' }, recent.length ? recent.map(item => el('button', { class: 'recent-row', onclick: () => go('brain', item.projectId, item.id) }, itemIcon(item), el('span', { class: 'recent-row-copy' }, el('strong', {}, item.title), el('small', {}, `${projectTitle(item.projectId)} · ${isAi(item) ? 'KI-utkast' : typeNames[item.type] || 'Notat'}`)), el('span', { class: 'recent-row-time' }, relativeDate(item.updatedAt)))) : empty('Ingen notater ennå', '', btn('Nytt notat', () => newItem('note'), 'button-secondary', 'add'), 'file', 'compact')));
  page.append(recentPanel);
  return page;
}

function makeEditor(item) {
  return { ...item, content: item.content || '', title: item.title || '', status: item.status || 'draft', dirty: false, mindmap: item.mindmap ? JSON.parse(JSON.stringify(item.mindmap)) : { nodes: [{ id: id(), text: item.title || 'Hovedidé', parentId: null }] } };
}
function renderBrain() {
  const page = el('div', { class: 'page page-compact' }, pageHeading('DITT KUNNSKAPSROM', 'Brain', 'Fra løse tanker til kunnskap du finner igjen.', [btn('Tankekart', () => newItem('mindmap'), 'button-secondary', 'map'), btn('Nytt notat', () => newItem('note'), '', 'add')]));
  const tabs = [['all', 'Alle'], ['note', 'Notater'], ['source', 'Kilder'], ['mindmap', 'Tankekart'], ['ai', 'KI']];
  page.append(el('div', { class: 'toolbar' }, el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filtrer Brain' }, tabs.map(([key, label]) => el('button', { class: `tab${ui.brainFilter === key ? ' active' : ''}`, role: 'tab', 'aria-selected': ui.brainFilter === key, onclick: () => { ui.brainFilter = key; renderMain(); } }, label))), el('label', { class: 'search-input' }, icon('search', 14), el('input', { id: 'brain-search', placeholder: 'Finn i Brain …', 'aria-label': 'Søk i Brain', value: ui.brainQuery, oninput: event => { ui.brainQuery = event.target.value; renderMain(); } }))));
  let visible = itemsForProject().filter(item => ui.brainFilter === 'all' || (ui.brainFilter === 'ai' ? isAi(item) : item.type === ui.brainFilter && !isAi(item)));
  const query = ui.brainQuery.toLocaleLowerCase('nb-NO');
  if (query) visible = visible.filter(item => `${item.title} ${item.content || ''}`.toLocaleLowerCase('nb-NO').includes(query));
  visible.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (!ui.itemId || !itemsForProject().some(item => item.id === ui.itemId)) ui.itemId = visible[0]?.id || null;
  const selected = state.items.find(item => item.id === ui.itemId);
  if (selected && (!editor || editor.id !== selected.id || !editor.dirty)) editor = makeEditor(selected);
  if (!selected) editor = null;
  const library = el('section', { class: 'panel library-panel', 'aria-label': 'Elementer i Brain' }, el('div', { class: 'library-header' }, el('span', {}, `${visible.length} ${visible.length === 1 ? 'element' : 'elementer'}`), el('span', {}, 'SIST ENDRET')), el('div', { class: 'library-list' }, visible.length ? visible.map(item => el('button', { class: `library-item${item.id === ui.itemId ? ' active' : ''}`, onclick: () => go('brain', ui.projectId, item.id) }, itemIcon(item), el('span', { class: 'library-item-copy' }, el('span', { class: 'library-item-title' }, item.title), el('small', {}, `${isAi(item) ? 'KI · ' : ''}${relativeDate(item.updatedAt)}`)))) : empty(query ? 'Ingen treff' : 'Plass til ideene dine', query ? 'Prøv et annet søkeord eller filter.' : 'Opprett et notat eller hent inn en kilde.', null, 'file', 'compact')), el('div', { class: 'library-footer' }, 'Notater lagres når du trykker Lagre.', el('br'), (ui.sync || state.sync).mode === 'local' ? 'Alt ligger på denne PC-en.' : 'Dette prosjektet deles med inviterte elever.'));
  page.append(el('div', { class: 'brain-layout' }, library, selected ? renderEditor(selected) : el('section', { class: 'panel editor-panel' }, empty('Hva vil du lære mer om?', 'Brain er stedet for notater, kilder, tankekart og KI-utkast. Start med én tanke.', btn('Skriv et notat', () => newItem('note'), '', 'add'), 'brain'))));
  return page;
}
function markDirty() {
  if (!editor) return;
  editor.dirty = true;
  const node = document.getElementById('editor-save-state');
  if (node) { node.textContent = 'Ulagret'; node.classList.add('dirty'); }
  const wordCount = document.getElementById('word-count');
  if (wordCount) wordCount.textContent = `${(editor.content.match(/\S+/g) || []).length} ord`;
  window.SammenLiveFile?.edited?.(editor);
}
function renderEditor(item) {
  const ai = isAi(item);
  const panel = el('section', { class: `panel editor-panel${item.type === 'mindmap' ? ' mindmap-editor' : ''}`, 'aria-label': 'Rediger element' });
  panel.append(el('div', { class: 'editor-toolbar' }, el('div', { class: 'editor-tags' }, item.type === 'source' ? el('span', { class: 'chip source-chip' }, 'Kilde') : null, ai ? el('span', { class: 'chip ai-chip' }, icon('sparkle', 10), 'KI') : null), el('div', { class: 'editor-actions' }, btn('Flashcard', () => cardModal(editor), 'button-quiet button-small', 'cards'), el('button', { class: 'icon-button', title: 'Slett element', 'aria-label': 'Slett element', onclick: () => deleteItemModal(item) }, icon('trash', 14)))));
  const body = el('div', { class: 'editor-body' });
  body.append(el('input', { id: 'editor-title', class: 'editor-title', 'aria-label': 'Tittel', placeholder: 'Tittel', value: editor.title, maxlength: 200, oninput: event => { editor.title = event.target.value; markDirty(); } }), el('div', { class: 'editor-meta' }, el('span', {}, item.author || state.user.name || 'Elev'), el('span', { class: 'meta-divider' }, '·'), el('span', {}, dateText(item.updatedAt) || 'nå')));
  if (ai) body.append(el('div', { class: 'editor-notice' }, icon('sparkle', 13), editor.status === 'reviewed' ? 'KI · Kontrollert av elev' : 'KI-utkast · Kontroller kildene.'));
  if (item.sourceUrl || item.sourceName) {
    const sourceBox = el('div', { class: 'editor-source' }, el('div', {}, 'KILDE'), externalLink(item.sourceName || item.sourceUrl, item.sourceUrl));
    if (item.originalAvailable) sourceBox.append(btn('Original', () => invoke('openOriginal', { id: item.id }).catch(showError), 'button-text button-small', 'external', { title: 'Åpne originalfilen på denne PC-en' }));
    else if (item.origin === 'import' && !safeUrl(item.sourceUrl)?.startsWith('onenote:')) sourceBox.append(el('small', { class: 'original-file-note' }, 'Tekstkopi'));
    body.append(sourceBox);
  }
  if (item.type === 'mindmap') body.append(renderMindmapEditor());
  else body.append(el('textarea', { id: 'editor-content', class: 'content-editor', 'aria-label': 'Notatinnhold', placeholder: 'Skriv her …', value: editor.content, oninput: event => { editor.content = event.target.value; markDirty(); } }));
  if (window.SammenFileSources) body.append(window.SammenFileSources.render(editor));
  else if (item.citations?.length) body.append(renderReferences(item.citations));
  panel.querySelector('.editor-tags').append(window.SammenLiveFile?.presence?.() || '');
  panel.append(body, el('div', { class: 'editor-footer' }, el('div', { class: 'badge-row' }, el('span', { id: 'editor-save-state', class: `editor-save-state${editor.dirty ? ' dirty' : ''}` }, editor.dirty ? 'Ulagret' : 'Lagret'), el('span', { id: 'word-count', class: 'editor-save-state word-count' }, `${(editor.content.match(/\S+/g) || []).length} ord`)), el('div', { class: 'heading-actions' }, el('select', { id: 'editor-status', class: 'status-select', 'aria-label': 'Kontrollstatus', value: editor.status, onchange: event => { editor.status = event.target.value; markDirty(); } }, el('option', { value: 'draft' }, 'Utkast'), el('option', { value: 'reviewed' }, 'Kontrollert')), btn('Lagre', () => saveEditor(), '', 'check', { id: 'save-editor' }))));
  queueMicrotask(() => { if (ui.view === 'brain' && editor?.id === item.id) window.SammenLiveFile?.bind?.(editor); });
  return panel;
}
function renderReferences(citations) {
  return el('section', { class: 'reference-list' }, el('h4', {}, 'Kilder'), citations.map((citation, index) => {
    const source = state.items.find(item => item.id === citation.sourceId);
    const label = citation.label || citation.id || `K${index + 1}`;
    const title = citation.title || source?.title || citation.url || 'Kilde';
    const url = citation.url || citation.sourceUrl || source?.sourceUrl;
    return safeUrl(url) ? externalLink(`${label} · ${title}`, url) : el('button', { onclick: () => source && go('brain', source.projectId, source.id), disabled: !source }, el('span', { class: 'reference-label' }, label), title);
  }));
}
function renderMindmapEditor() {
  if (window.SammenMindmap) return window.SammenMindmap.render();
  const block = el('div');
  block.append(el('div', { id: 'mindmap-canvas', class: 'mindmap-canvas', role: 'img', 'aria-label': 'Tankekartets sammenhenger' }), el('div', { class: 'section-heading' }, el('h3', {}, 'Punkter'), btn('Ny gren', addMindmapNode, 'button-secondary button-small', 'add')), el('div', { id: 'mindmap-table', class: 'mindmap-table' }));
  setTimeout(() => { if (ui.view === 'brain' && editor?.type === 'mindmap') { renderMindmapTable(); drawMindmap(); } }, 0);
  return block;
}
function descendants(nodeId, nodes) {
  const result = new Set([nodeId]);
  let changed = true;
  while (changed) { changed = false; for (const node of nodes) if (result.has(node.parentId) && !result.has(node.id)) { result.add(node.id); changed = true; } }
  return result;
}
function renderMindmapTable() {
  const table = document.getElementById('mindmap-table');
  if (!table || !editor) return;
  const nodes = editor.mindmap.nodes;
  table.replaceChildren(...nodes.map((node, index) => {
    const excluded = descendants(node.id, nodes);
    const parent = el('select', { 'aria-label': `Forelder til idé ${index + 1}`, disabled: !node.parentId, onchange: event => { node.parentId = event.target.value; markDirty(); drawMindmap(); } }, !node.parentId ? el('option', { value: '' }, 'Hovedidé') : null, nodes.filter(n => !excluded.has(n.id)).map(n => el('option', { value: n.id }, n.text || 'Uten navn')));
    parent.value = node.parentId || '';
    return el('div', { class: 'mindmap-row' }, el('input', { id: `mindmap-node-${node.id}`, value: node.text, maxlength: 180, 'aria-label': `Idé ${index + 1}`, oninput: event => { node.text = event.target.value; markDirty(); drawMindmap(); }, onchange: () => renderMindmapTable() }), parent, el('button', { class: 'icon-button', 'aria-label': `Slett idé ${index + 1}`, disabled: !node.parentId, onclick: () => { for (const child of nodes) if (child.parentId === node.id) child.parentId = node.parentId; editor.mindmap.nodes = nodes.filter(n => n.id !== node.id); markDirty(); renderMindmapTable(); drawMindmap(); } }, '×'));
  }));
}
function addMindmapNode() {
  if (!editor) return;
  if (editor.mindmap.nodes.length >= 60) return toast('Dette kartet kan ha opptil 60 ideer.', true);
  editor.mindmap.nodes.push({ id: id(), text: 'Ny idé', parentId: editor.mindmap.nodes[0]?.id || null });
  markDirty(); renderMindmapTable(); drawMindmap();
}
function drawMindmap() {
  const canvas = document.getElementById('mindmap-canvas');
  if (!canvas || !editor) return;
  const nodes = editor.mindmap.nodes;
  const map = new Map(nodes.map(node => [node.id, node]));
  const depth = (node, seen = new Set()) => { if (!node.parentId || !map.has(node.parentId) || seen.has(node.id)) return 0; seen.add(node.id); return Math.min(10, 1 + depth(map.get(node.parentId), seen)); };
  const groups = new Map();
  for (const node of nodes) { const d = depth(node); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(node); }
  const width = Math.max(640, (Math.max(...groups.keys(), 0) + 1) * 235 + 30);
  const maxRows = Math.max(...[...groups.values()].map(group => group.length), 1);
  const height = Math.max(280, maxRows * 70 + 50);
  const position = new Map();
  for (const [d, group] of groups) group.forEach((node, index) => position.set(node.id, { x: 24 + d * 235, y: (height / (group.length + 1)) * (index + 1) - 22 }));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const node of nodes) {
    const current = position.get(node.id), parent = position.get(node.parentId);
    if (parent) { const path = document.createElementNS(ns, 'path'); const middle = (parent.x + 190 + current.x) / 2; path.setAttribute('d', `M ${parent.x + 190} ${parent.y + 22} C ${middle} ${parent.y + 22}, ${middle} ${current.y + 22}, ${current.x} ${current.y + 22}`); path.setAttribute('class', 'mindmap-edge'); svg.append(path); }
  }
  for (const node of nodes) {
    const pos = position.get(node.id);
    const group = document.createElementNS(ns, 'g');
    const rectangle = document.createElementNS(ns, 'rect');
    Object.entries({ x: pos.x, y: pos.y, width: 190, height: 44, rx: 8, class: `mindmap-node${node.parentId ? '' : ' root-node'}` }).forEach(([key, value]) => rectangle.setAttribute(key, value));
    const text = document.createElementNS(ns, 'text');
    Object.entries({ x: pos.x + 13, y: pos.y + 27, class: 'mindmap-text' }).forEach(([key, value]) => text.setAttribute(key, value));
    text.textContent = (node.text || 'Uten navn').length > 26 ? `${node.text.slice(0, 25)}…` : node.text || 'Uten navn';
    const title = document.createElementNS(ns, 'title'); title.textContent = node.text || 'Uten navn';
    group.append(title, rectangle, text); svg.append(group);
  }
  canvas.replaceChildren(svg);
}
async function saveEditor() {
  if (editor?.type === 'mindmap') window.SammenMindmap?.flush?.();
  if (!editor) return false;
  if (window.SammenLiveFile?.isActive?.(editor)) return window.SammenLiveFile.save(editor);
  if (!editor.title.trim()) { toast('Gi notatet en tittel før du lagrer.', true); document.getElementById('editor-title')?.focus(); return false; }
  const button = document.getElementById('save-editor');
  if (button) { button.disabled = true; button.textContent = 'Lagrer …'; }
  const savingEditor = editor;
  const serializeDraft = draft => {
    const data = { ...draft, title: draft.title.trim() };
    delete data.dirty;
    if (data.type !== 'mindmap') delete data.mindmap;
    return JSON.stringify(data);
  };
  const savedDraft = serializeDraft(savingEditor);
  const snapshot = JSON.parse(savedDraft);
  try {
    const result = await invoke('saveItem', snapshot);
    if (editor === savingEditor) {
      const unchanged = serializeDraft(savingEditor) === savedDraft;
      const savedItem = normalizeState(result)?.items.find(item => item.id === snapshot.id);
      if (savedItem) savingEditor.revision = savedItem.revision;
      savingEditor.dirty = !unchanged;
      applyState(result, { force: unchanged });
      toast(unchanged ? 'Lagret i Brain.' : 'Lagret. De nyeste endringene er fortsatt ulagret.');
    } else {
      applyState(result);
      toast('Lagret i Brain.');
    }
    return editor !== savingEditor || !savingEditor.dirty;
  } catch (error) { showError(error); return false; }
  finally { if (button?.isConnected) { button.disabled = false; button.replaceChildren(icon('check', 14), 'Lagre'); } }
}

// A downloaded update may only close the window after local edits have saved.
api.onPrepareForUpdate?.(async ({ id: requestId }) => {
  let ok = false;
  try {
    window.SammenSidechat?.prepareForUpdate?.();
    window.SammenMindmap?.flush?.();
    ok = !editor?.dirty || await saveEditor();
    if (!ok) toast('Lagre endringene før appen kan oppdateres.', true);
  } catch (error) { showError(error); }
  try { await invoke('completeUpdatePreparation', { id: requestId, ok }); } catch {}
});
function deleteItemModal(item) {
  confirmModal('Slette fra Brain?', `«${item.title}» blir slettet fra dette prosjektet.`, 'Slett element', async () => {
    try { const result = await invoke('deleteItem', { id: item.id, revision: item.revision }); editor = null; ui.itemId = null; applyState(result); toast('Elementet er slettet.'); } catch (error) { showError(error); }
  }, { danger: true });
}

function renderResearch() {
  const page = el('div', { class: 'page' }, pageHeading('', 'Research', ''));
  const providers = [['wikipedia', 'Wikipedia'], ['crossref', 'Crossref'], ['pubmed', 'PubMed']];
  const searchPanel = el('form', { class: 'panel research-search', onsubmit: event => { event.preventDefault(); searchResearch(); } }, el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Søkekilde' }, providers.map(([kind, label]) => el('button', { type: 'button', class: `tab${ui.researchKind === kind ? ' active' : ''}`, role: 'tab', 'aria-selected': ui.researchKind === kind, onclick: () => { ui.researchKind = kind; ui.researchResults = []; ui.researchSearched = false; renderMain(); } }, label))), el('div', { class: 'research-question' }, el('input', { id: 'research-query', placeholder: 'Søk etter kilder …', 'aria-label': 'Søkeord for kildesøk', value: ui.researchQuery, required: true, maxlength: 500, oninput: event => { ui.researchQuery = event.target.value; } }), el('button', { type: 'submit', class: 'button', disabled: ui.researchBusy }, icon('search', 14), ui.researchBusy ? 'Søker …' : 'Finn kilder')), ui.researchKind === 'crossref' ? el('p', { class: 'research-note' }, 'Crossref henter publikasjonsdata, ikke fulltekst.') : ui.researchKind === 'pubmed' ? el('p', { class: 'research-note' }, 'Engelske fagord gir ofte flere treff.') : null);
  const results = el('div');
  if (ui.researchBusy) results.append(empty('Søker …', '', null, 'search', 'compact'));
  else if (ui.researchResults.length) {
    results.append(el('div', { class: 'search-results-header' }, `${ui.researchResults.length} treff`, el('span', {}, providers.find(([kind]) => kind === ui.researchKind)?.[1])));
    ui.researchResults.forEach(source => {
      const stored = state.items.some(item => item.type === 'source' && (item.sourceUrl === (source.url || source.sourceUrl)) && (!ui.projectId || item.projectId === ui.projectId));
      const authors = Array.isArray(source.authors) ? source.authors.join(', ') : source.authors || '';
      const content = source.content || source.abstract || source.snippet || '';
      const details = content.length > 650 ? el('details', {}, el('summary', {}, 'Les mer'), el('p', {}, content.slice(650))) : null;
      results.append(el('article', { class: 'panel source-card' }, el('div', { class: 'source-card-head' }, el('span', { class: 'chip source-chip' }, icon('globe', 10), source.provider || providers.find(([kind]) => kind === ui.researchKind)?.[1]), source.metadataOnly ? el('span', { class: 'chip' }, 'METADATA') : el('span', { class: 'chip' }, 'UTDRAG')), el('h3', {}, source.title || 'Kilde uten tittel'), el('div', { class: 'source-meta' }, [authors, source.year || source.published, source.doi ? `DOI: ${source.doi}` : null].filter(Boolean).join(' · ')), content ? el('p', {}, content.slice(0, 650) + (content.length > 650 ? ' …' : '')) : el('p', {}, 'Fulltekst er ikke hentet.'), details, el('div', { class: 'source-actions' }, btn(stored ? 'Lagret i Brain' : 'Legg i Brain', () => saveSource(source), 'button-secondary button-small', stored ? 'check' : 'add', { disabled: stored }), externalLink('Åpne originalen', source.url || source.sourceUrl))));
    });
  } else if (ui.researchSearched) results.append(el('div', { class: 'panel empty-research' }, empty('Ingen treff', 'Prøv et annet søkeord.', null, 'search')));
  else results.append(el('div', { class: 'panel empty-research' }, empty('Finn en kilde', 'Søk etter et tema eller en artikkel.', null, 'search')));
  page.append(el('section', {}, searchPanel, results));
  return page;
}
async function searchResearch() {
  if (ui.researchBusy || !ui.researchQuery.trim()) return;
  ui.researchBusy = true; ui.researchSearched = true; renderMain();
  try {
    const results = await invoke('searchSources', { query: ui.researchQuery.trim(), kind: ui.researchKind });
    ui.researchResults = Array.isArray(results) ? results : results.results || [];
  } catch (error) { showError(error); ui.researchResults = []; }
  finally { ui.researchBusy = false; if (ui.view === 'research') renderMain(); }
}
function saveSource(source) {
  withProject(async projectId => {
    try { applyState(await invoke('addSource', { projectId, source })); toast('Kilden er lagt i Brain.'); } catch (error) { showError(error); }
  }, 'Velg prosjekt for kilden');
}

function reviewQueue() {
  const cards = cardsForProject();
  return (ui.cardMode === 'due' ? cards.filter(card => !card.dueAt || new Date(card.dueAt) <= new Date()) : cards).sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0));
}
function renderFlashcards() {
  const page = el('div', { class: 'page' }, pageHeading('', 'Flashcards', '', [btn('Nytt flashcard', () => cardModal(), '', 'add')]));
  const cards = cardsForProject();
  const queue = reviewQueue();
  if (!queue.some(card => card.id === ui.cardId)) { ui.cardId = queue[0]?.id || null; ui.answerVisible = false; }
  const card = queue.find(c => c.id === ui.cardId);
  page.append(el('div', { class: 'toolbar' }, el('div', { class: 'tabs' }, [['due', 'Klare'], ['all', 'Alle']].map(([mode, label]) => el('button', { class: `tab${ui.cardMode === mode ? ' active' : ''}`, onclick: () => { ui.cardMode = mode; ui.cardId = null; ui.answerVisible = false; renderMain(); } }, label))), el('span', { class: 'tiny muted' }, `${cards.length} kort`)));
  if (!card) {
    page.append(el('div', { class: 'panel' }, empty(cards.length ? 'Ferdig for nå' : 'Ingen flashcards', '', btn(cards.length ? 'Vis alle' : 'Nytt flashcard', () => cards.length ? (ui.cardMode = 'all', renderMain()) : cardModal(), '', 'cards'), 'cards')));
    return page;
  }
  const index = queue.indexOf(card);
  const study = el('section', { class: 'panel study-panel' }, el('div', { class: 'study-top' }, el('span', {}, projectTitle(card.projectId)), el('span', {}, `${index + 1} av ${queue.length}`)));
  const face = el('div', { class: 'study-face' }, el('div', { class: 'card-side' }, 'SPØRSMÅL'), el('p', { class: 'study-question' }, card.question));
  if (ui.answerVisible) face.append(el('div', { class: 'study-answer' }, card.answer));
  study.append(face);
  if (ui.answerVisible) {
    study.append(el('div', { class: 'study-foot' }, el('div', { class: 'rating-row' }, [['again', 'En gang til'], ['hard', 'Vanskelig'], ['good', 'Greit'], ['easy', 'Lett']].map(([rating, label]) => el('button', { class: 'rating-button', 'data-rating': rating, onclick: () => reviewCard(card, rating) }, label)))));
  } else study.append(el('div', { class: 'study-foot' }, btn('Vis svaret', () => { ui.answerVisible = true; renderMain(); }, '', 'refresh')));
  study.append(el('div', { class: 'study-meta' }, el('span', {}, `${card.reviewCount || 0} repetisjoner · ${card.origin === 'ai' ? 'Laget av KI' : 'Laget av elev'}`), btn('Rediger kort', () => cardModal(null, card), 'button-text')));
  const list = el('aside', { class: 'panel study-list' }, el('div', { class: 'study-list-header' }, `${queue.length} kort`), el('div', { class: 'study-list-items' }, queue.map(c => el('button', { class: `study-list-button${c.id === ui.cardId ? ' active' : ''}`, onclick: () => { ui.cardId = c.id; ui.answerVisible = false; renderMain(); } }, c.question, el('small', {}, c.dueAt ? dateText(c.dueAt) : 'Nytt kort')))));
  page.append(el('div', { class: 'study-layout' }, study, list));
  return page;
}
async function reviewCard(card, rating) {
  try { applyState(await invoke('reviewCard', { id: card.id, rating })); ui.answerVisible = false; const queue = reviewQueue(); ui.cardId = queue.find(c => c.id !== card.id)?.id || queue[0]?.id || null; renderMain(); } catch (error) { showError(error); }
}
function cardModal(note = null, existing = null) {
  if (!state.projects.length) return withProject(() => cardModal(note, existing));
  const initialProject = existing?.projectId || note?.projectId || ui.projectId || state.projects[0]?.id;
  const form = el('form');
  const project = projectField(initialProject);
  if (existing || note) project.input.disabled = true;
  const question = el('textarea', { id: 'card-question', required: true, maxlength: 2000, placeholder: 'Spørsmål …', value: existing?.question || (note ? `Hva er ${note.title.toLocaleLowerCase('nb-NO')}?` : '') });
  const answer = el('textarea', { id: 'card-answer', required: true, maxlength: 12000, placeholder: 'Svar …', value: existing?.answer || (note ? note.content.slice(0, 1000) : '') });
  form.append(project.wrapper, field('Spørsmål', question), field('Svar', answer), note ? el('p', { class: 'form-help' }, 'Tilpass teksten fra notatet før du lagrer.') : null);
  const submit = el('button', { type: 'submit', class: 'button' }, icon('check', 14), existing ? 'Lagre endringer' : 'Lag flashcard');
  form.append(el('div', { class: 'modal-actions' }, btn('Avbryt', closeModal, 'button-secondary'), submit));
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      const result = await invoke('saveCard', { ...(existing || {}), projectId: project.input.value, question: question.value.trim(), answer: answer.value.trim(), origin: existing?.origin || 'human', sourceIds: existing?.sourceIds || (note ? [note.id] : []) });
      closeModal(); applyState(result); toast('Flashcardet er lagret.');
    } catch (error) { showError(error); submit.disabled = false; }
  });
  openModal(existing ? 'Rediger flashcard' : 'Nytt flashcard', '', form, 'modal-wide');
  question.focus();
}

function modelText() {
  const model = ui.settings?.model || '';
  if (model.toLowerCase().includes('luna')) return 'Luna';
  return ui.models.find(m => m.id === model)?.name || model || 'Velg modell';
}
function aiReady() { return Boolean(ui.settings?.model) && (ui.settings?.provider === 'ollama' || Boolean(ui.settings?.chatgpt?.connected && ui.settings?.chatgpt?.enabled !== false)); }
function currentChat() { return state.chats.find(chat => chat.id === ui.chatId); }
function renderChat() {
  const page = el('div', { class: 'page page-compact chat-page' }, pageHeading('', 'Chat', ''));
  const chats = [...chatsForProject()].reverse();
  if (!chats.some(chat => chat.id === ui.chatId)) ui.chatId = chats[0]?.id || null;
  const chat = currentChat();
  const history = el('aside', { class: 'panel chat-history' }, el('div', { class: 'chat-history-head' }, btn('Ny samtale', newChat, 'button-secondary button-wide button-small', 'add')), el('div', { class: 'chat-history-list' }, chats.length ? chats.map(session => el('button', { class: `chat-session${session.id === ui.chatId ? ' active' : ''}`, onclick: () => { if (ui.chatBusy) return toast('Vent til det aktive svaret er ferdig.'); ui.chatId = session.id; ui.sourceIds.clear(); renderMain(); } }, el('span', {}, session.title || 'Ny samtale'), el('small', {}, projectTitle(session.projectId)))) : el('p', { class: 'sidebar-empty' }, 'Ingen samtaler')));
  const main = el('section', { class: 'panel chat-main', 'aria-label': 'KI-samtale' });
  main.append(el('div', { class: 'chat-head' }, el('div', { class: 'chat-provider' }, icon('sparkle', 13), ui.settings?.provider === 'ollama' ? 'Lokal KI' : 'ChatGPT', el('span', { class: 'muted' }, '·'), modelText()), el('span', { class: 'chip' }, aiReady() ? 'TILKOBLET' : 'IKKE TILKOBLET')));
  const messages = el('div', { class: 'messages', id: 'chat-messages', 'aria-live': 'polite', 'aria-relevant': 'additions text' });
  const chatMessages = chat?.messages || [];
  if (!chatMessages.length && !ui.chatBusy) messages.append(renderChatWelcome());
  else chatMessages.forEach(message => messages.append(renderMessage(message)));
  if (ui.chatBusy) {
    const hasPending = chatMessages.some(message => message.role === 'user' && message.content === ui.pendingMessage);
    if (!hasPending) messages.append(renderMessage({ role: 'user', content: ui.pendingMessage }));
    messages.append(renderMessage({ role: 'assistant', content: ui.stream || 'Tenkepause …', pending: true }));
  }
  main.append(messages);
  const composer = el('form', { class: 'composer', onsubmit: event => { event.preventDefault(); sendChat(); } }, el('textarea', { id: 'chat-draft', 'aria-label': 'Melding til KI', placeholder: aiReady() ? 'Skriv en melding …' : 'Koble til KI i innstillinger …', value: ui.chatDraft, maxlength: 12000, disabled: ui.chatBusy, oninput: event => { ui.chatDraft = event.target.value; }, onkeydown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(); } } }), el('button', { type: 'submit', class: 'button', title: 'Send melding', 'aria-label': 'Send melding', disabled: ui.chatBusy || !aiReady() }, icon('arrow', 15)));
  main.append(el('div', { class: 'composer-wrap' }, composer, el('div', { class: 'composer-note' }, 'Svar → Brain · KI-utkast')));
  const contextItems = state.items.filter(item => item.projectId === (chat?.projectId || ui.projectId || state.projects[0]?.id));
  const context = el('aside', { class: 'panel chat-context' }, el('div', { class: 'chat-context-head' }, el('h3', {}, 'Fra Brain'), el('p', {}, 'Valgte utdrag sendes til KI.')), el('div', { class: 'context-count' }, el('span', { id: 'context-count' }, `${ui.sourceIds.size} valgt`), el('button', { class: 'text-button', onclick: () => { ui.sourceIds.clear(); renderMain(); } }, 'Nullstill')), el('div', { class: 'context-list' }, contextItems.length ? contextItems.map(item => el('label', { class: 'context-item' }, el('input', { type: 'checkbox', checked: ui.sourceIds.has(item.id), disabled: ui.chatBusy, onchange: event => toggleChatSource(event, item.id) }), el('span', {}, el('strong', {}, item.title), el('small', {}, `${isAi(item) ? 'KI-utkast' : typeNames[item.type]}${item.sourceName ? ` · ${item.sourceName}` : ''}`)))) : el('p', { class: 'sidebar-empty' }, 'Ingen notater eller kilder')), el('div', { class: 'context-foot' }, 'Kontroller KI-svar mot originalkildene.'));
  page.append(el('div', { class: 'chat-layout' }, history, main, context));
  if (chatMessages.length || ui.chatBusy) setTimeout(() => { const container = document.getElementById('chat-messages'); if (container) container.scrollTop = container.scrollHeight; }, 0);
  return page;
}
function renderChatWelcome() {
  return el('div', { class: 'chat-welcome' }, el('span', { class: 'welcome-symbol' }, icon('sparkle', 23)), el('h3', {}, aiReady() ? 'Hva vil du utforske?' : 'Koble til KI'), aiReady() ? null : el('p', {}, 'Bruk eget ChatGPT-abonnement eller Ollama.'), aiReady() ? el('div', { class: 'chat-prompts' }, [['Forklar med et eksempel', 'Forklar temaet med et eksempel'], ['Sjekk påstandene', 'Hvilke påstander bør jeg undersøke?'], ['Test meg', 'Still meg tre spørsmål om notatet']].map(([label, prompt]) => el('button', { onclick: () => { ui.chatDraft = prompt; renderMain(); document.getElementById('chat-draft')?.focus(); } }, label))) : btn('Koble til KI', () => go('settings'), 'button-secondary', 'settings'));
}
function toggleChatSource(event, sourceId) {
  if (event.target.checked && ui.sourceIds.size >= 30) { event.target.checked = false; toast('Velg opptil 30 elementer fra Brain per melding.'); return; }
  event.target.checked ? ui.sourceIds.add(sourceId) : ui.sourceIds.delete(sourceId);
  document.getElementById('context-count').textContent = `${ui.sourceIds.size} valgt`;
}
function renderMessage(message) {
  const user = message.role === 'user';
  const author = message.author || state.user.name || 'Du';
  const node = el('article', { class: `message ${user ? 'user' : 'assistant'}` }, el('span', { class: 'message-avatar' }, user ? author.charAt(0).toUpperCase() : icon('sparkle', 13)));
  const copy = el('div', { class: 'message-copy' }, el('div', { class: 'message-label' }, el('span', {}, user ? author : 'Sammen KI'), el('span', {}, message.pending ? 'SKRIVER …' : user ? '' : 'KI · IKKE KONTROLLERT')), el('div', { class: 'message-content', id: message.pending ? 'streaming-content' : null }, message.content || ''));
  if (message.citations?.length) copy.append(el('div', { class: 'message-citations' }, message.citations.map((citation, index) => {
    const source = state.items.find(item => item.id === citation.sourceId);
    const title = citation.title || source?.title || 'Kilde';
    const label = citation.label || citation.id || `K${index + 1}`;
    const url = citation.url || citation.sourceUrl || source?.sourceUrl;
    const contents = [el('span', {}, `${label} · ${title}`), icon(safeUrl(url) ? 'external' : 'file', 9)];
    if (safeUrl(url)) return el('a', { class: 'citation-link', href: safeUrl(url), title, onclick: event => { event.preventDefault(); invoke('openExternal', safeUrl(url)).catch(showError); } }, contents);
    return el('button', { class: 'citation-link', title, disabled: !source, onclick: () => source && go('brain', source.projectId, source.id) }, contents);
  })));
  node.append(copy);
  return node;
}
async function newChat() {
  if (ui.chatBusy) return toast('Vent til det aktive svaret er ferdig.');
  withProject(async projectId => {
    try {
      const oldIds = new Set(state.chats.map(chat => chat.id));
      const result = await invoke('createChat', { projectId });
      const next = normalizeState(result);
      ui.chatId = next?.chats.find(chat => !oldIds.has(chat.id))?.id || result.chatId || null;
      ui.projectId = projectId; ui.sourceIds.clear(); ui.chatDraft = ''; ui.view = 'chat';
      applyState(result);
      document.getElementById('chat-draft')?.focus();
    } catch (error) { showError(error); }
  }, 'Velg prosjekt for samtalen');
}
async function sendChat() {
  if (ui.chatBusy || !ui.chatDraft.trim()) return;
  if (!aiReady()) return go('settings');
  let chat = currentChat();
  if (!chat) {
    if (!ui.projectId && state.projects.length !== 1) return withProject(projectId => { ui.projectId = projectId; sendChat(); }, 'Velg prosjekt for samtalen');
    const projectId = ui.projectId || state.projects[0]?.id;
    if (!projectId) return withProject(projectId => { ui.projectId = projectId; sendChat(); });
    try {
      const oldIds = new Set(state.chats.map(c => c.id));
      const result = await invoke('createChat', { projectId });
      const next = normalizeState(result);
      ui.chatId = next?.chats.find(c => !oldIds.has(c.id))?.id || result.chatId || null;
      applyState(result);
      chat = currentChat();
    } catch (error) { showError(error); return; }
  }
  if (!chat) return toast('Kunne ikke opprette samtalen.', true);
  const chatId = chat.id;
  const message = ui.chatDraft.trim();
  const allowedIds = new Set(state.items.filter(item => item.projectId === chat.projectId).map(item => item.id));
  const sourceIds = [...ui.sourceIds].filter(sourceId => allowedIds.has(sourceId));
  ui.chatBusy = true; ui.pendingMessage = message; ui.chatDraft = ''; ui.stream = ''; renderMain();
  try {
    const response = await invoke('chat', { chatId, message, sourceIds });
    ui.chatBusy = false; ui.pendingMessage = ''; ui.stream = '';
    applyState(response.state || response);
  } catch (error) {
    ui.chatBusy = false; ui.pendingMessage = ''; ui.stream = ''; ui.chatDraft = message;
    showError(error);
    if (ui.view === 'chat') renderMain();
  }
}

function settingsHead(iconName, title, subtitle) {
  return el('div', { class: 'settings-card-head' }, el('span', { class: 'settings-icon' }, icon(iconName, 16)), el('div', {}, el('h3', {}, title), el('p', { class: 'card-subtitle' }, subtitle)));
}
function renderSettings() {
  const page = el('div', { class: 'page' }, pageHeading('', 'Innstillinger', ''));
  const left = el('div', { class: 'settings-column' });
  const right = el('div', { class: 'settings-column' });
  left.append(renderAiSettings(), renderSyncSettings());
  right.append(renderProfileSettings(), renderIntegrationSettings(), renderDataSettings());
  page.append(el('div', { class: 'settings-layout' }, left, right));
  return page;
}
function renderProfileSettings() {
  const panel = el('section', { class: 'panel settings-card' }, settingsHead('profile', 'Profil', 'Forfatternavn på notater.'));
  const input = el('input', { id: 'profile-name-input', value: state.user.name || '', placeholder: 'Navnet ditt', required: true, maxlength: 80, autocomplete: 'given-name' });
  const form = el('form', { onsubmit: async event => { event.preventDefault(); const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; try { const next = await invoke('saveProfile', { name: input.value.trim() }); clearSettingsDraft('profile-name-input'); applyState(next); toast('Profilen er lagret.'); } catch (error) { showError(error); } finally { if (submit.isConnected) submit.disabled = false; } } }, field('Navn', input), el('button', { class: 'button button-secondary', type: 'submit' }, 'Lagre profil'));
  panel.append(form); return panel;
}
function renderAiSettings() {
  const settings = ui.settings || { provider: 'chatgpt', model: '', baseUrl: 'http://127.0.0.1:11434', chatgpt: {} };
  const panel = el('section', { class: 'panel settings-card' }, settingsHead('sparkle', 'KI', 'Egen tilgang for hver elev.'));
  const form = el('form');
  const provider = settings.provider || 'chatgpt';
  form.append(el('div', { class: 'settings-provider-options' }, el('label', { class: 'provider-option' }, el('input', { type: 'radio', name: 'provider', value: 'chatgpt', checked: provider === 'chatgpt', onchange: () => switchProvider('chatgpt') }), el('span', {}, el('strong', {}, 'ChatGPT'), el('small', {}, 'Ditt abonnement og din kvote.'))), el('label', { class: 'provider-option' }, el('input', { type: 'radio', name: 'provider', value: 'ollama', checked: provider === 'ollama', onchange: () => switchProvider('ollama') }), el('span', {}, el('strong', {}, 'Ollama'), el('small', {}, 'Lokalt. Krever installert Ollama og modell.')))));
  if (provider === 'chatgpt') {
    const connected = settings.chatgpt?.connected;
    const available = !connected || settings.chatgpt?.enabled !== false;
    form.append(el('div', { class: 'connection-status' }, el('div', {}, el('strong', {}, connected ? 'Tilkoblet' : 'Ikke tilkoblet'), el('small', {}, connected ? settings.chatgpt.email || 'Eget abonnement' : available ? 'Innlogging åpnes i nettleseren.' : 'Ikke tilgjengelig i denne utgaven.')), btn(connected ? 'Koble fra' : 'Logg inn', event => connectAi(event, connected), 'button-secondary button-small', connected ? null : 'external')));
  }
  const model = el('input', { id: 'ai-model', value: settings.model || '', placeholder: provider === 'ollama' ? 'F.eks. qwen3:4b' : 'Velg en modell fra kontoen', list: 'ai-model-list', required: true, maxlength: 180 });
  const datalist = el('datalist', { id: 'ai-model-list' }, ui.models.map(m => el('option', { value: m.id }, m.name || m.id)));
  form.append(field('Modell', model, provider === 'chatgpt' ? 'Tilgjengelige modeller følger kontoen din.' : 'Modellen må være installert.'), datalist);
  let baseUrl;
  if (provider === 'ollama') {
    baseUrl = el('input', { id: 'ollama-url', type: 'url', value: settings.baseUrl || 'http://127.0.0.1:11434', placeholder: 'http://127.0.0.1:11434', required: true });
    form.append(field('Ollama-adresse', baseUrl));
  }
  const submit = el('button', { class: 'button', type: 'submit' }, 'Lagre KI-innstillinger');
  form.append(el('div', { class: 'settings-actions' }, submit, btn('Hent modelliste', async event => { const button = event.currentTarget; button.disabled = true; try { ui.settings = await invoke('updateAiSettings', { provider, model: model.value.trim(), ...(baseUrl ? { baseUrl: baseUrl.value.trim() } : {}) }); ui.models = await invoke('listModels'); renderMain(); toast(`${ui.models.length} modeller hentet.`); } catch (error) { showError(error); } finally { if (button.isConnected) button.disabled = false; } }, 'button-secondary', 'refresh')));
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try { ui.settings = await invoke('updateAiSettings', { provider, model: model.value.trim(), ...(baseUrl ? { baseUrl: baseUrl.value.trim() } : {}) }); clearSettingsDraft('ai-model', 'ollama-url'); renderMain(); toast('KI-innstillingene er lagret.'); } catch (error) { showError(error); submit.disabled = false; }
  });
  panel.append(form, el('p', { class: 'settings-privacy' }, 'Innlogging deles ikke med gruppen. Valgte kildeutdrag sendes til modellen.'));
  return panel;
}
async function switchProvider(provider) {
  try { ui.settings = await invoke('updateAiSettings', { provider }); clearSettingsDraft('ai-model', 'ollama-url'); ui.models = []; renderMain(); } catch (error) { showError(error); }
}
function rememberSettingsDraft(event) {
  const input = event.target;
  if (ui.view === 'settings' && input.id && input.matches('input:not([type="radio"]),textarea,select')) ui.settingsDrafts[input.id] = input.value;
}
function clearSettingsDraft(...fieldIds) { for (const fieldId of fieldIds) delete ui.settingsDrafts[fieldId]; }
async function connectAi(event, disconnect) {
  const button = event.currentTarget;
  button.disabled = true; button.textContent = disconnect ? 'Kobler fra …' : 'Venter på innlogging …';
  try {
    ui.settings = await invoke(disconnect ? 'disconnectChatGPT' : 'connectChatGPT');
    ui.models = [];
    if (ui.settings.chatgpt?.connected) { try { ui.models = await invoke('listModels'); } catch (error) { toast(error.message, true); } }
    renderMain(); toast(disconnect ? 'ChatGPT er koblet fra.' : 'ChatGPT er tilkoblet.');
    if (ui.settings.warning) toast(ui.settings.warning, true);
  } catch (error) { showError(error); if (button.isConnected) { button.disabled = false; button.textContent = disconnect ? 'Koble fra' : 'Logg inn'; } }
}
function renderSyncSettings() {
  const sync = ui.sync || state.sync || { mode: 'local' };
  const panel = el('section', { class: 'panel settings-card' }, settingsHead('users', 'Samarbeid', 'Lokalt nettverk · eksperimentelt.'));
  if (sync.mode === 'host') {
    panel.append(el('div', { class: 'connection-status' }, el('div', {}, el('strong', {}, 'Deling aktiv'), el('small', {}, projectTitle(sync.projectId))), el('span', { class: 'chip' }, 'VERT')), el('p', {}, 'Hold appen åpen. Del adressen og koden med gruppen.'), el('div', { class: 'sync-detail' }, el('strong', {}, 'Adresse'), (sync.urls || (sync.url ? [sync.url] : [])).map(url => el('code', { class: 'sync-url' }, url)), el('strong', {}, 'Invitasjonskode'), el('code', { class: 'sync-url' }, sync.inviteCode || 'Ikke tilgjengelig'), typeof sync.memberCount === 'number' ? el('span', { id: 'host-member-count' }, `${sync.memberCount} tilkoblet`) : null), btn('Stopp deling', async () => { try { ui.sync = await invoke('stopHosting'); applyState(await invoke('getState'), { force: true }); toast('Delingen er stoppet.'); } catch (error) { showError(error); } }, 'button-secondary'));
    return panel;
  }
  if (sync.mode === 'client') {
    const error = el('div', { id: 'sync-connection-error', class: 'error-inline' }, sync.error || '');
    error.hidden = !sync.error;
    panel.append(el('div', { class: 'connection-status' }, el('div', {}, el('strong', { id: 'client-sync-title' }, sync.error ? 'Forbindelsen er brutt' : 'Tilkoblet felles prosjekt'), el('small', {}, 'Egne prosjekter er beholdt.')), el('span', { class: 'chip' }, 'ELEV')), error, el('p', {}, 'Notater og flashcards synkroniseres mens du er tilkoblet.'), btn('Forlat gruppen', async () => { try { ui.sync = await invoke('leaveGroup'); editor = null; ui.itemId = null; ui.projectId = null; applyState(await invoke('getState'), { force: true }); toast('Ditt lokale arbeidsrom er åpnet igjen.'); } catch (error) { showError(error); } }, 'button-secondary'));
    return panel;
  }
  const selected = projectField(ui.projectId || state.projects[0]?.id, 'Del prosjekt');
  selected.input.id = 'share-project-choice';
  selected.wrapper.querySelector('label').htmlFor = selected.input.id;
  panel.append(selected.wrapper, btn('Start deling av prosjekt', async event => {
    if (!selected.input.value) return toast('Opprett et prosjekt først.', true);
    const button = event.currentTarget; button.disabled = true;
    try { ui.sync = await invoke('startHosting', { projectId: selected.input.value }); clearSettingsDraft('share-project-choice'); ui.projectId = selected.input.value; renderShell(); renderMain(); } catch (error) { showError(error); if (button.isConnected) button.disabled = false; }
  }, 'button-secondary', 'users', { disabled: !state.projects.length }), el('p', { class: 'form-help' }, 'Elevene må kunne nå denne PC-en på nettverket.'), el('div', { class: 'sync-divider' }, 'BLI MED'));
  const url = el('input', { id: 'group-url', type: 'url', placeholder: 'https://adresse:port …', required: true, spellcheck: false });
  const code = el('input', { id: 'group-code', placeholder: 'Koden du fikk av verten', required: true, autocomplete: 'off', spellcheck: false });
  const submit = el('button', { class: 'button button-secondary', type: 'submit' }, icon('link', 14), 'Bli med i prosjekt');
  const form = el('form', { onsubmit: async event => {
    event.preventDefault(); submit.disabled = true;
    try { ui.sync = await invoke('joinGroup', { url: url.value.trim(), inviteCode: code.value.trim() }); clearSettingsDraft('group-url', 'group-code', 'share-project-choice'); editor = null; ui.itemId = null; ui.projectId = null; applyState(await invoke('getState'), { force: true }); toast('Du er tilkoblet prosjektet.'); } catch (error) { showError(error); submit.disabled = false; }
  } }, field('Adresse til verten', url), field('Invitasjonskode', code), submit);
  panel.append(form, el('div', { class: 'settings-note warning-note' }, 'Eksporter en sikkerhetskopi før dere deler viktige notater.'));
  return panel;
}
function renderIntegrationSettings() {
  return el('section', { class: 'panel settings-card' }, settingsHead('link', 'Tilkoblinger', ''), el('div', { class: 'integration-row' }, el('span', { class: 'integration-mark' }, 'N'), el('div', {}, el('h4', {}, 'OneNote'), el('p', {}, 'Velg sider fra OneNote installert på din Windows-bruker.'), btn('Hent fra OneNote', oneNoteModal, 'button-secondary button-small', 'import'), el('span', { class: 'chip' }, 'KUN LESING'))), el('div', { class: 'integration-row' }, el('span', { class: 'integration-mark' }, icon('settings', 15)), el('div', {}, el('h4', {}, 'Remote Desktop Commander'), el('p', {}, 'Ikke aktivert. Krever installasjon og paring på hver PC.'))), el('div', { class: 'integration-row' }, el('span', { class: 'integration-mark' }, icon('search', 15)), el('div', {}, el('h4', {}, 'Research'), el('p', {}, 'Wikipedia · Crossref · PubMed. Krever nettverk.'))));
}
function renderDataSettings() {
  return el('section', { class: 'panel settings-card' }, settingsHead('download', 'Prosjektfiler', 'Importer eller eksporter JSON.'), el('p', {}, 'Alt prosjektinnhold følger med, unntatt originalfiler og KI-innlogging.'), el('div', { class: 'settings-actions' }, btn('Eksporter prosjekt', () => withProject(async projectId => { try { const result = await invoke('exportProject', { projectId }); if (!result.canceled) toast('Prosjektet er eksportert.'); } catch (error) { showError(error); } }, 'Velg prosjektet du vil eksportere'), 'button-secondary', 'download', { disabled: !state.projects.length }), btn('Importer prosjekt', async () => { try { const result = await invoke('importProject'); if (normalizeState(result)) { applyState(result); toast('Prosjektet er importert.'); } } catch (error) { showError(error); } }, 'button-secondary', 'upload', { disabled: (ui.sync || state.sync).mode === 'client' })), el('div', { class: 'settings-note' }, 'Eksport er en kopi. Senere endringer synkroniseres ikke.'));
}

function oneNoteModal() {
  withProject(projectId => openOneNoteModal(projectId), 'Hvor skal OneNote-sidene ligge?');
}
function openOneNoteModal(projectId) {
  const selected = new Set();
  let query = '', offset = 0, total = 0, busy = false;
  const container = el('div');
  const results = el('div', { class: 'onenote-page-list' });
  const status = el('p', { class: 'form-help' }, 'Sjekker OneNote på denne PC-en …');
  const searchInput = el('input', { id: 'onenote-search', placeholder: 'Søk i sidetittel eller notatbok …', 'aria-label': 'Søk i OneNote-sider', maxlength: 240 });
  const searchButton = el('button', { type: 'submit', class: 'button button-secondary button-small', disabled: true }, icon('search', 13), 'Søk');
  const search = el('form', { class: 'onenote-search', onsubmit: event => { event.preventDefault(); query = searchInput.value.trim(); loadPages(0); } }, searchInput, searchButton);
  const pageInfo = el('span', { class: 'tiny muted' });
  const previous = btn('Forrige', () => loadPages(Math.max(0, offset - 60)), 'button-secondary button-small', null, { disabled: true });
  const next = btn('Neste', () => loadPages(offset + 60), 'button-secondary button-small', null, { disabled: true });
  const pagination = el('div', { class: 'onenote-pagination' }, pageInfo, el('div', { class: 'settings-actions' }, previous, next));
  const selectedLabel = el('span', { class: 'tiny muted' }, 'Ingen sider valgt');
  const submit = btn('Importer valgte sider', async () => {
    if (!selected.size || busy) return;
    busy = true; submit.disabled = true; submit.textContent = 'Importerer sider …';
    try {
      const result = await invoke('importOneNotePages', { projectId, pageIds: [...selected] });
      closeModal(); applyState(result); toast(`${selected.size} OneNote-${selected.size === 1 ? 'side er' : 'sider er'} importert til Brain.`);
    } catch (error) { showError(error); busy = false; submit.disabled = false; submit.textContent = 'Importer valgte sider'; }
  }, '', 'import', { disabled: true });
  function updateCount() { selectedLabel.textContent = `${selected.size} ${selected.size === 1 ? 'side' : 'sider'} valgt`; submit.disabled = !selected.size || busy; }
  async function loadPages(newOffset) {
    if (busy || !container.isConnected) return;
    busy = true; searchButton.disabled = true; previous.disabled = true; next.disabled = true; submit.disabled = true;
    status.textContent = 'Henter sidelisten …';
    try {
      const data = await invoke('listOneNotePages', { query, offset: newOffset, limit: 60 });
      if (!container.isConnected) return;
      offset = data.offset ?? newOffset; total = data.total || 0;
      const pages = data.items || [];
      results.replaceChildren(...(pages.length ? pages.map(page => el('label', { class: 'onenote-page' }, el('input', { type: 'checkbox', checked: selected.has(page.id), onchange: event => { if (event.target.checked && selected.size >= 20) { event.target.checked = false; toast('Velg opptil 20 sider per import.'); return; } event.target.checked ? selected.add(page.id) : selected.delete(page.id); updateCount(); } }), el('span', {}, el('strong', {}, page.title || 'Side uten tittel'), el('small', {}, page.route || ''), page.modified ? el('small', { class: 'onenote-modified' }, `Endret ${dateText(page.modified)}`) : null))) : [empty('Ingen sider funnet.', query ? 'Prøv et annet søkeord. Søket gjelder sidetittel og plassering.' : 'Åpne OneNote og sjekk at en notatbok er tilgjengelig.', null, 'book', 'compact')]));
      pageInfo.textContent = pages.length ? `${offset + 1}–${offset + pages.length} av ${total} sider` : '0 sider';
      previous.disabled = offset === 0;
      next.disabled = !(data.truncated || offset + pages.length < total);
      status.textContent = 'Velg opptil 20 sider. OneNote endres ikke.';
    } catch (error) { status.textContent = error.message || 'Kunne ikke hente OneNote-sider.'; results.replaceChildren(el('div', { class: 'error-inline' }, 'Åpne Windows-versjonen av OneNote, og prøv igjen. Word- og HTML-import er også tilgjengelig.')); }
    finally { busy = false; if (container.isConnected) { searchButton.disabled = false; updateCount(); } }
  }
  container.append(el('p', { class: 'linked-project-title' }, `Importer til ${projectTitle(projectId)}`), status, search, results, pagination, el('div', { class: 'modal-actions onenote-modal-actions' }, selectedLabel, btn('Avbryt', closeModal, 'button-secondary'), submit));
  openModal('OneNote', 'Bare valgte sider leses og kopieres til Brain.', container, 'modal-wide');
  (async () => {
    try {
      const doctor = await invoke('doctorOneNote');
      if (!container.isConnected) return;
      if (!doctor.available) {
        status.textContent = doctor.message || 'OneNote på Windows er ikke tilgjengelig på denne PC-en.';
        results.replaceChildren(el('div', { class: 'error-inline' }, 'Installer eller åpne desktop-versjonen av OneNote. Du kan også eksportere sider til Word eller HTML og bruke dokumentimport.'));
        return;
      }
      await loadPages(0);
    } catch (error) { if (container.isConnected) status.textContent = error.message || 'Kunne ikke undersøke OneNote.'; }
  })();
}

function field(label, input, help = null) {
  return el('div', { class: 'field' }, el('label', { for: input.id || null }, label), input, help ? el('small', {}, help) : null);
}
function projectField(initialId, label = 'Prosjekt') {
  const input = el('select', { id: `project-field-${id()}`, required: true }, !state.projects.length ? el('option', { value: '' }, 'Opprett et prosjekt først') : null, state.projects.map(project => el('option', { value: project.id }, project.title)));
  if (initialId) input.value = initialId;
  return { input, wrapper: field(label, input) };
}
function openModal(title, description, content, className = '') {
  closeModal();
  const previous = document.activeElement;
  const modal = el('section', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, el('div', { class: 'modal-head' }, el('h2', { id: 'modal-title' }, title), el('button', { class: 'icon-button', 'aria-label': 'Lukk dialog', onclick: closeModal }, icon('close', 16))), description ? el('p', { class: 'modal-description' }, description) : null, content);
  const backdrop = el('div', { class: 'modal-backdrop', onclick: event => { if (event.target === backdrop) closeModal(); } }, modal);
  document.getElementById('modal-root').replaceChildren(backdrop);
  modalEscape = event => {
    if (event.key === 'Escape') closeModal();
    if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  document.addEventListener('keydown', modalEscape);
  modal.dataset.previousFocus = previous?.id || '';
  modal.querySelector('input,textarea,select,button')?.focus();
}
function closeModal() {
  if (window.SammenSharing?.isBusy?.()) return;
  const previous = document.querySelector('.modal')?.dataset.previousFocus;
  document.getElementById('modal-root').replaceChildren();
  if (modalEscape) { document.removeEventListener('keydown', modalEscape); modalEscape = null; }
  if (previous) document.getElementById(previous)?.focus();
}
function confirmModal(title, description, label, handler, options = {}) {
  const actions = el('div', { class: 'modal-actions' }, btn('Avbryt', closeModal, 'button-secondary'), options.secondary ? btn(options.secondaryLabel || 'Lagre', async () => { closeModal(); await options.secondary(); }, 'button-secondary') : null, btn(label, () => { closeModal(); handler(); }, options.danger ? 'button-danger' : ''));
  openModal(title, description, actions);
}
function newProjectModal(callback = null, options = {}) {
  if (typeof callback !== 'function') callback = null;
  if ((ui.sync || state.sync).mode === 'client') return toast('Forlat gruppen for å åpne dine egne prosjekter.', true);
  const title = el('input', { id: 'new-project-title', required: true, maxlength: 120, placeholder: 'F.eks. Politikk og menneskerettigheter' });
  const description = el('textarea', { id: 'new-project-description', maxlength: 1200, placeholder: 'Hva skal dere undersøke eller lære?' });
  let color = 'green';
  const colorChoices = el('div', { class: 'color-choices', role: 'group', 'aria-label': 'Prosjektfarge' }, colors.map(value => el('button', { type: 'button', class: `color-choice${value === color ? ' active' : ''}`, 'data-color': value, 'aria-label': ({ green: 'Grønn', blue: 'Blå', pink: 'Rosa', yellow: 'Gul', purple: 'Lilla' })[value], 'aria-pressed': value === color, onclick: event => { color = value; for (const button of colorChoices.children) { button.classList.toggle('active', button.dataset.color === value); button.setAttribute('aria-pressed', String(button.dataset.color === value)); } } }, '✓')));
  const submit = el('button', { type: 'submit', class: 'button' }, icon('add', 14), 'Opprett prosjekt');
  const form = el('form', { onsubmit: async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      const oldIds = new Set(state.projects.map(project => project.id));
      const result = await invoke('saveProject', { title: title.value.trim(), description: description.value.trim(), color: colorHex[color] });
      const next = normalizeState(result);
      const projectId = next?.projects.find(project => !oldIds.has(project.id))?.id;
      closeModal();
      if (options.fromBrain) {
        ui.projectId = null; ui.itemId = null; ui.brainMode = 'graph';
        ui.brainFilter = 'all'; ui.brainQuery = '';
        if (ui.brainCamera) delete ui.brainCamera[JSON.stringify(['*', 'all', ''])];
      } else if (projectId) ui.projectId = projectId;
      if (!callback) ui.view = 'brain';
      applyState(result);
      toast('Prosjektet er opprettet.');
      if (callback && projectId) callback(projectId);
    } catch (error) { showError(error); submit.disabled = false; }
  } }, field('Prosjektnavn', title), field('En kort beskrivelse', description), el('div', { class: 'field' }, el('label', {}, 'Prosjektfarge'), colorChoices), el('div', { class: 'modal-actions' }, btn('Avbryt', closeModal, 'button-secondary'), submit));
  openModal(options.fromBrain ? 'Nytt prosjekt' : 'Gi kunnskapen et eget rom.', options.fromBrain ? null : 'Et prosjekt kan være et fag, en oppgave eller et spørsmål dere vil utforske.', form);
  title.focus();
}
function withProject(callback, title = 'Velg et prosjekt') {
  if (ui.projectId && state.projects.some(project => project.id === ui.projectId)) return callback(ui.projectId);
  if (state.projects.length === 1) return callback(state.projects[0].id);
  if (!state.projects.length) return newProjectModal(callback);
  const project = projectField(state.projects[0].id);
  const form = el('form', { onsubmit: event => { event.preventDefault(); const projectId = project.input.value; closeModal(); callback(projectId); } }, project.wrapper, el('div', { class: 'modal-actions' }, btn('Avbryt', closeModal, 'button-secondary'), el('button', { type: 'submit', class: 'button' }, 'Fortsett')));
  openModal(title, 'Innholdet blir samlet i prosjektet du velger.', form);
}
function newItem(type = 'note') {
  if (editor?.dirty) return confirmModal('Lagre endringene først?', 'Du har et ulagret notat åpent.', 'Forkast og opprett', () => { editor = null; newItem(type); }, { secondaryLabel: 'Lagre og opprett', secondary: async () => { if (await saveEditor()) { editor = null; newItem(type); } } });
  withProject(async projectId => {
    try {
      const oldIds = new Set(state.items.map(item => item.id));
      const title = type === 'mindmap' ? 'Nytt tankekart' : 'Nytt notat';
      const item = { projectId, type, title, content: '', origin: 'human', status: 'draft', ...(type === 'mindmap' ? { mindmap: { nodes: [{ id: id(), text: 'Hovedidé', parentId: null }] } } : {}) };
      const result = await invoke('saveItem', item);
      const next = normalizeState(result);
      ui.itemId = next?.items.find(nextItem => !oldIds.has(nextItem.id))?.id || null;
      ui.projectId = projectId; ui.brainFilter = 'all'; ui.brainQuery = ''; ui.view = 'brain'; ui.brainMode = 'graph'; editor = null;
      applyState(result);
      Array.from(document.querySelectorAll('.brain-graph-node')).find(node => node.dataset.itemId === ui.itemId)?.focus();
    } catch (error) { showError(error); }
  }, type === 'mindmap' ? 'Prosjekt for tankekartet' : 'Prosjekt for notatet');
}
function importDocuments() {
  withProject(async projectId => {
    try { const before = state.items.length; const result = await invoke('importDocuments', { projectId }); const next = normalizeState(result); if (next) { applyState(result); if (next.items.length > before) toast('Dokumentet er lagt i Brain.'); } } catch (error) { showError(error); }
  }, 'Hvor skal dokumentet ligge?');
}
function importChooser() {
  if (window.SammenSharing?.isBusy?.()) return;
  const options = el('div', { class: 'new-item-menu' },
    el('button', { type: 'button', class: 'new-item-option', onclick: () => { closeModal(); importDocuments(); } }, icon('file', 24), el('h3', {}, 'Dokumenter'), el('p', {}, 'Word, tekst, Markdown eller HTML.')),
    el('button', { type: 'button', class: 'new-item-option', onclick: () => { closeModal(); oneNoteModal(); } }, icon('book', 24), el('h3', {}, 'OneNote'), el('p', {}, 'Velg sider fra OneNote på denne PC-en.'))
  );
  openModal('Importer', '', options);
}
function profileModal() {
  if (window.SammenSharing?.isBusy?.()) return;
  const name = el('input', { id: 'profile-display-name', required: true, maxlength: 80, value: state.user.name || '', autocomplete: 'given-name' });
  const submit = el('button', { type: 'submit', class: 'button button-secondary' }, 'Lagre navn');
  const form = el('form', { onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      applyState(await invoke('saveProfile', { name: name.value.trim() }));
      if (form.isConnected) closeModal();
      toast('Navnet er lagret.');
    } catch (error) { showError(error); }
    finally { if (submit.isConnected) submit.disabled = false; }
  } }, field('Navnet ditt', name), el('div', { class: 'modal-actions' }, submit));
  const device = el('div', { class: 'profile-device-action' }, btn('Denne PC-en', () => window.SammenDeviceSetup?.open?.(), 'button-secondary', 'link'), el('p', { class: 'form-help' }, 'Koble din AI til filer og programmer på denne PC-en.'));
  const updates = el('div', { class: 'profile-device-action' }, btn('Oppdateringer', () => window.SammenUpdates?.open?.(), 'button-secondary', 'refresh'));
  openModal('Profil', '', el('div', {}, form, device, updates));
  name.focus();
}

async function initialize() {
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); go('overview', null); });
  document.getElementById('sidebar-add-project').addEventListener('click', () => newProjectModal());
  document.getElementById('global-import').addEventListener('click', importChooser);
  document.getElementById('global-sharing').addEventListener('click', () => window.SammenSharing?.open());
  const profile = document.getElementById('profile-button');
  profile.setAttribute('role', 'button');
  profile.setAttribute('tabindex', '0');
  profile.setAttribute('aria-haspopup', 'dialog');
  profile.addEventListener('click', profileModal);
  profile.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); profileModal(); } });
  document.getElementById('project-select').addEventListener('change', event => go(ui.view, event.target.value || null));
  document.getElementById('main-content').addEventListener('input', rememberSettingsDraft);
  document.getElementById('main-content').addEventListener('change', rememberSettingsDraft);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && ui.view === 'brain' && editor) { event.preventDefault(); saveEditor(); }
  });
  if (!api) {
    document.getElementById('main-content').replaceChildren(el('div', { class: 'offline-page' }, el('h1', {}, 'Åpne Sammen som desktop-app.'), el('p', {}, 'Dette grensesnittet bruker appens lokale lagring og sikre tilkoblinger. Start Sammen gjennom Windows-installasjonen eller utviklingskommandoen for å bruke funksjonene.')));
    renderShell(); return;
  }
  try {
    const initial = await invoke('getState');
    applyState(initial);
    window.SammenLiveFile?.init?.();
    if (typeof api.onState === 'function') api.onState(value => applyState(value));
    if (typeof api.onChatDelta === 'function') api.onChatDelta(payload => {
      if (!ui.chatBusy || payload.chatId !== ui.chatId) return;
      ui.stream += payload.delta || '';
      const content = document.getElementById('streaming-content');
      if (content) content.textContent = ui.stream;
      const messages = document.getElementById('chat-messages');
      if (messages && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 180) messages.scrollTop = messages.scrollHeight;
    });
    const results = await Promise.allSettled([invoke('getSyncStatus'), invoke('getIntegrationInfo')]);
    if (results[0].status === 'fulfilled') ui.sync = results[0].value;
    if (results[1].status === 'fulfilled') ui.integrations = results[1].value;
    renderShell(); if (!editor?.dirty) renderMain();
    if (typeof api.getStartupOptions === 'function') {
      const options = await invoke('getStartupOptions');
      if (options?.showDeviceSetup && window.SammenDeviceSetup) {
        await window.SammenDeviceSetup.open();
        await invoke('acknowledgeDeviceSetup');
      }
    }
  } catch (error) {
    showError(error);
    document.getElementById('main-content').replaceChildren(el('div', { class: 'offline-page' }, el('h1', {}, 'Arbeidsrommet kunne ikke åpnes.'), el('p', {}, error.message), btn('Prøv igjen', initialize, 'button-secondary', 'refresh')));
  }
}
initialize();
