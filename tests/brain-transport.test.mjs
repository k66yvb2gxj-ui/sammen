import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createRoomHandler, createSyncService, exportBrain, transportRequest } from '../src/sync.mjs';
import { createInternetServer } from '../server/room-server.mjs';
import { createModel } from '../src/collaboration-model.mjs';

const createKey = 'brain-test-only-private-create-key-123456789';
async function fixture({ publicBrain = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-brain-transport-'));
  let service;
  const proxy = createServer((request, response) => {
    if (service) service.server.emit('request', request, response);
    else response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Offline test server' }));
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const open = async () => { service = await createInternetServer({ directory, publicOrigin: url, createKey, publicBrain, allowLoopbackHttp: true }); };
  await open();
  return { directory, url,
    async offline() { const previous = service; service = null; await previous?.close(); },
    async restart() { if (service) { const previous = service; service = null; await previous.close(); } await open(); },
    async close() { await service?.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); await rm(directory, { recursive: true, force: true }); }
  };
}
const client = store => createSyncService({ store, allowLoopbackHttp: true });

test('sharing a whole Brain is explicit and the default handler still requires one project', () => {
  const store = new Store();
  assert.throws(() => createRoomHandler({ store, secret: 'test' }), /ID/);
  assert.throws(() => createRoomHandler({ store, scope: 'everything', secret: 'test' }), /delingsområde/);
  const projectId = store.snapshot().projects[0].id;
  const privateProject = store.saveProject({ title: 'Privat prosjekt' });
  const room = createRoomHandler({ store, projectId, secret: 'test' });
  const joined = room.join({ name: 'Ada', secret: 'test' });
  assert.deepEqual(joined.state.projects.map(project => project.id), [projectId]);
  assert.throws(() => room.mutate('saveProject', { id: privateProject.id, title: 'Endret' }), /bare tilgang/);
  room.close(); store.close();
});

test('explicit pinned whole-Brain sharing supports projects and CRDT edits across two clients without crossing stores', async () => {
  const stores = [new Store(), new Store(), new Store(), new Store()];
  const [host, ada, bo] = stores.slice(0, 3).map(store => createSyncService({ store, listenHost: '127.0.0.1' }));
  const first = stores[0].snapshot().projects[0], second = stores[0].saveProject({ title: 'Andre fag' });
  const secretNote = stores[3].saveItem({ projectId: stores[3].snapshot().projects[0].id, title: 'Annen Brain', content: 'Privat' });
  try {
    const hosted = await host.startHosting({ scope: 'brain' });
    await ada.joinGroup({ url: hosted.urls[0], inviteCode: hosted.inviteCode });
    await bo.joinGroup({ url: hosted.urls[0], inviteCode: hosted.inviteCode });
    assert.equal(ada.status().scope, 'brain');
    assert.equal(ada.state().projects.length, 2);
    const third = await ada.mutate('saveProject', { title: 'Tredje fag' });
    const note = await ada.mutate('saveItem', { projectId: second.id, title: 'Felles', content: 'Start' });
    const source = await bo.mutate('saveItem', { projectId: first.id, title: 'Kilde i annet prosjekt', content: 'Kilde' });
    await bo.mutate('saveItem', { projectId: third.id, title: 'Nytt prosjekt', content: 'Nytt' });
    const opened = await bo.openSharedFile({ id: note.id });
    const model = createModel(opened), vector = model.vector();
    model.write({ ...opened.item, content: 'Start med samarbeid' });
    await bo.updateSharedFile({ id: note.id, update: model.encode(vector), stateVector: model.vector() });
    model.destroy();
    await ada.refresh();
    assert.equal(ada.state().items.find(item => item.id === note.id).content, 'Start med samarbeid');
    assert.equal(ada.state().projects.length, 3);
    assert.equal(stores[0].get('item', note.id).content, 'Start med samarbeid');
    await assert.rejects(ada.mutate('saveItem', { ...stores[0].get('item', note.id), citations: [{ id: 'bad', sourceId: source.id, title: 'Annet prosjekt' }] }), /Kilden må finnes/);
    const invalidOpened = await ada.openSharedFile({ id: note.id });
    const invalidModel = createModel(invalidOpened), invalidVector = invalidModel.vector();
    invalidModel.write({ ...invalidOpened.item, citations: [{ id: 'bad-crdt', sourceId: source.id, title: 'Annet prosjekt', url: '', excerpt: '' }] });
    await assert.rejects(ada.updateSharedFile({ id: note.id, update: invalidModel.encode(invalidVector), stateVector: invalidModel.vector() }), /Kilden må finnes/);
    invalidModel.destroy();
    assert.deepEqual(stores[0].get('item', note.id).citations, []);
    await assert.rejects(bo.openSharedFile({ id: secretNote.id }), /bare tilgang/);
    assert.equal(stores[3].get('item', secretNote.id).content, 'Privat');
    assert.equal(ada.state().items.some(item => item.id === secretNote.id), false);
  } finally { await ada.leaveGroup(); await bo.leaveGroup(); await host.shutdown(); for (const store of stores) store.close(); }
});

test('a newly created empty Brain can be hosted before its first project exists', async () => {
  const store = new Store(':memory:', { seedDefaultProject: false }), guestStore = new Store();
  const host = createSyncService({ store, listenHost: '127.0.0.1' }), guest = createSyncService({ store: guestStore });
  try {
    const room = await host.startHosting({ scope: 'brain' });
    await guest.joinGroup({ url: room.urls[0], inviteCode: room.inviteCode });
    assert.deepEqual(guest.state().projects, []);
    const project = await guest.mutate('saveProject', { title: 'Første prosjekt' });
    assert.equal(store.project(project.id).title, 'Første prosjekt');
  } finally { await guest.leaveGroup(); await host.shutdown(); store.close(); guestStore.close(); }
});

test('internet whole-Brain upload has no seeded project or metadata and stays isolated from another room', async () => {
  const server = await fixture();
  const stores = [new Store(':memory:', { seedDefaultProject: false }), new Store(), new Store()];
  const [a, b, other] = stores.map(client);
  const first = stores[0].saveProject({ title: 'Biologi' }), second = stores[0].saveProject({ title: 'Norsk' });
  stores[0].saveItem({ projectId: first.id, title: 'Celler', content: 'Fagtekst' });
  stores[0].saveItem({ projectId: second.id, title: 'Språk', content: 'Fagtekst' });
  stores[0].setMeta('private:test', { secret: 'do-not-share' });
  try {
    assert.equal(JSON.stringify(exportBrain(stores[0])).includes('do-not-share'), false);
    const shared = await a.startInternetRoom({ url: server.url, scope: 'brain', createKey });
    await b.joinGroup({ url: shared.url, inviteCode: shared.inviteCode });
    assert.deepEqual(b.state().projects.map(project => project.title), ['Biologi', 'Norsk']);
    assert.equal(b.state().items.length, 2);
    const added = await b.mutate('saveProject', { title: 'Historie' });
    await b.mutate('saveItem', { projectId: added.id, title: 'Nytt fag', content: 'Delt' });
    await a.refresh();
    assert.equal(a.state().projects.length, 3);
    const distinct = await other.startInternetRoom({ url: server.url, projectId: stores[2].snapshot().projects[0].id, createKey });
    const connection = stores[0].getMeta('sync:client').connection;
    await assert.rejects(transportRequest(distinct.url, '/api/state', { token: connection.token, allowLoopbackHttp: true }), /utløpt/);
    assert.equal(other.state().projects.length, 1);
    await server.restart(); await b.refresh();
    assert.equal(b.status().connected, true);
    assert.equal(b.state().projects.length, 3);
    assert.equal(stores[0].snapshot().projects.length, 2);
  } finally { for (const sync of [a, b, other]) await sync.leaveGroup(); for (const store of stores) store.close(); await server.close(); }
});

test('an empty shared Brain remains empty after server restart and can receive its first project', async () => {
  const server = await fixture(), store = new Store(':memory:', { seedDefaultProject: false }), sync = client(store);
  try {
    await sync.startInternetRoom({ url: server.url, scope: 'brain', createKey });
    assert.deepEqual(sync.state().projects, []);
    await server.restart(); await sync.refresh();
    assert.deepEqual(sync.state().projects, []);
    await sync.mutate('saveProject', { title: 'Første delte prosjekt' });
    assert.equal(sync.state().projects[0].title, 'Første delte prosjekt');
  } finally { await sync.leaveGroup(); store.close(); await server.close(); }
});

test('public Brain must be enabled and uses session tokens without exposing a creation key or invitation', async () => {
  const disabled = await fixture();
  const disabledStore = new Store(), unavailable = client(disabledStore);
  try { await assert.rejects(unavailable.joinPublicBrain({ url: disabled.url }), /finnes ikke/); }
  finally { await unavailable.shutdown(); disabledStore.close(); await disabled.close(); }
  const server = await fixture({ publicBrain: true });
  const stores = [new Store(), new Store(), new Store()];
  const [ada, bo, privateClient] = stores.map(client);
  try {
    const joined = await transportRequest(server.url + '/api/public-brain', '/api/join', { method: 'POST', data: { name: 'Test', userId: 'test-id' }, allowLoopbackHttp: true });
    assert.equal(joined.scope, 'brain');
    assert.equal(typeof joined.token, 'string');
    for (const name of ['inviteCode', 'secret', 'createKey']) assert.equal(Object.hasOwn(joined, name), false);
    await transportRequest(server.url + '/api/public-brain', '/api/leave', { method: 'POST', token: joined.token, data: {}, allowLoopbackHttp: true });
    await assert.rejects(transportRequest(server.url + '/api/public-brain', '/api/state', { allowLoopbackHttp: true }), /utløpt/);
    await ada.joinPublicBrain({ url: server.url }); await bo.joinPublicBrain({ url: server.url });
    assert.equal(ada.status().isPublic, true); assert.equal(ada.status().scope, 'brain');
    assert.equal(ada.status().inviteCode, undefined);
    assert.deepEqual(ada.state().projects, []);
    const shared = await ada.mutate('saveProject', { title: 'Åpent for alle' });
    await bo.mutate('saveItem', { projectId: shared.id, title: 'Sammen', content: 'Offentlig' });
    await ada.refresh(); assert.equal(ada.state().items[0].content, 'Offentlig');
    const privateRoom = await privateClient.startInternetRoom({ url: server.url, scope: 'brain', createKey });
    const publicToken = stores[0].getMeta('sync:client').connection.token;
    const privateToken = stores[2].getMeta('sync:client').connection.token;
    await assert.rejects(transportRequest(privateRoom.url, '/api/state', { token: publicToken, allowLoopbackHttp: true }), /utløpt/);
    await assert.rejects(transportRequest(server.url + '/api/public-brain', '/api/state', { token: privateToken, allowLoopbackHttp: true }), /utløpt/);
    assert.equal(privateClient.state().projects.some(project => project.id === shared.id), false);
    await server.restart(); await bo.refresh();
    assert.equal(bo.status().connected, true); assert.equal(bo.state().items[0].content, 'Offentlig');
  } finally { for (const sync of [ada, bo, privateClient]) await sync.leaveGroup(); for (const store of stores) store.close(); await server.close(); }
});

test('client shutdown preserves its private session and cached Brain for offline restart; explicit leave clears it', async () => {
  const server = await fixture({ publicBrain: true });
  const filename = join(server.directory, 'local-cache.sqlite');
  let store = new Store(filename, { seedDefaultProject: false }), sync = client(store);
  try {
    await sync.joinPublicBrain({ url: server.url });
    const project = await sync.mutate('saveProject', { title: 'Beholdt' });
    await sync.mutate('saveItem', { projectId: project.id, title: 'Utkast', content: 'Synlig uten nett' });
    const token = store.getMeta('sync:client').connection.token;
    await sync.shutdown(); store.close(); await server.offline();
    store = new Store(filename, { seedDefaultProject: false }); sync = client(store);
    assert.equal(sync.status().mode, 'client');
    assert.equal(sync.status().connected, false);
    assert.equal(sync.state().items[0].content, 'Synlig uten nett');
    assert.equal(store.getMeta('sync:client').connection.token, token);
    await sync.refresh(); assert.equal(sync.status().connected, false);
    await server.restart(); await sync.refresh();
    assert.equal(sync.status().connected, true);
    assert.equal(sync.state().items[0].content, 'Synlig uten nett');
    await sync.leaveGroup(); assert.equal(store.getMeta('sync:client'), null);
    await sync.shutdown(); store.close();
    store = new Store(filename, { seedDefaultProject: false }); sync = client(store);
    assert.equal(sync.status().mode, 'local'); assert.deepEqual(sync.state().items, []);
  } finally { await sync.shutdown(); store.close(); await server.close(); }
});

test('whole-Brain import rejects foreign project sources instead of accepting dangling references', async () => {
  const server = await fixture(), store = new Store();
  const projectId = store.snapshot().projects[0].id;
  store.saveItem({ projectId, title: 'Dårlig referanse', content: 'Tekst', citations: [{ id: 'bad', sourceId: 'outside-this-brain', title: 'Skjult' }] });
  const sync = client(store);
  try { await assert.rejects(sync.startInternetRoom({ url: server.url, scope: 'brain', createKey }), /Kilden må finnes/); }
  finally { await sync.shutdown(); store.close(); await server.close(); }
});
