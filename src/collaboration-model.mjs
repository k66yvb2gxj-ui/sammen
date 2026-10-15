import * as Y from 'yjs';

const fields = ['status', 'sourceUrl', 'sourceName'];
const nodeFields = ['parentId', 'x', 'y', 'color', 'shape', 'collapsed'];
const names = ['title', 'content', 'fields', 'nodes', 'relations', 'citations'];
const plain = value => JSON.parse(JSON.stringify(value));

export function replaceText(text, value) {
  value = String(value || '');
  const old = text.toString();
  if (old === value) return;
  let start = 0, end = 0;
  while (start < old.length && start < value.length && old[start] === value[start]) start++;
  while (end < old.length - start && end < value.length - start && old[old.length - end - 1] === value[value.length - end - 1]) end++;
  if (old.length - start - end) text.delete(start, old.length - start - end);
  if (value.length - start - end) text.insert(start, value.slice(start, value.length - end));
}

function writeMap(map, entries) {
  const keys = new Set(entries.map(([key]) => key));
  for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
  for (const [key, value] of entries) if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, plain(value));
}

export function writeItem(doc, item) {
  doc.transact(() => {
    replaceText(doc.getText('title'), item.title);
    replaceText(doc.getText('content'), item.content);
    const properties = doc.getMap('fields');
    for (const field of fields) if (properties.get(field) !== item[field]) properties.set(field, item[field] || (field === 'status' ? 'draft' : ''));
    writeMap(doc.getMap('citations'), (item.citations || []).map(c => [c.id, c]));
    const nodes = doc.getMap('nodes'), wanted = new Set((item.mindmap?.nodes || []).map(n => n.id));
    for (const key of nodes.keys()) if (!wanted.has(key)) nodes.delete(key);
    for (const data of item.mindmap?.nodes || []) {
      let node = nodes.get(data.id);
      if (!node) { node = new Y.Map(); node.set('text', new Y.Text()); nodes.set(data.id, node); }
      replaceText(node.get('text'), data.text);
      for (const field of nodeFields) {
        if (data[field] === undefined) { if (node.has(field)) node.delete(field); }
        else if (node.get(field) !== data[field]) node.set(field, data[field]);
      }
    }
    writeMap(doc.getMap('relations'), (item.mindmap?.relations || []).map(r => [r.id, r]));
  }, 'editor');
}

export function validateShape(doc) {
  for (const name of doc.share.keys()) if (!names.includes(name)) throw new Error('Ugyldige delte dokumentdata.');
  for (const name of ['title', 'content']) if (!(doc.getText(name) instanceof Y.Text)) throw new Error('Ugyldig delt tekst.');
  const properties = doc.getMap('fields');
  for (const key of properties.keys()) if (!fields.includes(key) || typeof properties.get(key) !== 'string') throw new Error('Ugyldig delt egenskap.');
  const nodes = doc.getMap('nodes');
  if (nodes.size > 150 || doc.getMap('relations').size > 300 || doc.getMap('citations').size > 30) throw new Error('Det delte dokumentet er for stort.');
  for (const [key, node] of nodes) {
    if (typeof key !== 'string' || !(node instanceof Y.Map) || !(node.get('text') instanceof Y.Text)) throw new Error('Ugyldig delt tankekartpunkt.');
    for (const property of node.keys()) if (!['text', ...nodeFields].includes(property)) throw new Error('Ugyldig egenskap i tankekartet.');
  }
}

export function readItem(doc, base) {
  validateShape(doc);
  const item = { ...base, title: doc.getText('title').toString() || 'Uten tittel', content: doc.getText('content').toString(), ...doc.getMap('fields').toJSON(), citations: [...doc.getMap('citations').values()].map(plain) };
  if (base.type === 'mindmap') {
    const rootId = base.mindmap.nodes.find(n => !n.parentId).id;
    const nodes = [...doc.getMap('nodes')].map(([id, map]) => ({ id, ...map.toJSON() }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    if (!byId.has(rootId)) throw new Error('Hovedpunktet i et delt tankekart kan ikke slettes.');
    byId.get(rootId).parentId = null;
    // Simultaneous moves may form a cycle or point to a concurrently deleted
    // branch. Attach those nodes to the stable root, keeping every surviving node.
    for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (node.id === rootId) continue;
      const visited = new Set([node.id]); let parent = node.parentId;
      while (parent && byId.has(parent) && !visited.has(parent)) { visited.add(parent); parent = byId.get(parent).parentId; }
      if (!node.parentId || !byId.has(node.parentId) || parent) node.parentId = rootId;
    }
    const relations = [...doc.getMap('relations').values()].map(plain).filter(r => byId.has(r.fromId) && byId.has(r.toId));
    item.mindmap = { nodes, relations };
  }
  return item;
}

export function createModel({ item, update } = {}) {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, decode(update)); else if (item) writeItem(doc, item);
  return {
    doc,
    read: base => readItem(doc, base || item),
    write: value => writeItem(doc, value),
    apply: update => {
      if (!update) return false;
      let changed = false; const observer = () => { changed = true; };
      doc.on('update', observer);
      try { Y.applyUpdate(doc, decode(update), 'remote'); } finally { doc.off('update', observer); }
      return changed;
    },
    encode: vector => encode(Y.encodeStateAsUpdate(doc, vector ? decode(vector) : undefined)),
    vector: () => encode(Y.encodeStateVector(doc)),
    isSynced: serverVector => {
      if (!serverVector) return false;
      try {
        const remote = Y.decodeStateVector(decode(serverVector));
        for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) if ((remote.get(client) || 0) < clock) return false;
        return true;
      } catch { return false; }
    },
    captureSelection: (field, start, end) => {
      if (!['title', 'content'].includes(field)) return null;
      const text = doc.getText(field);
      return { start: Y.createRelativePositionFromTypeIndex(text, Math.min(start, text.length)), end: Y.createRelativePositionFromTypeIndex(text, Math.min(end, text.length)) };
    },
    restoreSelection: anchor => {
      if (!anchor) return null;
      const start = Y.createAbsolutePositionFromRelativePosition(anchor.start, doc), end = Y.createAbsolutePositionFromRelativePosition(anchor.end, doc);
      return start && end ? { start: start.index, end: end.index } : null;
    },
    destroy: () => doc.destroy()
  };
}

export function encode(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text);
}
export function decode(value) {
  if (typeof value !== 'string' || value.length > 16000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Ugyldig dokumentoppdatering.');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

export { Y };
