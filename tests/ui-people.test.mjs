import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AVATAR_STYLES, AVATAR_COLORS, avatarForId } from '../src/people.mjs';

const source = await readFile(new URL('../src/ui/people.js', import.meta.url), 'utf8');
function fixture() {
  const browser = {};
  const snapshot = { user: { id: 'me', name: 'Vilma', avatar: { style: 'fox', color: 'peach' } }, items: [], sync: { mode: 'local' }, brainSpace: { activeId: 'personal', brains: [{ id: 'personal', name: 'Min Brain', isPersonal: true }] } };
  const ui = {};
  const document = { activeElement: null };
  class Node {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.children = []; this.events = {}; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    append(...children) { this.children.push(...children.flat(Infinity).filter(child => child !== null && child !== undefined)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => child instanceof Node ? [...(selector === '[role="radio"]' && child.getAttribute('role') === 'radio' ? [child] : []), ...child.querySelectorAll(selector)] : []);
    }
    focus() { document.activeElement = this; }
  }
  document.createElementNS = (_namespace, tag) => new Node(tag);
  const element = (tag, attrs = {}, ...children) => {
    const node = new Node(tag);
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('on')) node.events[key.slice(2)] = value; else node.setAttribute(key, value);
    node.append(...children);
    return node;
  };
  Function('window', 'state', 'ui', 'document', 'el', source)(browser, snapshot, ui, document, element);
  return { api: browser.SammenPeople, state: snapshot, ui, document };
}

test('avatar fallback agrees with the stored profile model for stable IDs', () => {
  const { api } = fixture();
  assert.deepEqual(api.styles, [...AVATAR_STYLES]);
  assert.deepEqual(api.colors, [...AVATAR_COLORS]);
  for (const id of ['', 'me', 'other-user', '9be1f4f0-d417-45ab-8a74-75e4388460da', 'elev-æøå-🐸']) assert.deepEqual(api.avatarForId(id), avatarForId(id));
});

test('contributors use current names and avatars by ID while preserving contribution dates', () => {
  const { api, state } = fixture();
  state.brainSpace.brains[0].members = [{ id: 'other', name: 'Sigurd', avatar: { style: 'frog', color: 'mint' } }];
  const item = { contributors: [{ id: 'other', name: 'Old name', avatar: { style: 'bear', color: 'sky' }, firstContributedAt: '2026-10-01T10:00:00.000Z', lastContributedAt: '2026-10-02T10:00:00.000Z' }, { id: 'me', name: 'Older Vilma' }] };
  const people = api.contributorPeople(item);
  assert.equal(people[0].name, 'Sigurd');
  assert.deepEqual(people[0].avatar, { style: 'frog', color: 'mint' });
  assert.equal(people[0].firstContributedAt, item.contributors[0].firstContributedAt);
  assert.equal(people[0].lastContributedAt, item.contributors[0].lastContributedAt);
  assert.equal(people[1].name, 'Vilma');
  assert.deepEqual(people[1].avatar, state.user.avatar);
});

test('legacy authors remain unidentified even when their name matches the current user', () => {
  const { api } = fixture();
  const old = api.contributorPeople({ author: 'Vilma', contributors: [] });
  assert.equal(old.length, 1);
  assert.equal(old[0].id, null);
  assert.equal(old[0].legacy, true);
  assert.equal(old[0].label, 'Vilma · eldre oppføring');
  const edited = api.contributorPeople({ author: 'Vilma', legacyAuthor: 'Vilma', contributors: [{ id: 'me', name: 'Vilma' }] });
  assert.equal(edited.length, 2);
  assert.equal(edited[0].id, 'me');
  assert.equal(edited[1].id, null);
});

test('AI files do not fabricate human contributors but later human contributions are shown', () => {
  const { api } = fixture();
  assert.deepEqual(api.contributorPeople({ origin: 'ai', author: 'KI', contributors: [] }), []);
  assert.deepEqual(api.contributorPeople({ type: 'ai', author: 'Vilma' }), []);
  assert.deepEqual(api.contributorPeople({ author: 'KI' }), []);
  assert.equal(api.contributorPeople({ origin: 'ai', author: 'KI', contributors: [{ id: 'me', name: 'Vilma' }] })[0].id, 'me');
});

test('membership survives loss of presence and duplicate sessions count as one person', () => {
  const { api, state, ui } = fixture();
  const brain = { id: 'group', name: 'Gruppen', members: [{ id: 'me', name: 'Vilma' }, { id: 'other', name: 'Sigurd' }] };
  state.brainSpace = { activeId: 'group', brains: [brain] };
  ui.sync = { mode: 'client', connected: true, roster: brain.members, members: [{ id: 'session-1', userId: 'other', name: 'Sigurd' }, { id: 'session-2', userId: 'other', name: 'Sigurd' }] };
  const connected = api.memberPeople(brain);
  assert.equal(connected.length, 2);
  assert.equal(connected.find(person => person.id === 'me').isYou, true);
  assert.equal(connected.find(person => person.id === 'other').online, true);
  ui.sync.connected = false;
  const offline = api.memberPeople(brain);
  assert.equal(offline.length, 2);
  assert.ok(offline.every(person => !person.online));
});

test('inactive Brain presence comes only from its live catalog and personal Brain stays private', () => {
  const { api, state, ui } = fixture();
  const group = { id: 'group', members: [{ id: 'other', name: 'Sigurd' }], connection: { mode: 'client', connected: true }, onlineMembers: [] };
  ui.sync = { mode: 'client', members: [{ userId: 'other', id: 'session', name: 'Sigurd' }] };
  assert.equal(api.memberPeople(group)[0].online, false);
  group.onlineMembers = [{ userId: 'other', id: 'session', name: 'Sigurd' }];
  assert.equal(api.memberPeople(group)[0].online, true);
  const personal = api.memberPeople(state.brainSpace.brains[0]);
  assert.equal(personal.length, 1);
  assert.equal(personal[0].id, 'me');
  assert.equal(personal[0].localHere, true);
});

test('avatars are standalone accessible SVGs with decorative support and distinct figures', () => {
  const { api } = fixture();
  const renderings = [];
  for (const style of AVATAR_STYLES) {
    const avatar = api.avatar({ name: '<Vilma>', avatar: { style, color: 'lilac' } }, { size: 20 });
    assert.equal(avatar.tagName, 'svg');
    assert.equal(avatar.getAttribute('viewBox'), '0 0 40 40');
    assert.equal(avatar.getAttribute('width'), '20');
    assert.equal(avatar.getAttribute('role'), 'img');
    assert.equal(avatar.children[0].tagName, 'title');
    assert.equal(avatar.children[0].children[0], '<Vilma> · eldre oppføring');
    renderings.push(JSON.stringify(avatar.children.at(-1)));
  }
  assert.equal(new Set(renderings).size, AVATAR_STYLES.length);
  const decorative = api.avatar({ id: 'me', name: 'Vilma' }, { decorative: true });
  assert.equal(decorative.getAttribute('aria-hidden'), 'true');
  assert.equal(decorative.getAttribute('role'), null);
});

test('avatar picker supports arrow keys and reports only the selected profile values', () => {
  const { api, state, document } = fixture();
  const changes = [];
  const picker = api.picker({ ...state.user, avatar: { style: 'cat', color: 'lilac' } }, value => changes.push(value));
  const cat = picker.querySelectorAll('[role="radio"]').find(node => node.getAttribute('aria-label') === 'Katt');
  let prevented = false;
  cat.events.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(changes.at(-1), { style: 'fox', color: 'lilac' });
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Rev');
  const lilac = picker.querySelectorAll('[role="radio"]').find(node => node.getAttribute('aria-label') === 'Syrin');
  lilac.events.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(changes.at(-1), { style: 'fox', color: 'butter' });
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Vanilje');
});
