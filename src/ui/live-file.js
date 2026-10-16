'use strict';

(() => {
  let binding = null, generation = 0, initialized = false;
  const shared = draft => {
    const sync = ui.sync || state.sync;
    return Boolean(draft && ['host', 'client'].includes(sync.mode) && (sync.scope === 'brain' || sync.projectId === draft.projectId));
  };
  const busyMap = draft => draft?.type === 'mindmap' && Boolean(document.querySelector('.topic-map-inline-input, .topic-map-relation-input, .topic-map-svg.dragging'));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  function acknowledged(current, payload) {
    if (payload.pending !== false || !payload.item || !current.model.isSynced?.(payload.stateVector)) return false;
    const merged = current.model.read(payload.item);
    const fields = ['title', 'content', 'status', 'citations', ...(payload.item.type === 'mindmap' ? ['mindmap'] : [])];
    return fields.every(field => JSON.stringify(canonical(merged[field])) === JSON.stringify(canonical(payload.item[field])));
  }
  function paint() {
    for (const node of document.querySelectorAll('.live-file-presence')) {
      const active = binding?.active && editor?.id === binding.id;
      node.hidden = !active;
      if (!active) continue;
      const others = (binding.members || []).filter(member => member.id !== state.user.id && member.userId !== state.user.id && (member.editingItemId === binding.id || member.itemId === binding.id));
      node.replaceChildren(el('span', { class: 'live-file-dot' }), el('span', {}, others.length ? `${others.map(member => member.name).join(', ')} og deg` : 'Delt fil'));
      node.title = 'Endringer lagres automatisk i fellesrommet.';
    }
    const status = document.getElementById('editor-save-state');
    if (status && binding?.active && editor?.id === binding.id) {
      status.textContent = binding.error ? 'Frakoblet · utkast bevart' : busyMap(editor) && editor.dirty ? 'Redigerer …' : binding.sending || editor.dirty ? 'Synkroniserer …' : 'Lagret for alle';
      status.classList.toggle('dirty', Boolean(binding.error || editor.dirty));
    }
  }
  function presence() { return el('span', { class: 'live-file-presence', hidden: !shared(editor), 'aria-live': 'polite' }, el('span', { class: 'live-file-dot' }), 'Delt fil'); }
  function init() {
    if (initialized || !api?.onFileCollaboration) return;
    initialized = true;
    api.onFileCollaboration(receive);
  }
  function detach() {
    generation++;
    const previous = binding; binding = null;
    if (!previous) return;
    clearTimeout(previous.timer);
    unlock(previous);
    previous.model?.destroy();
    invoke('closeSharedFile', { id: previous.id }).catch(() => {});
  }
  function lock(current) {
    const panel = document.querySelector('.editor-panel');
    panel?.classList.add('live-file-opening');
    current.locked ||= new Map();
    for (const node of panel?.querySelectorAll('input, textarea, button, select') || []) {
      if (!current.locked.has(node)) current.locked.set(node, node.disabled);
      node.disabled = true;
    }
    const status = document.getElementById('editor-save-state'); if (status) status.textContent = 'Kobler til …';
  }
  function unlock(current) {
    document.querySelector('.editor-panel')?.classList.remove('live-file-opening');
    for (const [node, disabled] of current.locked || []) node.disabled = disabled;
    current.locked?.clear();
  }
  async function bind(draft) {
    init();
    if (!shared(draft) || !window.SammenCollaborationModel || !api?.openSharedFile) { if (binding) detach(); return; }
    if (binding?.id === draft.id) { binding.draft = draft; if (!binding.active && !binding.error) lock(binding); paint(); return; }
    if (draft.dirty) return;
    detach();
    const current = { id: draft.id, draft, gen: generation, active: false, model: null, members: [], sequence: 0, sending: false, deferred: [], error: '', timer: null, sentVector: null };
    binding = current;
    lock(current);
    try {
      const payload = await invoke('openSharedFile', { id: draft.id });
      if (binding !== current || generation !== current.gen || editor?.id !== draft.id) return;
      if (!payload.active) { unlock(current); binding = null; return; }
      current.model = window.SammenCollaborationModel.create({ item: payload.item, update: payload.update });
      current.sentVector = current.model.vector();
      current.active = true; current.members = payload.members || [];
      syncDraft(current, payload);
      unlock(current);
      paint();
    } catch (error) { if (binding === current) { unlock(current); current.error = error.message; paint(); showError(error); } }
  }
  function syncDraft(current, payload, anchors = null) {
    if (binding !== current || editor?.id !== current.id) return;
    const draft = editor;
    const beforeMap = JSON.stringify(draft.mindmap);
    const merged = current.model.read({ ...draft, ...(payload.item || {}) });
    if (payload.item) state.items = state.items.map(item => item.id === payload.item.id ? payload.item : item);
    for (const field of ['title', 'content', 'status', 'citations', 'mindmap', 'revision', 'updatedAt', 'author', 'contributors', 'legacyAuthor']) if (merged[field] !== undefined) draft[field] = merged[field];
    refreshEditorContributors(draft);
    current.draft = draft;
    if (draft.type === 'mindmap') {
      if (beforeMap !== JSON.stringify(draft.mindmap) && !busyMap(draft)) renderMain();
    } else {
      for (const [field, selector] of [['title', '#editor-title'], ['content', '#editor-content']]) {
        const input = document.querySelector(selector);
        if (!input || input.value === draft[field]) continue;
        const focused = document.activeElement === input;
        const start = input.selectionStart, end = input.selectionEnd;
        input.value = draft[field] || '';
        if (focused) {
          const position = anchors?.[field] && current.model.restoreSelection?.(anchors[field]);
          try { input.setSelectionRange(position?.start ?? Math.min(start, input.value.length), position?.end ?? Math.min(end, input.value.length)); } catch {}
        }
      }
    }
    const status = document.getElementById('editor-status'); if (status) status.value = draft.status;
    window.SammenFileSources?.refresh?.(draft);
    const count = document.getElementById('word-count'); if (count) count.textContent = `${(draft.content.match(/\S+/g) || []).length} ord`;
  }
  function apply(current, payload) {
    const anchors = {};
    for (const [field, selector] of [['title', '#editor-title'], ['content', '#editor-content']]) {
      const input = document.querySelector(selector);
      if (input && document.activeElement === input) anchors[field] = current.model.captureSelection?.(field, input.selectionStart, input.selectionEnd);
    }
    if (payload.update) current.model.apply(payload.update);
    current.members = payload.members || current.members;
    if (payload.pending) current.error = payload.error || 'Forbindelsen er brutt.';
    syncDraft(current, payload, anchors); paint();
    if (current.pendingSequence !== undefined && current.sequence === current.pendingSequence && !busyMap(current.draft) && acknowledged(current, payload)) {
      current.draft.dirty = false; current.error = ''; current.pendingSequence = undefined; current.sentVector = current.model.vector(); paint();
    }
  }
  function receive(payload) {
    const current = binding;
    if (!current?.active || current.id !== payload?.id || !current.model) return;
    if (busyMap(current.draft)) { current.deferred.push(payload); current.members = payload.members || current.members; paint(); return; }
    apply(current, payload);
  }
  function drain(current) {
    if (busyMap(current.draft)) return;
    for (const payload of current.deferred.splice(0)) apply(current, payload);
  }
  function edited(draft) {
    const current = binding;
    if (!current?.active || current.id !== draft?.id || !current.model) return;
    current.draft = draft;
    current.sequence++;
    if (busyMap(draft)) { paint(); return; }
    current.model.write(draft);
    drain(current); schedule(current); paint();
  }
  function interactionEnd(draft) {
    const current = binding;
    if (!current?.active || current.id !== draft?.id || busyMap(draft)) return;
    if (draft.dirty) { current.model.write(draft); current.sequence++; }
    drain(current);
    if (draft.dirty) schedule(current);
    paint();
  }
  function schedule(current) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { flush(current).catch(() => {}); }, 300);
  }
  async function flush(current) {
    clearTimeout(current.timer);
    if (binding !== current || !current.active) return false;
    if (current.sending) { await current.request; return binding === current && !current.draft.dirty ? true : flush(current); }
    if (busyMap(current.draft)) return false;
    const sequence = current.sequence;
    const update = current.model.encode(current.sentVector);
    const sentVector = current.model.vector();
    current.sending = true; paint();
    current.request = (async () => {
      try {
        const payload = await invoke('updateSharedFile', { id: current.id, update, stateVector: sentVector, editing: true });
        if (binding !== current) return true;
        if (!payload.pending) { current.sentVector = sentVector; current.error = ''; }
        if (busyMap(current.draft)) { current.deferred.push(payload); current.members = payload.members || current.members; }
        else apply(current, payload);
        if (payload.pending) { current.pendingSequence = sequence; current.draft.dirty = true; current.error = payload.error || 'Forbindelsen er brutt.'; }
        else if (current.sequence === sequence && !busyMap(current.draft)) current.draft.dirty = false;
        else schedule(current);
        return !current.draft.dirty;
      } catch (error) {
        if (binding === current) { if (current.error !== error.message) showError(error); current.error = error.message; current.draft.dirty = true; }
        return false;
      } finally { if (binding === current) { current.sending = false; paint(); } }
    })();
    return current.request;
  }
  async function save(draft) {
    if (draft.type === 'mindmap') window.SammenMindmap?.flush?.();
    const current = binding;
    if (!current?.active || current.id !== draft.id) return false;
    current.model.write(draft); current.sequence++;
    drain(current);
    return flush(current);
  }
  window.SammenLiveFile = { init, bind, detach, edited, interactionEnd, receive, presence, isOpening: draft => Boolean(binding?.id === draft?.id && !binding.active && !binding.error), isActive: draft => Boolean(binding?.active && binding.id === draft?.id), save };
})();
