import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, mutateStore } from '../src/store.mjs';

test('conflicting note saves are rejected without losing the original', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  const note = store.saveItem({projectId,title:'Første',content:'Første tekst'});
  store.saveItem({...note,content:'Endring fra elev A'});
  assert.throws(()=>store.saveItem({...note,content:'Endring fra elev B'}),/endret av en annen/);
  assert.equal(store.get('item',note.id).content,'Endring fra elev A'); store.close();
});
test('shared mutations cannot reach another project or invent a write operation', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  const other = store.saveProject({title:'Privat'});
  const note = store.saveItem({projectId:other.id,title:'Privat notat'});
  assert.throws(()=>mutateStore(store,'saveItem',{...note,content:'Endret'}, {projectId,author:'Elev'}),/bare tilgang/);
  assert.throws(()=>mutateStore(store,'deleteItem',{id:note.id,revision:note.revision},{projectId}),/bare tilgang/);
  assert.throws(()=>mutateStore(store,'close',{}, {projectId}),/støttes ikke/); store.close();
});
test('project round trip preserves AI provenance, citations and flashcard sources', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  const source = store.saveItem({projectId,title:'Original',type:'source',content:'Kildetekst',sourceUrl:'https://example.org'});
  store.saveItem({projectId,title:'KI',type:'ai',origin:'ai',content:'Svar [K1]',citations:[{id:'K1',sourceId:source.id,title:source.title,url:source.sourceUrl,excerpt:'Kildetekst'}]});
  store.saveCard({projectId,question:'Hva?',answer:'Svar',sourceIds:[source.id]});
  const copy = store.importProject(store.exportProject(projectId)); const state = store.snapshot(copy.id);
  const newSource = state.items.find(i=>i.type==='source'); const draft = state.items.find(i=>i.origin==='ai');
  assert.notEqual(newSource.id,source.id); assert.equal(draft.status,'draft'); assert.equal(draft.citations[0].sourceId,newSource.id);
  assert.equal(state.flashcards[0].sourceIds[0],newSource.id); store.close();
});
test('invalid project import rolls back all newly created records', () => {
  const store = new Store(); const before = store.snapshot();
  assert.throws(()=>store.importProject({format:'sammen-project',version:1,project:{title:'Import'},items:[{title:'Gyldig'},{title:'Ugyldig',type:'mindmap',mindmap:{nodes:[]}}],flashcards:[],chats:[]}));
  assert.deepEqual(store.snapshot(),before); store.close();
});
test('mindmap cycles are rejected and AI origin cannot be erased by editing', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  assert.throws(()=>store.saveItem({projectId,title:'Kart',type:'mindmap',mindmap:{nodes:[{id:'root',text:'Rot',parentId:null},{id:'a',text:'A',parentId:'b'},{id:'b',text:'B',parentId:'a'}]}}),/ugyldig kobling/);
  const draft = store.saveItem({projectId,title:'AI',type:'ai',origin:'ai',content:'Et utkast'});
  assert.equal(store.saveItem({...draft,origin:'human',content:'Redigert'}).origin,'ai'); store.close();
});
test('card review schedules the next review rather than overwriting a question', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  const card = store.saveCard({projectId,question:'Spørsmål',answer:'Svar'});
  const reviewed = store.reviewCard({id:card.id,rating:'good'});
  assert.equal(reviewed.reviewCount,1); assert.equal(reviewed.question,card.question);
  assert.ok(Date.parse(reviewed.dueAt)>Date.now()+23*3600000); store.close();
});

test('interactive mindmap positions and formatting survive saves and project export', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  const mindmap = { nodes: [
    { id: 'root', text: 'Rot', parentId: null, x: 0, y: 0, color: '#e4d4f6', shape: 'ellipse', collapsed: false },
    { id: 'branch', text: 'Gren', parentId: 'root', x: -220.5, y: 87, color: '#ffddbb', shape: 'rounded', collapsed: true }
  ], relations: [{ id: 'relation', fromId: 'root', toId: 'branch', label: 'Sammenheng' }] };
  const item = store.saveItem({ projectId, title: 'Kart', type: 'mindmap', mindmap });
  const saved = store.saveItem({ ...item, content: 'Et kart' });
  assert.deepEqual(saved.mindmap, mindmap);
  const copy = store.importProject(store.exportProject(projectId));
  assert.deepEqual(store.snapshot(copy.id).items[0].mindmap, mindmap);
  store.close();
});

test('invalid mindmap positions, formatting and cross-node relations cannot corrupt a saved map', () => {
  const store = new Store(); const projectId = store.snapshot().projects[0].id;
  const map = store.saveItem({ projectId, title: 'Kart', type: 'mindmap', mindmap: { nodes: [{ id: 'root', text: 'Rot', parentId: null }] } });
  for (const patch of [{ x: Infinity }, { y: 20001 }, { color: 'red' }, { shape: 'script' }, { collapsed: 'yes' }]) {
    assert.throws(() => store.saveItem({ ...map, mindmap: { nodes: [{ ...map.mindmap.nodes[0], ...patch }] } }), /Ugyldig/);
  }
  for (const relation of [
    { id: 'r', fromId: 'root', toId: 'root' },
    { id: 'r', fromId: 'root', toId: 'missing' }
  ]) assert.throws(() => store.saveItem({ ...map, mindmap: { ...map.mindmap, relations: [relation] } }), /ugyldig forbindelse/);
  assert.deepEqual(store.get('item', map.id), map);
  store.close();
});
test('personal repetition never changes the shared flashcard schedule', () => {
  const a = new Store(), b = new Store(); const projectId=a.snapshot().projects[0].id;
  const card=a.saveCard({projectId,question:'Felles spørsmål',answer:'Svar'});
  a.reviewPersonalCard(card,'easy');
  assert.equal(a.personalCard(card).reviewCount,1); assert.equal(b.personalCard(card).reviewCount,0);
  assert.equal(a.get('card',card.id).reviewCount,0); a.close(); b.close();
});
