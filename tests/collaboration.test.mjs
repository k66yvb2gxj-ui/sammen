import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createSyncService, createRoomHandler, groupUrl } from '../src/sync.mjs';
import { createFileCollaboration } from '../src/collaboration.mjs';
import { createModel } from '../src/collaboration-model.mjs';

async function group() {
  const stores = [new Store(), new Store(), new Store()];
  stores[0].saveProfile({ name: 'Vert' }); stores[1].saveProfile({ name: 'Ada' }); stores[2].saveProfile({ name: 'Bo' });
  const [host, ada, bo] = stores.map(store => createSyncService({ store }));
  const projectId = stores[0].snapshot().projects[0].id;
  const status = await host.startHosting({ projectId }); const url = new URL(status.urls[0]); url.hostname = '127.0.0.1';
  await ada.joinGroup({ url: url.origin, inviteCode: status.inviteCode }); await bo.joinGroup({ url: url.origin, inviteCode: status.inviteCode });
  return { stores, host, ada, bo, projectId, close: async () => { await ada.leaveGroup(); await bo.leaveGroup(); await host.stopHosting(); for (const store of stores) store.close(); } };
}

function edit(opened, transform) {
  const model = createModel(opened), vector = model.vector(); model.write(transform(model.read(opened.item)));
  return { model, input: { id: opened.id, update: model.encode(vector), stateVector: model.vector() } };
}

test('three native students merge simultaneous note text and independent sources over pinned HTTPS', async () => {
  const g = await group();
  try {
    const note = await g.host.mutate('saveItem', { projectId: g.projectId, title: 'Notat', content: 'Felles grunntekst.' });
    const [oa, ob] = await Promise.all([g.ada.openSharedFile({ id: note.id }), g.bo.openSharedFile({ id: note.id })]);
    const a = edit(oa, item => ({ ...item, content: `Ada: ${item.content}`, citations: [{ id: 'ada-source', sourceId: '', title: 'Ada sin kilde', url: 'https://example.org/ada', excerpt: '' }] }));
    const b = edit(ob, item => ({ ...item, content: `${item.content} Bo.`, citations: [{ id: 'bo-source', sourceId: '', title: 'Bo sin kilde', url: 'https://example.org/bo', excerpt: '' }] }));
    await Promise.all([g.ada.updateSharedFile(a.input), g.bo.updateSharedFile(b.input)]);
    await Promise.all([g.ada.refresh(), g.bo.refresh()]);
    const saved = g.stores[0].get('item', note.id);
    assert.equal(saved.content, 'Ada: Felles grunntekst. Bo.');
    assert.deepEqual(saved.citations.map(c => c.id).sort(), ['ada-source', 'bo-source']);
    assert.equal(g.ada.state().items.find(i => i.id === note.id).content, saved.content);
    assert.equal(g.bo.state().items.find(i => i.id === note.id).content, saved.content);
    assert.equal(g.host.status().memberCount, 3);
    assert.deepEqual((await g.ada.openSharedFile({ id: note.id })).members.map(m => m.name).sort(), ['Ada', 'Bo']);
    a.model.destroy(); b.model.destroy();
  } finally { await g.close(); }
});

test('different mindmap branches survive simultaneous edits and conflicting moves keep a valid tree', async () => {
  const g = await group();
  try {
    const map = await g.host.mutate('saveItem', { projectId: g.projectId, type: 'mindmap', title: 'Kart', content: '', mindmap: { nodes: [{ id: 'root', text: 'Hovedidé', parentId: null }, { id: 'a', text: 'A', parentId: 'root' }, { id: 'b', text: 'B', parentId: 'root' }] } });
    const [oa, ob] = await Promise.all([g.ada.openSharedFile({ id: map.id }), g.bo.openSharedFile({ id: map.id })]);
    const a = edit(oa, item => ({ ...item, mindmap: { nodes: item.mindmap.nodes.map(n => n.id === 'a' ? { ...n, text: 'Ada sin gren', parentId: 'b', x: 200 } : n), relations: [] } }));
    const b = edit(ob, item => ({ ...item, mindmap: { nodes: item.mindmap.nodes.map(n => n.id === 'b' ? { ...n, text: 'Bo sin gren', parentId: 'a', color: '#ffaa44' } : n), relations: [] } }));
    await Promise.all([g.ada.updateSharedFile(a.input), g.bo.updateSharedFile(b.input)]);
    const result = g.stores[0].get('item', map.id);
    assert.equal(result.mindmap.nodes.length, 3);
    assert.equal(result.mindmap.nodes.find(n => n.id === 'a').text, 'Ada sin gren');
    assert.equal(result.mindmap.nodes.find(n => n.id === 'b').text, 'Bo sin gren');
    assert.equal(result.mindmap.nodes.find(n => n.id === 'a').x, 200);
    assert.equal(result.mindmap.nodes.find(n => n.id === 'b').color, '#ffaa44');
    assert.equal(result.mindmap.nodes.filter(n => !n.parentId).length, 1);
    assert.doesNotThrow(() => g.stores[0].saveItem(result));
    a.model.destroy(); b.model.destroy();
  } finally { await g.close(); }
});

test('CRDT persistence survives SQLite restart and ordinary revision-checked saves reconcile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sammen-crdt-')), filename = path.join(directory, 'brain.sqlite');
  let store = new Store(filename), collaboration;
  try {
    const projectId = store.snapshot().projects[0].id;
    const note = store.saveItem({ projectId, title: 'Vedvarende', content: 'Start' });
    collaboration = createFileCollaboration({ store, projectId });
    const opened = collaboration.response(note.id), a = edit(opened, item => ({ ...item, content: `${item.content} + første` }));
    collaboration.update(a.input, 'Ada'); collaboration.close(); store.close();
    store = new Store(filename); collaboration = createFileCollaboration({ store, projectId });
    const reopened = collaboration.response(note.id);
    assert.equal(createModel(reopened).read(reopened.item).content, 'Start + første');
    const ordinary = store.saveItem({ ...reopened.item, content: 'Redigert vanlig' });
    const reconciled = collaboration.response(note.id);
    assert.equal(createModel(reconciled).read(ordinary).content, 'Redigert vanlig');
    a.model.destroy();
  } finally { collaboration?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('shared CRDT rejects private file and foreign-project sources without poisoning persisted content', async () => {
  const g = await group();
  try {
    const privateProject = g.stores[0].saveProject({ title: 'Privat' });
    const privateNote = g.stores[0].saveItem({ projectId: privateProject.id, title: 'Privat notat', content: 'Skjult' });
    const note = await g.host.mutate('saveItem', { projectId: g.projectId, title: 'Delt', content: 'Trygg tekst' });
    await assert.rejects(g.ada.openSharedFile({ id: privateNote.id }), /bare tilgang/);
    const opened = await g.ada.openSharedFile({ id: note.id });
    const bad = edit(opened, item => ({ ...item, citations: [{ id: 'invalid', sourceId: privateNote.id, title: 'Privat kilde', url: '', excerpt: '' }] }));
    await assert.rejects(g.ada.updateSharedFile(bad.input), /Kilden må finnes/);
    assert.equal(g.stores[0].get('item', note.id).content, 'Trygg tekst');
    assert.equal(g.stores[0].get('item', note.id).citations.length, 0);
    bad.model.destroy();
  } finally { await g.close(); }
});

test('internet transport permits HTTPS room paths and rejects public HTTP, credentials and malformed URLs', () => {
  assert.equal(groupUrl('https://study.example.org/rooms/abc-123/'), 'https://study.example.org/rooms/abc-123');
  assert.throws(() => groupUrl('http://study.example.org/rooms/abc'), /HTTPS/);
  assert.throws(() => groupUrl('https://user:password@study.example.org/'), /HTTPS/);
  assert.throws(() => groupUrl('https://study.example.org/rooms/abc?token=x'), /HTTPS/);
  assert.throws(() => groupUrl('https://study.example.org/private/path'), /HTTPS/);
});

test('relative text selections follow a concurrent insertion instead of jumping to another word', () => {
  const item = { title: 'Tittel', content: 'Et felles notat', status: 'draft', citations: [] };
  const first = createModel({ item }), peer = createModel({ item, update: first.encode() });
  const selection = first.captureSelection('content', 3, 9), vector = peer.vector();
  peer.write({ ...item, content: 'Nytt: Et felles notat' }); first.apply(peer.encode(vector));
  assert.deepEqual(first.restoreSelection(selection), { start: 9, end: 15 });
  assert.equal(first.read(item).content.slice(9, 15), 'felles');
  first.destroy(); peer.destroy();
});

test('sync coverage detects unsent character edits and accepts an acknowledged or ahead server vector', () => {
  const item = { title: 'Tittel', content: 'Felles', status: 'draft', citations: [] };
  const model = createModel({ item }), serverVector = model.vector();
  assert.equal(model.isSynced(serverVector), true);
  model.write({ ...item, content: 'Felles tekst' });
  assert.equal(model.isSynced(serverVector), false);
  assert.equal(model.isSynced(model.vector()), true);
  assert.equal(model.isSynced(undefined), false);
  assert.equal(model.isSynced('not a vector'), false);
  model.destroy();
});

test('persisted session tokens are scoped to one invitation and shared project', () => {
  const store = new Store();
  const firstProject = store.snapshot().projects[0].id, secondProject = store.saveProject({ title: 'Andre gruppe' }).id;
  const secret = randomBytes(32).toString('base64url');
  const first = createRoomHandler({ store, projectId: firstProject, secret, hostPresence: false });
  first.join({ secret, name: 'Ada' }); first.close();
  const resumed = createRoomHandler({ store, projectId: firstProject, secret, hostPresence: false });
  assert.equal(resumed.status().members.length, 1); resumed.close();
  const second = createRoomHandler({ store, projectId: secondProject, secret, hostPresence: false });
  assert.equal(second.status().members.length, 0); second.close();
  const rotated = createRoomHandler({ store, projectId: firstProject, secret: randomBytes(32).toString('base64url'), hostPresence: false });
  assert.equal(rotated.status().members.length, 0); rotated.close(); store.close();
});

test('an offline native draft survives app and room restart then merges with work done at the server', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sammen-outbox-'));
  const hostStore = new Store(path.join(directory, 'host.sqlite'));
  let guestStore = new Store(path.join(directory, 'guest.sqlite'));
  const projectId = hostStore.snapshot().projects[0].id;
  const note = hostStore.saveItem({ projectId, title: 'Offline', content: 'Start.' });
  const secret = randomBytes(32).toString('base64url');
  let room = createRoomHandler({ store: hostStore, projectId, secret, hostPresence: false });
  const server = http.createServer((req, res) => { req.url = req.url.replace('/rooms/offline-room', ''); return room.handle(req, res); });
  const listen = port => new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const stop = () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
  await listen(0); const port = server.address().port, url = `http://127.0.0.1:${port}/rooms/offline-room`;
  const inviteCode = `S2.${Buffer.from(JSON.stringify({ version: 2, secret, url })).toString('base64url')}`;
  let guest = createSyncService({ store: guestStore, allowLoopbackHttp: true });
  try {
    await guest.joinGroup({ url, inviteCode });
    const opened = await guest.openSharedFile({ id: note.id });
    const local = edit(opened, item => ({ ...item, content: `${item.content} Fra elev.` }));
    await stop();
    const pending = await guest.updateSharedFile(local.input);
    assert.equal(pending.pending, true);
    assert.equal(pending.item.content, 'Start. Fra elev.');
    await guest.leaveGroup(); guestStore.close();
    const hostOpened = room.openFile({ id: note.id });
    const changed = edit(hostOpened, item => ({ ...item, content: `Fra vert. ${item.content}` }));
    room.updateFile(changed.input); room.close();
    room = createRoomHandler({ store: hostStore, projectId, secret, hostPresence: false });
    await listen(port);
    guestStore = new Store(path.join(directory, 'guest.sqlite'));
    guest = createSyncService({ store: guestStore, allowLoopbackHttp: true });
    await guest.joinGroup({ url, inviteCode }); await guest.openSharedFile({ id: note.id }); await guest.refresh();
    assert.equal(hostStore.get('item', note.id).content, 'Fra vert. Start. Fra elev.');
    assert.equal(guest.state().items.find(i => i.id === note.id).content, 'Fra vert. Start. Fra elev.');
    local.model.destroy(); changed.model.destroy();
  } finally { await guest.leaveGroup(); if (server.listening) await stop(); room.close(); hostStore.close(); guestStore.close(); await rm(directory, { recursive: true, force: true }); }
});
