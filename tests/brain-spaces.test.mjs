import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, mutateStore } from '../src/store.mjs';
import { createBrainSpaces } from '../src/brain-spaces.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sammen-brain-spaces-'));
  const filename = path.join(directory, 'brain.sqlite');
  const baseStore = new Store(filename);
  const spaces = createBrainSpaces({ baseStore, directory, ...options });
  t.after(async () => { await spaces.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, filename, baseStore, spaces };
}
function addContent(spaces, title) {
  const store = spaces.store;
  const project = store.snapshot().projects[0] || store.saveProject({ title });
  const note = store.saveItem({ projectId: project.id, title, content: title });
  const map = store.saveItem({ projectId: project.id, title: `${title} kart`, type: 'mindmap', mindmap: { nodes: [{ id: 'root', parentId: null, text: title }] } });
  store.saveCard({ projectId: project.id, question: title, answer: title, sourceIds: [note.id] });
  const chat = store.createChat({ projectId: project.id });
  store.appendMessage({ chatId: chat.id, message: { role: 'user', content: title } });
  store.setMeta(`original:${note.id}`, { storedName: 'private-original.docx' });
  return { project, note, map, chat };
}

test('new Brains are empty and personal Brain retains the existing SQLite records', async t => {
  const { spaces, baseStore } = fixture(t);
  const content = addContent(spaces, 'Personlig');
  assert.equal(spaces.state().brainSpace.activeId, 'personal');
  const publicState = await spaces.switchBrain({ id: 'public' });
  for (const collection of ['projects', 'items', 'flashcards', 'chats']) assert.equal(publicState[collection].length, 0);
  assert.equal(spaces.store.getMeta(`original:${content.note.id}`), null);
  assert.equal(baseStore.get('item', content.note.id).content, 'Personlig');
  await spaces.switchBrain({ id: 'personal' });
  assert.equal(spaces.state().items.length, 2);
  assert.equal(spaces.store.get('item', content.map.id).type, 'mindmap');
});

test('projects, notes, maps, cards, chat and originals remain isolated across each Brain', async t => {
  const { spaces } = fixture(t);
  const personal = addContent(spaces, 'Bare meg');
  await spaces.switchBrain({ id: 'public' });
  const publicContent = addContent(spaces, 'Offentlig innhold');
  const groupState = await spaces.createBrain({ name: 'Kollokvie' });
  const groupId = groupState.brainSpace.activeId;
  assert.notEqual(groupId, 'personal');
  assert.notEqual(groupId, 'public');
  assert.equal(groupState.projects.length, 0);
  const group = addContent(spaces, 'Invitert gruppe');
  for (const [id, own, hidden] of [
    ['personal', personal, [publicContent, group]],
    ['public', publicContent, [personal, group]],
    [groupId, group, [personal, publicContent]]
  ]) {
    const state = await spaces.switchBrain({ id });
    assert.equal(state.projects.length, 1);
    assert.equal(state.items.length, 2);
    assert.equal(state.flashcards.length, 1);
    assert.equal(state.chats.length, 1);
    assert.equal(state.items[0].id, own.note.id);
    for (const other of hidden) {
      assert.equal(spaces.store.get('item', other.note.id), null);
      assert.equal(spaces.store.getMeta(`original:${other.note.id}`), null);
      assert.throws(() => spaces.store.saveItem({ ...other.note, projectId: other.project.id }), /finnes ikke/);
      assert.throws(() => spaces.store.exportProject(other.project.id), /finnes ikke/);
    }
  }
});

test('catalog selection and all Brain contents survive a fresh service instance', async t => {
  const { directory, filename, spaces } = fixture(t);
  const personal = addContent(spaces, 'Lagret privat');
  const groupState = await spaces.createBrain({ name: 'Prosjektgjengen' });
  const groupId = groupState.brainSpace.activeId;
  const group = addContent(spaces, 'Lagret gruppe');
  await spaces.close();
  const reopened = createBrainSpaces({ baseStore: new Store(filename), directory });
  try {
    assert.equal(reopened.state().brainSpace.activeId, groupId);
    assert.equal(reopened.state().items[0].id, group.note.id);
    assert.equal(reopened.catalog().brains.find(brain => brain.id === groupId).name, 'Prosjektgjengen');
    await reopened.switchBrain({ id: 'personal' });
    assert.equal(reopened.state().items[0].id, personal.note.id);
    assert.equal(reopened.state().projects.length, 1);
  } finally { await reopened.close(); }
});

test('profile identity is shared across Brains and persisted without copying personal records', async t => {
  const { spaces, baseStore } = fixture(t);
  const avatar = { style: 'owl', color: 'peach' };
  await spaces.store.saveProfile({ name: 'Hugo', avatar });
  const userId = spaces.state().user.id;
  const group = await spaces.createBrain({ name: 'Faggruppe' });
  assert.deepEqual(group.user, { id: userId, name: 'Hugo', avatar });
  await spaces.store.saveProfile({ name: 'Nytt navn' });
  assert.deepEqual(baseStore.getMeta('user'), { id: userId, name: 'Nytt navn', avatar });
  const personal = await spaces.switchBrain({ id: 'personal' });
  assert.equal(personal.user.name, 'Nytt navn');
  const publicState = await spaces.switchBrain({ id: 'public' });
  assert.equal(publicState.user.id, userId);
  assert.equal(publicState.user.name, 'Nytt navn');
  assert.equal(publicState.projects.length, 0);
});

test('invalid names, visibility and Brain IDs leave the active Brain unchanged', async t => {
  const { spaces } = fixture(t);
  const before = spaces.state();
  for (const id of ['missing', '../brain.sqlite', 'PUBLIC', null]) await assert.rejects(spaces.switchBrain({ id }), /finnes ikke/);
  for (const name of ['', ' ', 'x'.repeat(81), null]) await assert.rejects(spaces.createBrain({ name }), /navn/);
  await assert.rejects(spaces.createBrain({ name: 'Ugyldig', visibility: 'public' }), /inviterte/);
  assert.deepEqual(spaces.state(), before);
});

function fakeSyncFactory(contexts) {
  return ({ store, onChange, onCollaboration }) => {
    const context = { store, onChange, onCollaboration, closedFiles: [], leaves: 0, stops: 0, shutdowns: 0, pauses: 0, resumes: 0,
      connection: { mode: 'local', members: [], memberCount: 1 },
      status() { return this.connection; },
      state() { return { ...store.snapshot(), sync: this.status() }; },
      async mutate(operation, input) { const result = mutateStore(store, operation, input); onChange(); return result; },
      async openSharedFile({ id }) { return { id }; },
      async closeSharedFile({ id }) { this.closedFiles.push(id); },
      async leaveGroup() { this.leaves++; },
      async stopHosting() { this.stops++; },
      async pause() { this.pauses++; },
      async resume() { this.resumes++; },
      async shutdown() { this.shutdowns++; }
    };
    contexts.push(context);
    return context;
  };
}

test('switch closes active file handles while preserving background sessions and hiding their events', async t => {
  const contexts = [], states = [], files = [];
  const { spaces } = fixture(t, { createSync: fakeSyncFactory(contexts), onChange: state => states.push(state), onCollaboration: value => files.push(value) });
  await spaces.sync.openSharedFile({ id: 'edited-note' });
  contexts[0].connection = { mode: 'host', projectId: 'host-project', inviteCode: 'PRIVATE-INVITE', urls: ['https://private.example'], memberCount: 2, transport: 'local' };
  await spaces.switchBrain({ id: 'public' });
  assert.deepEqual(contexts[0].closedFiles, ['edited-note']);
  assert.equal(contexts[0].leaves, 0);
  assert.equal(contexts[0].stops, 0);
  assert.equal(contexts[0].shutdowns, 0);
  const notifications = states.length;
  contexts[0].onChange(); contexts[0].onCollaboration({ item: { id: 'private' } });
  assert.equal(states.length, notifications);
  assert.equal(files.length, 0);
  contexts[1].onChange(); contexts[1].onCollaboration({ item: { id: 'public' } });
  assert.equal(states.length, notifications + 1);
  assert.equal(files[0].item.id, 'public');
  const state = spaces.state();
  assert.equal(state.brainSpace.activeId, 'public');
  assert.equal(state.brainSpace.brains.find(brain => brain.id === 'personal').connection.connected, true);
  assert.equal(JSON.stringify(state).includes('PRIVATE-INVITE'), false);
  assert.equal(JSON.stringify(state).includes('https://private.example'), false);
  await spaces.close();
  assert.ok(contexts.every(context => context.shutdowns === 1));
  assert.ok(contexts.every(context => context.leaves === 0));
});

test('switch waits for an in-flight mutation before selecting the next store', async t => {
  const contexts = [];
  const { spaces } = fixture(t, { createSync: fakeSyncFactory(contexts) });
  let complete;
  contexts[0].mutate = () => new Promise(resolve => { complete = resolve; });
  const mutation = spaces.sync.mutate('saveProject', { title: 'Lagrer' });
  let switched = false;
  const switching = spaces.switchBrain({ id: 'public' }).then(state => { switched = true; return state; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(switched, false);
  assert.equal(spaces.state().brainSpace.activeId, 'personal');
  assert.throws(() => spaces.sync.mutate('saveProject', { title: 'Racer' }), /Vent/);
  complete({ id: 'saved' }); await mutation;
  assert.equal((await switching).brainSpace.activeId, 'public');
});

test('file-close failure keeps selection and catalog unchanged for a safe retry', async t => {
  const contexts = [];
  const { spaces, baseStore } = fixture(t, { createSync: fakeSyncFactory(contexts) });
  await spaces.sync.openSharedFile({ id: 'pending' });
  contexts[0].closeSharedFile = async () => { throw new Error('Kan ikke lagre nå'); };
  await assert.rejects(spaces.switchBrain({ id: 'public' }), /Kan ikke lagre/);
  assert.equal(spaces.state().brainSpace.activeId, 'personal');
  assert.equal(baseStore.getMeta('brainSpaces:v1').activeId, 'personal');
  contexts[0].closeSharedFile = async () => {};
  assert.equal((await spaces.switchBrain({ id: 'public' })).brainSpace.activeId, 'public');
});

test('catalog contains no invitation credentials and the public Brain starts disconnected', async t => {
  const { spaces, baseStore } = fixture(t);
  spaces.store.setMeta('sync:client', { token: 'session-secret', inviteCode: 'invite-secret' });
  const group = await spaces.createBrain({ name: 'Kun venner', inviteCode: 'untrusted-secret', members: ['private-address@example.org'] });
  const record = group.brainSpace.brains.find(brain => brain.id === group.brainSpace.activeId);
  assert.equal(record.visibility, 'invited');
  assert.equal(record.isPersonal, false);
  assert.equal(record.isPublic, false);
  const catalogText = JSON.stringify(baseStore.getMeta('brainSpaces:v1'));
  for (const secret of ['session-secret', 'invite-secret', 'untrusted-secret', 'private-address@example.org']) assert.equal(catalogText.includes(secret), false);
  assert.equal(spaces.store.getMeta('sync:client'), null);
  const publicState = await spaces.switchBrain({ id: 'public' });
  const publicBrain = publicState.brainSpace.brains.find(brain => brain.isPublic);
  assert.deepEqual(publicBrain.connection, { mode: 'local', connected: false, transport: null, memberCount: 0 });
  assert.equal(JSON.stringify(publicState).includes('session-secret'), false);
});

test('Store can intentionally stay empty across restarts without changing the personal default', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sammen-empty-store-'));
  const filename = path.join(directory, 'empty.sqlite');
  let store = new Store(filename, { seedDefaultProject: false });
  assert.equal(store.snapshot().projects.length, 0); store.close();
  store = new Store(filename, { seedDefaultProject: false });
  assert.equal(store.snapshot().projects.length, 0); store.close();
  store = new Store(); assert.equal(store.snapshot().projects.length, 1); store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('pausing all Brain contexts preserves usable stores for a failed updater restart', async t => {
  const contexts = [], states = [];
  const { spaces } = fixture(t, { createSync: fakeSyncFactory(contexts), onChange: state => states.push(state) });
  addContent(spaces, 'Personlig lagring');
  await spaces.switchBrain({ id: 'public' });
  const publicContent = addContent(spaces, 'Offentlig lagring');
  await spaces.sync.openSharedFile({ id: publicContent.note.id });
  await spaces.pause();
  assert.ok(contexts.every(context => context.pauses === 1));
  assert.deepEqual(contexts[1].closedFiles, [publicContent.note.id]);
  assert.ok(contexts.every(context => context.shutdowns === 0 && context.leaves === 0));
  assert.equal(spaces.state().items[0].id, publicContent.note.id);
  assert.equal(spaces.store.get('item', publicContent.note.id).content, 'Offentlig lagring');
  assert.throws(() => spaces.store.saveProject({ title: 'Under oppdatering' }), /Vent/);
  assert.throws(() => spaces.sync.mutate('saveProject', { title: 'Under oppdatering' }), /Vent/);
  await assert.rejects(spaces.switchBrain({ id: 'personal' }), /Vent/);
  const count = states.length; contexts[1].onChange(); assert.equal(states.length, count);
  await spaces.resume();
  assert.ok(contexts.every(context => context.resumes === 1));
  await spaces.sync.mutate('saveProject', { title: 'Etter oppdateringsfeil' });
  assert.equal(spaces.state().projects.length, 2);
  assert.equal((await spaces.switchBrain({ id: 'personal' })).items[0].title, 'Personlig lagring');
});
