import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const kinds = ['project', 'item', 'card', 'chat'];
const timestamp = () => new Date().toISOString();
const text = (value, limit, name, required = false) => {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`Ugyldig ${name}.`);
  return value;
};
const id = value => text(value, 100, 'ID', true);
const safeUrl = value => {
  if (!value) return '';
  const url = new URL(text(value, 2000, 'kildelenke'));
  if (!['https:', 'http:', 'onenote:'].includes(url.protocol) || url.username || url.password) throw new Error('Ugyldig kildelenke.');
  return url.href;
};
const citations = value => {
  if (!value) return [];
  if (!Array.isArray(value) || value.length > 30) throw new Error('Ugyldig kildeliste.');
  return value.map(c => ({ id: id(c.id), sourceId: c.sourceId ? id(c.sourceId) : '', title: text(c.title || 'Kilde', 500, 'kildetittel'), url: safeUrl(c.url), excerpt: text(c.excerpt || '', 4000, 'kildeutdrag') }));
};

export class Store {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, data TEXT NOT NULL);');
    if (!this.getMeta('user')) this.setMeta('user', { id: randomUUID(), name: 'Meg' });
    if (!this.list('project').length) this.saveProject({ title: 'Mitt første prosjekt', description: 'Et sted for notater, kilder og spørsmål.', color: '#647a64' });
  }
  close() { this.db.close(); }
  getMeta(key) { const r = this.db.prepare('SELECT data FROM metadata WHERE key=?').get(key); return r ? JSON.parse(r.data) : null; }
  setMeta(key, data) { this.db.prepare('INSERT INTO metadata(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(data)); }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.data)); }
  get(kind, key) { const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, key); return r ? JSON.parse(r.data) : null; }
  put(kind, value) { this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE records.kind=excluded.kind').run(kind, value.id, JSON.stringify(value)); return value; }
  project(key) { const p = this.get('project', id(key)); if (!p) throw new Error('Prosjektet finnes ikke.'); return p; }
  snapshot(projectId) {
    return { version: 1, user: this.getMeta('user'), projects: this.list('project').filter(p => !projectId || p.id === projectId), items: this.list('item').filter(i => !projectId || i.projectId === projectId), flashcards: this.list('card').filter(i => !projectId || i.projectId === projectId), chats: this.list('chat').filter(i => !projectId || i.projectId === projectId) };
  }
  saveProfile(input) { this.setMeta('user', { ...this.getMeta('user'), name: text(input.name, 80, 'navn', true).trim() }); }
  saveProject(input) {
    const old = input.id ? this.project(input.id) : null;
    const p = { id: old?.id || randomUUID(), title: text(input.title, 120, 'prosjekttittel', true).trim(), description: text(input.description || '', 2000, 'prosjektbeskrivelse'), color: /^#[a-f0-9]{6}$/i.test(input.color || '') ? input.color : old?.color || '#647a64', createdAt: old?.createdAt || timestamp(), updatedAt: timestamp() };
    return this.put('project', p);
  }
  saveItem(input, author = this.getMeta('user').name) {
    this.project(input.projectId);
    const old = input.id ? this.get('item', id(input.id)) : null;
    if (input.id && !old) throw new Error('Notatet finnes ikke lenger.');
    if (old && input.revision !== old.revision) throw new Error('Notatet er endret av en annen elev. Kopier utkastet ditt, og last inn den nye versjonen før du lagrer.');
    if (old && old.projectId !== input.projectId) throw new Error('Flytting mellom prosjekter støttes ikke her.');
    const type = input.type || old?.type || 'note';
    if (!['note', 'source', 'mindmap', 'ai'].includes(type)) throw new Error('Ugyldig notattype.');
    const origin = old?.origin || input.origin || 'human';
    if (!['human', 'ai', 'import', 'web'].includes(origin)) throw new Error('Ugyldig opprinnelse.');
    let mindmap;
    if (type === 'mindmap') {
      const nodes = input.mindmap?.nodes;
      if (!Array.isArray(nodes) || !nodes.length || nodes.length > 150) throw new Error('Tankekartet må ha mellom 1 og 150 punkter.');
      mindmap = { nodes: nodes.map(n => {
        const node = { id: id(n.id), text: text(n.text, 500, 'punkt i tankekart'), parentId: n.parentId ? id(n.parentId) : null };
        for (const coordinate of ['x', 'y']) if (n[coordinate] !== undefined) {
          if (!Number.isFinite(n[coordinate]) || Math.abs(n[coordinate]) > 20000) throw new Error('Ugyldig posisjon i tankekartet.');
          node[coordinate] = n[coordinate];
        }
        if (n.color !== undefined) {
          if (typeof n.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(n.color)) throw new Error('Ugyldig farge i tankekartet.');
          node.color = n.color;
        }
        if (n.shape !== undefined) {
          if (!['rounded', 'rectangle', 'ellipse'].includes(n.shape)) throw new Error('Ugyldig form i tankekartet.');
          node.shape = n.shape;
        }
        if (n.collapsed !== undefined) {
          if (typeof n.collapsed !== 'boolean') throw new Error('Ugyldig grenstatus i tankekartet.');
          node.collapsed = n.collapsed;
        }
        return node;
      }) };
      const ids = new Set(mindmap.nodes.map(n => n.id));
      if (ids.size !== nodes.length || mindmap.nodes.filter(n => !n.parentId).length !== 1) throw new Error('Tankekartet må ha én rot og unike punkter.');
      for (const node of mindmap.nodes) {
        const visited = new Set([node.id]); let parent = node.parentId;
        while (parent) { if (!ids.has(parent) || visited.has(parent)) throw new Error('Tankekartet har en ugyldig kobling.'); visited.add(parent); parent = mindmap.nodes.find(n => n.id === parent).parentId; }
      }
      if (input.mindmap.relations !== undefined) {
        const relations = input.mindmap.relations;
        if (!Array.isArray(relations) || relations.length > 300) throw new Error('Ugyldige forbindelser i tankekartet.');
        const relationIds = new Set();
        mindmap.relations = relations.map(r => {
          const relation = { id: id(r.id), fromId: id(r.fromId), toId: id(r.toId), label: text(r.label || '', 180, 'forbindelsestekst') };
          if (relationIds.has(relation.id) || !ids.has(relation.fromId) || !ids.has(relation.toId) || relation.fromId === relation.toId) throw new Error('Tankekartet har en ugyldig forbindelse.');
          relationIds.add(relation.id);
          return relation;
        });
      }
    }
    const item = { id: old?.id || randomUUID(), projectId: input.projectId, type, title: text(input.title, 200, 'notattittel', true).trim(), content: text(input.content || '', 250000, 'notattekst'), origin, status: input.status === 'reviewed' ? 'reviewed' : 'draft', author: text(author, 80, 'forfatter', true), sourceUrl: safeUrl(input.sourceUrl || old?.sourceUrl), sourceName: text(input.sourceName || old?.sourceName || '', 500, 'kildenavn'), citations: citations(input.citations || old?.citations), mindmap, createdAt: old?.createdAt || timestamp(), updatedAt: timestamp(), revision: (old?.revision || 0) + 1 };
    return this.put('item', item);
  }
  deleteItem({ id: key, revision }) {
    const old = this.get('item', id(key));
    if (!old) return;
    if (old.revision !== revision) throw new Error('Notatet er endret. Last inn ny versjon før du sletter.');
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('item', key);
  }
  saveCard(input) {
    this.project(input.projectId);
    const old = input.id ? this.get('card', id(input.id)) : null;
    if (input.id && !old) throw new Error('Kortet finnes ikke.');
    if (old && old.projectId !== input.projectId) throw new Error('Ugyldig prosjekt for kortet.');
    if (input.sourceIds && (!Array.isArray(input.sourceIds) || input.sourceIds.length > 30)) throw new Error('Ugyldige kortkilder.');
    const sourceIds = (input.sourceIds || old?.sourceIds || []).map(id);
    for (const sourceId of sourceIds) { const item = this.get('item', sourceId); if (!item || item.projectId !== input.projectId) throw new Error('Kortets kilde finnes ikke i prosjektet.'); }
    return this.put('card', { id: old?.id || randomUUID(), projectId: input.projectId, question: text(input.question, 4000, 'spørsmål', true), answer: text(input.answer, 12000, 'svar', true), origin: old?.origin || (input.origin === 'ai' ? 'ai' : 'human'), sourceIds, dueAt: old?.dueAt || timestamp(), interval: old?.interval || 0, reviewCount: old?.reviewCount || 0, createdAt: old?.createdAt || timestamp(), updatedAt: timestamp() });
  }
  reviewCard({ id: key, rating }) {
    const card = this.get('card', id(key)); if (!card) throw new Error('Kortet finnes ikke.');
    if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('Ugyldig vurdering.');
    const interval = rating === 'again' ? 10 / 1440 : rating === 'hard' ? Math.max(1, card.interval * 1.2) : rating === 'easy' ? Math.max(4, card.interval * 3) : Math.max(1, card.interval * 2.5);
    return this.put('card', { ...card, interval, dueAt: new Date(Date.now() + interval * 86400000).toISOString(), reviewCount: card.reviewCount + 1, updatedAt: timestamp() });
  }
  personalCard(card) { return { ...card, ...(this.getMeta(`review:${card.id}`) || { interval: 0, reviewCount: 0, dueAt: card.createdAt }) }; }
  reviewPersonalCard(card, rating) {
    if (!['again','hard','good','easy'].includes(rating)) throw new Error('Ugyldig vurdering.');
    const previous = this.personalCard(card);
    const interval = rating === 'again' ? 10 / 1440 : rating === 'hard' ? Math.max(1, previous.interval * 1.2) : rating === 'easy' ? Math.max(4, previous.interval * 3) : Math.max(1, previous.interval * 2.5);
    this.setMeta(`review:${id(card.id)}`, { interval, reviewCount: previous.reviewCount + 1, dueAt: new Date(Date.now()+interval*86400000).toISOString() });
    return this.personalCard(card);
  }
  createChat({ projectId }) { this.project(projectId); return this.put('chat', { id: randomUUID(), projectId, title: 'Ny samtale', messages: [], createdAt: timestamp(), updatedAt: timestamp() }); }
  appendMessage({ chatId, message }) {
    const chat = this.get('chat', id(chatId)); if (!chat) throw new Error('Samtalen finnes ikke.');
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Ugyldig melding.');
    if (chat.messages.length >= 1000) throw new Error('Start en ny samtale. Denne er blitt svært lang.');
    const m = { id: randomUUID(), role: message.role, content: text(message.content, 100000, 'melding', true), citations: citations(message.citations), provider: text(message.provider || '', 100, 'leverandør'), model: text(message.model || '', 200, 'modell'), author: text(message.author || this.getMeta('user').name, 80, 'forfatter'), createdAt: timestamp() };
    const title = chat.messages.length ? chat.title : m.content.slice(0, 70);
    return this.put('chat', { ...chat, title, messages: [...chat.messages, m], updatedAt: timestamp() });
  }
  exportProject(projectId) {
    const state = this.snapshot(projectId); if (!state.projects.length) throw new Error('Prosjektet finnes ikke.');
    return { format: 'sammen-project', version: 1, exportedAt: timestamp(), project: state.projects[0], items: state.items, flashcards: state.flashcards, chats: state.chats };
  }
  importProject(data) {
    if (data?.format !== 'sammen-project' || data.version !== 1 || !data.project || !Array.isArray(data.items) || !Array.isArray(data.flashcards) || !Array.isArray(data.chats) || data.items.length > 2000 || data.flashcards.length > 5000 || data.chats.length > 500) throw new Error('Filen er ikke et gyldig Sammen-prosjekt.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p = this.saveProject({ ...data.project, id: undefined, title: `${data.project.title} (importert)`.slice(0, 120) });
      const mapping = new Map();
      for (const item of data.items) {
        const saved = this.saveItem({ ...item, id: undefined, projectId: p.id, revision: undefined });
        mapping.set(item.id, saved.id);
      }
      for (const item of this.snapshot(p.id).items) {
        item.citations = item.citations.map(c => ({ ...c, sourceId: mapping.get(c.sourceId) || c.sourceId })); this.put('item', item);
      }
      for (const card of data.flashcards) this.saveCard({ ...card, id: undefined, projectId: p.id, sourceIds: (card.sourceIds || []).map(s => mapping.get(s)).filter(Boolean) });
      for (const chat of data.chats) {
        if (!Array.isArray(chat.messages) || chat.messages.length > 1000) throw new Error('Ugyldig samtale i prosjektfilen.');
        const fresh = this.createChat({ projectId: p.id });
        for (const message of chat.messages) this.appendMessage({ chatId: fresh.id, message: { ...message, citations: (message.citations || []).map(c => ({ ...c, sourceId: mapping.get(c.sourceId) || c.sourceId })) } });
      }
      this.db.exec('COMMIT'); return { ...p, itemIdMap: Object.fromEntries(mapping) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export const supportedOperations = ['saveProject', 'saveItem', 'deleteItem', 'saveCard', 'createChat', 'appendMessage'];
export function mutateStore(store, operation, input, { projectId, author } = {}) {
  if (!supportedOperations.includes(operation)) throw new Error('Operasjonen støttes ikke.');
  if (projectId) {
    let target = input.projectId;
    if (operation === 'saveProject') target = input.id;
    if (operation === 'deleteItem') target = store.get('item', input.id)?.projectId;
    if (operation === 'reviewCard') target = store.get('card', input.id)?.projectId;
    if (operation === 'appendMessage') target = store.get('chat', input.chatId)?.projectId;
    if (target !== projectId) throw new Error('Du har bare tilgang til det delte prosjektet.');
  }
  if (operation === 'saveItem') return store.saveItem(input, author);
  if (operation === 'appendMessage') return store.appendMessage({ ...input, message: { ...input.message, author } });
  return store[operation](input);
}
