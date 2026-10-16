import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { avatarForId } from '../src/people.mjs';
import { createRoomHandler, createSyncService, transportRequest } from '../src/sync.mjs';
import { createModel } from '../src/collaboration-model.mjs';
import { createBrainSpaces } from '../src/brain-spaces.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-people-sync-'));
  const cert = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1, algorithm: 'sha256', extensions: [
    { name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }
  ] });
  const filename = join(directory, 'host.sqlite'), secret = randomBytes(32).toString('base64url');
  let store = new Store(filename), room = createRoomHandler({ store, scope: 'brain', secret, hostPresence: false });
  const server = createServer({ key: cert.private, cert: cert.cert }, (request, response) => { request.url = request.url.replace('/rooms/people', ''); room.handle(request, response); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `https://127.0.0.1:${server.address().port}/rooms/people`;
  const inviteCode = `S2.${Buffer.from(JSON.stringify({ version: 2, secret, url })).toString('base64url')}`;
  return { directory, url, inviteCode, secret, ca: cert.cert, get store() { return store; }, get room() { return room; },
    restart() { room.close(); store.close(); store = new Store(filename); room = createRoomHandler({ store, scope: 'brain', secret, hostPresence: false }); },
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); room.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test('verified HTTPS preserves distinct session actors and durable CRDT contributors even with identical names', async () => {
  const server = await fixture(), stores = [new Store(), new Store()];
  const [first, second] = stores.map(store => createSyncService({ store, ca: server.ca }));
  stores[0].saveProfile({ name: 'Sam', avatar: { style: 'fox', color: 'mint' } });
  stores[1].saveProfile({ name: 'Sam', avatar: { style: 'owl', color: 'sky' } });
  const firstPerson = stores[0].getMeta('user'), secondPerson = stores[1].getMeta('user');
  try {
    await first.joinGroup({ url: server.url, inviteCode: server.inviteCode });
    await second.joinGroup({ url: server.url, inviteCode: server.inviteCode });
    const projectId = first.state().projects[0].id;
    const forged = { id: 'not-a-member', name: 'Forged', avatar: { style: 'cat', color: 'rose' }, firstContributedAt: new Date().toISOString(), lastContributedAt: new Date().toISOString() };
    const note = await first.mutate('saveItem', { projectId, title: 'Samarbeid', content: 'Start.', author: 'Forged', contributors: [forged] });
    assert.deepEqual(note.contributors.map(person => person.id), [firstPerson.id]);
    assert.equal(note.author, 'Sam');
    const opened = await second.openSharedFile({ id: note.id }), model = createModel(opened), vector = model.vector();
    model.write({ ...opened.item, content: 'Start. Sam skrev mer.', contributors: [forged] });
    const edited = await second.updateSharedFile({ id: note.id, update: model.encode(vector), stateVector: model.vector(), contributors: [forged], author: 'Forged' });
    model.destroy();
    assert.deepEqual(edited.item.contributors.map(person => person.id).sort(), [firstPerson.id, secondPerson.id].sort());
    assert.deepEqual(edited.item.contributors.find(person => person.id === secondPerson.id).avatar, secondPerson.avatar);
    assert.equal(edited.item.contributors.some(person => person.id === forged.id), false);
    await first.refresh();
    assert.equal(first.status().roster.length, 2);
    assert.deepEqual(first.status().roster.map(person => person.name), ['Sam', 'Sam']);
    assert.equal(new Set(first.status().roster.map(person => person.id)).size, 2);
    assert.ok(first.status().roster.every(person => Date.parse(person.joinedAt) && Date.parse(person.lastSeen)));
    await second.leaveGroup(); await first.refresh();
    assert.equal(first.status().members.length, 1);
    assert.equal(first.status().roster.length, 2);
    await first.pause();
    assert.equal(server.room.status().members.length, 0);
    assert.equal(server.room.status().roster.length, 2);
    await first.refresh(); assert.equal(server.room.status().members.length, 1);
    await first.pause(); server.restart();
    assert.equal(server.room.status().members.length, 0);
    assert.equal(server.room.status().roster.length, 2);
    assert.equal(server.store.get('item', note.id).contributors.length, 2);
    await first.refresh();
    assert.equal(first.status().members.length, 1);
    assert.equal(first.status().roster.length, 2);
  } finally { await first.shutdown(); await second.shutdown(); for (const store of stores) store.close(); await server.close(); }
});

test('authenticated profile updates change avatar and name without accepting a replacement identity', async () => {
  const server = await fixture(), store = new Store(), sync = createSyncService({ store, ca: server.ca });
  const userId = store.getMeta('user').id;
  try {
    await sync.joinGroup({ url: server.url, inviteCode: server.inviteCode });
    store.saveProfile({ name: 'Nytt navn', avatar: { style: 'rabbit', color: 'peach' } });
    await sync.updateProfile();
    assert.equal(sync.status().roster[0].id, userId);
    assert.equal(sync.status().roster[0].name, 'Nytt navn');
    assert.deepEqual(sync.status().members[0].avatar, { style: 'rabbit', color: 'peach' });
    const connection = store.getMeta('sync:client').connection;
    const changed = await transportRequest(server.url, '/api/profile', { method: 'POST', token: connection.token, data: { userId: 'forged-id', id: 'forged-id', name: 'Declared name', avatar: { style: 'panda', color: 'butter' } }, ca: server.ca });
    assert.equal(changed.roster[0].id, userId);
    assert.equal(changed.roster.some(person => person.id === 'forged-id'), false);
    const note = await sync.mutate('saveItem', { projectId: sync.state().projects[0].id, title: 'Aktør', content: 'Sesjonen bestemmer' });
    assert.equal(note.contributors[0].id, userId);
    assert.equal(note.contributors[0].name, 'Declared name');
    assert.deepEqual(note.contributors[0].avatar, { style: 'panda', color: 'butter' });
  } finally { await sync.shutdown(); store.close(); await server.close(); }
});

test('legacy clients receive a deterministic avatar and durable membership survives session expiry', async () => {
  const server = await fixture();
  try {
    const joined = await transportRequest(server.url, '/api/join', { method: 'POST', data: { secret: server.secret, name: 'Eldre klient', userId: 'legacy-stable-id' }, ca: server.ca });
    assert.deepEqual(joined.roster[0].avatar, avatarForId('legacy-stable-id'));
    const saved = server.store.getMeta('room:sessions');
    for (const [, session] of saved.sessions) { session.lastSeen = Date.now() - 9 * 3600000; session.presenceSeen = session.lastSeen; }
    server.room.close();
    server.store.setMeta('room:sessions', saved);
    // Reopening the handler, without closing again, simulates persisted expired sessions.
    const isolated = createRoomHandler({ store: server.store, scope: 'brain', secret: server.secret, hostPresence: false });
    assert.equal(isolated.status().members.length, 0);
    assert.equal(isolated.status().roster.length, 1);
    isolated.close();
  } finally { await server.close(); }
});

test('project-room rosters remain separate when a store is reused for another shared project', () => {
  const store = new Store(), firstId = store.snapshot().projects[0].id, secondId = store.saveProject({ title: 'Annet' }).id;
  const first = createRoomHandler({ store, projectId: firstId, secret: 'first', hostPresence: false });
  first.join({ secret: 'first', name: 'Første deltaker', userId: 'first-user' }); first.close();
  const second = createRoomHandler({ store, projectId: secondId, secret: 'second', hostPresence: false });
  assert.deepEqual(second.status().roster, []);
  second.join({ secret: 'second', name: 'Andre deltaker', userId: 'second-user' }); second.close();
  const resumed = createRoomHandler({ store, projectId: firstId, secret: 'rotated', hostPresence: false });
  assert.deepEqual(resumed.status().roster.map(person => person.id), ['first-user']);
  resumed.close(); store.close();
});

test('catalog caches sanitized inactive Brain members without reconnecting them and updates every open profile session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-people-catalog-')), filename = join(directory, 'personal.sqlite');
  let contexts = [], baseStore = new Store(filename), spaces;
  const factory = options => {
    const context = { options, mode: 'local', roster: [], members: [], profileUpdates: [] };
    contexts.push(context);
    return {
      state: () => ({ ...options.store.snapshot(), sync: context.mode }),
      status: () => ({ mode: context.mode, roster: context.roster, members: context.members, connected: true }),
      async updateProfile() { context.profileUpdates.push(options.store.getMeta('user')); },
      async shutdown() {}, async closeSharedFile() {},
    };
  };
  try {
    spaces = createBrainSpaces({ baseStore, directory, createSync: factory });
    await spaces.createBrain({ name: 'Med utvalgte' });
    const invitedId = spaces.catalog().activeId, invited = contexts[1];
    const person = { id: 'member-one', userId: 'member-one', name: 'Ada', avatar: { style: 'fox', color: 'mint' }, joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), token: 'must-not-leak', secret: 'must-not-leak' };
    invited.mode = 'client'; invited.roster = [person]; invited.members = [{ ...person, lastSeen: Date.now() }]; invited.options.onChange();
    assert.deepEqual(spaces.catalog().brains.find(brain => brain.id === invitedId).members.map(member => member.id), ['member-one']);
    assert.equal(JSON.stringify(spaces.catalog()).includes('must-not-leak'), false);
    await spaces.switchBrain({ id: 'personal' });
    await spaces.store.saveProfile({ name: 'Oppdatert', avatar: { style: 'robot', color: 'rose' } });
    assert.equal(contexts[0].profileUpdates.at(-1).name, 'Oppdatert');
    assert.equal(contexts[1].profileUpdates.at(-1).name, 'Oppdatert');
    assert.deepEqual(contexts[1].profileUpdates.at(-1).avatar, { style: 'robot', color: 'rose' });
    assert.equal(spaces.catalog().brains.find(brain => brain.id === 'personal').members.length, 1);
    assert.equal(spaces.catalog().brains.find(brain => brain.id === invitedId).onlineMembers.length, 1);
    await spaces.close(); contexts = [];
    baseStore = new Store(filename); spaces = createBrainSpaces({ baseStore, directory, createSync: factory });
    assert.equal(contexts.length, 1);
    const saved = spaces.catalog().brains.find(brain => brain.id === invitedId);
    assert.deepEqual(saved.members.map(member => member.id), ['member-one']);
    assert.deepEqual(saved.onlineMembers, []);
    assert.equal(JSON.stringify(saved).includes('must-not-leak'), false);
    assert.equal(contexts.length, 1);
  } finally { await spaces?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a newly created invited Brain records its creator while an unjoined public Brain stays empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-people-creator-')), baseStore = new Store(join(directory, 'personal.sqlite'));
  const spaces = createBrainSpaces({ baseStore, directory });
  try {
    assert.deepEqual(spaces.catalog().brains.find(brain => brain.id === 'public').members, []);
    await spaces.createBrain({ name: 'Egen gruppe' });
    const id = spaces.catalog().activeId, owner = baseStore.getMeta('user');
    assert.deepEqual(spaces.catalog().brains.find(brain => brain.id === id).members.map(member => member.id), [owner.id]);
    await spaces.store.saveProfile({ name: 'Nytt eiernavn', avatar: { style: 'bear', color: 'butter' } });
    assert.equal(spaces.sync.status().roster[0].name, 'Nytt eiernavn');
    assert.deepEqual(spaces.catalog().brains.find(brain => brain.id === id).members[0].avatar, { style: 'bear', color: 'butter' });
    await spaces.switchBrain({ id: 'public' });
    assert.deepEqual(spaces.catalog().brains.find(brain => brain.id === 'public').members, []);
    assert.deepEqual(spaces.sync.status().roster, []);
  } finally { await spaces.close(); await rm(directory, { recursive: true, force: true }); }
});
