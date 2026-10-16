// A Brain switch must wait for operations that still refer to the old workspace.
export function createBrainCommands({ spaces, cancelActive = async () => {}, onChange = () => {}, publicUrl = () => '' }) {
  let changing = false, stable = spaces.state();
  const pending = new Set();
  const active = () => { const catalog = spaces.catalog(); return catalog.brains.find(brain => brain.id === catalog.activeId); };
  const state = () => changing ? structuredClone(stable) : spaces.state();
  function assertPublicWritable() {
    if (active()?.isPublic && !spaces.sync.status().isPublic) throw new Error('Koble til den offentlige Brainen før du legger inn innhold.');
  }
  async function runScoped(callback, { write = false } = {}) {
    if (changing) throw new Error('Vent til Brainen er byttet.');
    if (write) assertPublicWritable();
    const task = Promise.resolve().then(callback);
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  async function transition(callback) {
    if (changing) throw new Error('Vent til Brainen er byttet.');
    stable = spaces.state(); changing = true;
    try {
      await cancelActive();
      await Promise.allSettled([...pending]);
      return await callback();
    } finally {
      changing = false; stable = spaces.state(); onChange(stable);
    }
  }
  function requireInvited() {
    if (active()?.visibility !== 'invited') throw new Error('Opprett en egen Brain for inviterte før du deler hele arbeidsrommet.');
  }
  const methods = {
    getBrainSpaces: () => spaces.catalog(),
    switchBrain: input => transition(() => spaces.switchBrain(input)),
    createBrain: input => transition(() => spaces.createBrain(input)),
    joinBrain: input => transition(async () => {
      const previous = spaces.catalog().activeId;
      try {
        await spaces.createBrain({ name: input?.name || 'Delt Brain', visibility: 'invited' });
        await spaces.sync.joinGroup({ url: input?.url, inviteCode: input?.inviteCode });
        return spaces.state();
      } catch (error) { await spaces.switchBrain({ id: previous }); throw error; }
    }),
    connectPublicBrain: input => transition(async () => {
      const previous = spaces.catalog().activeId;
      try {
        await spaces.switchBrain({ id: 'public' });
        if (!spaces.sync.status().isPublic) await spaces.sync.joinPublicBrain({ url: input?.url || publicUrl() });
        return spaces.state();
      } catch (error) { await spaces.switchBrain({ id: previous }); throw error; }
    }),
    startBrainHosting: () => transition(async () => { requireInvited(); return spaces.sync.startHosting({ scope: 'brain' }); }),
    startInternetBrain: input => transition(async () => { requireInvited(); return spaces.sync.startInternetRoom({ url: input?.url, createKey: input?.createKey, scope: 'brain' }); })
  };
  return { ...methods, state, runScoped, isBusy: () => changing, assertPublicWritable, methods };
}
