import { Y, createModel, readItem, writeItem, encode, decode } from './collaboration-model.mjs';

export function createFileCollaboration({ store, projectId }) {
  const documents = new Map();
  function currentItem(id) {
    const item = store.get('item', id);
    if (!item || (projectId && item.projectId !== projectId)) throw new Error('Du har bare tilgang til filer i det delte prosjektet.');
    return item;
  }
  function load(id) {
    const item = currentItem(id), cached = documents.get(id);
    if (cached && cached.revision === item.revision) return cached;
    const persisted = store.getMeta(`collaboration:${id}`);
    const model = cached?.model || createModel(persisted ? { item, update: persisted.update } : { item });
    if ((cached?.revision || persisted?.revision) !== item.revision) model.write(item);
    const result = { model, revision: item.revision };
    documents.set(id, result);
    store.setMeta(`collaboration:${id}`, { version: 1, revision: item.revision, update: model.encode() });
    return result;
  }
  function response(id, stateVector) {
    const current = load(id);
    return { id, item: currentItem(id), update: current.model.encode(stateVector), stateVector: current.model.vector() };
  }
  function update({ id, update, stateVector }, author, actor) {
    const item = currentItem(id), existing = load(id);
    const candidate = createModel({ item, update: existing.model.encode() });
    try {
      candidate.apply(update);
      const projected = readItem(candidate.doc, item);
      for (const citation of projected.citations) {
        if (citation.sourceId) {
          const source = store.get('item', citation.sourceId);
          if (!source || source.projectId !== item.projectId) throw new Error('Kilden må finnes i det delte prosjektet.');
        }
      }
      const complete = candidate.encode();
      if (complete.length > 16000000) throw new Error('Det delte dokumentet er for stort.');
      const changed = JSON.stringify({ ...projected, author: item.author }) !== JSON.stringify(item);
      store.db.exec('BEGIN IMMEDIATE');
      let saved;
      try {
        saved = changed ? store.saveItem(projected, author, actor) : item;
        store.setMeta(`collaboration:${id}`, { version: 1, revision: saved.revision, update: complete });
        store.db.exec('COMMIT');
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
      existing.model.destroy(); documents.set(id, { model: candidate, revision: saved.revision });
      return { id, item: saved, update: candidate.encode(stateVector), stateVector: candidate.vector() };
    } catch (error) { candidate.destroy(); throw error; }
  }
  return { response, update, reconcile: item => { if (item?.id && item.type) load(item.id); }, close: () => { for (const data of documents.values()) data.model.destroy(); documents.clear(); } };
}
