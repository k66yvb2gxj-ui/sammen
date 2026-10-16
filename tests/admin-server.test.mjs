import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import https from 'node:https';
import { Readable } from 'node:stream';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import { Store } from '../src/store.mjs';
import { createSyncService, transportRequest } from '../src/sync.mjs';
import { createModel } from '../src/collaboration-model.mjs';
import { createInternetServer } from '../server/room-server.mjs';
import { createAdminEvents } from '../src/admin-events.mjs';
import { createAdminService } from '../src/admin.mjs';

const createKey = 'admin-tests-private-room-key-123456789';
const adminKey = 'admin-tests-separate-admin-key-987654321';
async function fixture({ enabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-admin-test-'));
  const cert = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1, algorithm: 'sha256', extensions: [
    { name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }
  ] });
  let service;
  const server = createServer({ key: cert.private, cert: cert.cert }, (request, response) => service.server.emit('request', request, response));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `https://127.0.0.1:${server.address().port}`;
  const open = async () => { service = await createInternetServer({ directory, publicOrigin: url, createKey, publicBrain: true, ...(enabled ? { adminKey } : {}) }); };
  await open();
  const request = (route, options = {}) => transportRequest(url, route, { token: adminKey, ca: cert.cert, ...options });
  return { directory, url, ca: cert.cert, request,
    async restart() { await service.close(); await open(); },
    async close() { await service.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(directory, { recursive: true, force: true }); }
  };
}

test('admin API is opt-in, read-only, and never accepts creation keys or browser-origin requests', async () => {
  const disabled = await fixture({ enabled: false });
  try {
    await assert.rejects(disabled.request('/api/admin/overview'), error => error.statusCode === 404);
    await assert.rejects(access(join(disabled.directory, 'admin-activity.sqlite')));
  } finally { await disabled.close(); }
  const server = await fixture();
  try {
    await assert.rejects(server.request('/api/admin/overview', { token: undefined }), error => error.statusCode === 401);
    await assert.rejects(server.request('/api/admin/overview', { token: createKey }), error => error.statusCode === 401);
    await assert.rejects(server.request('/api/admin/overview', { token: 'incorrect-admin-key-123456789' }), error => error.statusCode === 401);
    await assert.rejects(server.request('/api/admin/overview', { method: 'POST', data: {} }), error => error.statusCode === 405);
    const response = await new Promise((done, fail) => {
      const request = https.get(server.url + '/api/admin/overview', { ca: server.ca, headers: { Authorization: `Bearer ${adminKey}`, Origin: 'https://example.org' } }, response => { response.resume(); response.on('end', () => done(response.statusCode)); }); request.on('error', fail);
    });
    assert.equal(response, 403);
    const rawKeyStatus = await new Promise((done, fail) => {
      const request = https.get(server.url + '/api/admin/overview', { ca: server.ca, headers: { Authorization: adminKey } }, response => { response.resume(); response.on('end', () => done(response.statusCode)); }); request.on('error', fail);
    });
    assert.equal(rawKeyStatus, 401);
    const empty = await server.request('/api/admin/overview');
    assert.deepEqual(empty.counts, { brains: 1, users: 0, projects: 0, files: 0 });
    assert.equal(empty.brains[0].name, 'Offentlig Brain');
    assert.deepEqual(empty.brains[0].members, []);
    for (const limit of ['0', '-1', '201', 'NaN', '1.5', '50&limit=20', '50&key=test']) await assert.rejects(server.request('/api/admin/activity?limit=' + limit), error => error.statusCode === 400);
    assert.deepEqual((await server.request('/api/admin/activity?limit=200')).events, []);
  } finally { await server.close(); }
});

test('admin keys must be long and separate from room creation credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-admin-key-'));
  try {
    await assert.rejects(createInternetServer({ directory, publicOrigin: 'https://example.org', createKey, adminKey: 'short' }), /adminnøkkel/);
    await assert.rejects(createInternetServer({ directory, publicOrigin: 'https://example.org', createKey, adminKey: createKey }), /adminnøkkel/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('admin overview and durable semantic activity expose metadata without document content or credentials', async () => {
  const server = await fixture(), stores = [new Store(), new Store(), new Store()];
  stores[0].saveProfile({ name: 'Alice', avatar: { style: 'fox', color: 'mint' } });
  stores[1].saveProfile({ name: 'Bob', avatar: { style: 'owl', color: 'sky' } });
  stores[2].setMeta('user', stores[0].getMeta('user'));
  const [alice, bob, publicAlice] = stores.map(store => createSyncService({ store, ca: server.ca }));
  const content = 'DOCUMENT_CONTENT_MUST_NEVER_APPEAR_IN_ADMIN';
  try {
    const shared = await alice.startInternetRoom({ url: server.url, scope: 'brain', name: 'Vår lesegruppe', createKey });
    await bob.joinGroup({ url: shared.url, inviteCode: shared.inviteCode });
    await publicAlice.joinPublicBrain({ url: server.url });
    const projectId = alice.state().projects[0].id;
    const note = await alice.mutate('saveItem', { projectId, title: 'Visible title', content });
    const changed = await bob.mutate('saveItem', { ...note, content: content + ' Bob.' });
    const opened = await bob.openSharedFile({ id: note.id }), model = createModel(opened), vector = model.vector();
    model.write({ ...opened.item, content: opened.item.content + ' CRDT.' });
    const updated = await bob.updateSharedFile({ id: note.id, update: model.encode(vector), stateVector: model.vector() });
    const afterEdit = await server.request('/api/admin/activity?limit=200');
    await assert.rejects(alice.mutate('saveItem', { ...note, content: 'Stale revision' }), /endret av en annen/);
    await assert.rejects(alice.mutate('saveItem', { ...updated.item, citations: [{ id: 'invalid', sourceId: 'missing-source', title: 'Missing' }] }), /Kilden må finnes/);
    await bob.updateSharedFile({ id: note.id, update: model.encode(model.vector()), stateVector: model.vector() });
    model.destroy();
    await bob.mutate('saveItem', { ...updated.item });
    await alice.refresh(); await bob.refresh();
    await alice.openSharedFile({ id: note.id }); await alice.closeSharedFile({ id: note.id });
    assert.equal((await server.request('/api/admin/activity?limit=200')).events.length, afterEdit.events.length);
    await alice.mutate('saveProject', { ...alice.state().projects[0], title: 'Nytt fagnavn' });
    const newProject = await alice.mutate('saveProject', { title: 'Ekstra fag' });
    await alice.mutate('saveProject', { ...newProject });
    stores[0].saveProfile({ name: 'Alice ny', avatar: { style: 'robot', color: 'rose' } });
    await alice.updateProfile(); const afterProfile = (await server.request('/api/admin/activity?limit=200')).events.length;
    await alice.updateProfile();
    assert.equal((await server.request('/api/admin/activity?limit=200')).events.length, afterProfile);
    const overview = await server.request('/api/admin/overview');
    assert.deepEqual(overview.counts, { brains: 2, users: 2, projects: 2, files: 1 });
    assert.equal(overview.brains.find(brain => brain.visibility === 'invited').memberCount, 2);
    assert.equal(overview.brains.find(brain => brain.visibility === 'invited').name, 'Vår lesegruppe');
    assert.equal(overview.users.find(user => user.id === stores[0].getMeta('user').id).brainIds.length, 2);
    assert.equal(overview.users.find(user => user.id === stores[0].getMeta('user').id).name, 'Alice ny');
    const serialized = JSON.stringify(overview) + JSON.stringify(await server.request('/api/admin/activity?limit=200'));
    const token = stores[0].getMeta('sync:client').connection.token;
    for (const value of [content, createKey, adminKey, token, shared.inviteCode, '"secret"', '"token"', '"content"']) assert.equal(serialized.includes(value), false, value);
    const activities = (await server.request('/api/admin/activity?limit=200')).events;
    assert.equal(activities.filter(event => event.type === 'file.created').length, 1);
    assert.equal(activities.filter(event => event.type === 'file.updated').length, 2);
    assert.equal(activities.filter(event => event.type === 'project.created').length, 1);
    assert.equal(activities.filter(event => event.type === 'project.updated').length, 1);
    assert.equal(activities.filter(event => event.type === 'profile.updated').length, 1);
    assert.equal(activities.find(event => event.type === 'file.updated').actor.id, stores[1].getMeta('user').id);
    await alice.mutate('deleteItem', { id: note.id, revision: changed.revision + 1 });
    await bob.leaveGroup();
    const finalEvents = (await server.request('/api/admin/activity?limit=200')).events;
    assert.equal(finalEvents.filter(event => event.type === 'file.deleted').length, 1);
    assert.equal(finalEvents.filter(event => event.type === 'member.left').length, 1);
    await alice.pause(); await publicAlice.pause();
    await server.restart();
    assert.deepEqual((await server.request('/api/admin/activity?limit=200')).events, finalEvents);
    const restored = await server.request('/api/admin/overview');
    assert.equal(restored.counts.users, 2); assert.equal(restored.counts.files, 0);
    assert.equal(restored.users.some(user => user.name === 'Meg'), false);
    assert.equal(restored.brains.find(brain => brain.visibility === 'invited').members.length, 2);
  } finally { for (const sync of [alice, bob, publicAlice]) await sync.shutdown(); for (const store of stores) store.close(); await server.close(); }
});

test('the main-process admin client accepts the actual server DTO over verified HTTPS', async () => {
  const server = await fixture(), store = new Store(), sync = createSyncService({ store, ca: server.ca });
  const fetchImpl = (url, options) => new Promise((done, fail) => {
    const request = https.request(url, { method: options.method, ca: server.ca, headers: options.headers, signal: options.signal }, response => done(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })));
    request.on('error', fail); request.end();
  });
  const admin = await createAdminService({ directory: join(server.directory, 'client'), fetchImpl, canRemember: false });
  try {
    await sync.startInternetRoom({ url: server.url, scope: 'brain', name: 'Klientkontrakt', createKey });
    const state = await admin.connect({ url: server.url, key: adminKey, remember: false });
    assert.equal(state.status.connected, true);
    assert.equal(state.overview.brains.find(brain => brain.visibility === 'invited').name, 'Klientkontrakt');
    assert.equal((await admin.getOverview()).counts.users, 1);
    assert.ok((await admin.getActivity({ limit: 200 })).events.some(event => event.type === 'room.created'));
    assert.equal(JSON.stringify(admin.getState()).includes(adminKey), false);
  } finally { await admin.disconnect(); await sync.shutdown(); store.close(); await server.close(); }
});

test('activity storage is bounded and whitelists event fields before persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sammen-admin-bounded-')), filename = join(directory, 'events.sqlite');
  let events = createAdminEvents({ filename, maxEvents: 3 });
  const actor = { id: 'user-id', name: 'Person', avatar: { style: 'cat', color: 'lilac' }, token: 'never-record-me' };
  try {
    for (let number = 0; number < 8; number++) events.record({ type: 'file.updated', brainId: 'public', actor, target: { id: `item-${number}`, title: 'Metadata', content: 'never-record-me' }, content: 'never-record-me', token: 'never-record-me' });
    assert.equal(events.activity(200).length, 3);
    assert.deepEqual(events.activity(200).map(event => event.target.id), ['item-7', 'item-6', 'item-5']);
    assert.equal(JSON.stringify(events.activity(200)).includes('never-record-me'), false);
    events.close(); events = createAdminEvents({ filename, maxEvents: 3 });
    assert.equal(events.activity(200).length, 3);
    assert.throws(() => events.activity(201), /200/);
  } finally { events.close(); await rm(directory, { recursive: true, force: true }); }
});
