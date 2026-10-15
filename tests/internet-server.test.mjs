import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { generate } from 'selfsigned';
import { Store } from '../src/store.mjs';
import { createSyncService } from '../src/sync.mjs';
import { createModel } from '../src/collaboration-model.mjs';
import { createInternetServer } from '../server/room-server.mjs';

const createKey = 'test-only-server-create-key-123456789';
async function fixture() {
  const cert = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1, algorithm: 'sha256', extensions: [
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }
  ] });
  const directory = await mkdtemp(join(tmpdir(), 'sammen-internet-test-'));
  let service;
  const tls = createServer({ key: cert.private, cert: cert.cert }, (req, res) => {
    if (!service) { res.writeHead(503).end(); return; }
    service.server.emit('request', req, res);
  });
  await new Promise(done => tls.listen(0, '127.0.0.1', done));
  const url = `https://127.0.0.1:${tls.address().port}`;
  service = await createInternetServer({ directory, publicOrigin: url, createKey });
  return {
    url, ca: cert.cert, directory,
    async restart() { const old = service; service = null; await old.close(); service = await createInternetServer({ directory, publicOrigin: url, createKey }); },
    async close() {
      await service.close(); tls.closeAllConnections(); await new Promise(done => tls.close(done));
      const target = resolve(directory), base = resolve(tmpdir());
      const below = relative(base, target);
      if (!below || below.startsWith('..' + sep) || !target.includes('sammen-internet-test-')) throw new Error('Unexpected fixture cleanup path.');
      await rm(target, { recursive: true, force: true });
    }
  };
}

test('Internet room upload, authenticated joining, concurrent edits and server restart work over verified TLS', async () => {
  const server = await fixture();
  const aStore = new Store(), bStore = new Store();
  aStore.saveProfile({ name: 'Alice' }); bStore.saveProfile({ name: 'Bob' });
  const projectId = aStore.snapshot().projects[0].id;
  aStore.saveProject({ id: projectId, title: 'Felles fag' });
  aStore.saveItem({ projectId, title: 'Notat', content: 'Felles utgangspunkt.' });
  const a = createSyncService({ store: aStore, ca: server.ca }), b = createSyncService({ store: bStore, ca: server.ca });
  const models = [];
  try {
    await assert.rejects(a.startInternetRoom({ url: server.url, projectId, createKey: 'wrong-key-that-is-at-least-24-chars' }), /Opprettelsesnøkkelen/);
    const created = await a.startInternetRoom({ url: server.url, projectId, createKey });
    assert.equal(created.mode, 'client'); assert.ok(created.url.includes('/rooms/'));
    assert.equal(a.state().projects[0].title, 'Felles fag');
    assert.equal(aStore.snapshot().projects.find(p => p.id === projectId).title, 'Felles fag');
    await assert.rejects(b.joinGroup({ url: created.url.replace(/rooms\/.+$/, 'rooms/00000000-0000-0000-0000-000000000000'), inviteCode: created.inviteCode }), /adresse|invitasjon|Invitasjon/);
    await b.joinGroup({ url: created.url, inviteCode: created.inviteCode });
    const id = a.state().items[0].id;
    const [firstA, firstB] = await Promise.all([a.openSharedFile({ id }), b.openSharedFile({ id })]);
    const modelA = createModel(firstA), modelB = createModel(firstB); models.push(modelA, modelB);
    const vectorA = modelA.vector(), vectorB = modelB.vector();
    modelA.write({ ...firstA.item, content: firstA.item.content + ' Alice.' });
    modelB.write({ ...firstB.item, content: firstB.item.content + ' Bob.' });
    await Promise.all([
      a.updateSharedFile({ id, update: modelA.encode(vectorA), stateVector: modelA.vector() }),
      b.updateSharedFile({ id, update: modelB.encode(vectorB), stateVector: modelB.vector() })
    ]);
    const merged = await a.openSharedFile({ id });
    assert.match(merged.item.content, /Alice\./); assert.match(merged.item.content, /Bob\./);
    assert.equal(merged.members.length, 2);
    assert.ok(merged.members.some(member => member.userId === aStore.getMeta('user').id));
    await server.restart();
    const reopened = await b.openSharedFile({ id });
    assert.match(reopened.item.content, /Alice\./); assert.match(reopened.item.content, /Bob\./);
    assert.equal(reopened.active, true);
  } finally {
    for (const model of models) model.destroy();
    await a.leaveGroup(); await b.leaveGroup(); aStore.close(); bStore.close(); await server.close();
  }
});

test('public room server requires HTTPS and a private creation key', async () => {
  await assert.rejects(createInternetServer({ directory: tmpdir(), publicOrigin: 'http://example.org', createKey }), /HTTPS/);
  await assert.rejects(createInternetServer({ directory: tmpdir(), publicOrigin: 'https://example.org', createKey: 'short' }), /opprettelsesnøkkel/);
});
