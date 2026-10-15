import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createSyncService, pinnedRequest } from '../src/sync.mjs';

test('TLS-pinned group sharing isolates a project and applies conflict-checked edits', async () => {
  const hostStore = new Store(); const guestStore = new Store();
  const projectId = hostStore.snapshot().projects[0].id;
  const privateProject = hostStore.saveProject({title:'Privat prosjekt'});
  hostStore.saveItem({projectId:privateProject.id,title:'Privat tekst',content:'Ikke delt'});
  const host = createSyncService({store:hostStore}); const guest = createSyncService({store:guestStore});
  try {
    const status = await host.startHosting({projectId}); const url = new URL(status.urls[0]); url.hostname='127.0.0.1';
    await guest.joinGroup({url:url.origin,inviteCode:status.inviteCode});
    assert.equal(guest.state().projects.length,1); assert.equal(guest.state().items.length,0);
    const note = await guest.mutate('saveItem',{projectId,title:'Felles notat',content:'Fra elev'});
    assert.equal(hostStore.get('item',note.id).content,'Fra elev');
    await host.mutate('saveItem',{...note,content:'Endret av vert'});
    await assert.rejects(guest.mutate('saveItem',{...note,content:'Gammelt utkast'}),/endret av en annen/);
    await assert.rejects(guest.mutate('saveProject',{title:'Ulovlig nytt prosjekt'}),/bare tilgang/);
    const code = JSON.parse(Buffer.from(status.inviteCode.slice(3),'base64url'));
    await assert.rejects(pinnedRequest(url.origin,code.fingerprint,'/api/state'),/utløpt/);
    await assert.rejects(pinnedRequest(url.origin,'0'.repeat(64),'/api/state'),/sertifikat/);
    await guest.leaveGroup(); assert.equal(guest.status().mode,'local'); assert.notEqual(guest.state().projects[0].id,projectId);
  } finally { await guest.leaveGroup(); await host.stopHosting(); hostStore.close();guestStore.close(); }
});
