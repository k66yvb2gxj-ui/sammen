import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { createSyncService } from './sync.mjs';

const catalogKey = 'brainSpaces:v1';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const reserved = [
  { id: 'personal', name: 'Min Brain', visibility: 'personal' },
  { id: 'public', name: 'Offentlig Brain', visibility: 'public' }
];
const clone = value => structuredClone(value);
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('Gi Brainen et navn på opptil 80 tegn.');
  return value.trim();
};
function readCatalog(value) {
  if (value === null) return { version: 1, activeId: 'personal', brains: clone(reserved) };
  if (value?.version !== 1 || !Array.isArray(value.brains) || value.brains.length < 2 || value.brains.length > 100) throw new Error('Brain-oversikten kunne ikke leses. Datafilene er beholdt.');
  const ids = new Set();
  const brains = value.brains.map(entry => {
    const fixed = reserved.find(brain => brain.id === entry?.id);
    if (!entry || (!fixed && !uuid.test(entry.id)) || ids.has(entry.id) || entry.visibility !== (fixed?.visibility || 'invited')) throw new Error('Brain-oversikten er ugyldig. Datafilene er beholdt.');
    ids.add(entry.id);
    return fixed ? clone(fixed) : { id: entry.id, name: nameOf(entry.name), visibility: 'invited' };
  });
  if (!reserved.every(brain => ids.has(brain.id)) || !ids.has(value.activeId)) throw new Error('Den valgte Brainen finnes ikke. Datafilene er beholdt.');
  return { version: 1, activeId: value.activeId, brains };
}

// Each Brain owns its store and sync context. Inactive contexts stay connected,
// but their file and state events cannot replace the selected Brain in the UI.
export function createBrainSpaces({ baseStore, directory, createStore = (filename, options) => new Store(filename, options), createSync = createSyncService, syncOptions = {}, onChange = () => {}, onCollaboration = () => {} }) {
  if (!baseStore || typeof directory !== 'string' || !directory) throw new Error('Brain-lagringen mangler.');
  const saved = readCatalog(baseStore.getMeta(catalogKey));
  let records = saved.brains, activeId = saved.activeId, active, transition = false, paused = false, closed = false, closing = false;
  let queue = Promise.resolve(), closePromise;
  const contexts = new Map();
  const assertOpen = () => { if (closed || closing) throw new Error('Brain-lagringen er lukket.'); };
  const assertWritable = () => { if (transition || paused) throw new Error('Vent til Brainen er klar.'); };
  const persist = () => baseStore.setMeta(catalogKey, { version: 1, activeId, brains: clone(records) });
  function contextFor(record) {
    if (contexts.has(record.id)) return contexts.get(record.id);
    let store;
    if (record.id === 'personal') store = baseStore;
    else {
      const folder = path.join(path.resolve(directory), 'brains');
      mkdirSync(folder, { recursive: true });
      store = createStore(path.join(folder, `${record.id}.sqlite`), { seedDefaultProject: false });
    }
    store.setMeta('user', baseStore.getMeta('user'));
    const context = { record, store, sync: null, files: new Set(), pending: new Set() };
    try {
      context.sync = createSync({ ...syncOptions, store,
        onChange: () => { if (!closed && !closing && !transition && !paused && context === active) onChange(state()); },
        onCollaboration: value => { if (!closed && !closing && !transition && !paused && context === active) onCollaboration(value); }
      });
    } catch (error) { if (store !== baseStore) store.close(); throw error; }
    contexts.set(record.id, context);
    return context;
  }
  function summary(record) {
    const connection = contexts.get(record.id)?.sync.status() || { mode: 'local' };
    return { ...record, isPersonal: record.id === 'personal', isPublic: record.id === 'public', connection: {
      mode: ['host', 'client'].includes(connection.mode) ? connection.mode : 'local',
      connected: connection.mode === 'host' || (connection.mode === 'client' && connection.connected !== false),
      transport: ['local', 'internet'].includes(connection.transport) ? connection.transport : null,
      memberCount: Number.isSafeInteger(connection.memberCount) && connection.memberCount > 0 ? connection.memberCount : 1
    } };
  }
  function catalog() { assertOpen(); return { activeId, brains: records.map(summary) }; }
  function state() { assertOpen(); return { ...active.sync.state(), brainSpace: catalog() }; }
  function notify() { onChange(state()); }
  async function settle(context) {
    while (context.pending.size) await Promise.allSettled([...context.pending]);
  }
  async function closeFiles(context) {
    for (const id of [...context.files]) {
      await context.sync.closeSharedFile({ id });
      context.files.delete(id);
    }
  }
  function serial(callback) {
    const operation = queue.then(() => { assertOpen(); return callback(); });
    queue = operation.catch(() => {});
    return operation;
  }
  async function select(record) {
    if (record.id === activeId) return state();
    // Open and validate the target before changing or closing anything active.
    const next = contextFor(record);
    transition = true;
    try {
      await settle(active);
      await closeFiles(active);
      const previousId = activeId;
      activeId = record.id;
      try { persist(); } catch (error) { activeId = previousId; throw error; }
      active = next;
    } finally { transition = false; }
    notify();
    return state();
  }
  function switchBrain(input) {
    return serial(() => {
      assertWritable();
      const record = records.find(brain => brain.id === input?.id);
      if (!record) throw new Error('Brainen finnes ikke.');
      return select(record);
    });
  }
  function createBrain(input) {
    return serial(async () => {
      assertWritable();
      const name = nameOf(input?.name);
      if (input?.visibility !== undefined && input.visibility !== 'invited') throw new Error('Nye Brains deles bare med inviterte.');
      if (records.length >= 100) throw new Error('Du kan ha opptil 100 Brains på denne PC-en.');
      const record = { id: randomUUID(), name, visibility: 'invited' };
      contextFor(record);
      records = [...records, record];
      try { persist(); } catch (error) {
        records = records.filter(brain => brain.id !== record.id);
        const context = contexts.get(record.id); contexts.delete(record.id); context.store.close();
        throw error;
      }
      // A failed selection leaves the newly created empty Brain in the catalog
      // so it can be retried, while the previous Brain remains selected.
      return select(record);
    });
  }
  const store = new Proxy({}, {
    get(_target, property) {
      assertOpen();
      if (property === 'saveProfile') return input => {
        assertOpen();
        assertWritable();
        baseStore.saveProfile(input);
        const user = baseStore.getMeta('user');
        for (const context of contexts.values()) if (context.store !== baseStore) context.store.setMeta('user', user);
      };
      if (property === 'close') return close;
      if (property === 'getMeta') return key => key === 'user' ? baseStore.getMeta('user') : active.store.getMeta(key);
      if (property === 'setMeta') return (key, value) => {
        if (key === 'user' || key === catalogKey) throw new Error('Denne innstillingen administreres av Brain-oversikten.');
        assertWritable();
        return active.store.setMeta(key, value);
      };
      const value = active.store[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        assertOpen();
        if (transition || (paused && !['get', 'list', 'project', 'snapshot', 'exportProject', 'personalCard'].includes(property))) assertWritable();
        return active.store[property](...args);
      };
    }
  });
  const sync = new Proxy({}, {
    get(_target, property) {
      assertOpen();
      if (property === 'state') return state;
      if (property === 'status') return () => active.sync.status();
      const value = active.sync[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        assertOpen();
        assertWritable();
        const context = active;
        const result = context.sync[property](...args);
        const trackFile = value => {
          if (property === 'openSharedFile') context.files.add(args[0].id);
          if (property === 'closeSharedFile') context.files.delete(args[0].id);
          return value;
        };
        if (!result || typeof result.then !== 'function') return trackFile(result);
        const pending = Promise.resolve(result).then(trackFile);
        context.pending.add(pending);
        pending.then(() => context.pending.delete(pending), () => context.pending.delete(pending));
        return pending;
      };
    }
  });
  function pause() {
    return serial(async () => {
      if (paused) return state();
      transition = true;
      try {
        for (const context of contexts.values()) {
          await settle(context);
          await closeFiles(context);
          if (typeof context.sync.pause === 'function') await context.sync.pause();
        }
        paused = true;
      } finally { transition = false; }
      return state();
    });
  }
  function resume() {
    return serial(async () => {
      transition = true;
      try {
        for (const context of contexts.values()) if (typeof context.sync.resume === 'function') await context.sync.resume();
        paused = false;
      } finally { transition = false; }
      notify();
      return state();
    });
  }
  function close() {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = serial(async () => {
      closing = true; transition = true;
      try {
        for (const context of contexts.values()) {
          await settle(context);
          await closeFiles(context);
          if (typeof context.sync.shutdown === 'function') await context.sync.shutdown();
          else { await context.sync.leaveGroup(); await context.sync.stopHosting(); }
        }
        for (const context of contexts.values()) if (context.store !== baseStore) context.store.close();
        baseStore.close();
        closed = true;
      } finally { closing = false; transition = false; closePromise = undefined; }
    });
    return closePromise;
  }
  active = contextFor(records.find(brain => brain.id === activeId));
  persist();
  return { store, sync, state, catalog, createBrain, switchBrain, pause, resume, close };
}
