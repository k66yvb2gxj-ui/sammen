import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, mutateStore } from '../src/store.mjs';
import { createBrainSpaces } from '../src/brain-spaces.mjs';
import { createBrainCommands } from '../src/brain-commands.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sammen-brain-commands-'));
  const baseStore = new Store(path.join(directory, 'brain.sqlite'));
  const contexts = [];
  const behavior = { groupError: null, publicError: null };
  const spaces = createBrainSpaces({ baseStore, directory, createSync: ({ store, onChange }) => {
    const context = {
      store, connection: { mode: 'local', memberCount: 1 }, groupCalls: [], publicCalls: [], hostCalls: [], internetCalls: [],
      status() { return this.connection; },
      state() { return { ...store.snapshot(), sync: this.status() }; },
      async mutate(operation, input) { const result = mutateStore(store, operation, input); onChange(); return result; },
      async closeSharedFile() {},
      async joinGroup(input) {
        this.groupCalls.push(input);
        if (behavior.groupError) throw behavior.groupError;
        this.connection = { mode: 'client', isPublic: false, scope: 'brain', connected: true, memberCount: 2, transport: 'internet' };
      },
      async joinPublicBrain(input) {
        this.publicCalls.push(input);
        if (behavior.publicError) throw behavior.publicError;
        if (!input.url) throw new Error('Offentlig server er ikke konfigurert.');
        this.connection = { mode: 'client', isPublic: true, scope: 'brain', connected: true, memberCount: 3, transport: 'internet' };
      },
      async startHosting(input) { this.hostCalls.push(input); return { mode: 'host', ...input }; },
      async startInternetRoom(input) { this.internetCalls.push(input); return { mode: 'client', ...input }; },
      async shutdown() {}
    };
    contexts.push(context);
    return context;
  } });
  const changes = [];
  const commands = createBrainCommands({ spaces, onChange: state => changes.push(state), ...options });
  t.after(async () => { await spaces.close(); rmSync(directory, { recursive: true, force: true }); });
  return { spaces, commands, baseStore, contexts, behavior, changes };
}

test('Brain transition waits for scoped asynchronous work and rejects new work until complete', async t => {
  const cancelled = [];
  const { spaces, commands } = fixture(t, { cancelActive: async () => { cancelled.push(true); } });
  const projectId = spaces.state().projects[0].id;
  const started = deferred(), finish = deferred();
  const operation = commands.runScoped(async () => {
    started.resolve(); await finish.promise;
    return spaces.sync.mutate('saveItem', { projectId, title: 'Sen privat lagring', content: 'Bare i Min Brain' });
  }, { write: true });
  await started.promise;
  const switching = commands.switchBrain({ id: 'public' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.isBusy(), true);
  assert.equal(cancelled.length, 1);
  assert.equal(commands.state().brainSpace.activeId, 'personal');
  const visibleState = commands.state(); visibleState.projects[0].title = 'Mutert klientkopi';
  assert.notEqual(commands.state().projects[0].title, 'Mutert klientkopi');
  let newWorkRan = false;
  await assert.rejects(commands.runScoped(() => { newWorkRan = true; }), /Vent/);
  await assert.rejects(commands.createBrain({ name: 'Samtidig' }), /Vent/);
  assert.equal(newWorkRan, false);
  finish.resolve(); const saved = await operation;
  const publicState = await switching;
  assert.equal(publicState.brainSpace.activeId, 'public');
  assert.equal(publicState.items.length, 0);
  await commands.switchBrain({ id: 'personal' });
  assert.equal(commands.state().items[0].id, saved.id);
  assert.equal(commands.isBusy(), false);
});

test('a failed pending operation does not strand a switch or run its writes in another Brain', async t => {
  const { commands } = fixture(t);
  const finish = deferred();
  const operation = commands.runScoped(async () => { await finish.promise; throw new Error('Import feilet'); });
  const rejected = assert.rejects(operation, /Import feilet/);
  const switching = commands.switchBrain({ id: 'public' });
  finish.resolve(); await rejected;
  assert.equal((await switching).brainSpace.activeId, 'public');
  assert.equal(commands.isBusy(), false);
});

test('public Brain content cannot be written until a public session has actually joined', async t => {
  const { commands, spaces, contexts } = fixture(t, { publicUrl: () => 'https://brain.example.org' });
  await commands.switchBrain({ id: 'public' });
  let called = false;
  await assert.rejects(commands.runScoped(() => { called = true; return spaces.sync.mutate('saveProject', { title: 'For tidlig' }); }, { write: true }), /Koble til/);
  assert.equal(called, false);
  assert.equal(commands.state().projects.length, 0);
  assert.equal(await commands.runScoped(() => 'Lesing'), 'Lesing');
  // A joined invitation-only room does not count as the public service.
  contexts[1].connection = { mode: 'client', connected: true, isPublic: false };
  await assert.rejects(commands.runScoped(() => {}, { write: true }), /Koble til/);
  contexts[1].connection = { mode: 'local' };
  const connected = await commands.connectPublicBrain();
  assert.equal(connected.brainSpace.activeId, 'public');
  assert.deepEqual(contexts[1].publicCalls, [{ url: 'https://brain.example.org' }]);
  const project = await commands.runScoped(() => spaces.sync.mutate('saveProject', { title: 'Offentlig prosjekt' }), { write: true });
  assert.equal(project.title, 'Offentlig prosjekt');
  // Reopening an already joined public Brain avoids an unnecessary second join.
  await commands.switchBrain({ id: 'personal' });
  assert.equal((await commands.connectPublicBrain()).projects[0].id, project.id);
  assert.equal(contexts[1].publicCalls.length, 1);
});

test('failed public connection restores personal selection and retains its exact records and catalog', async t => {
  const { commands, spaces, baseStore, behavior } = fixture(t);
  const projectId = spaces.state().projects[0].id;
  await commands.runScoped(() => spaces.sync.mutate('saveItem', { projectId, title: 'Privat notat', content: 'Privat tekst' }), { write: true });
  const before = baseStore.snapshot();
  const catalog = spaces.catalog();
  behavior.publicError = new Error('Serveren er utilgjengelig');
  await assert.rejects(commands.connectPublicBrain({ url: 'https://offline.example.org' }), /utilgjengelig/);
  assert.equal(commands.state().brainSpace.activeId, 'personal');
  assert.deepEqual(baseStore.snapshot(), before);
  assert.deepEqual(spaces.catalog(), catalog);
  assert.equal(commands.isBusy(), false);
  await commands.switchBrain({ id: 'public' });
  assert.equal(commands.state().items.length, 0);
  assert.equal(commands.state().projects.length, 0);
});

test('createBrain selects a separate empty workspace with invitation-only visibility', async t => {
  const { commands, spaces, baseStore } = fixture(t);
  const projectId = spaces.state().projects[0].id;
  const note = spaces.store.saveItem({ projectId, title: 'Mitt notat', content: 'Min tekst' });
  const created = await commands.createBrain({ name: 'Sigurd og Vilma' });
  const id = created.brainSpace.activeId;
  assert.notEqual(id, 'personal'); assert.notEqual(id, 'public');
  assert.equal(created.brainSpace.brains.find(brain => brain.id === id).visibility, 'invited');
  assert.equal(created.projects.length, 0); assert.equal(created.items.length, 0);
  const sharedProject = await commands.runScoped(() => spaces.sync.mutate('saveProject', { title: 'Gruppens prosjekt' }), { write: true });
  assert.equal(baseStore.get('project', sharedProject.id), null);
  assert.equal(baseStore.get('item', note.id).content, 'Min tekst');
});

test('whole-Brain hosting and internet creation refuse personal and public workspaces', async t => {
  const { commands, contexts } = fixture(t);
  const input = { url: 'https://rooms.example.org', createKey: 'secret-create-key' };
  for (const id of ['personal', 'public']) {
    await commands.switchBrain({ id });
    await assert.rejects(commands.startBrainHosting(), /inviterte/);
    await assert.rejects(commands.startInternetBrain(input), /inviterte/);
  }
  assert.ok(contexts.every(context => !context.hostCalls.length && !context.internetCalls.length));
  await commands.createBrain({ name: 'Inviterte' });
  const context = contexts.at(-1);
  await commands.startBrainHosting();
  assert.deepEqual(context.hostCalls, [{ scope: 'brain' }]);
  await commands.startInternetBrain(input);
  assert.deepEqual(context.internetCalls, [{ ...input, scope: 'brain' }]);
});

test('failed invitation joining keeps old personal content, catalog entries and private metadata', async t => {
  const { commands, spaces, baseStore, behavior, changes } = fixture(t);
  const projectId = spaces.state().projects[0].id;
  const note = spaces.store.saveItem({ projectId, title: 'Ikke del', content: 'Min hemmelige tekst' });
  spaces.store.setMeta(`original:${note.id}`, { name: 'Privat.docx' });
  const before = baseStore.snapshot();
  const originalEntries = spaces.catalog().brains;
  behavior.groupError = new Error('Invitasjonen er utløpt');
  await assert.rejects(commands.joinBrain({ name: 'Felles historie', url: 'https://rooms.example.org/rooms/a', inviteCode: 'secret-invite' }), /utløpt/);
  assert.equal(commands.state().brainSpace.activeId, 'personal');
  assert.deepEqual(baseStore.snapshot(), before);
  for (const original of originalEntries) assert.deepEqual(spaces.catalog().brains.find(brain => brain.id === original.id), original);
  const emptyGroup = spaces.catalog().brains.find(brain => brain.visibility === 'invited');
  assert.equal(emptyGroup.name, 'Felles historie');
  await commands.switchBrain({ id: emptyGroup.id });
  assert.equal(commands.state().items.length, 0);
  assert.equal(spaces.store.getMeta(`original:${note.id}`), null);
  assert.equal(JSON.stringify(spaces.catalog()).includes('secret-invite'), false);
  assert.ok(changes.length > 0);
});

test('successful invitation joining uses a new isolated Brain and passes only the selected credentials', async t => {
  const { commands, spaces, contexts, baseStore } = fixture(t);
  const projectId = spaces.state().projects[0].id;
  spaces.store.saveItem({ projectId, title: 'Privat', content: 'Hjemme' });
  const input = { name: 'Naturfag', url: 'https://rooms.example.org/rooms/naturfag', inviteCode: 'invitation-code' };
  const joined = await commands.joinBrain(input);
  assert.equal(joined.brainSpace.brains.find(brain => brain.id === joined.brainSpace.activeId).name, 'Naturfag');
  assert.deepEqual(contexts.at(-1).groupCalls, [{ url: input.url, inviteCode: input.inviteCode }]);
  assert.equal(contexts.at(-1).store.snapshot().items.length, 0);
  assert.equal(baseStore.snapshot().items[0].title, 'Privat');
  assert.equal(joined.sync.isPublic, false);
});
