import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, mutateStore } from '../src/store.mjs';
import { AVATAR_STYLES, AVATAR_COLORS, avatarForId, normalizeAvatar, normalizePerson, validateContributors } from '../src/people.mjs';

const alice = { id: 'alice-id', name: 'Alice', avatar: { style: 'cat', color: 'lilac' } };
const bob = { id: 'bob-id', name: 'Bob', avatar: { style: 'frog', color: 'mint' } };
const dated = (person = alice, first = '2025-01-01T10:00:00.000Z', last = first) => ({ ...person, firstContributedAt: first, lastContributedAt: last });
function fixture(t) {
  const store = new Store();
  t.after(() => store.close());
  return { store, projectId: store.snapshot().projects[0].id };
}

test('avatar choices are bounded presets and defaults are stable for the same user ID', () => {
  assert.equal(AVATAR_STYLES.length, 8); assert.equal(new Set(AVATAR_STYLES).size, 8);
  assert.equal(AVATAR_COLORS.length, 6); assert.equal(new Set(AVATAR_COLORS).size, 6);
  const styles = new Set(), colors = new Set();
  for (let index = 0; index < 100; index++) {
    const id = `student-${index}`;
    const avatar = avatarForId(id);
    assert.deepEqual(avatarForId(id), avatar);
    assert.ok(AVATAR_STYLES.includes(avatar.style)); assert.ok(AVATAR_COLORS.includes(avatar.color));
    styles.add(avatar.style); colors.add(avatar.color);
  }
  assert.equal(styles.size, 8); assert.equal(colors.size, 6);
  assert.deepEqual(normalizeAvatar(undefined, alice.id), avatarForId(alice.id));
  assert.deepEqual(normalizeAvatar({ ...bob.avatar, imageUrl: 'https://untrusted.example/a.svg' }), bob.avatar);
  for (const avatar of [null, 'cat', { style: 'custom', color: 'mint' }, { style: 'cat', color: 'red' }, { style: 'https://example.org/a.svg', color: 'sky' }]) assert.throws(() => normalizeAvatar(avatar), /profilikon/);
});

test('person normalization uses a stable user ID instead of a connection session ID', () => {
  const person = normalizePerson({ id: 'temporary-session', userId: alice.id, name: ' Alice ', email: 'secret@example.org' });
  assert.deepEqual(person, { id: alice.id, name: alice.name, avatar: avatarForId(alice.id) });
  assert.deepEqual(normalizePerson({ name: 'No ID' }, { fallback: bob }), bob);
  for (const value of [null, {}, { id: '', name: 'A' }, { id: 'id', name: '' }, { id: 'x'.repeat(101), name: 'A' }, { id: 'id', name: 'A'.repeat(81) }]) assert.throws(() => normalizePerson(value), /brukerprofil/);
});

test('profile updates preserve the original ID and let name and avatar change independently', t => {
  const { store } = fixture(t);
  const original = store.getMeta('user');
  assert.deepEqual(original.avatar, avatarForId(original.id));
  store.saveProfile({ id: 'forged-id', name: 'Hugo' });
  assert.deepEqual(store.getMeta('user'), { ...original, name: 'Hugo' });
  store.saveProfile({ avatar: bob.avatar });
  assert.deepEqual(store.getMeta('user'), { id: original.id, name: 'Hugo', avatar: bob.avatar });
  const before = store.getMeta('user');
  for (const input of [{ name: ' ' }, { avatar: { style: 'custom', color: 'mint' } }, { avatar: null }]) assert.throws(() => store.saveProfile(input));
  assert.deepEqual(store.getMeta('user'), before);
});

test('legacy profile migration retains identity and persists its deterministic icon', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sammen-people-'));
  const filename = path.join(directory, 'brain.sqlite');
  let store = new Store(filename);
  store.setMeta('user', { id: 'legacy-user-id', name: 'Eldre profil' }); store.close();
  store = new Store(filename);
  const migrated = store.getMeta('user');
  assert.deepEqual(migrated, { id: 'legacy-user-id', name: 'Eldre profil', avatar: avatarForId('legacy-user-id') });
  store.close(); store = new Store(filename);
  assert.deepEqual(store.getMeta('user'), migrated); store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('new human notes record only the trusted actor and ignore supplied contributor histories', t => {
  const { store, projectId } = fixture(t);
  const note = store.saveItem({ projectId, title: 'Et bidrag', content: '', author: 'Forged', contributors: [dated(bob)] }, alice);
  assert.equal(note.author, 'Alice');
  assert.equal(note.contributors.length, 1);
  assert.deepEqual(note.contributors[0], { ...alice, firstContributedAt: note.createdAt, lastContributedAt: note.updatedAt });
  const local = store.saveItem({ projectId, title: 'Lokal bruker', contributors: 'malformed untrusted field' });
  assert.equal(local.contributors[0].id, store.getMeta('user').id);
  assert.equal(local.author, store.getMeta('user').name);
});

test('real changes add contributors by ID and rename an existing contributor without duplicates', t => {
  const { store, projectId } = fixture(t);
  const note = store.saveItem({ projectId, title: 'Samarbeid', content: 'Første' }, alice);
  note.contributors = [dated(alice)]; store.put('item', note);
  const next = store.saveItem({ ...note, content: 'To bidrag' }, bob.name, bob);
  assert.deepEqual(next.contributors.map(person => person.id), [alice.id, bob.id]);
  const renamed = { ...alice, name: 'Alice nytt navn', avatar: { style: 'owl', color: 'sky' } };
  const final = store.saveItem({ ...next, title: 'Ny tittel' }, renamed);
  assert.equal(final.author, renamed.name);
  assert.equal(final.contributors.length, 2);
  const history = final.contributors.find(person => person.id === alice.id);
  assert.equal(history.name, renamed.name); assert.deepEqual(history.avatar, renamed.avatar);
  assert.equal(history.firstContributedAt, '2025-01-01T10:00:00.000Z');
  assert.ok(history.lastContributedAt > history.firstContributedAt);
  const sameName = store.saveItem({ ...final, content: 'En annen Alice' }, { ...bob, name: renamed.name });
  assert.equal(sameName.contributors.length, 2);
  assert.notEqual(sameName.contributors[0].id, sameName.contributors[1].id);
});

test('opening, exporting and no-op saves do not add authors or alter history, revision or timestamps', t => {
  const { store, projectId } = fixture(t);
  const note = store.saveItem({ projectId, title: 'Uendret', content: 'Samme tekst' }, alice);
  store.snapshot(); store.get('item', note.id); store.exportProject(projectId);
  const unchanged = store.saveItem({ ...note, contributors: [dated(bob)] }, bob);
  assert.deepEqual(unchanged, note);
  assert.deepEqual(store.get('item', note.id), note);
});

test('citation, review and mindmap changes count, while object key ordering does not', t => {
  const { store, projectId } = fixture(t);
  const note = store.saveItem({ projectId, title: 'Kilder', content: 'Tekst' }, alice);
  const cited = store.saveItem({ ...note, citations: [{ id: 'K1', title: 'Kilde', url: 'https://example.org', excerpt: '' }] }, bob);
  assert.equal(cited.contributors.length, 2);
  const reviewed = store.saveItem({ ...cited, status: 'reviewed' }, alice);
  assert.equal(reviewed.revision, cited.revision + 1);
  const map = store.saveItem({ projectId, type: 'mindmap', title: 'Kart', mindmap: { nodes: [{ id: 'root', text: 'Ide', parentId: null, x: 0, y: 0 }] } }, alice);
  const unchanged = store.saveItem({ ...map, mindmap: { nodes: [{ y: 0, parentId: null, text: 'Ide', x: 0, id: 'root' }] } }, bob);
  assert.deepEqual(unchanged, map);
  const canonicalMap = store.saveItem({ ...map, mindmap: { ...map.mindmap, relations: [] } }, bob);
  assert.deepEqual(canonicalMap, map);
  const moved = store.saveItem({ ...map, mindmap: { nodes: [{ ...map.mindmap.nodes[0], x: 20 }] } }, bob);
  assert.equal(moved.contributors.length, 2);
});

test('normalizing absent legacy empty fields is not an attributed file change', t => {
  const { store, projectId } = fixture(t);
  const original = store.saveItem({ projectId, title: 'Eldre standardverdier', citations: [{ id: 'K1', title: 'Kilde' }] }, alice);
  const legacy = { ...original, citations: [{ id: 'K1', title: 'Kilde' }] };
  for (const field of ['content', 'status', 'sourceUrl', 'sourceName']) delete legacy[field];
  store.put('item', legacy);
  assert.deepEqual(store.saveItem(legacy, bob), legacy);
  assert.equal(store.get('item', original.id).contributors.length, 1);
});

test('legacy name-only authors remain name-only and newly observed edits never invent an old identity', t => {
  const { store, projectId } = fixture(t);
  const legacy = store.saveItem({ projectId, title: 'Eldre fil', content: 'Historisk tekst' }, 'Eldre elev');
  assert.equal(legacy.author, 'Eldre elev'); assert.deepEqual(legacy.contributors, []);
  const noHistory = { ...legacy }; delete noHistory.contributors; store.put('item', noHistory);
  assert.deepEqual(store.saveItem(noHistory, bob), noHistory);
  const updated = store.saveItem({ ...noHistory, content: 'Ny faktisk endring' }, bob);
  assert.deepEqual(updated.contributors.map(person => person.id), [bob.id]);
  assert.equal(updated.legacyAuthor, 'Eldre elev');
  const again = store.saveItem({ ...updated, content: 'Enda en endring', legacyAuthor: 'Forged' }, alice);
  assert.equal(again.legacyAuthor, 'Eldre elev');
});

test('AI generation records no pupil as its writer and later human editing is credited separately', t => {
  const { store, projectId } = fixture(t);
  const generated = store.saveItem({ projectId, type: 'ai', origin: 'ai', title: 'KI-utkast', content: 'Generert tekst', contributors: [dated(alice)] }, bob.name, bob);
  assert.equal(generated.author, 'KI'); assert.deepEqual(generated.contributors, []);
  assert.deepEqual(store.saveItem(generated, alice), generated);
  const edited = store.saveItem({ ...generated, content: 'Generert tekst med min rettelse' }, alice);
  assert.equal(edited.origin, 'ai'); assert.equal(edited.author, 'Alice');
  assert.deepEqual(edited.contributors.map(person => person.id), [alice.id]);
});

test('mutateStore attributes files and chat names from the trusted actor rather than supplied metadata', t => {
  const { store, projectId } = fixture(t);
  const note = mutateStore(store, 'saveItem', { projectId, title: 'Serverlagring', author: 'Forged', contributors: [dated(alice)] }, { author: 'Annet navn', actor: bob });
  assert.equal(note.author, bob.name); assert.equal(note.contributors[0].id, bob.id);
  const chat = store.createChat({ projectId });
  const saved = mutateStore(store, 'appendMessage', { chatId: chat.id, message: { role: 'user', content: 'Hei', author: 'Forged' } }, { actor: bob });
  assert.equal(saved.messages[0].author, bob.name);
});

test('contributor import validation deduplicates by ID, preserves earliest/latest times and rejects invalid dates', () => {
  const history = validateContributors([
    dated(alice, '2025-01-01T10:00:00Z', '2025-01-02T10:00:00Z'),
    dated({ ...alice, name: 'Alice nytt navn', avatar: bob.avatar }, '2025-01-02T10:00:00Z', '2025-01-03T10:00:00Z')
  ]);
  assert.deepEqual(history, [dated({ ...alice, name: 'Alice nytt navn', avatar: bob.avatar }, '2025-01-01T10:00:00.000Z', '2025-01-03T10:00:00.000Z')]);
  for (const input of [null, {}, Array(501).fill(dated()), [{ ...dated(), id: '' }], [{ ...dated(), firstContributedAt: '2025-02-30T00:00:00Z' }], [{ ...dated(), firstContributedAt: '2025-01-01T24:00:00Z' }], [{ ...dated(), lastContributedAt: 'not a date' }], [dated(alice, '2025-02-01T00:00:00Z', '2025-01-01T00:00:00Z')]]) assert.throws(() => validateContributors(input));
});

test('project round trips retain original people, contributor history and timestamps without crediting the importer', t => {
  const { store, projectId } = fixture(t);
  const original = store.saveItem({ projectId, title: 'Original', content: 'Alice skrev dette' }, alice);
  const edited = store.saveItem({ ...original, content: 'Bob rettet dette' }, bob);
  const exported = store.exportProject(projectId);
  store.saveProfile({ name: 'Importøren', avatar: { style: 'robot', color: 'peach' } });
  const imported = store.importProject(exported);
  const copy = store.snapshot(imported.id).items[0];
  assert.notEqual(copy.id, edited.id);
  assert.equal(copy.author, bob.name);
  assert.deepEqual(copy.contributors, edited.contributors);
  assert.equal(copy.createdAt, edited.createdAt); assert.equal(copy.updatedAt, edited.updatedAt);
  assert.equal(copy.contributors.some(person => person.id === store.getMeta('user').id), false);
  const legacy = { ...edited, author: 'Eldre forfatter' }; delete legacy.contributors;
  const legacyCopy = store.importProject({ ...exported, items: [legacy] });
  assert.equal(store.snapshot(legacyCopy.id).items[0].author, legacy.author);
  assert.deepEqual(store.snapshot(legacyCopy.id).items[0].contributors, []);
  const known = store.saveItem({ ...store.snapshot(legacyCopy.id).items[0], content: 'Første kjente endring' }, bob);
  const historical = store.importProject(store.exportProject(legacyCopy.id));
  assert.equal(store.snapshot(historical.id).items[0].legacyAuthor, known.legacyAuthor);
});

test('invalid imported contributor history rolls back every project record atomically', t => {
  const { store, projectId } = fixture(t);
  store.saveItem({ projectId, title: 'Eksisterende', content: 'Behold meg' }, alice);
  const exported = store.exportProject(projectId);
  const before = store.snapshot();
  assert.throws(() => store.importProject({ ...exported, items: [...exported.items, { ...exported.items[0], id: 'bad-import', contributors: [{ ...dated(), avatar: { style: 'external-url', color: 'mint' } }] }] }), /profilikon/);
  assert.deepEqual(store.snapshot(), before);
});
