import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/ui/admin.js', import.meta.url), 'utf8');
const disconnected = (extra = {}) => ({ status: { configured: false, connected: false, url: '', remembered: false, canRemember: true, ...extra }, overview: null, activity: null });
const connected = () => ({ status: { configured: true, connected: true, url: 'https://school.example', remembered: false, canRemember: true, checkedAt: '2026-10-16T14:20:00.000Z' }, overview: { version: 1, counts: { brains: 1, users: 1, projects: 2, files: 3 }, users: [{ id: 'user-1', name: 'Vilma', avatar: { style: 'cat', color: 'lilac' }, brainIds: ['brain-1'], lastSeen: '2026-10-16T14:20:00.000Z' }], brains: [{ id: 'brain-1', name: 'Historiegruppen', visibility: 'invited', projectCount: 2, fileCount: 3, memberCount: 1, members: [{ id: 'user-1', name: 'Vilma' }] }] }, activity: { version: 1, events: [{ id: 'event-1', type: 'file.updated', at: '2026-10-16T14:20:00.000Z', brainId: 'brain-1', actor: { id: 'user-1', name: 'Vilma' }, target: { id: 'file-1', title: 'Historienotat', content: 'PRIVATE-CONTENT-NOT-FOR-ADMIN' } }] } });

function fixture({ sandbox = false, handlers = {} } = {}) {
  const observers = new Set(), calls = [];
  const document = { activeElement: null };
  class Node {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.children = []; this.events = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    append(...children) {
      for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        if (child instanceof Node) {
          if (child.parent) child.parent.children = child.parent.children.filter(value => value !== child);
          child.parent = this;
        }
        this.children.push(child);
      }
    }
    replaceChildren(...children) { for (const child of this.children) if (child instanceof Node) child.parent = null; this.children = []; this.append(...children); }
    get isConnected() { return this === modalRoot || Boolean(this.parent?.isConnected); }
    get textContent() { return this.children.map(child => child instanceof Node ? child.hidden ? '' : child.textContent : String(child)).join(' '); }
    set textContent(value) { this.replaceChildren(String(value)); }
    focus() { document.activeElement = this; }
  }
  const modalRoot = new Node('div'); modalRoot.id = 'modal-root';
  const all = (node = modalRoot) => [node, ...node.children.flatMap(child => child instanceof Node ? all(child) : [])];
  document.body = { classList: { contains: name => name === 'sandbox' && sandbox } };
  document.getElementById = id => all().find(node => node.id === id) || null;
  const el = (tag, attrs = {}, ...children) => {
    const node = new Node(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (key.startsWith('on')) node.events[key.slice(2).toLowerCase()] = value;
      else if (['value', 'checked', 'disabled', 'hidden'].includes(key)) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children); return node;
  };
  const btn = (label, handler, className = '', image = null, attrs = {}) => el('button', { type: 'button', class: className, onclick: handler, ...attrs }, image ? el('svg') : null, label);
  const field = (label, input) => el('div', {}, el('label', { for: input.id }, label), input);
  const browser = {};
  class Observer { constructor(callback) { this.callback = callback; observers.add(this); } observe() {} disconnect() { observers.delete(this); } }
  const invoke = async (method, payload) => {
    calls.push({ method, payload: payload ? structuredClone(payload) : undefined });
    if (handlers[method]) return handlers[method](payload);
    if (method === 'getAdminState' || method === 'disconnectAdmin') return disconnected();
    throw new Error(`Unexpected method ${method}`);
  };
  Function('window', 'document', 'el', 'btn', 'field', 'icon', 'invoke', 'openModal', 'MutationObserver', source)(browser, document, el, btn, field, (name, size) => el('svg', { 'data-icon': name, width: size }), invoke, (_title, _description, content) => modalRoot.replaceChildren(content), Observer);
  return { admin: browser.SammenAdmin, calls, root: modalRoot, document, all,
    input(id) { return document.getElementById(id); },
    submit() { return all().find(node => node.tagName === 'form').events.submit({ preventDefault() {} }); },
    click(label) { const button = all().find(node => node.tagName === 'button' && node.textContent === label); assert.ok(button, `button ${label}`); return button.events.click(); },
    close() { modalRoot.replaceChildren(); for (const observer of [...observers]) observer.callback(); }
  };
}

test('admin starts locked with no fabricated server data and remembering is opt-in', async () => {
  const f = fixture(); await f.admin.open();
  assert.equal(f.input('admin-server-key').getAttribute('type'), 'password');
  assert.equal(f.input('admin-server-key').getAttribute('value'), null);
  assert.equal(f.input('admin-remember').checked, false);
  assert.equal(f.input('admin-remember').disabled, false);
  assert.equal(f.root.textContent.includes('Historiegruppen'), false);
  assert.equal(f.all().some(node => node.getAttribute('role') === 'tablist'), false);
});

test('desktop rejects insecure URLs and anything besides a server root address', async () => {
  const f = fixture(); await f.admin.open();
  f.input('admin-server-key').value = 'actual-admin-key';
  for (const url of ['http://127.0.0.1:9000', 'http://school.example', 'https://school.example/path', 'https://school.example?token=x', 'https://school.example/#token', 'https://user:password@school.example']) {
    f.input('admin-server-address').value = url; await f.submit();
  }
  assert.equal(f.calls.some(call => call.method === 'connectAdmin'), false);
  assert.equal(f.input('admin-server-key').value, 'actual-admin-key');
  assert.equal(f.root.textContent.includes('actual-admin-key'), false);
});

test('sandbox permits only explicit local HTTP tests and never remembers credentials', async () => {
  const f = fixture({ sandbox: true, handlers: { connectAdmin: () => connected() } }); await f.admin.open();
  assert.equal(f.input('admin-remember').disabled, true);
  f.input('admin-server-address').value = 'http://external.example'; f.input('admin-server-key').value = 'test-admin-key'; await f.submit();
  assert.equal(f.calls.some(call => call.method === 'connectAdmin'), false);
  f.input('admin-server-address').value = 'http://127.0.0.1:9000'; f.input('admin-remember').checked = true; await f.submit();
  const call = f.calls.find(call => call.method === 'connectAdmin');
  assert.equal(call.payload.url, 'http://127.0.0.1:9000');
  assert.equal(call.payload.remember, false);
});

test('failed authentication preserves input for retry without echoing a secret from errors', async () => {
  const secret = 'DO-NOT-RENDER-THIS-ADMIN-KEY';
  const f = fixture({ handlers: { connectAdmin: () => { throw new Error(`401 token ${secret}`); } } }); await f.admin.open();
  f.input('admin-server-address').value = 'https://school.example'; f.input('admin-server-key').value = secret; await f.submit();
  assert.equal(f.input('admin-server-key').value, secret);
  assert.equal(f.root.textContent.includes(secret), false);
  assert.equal(f.all().some(node => Object.values(node.attributes).some(value => value.includes(secret))), false);
  assert.match(f.root.textContent, /Kontroller adressen og adminnøkkelen/);
});

test('successful access clears the password and renders real metadata without file contents', async () => {
  const f = fixture({ handlers: { connectAdmin: () => connected() } }); await f.admin.open();
  f.input('admin-server-address').value = 'https://school.example'; const keyInput = f.input('admin-server-key'); keyInput.value = 'valid-admin-key'; await f.submit();
  assert.equal(keyInput.value, '');
  assert.equal(f.calls.find(call => call.method === 'connectAdmin').payload.remember, false);
  assert.equal(f.all().filter(node => node.getAttribute('role') === 'tab').length, 4);
  await f.click('Brukere'); assert.match(f.root.textContent, /Vilma/);
  await f.click('Brains'); assert.match(f.root.textContent, /Historiegruppen/);
  await f.click('Aktivitet'); assert.match(f.root.textContent, /Endret fil/); assert.match(f.root.textContent, /Historienotat/);
  assert.equal(f.root.textContent.includes('PRIVATE-CONTENT-NOT-FOR-ADMIN'), false);
});

test('a denied status response also preserves the password without opening the server panel', async () => {
  const f = fixture({ handlers: { connectAdmin: () => disconnected({ error: 'Access denied' }) } }); await f.admin.open();
  f.input('admin-server-address').value = 'https://school.example'; f.input('admin-server-key').value = 'retry-this-key'; await f.submit();
  assert.equal(f.input('admin-server-key').value, 'retry-this-key');
  assert.equal(f.all().some(node => node.getAttribute('role') === 'tablist'), false);
  assert.match(f.root.textContent, /Tilgangen kunne ikke bekreftes/);
});

test('OS encryption failure disables remembering while preserving the key for a memory-only retry', async () => {
  let statusReads = 0;
  const previous = connected(); previous.status.canRemember = false;
  const f = fixture({ handlers: {
    getAdminState: () => ++statusReads === 1 ? disconnected() : previous,
    connectAdmin: () => { throw new Error('OS encryption is unavailable'); }
  } });
  await f.admin.open();
  f.input('admin-server-address').value = 'https://school.example';
  f.input('admin-server-key').value = 'retry-this-secret';
  f.input('admin-remember').checked = true;
  await f.submit();
  assert.equal(f.input('admin-server-key').value, 'retry-this-secret');
  assert.equal(f.input('admin-remember').disabled, true);
  assert.equal(f.input('admin-remember').checked, false);
  assert.match(f.root.textContent, /Denne PC-en kan ikke huske adminnøkkelen/);
  assert.match(f.root.textContent, /Prøv igjen uten/);
  assert.equal(f.root.textContent.includes('retry-this-secret'), false);
  assert.equal(f.root.textContent.includes('Historiegruppen'), false);
  assert.equal(f.root.textContent.includes('Vilma'), false);
  assert.equal(f.all().some(node => node.getAttribute('role') === 'tablist'), false);
});

test('closing during authentication clears the field and ignores late UI responses', async () => {
  let finish;
  const f = fixture({ handlers: { connectAdmin: () => new Promise(resolve => { finish = resolve; }) } }); await f.admin.open();
  f.input('admin-server-address').value = 'https://school.example'; const keyInput = f.input('admin-server-key'); keyInput.value = 'secret-in-flight'; const pending = f.submit();
  assert.equal(f.admin.isBusy(), true);
  f.close(); assert.equal(keyInput.value, ''); assert.equal(f.admin.isBusy(), false);
  finish(connected()); await pending;
  assert.equal(f.root.textContent, '');
});

test('stored access is checked again and rejected access does not reveal cached metadata', async () => {
  const stale = connected(); stale.status.connected = false; stale.status.remembered = true;
  const f = fixture({ handlers: { getAdminState: () => stale, getAdminOverview: () => { throw Error('401 unauthorized'); }, getAdminActivity: () => { throw Error('401 unauthorized'); } } }); await f.admin.open();
  assert.equal(f.input('admin-server-key').value, '');
  assert.equal(f.input('admin-remember').checked, false);
  assert.equal(f.root.textContent.includes('Vilma'), false);
  assert.equal(f.root.textContent.includes('Historiegruppen'), false);
  assert.match(f.root.textContent, /Oversikten kunne ikke hentes/);
});

test('disconnect removes the server panel and returns to an unchecked connection form', async () => {
  const data = connected();
  const f = fixture({ handlers: { getAdminState: () => data, getAdminOverview: () => data.overview, getAdminActivity: () => data.activity, disconnectAdmin: () => disconnected() } }); await f.admin.open();
  assert.equal(f.all().filter(node => node.getAttribute('role') === 'tab').length, 4);
  await f.click('Koble fra');
  assert.equal(f.all().some(node => node.getAttribute('role') === 'tablist'), false);
  assert.equal(f.input('admin-remember').checked, false);
  assert.equal(f.input('admin-server-key').value, '');
});
